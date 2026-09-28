"""Export an OpenRocket design for our simulator, plus OpenRocket's own results as a validation reference.

Needs Java, the dev requirements (orhelper, JPype) and an OpenRocket 23.09 jar:
    python scripts/openrocket_export.py design.ork --jar OpenRocket-23.09.jar

Writes rockets/<name>.json (rocket + launch conditions), rockets/motors/<motor>.eng and
rockets/validation/<name>.openrocket.json (OpenRocket's flight data for the same launch).
"""

import argparse
import json
import math
import re
from pathlib import Path

import jpype
import orhelper
from orhelper import FlightDataType, FlightEvent

ROOT = Path(__file__).resolve().parent.parent
ROCKETS_DIR = ROOT / "rockets"

SHAPES = {"CONICAL": "cone", "OGIVE": "ogive", "ELLIPSOID": "ellipsoid", "POWER": "power",
          "PARABOLIC": "parabolic", "HAACK": "haack"}
# Parts whose aerodynamics our simulator doesn't model (their mass still counts)
UNMODELED = {"Transition", "FreeformFinSet", "EllipticalFinSet", "TubeFinSet", "PodSet",
             "ParallelStage", "RailButton"}

SERIES = {
    "time": FlightDataType.TYPE_TIME, "altitude": FlightDataType.TYPE_ALTITUDE,
    "vertical_velocity": FlightDataType.TYPE_VELOCITY_Z, "speed": FlightDataType.TYPE_VELOCITY_TOTAL,
    "acceleration": FlightDataType.TYPE_ACCELERATION_TOTAL, "mach": FlightDataType.TYPE_MACH_NUMBER,
    "drag_coefficient": FlightDataType.TYPE_DRAG_COEFF, "stability_margin": FlightDataType.TYPE_STABILITY,
    "cp": FlightDataType.TYPE_CP_LOCATION, "cg": FlightDataType.TYPE_CG_LOCATION,
    "thrust": FlightDataType.TYPE_THRUST_FORCE, "mass": FlightDataType.TYPE_MASS,
    "x": FlightDataType.TYPE_POSITION_X, "y": FlightDataType.TYPE_POSITION_Y,
    "angle_of_attack": FlightDataType.TYPE_AOA,
}


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def write_eng(motor, delays: list[float]) -> str:
    """Write an OpenRocket motor's thrust curve to rockets/motors as a RASP .eng file; returns its name."""
    designation = str(motor.getDesignation())
    maker = str(motor.getManufacturer()).split()[0]
    prop = float(motor.getLaunchMass()) - float(motor.getBurnoutMass())
    eng_name = f"{slug(maker)}_{slug(designation)}.eng"
    delay_text = "-".join(f"{d:g}" for d in delays) or "0"
    lines = [f"; {maker} {designation}, exported from OpenRocket's motor database",
             f"{designation} {float(motor.getDiameter()) * 1000:g} {float(motor.getLength()) * 1000:g} "
             f"{delay_text} {prop:.5f} {float(motor.getLaunchMass()):.5f} {maker}"]
    for t, f in zip(motor.getTimePoints(), motor.getThrustPoints()):
        if float(t) > 0:
            lines.append(f"{float(t):.4f} {float(f):.4f}")
    (ROCKETS_DIR / "motors").mkdir(parents=True, exist_ok=True)
    (ROCKETS_DIR / "motors" / eng_name).write_text("\n".join(lines) + "\n")
    return eng_name


def export_motors(jar: Path, wanted: list[str]) -> None:
    """Export motors named 'Maker:Designation:diameter_mm' from OpenRocket's database."""
    import time
    with orhelper.OpenRocketInstance(str(jar), log_level="ERROR"):
        db = jpype.JClass("net.sf.openrocket.startup.Application").getThrustCurveMotorSetDatabase()
        time.sleep(2)  # the database loads in the background
        sets = list(db.getMotorSets())
        for spec in wanted:
            maker, designation, diameter = spec.split(":")
            match = next((ms for ms in sets
                          if str(ms.getManufacturer()).startswith(maker) and str(ms.getDesignation()) == designation
                          and round(float(ms.getMotors()[0].getDiameter()) * 1000) == int(diameter)), None)
            if match is None:
                print(f"warning: no {maker} {designation} ({diameter} mm) in OpenRocket's database")
                continue
            motor = match.getMotors()[0]
            delays = [float(d) for d in motor.getStandardDelays() if float(d) < 1e3]
            print(f"Wrote rockets/motors/{write_eng(motor, delays)}")


