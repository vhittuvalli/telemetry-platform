"""Live telemetry: register a session, send packets over WebSocket (or UDP), watch it live."""

import asyncio
import json
import os

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from backend import live

router = APIRouter(prefix="/live", tags=["live"])

#UDP port for senders that reach the server directly; web hosts like Render only pass HTTP,
#so remote senders use scripts/telemetry_relay.py instead
UDP_PORT = int(os.environ.get("LIVE_UDP_PORT", "9870") or 0)
BATCH_S = 0.1  # viewers get new data in batches, ten times a second


class NewSession(BaseModel):
    domain: str = "rocket"
    meta: dict


@router.post("/sessions", status_code=201)
def create_session(req: NewSession):
    """Start a live session. Returns its code (share it with viewers) and key (keep it secret)."""
    try:
        session = live.create(req.domain, req.meta)
    except live.LiveError as err:
        raise HTTPException(status_code=422, detail=str(err))
    return {"code": session.code, "key": session.key, "udp_port": UDP_PORT or None,
            "protocol_version": live.PROTOCOL_VERSION}


@router.get("/sessions")
def list_sessions():
    return live.active()


@router.get("/sessions/{code}")
def get_session(code: str):
    session = live.get(code)
    if session is None:
        raise HTTPException(status_code=404, detail=f"No live session '{code}'")
    return {**session.info(), "meta": session.meta}


@router.websocket("/ingest")
async def ingest_socket(ws: WebSocket):
    """Send packets as WebSocket text messages, one JSON packet each (same format as UDP)."""
    await ws.accept()
    try:
        while True:
            try:
                packet = json.loads(await ws.receive_text())
                session = live.ingest(packet)
                if packet.get("end"):
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
    queue: asyncio.Queue = asyncio.Queue(maxsize=2000)
    session.watchers.add(queue)
    try:
        await ws.send_json(session.snapshot())
        if session.ended:
            return
        while True:
            # Gather what arrived in the last batch interval into one message
            message = await queue.get()
            await asyncio.sleep(BATCH_S)
            batch = {"type": "data", "samples": [], "events": []}
            ended = None
            for m in [message, *[queue.get_nowait() for _ in range(queue.qsize())]]:
                if m["type"] == "end":
                    ended = m
                else:
                    batch["samples"] += m["samples"]
                    batch["events"] += m["events"]
            if batch["samples"] or batch["events"]:
                await ws.send_json(batch)
            if ended:
                await ws.send_json(ended)
                return
    except WebSocketDisconnect:
        pass
    finally:
        session.watchers.discard(queue)


async def start_udp() -> asyncio.DatagramTransport | None:
    """Listen for live packets over UDP (if LIVE_UDP_PORT isn't empty)."""
    if not UDP_PORT:
        return None
    loop = asyncio.get_running_loop()
    try:
        transport, _ = await loop.create_datagram_endpoint(live.UdpIngest, local_addr=("0.0.0.0", UDP_PORT))
    except OSError as err:
        print(f"Live UDP listener not started on port {UDP_PORT}: {err}")
        return None
    print(f"Listening for live telemetry over UDP on port {UDP_PORT}")
    return transport
