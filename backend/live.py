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
from array import array
from bisect import bisect_right
from dataclasses import dataclass, field
from datetime import datetime, timezone

import pandas as pd

from telemetry.f1 import REPLAYS_DIR, save_metadata, save_replay

PROTOCOL_VERSION = 1
MAX_SESSIONS = 20
IDLE_TIMEOUT_S = 10 * 60       # a session nobody has sent to in this long is closed
ENDED_KEEP_S = 10 * 60         # ended sessions stay watchable this long
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O, 1/I/L

# Channels a sample may carry in each domain (docs/data-format.md); others are dropped
ROCKET_CHANNELS = (
    "time", "x", "y", "z", "speed", "qw", "qx", "qy", "qz", "vertical_velocity",
    "acceleration", "mach", "dynamic_pressure", "angle_of_attack", "stability_margin",
    "thrust", "mass",
)
F1_CHANNELS = ("time", "x", "y", "z", "speed", "throttle", "brake", "gear", "rpm", "drs", "on_track")
REQUIRED = ("time", "x", "y", "z")


@dataclass(frozen=True)
class Domain:
    channels: tuple[str, ...]
    defaults: dict               # values for channels a sample leaves out
    max_samples: int             # across all vehicles in a session


DOMAINS = {
    # ten minutes at 100 Hz
    "rocket": Domain(ROCKET_CHANNELS, {"qw": 1.0}, 60_000),
    # a full race (Monza 2024 is 360,000) with room to spare; ~40 MB in compact arrays
    "f1": Domain(F1_CHANNELS, {"on_track": 1.0}, 450_000),
}
LAP_FIELDS = ("lap_time", "lap_end", "position", "tyre_life", "stint", "pit_in", "pit_out")


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
    vehicles: dict[str, dict[str, array]] = field(default_factory=dict)  # vehicle id -> channel -> values
    events: list[dict] = field(default_factory=list)
    laps: dict[tuple[str, int], dict] = field(default_factory=dict)       # F1: (driver, lap) -> record
    samples: int = 0
    seen: set[int] = field(default_factory=set)
    packets: int = 0
    lost: int = 0                 # sequence numbers skipped over (UDP gives no resends)
    last_seq: int = -1
    ended: bool = False
    replay_id: str | None = None  # the recording, once the stream ends
    watchers: set[asyncio.Queue] = field(default_factory=set)

    @property
    def spec(self) -> Domain:
        return DOMAINS[self.domain]

    @property
    def latest(self) -> float | None:
        ends = [v["time"][-1] for v in self.vehicles.values() if len(v["time"])]
        return max(ends) if ends else None

    def info(self) -> dict:
        name = self.meta.get("rocket", {}).get("name") or self.meta.get("session", {}).get("event")
        return {
            "code": self.code, "domain": self.domain, "name": name,
            "samples": self.samples, "packets": self.packets, "lost": self.lost,
            "latest": self.latest, "ended": self.ended, "replay_id": self.replay_id,
            "age": round(time.time() - self.created),
        }

    def snapshot(self) -> dict:
        """What a viewer that just joined needs first; each vehicle's data follows in `vehicle_snapshots`."""
        return {
            "type": "snapshot", "meta": self.meta, "events": self.events, "laps": list(self.laps.values()),
            "vehicles": {}, "ended": self.ended, "replay_id": self.replay_id,
        }

    def vehicle_snapshots(self):
        """Each vehicle's samples so far, one message at a time: a whole race in one message
        would briefly need well over 100 MB, more than a small host has spare."""
        for vid in list(self.vehicles):
            cols = self.vehicles[vid]
            yield {"type": "vehicle", "id": vid, "columns": {c: list(values) for c, values in cols.items()}}


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
    if domain not in DOMAINS:
        raise LiveError(f"Unknown domain '{domain}'; use one of {', '.join(DOMAINS)}")
    if len(_sessions) >= MAX_SESSIONS:
        raise LiveError("Too many live sessions right now; try again later")
    if domain == "rocket" and not isinstance(meta.get("rocket"), dict):
        raise LiveError("meta.rocket (the rocket's geometry) is required")
    if domain == "f1":
        drivers = meta.get("drivers")
        if not isinstance(drivers, list) or not drivers or not all(isinstance(d, dict) and d.get("code") for d in drivers):
            raise LiveError("meta.drivers (a list with each driver's code) is required")
        outline = meta.get("track_outline")
        if not isinstance(outline, list) or len(outline) < 10:
            raise LiveError("meta.track_outline (the track as [x, y, z] points) is required")
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


