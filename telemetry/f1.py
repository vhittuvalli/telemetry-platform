import os
from pathlib import Path
import fastf1
import pandas as pd

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

def build_race_replay(session):
    """Run the two functions above for every driver and combine them
    into one table."""

def save_replay(df, path):
    """Write to Parquet (much smaller than CSV for a full race)."""