"""Rocket geometry, mass properties and aerodynamics.

Positions are measured along the rocket from the nose tip, positive toward the tail, in
meters. Aerodynamics follow the methods OpenRocket documents (Niskanen, "Development of
an Open Source model rocket simulation software", 2009): Barrowman/Diederich normal
force and center of pressure, and skin friction, pressure and base drag. Subsonic only:
results above about Mach 0.8 are not reliable.
"""

import json
import math
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path

from telemetry.rocket.atmosphere import Air
from telemetry.rocket.motor import Motor, load_eng

STEPS = 200  # integration steps along the nose profile


@dataclass
class NoseCone:
    shape: str             # cone, ogive, ellipsoid, parabolic, power, haack
    length: float
    diameter: float        # at the base
    shape_parameter: float = 1.0
    position: float = 0.0

    def radius(self, x: float) -> float:
        """Radius `x` meters behind the tip."""
        L, R, k = self.length, self.diameter / 2, self.shape_parameter
        x = min(max(x, 0.0), L)
        if self.shape == "cone" or (self.shape == "ogive" and k < 1e-3):
            return R * x / L
        if self.shape == "ogive":  # k = 1 is a tangent ogive; smaller k blends toward a cone
            rho = math.sqrt((L * L + R * R) * (((2 - k) * L) ** 2 + (k * R) ** 2) / (4 * (k * R) ** 2))
            l_eff = L / k
            y0 = math.sqrt(max(rho * rho - l_eff * l_eff, 0.0))
            return math.sqrt(max(rho * rho - (l_eff - x) ** 2, 0.0)) - y0
        if self.shape == "ellipsoid":
            return R * math.sqrt(max(2 * x / L - (x / L) ** 2, 0.0))
        if self.shape == "parabolic":
            return R * (2 * x / L - k * (x / L) ** 2) / (2 - k)
        if self.shape == "power":
            return R * (x / L) ** k
        if self.shape == "haack":  # k = 0: Von Kármán, k = 1/3: LV-Haack
            theta = math.acos(1 - 2 * x / L)
            return R / math.sqrt(math.pi) * math.sqrt(max(theta - math.sin(2 * theta) / 2 + k * math.sin(theta) ** 3, 0.0))
        raise ValueError(f"Unknown nose cone shape '{self.shape}'")

    def _integrate(self, f) -> float:
        h = self.length / STEPS
        return sum(f((i + 0.5) * h) for i in range(STEPS)) * h

    @cached_property
    def volume(self) -> float:
        return self._integrate(lambda x: math.pi * self.radius(x) ** 2)

    @cached_property
    def wetted_area(self) -> float:
        h = 1e-6 * self.length
        def ring(x):
            slope = (self.radius(min(x + h, self.length)) - self.radius(max(x - h, 0))) / (2 * h)
            return 2 * math.pi * self.radius(x) * math.sqrt(1 + slope * slope)
        return self._integrate(ring)

    @cached_property
    def joint_angle(self) -> float:
        """Half-angle of the profile where it meets the body, radians (0 for a tangent shape)."""
        h = 1e-4 * self.length
        return math.atan((self.radius(self.length) - self.radius(self.length - h)) / h)


@dataclass
class BodyTube:
    length: float
    diameter: float
    position: float


@dataclass
class FinSet:
    count: int
    root_chord: float
    tip_chord: float
    span: float
    sweep: float           # distance the tip's leading edge sits behind the root's
    thickness: float
    position: float        # root leading edge
    cross_section: str = "rounded"  # square, rounded or airfoil

    @property
    def area(self) -> float:
        return self.span * (self.root_chord + self.tip_chord) / 2

    @property
    def mean_chord(self) -> float:
        cr, ct = self.root_chord, self.tip_chord
        return 2 / 3 * (cr + ct - cr * ct / (cr + ct))

    @property
    def midchord_sweep(self) -> float:
        return math.atan((self.sweep + self.tip_chord / 2 - self.root_chord / 2) / self.span)

    @property
    def cp(self) -> float:
        """Center of pressure (Barrowman), from the nose tip."""
        cr, ct, xs = self.root_chord, self.tip_chord, self.sweep
        return self.position + xs / 3 * (cr + 2 * ct) / (cr + ct) + (cr + ct - cr * ct / (cr + ct)) / 6


