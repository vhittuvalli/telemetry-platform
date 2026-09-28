"""International Standard Atmosphere (troposphere and lower stratosphere, up to 20 km)."""

import math
from dataclasses import dataclass

G0 = 9.80665          # m/s², standard gravity
R_AIR = 287.05287     # J/(kg·K), specific gas constant for dry air
GAMMA = 1.4           # ratio of specific heats for air
LAPSE = 0.0065        # K/m, temperature drop with height in the troposphere
TROPOPAUSE = 11000.0  # m, where temperature stops falling


@dataclass(frozen=True)
class Air:
    density: float        # kg/m³
    pressure: float       # Pa
    temperature: float    # K
    speed_of_sound: float  # m/s
    viscosity: float      # kinematic, m²/s


def air_at(altitude: float, ground_temperature: float = 288.15, ground_pressure: float = 101325.0) -> Air:
    """Air properties `altitude` meters above sea level."""
    h = max(0.0, min(altitude, 20000.0))
    if h <= TROPOPAUSE:
        t = ground_temperature - LAPSE * h
        p = ground_pressure * (t / ground_temperature) ** (G0 / (R_AIR * LAPSE))
    else:
        t = ground_temperature - LAPSE * TROPOPAUSE
        p11 = ground_pressure * (t / ground_temperature) ** (G0 / (R_AIR * LAPSE))
        p = p11 * math.exp(-G0 * (h - TROPOPAUSE) / (R_AIR * t))
    rho = p / (R_AIR * t)
    mu = 1.458e-6 * t ** 1.5 / (t + 110.4)  # Sutherland's law, dynamic viscosity
    return Air(rho, p, t, math.sqrt(GAMMA * R_AIR * t), mu / rho)
