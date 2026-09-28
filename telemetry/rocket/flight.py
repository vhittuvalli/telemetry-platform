"""6-DOF flight simulation: position, velocity, orientation and pitch/yaw rates, stepped with RK4.

World frame: x east, y north, z up, origin at the launch pad (the replay format's axes).
Body frame: +z points out of the nose. Orientation is a unit quaternion (w, x, y, z)
rotating body vectors into the world frame. Roll is not modeled (no canted fins).
"""

import math
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
    wind_speed: float = 0.0        # m/s
    wind_from: float = 0.0         # compass degrees the wind blows from
    site_name: str = "Launch site"
    site_altitude: float = 0.0     # m above sea level
    temperature: float = 288.15    # K at the site
    pressure: float = 101325.0     # Pa at the site

    @property
    def wind(self):
        h = math.radians(self.wind_from)
        return (-self.wind_speed * math.sin(h), -self.wind_speed * math.cos(h), 0.0)

    @property
    def rail_direction(self):
        e, h = math.radians(90 - self.angle), math.radians(self.heading)
        return (math.cos(e) * math.sin(h), math.cos(e) * math.cos(h), math.sin(e))


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
        self.wind = launch.wind
        self.descent_drag_area = 0.0  # sum of deployed recovery devices' Cd·A

    def forces(self, t, pos, vel, q, omega):
        """Acceleration, angular acceleration and the quantities recorded each sample."""
        rocket, launch = self.rocket, self.launch
        mass, cg, inertia = rocket.mass_properties(t)
        air = air_at(launch.site_altitude + pos[2], launch.temperature, launch.pressure)
        axis = rotate(q, (0.0, 0.0, 1.0))
        v_air = sub(vel, self.wind)
        speed = norm(v_air)
        qdyn = 0.5 * air.density * speed * speed
        thrust = rocket.motor.thrust(t)

        force = add(scale(axis, thrust), (0.0, 0.0, -G0 * mass))
        torque = (0.0, 0.0, 0.0)
        cd = rocket.drag_coefficient(speed, air)
        mach = speed / air.speed_of_sound
        cn_alpha, cp = rocket.normal_force(mach)
        aoa = 0.0

        if speed > 1e-6:
            # Under a parachute only the parachutes' drag counts, as in OpenRocket
            drag_area = self.descent_drag_area or cd * rocket.reference_area
            force = add(force, scale(v_air, -qdyn * drag_area / speed))

            if not self.descent_drag_area:
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
        if rate > 1e-9 and not self.descent_drag_area:
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

    def deploy(device, t, z):
        model.descent_drag_area += device.drag_area
        event(f"deploy:{device.name}", t, z)

    record(t, state)
    while t < max_time:
        step = descent_dt if phase == "descent" else dt
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
                deploy(device, t, state[2])
                opening.remove((when, device))
                phase = "descent"

        if phase == "descent":
            # Under a parachute the rocket hangs nose-up; ease its orientation there
            q = qslerp(state[6:10], UP, 1 - math.exp(-step / 1.5))
            state = (*state[0:6], *q, 0.0, 0.0, 0.0)
        else:
            state = (*state[0:6], *qnormalize(state[6:10]), *state[10:13])

        if record_samples and t - last_record >= (0.05 if phase == "descent" else 0.01) - 1e-9:
            record(t, state)

    return Flight(columns, sorted(events, key=lambda e: e.time))


def load_launch(path) -> Launch:
    """Launch conditions from a rocket definition's `launch` section."""
    import json
    from pathlib import Path
    return Launch(**json.loads(Path(path).read_text()).get("launch", {}))