@dataclass
class LaunchLug:
    length: float
    outer_diameter: float
    inner_diameter: float


@dataclass
class MassItem:
    name: str
    mass: float
    cg: float              # from the nose tip
    length: float = 0.0    # for its own moment of inertia
    radius: float = 0.0


@dataclass
class Recovery:
    name: str
    diameter: float
    cd: float
    deploy: str = "ejection"       # ejection (motor delay), apogee, or altitude
    deploy_altitude: float | None = None  # m above the pad, for deploy = "altitude"
    deploy_delay: float = 0.0             # s from the trigger until it opens

    @property
    def drag_area(self) -> float:
        return self.cd * math.pi * (self.diameter / 2) ** 2


@dataclass
class Rocket:
    name: str
    nose: NoseCone
    body_tubes: list[BodyTube]
    fins: list[FinSet]
    masses: list[MassItem]         # every component's mass except the motor
    motor: Motor
    motor_aft: float               # position of the motor's aft end
    ejection_delay: float | None   # s after burnout; None = no ejection charge (plugged)
    recovery: list[Recovery] = field(default_factory=list)
    launch_lugs: list[LaunchLug] = field(default_factory=list)
    roughness: float = 60e-6       # surface roughness, m (60 µm: regular paint)
    cd_override: float | None = None

    # ---------- geometry ----------

    @property
    def diameter(self) -> float:
        return max([self.nose.diameter] + [b.diameter for b in self.body_tubes])

    @property
    def reference_area(self) -> float:
        return math.pi * (self.diameter / 2) ** 2

    @property
    def length(self) -> float:
        ends = [self.nose.position + self.nose.length] + [b.position + b.length for b in self.body_tubes]
        return max(ends)

    @property
    def aft_radius(self) -> float:
        last = max(self.body_tubes, key=lambda b: b.position + b.length, default=None)
        return (last.diameter if last else self.nose.diameter) / 2

    # ---------- mass ----------

    @property
    def motor_cg(self) -> float:
        return self.motor_aft - self.motor.length / 2

    def mass_properties(self, t: float) -> tuple[float, float, float]:
        """(mass kg, CG from the nose tip m, pitch moment of inertia kg·m²) at motor time `t`."""
        items = [(m.mass, m.cg, m.length, m.radius) for m in self.masses]
        items.append((self.motor.mass(t), self.motor_cg, self.motor.length, self.motor.diameter / 2))
        mass = sum(m for m, *_ in items)
        cg = sum(m * x for m, x, *_ in items) / mass
        inertia = sum(m * ((x - cg) ** 2 + L * L / 12 + r * r / 4) for m, x, L, r in items)
        return mass, cg, inertia

    # ---------- aerodynamics ----------

    def normal_force(self, mach: float) -> tuple[float, float]:
        """(CNα per radian, center of pressure from the nose tip) at small angles of attack."""
        a_ref = self.reference_area
        parts = []

        nose = self.nose
        a_base = math.pi * (nose.diameter / 2) ** 2
        parts.append((2 * a_base / a_ref, nose.position + (nose.length * a_base - nose.volume) / a_base))

        beta = math.sqrt(abs(1 - mach * mach)) or 1e-3
        for fin in self.fins:
            # Diederich's planform method for one fin, then combined for the whole set
            one = (2 * math.pi * fin.span ** 2 / a_ref) / (
                1 + math.sqrt(1 + (beta * fin.span ** 2 / (fin.area * math.cos(fin.midchord_sweep))) ** 2)
            )
            n = fin.count
            spread = {5: 0.948, 6: 0.913, 7: 0.854, 8: 0.810}.get(n, 1.0)
            body_r = self.body_radius_at(fin.position)
            interference = 1 + body_r / (fin.span + body_r)
            parts.append((one * n / 2 * spread * interference, fin.cp))

        cn_alpha = sum(c for c, _ in parts)
        cp = sum(c * x for c, x in parts) / cn_alpha
        return cn_alpha, cp

    def body_radius_at(self, x: float) -> float:
        for b in self.body_tubes:
            if b.position <= x <= b.position + b.length:
                return b.diameter / 2
        return self.diameter / 2

    def drag_coefficient(self, speed: float, air: Air) -> float:
        """Zero-angle-of-attack drag coefficient, referenced to the body's cross-section."""
        if self.cd_override is not None:
            return self.cd_override
        mach = speed / air.speed_of_sound
        a_ref = self.reference_area
        length = self.length

        # Skin friction: turbulent flat plate, limited by surface roughness
        re = max(speed * length / air.viscosity, 1.0)
        if re < 1e4:
            cf = 1.48e-2
        else:
            smooth = 1 / (1.5 * math.log(re) - 5.6) ** 2 * (1 - 0.1 * mach * mach)
            rough = 0.032 * (self.roughness / length) ** 0.2 / (1 + 0.18 * mach * mach)
            cf = max(smooth, rough)

        fineness = length / self.diameter
        body_wet = self.nose.wetted_area + sum(math.pi * b.diameter * b.length for b in self.body_tubes)
        fin_wet = sum(2 * f.count * f.area * (1 + 2 * f.thickness / f.mean_chord) for f in self.fins)
        cd = cf * ((1 + 1 / (2 * fineness)) * body_wet + fin_wet) / a_ref

        # Base drag. A burning motor's exhaust partly fills the base, but OpenRocket (which we
        # validate against) keeps the full base drag while thrusting, so we do too.
        cd_base = 0.12 + 0.13 * mach * mach
        cd += cd_base * math.pi * self.aft_radius ** 2 / a_ref

        # Nose pressure drag (zero for shapes that meet the body tangentially)
        cd += 0.8 * math.sin(self.nose.joint_angle) ** 2 * math.pi * (self.nose.diameter / 2) ** 2 / a_ref

        # Fin pressure drag: leading edge stagnation plus trailing edge base drag
        for f in self.fins:
            frontal = f.count * f.span * f.thickness
            le = ((1 - mach * mach) ** -0.417 - 1) if f.cross_section != "square" else 1 - mach * mach
            le = max(le, 0.0) * math.cos(math.atan(f.sweep / f.span)) ** 2
            te = {"square": cd_base, "rounded": cd_base / 2}.get(f.cross_section, 0.0)
            cd += (le + te) * frontal / a_ref

        # Launch lugs: a blunt ring facing the flow
        for lug in self.launch_lugs:
            ring = math.pi * ((lug.outer_diameter / 2) ** 2 - (lug.inner_diameter / 2) ** 2)
            cd += 1.0 * ring / a_ref + cf * math.pi * lug.outer_diameter * lug.length / a_ref

        return cd

    def damping_moment(self, rate: float, density: float, cg: float) -> float:
        """Pitch damping moment (N·m) opposing a pitch rate `rate` (rad/s)."""
        body = 0.275 * self.diameter * self.length ** 4
        fins = sum(0.6 * f.count * f.area * abs(f.cp - cg) ** 3 for f in self.fins)
        return -math.copysign(0.5 * density * rate * rate * (body + fins), rate)


def load_rocket(path: str | Path) -> Rocket:
    """Load a rocket definition (see rockets/*.json). Motor files are relative to the definition."""
    path = Path(path)
    spec = json.loads(path.read_text())
    motor_spec = spec["motor"]
    motor = load_eng(path.parent / motor_spec["file"])
    return Rocket(
        name=spec["name"],
        nose=NoseCone(**spec["nose"]),
        body_tubes=[BodyTube(**b) for b in spec["body_tubes"]],
        fins=[FinSet(**f) for f in spec.get("fins", [])],
        masses=[MassItem(**m) for m in spec["masses"]],
        motor=motor,
        motor_aft=motor_spec["aft_position"],
        ejection_delay=motor_spec.get("ejection_delay"),
        recovery=[Recovery(**r) for r in spec.get("recovery", [])],
        launch_lugs=[LaunchLug(**lug) for lug in spec.get("launch_lugs", [])],
        roughness=spec.get("roughness", 60e-6),
        cd_override=spec.get("cd"),
    )
