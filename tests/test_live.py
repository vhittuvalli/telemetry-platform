"""Live telemetry: sessions, packets over WebSocket and UDP, watching, and recording."""

import json

import pytest
from fastapi.testclient import TestClient

from backend import live
from backend.main import app

client = TestClient(app)
META = {"session": {"event": "Test rocket"}, "rocket": {"name": "Test rocket"}, "launch": {}}


def register() -> dict:
    res = client.post("/live/sessions", json={"domain": "rocket", "meta": META})
    assert res.status_code == 201
    return res.json()


def sample(t: float, z: float) -> dict:
    return {"time": t, "x": 0.0, "y": 0.0, "z": z, "speed": z, "dynamic_pressure": z}


def packet(s: dict, seq: int, samples=(), events=(), end=False) -> dict:
    return {"v": 1, "session": s["code"], "key": s["key"], "seq": seq,
            "samples": list(samples), "events": list(events), "end": end}


def test_stream_over_websocket_is_watched_live_and_recorded(tmp_path, monkeypatch):
    monkeypatch.setattr(live, "REPLAYS_DIR", tmp_path)
    s = register()
    with client.websocket_connect(f"/live/sessions/{s['code']}/watch") as watcher:
        snapshot = watcher.receive_json()
        assert snapshot["type"] == "snapshot" and snapshot["vehicles"] == {}
        with client.websocket_connect("/live/ingest") as sender:
            sender.send_text(json.dumps(packet(s, 0, [sample(0, 0), sample(0.1, 5)],
                                               [{"name": "liftoff", "time": 0}])))
            sender.send_text(json.dumps(packet(s, 1, [sample(0.2, 12)], end=True)))
            assert sender.receive_json()["ended"] is True
        got, events, end = 0, [], None
        while end is None:
            m = watcher.receive_json()
            if m["type"] == "data":
                got += len(m["samples"])
                events += m["events"]
            elif m["type"] == "end":
                end = m
    assert got == 3 and [e["name"] for e in events] == ["liftoff"]
    assert (tmp_path / f"{end['replay_id']}.parquet").exists()
    meta = json.loads((tmp_path / f"{end['replay_id']}.meta.json").read_text())
    assert meta["domain"] == "rocket" and meta["summary"]["apogee"] == 12


def test_packets_are_checked_deduplicated_and_ordered():
    s = register()
    with pytest.raises(live.LiveError, match="Wrong key"):
        live.ingest({**packet(s, 0, [sample(0, 0)]), "key": "nope"})
    live.ingest(packet(s, 5, [sample(0.5, 5)]))
    live.ingest(packet(s, 5, [sample(0.5, 5)]))          # duplicate datagram: ignored
    live.ingest(packet(s, 3, [sample(0.3, 3)]))          # arrived late: slotted into place
    live.ingest(packet(s, 9, [sample(0.9, 9), {"time": 1.0}]))  # second sample lacks x/y/z: dropped
    session = live.get(s["code"])
    assert list(session.vehicles["rocket"]["time"]) == [0.3, 0.5, 0.9]
    assert session.lost == 3  # seq 6, 7, 8 never came


def test_udp_datagrams_are_ingested_and_errors_answered():
    s = register()
    sent = []

    class Transport:
        def sendto(self, data, addr):
            sent.append(json.loads(data))

    udp = live.UdpIngest()
    udp.connection_made(Transport())
    udp.datagram_received(json.dumps(packet(s, 0, [sample(0, 1)])).encode(), ("127.0.0.1", 5000))
    udp.datagram_received(b"not json", ("127.0.0.1", 5000))
    assert live.get(s["code"]).samples == 1
    assert sent and "error" in sent[0]


F1_META = {
    "session": {"event": "Test GP", "name": "Race"},
    "drivers": [{"code": "AAA", "name": "A", "team": "T", "color": "#ff0000"},
                {"code": "BBB", "name": "B", "team": "T", "color": "#0000ff"}],
    "track_outline": [[i, i * 2, 0] for i in range(20)],
}


def test_f1_sessions_need_drivers_and_a_track():
    assert client.post("/live/sessions", json={"domain": "f1", "meta": META}).status_code == 422
    assert client.post("/live/sessions", json={"domain": "nope", "meta": META}).status_code == 422


def test_f1_stream_keeps_cars_apart_takes_laps_and_records_a_full_replay(tmp_path, monkeypatch):
    monkeypatch.setattr(live, "REPLAYS_DIR", tmp_path)
    s = client.post("/live/sessions", json={"domain": "f1", "meta": F1_META}).json()
    car = lambda vid, t: {"vehicle_id": vid, "time": t, "x": t, "y": 0, "z": 0, "speed": 200, "gear": 7}
    live.ingest(packet(s, 0, [car("AAA", 0), car("BBB", 0), car("AAA", 0.25), car("ZZZ", 0.25)]))
    live.ingest({**packet(s, 1, [car("BBB", 0.25)]),
                 "laps": [{"driver": "AAA", "lap": 1, "lap_time": 81.2, "lap_end": 81.2, "position": 1,
                           "compound": "MEDIUM"}, {"driver": "ZZZ", "lap": 1}]})
    session = live.get(s["code"])
    assert set(session.vehicles) == {"AAA", "BBB"}            # ZZZ isn't in the field
    # A viewer joining now gets the session, then each car's data in its own message
    with client.websocket_connect(f"/live/sessions/{s['code']}/watch") as watcher:
        assert watcher.receive_json()["type"] == "snapshot"
        parts = {m["id"]: m["columns"]["time"] for m in (watcher.receive_json(), watcher.receive_json())}
    assert parts == {"AAA": [0, 0.25], "BBB": [0, 0.25]}
    assert list(session.vehicles["AAA"]["time"]) == [0, 0.25]
    assert list(session.laps) == [("AAA", 1)]
    assert session.snapshot()["laps"][0]["compound"] == "MEDIUM"

    live.ingest(packet(s, 2, end=True))
    rid = session.replay_id
    assert (tmp_path / f"{rid}.laps.json").exists()
    import pandas as pd
    frame = pd.read_parquet(tmp_path / f"{rid}.parquet")
    assert set(frame["vehicle_id"]) == {"AAA", "BBB"} and str(frame["gear"].dtype) == "Int8"
    assert json.loads((tmp_path / f"{rid}.meta.json").read_text())["domain"] == "f1"
