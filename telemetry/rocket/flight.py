"""6-DOF flight simulation: position, velocity, orientation and pitch/yaw rates, stepped with RK4.

World frame: x east, y north, z up, origin at the launch pad (the replay format's axes).
Body frame: +z points out of the nose. Orientation is a unit quaternion (w, x, y, z)
rotating body vectors into the world frame. Roll is not modeled (no canted fins).
"""

import math
import random
from dataclasses import dataclass, field

from telemetry.rocket.atmosphere import G0, air_at
from telemetry.rocket.rocket import Rocket

# ---------- small vector and quaternion helpers (plain floats are much faster than numpy here) ----------


def add(a, b): return (a[0] + b[0], a[1] + b[1], a[2] + b[2])
def sub(a, b): return (a[0] - b[0], a[1] - b[1], a[2] - b[2])
def scale(a, k): return (a[0] * k, a[1] * k, a[2] * k)
def dot(a, b): return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
def norm(a): return math.sqrt(dot(a, a))


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def qmul(p, q):
    pw, px, py, pz = p
    qw, qx, qy, qz = q
    return (pw * qw - px * qx - py * qy - pz * qz,
            pw * qx + px * qw + py * qz - pz * qy,
            pw * qy - px * qz + py * qw + pz * qx,
            pw * qz + px * qy - py * qx + pz * qw)


def rotate(q, v):
    """Rotate vector v by unit quaternion q."""
    w, x, y, z = q
    u = (x, y, z)
    t = scale(cross(u, v), 2)
    return add(add(v, scale(t, w)), cross(u, t))


def conj(q): return (q[0], -q[1], -q[2], -q[3])


def qnormalize(q):
    n = math.sqrt(sum(c * c for c in q))
    return tuple(c / n for c in q)


def qslerp(a, b, f):
    d = sum(x * y for x, y in zip(a, b))
    if d < 0:
        b, d = tuple(-c for c in b), -d
    if d > 0.9995:
        return qnormalize(tuple(x + (y - x) * f for x, y in zip(a, b)))
    theta = math.acos(d)
    s = math.sin(theta)
    wa, wb = math.sin((1 - f) * theta) / s, math.sin(f * theta) / s
    return tuple(wa * x + wb * y for x, y in zip(a, b))


def pointing(elevation: float, heading: float):
    """Quaternion turning body +z to a direction `elevation` above the horizon, toward compass `heading` (radians)."""
    target = (math.cos(elevation) * math.sin(heading), math.cos(elevation) * math.cos(heading), math.sin(elevation))
    axis = cross((0.0, 0.0, 1.0), target)
    s = norm(axis)
    if s < 1e-9:
        return (1.0, 0.0, 0.0, 0.0)
    angle = math.atan2(s, target[2])
    axis = scale(axis, math.sin(angle / 2) / s)
    return (math.cos(angle / 2), *axis)


UP = (1.0, 0.0, 0.0, 0.0)

# ---------- launch conditions ----------


@dataclass
class Launch:
    rail_length: float = 1.0       # m
    angle: float = 0.0             # degrees from vertical
    heading: float = 0.0           # compass degrees the rail tilts toward
    wind_speed: float = 0.0        # m/s, measured 10 m above the ground
    wind_from: float = 0.0         # compass degrees the wind blows from
    wind_gradient: float = 1 / 7   # wind grows with height as (z / 10 m) ** this; 0 keeps it constant
    turbulence: float = 0.1        # gusts' standard deviation, as a fraction of the wind speed
    turbulence_seed: int = 0       # which gusts: the same seed flies the same flight
    site_name: str = "Launch site"
    site_altitude: float = 0.0     # m above sea level
    temperature: float = 288.15    # K at the site
    pressure: float = 101325.0     # Pa at the site

    @property
    def wind(self):
        """The wind at the reference height, without gusts."""
        h = math.radians(self.wind_from)
        return (-self.wind_speed * math.sin(h), -self.wind_speed * math.cos(h), 0.0)

    @property
    def rail_direction(self):
        e, h = math.radians(90 - self.angle), math.radians(self.heading)
        return (math.cos(e) * math.sin(h), math.cos(e) * math.cos(h), math.sin(e))


