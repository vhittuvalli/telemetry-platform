"""The rocket designs and motors in rockets/, for picking a flight to simulate."""

import json
import os
from dataclasses import replace
from pathlib import Path

from telemetry.rocket.flight import load_launch
from telemetry.rocket.motor import Motor, load_eng
from telemetry.rocket.rocket import Rocket, load_rocket

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
ROCKETS_DIR = Path(os.environ.get("ROCKETS_DIR", PROJECT_ROOT / "rockets"))
MOTORS_DIR = ROCKETS_DIR / "motors"


def motor_summary(file: str, motor: Motor) -> dict:
    return {
        "file": file,
        "designation": motor.designation,
        "manufacturer": motor.manufacturer,
        "diameter": round(motor.diameter * 1000),  # mm, what motor mounts are sized by
        "total_impulse": round(motor.total_impulse, 1),
        "burn_time": round(motor.burn_time, 2),
        "max_thrust": round(max(motor.thrusts), 1),
        "delays": motor.delays or [],
    }


def motors() -> list[dict]:
    """Every motor in rockets/motors, smallest impulse first."""
    found = [motor_summary(p.name, load_eng(p)) for p in sorted(MOTORS_DIR.glob("*.eng"))]
    return sorted(found, key=lambda m: (m["diameter"], m["total_impulse"]))


def rocket_path(rocket_id: str) -> Path:
    path = ROCKETS_DIR / f"{rocket_id}.json"
    if path.parent != ROCKETS_DIR or not path.exists():
        raise FileNotFoundError(f"No rocket '{rocket_id}'")
    return path


def rockets() -> list[dict]:
    """Every rocket design, with the motor and launch conditions it was set up with."""
    out = []
    for path in sorted(ROCKETS_DIR.glob("*.json")):
        spec = json.loads(path.read_text())
        rocket = load_rocket(path)
        out.append({
            "id": path.stem,
            "name": rocket.name,
            "length": round(rocket.length, 3),
            "diameter": round(rocket.diameter, 4),
            "motor": motor_summary(Path(spec["motor"]["file"]).name, rocket.motor),
            "ejection_delay": rocket.ejection_delay,
            "uses_ejection": any(r.deploy == "ejection" for r in rocket.recovery),
            "launch": vars(load_launch(path)),
        })
    return out


def with_motor(rocket: Rocket, motor_file: str, ejection_delay: float | None) -> Rocket:
    """The rocket flying a different motor of the same diameter (so it fits the mount)."""
    path = MOTORS_DIR / motor_file
    if path.parent != MOTORS_DIR or not path.exists():
        raise FileNotFoundError(f"No motor '{motor_file}'")
    motor = load_eng(path)
    if round(motor.diameter * 1000) != round(rocket.motor.diameter * 1000):
        raise ValueError(f"{motor.designation} is {motor.diameter * 1000:.0f} mm; "
                         f"{rocket.name}'s motor mount takes {rocket.motor.diameter * 1000:.0f} mm")
    return replace(rocket, motor=motor, ejection_delay=ejection_delay)
