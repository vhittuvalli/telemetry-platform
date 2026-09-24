import os
from pathlib import Path
import fastf1

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