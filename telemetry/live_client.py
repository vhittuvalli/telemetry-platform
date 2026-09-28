"""Send telemetry to the platform live (see docs/live-protocol.md): register a session,
then stream samples, events and laps in real time over UDP or a WebSocket."""

import json
import socket
import time
import urllib.request
from contextlib import ExitStack

MAX_PACKET = 1200  # bytes: fits in one datagram on any network without fragmenting


def register(site: str, domain: str, meta: dict) -> dict:
    """Start a live session; returns its code (for viewers) and key (for packets)."""
    req = urllib.request.Request(f"{site}/live/sessions", data=json.dumps({"domain": domain, "meta": meta}).encode(),
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


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


def sender(site: str, udp: str, websocket: bool):
    if websocket:
        print(f"Sending over WebSocket to {site}")
        return WebSocketSender(site)
    host, port = udp.rsplit(":", 1)
    print(f"Sending UDP to {host}:{port}")
    return UdpSender(host, int(port))


def stream(site: str, domain: str, meta: dict, samples: list[dict], events: list[dict] = (),
           laps: list[dict] = (), udp: str = "127.0.0.1:9870", websocket: bool = False, speed: float = 1.0,
           describe=lambda e: e["name"]) -> None:
    """Register a session and send everything paced in real time (or `speed` times faster).

    Samples go out when their `time` comes up, events at their `time`, laps at their `lap_end`.
    """
    session = register(site, domain, meta)
    print(f"Live session {session['code']}: watch at {site}/?live={session['code']}")
    out = sender(site, udp, websocket)
    samples = sorted(samples, key=lambda s: s["time"])
    events = sorted(events, key=lambda e: e["time"])
    laps = sorted((l for l in laps if l.get("lap_end") is not None), key=lambda l: l["lap_end"])

    t0 = samples[0]["time"]
    start = time.monotonic()
    i = e = k = seq = sent = 0
    try:
        while i < len(samples):
            now = t0 + (time.monotonic() - start) * speed
            due = []
            while i < len(samples) and samples[i]["time"] <= now:
                due.append(samples[i])
                i += 1
            new_events = []
            while e < len(events) and events[e]["time"] <= now:
                new_events.append(events[e])
                print(f"  T{events[e]['time']:+8.2f} s  {describe(events[e])}")
                e += 1
            new_laps = []
            while k < len(laps) and laps[k]["lap_end"] <= now:
                new_laps.append(laps[k])
                k += 1
            if due or new_events or new_laps:
                for p in packets(session, due, new_events, new_laps, seq):
                    out.send(p)
                    seq, sent = p["seq"] + 1, sent + 1
            time.sleep(0.02)
        out.send({"v": 1, "session": session["code"], "key": session["key"], "seq": seq,
                  "events": events[e:], "laps": laps[k:], "end": True})
    finally:
        out.close()
    print(f"Done: sent {len(samples)} samples in {sent + 1} packets"
          + (f"; the server rejected {out.rejected} of them" if out.rejected else "")
          + ". Once the server has the end packet, the stream is saved as a replay.")
