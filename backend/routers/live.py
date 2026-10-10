"""Live telemetry: register a session, send packets over WebSocket (or UDP), watch it live."""

import asyncio
import json
import os
import socket
from dataclasses import asdict

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from backend import demos, live
from backend.routers import replays, rockets
from telemetry import live_sources
from telemetry.rocket import catalog
from telemetry.rocket.flight import load_launch
from telemetry.rocket.replay import rocket_metadata
from telemetry.rocket.rocket import load_rocket

router = APIRouter(prefix="/live", tags=["live"])

#UDP port for senders that reach the server directly; web hosts like Render only pass HTTP,
#so remote senders use scripts/telemetry_relay.py instead
UDP_PORT = int(os.environ.get("LIVE_UDP_PORT", "9870") or 0)
BATCH_S = 0.1  # viewers get new data in batches, ten times a second


def client_ip(conn: Request | WebSocket) -> str:
    # Behind a proxy, uvicorn's --proxy-headers puts the real client here
    return conn.client.host if conn.client else ""


class NewSession(BaseModel):
    domain: str = "rocket"
    meta: dict = {}
    rocket: str | None = None  # a design in rockets/ (GET /rockets): the server fills in its geometry


def design_meta(rocket_id: str, meta: dict) -> dict:
    """A rocket session's meta with the geometry and launch of one of the site's designs, so a
    sender (a flight computer, a script with just numbers) needn't describe the rocket itself."""
    try:
        path = catalog.rocket_path(rocket_id)
    except FileNotFoundError as err:
        raise HTTPException(status_code=404, detail=str(err))
    rocket = load_rocket(path)
    session = meta.get("session") if isinstance(meta.get("session"), dict) else {}
    return {
        **meta,
        "session": {"event": rocket.name, "location": "Live launch", "name": "Live flight", **session},
        "rocket": rocket_metadata(rocket, rocket_id),
        "launch": meta.get("launch") or asdict(load_launch(path)),
    }


@router.post("/sessions", status_code=201)
def create_session(req: NewSession, request: Request):
    """Start a live session. Returns its code (share it with viewers) and key (keep it secret)."""
    meta = design_meta(req.rocket, req.meta) if req.domain == "rocket" and req.rocket else req.meta
    try:
        session = live.create(req.domain, meta, owner=client_ip(request))
    except live.Throttled as err:
        raise HTTPException(status_code=429, detail=str(err))
    except live.LiveError as err:
        raise HTTPException(status_code=422, detail=str(err))
    return {"code": session.code, "key": session.key, "udp_port": UDP_PORT or None,
            "protocol_version": live.PROTOCOL_VERSION, "max_samples": session.spec.max_samples}


class DemoRequest(BaseModel):
    rocket: str | None = None              # a design in rockets/ to simulate and stream
    replay: str | None = None              # or a built F1 replay: its first minutes
    speed: float = Field(1, ge=1, le=20)   # times real time


@router.post("/demo", status_code=201)
async def start_demo(req: DemoRequest, request: Request):
    """The server streams a flight or a race into a new live session; watch it with the returned code."""
    if bool(req.rocket) == bool(req.replay):
        raise HTTPException(status_code=422, detail="Give a rocket or an F1 replay to stream")
    try:
        demos.check_capacity()  # before the simulation or file read, not just after
        stream = await asyncio.to_thread(demo_stream, req)
        session = demos.start(stream, owner=client_ip(request), speed=req.speed)
    except live.Throttled as err:
        raise HTTPException(status_code=429, detail=str(err))
    except live.LiveError as err:
        raise HTTPException(status_code=422, detail=str(err))
    return {"code": session.code, "domain": session.domain}