class Wind:
    """The wind at any height and time: a mean wind growing with height (the power law for open
    country) plus gusts. Gusts are a sum of sine waves with random phases and a pink spectrum
    (amplitude falling as 1/sqrt(frequency)), like OpenRocket's turbulence, seeded so a flight
    replays the same. Vertical gusts are half as strong as those along the wind."""

    REFERENCE_HEIGHT = 10.0                         # m, where wind_speed is measured
    FREQUENCIES = [0.03 * 1.8 ** k for k in range(9)]  # Hz, 0.03 to 3.3
    AXES = (1.0, 0.8, 0.5)                          # along the wind, across it, vertical

    def __init__(self, launch: Launch):
        h = math.radians(launch.wind_from)
        self.along = (-math.sin(h), -math.cos(h), 0.0)
        self.across = (-math.cos(h), math.sin(h), 0.0)
        self.speed = launch.wind_speed
        self.gradient = launch.wind_gradient
        rng = random.Random(launch.turbulence_seed)
        weights = [f ** -0.5 for f in self.FREQUENCIES]
        norm_ = math.sqrt(sum(w * w for w in weights) / 2)  # a sine of amplitude a has std a/sqrt(2)
        self.components = [
            [(2 * math.pi * f, w / norm_ * launch.turbulence * k, rng.uniform(0, 2 * math.pi))
             for f, w in zip(self.FREQUENCIES, weights)]
            for k in self.AXES
        ]

    def mean_speed(self, z: float) -> float:
        if not self.gradient:
            return self.speed
        return self.speed * (max(z, 0.5) / self.REFERENCE_HEIGHT) ** self.gradient

    def at(self, z: float, t: float):
        mean = self.mean_speed(z)
        if mean == 0.0:
            return (0.0, 0.0, 0.0)
        g = [sum(a * math.sin(w * t + phase) for w, a, phase in axis) * mean for axis in self.components]
        u, v = mean + g[0], g[1]
        return (self.along[0] * u + self.across[0] * v, self.along[1] * u + self.across[1] * v, g[2])


class Canopy:
    """A recovery device opening: its drag area grows from nothing over the filling time, about
    eight canopy diameters of travel at the opening speed (Knacke), which gives the opening shock."""

    FILL_DIAMETERS = 8.0

    def __init__(self, device, t: float, speed: float):
        self.device = device
        self.opened = t
        self.fill_time = min(max(self.FILL_DIAMETERS * device.diameter / max(speed, 1.0), 0.1), 3.0)

    def fill(self, t: float) -> float:
        f = (t - self.opened) / self.fill_time
        return 1.0 if f >= 1 else max(f, 0.0) ** 2

    def drag_area(self, t: float) -> float:
        return self.device.drag_area * self.fill(t)


class Swing:
    """The rocket hanging under its parachute as a damped pendulum from the canopy, pushed by gusts
    and by the jerk of opening. `tilt` is the rocket's lean from vertical (radians, toward east and
    north); the canopy is the pivot, so the rocket's CG swings `length` meters below it."""

    DAMPING = 0.35  # 1/s: air resistance on the rocket and canopy; a swing halves in about 4 s

    def __init__(self, length: float, tilt: tuple[float, float]):
        self.length = max(length, 0.2)
        self.tilt = list(tilt)
        self.rate = [0.0, 0.0]

    def step(self, dt: float, pivot_accel: tuple[float, float]) -> None:
        # Small substeps: the pendulum (period ~2 s) is faster than the descent's time step
        n = max(1, math.ceil(dt / 0.01))
        h = dt / n
        for _ in range(n):
            for i in (0, 1):
                acc = -(G0 / self.length) * math.sin(self.tilt[i]) - self.DAMPING * self.rate[i] \
                      - pivot_accel[i] / self.length * math.cos(self.tilt[i])
                self.rate[i] += acc * h
                self.tilt[i] += self.rate[i] * h

    def axis(self):
        """The rocket's axis (nose direction): along the lines up to the canopy."""
        x, y = math.sin(self.tilt[0]), math.sin(self.tilt[1])
        return (x, y, math.sqrt(max(1.0 - x * x - y * y, 0.0)))

    def offset(self):
        """Where the CG hangs relative to straight below the canopy."""
        ax = self.axis()
        return scale(sub((0.0, 0.0, 1.0), ax), self.length)


def lean_toward(axis):
    """Quaternion turning body +z (the nose) to `axis`, a unit vector."""
    cr = cross((0.0, 0.0, 1.0), axis)
    s = norm(cr)
    if s < 1e-9:
        return UP
    angle = math.atan2(s, axis[2])
    return (math.cos(angle / 2), *scale(cr, math.sin(angle / 2) / s))


# ---------- results ----------

