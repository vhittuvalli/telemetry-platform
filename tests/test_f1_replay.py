from types import SimpleNamespace

import pandas as pd
import pytest

from telemetry.f1 import build_race_replay


def test_session_without_telemetry_gives_a_clear_error():
    #what FastF1 hands back when F1's timing API refuses the request: results, but no car data
    session = SimpleNamespace(
        results=pd.DataFrame({"Abbreviation": ["VER", "HAM"], "DriverNumber": ["1", "44"]}),
        pos_data={},
        car_data={},
    )
    with pytest.raises(ValueError, match="F1TV login"):
        build_race_replay(session)
