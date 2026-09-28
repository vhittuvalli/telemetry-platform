"""Rocket motors from thrust curves in RASP (.eng) format, the format thrustcurve.org and OpenRocket use."""

from bisect import bisect_right
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Motor:
    designation: str
    manufacturer: str
    diameter: float         # m
    length: float           # m
    propellant_mass: float  # kg
    total_mass: float       # kg, loaded
    times: list[float]      # s, thrust curve sample times (starting at 0)
    thrusts: list[float]    # N
    delays: list[float] | None = None  # available ejection delays, s

    def __post_init__(self):
        if self.times[0] > 0:
            self.times = [0.0, *self.times]
            self.thrusts = [0.0, *self.thrusts]
        # Impulse delivered by each curve point, for burning propellant in proportion to it
        self._impulse = [0.0]
        for i in range(1, len(self.times)):
            dt = self.times[i] - self.times[i - 1]
            self._impulse.append(self._impulse[-1] + 0.5 * (self.thrusts[i] + self.thrusts[i - 1]) * dt)

    @property
    def burn_time(self) -> float:
        return self.times[-1]

    @property
    def total_impulse(self) -> float:
        return self._impulse[-1]

    def thrust(self, t: float) -> float:
        if t <= 0 or t >= self.times[-1]:
            return 0.0
        i = bisect_right(self.times, t) - 1
        t0, t1 = self.times[i], self.times[i + 1]
        return self.thrusts[i] + (self.thrusts[i + 1] - self.thrusts[i]) * (t - t0) / (t1 - t0)

    def impulse_by(self, t: float) -> float:
        """Impulse delivered from ignition to `t`."""
        if t <= 0:
            return 0.0
        if t >= self.times[-1]:
            return self.total_impulse
        i = bisect_right(self.times, t) - 1
        return self._impulse[i] + 0.5 * (self.thrusts[i] + self.thrust(t)) * (t - self.times[i])

    def mass(self, t: float) -> float:
        """Motor mass at `t`; propellant burns in proportion to the impulse delivered."""
        burned = self.impulse_by(t) / self.total_impulse if self.total_impulse else 0.0
        return self.total_mass - self.propellant_mass * burned

    def scaled(self, factor: float) -> "Motor":
        """The same motor with thrust scaled by `factor` (for dispersion runs)."""
        return Motor(self.designation, self.manufacturer, self.diameter, self.length,
                     self.propellant_mass, self.total_mass, list(self.times),
                     [f * factor for f in self.thrusts], self.delays)


def load_eng(path: str | Path) -> Motor:
    """Read the first motor in a RASP .eng file.

    Header: `name diameter(mm) length(mm) delays propellant(kg) total(kg) manufacturer`,
    then one `time thrust` pair per line. Lines starting with ';' are comments.
    """
    lines = [ln.strip() for ln in Path(path).read_text().splitlines()]
    lines = [ln for ln in lines if ln and not ln.startswith(";")]
    name, diameter, length, delays, prop, total, maker = lines[0].split()[:7]
    times, thrusts = [], []
    for line in lines[1:]:
        if line.startswith(";"):
            continue
        parts = line.split()
        if len(parts) < 2:
            break
        try:
            t, f = float(parts[0]), float(parts[1])
        except ValueError:
            break  # the next motor's header
        times.append(t)
        thrusts.append(f)
        if f == 0 and t > 0:
            break
    delay_list = [float(d) for d in delays.split("-") if d.replace(".", "").isdigit()] or None
    return Motor(name, maker, float(diameter) / 1000, float(length) / 1000,
                 float(prop), float(total), times, thrusts, delay_list)
