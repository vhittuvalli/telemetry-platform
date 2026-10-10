"""Send telemetry to the platform live (see docs/live-protocol.md): register a session,
then stream samples, events and laps in real time over UDP or a WebSocket."""

import json
import socket
import time
import sys
import urllib.error
import urllib.request
from contextlib import ExitStack
from urllib.parse import urlparse

MAX_PACKET = 1200  # bytes: fits in one datagram on any network without fragmenting


class LiveRefused(Exception):
    """The platform turned the session down; the message is its reason."""


def register(site: str, domain: str, meta: dict | None = None, rocket: str | None = None) -> dict:
    """Start a live session; returns its code (for viewers) and key (for packets).

    A rocket session needs the rocket's geometry in `meta`, or `rocket`: a design on the site
    (GET /rockets) whose geometry the server fills in.
    """
    body = {"domain": domain, "meta": meta or {}, **({"rocket": rocket} if rocket else {})}
    req = urllib.request.Request(f"{site}/live/sessions", data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as err:
        try:
            reason = json.loads(err.read())["detail"]
        except (ValueError, KeyError):
            reason = err.reason
        raise LiveRefused(f"{site} refused the session ({err.code}): {reason}") from None


def join(site: str, code: str, key: str) -> dict:
    """A session someone already started (e.g. from the site's Go live panel), to send to."""
    try:
        with urllib.request.urlopen(f"{site}/live/sessions/{code.upper()}", timeout=120) as r:
            info = json.loads(r.read())
    except urllib.error.HTTPError as err:
        raise LiveRefused(f"{site} has no live session {code.upper()} ({err.code})") from None
    if info.get("ended"):
        raise LiveRefused(f"Live session {code.upper()} has ended; start another")
    return {"code": info["code"], "key": key, "udp_port": info.get("udp_port"), "max_samples": info.get("max_samples")}


def packets(session: dict, samples: list[dict], events: list[dict], laps: list[dict], seq: int):
    """Split samples (plus any events and laps) into packets no bigger than MAX_PACKET bytes."""
    base = {"v": 1, "session": session["code"], "key": session["key"]}
    extras = {"events": events, "laps": laps}
    batch: list[dict] = []
    for s in samples:
        trial = json.dumps({**base, "seq": seq, "samples": batch + [s], **extras}, separators=(",", ":"))
        if batch and len(trial) > MAX_PACKET:
            yield {**base, "seq": seq, "samples": batch, **extras}
            seq, batch, extras = seq + 1, [], {"events": [], "laps": []}
        batch.append(s)
    if batch or extras["events"] or extras["laps"]:
        yield {**base, "seq": seq, "samples": batch, **extras}


class UdpSender:
    def __init__(self, host: str, port: int):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setblocking(False)
        self.addr = (host, port)
        self.rejected = 0

    def send(self, packet: dict) -> None:
        self.sock.sendto(json.dumps(packet, separators=(",", ":")).encode(), self.addr)
        try:
            reply, _ = self.sock.recvfrom(2048)  # the server only replies when something's wrong
        except (BlockingIOError, ConnectionRefusedError):
            return
        self.rejected += 1
        if self.rejected == 1:
            print(f"server rejected a packet: {reply.decode()} (is --udp pointing at the same server as --site?)")

    def close(self) -> None:
        self.sock.close()


class WebSocketSender:
    rejected = 0

    def __init__(self, site: str):
        from websockets.sync.client import connect
        url = site.replace("https://", "wss://").replace("http://", "ws://") + "/live/ingest"
        self.stack = ExitStack()
        self.ws = self.stack.enter_context(connect(url, open_timeout=120))

    def send(self, packet: dict) -> None:
        self.ws.send(json.dumps(packet, separators=(",", ":")))

    def close(self) -> None:
        self.stack.close()


def sender(site: str, udp: str | None, websocket: bool, udp_port: int | None = None):
    """Where packets go: `udp` if given, else the site's own UDP port, else a WebSocket to the site."""
    if udp is None and not websocket:
        if udp_port:
            udp = f"{urlparse(site).hostname}:{udp_port}"
        else:
            print("The site doesn't take UDP directly (give --udp to use a relay)")
            websocket = True
    if websocket:
        print(f"Sending over WebSocket to {site}")
        return WebSocketSender(site)
    host, port = udp.rsplit(":", 1)
    print(f"Sending UDP to {host}:{port}")
    return UdpSender(host, int(port))


def schedule(samples: list[dict], events: list[dict] = (), laps: list[dict] = (), step: float = 0.02):
    """The stream in sending order: (offset, samples, events, laps) for each `step` s of stream time
    that has something new, where offset is the stream time since the first sample. Samples come up
    at their `time`, events at their `time`, laps at their `lap_end`."""
    samples = sorted(samples, key=lambda s: s["time"])
    events = sorted(events, key=lambda e: e["time"])
    laps = sorted((l for l in laps if l.get("lap_end") is not None), key=lambda l: l["lap_end"])
    if not samples:
        return
    t0 = now = samples[0]["time"]
    i = e = k = 0
    while i < len(samples):
        due = []
        while i < len(samples) and samples[i]["time"] <= now:
            due.append(samples[i])
            i += 1
        new_events = []
        while e < len(events) and events[e]["time"] <= now:
            new_events.append(events[e])
            e += 1
        new_laps = []
        while k < len(laps) and laps[k]["lap_end"] <= now:
            new_laps.append(laps[k])
            k += 1
        if due or new_events or new_laps:
            yield now - t0, due, new_events, new_laps
        now += step
    if e < len(events) or k < len(laps):
        yield now - t0, [], events[e:], laps[k:]  # whatever comes after the last sample


def stream(site: str, domain: str, meta: dict, samples: list[dict], events: list[dict] = (),
           laps: list[dict] = (), udp: str | None = None, websocket: bool = False, speed: float = 1.0,
           describe=lambda e: e["name"], rocket: str | None = None, session: dict | None = None) -> None:
    """Register a session (or use `session`, one already started) and send everything paced in
    real time (or `speed` times faster)."""
    if session is None:
        try:
            session = register(site, domain, meta, rocket=rocket)
        except LiveRefused as err:
            sys.exit(str(err))
    print(f"Live session {session['code']}: watch at {site}/?live={session['code']}")
    limit = session.get("max_samples")
    if limit and len(samples) > limit:
        print(f"warning: the server keeps {limit:,} samples per session; the last "
              f"{len(samples) - limit:,} of {len(samples):,} won't be kept (stream a shorter slice)")
    out = sender(site, udp, websocket, session.get("udp_port"))

    start = time.monotonic()
    seq = sent = 0
    try:
        for offset, due, new_events, new_laps in schedule(samples, events, laps, step=0.02 * speed):
            time.sleep(max(0.0, start + offset / speed - time.monotonic()))
            for event in new_events:
                print(f"  T{event['time']:+8.2f} s  {describe(event)}")
            for p in packets(session, due, new_events, new_laps, seq):
                out.send(p)
                seq, sent = p["seq"] + 1, sent + 1
        out.send({"v": 1, "session": session["code"], "key": session["key"], "seq": seq, "end": True})
    finally:
        out.close()
    print(f"Done: sent {len(samples)} samples in {sent + 1} packets"
          + (f"; the server rejected {out.rejected} of them" if out.rejected else "")
          + ". Once the server has the end packet, the stream is saved as a replay.")
