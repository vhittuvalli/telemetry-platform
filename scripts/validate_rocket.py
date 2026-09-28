"""Compare our simulator with OpenRocket's flight of the same rocket.

    python scripts/validate_rocket.py rockets/a_simple_model_rocket.json

Needs the reference written by scripts/openrocket_export.py (rockets/validation/<name>.openrocket.json).
"""

import argparse
import json
import sys
from bisect import bisect_left
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from telemetry.rocket.flight import load_launch, simulate  # noqa: E402
from telemetry.rocket.rocket import load_rocket  # noqa: E402


def at(times, values, t):
    """Linear interpolation of a series at time t."""
    i = min(max(bisect_left(times, t), 1), len(times) - 1)
    t0, t1 = times[i - 1], times[i]
    f = (t - t0) / (t1 - t0) if t1 > t0 else 0
    return values[i - 1] + (values[i] - values[i - 1]) * f


def least_aoa(ours, theirs, key):
    """(ours, theirs) values of `key` when OpenRocket's angle of attack is smallest during powered/coast flight."""
    candidates = [i for i, (t, a) in enumerate(zip(theirs["time"], theirs["angle_of_attack"]))
                  if a is not None and theirs[key][i] is not None and theirs["vertical_velocity"][i] > 1]
    i = min(candidates, key=lambda k: theirs["angle_of_attack"][k])
    return at(ours["time"], ours[key], theirs["time"][i]), theirs[key][i]


def compare(path: Path) -> dict:
    rocket, launch = load_rocket(path), load_launch(path)
    ref = json.loads((path.parent / "validation" / f"{path.stem}.openrocket.json").read_text())
    flight = simulate(rocket, launch)
    ours, theirs = flight.columns, ref["series"]
    ev = ref["events"]

    def first(name):
        return ev.get(name, [None])[0]

    apogee_ref = max(theirs["altitude"])
    rows = [
        ("Apogee (m)", flight.apogee, apogee_ref),
        ("Apogee time (s)", flight.event("apogee").time, first("apogee")),
        ("Max speed (m/s)", max(ours["speed"]), max(theirs["speed"])),
        ("Max acceleration (m/s²)", max(ours["acceleration"]), max(theirs["acceleration"])),
        ("Rail exit time (s)", flight.event("rail_exit").time, first("launchrod")),
        ("Burnout altitude (m)", flight.event("burnout").altitude,
         at(theirs["time"], theirs["altitude"], first("burnout"))),
        # OpenRocket's recorded stability includes angle-of-attack effects; compare at the
        # moment of least angle of attack, where both are near the zero-angle value
        ("Stability, least AoA (cal)", *least_aoa(ours, theirs, "stability_margin")),
        ("Drag coefficient, least AoA", *least_aoa(ours, theirs, "drag_coefficient")),
        ("Landing time (s)", flight.event("landing").time, first("ground_hit")),
    ]

    # Altitude curve error over the ascent
    t_apo = first("apogee")
    errs = [abs(at(ours["time"], ours["z"], t) - at(theirs["time"], theirs["altitude"], t))
            for t in theirs["time"] if 0 < t <= t_apo]
    rows.append(("Ascent altitude, worst gap (m)", max(errs), 0.0))

    print(f"\n{rocket.name} on {rocket.motor.designation} ({launch.wind_speed:g} m/s wind; "
          f"OpenRocket adds {ref['wind_turbulence']:.0%} turbulence)\n")
    print(f"{'':32}{'ours':>10}{'OpenRocket':>12}{'diff':>9}")
    for label, a, b in rows:
        diff = f"{(a - b) / b:+.1%}" if b else ""
        print(f"{label:32}{a:10.3f}{b:12.3f}{diff:>9}")
    return {label: (a, b) for label, a, b in rows}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("rockets", nargs="+", type=Path)
    for p in parser.parse_args().rockets:
        compare(p)