def export(ork: Path, jar: Path, sim_index: int) -> None:
    with orhelper.OpenRocketInstance(str(jar), log_level="ERROR") as instance:
        orh = orhelper.Helper(instance)
        origin = jpype.JClass("net.sf.openrocket.util.Coordinate")(0.0, 0.0, 0.0)

        def front(c) -> float:
            """A component's front, measured from the nose tip."""
            return float(c.toAbsolute(origin)[0].x)

        doc = orh.load_doc(str(ork))
        sim = doc.getSimulation(sim_index)
        rocket = doc.getRocket()
        config = rocket.getFlightConfiguration(sim.getFlightConfigurationId())

        spec = {"name": str(rocket.getName()), "body_tubes": [], "fins": [], "masses": [],
                "launch_lugs": [], "recovery": []}
        mount = None
        warnings: set[str] = set()

        def outer_radius(c) -> float:
            if hasattr(c, "getAftRadius"):  # nose cones and transitions
                return float(c.getAftRadius())
            return float(c.getOuterRadius()) if hasattr(c, "getOuterRadius") else 0.0

        def masses(c) -> list[dict]:
            """Mass items for a component and everything inside it, honoring OpenRocket's overrides."""
            x = front(c)
            whole_mass = c.isMassOverridden() and c.isSubcomponentsOverriddenMass()
            whole_cg = c.isCGOverridden() and c.isSubcomponentsOverriddenCG()
            own = float(c.getOverrideMass()) if c.isMassOverridden() and not whole_mass else float(c.getComponentMass())
            cg = float(c.getOverrideCGX()) if c.isCGOverridden() and not whole_cg else float(c.getComponentCG().x)
            items = []
            if own > 0:
                items.append({"name": str(c.getName()), "mass": own, "cg": x + cg,
                              "length": float(c.getLength()), "radius": outer_radius(c)})
            for child in c.getChildren():
                items += masses(child)

            # An override on an assembly replaces its parts' total; keep their layout, rescale to fit
            if whole_mass:
                total = sum(i["mass"] for i in items)
                target = float(c.getOverrideMass())
                if total > 0:
                    for i in items:
                        i["mass"] *= target / total
                else:
                    items = [{"name": str(c.getName()), "mass": target, "cg": x + float(c.getComponentCG().x),
                              "length": float(c.getLength()), "radius": 0.0}]
            if whole_cg and items:
                total = sum(i["mass"] for i in items)
                shift = x + float(c.getOverrideCGX()) - sum(i["mass"] * i["cg"] for i in items) / total
                for i in items:
                    i["cg"] += shift
            return items

        def walk(c):
            nonlocal mount
            kind = str(c.getClass().getSimpleName())
            if kind in UNMODELED:
                warnings.add(kind)
            x = front(c)
            if kind == "NoseCone":
                spec["nose"] = {"shape": SHAPES[str(c.getShapeType().name())], "length": float(c.getLength()),
                                "diameter": 2 * float(c.getAftRadius()),
                                "shape_parameter": float(c.getShapeParameter()), "position": x}
            elif kind == "BodyTube":
                spec["body_tubes"].append({"length": float(c.getLength()), "diameter": 2 * float(c.getOuterRadius()),
                                           "position": x})
            elif kind == "TrapezoidFinSet":
                spec["fins"].append({"count": int(c.getFinCount()), "root_chord": float(c.getRootChord()),
                                     "tip_chord": float(c.getTipChord()), "span": float(c.getHeight()),
                                     "sweep": float(c.getSweep()), "thickness": float(c.getThickness()),
                                     "position": x, "cross_section": str(c.getCrossSection().name()).lower()})
            elif kind == "LaunchLug":
                spec["launch_lugs"].append({"length": float(c.getLength()),
                                            "outer_diameter": 2 * float(c.getOuterRadius()),
                                            "inner_diameter": 2 * float(c.getInnerRadius())})
            elif kind == "Parachute":
                deploy = c.getDeploymentConfigurations().get(config.getId())
                event = str(deploy.getDeployEvent().name())
                spec["recovery"].append({
                    "name": str(c.getName()), "diameter": float(c.getDiameter()), "cd": float(c.getCD()),
                    "deploy": {"EJECTION": "ejection", "APOGEE": "apogee", "ALTITUDE": "altitude"}.get(event, "ejection"),
                    "deploy_altitude": float(deploy.getDeployAltitude()) if event == "ALTITUDE" else None,
                    "deploy_delay": float(deploy.getDeployDelay()),
                })
            if hasattr(c, "isMotorMount") and c.isMotorMount() and c.getMotorConfig(config.getId()).hasMotor():
                mount = c
            for child in c.getChildren():
                walk(child)

        walk(rocket)
        spec["masses"] = [{**i, "mass": round(i["mass"], 6), "cg": round(i["cg"], 5),
                           "length": round(i["length"], 5), "radius": round(i["radius"], 5)}
                          for i in masses(rocket)]
        if rocket.getStageCount() > 1 or len(list(config.getActiveMotors())) > 1:
            warnings.add("multiple stages or motors (only one motor is simulated)")
        for tube in spec["body_tubes"]:
            tube["position"] = round(tube["position"], 5)

        # Motor: write its thrust curve as a RASP .eng file
        instance_ = mount.getMotorConfig(config.getId())
        eng_name = write_eng(instance_.getMotor(), [float(instance_.getEjectionDelay())])
        spec["motor"] = {
            "file": f"motors/{eng_name}",
            "aft_position": round(front(mount) + float(mount.getLength()) + float(mount.getMotorOverhang()), 5),
            "ejection_delay": float(instance_.getEjectionDelay()),
        }

        opts = sim.getOptions()
        spec["launch"] = {
            "rail_length": float(opts.getLaunchRodLength()),
            "angle": math.degrees(float(opts.getLaunchRodAngle())),
            "heading": math.degrees(float(opts.getLaunchRodDirection())),
            "wind_speed": float(opts.getWindSpeedAverage()),
            "wind_from": math.degrees(float(opts.getWindDirection())),
            "site_altitude": float(opts.getLaunchAltitude()),
            "temperature": float(opts.getLaunchTemperature()),
            "pressure": float(opts.getLaunchPressure()),
        }

        # OpenRocket's own flight, as the reference
        orh.run_simulation(sim)
        data = orh.get_timeseries(sim, list(SERIES.values()))
        events = orh.get_events(sim)
        reference = {
            "openrocket_version": "23.09",
            "source": ork.name,
            "wind_turbulence": float(opts.getWindTurbulenceIntensity()),
            "events": {str(k).removeprefix("FlightEvent.").lower(): [round(float(t), 4) for t in v]
                       for k, v in events.items()},
            "series": {name: [round(float(v), 5) if not math.isnan(float(v)) else None for v in data[kind]]
                       for name, kind in SERIES.items()},
        }

    name = slug(spec["name"])
    (ROCKETS_DIR / f"{name}.json").write_text(json.dumps(spec, indent=2) + "\n")
    (ROCKETS_DIR / "validation").mkdir(exist_ok=True)
    (ROCKETS_DIR / "validation" / f"{name}.openrocket.json").write_text(json.dumps(reference) + "\n")
    for w in sorted(warnings):
        print(f"warning: {w} is not modeled aerodynamically; expect differences from OpenRocket")
    print(f"Wrote rockets/{name}.json, rockets/motors/{eng_name}, rockets/validation/{name}.openrocket.json")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("ork", type=Path, nargs="?", help="OpenRocket design to export")
    parser.add_argument("--jar", type=Path, required=True, help="OpenRocket 23.09 jar")
    parser.add_argument("--sim", type=int, default=0, help="index of the simulation to use as the reference")
    parser.add_argument("--motor", action="append", default=[], metavar="MAKER:DESIGNATION:MM",
                        help="also export a motor from OpenRocket's database, e.g. Estes:C6:18")
    args = parser.parse_args()
    if args.ork:
        export(args.ork, args.jar, args.sim)
    if args.motor:
        export_motors(args.jar, args.motor)