CHANNELS = [
    "time", "x", "y", "z", "vx", "vy", "vz", "qw", "qx", "qy", "qz",
    "speed", "vertical_velocity", "acceleration", "mach", "dynamic_pressure",
    "angle_of_attack", "stability_margin", "thrust", "mass", "drag_coefficient",
]


@dataclass
class FlightEvent:
    name: str
    time: float
    altitude: float


@dataclass
class Flight:
    columns: dict[str, list[float]]
    events: list[FlightEvent] = field(default_factory=list)

    def event(self, name: str) -> FlightEvent | None:
        return next((e for e in self.events if e.name == name), None)

    @property
    def apogee(self) -> float:
        e = self.event("apogee")
        return max(max(self.columns["z"]), e.altitude if e else 0.0)

    @property
    def landing(self) -> tuple[float, float]:
        return self.columns["x"][-1], self.columns["y"][-1]

    def summary(self) -> dict:
        c = self.columns
        imax = max(range(len(c["dynamic_pressure"])), key=c["dynamic_pressure"].__getitem__)
        return {
            "apogee": round(self.apogee, 2),
            "apogee_time": round(self.event("apogee").time, 3) if self.event("apogee") else None,
            "max_speed": round(max(c["speed"]), 2),
            "max_mach": round(max(c["mach"]), 4),
            "max_acceleration": round(max(c["acceleration"]), 2),
            "max_q": round(c["dynamic_pressure"][imax], 1),
            "max_q_time": round(c["time"][imax], 3),
            "flight_time": round(c["time"][-1], 3),
            "landing": [round(v, 2) for v in self.landing],
            "rail_exit_speed": round(self._speed_at("rail_exit"), 2),
        }

    def _speed_at(self, name: str) -> float:
        e = self.event(name)
        if not e:
            return 0.0
        i = min(range(len(self.columns["time"])), key=lambda k: abs(self.columns["time"][k] - e.time))
        return self.columns["speed"][i]


# ---------- simulation ----------


class _Model:
    """Forces and moments on the rocket; `derivative` is what RK4 integrates."""

    def __init__(self, rocket: Rocket, launch: Launch):
        self.rocket = rocket
        self.launch = launch
        self.wind = Wind(launch)
        self.canopies: list[Canopy] = []  # recovery devices deployed so far

    def canopy_drag_area(self, t: float) -> float:
        return sum(c.drag_area(t) for c in self.canopies)

    def forces(self, t, pos, vel, q, omega):
        """Acceleration, angular acceleration and the quantities recorded each sample."""
        rocket, launch = self.rocket, self.launch
        mass, cg, inertia = rocket.mass_properties(t)
        air = air_at(launch.site_altitude + pos[2], launch.temperature, launch.pressure)
        axis = rotate(q, (0.0, 0.0, 1.0))
        v_air = sub(vel, self.wind.at(pos[2], t))
        speed = norm(v_air)
        qdyn = 0.5 * air.density * speed * speed
        thrust = rocket.motor.thrust(t)

        force = add(scale(axis, thrust), (0.0, 0.0, -G0 * mass))
        torque = (0.0, 0.0, 0.0)
        cd = rocket.drag_coefficient(speed, air)
        mach = speed / air.speed_of_sound
        cn_alpha, cp = rocket.normal_force(mach)
        aoa = 0.0

        under_canopy = bool(self.canopies)
        if speed > 1e-6:
            # Under an open parachute only the parachutes' drag counts, as in OpenRocket; while
            # one fills, the rocket's own drag fades out as the canopy's grows
            drag_area = cd * rocket.reference_area
            if under_canopy:
                fill = max(c.fill(t) for c in self.canopies)
                drag_area = self.canopy_drag_area(t) + drag_area * (1 - fill)
            force = add(force, scale(v_air, -qdyn * drag_area / speed))

            if not under_canopy:
                axial = dot(v_air, axis)
                lateral = sub(v_air, scale(axis, axial))
                lat = norm(lateral)
                aoa = math.atan2(lat, axial)
                if lat > 1e-9:
                    normal = scale(lateral, -qdyn * rocket.reference_area * cn_alpha * math.sin(aoa) / lat)
                    force = add(force, normal)
                    torque = cross(scale(axis, cg - cp), normal)  # lever from the CG back to the CP

        # Pitch damping, in the body frame; roll is ignored
        body_torque = rotate(conj(q), torque)
        rate = math.hypot(omega[0], omega[1])
        if rate > 1e-9 and not under_canopy:
            damp = rocket.damping_moment(rate, air.density, cg)
            body_torque = add(body_torque, (damp * omega[0] / rate, damp * omega[1] / rate, 0.0))
        ang_acc = (body_torque[0] / inertia, body_torque[1] / inertia, 0.0)

        accel = scale(force, 1 / mass)
        aux = {
            "thrust": thrust, "mass": mass, "mach": mach, "dynamic_pressure": qdyn,
            "angle_of_attack": math.degrees(aoa), "stability_margin": (cp - cg) / rocket.diameter,
            "drag_coefficient": cd, "acceleration": norm(accel),
        }
        return accel, ang_acc, aux

    def derivative(self, t, s, on_rail: bool):
        pos, vel, q, omega = s[0:3], s[3:6], s[6:10], s[10:13]
        accel, ang_acc, _ = self.forces(t, pos, vel, q, omega)
        if on_rail:
            rail = self.launch.rail_direction
            a = max(dot(accel, rail), 0.0) if dot(vel, rail) <= 1e-9 else dot(accel, rail)
            accel, ang_acc = scale(rail, a), (0.0, 0.0, 0.0)
            omega = (0.0, 0.0, 0.0)
        qdot = scale4(qmul(q, (0.0, *omega)), 0.5)
        return (*vel, *accel, *qdot, *ang_acc)


