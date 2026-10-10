"""Ready-to-stream sessions: a simulated rocket flight, or a saved rocket or F1 replay, as the
samples, events, laps and registration meta that `telemetry.live_client` sends.

Used by scripts/stream_rocket.py and scripts/stream_f1.py, and by the server's demo streams.
"""

import json
import math
from dataclasses import dataclass, field, replace
from pathlib import Path


@dataclass
class LiveStream:
    domain: str
    meta: dict                      # what's known before the start (POST /live/sessions)
    samples: list[dict]
    events: list[dict] = field(default_factory=list)
    laps: list[dict] = field(default_factory=list)
    summary: dict | None = None     # a simulated flight's results, for the streamer to print


def _stem(path: str | Path) -> Path:
    stem = Path(path)
    return stem.with_name(stem.name.removesuffix(".parquet").removesuffix(".meta.json"))


def _rocket_stream(frame, meta: dict, events: list[dict], site_name: str | None) -> LiveStream:
    frame = frame.drop(columns=["vehicle_id"]).round(4)
    # What's known before launch; results (summary, events) arrive during the flight
    registration = {k: v for k, v in meta.items() if k in ("session", "rocket", "launch")}
    registration["session"] = {**registration.get("session", {}), "location": site_name or
                               registration.get("launch", {}).get("site_name", "Live launch")}
    return LiveStream("rocket", registration, frame.to_dict("records"),
                      events=[e for e in events if e["name"] != "ignition"], summary=meta.get("summary"))


def rocket_flight(rocket_path: str | Path, motor: str | None = None, delay: float | None = None,
                  wind: float | None = None, wind_from: float | None = None, angle: float | None = None,
                  heading: float | None = None, site_name: str | None = None) -> LiveStream:
    """Simulate a rocket design (with another motor or launch conditions, if given) to stream it."""
    from telemetry.rocket import catalog
    from telemetry.rocket.flight import load_launch, simulate
    from telemetry.rocket.replay import flight_frame, flight_metadata
    from telemetry.rocket.rocket import load_rocket
    rocket, launch = load_rocket(rocket_path), load_launch(rocket_path)
    if motor:
        rocket = catalog.with_motor(rocket, motor, delay if delay is not None else rocket.ejection_delay)
    elif delay is not None:
        rocket = replace(rocket, ejection_delay=delay)
    overrides = {"wind_speed": wind, "wind_from": wind_from, "angle": angle, "heading": heading}
    launch = replace(launch, **{k: v for k, v in overrides.items() if v is not None})
    flight = simulate(rocket, launch)
    meta = flight_metadata(rocket, launch, flight, rocket_id=Path(rocket_path).stem)
    return _rocket_stream(flight_frame(flight), meta, meta["events"], site_name)


def rocket_replay(path: str | Path, site_name: str | None = None) -> LiveStream:
    """A saved rocket replay (path without extension), to stream again."""
    import pandas as pd
    stem = _stem(path)
    meta = json.loads(Path(f"{stem}.meta.json").read_text())
    return _rocket_stream(pd.read_parquet(f"{stem}.parquet"), meta, meta.get("events", []), site_name)


def f1_replay(path: str | Path, start: float | None = None, end: float | None = None) -> LiveStream:
    """A saved F1 replay (path without extension), or the slice of it from `start` to `end` s."""
    import pandas as pd
    stem = _stem(path)
    filters = [f for f in (("time", ">=", start) if start is not None else None,
                           ("time", "<=", end) if end is not None else None) if f]
    frame = pd.read_parquet(f"{stem}.parquet", filters=filters or None)
    meta = json.loads(Path(f"{stem}.meta.json").read_text())
    laps = json.loads(Path(f"{stem}.laps.json").read_text())
    if end is not None:
        laps = [l for l in laps if l.get("lap_end") is not None and l["lap_end"] <= end]
    if start is not None:
        laps = [l for l in laps if l.get("lap_end") is None or l["lap_end"] >= start]

    frame = frame.assign(on_track=frame["on_track"].astype(int)).round(3)
    # Leave out missing values: the server fills in defaults
    samples = [{k: v for k, v in row.items() if not (isinstance(v, float) and math.isnan(v)) and v is not pd.NA}
               for row in frame.to_dict("records")]
    for s in samples:
        for k in ("brake", "gear", "drs"):
            if k in s:
                s[k] = int(s[k])
    registration = {"session": meta["session"], "drivers": meta["drivers"], "track_outline": meta["track_outline"]}
    return LiveStream("f1", registration, samples, laps=laps)
