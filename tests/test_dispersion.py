"""Monte Carlo dispersion: reproducible, centered on the nominal flight, and honest about its ellipses."""

import math
import random
from pathlib import Path

import pytest

from telemetry.rocket import dispersion
from telemetry.rocket.flight import load_launch, simulate
from telemetry.rocket.rocket import load_rocket

ROCKET = Path(__file__).resolve().parent.parent / "rockets" / "chute_release.json"
NONE = dispersion.Variation(**{k: 0.0 for k in dispersion.Variation.__dataclass_fields__})


def test_no_variation_reproduces_the_nominal_flight():
    rocket, launch = load_rocket(ROCKET), load_launch(ROCKET)
    nominal = simulate(rocket, launch)
    result = dispersion.run(rocket, launch, runs=4, variation=NONE, workers=2)
    for x, y in result["landings"]:
        assert (x, y) == pytest.approx(nominal.landing, abs=0.01)
    assert result["apogee"]["sd"] == pytest.approx(0, abs=1e-6)


def test_same_seed_same_results():
    rocket, launch = load_rocket(ROCKET), load_launch(ROCKET)
    a = dispersion.run(rocket, launch, runs=8, seed=7, workers=2)
    b = dispersion.run(rocket, launch, runs=8, seed=7, workers=2)
    assert a["landings"] == b["landings"]


def test_ellipses_hold_what_they_claim_for_normal_points():
    rng = random.Random(3)
    # Correlated normal points: 30 m along a 30° axis, 10 m across it
    points = []
    for _ in range(4000):
        u, w = rng.gauss(0, 30), rng.gauss(0, 10)
        a = math.radians(30)
        points.append((100 + u * math.cos(a) - w * math.sin(a), -50 + u * math.sin(a) + w * math.cos(a)))
    for p in (0.5, 0.95):
        zone = dispersion.ellipse(points, p)
        assert zone["angle"] == pytest.approx(30, abs=2)
        share = sum(dispersion.inside(pt, zone) for pt in points) / len(points)
        assert share == pytest.approx(p, abs=0.02)
