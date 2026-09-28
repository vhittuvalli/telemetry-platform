"""Live telemetry sessions: a sender streams samples in, viewers watch them arrive.

Senders register a session over HTTP (getting a short code and a secret key), then send
packets over UDP or a WebSocket. Every packet carries the code and key, so the two
transports are interchangeable. See docs/live-protocol.md.
"""

import asyncio
import json
import math
import secrets
import time
from bisect import bisect_right
from dataclasses import dataclass, field
from datetime import datetime, timezone

import pandas as pd

from telemetry.f1 import REPLAYS_DIR, save_metadata, save_replay

PROTOCOL_VERSION = 1
MAX_SESSIONS = 20
MAX_SAMPLES = 60_000           # per session: ten minutes at 100 Hz
IDLE_TIMEOUT_S = 10 * 60       # a session nobody has sent to in this long is closed
ENDED_KEEP_S = 10 * 60         # ended sessions stay watchable this long
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O, 1/I/L

# Rocket channels a sample may carry (docs/data-format.md, rocket flights); others are dropped
ROCKET_CHANNELS = (
    "time", "x", "y", "z", "speed", "qw", "qx", "qy", "qz", "vertical_velocity",
    "acceleration", "mach", "dynamic_pressure", "angle_of_attack", "stability_margin",
    "thrust", "mass",
)
REQUIRED = ("time", "x", "y", "z")
DEFAULTS = {"qw": 1.0}  # an unrotated rocket points straight up


class LiveError(Exception):
    """A packet or request the server refuses; the message says why."""


@dataclass
class LiveSession:
    code: str
    key: str
    domain: str
    meta: dict
    created: float = field(default_factory=time.time)
    last_packet: float = field(default_factory=time.time)
    columns: dict[str, list[float]] = field(default_factory=lambda: {c: [] for c in ROCKET_CHANNELS})
    events: list[dict] = field(default_factory=list)
    seen: set[int] = field(default_factory=set)
    packets: int = 0
    lost: int = 0                 # sequence numbers skipped over (UDP gives no resends)
    last_seq: int = -1
    ended: bool = False
    replay_id: str | None = None  # the recording, once the stream ends
    watchers: set[asyncio.Queue] = field(default_factory=set)

    @property
    def samples(self) -> int:
        return len(self.columns["time"])

    def info(self) -> dict:
        t = self.columns["time"]
        return {
            "code": self.code, "domain": self.domain, "name": self.meta.get("rocket", {}).get("name"),
            "samples": self.samples, "packets": self.packets, "lost": self.lost,
            "latest": t[-1] if t else None, "ended": self.ended, "replay_id": self.replay_id,
            "age": round(time.time() - self.created),
        }

    def snapshot(self) -> dict:
        """Everything so far, for a viewer that just joined."""
        return {"type": "snapshot", "meta": self.meta, "columns": self.columns, "events": self.events,
                "ended": self.ended, "replay_id": self.replay_id}


_sessions: dict[str, LiveSession] = {}


def _new_code() -> str:
    while True:
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))
        if code not in _sessions:
            return code


def expire() -> None:
    now = time.time()
    for code, s in list(_sessions.items()):
        idle = now - s.last_packet
        if (s.ended and idle > ENDED_KEEP_S) or (not s.ended and idle > IDLE_TIMEOUT_S):
            if not s.ended:
                end(s)
            del _sessions[code]


def create(domain: str, meta: dict) -> LiveSession:
    expire()
    if domain != "rocket":
        raise LiveError("Only rocket sessions can stream live so far")
    if len(_sessions) >= MAX_SESSIONS:
        raise LiveError("Too many live sessions right now; try again later")
    if not isinstance(meta.get("rocket"), dict):
        raise LiveError("meta.rocket (the rocket's geometry) is required")
    session = LiveSession(code=_new_code(), key=secrets.token_urlsafe(12), domain=domain, meta=meta)
    _sessions[session.code] = session
    return session


def get(code: str) -> LiveSession | None:
    expire()
    return _sessions.get(code.upper())


def active() -> list[dict]:
    expire()
    return [s.info() for s in sorted(_sessions.values(), key=lambda s: -s.created)]


def _number(value) -> float:
    v = float(value)
    if not math.isfinite(v):
        raise ValueError("not a finite number")
    return v