def _vehicle_id(session: LiveSession, raw: dict) -> str:
    if session.domain == "rocket":
        return "rocket"
    vid = str(raw.get("vehicle_id", ""))
    if vid not in {d["code"] for d in session.meta["drivers"]}:
        raise ValueError(f"unknown vehicle '{vid}'")
    return vid


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

    spec = session.spec
    new_samples = []
    for raw in packet.get("samples", []) or []:
        if session.samples >= spec.max_samples:
            break
        try:
            if not isinstance(raw, dict) or any(c not in raw for c in REQUIRED):
                raise ValueError("missing time/x/y/z")
            vid = _vehicle_id(session, raw)
            sample = {c: _number(raw[c]) if raw.get(c) is not None else spec.defaults.get(c, 0.0)
                      for c in spec.channels}
        except (TypeError, ValueError):
            continue  # one bad sample doesn't sink the packet
        if _insert(session, vid, sample):
            new_samples.append({"vehicle_id": vid, **sample})

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

    new_laps = []
    for raw in packet.get("laps", []) or []:
        lap = _lap(session, raw)
        if lap:
            session.laps[(lap["driver"], lap["lap"])] = lap
            new_laps.append(lap)

    if new_samples or new_events or new_laps:
        _broadcast(session, {"type": "data", "samples": new_samples, "events": new_events, "laps": new_laps})
    if packet.get("end"):
        end(session)
    return session


def _lap(session: LiveSession, raw) -> dict | None:
    """A completed lap (F1), in the replay's laps format; None if it isn't valid."""
    if session.domain != "f1" or not isinstance(raw, dict):
        return None
    try:
        driver = str(raw["driver"])
        if driver not in {d["code"] for d in session.meta["drivers"]}:
            return None
        lap = {"driver": driver, "lap": int(raw["lap"])}
        for f in LAP_FIELDS:
            lap[f] = _number(raw[f]) if raw.get(f) is not None else None
        lap["compound"] = str(raw["compound"])[:16] if raw.get("compound") else None
        return lap
    except (KeyError, TypeError, ValueError):
        return None


def _insert(session: LiveSession, vid: str, sample: dict) -> bool:
    """Add a sample in time order (UDP can deliver packets out of order); False if it's a repeat."""
    cols = session.vehicles.get(vid)
    if cols is None:
        cols = session.vehicles[vid] = {c: array("d") for c in session.spec.channels}
    times = cols["time"]
    if not times or sample["time"] > times[-1]:
        for c, values in cols.items():
            values.append(sample[c])
    else:
        i = bisect_right(times, sample["time"])
        if i and times[i - 1] == sample["time"]:
            return False  # already have this instant
        for c, values in cols.items():
            values.insert(i, sample[c])
    session.samples += 1
    return True


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
    if any(len(cols["time"]) >= 2 for cols in session.vehicles.values()):
        try:
            session.replay_id = record(session)
        except OSError:
            session.replay_id = None
    _broadcast(session, {"type": "end", "replay_id": session.replay_id})


def summarize(columns: dict, events: list[dict]) -> dict:
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


def _frame(session: LiveSession) -> pd.DataFrame:
    """Every vehicle's samples in the replay's long format."""
    frames = [pd.DataFrame({"time": list(cols["time"]), "vehicle_id": vid,
                            **{c: list(v) for c, v in cols.items() if c != "time"}})
              for vid, cols in session.vehicles.items() if len(cols["time"])]
    frame = pd.concat(frames, ignore_index=True).sort_values(["time", "vehicle_id"], ignore_index=True)
    if session.domain == "f1":
        # The replay format's integer and flag channels
        for c in ("brake", "gear", "drs"):
            frame[c] = frame[c].round().astype("Int8")
        frame["on_track"] = frame["on_track"] > 0.5
    return frame


def record(session: LiveSession) -> str:
    """Write the stream as a replay, so it can be watched again."""
    stamp = datetime.now(timezone.utc)
    replay_id = f"live_{session.code.lower()}_{stamp:%Y%m%d_%H%M%S}"
    frame = _frame(session)
    base_name = session.meta.get("session", {}).get("name", "flight" if session.domain == "rocket" else "session")
    meta = {
        **session.meta,
        "domain": session.domain,
        "session": {**session.meta.get("session", {}), "year": stamp.year, "name": f"Live · {base_name}",
                    "date": stamp.replace(microsecond=0, tzinfo=None).isoformat()},
        "time_range": {"start": float(frame["time"].min()), "end": float(frame["time"].max())},
        "live": {"code": session.code, "packets": session.packets, "lost": session.lost},
    }
    if session.domain == "rocket":
        cols = session.vehicles["rocket"]
        meta["events"] = session.events
        meta["summary"] = summarize(cols, session.events)
    save_replay(frame, REPLAYS_DIR / f"{replay_id}.parquet")
    save_metadata(meta, REPLAYS_DIR / f"{replay_id}.meta.json")
    if session.domain == "f1":
        # Written last: an F1 replay counts as complete once its laps file exists
        laps = sorted(session.laps.values(), key=lambda l: (l["lap_end"] is None, l["lap_end"] or 0))
        (REPLAYS_DIR / f"{replay_id}.laps.json").write_text(json.dumps(laps, indent=2))
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
