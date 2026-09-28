"""Stream a rocket flight to the platform live, the way a flight computer sends telemetry.

    # simulate and stream over UDP to a server on this machine
    python scripts/stream_rocket.py rockets/dual_parachute_deployment.json

    # stream to a remote site: run scripts/telemetry_relay.py --site <url> first, then
    python scripts/stream_rocket.py rockets/chute_release.json --site https://telemetry-platform.onrender.com

    # or skip UDP and send over a WebSocket straight to the site
    python scripts/stream_rocket.py rockets/chute_release.json --site https://... --websocket

    # re-stream a saved flight instead of simulating
    python scripts/stream_rocket.py --replay data/replays/rocket_chute_release_g40w

Samples go out paced in real time (or --speed times faster), a few per packet; the
flight events (burnout, apogee, ...) go out as they happen. See docs/live-protocol.md.
"""

import argparse
import json
import socket
import sys
import time
import urllib.request
from contextlib import ExitStack
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

MAX_PACKET = 1200  # bytes: fits in one datagram on any network without fragmenting


def load_flight(args) -> tuple[list[dict], list[dict], dict]:
    """(samples, events, registration meta) from a simulation or a saved replay."""
    import pandas as pd
    if args.replay:
        stem = Path(args.replay)
        stem = stem.with_name(stem.name.removesuffix(".parquet").removesuffix(".meta.json"))
        frame = pd.read_parquet(f"{stem}.parquet")
        meta = json.loads(Path(f"{stem}.meta.json").read_text())
        events = meta.get("events", [])
    else:
        from telemetry.rocket.flight import load_launch, simulate
        from telemetry.rocket.replay import flight_frame, flight_metadata
        from telemetry.rocket.rocket import load_rocket
        rocket, launch = load_rocket(args.rocket), load_launch(args.rocket)
        flight = simulate(rocket, launch)
        frame = flight_frame(flight)
        meta = flight_metadata(rocket, launch, flight, rocket_id=Path(args.rocket).stem)
        events = meta["events"]
    frame = frame.drop(columns=["vehicle_id"]).round(4)
    samples = frame.to_dict("records")
    # What's known before launch; results (summary, events) arrive during the flight
    registration = {k: v for k, v in meta.items() if k in ("session", "rocket", "launch")}
    registration["session"] = {**registration.get("session", {}), "location": args.site_name or
                               registration.get("launch", {}).get("site_name", "Live launch")}
    return samples, [e for e in events if e["name"] != "ignition"], registration


def register(site: str, meta: dict) -> dict:
    req = urllib.request.Request(f"{site}/live/sessions", data=json.dumps({"domain": "rocket", "meta": meta}).encode(),
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def packets(session: dict, samples: list[dict], events: list[dict], start_seq: int):
    """Split samples (and any events) into packets no bigger than MAX_PACKET bytes."""
    seq = start_seq
    base = {"v": 1, "session": session["code"], "key": session["key"]}
    batch: list[dict] = []
    for s in samples:
        trial = json.dumps({**base, "seq": seq, "samples": batch + [s], "events": events}, separators=(",", ":"))
        if batch and len(trial) > MAX_PACKET:
            yield {**base, "seq": seq, "samples": batch, "events": events}
            seq, batch, events = seq + 1, [], []
        batch.append(s)
    if batch or events:
        yield {**base, "seq": seq, "samples": batch, "events": events}


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


class WebSocketSender:
    def __init__(self, site: str):
        from websockets.sync.client import connect
        url = site.replace("https://", "wss://").replace("http://", "ws://") + "/live/ingest"
        self.stack = ExitStack()
        self.ws = self.stack.enter_context(connect(url, open_timeout=120))

    def send(self, packet: dict) -> None:
        self.ws.send(json.dumps(packet, separators=(",", ":")))

    def close(self) -> None:
        self.stack.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("rocket", nargs="?", help="rocket definition (JSON) to simulate and stream")
    parser.add_argument("--replay", help="stream a saved rocket replay instead (path without extension)")
    parser.add_argument("--site", default="http://localhost:8000", help="the platform's address")
    parser.add_argument("--udp", default="127.0.0.1:9870",
                        help="where to send UDP: the server itself, or a relay (default %(default)s)")
    parser.add_argument("--websocket", action="store_true", help="send over a WebSocket to --site instead of UDP")
    parser.add_argument("--speed", type=float, default=1.0, help="playback speed (1 = real time)")
    parser.add_argument("--site-name", help="launch site name to show viewers")
    args = parser.parse_args()
    if not args.rocket and not args.replay:
        parser.error("give a rocket definition or --replay")
    site = args.site.rstrip("/")

    samples, events, meta = load_flight(args)
    session = register(site, meta)
    print(f"Live session {session['code']}: watch at {site}/?live={session['code']}")
    if args.websocket:
        sender = WebSocketSender(site)
        print(f"Sending over WebSocket to {site}")
    else:
        host, port = args.udp.rsplit(":", 1)
        sender = UdpSender(host, int(port))
        print(f"Sending UDP to {host}:{port}")

    t0 = samples[0]["time"]
    start = time.monotonic()
    i, e, seq, sent = 0, 0, 0, 0
    while i < len(samples):
        flight_time = t0 + (time.monotonic() - start) * args.speed
        due = []
        while i < len(samples) and samples[i]["time"] <= flight_time:
            due.append(samples[i])
            i += 1
        new_events = []
        while e < len(events) and events[e]["time"] <= flight_time:
            new_events.append(events[e])
            print(f"  T+{events[e]['time']:6.2f} s  {events[e]['name']}")
            e += 1
        if due or new_events:
            for p in packets(session, due, new_events, seq):
                sender.send(p)
                seq, sent = p["seq"] + 1, sent + 1
        time.sleep(0.02)

    sender.send({"v": 1, "session": session["code"], "key": session["key"], "seq": seq,
                 "events": events[e:], "end": True})
    if hasattr(sender, "close"):
        sender.close()
    rejected = getattr(sender, "rejected", 0)
    print(f"Done: sent {len(samples)} samples in {sent + 1} packets"
          + (f"; the server rejected {rejected} of them" if rejected else "")
          + f". Once the server has the end packet, the flight is saved as a replay.")


if __name__ == "__main__":
    main()
