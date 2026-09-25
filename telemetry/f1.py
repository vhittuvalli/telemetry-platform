import os
from pathlib import Path
import fastf1
import pandas as pd
import json
import math
import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("TELEMETRY_DATA_DIR", PROJECT_ROOT / "data"))
CACHE_DIR = DATA_DIR / "cache"

fastf1.set_log_level("WARNING")
def load_session(year, event, session_type):
    CACHE_DIR.mkdir(parents=True, exist_ok=True) #make cache directory
    fastf1.Cache.enable_cache(CACHE_DIR) #set cache directory

    session = fastf1.get_session(year, event, session_type) #define session
    session.load(laps=True, telemetry=True, weather=False, messages=True) #get session (check if already in cache first)
    return session

def get_driver_telemetry(session, driver):
    results = session.results
    row = results[results["Abbreviation"] == driver] #filter to matching row
    if row.empty:
        raise ValueError(f"Driver {driver!r} not found in this session")
    number = str(row["DriverNumber"].iloc[0])
    pos = pd.DataFrame(session.pos_data[number])[["SessionTime", "X", "Y", "Z", "Status"]]
    car = pd.DataFrame(session.car_data[number])[
        ["SessionTime", "Speed", "Throttle", "Brake", "nGear", "RPM", "DRS"]
    ] #position and car data
    pos = pos.sort_values("SessionTime")
    car = car.sort_values("SessionTime")

    merged = pd.merge_asof(
        pos,
        car,
        on="SessionTime",
        direction="nearest",
        tolerance=pd.Timedelta("500ms"),
    ) #pair car data with its closest position data because times may not exactly match
    return merged.reset_index(drop=True)

def to_standard_format(tel, driver):
    """Convert one driver's merged telemetry to the platform's standard format."""
    return pd.DataFrame({
        "time":       tel["SessionTime"].dt.total_seconds(),
        "vehicle_id": driver,
        "x":          tel["X"] / 10,
        "y":          tel["Y"] / 10,
        "z":          tel["Z"] / 10,
        "speed":      tel["Speed"],
        "throttle":   tel["Throttle"],
        "brake":      tel["Brake"].astype("boolean").astype("Int8"),
        "gear":       tel["nGear"].astype("Int8"),
        "rpm":        tel["RPM"],
        "drs":        tel["DRS"].astype("Int8"),
        "on_track":   tel["Status"] == "OnTrack",
    })

def build_race_replay(session, padding_s=60):
    """Build one table with every driver's telemetry on a shared clock,
    where time 0 is the start of the session."""
    frames = []
    for driver in session.results["Abbreviation"]:
        try:
            tel = get_driver_telemetry(session, driver)
        except (KeyError, ValueError) as err:
            print(f"Skipping {driver}: {err}")
            continue
        frames.append(to_standard_format(tel, driver))

    replay = pd.concat(frames, ignore_index=True)

    start = session_start_seconds(session)
    end = session.laps["Time"].max().total_seconds()

    replay["time"] = replay["time"] - start
    replay = replay[
        (replay["time"] >= -padding_s) & (replay["time"] <= end - start + padding_s)
    ]

    return replay.sort_values(["time", "vehicle_id"]).reset_index(drop=True)

REPLAYS_DIR = DATA_DIR / "replays"

def save_replay(replay, path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    replay.to_parquet(path, index=False, compression="zstd")
    return path

def load_replay(path):
    return pd.read_parquet(path)

def session_start_seconds(session):
    """The session clock value (in seconds) treated as time 0 in replays."""
    return session.session_start_time.total_seconds()

def _json_safe(value):
    """Convert pandas/NumPy values into plain Python values JSON can store."""
    if value is None or value is pd.NA:
        return None
    if isinstance(value, (np.integer, np.floating, np.bool_)):
        value = value.item()
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    return value

def build_metadata(session, replay, outline_points=500):
    """Session info, drivers, time range, and a track outline for the viewer."""
    results = session.results.sort_values("Position")

    drivers = [
        {
            "code": _json_safe(row["Abbreviation"]),
            #leaderboard details
            "number": _json_safe(row["DriverNumber"]),
            "name": _json_safe(row["FullName"]),
            "team": _json_safe(row["TeamName"]),
            #color is for rendering car color correctly
            "color": f"#{row['TeamColor']}" if isinstance(row["TeamColor"], str) else None,
            #handling when cars "disappear" (end the race)
            "final_position": _json_safe(row["Position"]),
            "status": _json_safe(row["Status"]),
        }
        for _, row in results.iterrows()
    ]

    # Track outline: the winner's fastest lap, in meters, thinned to ~outline_points
    #winner is first row of results
    winner = results.iloc[0]["Abbreviation"]
    lap = session.laps.pick_drivers(winner).pick_fastest()
    pos = lap.get_pos_data()
    step = max(1, len(pos) // outline_points)
    outline = [
        [round(x / 10, 2), round(y / 10, 2), round(z / 10, 2)]
        for x, y, z in pos[["X", "Y", "Z"]].to_numpy()[::step]
    ]

    return {
        "session": {
            "year": int(session.date.year),
            "event": _json_safe(session.event["EventName"]),
            "location": _json_safe(session.event["Location"]),
            "name": session.name,
            "date": _json_safe(session.date),
        },
        "time_range": {
            "start": float(replay["time"].min()),
            "end": float(replay["time"].max()),
        },
        "drivers": drivers,
        "track_outline": outline,
    }
def build_laps(session):
    """One row per driver per lap, with times on the replay clock (seconds)."""
    laps = session.laps
    offset = session_start_seconds(session)

    def seconds(col):
        return laps[col].dt.total_seconds()

    return pd.DataFrame({
        "driver": laps["Driver"],
        "lap": laps["LapNumber"].astype("Int16"),
        "lap_time": seconds("LapTime"),
        "lap_end": seconds("Time") - offset,
        "position": laps["Position"].astype("Int8"),
        "compound": laps["Compound"],
        "tyre_life": laps["TyreLife"],
        "stint": laps["Stint"].astype("Int8"),
        "pit_in": seconds("PitInTime") - offset,
        "pit_out": seconds("PitOutTime") - offset,
    })
def save_metadata(metadata, path):
    """Save metadata as JSON."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(metadata, indent=2))
    return path


def save_laps(laps, path):
    """Save lap data as JSON (one object per lap; missing values become null)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    laps.to_json(path, orient="records", indent=2)
    return path