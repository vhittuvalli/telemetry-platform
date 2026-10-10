"""Forward live telemetry from UDP on this machine to a remote platform over a WebSocket.

    python scripts/telemetry_relay.py --site https://telemetry-platform.onrender.com

The same as `telemetry-live relay`; see telemetry/live_relay.py.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from telemetry import live_relay  # noqa: E402

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    live_relay.add_arguments(parser)
    live_relay.run(parser.parse_args())
