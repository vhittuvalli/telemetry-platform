"""Rocket simulator checks: exact physics cases, and agreement with OpenRocket on its own examples."""

import json
import math
from pathlib import Path

import pytest

from telemetry.rocket.atmosphere import G0, air_at
from telemetry.rocket.flight import Launch, load_launch, simulate
from telemetry.rocket.motor import Motor, load_eng
from telemetry.rocket.rocket import BodyTube, FinSet, MassItem, NoseCone, Rocket, load_rocket

ROCKETS = Path(__file__).resolve().parent.parent / "rockets"
VALIDATED = sorted(p.name.removesuffix(".openrocket.json") for p in (ROCKETS / "validation").glob("*.openrocket.json"))


def test_standard_atmosphere():
    sea = air_at(0)
    assert sea.density == pytest.approx(1.225, rel=1e-3)
    assert sea.speed_of_sound == pytest.approx(340.3, rel=1e-3)
    assert air_at(11000).density == pytest.approx(0.3639, rel=1e-3)


def test_eng_motor_matches_openrocket_impulse():
    a8 = load_eng(ROCKETS / "motors" / "estes_a8.eng")
    assert a8.total_impulse == pytest.approx(2.3202, rel=1e-3)  # OpenRocket's own estimate
    assert a8.mass(0) == pytest.approx(0.01635)
    assert a8.mass(a8.burn_time) == pytest.approx(0.01635 - a8.propellant_mass)


def vacuum_rocket(thrust=100.0, burn=2.0, dry=1.0, propellant=0.5) -> Rocket:
    """A rocket with no drag, flying straight up: its flight has an exact answer."""
    motor = Motor("T", "test", 0.03, 0.2, propellant, propellant + 0.1,
                  [0.0, 1e-9, burn - 1e-9, burn], [0.0, thrust, thrust, 0.0])
    return Rocket(
        name="vacuum", nose=NoseCone("ogive", 0.2, 0.05), body_tubes=[BodyTube(1.0, 0.05, 0.2)],
        fins=[FinSet(4, 0.1, 0.05, 0.05, 0.05, 0.003, 1.05)],
        masses=[MassItem("body", dry, 0.6)], motor=motor, motor_aft=1.2, ejection_delay=None, cd_override=0.0,
    )


def test_vacuum_flight_matches_rocket_equation():
    thrust, burn, dry, propellant = 100.0, 2.0, 1.0, 0.5
    flight = simulate(vacuum_rocket(thrust, burn, dry, propellant), Launch(rail_length=0.5))

    # Constant thrust, propellant burning at a constant rate: v(t) = u·ln(m0/m) − g·t
    m0 = dry + propellant + 0.1
    rate = propellant / burn
    u = thrust / rate
    v_burnout = u * math.log(m0 / (m0 - propellant)) - G0 * burn
    # h(t) = ∫v dt, integrated in closed form
    h_burnout = u * ((m0 - rate * burn) / rate * math.log((m0 - rate * burn) / m0) + burn) - G0 * burn ** 2 / 2
    apogee = h_burnout + v_burnout ** 2 / (2 * G0)

    assert flight.apogee == pytest.approx(apogee, rel=1e-4)
    times = flight.columns["time"]
    at_burnout = min(range(len(times)), key=lambda i: abs(times[i] - burn))
    assert flight.columns["vz"][at_burnout] == pytest.approx(v_burnout, rel=1e-6)
    assert flight.columns["z"][at_burnout] == pytest.approx(h_burnout, rel=1e-6)
    assert flight.event("apogee").time == pytest.approx(burn + v_burnout / G0, rel=1e-4)


def test_rocket_weathercocks_into_the_wind():
    rocket = load_rocket(ROCKETS / "chute_release.json")
    flight = simulate(rocket, Launch(rail_length=1.0, wind_speed=5.0, wind_from=90.0))  # wind from the east
    apogee = flight.event("apogee").time
    x_at_apogee = next(x for t, x in zip(flight.columns["time"], flight.columns["x"]) if t >= apogee)
    assert x_at_apogee > 5, "the nose turns into the wind, so the rocket climbs toward the east"
    assert flight.landing[0] < x_at_apogee, "then it drifts downwind (west) under the parachute"


@pytest.mark.parametrize("name", VALIDATED)
def test_matches_openrocket(name):
    """OpenRocket 23.09's flight of the same design (see scripts/openrocket_export.py)."""
    path = ROCKETS / f"{name}.json"
    ref = json.loads((ROCKETS / "validation" / f"{name}.openrocket.json").read_text())
    theirs = ref["series"]
    flight = simulate(load_rocket(path), load_launch(path))

    assert flight.apogee == pytest.approx(max(theirs["altitude"]), rel=0.02)
    assert max(flight.columns["speed"]) == pytest.approx(max(theirs["speed"]), rel=0.01)
    assert flight.event("apogee").time == pytest.approx(ref["events"]["apogee"][0], rel=0.02)
    assert flight.event("burnout").altitude == pytest.approx(
        max(a for t, a in zip(theirs["time"], theirs["altitude"]) if t <= ref["events"]["burnout"][0]), rel=0.02)