def demo_stream(req: DemoRequest) -> live_sources.LiveStream:
    if req.rocket:
        try:
            path = catalog.rocket_path(req.rocket)
        except FileNotFoundError as err:
            raise HTTPException(status_code=404, detail=str(err))
        with rockets._busy:  # one simulation at a time, shared with re-simulations
            return live_sources.rocket_flight(path, site_name="Demo launch")
    # Only a replay the server lists as built, so the id can't point anywhere else
    if not any(r["id"] == req.replay and r["domain"] == "f1" for r in replays.built_replays()):
        raise HTTPException(status_code=404, detail=f"No built F1 replay '{req.replay}'")
    start = replays.read_json(req.replay, ".meta.json").get("time_range", {}).get("start", 0.0)
    return live_sources.f1_replay(replays.REPLAYS_DIR / req.replay, start, start + demos.F1_SPAN_S)


@router.get("/sessions")
def list_sessions():
    return live.active()


@router.get("/sessions/{code}")
def get_session(code: str):
    session = live.get(code)
    if session is None:
        raise HTTPException(status_code=404, detail=f"No live session '{code}'")
    return {**session.info(), "meta": session.meta, "udp_port": UDP_PORT or None,
            "max_samples": session.spec.max_samples}


@router.websocket("/ingest")
async def ingest_socket(ws: WebSocket):
    """Send packets as WebSocket text messages, one JSON packet each (same format as UDP)."""
    await ws.accept()
    source = client_ip(ws)
    try:
        while True:
            try:
                text = await ws.receive_text()
                session = live.receive(text, source, live.MAX_MESSAGE)
                if session.ended:
                    await ws.send_json({"ok": True, "ended": True, "replay_id": session.replay_id})
            except (live.LiveError, ValueError) as err:
                await ws.send_json({"error": str(err)})
    except WebSocketDisconnect:
        pass


@router.websocket("/sessions/{code}/watch")
async def watch_socket(ws: WebSocket, code: str):
    """Everything so far, then new samples and events as they arrive."""
    await ws.accept()
    session = live.get(code)
    if session is None:
        await ws.send_json({"type": "error", "detail": f"No live session '{code}'"})
        await ws.close()
        return
    if len(session.watchers) >= live.MAX_WATCHERS:
        await ws.send_json({"type": "error", "detail": "This session has as many viewers as it can take; try again soon"})
        await ws.close()
        return
    queue: asyncio.Queue = asyncio.Queue(maxsize=2000)
    session.watchers.add(queue)
    try:
        await ws.send_json(session.snapshot())
        for message in session.vehicle_snapshots():
            await ws.send_json(message)
        if session.ended:
            return
        while True:
            # Gather what arrived in the last batch interval into one message
            message = await queue.get()
            await asyncio.sleep(BATCH_S)
            batch = {"type": "data", "samples": [], "events": [], "laps": []}
            ended = None
            for m in [message, *[queue.get_nowait() for _ in range(queue.qsize())]]:
                if m["type"] == "end":
                    ended = m
                else:
                    for k in ("samples", "events", "laps"):
                        batch[k] += m[k]
            if batch["samples"] or batch["events"] or batch["laps"]:
                await ws.send_json(batch)
            if ended:
                await ws.send_json(ended)
                return
    except WebSocketDisconnect:
        pass
    finally:
        session.watchers.discard(queue)


def udp_socket(port: int) -> socket.socket:
    """A UDP socket on `port` for IPv4 and IPv6 senders alike (a site's name can resolve to either),
    or IPv4 alone where the host has no IPv6 (as in many Docker setups)."""
    try:
        sock = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)
        try:
            sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
            sock.bind(("::", port))
            return sock
        except OSError:
            sock.close()
            raise
    except OSError:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.bind(("0.0.0.0", port))
        return sock


async def start_udp() -> asyncio.DatagramTransport | None:
    """Listen for live packets over UDP (if LIVE_UDP_PORT isn't empty)."""
    if not UDP_PORT:
        return None
    loop = asyncio.get_running_loop()
    try:
        transport, _ = await loop.create_datagram_endpoint(live.UdpIngest, sock=udp_socket(UDP_PORT))
    except OSError as err:
        print(f"Live UDP listener not started on port {UDP_PORT}: {err}")
        return None
    print(f"Listening for live telemetry over UDP on port {UDP_PORT}")
    return transport