def scale4(q, k): return (q[0] * k, q[1] * k, q[2] * k, q[3] * k)


def _rk4(f, t, s, dt):
    # The end stages are evaluated just inside the step, so a thrust curve that jumps
    # exactly on a step boundary (ignition, burnout) counts for the step it belongs to
    eps = 1e-9
    k1 = f(t + eps, s)
    k2 = f(t + dt / 2, tuple(a + dt / 2 * b for a, b in zip(s, k1)))
    k3 = f(t + dt / 2, tuple(a + dt / 2 * b for a, b in zip(s, k2)))
    k4 = f(t + dt - eps, tuple(a + dt * b for a, b in zip(s, k3)))
    return tuple(a + dt / 6 * (b + 2 * c + 2 * d + e) for a, b, c, d, e in zip(s, k1, k2, k3, k4))


def simulate(rocket: Rocket, launch: Launch, dt: float = 0.005, descent_dt: float = 0.05,
             max_time: float = 3600.0, record_samples: bool = True) -> Flight:
    """Fly `rocket` from ignition (t = 0) to landing.

    With `record_samples` off, only the first and last samples are kept (events are
    always recorded); dispersion runs use this, since they only need the outcome.
    """
    model = _Model(rocket, launch)
    rail = launch.rail_direction
    q0 = pointing(math.radians(90 - launch.angle), math.radians(launch.heading))
    state = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, *q0, 0.0, 0.0, 0.0)
    columns = {name: [] for name in CHANNELS}
    events: list[FlightEvent] = []

    def event(name, t, z):
        events.append(FlightEvent(name, round(t, 4), round(z, 3)))

    burnout = rocket.motor.burn_time
    ejection = burnout + rocket.ejection_delay if rocket.ejection_delay is not None else None
    pending = list(rocket.recovery)
    opening = []  # (time it opens, device) for triggered devices still inside their deploy delay
    swing: Swing | None = None
    hang = None  # (orientation at deployment, when, how long): the rocket turning to hang under its canopy
    phase = "rail"  # rail -> flight -> descent -> landed
    lifted = False
    t = 0.0
    last_record = -1.0
    prev_accel = None

    event("ignition", 0.0, 0.0)

    def record(t, s):
        nonlocal last_record
        pos, vel, q, omega = s[0:3], s[3:6], s[6:10], s[10:13]
        accel, _, aux = model.forces(t, pos, vel, q, omega)
        if swing:
            # The simulated point is straight below the canopy; the rocket swings around it
            pos = add(pos, swing.offset())
        if phase == "rail":
            accel = scale(rail, dot(accel, rail)) if lifted else (0.0, 0.0, 0.0)
            aux["acceleration"] = norm(accel)
        row = {
            "time": t, "x": pos[0], "y": pos[1], "z": pos[2], "vx": vel[0], "vy": vel[1], "vz": vel[2],
            "qw": q[0], "qx": q[1], "qy": q[2], "qz": q[3], "speed": norm(vel), "vertical_velocity": vel[2],
            **aux,
        }
        for name in CHANNELS:
            columns[name].append(row[name])
        last_record = t

    def deploy(device, t, s):
        """Open a recovery device; returns how far to move the simulated point so the rocket itself
        doesn't jump (the point sits below the canopy, and the rocket hangs off to the side of it)."""
        nonlocal swing, hang
        before = swing.offset() if swing else (0.0, 0.0, 0.0)
        canopy = Canopy(device, t, norm(sub(s[3:6], model.wind.at(s[2], t))))
        model.canopies.append(canopy)
        event(f"deploy:{device.name}", t, s[2])
        # The rocket hangs on lines about as long as the canopy is wide, from its nose
        length = 1.1 * max(c.device.diameter for c in model.canopies) + rocket.mass_properties(t)[1]
        if swing is None:
            # It starts from however it was flying, at most 60° from hanging straight
            ax = rotate(s[6:10], (0.0, 0.0, 1.0))
            lean = math.atan2(math.hypot(ax[0], ax[1]), max(ax[2], 0.0))
            k = math.sin(min(lean, math.radians(60))) / max(math.hypot(ax[0], ax[1]), 1e-9)
            swing = Swing(length, (math.asin(ax[0] * k), math.asin(ax[1] * k)) if lean > 1e-6 else (0.0, 0.0))
            # The opening canopy pulls the rocket round to hang under it as it fills, not in an instant
            hang = (s[6:10], t, min(max(2 * canopy.fill_time, 0.8), 2.0))
        else:
            swing.length = length
        return sub(before, swing.offset())

    record(t, state)
    while t < max_time:
        inflating = any(c.fill(t) < 1 for c in model.canopies)
        step = descent_dt if phase == "descent" and not inflating else dt
        prev = state
        state = _rk4(lambda tt, ss: model.derivative(tt, ss, phase == "rail"), t, state, step)
        t += step

        if phase == "rail":
            travelled = dot(state[0:3], rail)
            if not lifted and travelled > 1e-6:
                lifted = True
                event("liftoff", t - step, 0.0)
            if not lifted:
                state = prev  # still sitting on the pad: thrust hasn't overcome weight yet
                if t > burnout:
                    raise ValueError(f"{rocket.motor.designation} never lifts {rocket.name} off the pad")
            if travelled >= launch.rail_length:
                phase = "flight"
                event("rail_exit", t, state[2])

        if prev[2] >= 0 and state[2] < 0 and lifted and phase != "rail":
            # Landing: interpolate back to ground level
            f = prev[2] / (prev[2] - state[2])
            t_land = t - step + f * step
            state = tuple(a + (b - a) * f for a, b in zip(prev, state))
            phase = "landed"
            event("landing", t_land, 0.0)
            record(t_land, state)
            break

        if t - step < burnout <= t:
            event("burnout", burnout, state[2])

        apogee_now = phase in ("flight", "descent") and prev[5] > 0 >= state[5]
        if apogee_now:
            f = prev[5] / (prev[5] - state[5])
            event("apogee", t - step + f * step, prev[2] + (state[2] - prev[2]) * f)
        past_apogee = any(e.name == "apogee" for e in events)

        if ejection is not None and t - step < ejection <= t:
            event("ejection", ejection, state[2])
        for device in list(pending):
            fire = (
                (device.deploy == "ejection" and ejection is not None and t >= ejection)
                or (device.deploy == "apogee" and past_apogee)
                or (device.deploy == "altitude" and past_apogee and state[2] <= device.deploy_altitude)
            )
            if fire:
                pending.remove(device)
                opening.append((t + device.deploy_delay, device))
        for when, device in list(opening):
            if t >= when:
                shift = deploy(device, t, state)
                state = (*add(state[0:3], shift), *state[3:])
                opening.remove((when, device))
                phase = "descent"

        if phase == "descent":
            # The canopy carries the rocket: swing it under the canopy as the canopy is pushed around
            pivot_accel = ((state[3] - prev[3]) / step, (state[4] - prev[4]) / step)
            swing.step(step, pivot_accel)
            q = lean_toward(swing.axis())
            if hang and t < hang[1] + hang[2]:
                f = (t - hang[1]) / hang[2]
                q = qslerp(hang[0], q, f * f * (3 - 2 * f))
            state = (*state[0:6], *q, 0.0, 0.0, 0.0)
        else:
            state = (*state[0:6], *qnormalize(state[6:10]), *state[10:13])

        if record_samples and t - last_record >= (0.05 if step == descent_dt else 0.01) - 1e-9:
            record(t, state)

    return Flight(columns, sorted(events, key=lambda e: e.time))


def load_launch(path) -> Launch:
    """Launch conditions from a rocket definition's `launch` section."""
    import json
    from pathlib import Path
    return Launch(**json.loads(Path(path).read_text()).get("launch", {}))