def ingest(packet: dict) -> LiveSession:
    """Apply one packet from a sender (UDP datagram or WebSocket message)."""
    if packet.get("v", PROTOCOL_VERSION) != PROTOCOL_VERSION:
        raise LiveError(f"Unsupported protocol version {packet.get('v')}")
    session = get(str(packet.get("session", "")))
    if session is None:
        raise LiveError("Unknown session")
    if not secrets.compare_digest(str(packet.get("key", "")), session.key):
        raise LiveError("Wrong key for this session")
    if session.ended:
        raise LiveError("This session has ended")

    seq = packet.get("seq")
    if isinstance(seq, int):
        if seq in session.seen:
            return session  # a duplicate datagram
        session.seen.add(seq)
        if len(session.seen) > 4096:
            session.seen = set(sorted(session.seen)[-2048:])
        if seq > session.last_seq + 1 and session.last_seq >= 0:
            session.lost += seq - session.last_seq - 1
        session.last_seq = max(session.last_seq, seq)
    session.packets += 1
    session.last_packet = time.time()

    new_samples = []
    for raw in packet.get("samples", []) or []:
        if session.samples >= MAX_SAMPLES:
            break
        try:
            sample = {c: _number(raw[c]) if c in raw else DEFAULTS.get(c, 0.0) for c in ROCKET_CHANNELS}
            if any(c not in raw for c in REQUIRED):
                raise ValueError("missing time/x/y/z")
        except (TypeError, ValueError, KeyError):
            continue  # one bad sample doesn't sink the packet
        _insert(session, sample)
        new_samples.append(sample)

    new_events = []
    for e in packet.get("events", []) or []:
        try:
            event = {"name": str(e["name"])[:64], "time": _number(e["time"]),
                     **{k: _number(e.get(k, 0.0)) for k in ("x", "y", "z")}}
        except (TypeError, ValueError, KeyError):
            continue
        if any(x["name"] == event["name"] and abs(x["time"] - event["time"]) < 1e-6 for x in session.events):
            continue
        session.events.append(event)
        session.events.sort(key=lambda x: x["time"])
        new_events.append(event)

    if new_samples or new_events:
        _broadcast(session, {"type": "data", "samples": new_samples, "events": new_events})
    if packet.get("end"):
        end(session)
    return session


def _insert(session: LiveSession, sample: dict) -> None:
    """Add a sample in time order; UDP can deliver packets out of order."""
    times = session.columns["time"]
    if not times or sample["time"] > times[-1]:
        for c in ROCKET_CHANNELS:
            session.columns[c].append(sample[c])
        return
    i = bisect_right(times, sample["time"])
    if i and times[i - 1] == sample["time"]:
        return  # already have this instant
    for c in ROCKET_CHANNELS:
        session.columns[c].insert(i, sample[c])


def _broadcast(session: LiveSession, message: dict) -> None:
    for queue in list(session.watchers):
        try:
            queue.put_nowait(message)
        except asyncio.QueueFull:
            session.watchers.discard(queue)  # a viewer that can't keep up drops out and reconnects


def end(session: LiveSession) -> None:
    """Close the stream and save it as a replay."""
    if session.ended:
        return
    session.ended = True
    if session.samples >= 2:
        try:
            session.replay_id = record(session)
        except OSError:
            session.replay_id = None
    _broadcast(session, {"type": "end", "replay_id": session.replay_id})


def summarize(columns: dict[str, list[float]], events: list[dict]) -> dict:
    """The same flight summary a simulated replay carries, from what was streamed."""
    t, z = columns["time"], columns["z"]
    speed = [v / 3.6 for v in columns["speed"]]
    q = columns["dynamic_pressure"]
    i_apo = max(range(len(z)), key=z.__getitem__)
    i_q = max(range(len(q)), key=q.__getitem__)
    event_time = {e["name"]: e["time"] for e in events}

    def speed_at(name):
        if name not in event_time:
            return 0.0
        return speed[min(range(len(t)), key=lambda k: abs(t[k] - event_time[name]))]

    return {
        "apogee": round(z[i_apo], 2), "apogee_time": round(event_time.get("apogee", t[i_apo]), 3),
        "max_speed": round(max(speed), 2), "max_mach": round(max(columns["mach"]), 4),
        "max_acceleration": round(max(columns["acceleration"]), 2),
        "max_q": round(q[i_q], 1), "max_q_time": round(t[i_q], 3),
        "flight_time": round(t[-1], 3), "landing": [round(columns["x"][-1], 2), round(columns["y"][-1], 2)],
        "rail_exit_speed": round(speed_at("rail_exit"), 2),
    }


def record(session: LiveSession) -> str:
    """Write the stream as a rocket replay, so it can be watched again."""
    stamp = datetime.now(timezone.utc)
    replay_id = f"live_{session.code.lower()}_{stamp:%Y%m%d_%H%M%S}"
    frame = pd.DataFrame({"time": session.columns["time"], "vehicle_id": "rocket",
                          **{c: session.columns[c] for c in ROCKET_CHANNELS if c != "time"}})
    meta = {
        **session.meta,
        "domain": "rocket",
        "session": {**session.meta.get("session", {}), "year": stamp.year,
                    "name": f"Live · {session.meta.get('session', {}).get('name', 'flight')}",
                    "date": stamp.replace(microsecond=0, tzinfo=None).isoformat()},
        "time_range": {"start": session.columns["time"][0], "end": session.columns["time"][-1]},
        "events": session.events,
        "summary": summarize(session.columns, session.events),
        "live": {"code": session.code, "packets": session.packets, "lost": session.lost},
    }
    save_replay(frame, REPLAYS_DIR / f"{replay_id}.parquet")
    save_metadata(meta, REPLAYS_DIR / f"{replay_id}.meta.json")  # written last: the replay is complete
    return replay_id


class UdpIngest(asyncio.DatagramProtocol):
    """Live packets over UDP: one JSON packet per datagram. Errors go back to the sender."""

    def __init__(self):
        self.transport = None

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data: bytes, addr):
        try:
            ingest(json.loads(data.decode("utf-8")))
        except (LiveError, ValueError, UnicodeDecodeError) as err:
            # Senders may ignore this; it's there for debugging a new sender
            self.transport.sendto(json.dumps({"error": str(err)}).encode(), addr)
