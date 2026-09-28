"""Monte Carlo dispersion: fly a rocket many times with small random variations and see where it lands."""

import math
import random
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict, dataclass, replace

from telemetry.rocket.flight import Launch, simulate
from telemetry.rocket.rocket import Rocket


@dataclass(frozen=True)
class Variation:
    """One-sigma spread of each input. Relative values are fractions (0.03 = 3%)."""
    wind_speed: float = 0.25       # relative, with at least `wind_speed_min` m/s
    wind_speed_min: float = 0.5    # m/s
    wind_direction: float = 15.0   # degrees
    thrust: float = 0.03           # relative (motor-to-motor impulse)
    rail_angle: float = 1.0        # degrees of tilt error, in a random direction
    drag: float = 0.05             # relative
    mass: float = 0.02             # relative, dry mass
    parachute_cd: float = 0.07     # relative
    ejection_delay: float = 0.10   # relative (motor delay grains vary)


def perturb(rocket: Rocket, launch: Launch, v: Variation, rng: random.Random) -> tuple[Rocket, Launch]:
    """A copy of the rocket and launch with every varied input drawn from its distribution."""
    g = rng.gauss
    wind = max(0.0, launch.wind_speed + g(0, max(v.wind_speed * launch.wind_speed, v.wind_speed_min)))

    # Rail tilt error: add a small random tilt vector to the rail's nominal lean
    lean = math.radians(launch.angle)
    heading = math.radians(launch.heading)
    ex, ey = math.sin(lean) * math.sin(heading), math.sin(lean) * math.cos(heading)
    err, err_dir = abs(g(0, math.radians(v.rail_angle))), rng.uniform(0, 2 * math.pi)
    ex += math.sin(err) * math.sin(err_dir)
    ey += math.sin(err) * math.cos(err_dir)
    angle = math.degrees(math.asin(min(math.hypot(ex, ey), 1.0)))
    new_heading = math.degrees(math.atan2(ex, ey)) % 360 if angle > 1e-6 else launch.heading

    rocket = replace(
        rocket,
        motor=rocket.motor.scaled(max(0.5, g(1, v.thrust))),
        masses=[replace(m, mass=m.mass * max(0.5, g(1, v.mass))) for m in rocket.masses],
        cd_scale=rocket.cd_scale * max(0.5, g(1, v.drag)),
        recovery=[replace(r, cd=r.cd * max(0.3, g(1, v.parachute_cd))) for r in rocket.recovery],
        ejection_delay=(max(0.0, rocket.ejection_delay * g(1, v.ejection_delay))
                        if rocket.ejection_delay is not None else None),
    )
    launch = replace(launch, wind_speed=wind, wind_from=launch.wind_from + g(0, v.wind_direction),
                     angle=angle, heading=new_heading)
    return rocket, launch


def _fly(args) -> tuple[float, float, float, float] | None:
    """(landing x, landing y, apogee, flight time) of one varied flight, or None if it failed."""
    rocket, launch, variation, seed = args
    rng = random.Random(seed)
    try:
        flight = simulate(*perturb(rocket, launch, variation, rng), record_samples=False)
    except ValueError:
        return None
    x, y = flight.landing
    return x, y, flight.apogee, flight.columns["time"][-1]


def percentile(values: list[float], p: float) -> float:
    s = sorted(values)
    k = (len(s) - 1) * p
    lo, hi = math.floor(k), math.ceil(k)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def ellipse(points: list[tuple[float, float]], probability: float) -> dict:
    """The ellipse expected to hold `probability` of landings, from the points' mean and covariance."""
    n = len(points)
    mx = sum(p[0] for p in points) / n
    my = sum(p[1] for p in points) / n
    sxx = sum((p[0] - mx) ** 2 for p in points) / (n - 1)
    syy = sum((p[1] - my) ** 2 for p in points) / (n - 1)
    sxy = sum((p[0] - mx) * (p[1] - my) for p in points) / (n - 1)
    # Eigenvalues of the covariance give the spread along the ellipse's axes
    mean_var = (sxx + syy) / 2
    diff = math.sqrt(((sxx - syy) / 2) ** 2 + sxy ** 2)
    major, minor = mean_var + diff, max(mean_var - diff, 0.0)
    angle = 0.5 * math.atan2(2 * sxy, sxx - syy)  # of the major axis, counterclockwise from east
    k = math.sqrt(-2 * math.log(1 - probability))  # radius of a 2-D normal holding `probability`
    return {"probability": probability, "center": [round(mx, 2), round(my, 2)],
            "semi_major": round(k * math.sqrt(major), 2), "semi_minor": round(k * math.sqrt(minor), 2),
            "angle": round(math.degrees(angle), 2)}


def inside(point: tuple[float, float], e: dict) -> bool:
    a = math.radians(e["angle"])
    dx, dy = point[0] - e["center"][0], point[1] - e["center"][1]
    u = dx * math.cos(a) + dy * math.sin(a)
    w = -dx * math.sin(a) + dy * math.cos(a)
    return (u / max(e["semi_major"], 1e-9)) ** 2 + (w / max(e["semi_minor"], 1e-9)) ** 2 <= 1


def run(rocket: Rocket, launch: Launch, runs: int = 500, variation: Variation = Variation(),
        seed: int = 1, workers: int | None = None) -> dict:
    """Fly `runs` varied copies of the flight and summarize where they land and how high they go."""
    jobs = [(rocket, launch, variation, seed * 1_000_003 + i) for i in range(runs)]
    with ProcessPoolExecutor(max_workers=workers) as pool:
        results = [r for r in pool.map(_fly, jobs, chunksize=max(1, runs // 64)) if r is not None]
    if len(results) < 3:
        raise ValueError("Too few dispersion runs succeeded to summarize")

    landings = [(x, y) for x, y, _, _ in results]
    apogees = [a for _, _, a, _ in results]
    zones = [ellipse(landings, p) for p in (0.5, 0.95)]
    for zone in zones:
        zone["observed"] = round(sum(inside(p, zone) for p in landings) / len(landings), 3)

    distances = [math.hypot(x, y) for x, y in landings]
    return {
        "runs": runs,
        "succeeded": len(results),
        "seed": seed,
        "variation": asdict(variation),
        "apogee": {
            "mean": round(sum(apogees) / len(apogees), 2),
            "sd": round(math.sqrt(sum((a - sum(apogees) / len(apogees)) ** 2 for a in apogees) / (len(apogees) - 1)), 2),
            "p5": round(percentile(apogees, 0.05), 2),
            "p95": round(percentile(apogees, 0.95), 2),
        },
        "landing": {
            "zones": zones,
            "max_distance": round(max(distances), 2),
            "p95_distance": round(percentile(distances, 0.95), 2),
        },
        "landings": [[round(x, 2), round(y, 2)] for x, y in landings],
        "apogees": [round(a, 2) for a in apogees],
    }
