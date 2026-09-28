"""The /rockets API: designs, motors, and flights simulated on request."""

import pytest
from fastapi.testclient import TestClient

from backend.main import app

client = TestClient(app)


def test_lists_rockets_and_motors():
    rockets = {r["id"]: r for r in client.get("/rockets").json()}
    assert rockets["a_simple_model_rocket"]["motor"]["designation"] == "A8"
    motors = client.get("/rockets/motors").json()
    assert {m["designation"] for m in motors if m["diameter"] == 18} >= {"A8", "C6"}


def test_simulated_flight_is_served_like_a_replay():
    body = {"rocket": "a_simple_model_rocket", "motor": "estes_c6.eng", "ejection_delay": 5,
            "wind_speed": 3, "wind_from": 90}
    replay_id = client.post("/rockets/simulate", json=body).json()["replay_id"]
    assert replay_id.startswith("sim_")
    assert client.post("/rockets/simulate", json=body).json()["replay_id"] == replay_id  # cached

    meta = client.get(f"/replays/{replay_id}/meta").json()
    assert meta["rocket"]["motor"]["designation"] == "C6"
    assert meta["custom"]["wind_speed"] == 3
    data = client.get(f"/replays/{replay_id}/data", params={"start": 0, "end": 5}).json()
    assert data["vehicles"]["rocket"]["time"][0] == 0
    # One-off flights stay out of the list of saved replays
    assert replay_id not in {r["id"] for r in client.get("/replays").json()}


@pytest.mark.parametrize("body, status", [
    ({"rocket": "nope"}, 404),
    ({"rocket": "a_simple_model_rocket", "motor": "estes_d12.eng"}, 422),  # 24 mm motor, 18 mm mount
    ({"rocket": "a_simple_model_rocket", "motor": "../rockets/presets.json"}, 404),
    ({"rocket": "a_simple_model_rocket", "wind_speed": 99}, 422),
])
def test_rejects_bad_requests(body, status):
    assert client.post("/rockets/simulate", json=body).status_code == status
