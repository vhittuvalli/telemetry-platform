"""Turn a simulated flight into replay files (see docs/data-format.md, rocket domain)."""

from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from telemetry.f1 import REPLAYS_DIR, save_metadata, save_replay, slugify
from telemetry.rocket.flight import Flight, Launch
from telemetry.rocket.rocket import Rocket

VEHICLE_ID = "rocket"


def replay_id(rocket: Rocket) -> str:
    return f"rocket_{slugify(rocket.name)}_{slugify(rocket.motor.designation)}"


def flight_frame(flight: Flight) -> pd.DataFrame:
    """The flight in the replay's long format: one row per sample for the single vehicle."""
    c = flight.columns
    frame = pd.DataFrame({
        "time": c["time"],
        "vehicle_id": VEHICLE_ID,
        "x": c["x"], "y": c["y"], "z": c["z"],
        "speed": [v * 3.6 for v in c["speed"]],  # km/h, like every domain's `speed`
        "qw": c["qw"], "qx": c["qx"], "qy": c["qy"], "qz": c["qz"],
        "vertical_velocity": c["vertical_velocity"],
        "acceleration": c["acceleration"],
        "mach": c["mach"],
        "dynamic_pressure": c["dynamic_pressure"],
        "angle_of_attack": c["angle_of_attack"],
        "stability_margin": c["stability_margin"],
        "thrust": c["thrust"],
        "mass": c["mass"],
    })
    return frame.round(5)


def flight_metadata(rocket: Rocket, launch: Launch, flight: Flight, when: datetime | None = None) -> dict:
    when = when or datetime.now(timezone.utc)
    c = flight.columns
    events = []
    for e in flight.events:
        i = min(range(len(c["time"])), key=lambda k: abs(c["time"][k] - e.time))
        events.append({"name": e.name, "time": e.time, "x": round(c["x"][i], 2), "y": round(c["y"][i], 2),
                       "z": round(e.altitude, 2)})
    motor = rocket.motor
    return {
        "domain": "rocket",
        "session": {
            "year": when.year,
            "event": rocket.name,
            "location": launch.site_name,
            "name": f"{motor.designation} flight",
            "date": when.replace(microsecond=0, tzinfo=None).isoformat(),
        },
        "time_range": {"start": 0.0, "end": round(c["time"][-1], 3)},
        "rocket": {
            "name": rocket.name,
            "length": round(rocket.length, 4),
            "diameter": round(rocket.diameter, 4),
            "cg": round(rocket.mass_properties(0)[1], 4),  # the point the flight's position tracks
            "nose": asdict(rocket.nose),
            "body_tubes": [asdict(b) for b in rocket.body_tubes],
            "fins": [asdict(f) for f in rocket.fins],
            "motor": {
                "designation": motor.designation, "manufacturer": motor.manufacturer,
                "diameter": motor.diameter, "length": motor.length,
                "total_impulse": round(motor.total_impulse, 2), "burn_time": round(motor.burn_time, 3),
                "max_thrust": round(max(motor.thrusts), 2),
                "aft_position": rocket.motor_aft,
            },
            "recovery": [asdict(r) for r in rocket.recovery],
        },
        "launch": asdict(launch),
        "events": events,
        "summary": flight.summary(),
    }


def save_flight(rocket: Rocket, launch: Launch, flight: Flight, replays_dir: Path = REPLAYS_DIR,
                dispersion: dict | None = None) -> str:
    """Write the flight's replay files (and Monte Carlo results, if given); returns the replay id."""
    stem = replay_id(rocket)
    meta = flight_metadata(rocket, launch, flight)
    dispersion_path = replays_dir / f"{stem}.dispersion.json"
    if dispersion:
        save_metadata(dispersion, dispersion_path)
        # The summary rides along in the metadata; the individual runs are fetched separately
        meta["dispersion"] = {k: v for k, v in dispersion.items() if k not in ("landings", "apogees")}
    elif dispersion_path.exists():
        dispersion_path.unlink()  # results from an earlier flight no longer apply
    #metadata is written last: a rocket replay counts as built once both files exist
    save_replay(flight_frame(flight), replays_dir / f"{stem}.parquet")
    save_metadata(meta, replays_dir / f"{stem}.meta.json")
    return stem
