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
    udp.datagram_received(b"not json" * 20, ("127.0.0.1", 5000))
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


class Transport:
    def __init__(self):
        self.sent = []

    def sendto(self, data, addr):
        self.sent.append(data)


@pytest.fixture
def fresh_limits(monkeypatch):
    """Limiters of their own, so these tests don't use up the other tests' allowance."""
    from backend.limits import RateLimiter
    monkeypatch.setattr(live, "session_starts", RateLimiter(rate=1 / 120, burst=6))
    monkeypatch.setattr(live, "packets_per_ip", RateLimiter(rate=500, burst=1000))
    monkeypatch.setattr(live, "packets_total", RateLimiter(rate=5000, burst=10_000))
    monkeypatch.setattr(live, "udp_replies", RateLimiter(rate=1, burst=5))


def test_udp_replies_never_amplify_and_are_rate_limited(fresh_limits):
    udp, transport = live.UdpIngest(), Transport()
    udp.connection_made(transport)
    udp.datagram_received(b"x", ("198.51.100.1", 5000))           # reply would be bigger: silent
    assert transport.sent == []
    junk = b"not json" * 20
    for _ in range(20):
        udp.datagram_received(junk, ("198.51.100.2", 5000))
    assert len(transport.sent) == 5 and all(len(r) <= len(junk) for r in transport.sent)
    udp.datagram_received(b" " * (live.MAX_DATAGRAM + 1), ("198.51.100.3", 5000))  # oversized: dropped
    assert len(transport.sent) == 5


def test_packets_from_one_sender_are_rate_limited(fresh_limits, monkeypatch):
    from backend.limits import RateLimiter
    monkeypatch.setattr(live, "packets_per_ip", RateLimiter(rate=0.01, burst=10))
    s = register()
    data = json.dumps(packet(s, 0, [sample(0, 1)]))
    for _ in range(10):
        live.receive(data, "198.51.100.9", live.MAX_MESSAGE)
    with pytest.raises(live.Throttled):
        live.receive(data, "198.51.100.9", live.MAX_MESSAGE)
    live.receive(data, "198.51.100.10", live.MAX_MESSAGE)  # someone else still gets through
    with pytest.raises(live.LiveError, match="too large"):
        live.receive(" " * (live.MAX_MESSAGE + 1), "198.51.100.10", live.MAX_MESSAGE)


def test_one_address_cant_hog_sessions(fresh_limits, monkeypatch):
    monkeypatch.setattr(live, "_sessions", {})
    for _ in range(live.MAX_SESSIONS_PER_IP):
        live.create("rocket", META, owner="198.51.100.20")
    with pytest.raises(live.Throttled, match="already have"):
        live.create("rocket", META, owner="198.51.100.20")
    live.create("rocket", META, owner="198.51.100.21")
    with pytest.raises(live.LiveError, match="too large"):
        live.create("rocket", {**META, "junk": "x" * live.MAX_META_BYTES}, owner="198.51.100.22")


def test_session_starts_are_rate_limited_per_address(fresh_limits, monkeypatch):
    monkeypatch.setattr(live, "_sessions", {})
    for _ in range(6):
        live.end(live.create("rocket", META, owner="198.51.100.30"))  # ended, so not counted as open
    with pytest.raises(live.Throttled, match="wait"):
        live.create("rocket", META, owner="198.51.100.30")


def test_http_limits(fresh_limits, monkeypatch):
    monkeypatch.setattr(live, "_sessions", {})
    assert client.post("/live/sessions", content=b"{" + b" " * (1024 * 1024 + 1)).status_code == 413
    monkeypatch.setattr(live, "MAX_SESSIONS_PER_IP", 1)
    assert client.post("/live/sessions", json={"domain": "rocket", "meta": META}).status_code == 201
    assert client.post("/live/sessions", json={"domain": "rocket", "meta": META}).status_code == 429


def test_only_the_newest_live_recordings_are_kept(tmp_path, monkeypatch):
    import os
    monkeypatch.setattr(live, "REPLAYS_DIR", tmp_path)
    for i in range(4):
        for suffix in (".parquet", ".meta.json"):
            path = tmp_path / f"live_r{i}{suffix}"
            path.write_text("{}")
            os.utime(path, (i, i))
    (tmp_path / "monza_2024_r.meta.json").write_text("{}")
    live.prune_recordings(keep=2)
    assert sorted(p.name for p in tmp_path.iterdir()) == [
        "live_r2.meta.json", "live_r2.parquet", "live_r3.meta.json", "live_r3.parquet", "monza_2024_r.meta.json"]


def test_a_session_can_name_a_design_instead_of_sending_its_geometry(fresh_limits, monkeypatch):
    monkeypatch.setattr(live, "_sessions", {})
    res = client.post("/live/sessions", json={"domain": "rocket", "rocket": "chute_release",
                                              "meta": {"session": {"event": "My flight"}}})
    assert res.status_code == 201
    meta = client.get(f"/live/sessions/{res.json()['code']}").json()["meta"]
    assert meta["rocket"]["id"] == "chute_release" and meta["rocket"]["length"] > 0
    assert meta["session"]["event"] == "My flight" and "rail_length" in meta["launch"]
    assert client.post("/live/sessions", json={"domain": "rocket", "rocket": "../secrets"}).status_code == 404


def test_a_demo_is_streamed_by_the_server_and_recorded(fresh_limits, tmp_path, monkeypatch):
    from backend.routers import live as live_router
    from telemetry import live_sources
    monkeypatch.setattr(live, "_sessions", {})
    monkeypatch.setattr(live, "REPLAYS_DIR", tmp_path)
    flight = live_sources.LiveStream("rocket", META, [sample(t / 10, t) for t in range(5)],
                                     events=[{"name": "apogee", "time": 0.4, "z": 4}])
    monkeypatch.setattr(live_sources, "rocket_flight", lambda *a, **k: flight)
    with TestClient(app) as c:  # keeps the event loop (and so the demo's task) running between requests
        res = c.post("/live/demo", json={"rocket": "chute_release", "speed": 20})
        assert res.status_code == 201
        code = res.json()["code"]
        assert c.get(f"/live/sessions/{code}").json()["demo"] is True
        with c.websocket_connect(f"/live/sessions/{code}/watch") as watcher:
            while (m := watcher.receive_json())["type"] != "end":
                pass
    session = live.get(code)
    assert session.samples == 5 and [e["name"] for e in session.events] == ["apogee"]
    assert (tmp_path / f"{m['replay_id']}.parquet").exists()


def test_demos_need_one_source_and_are_capped(fresh_limits, monkeypatch):
    from backend import demos
    assert client.post("/live/demo", json={}).status_code == 422
    assert client.post("/live/demo", json={"rocket": "chute_release", "replay": "monza_2024_r"}).status_code == 422
    assert client.post("/live/demo", json={"replay": "../../etc/passwd"}).status_code == 404
    monkeypatch.setattr(demos, "MAX_DEMOS", 0)
    assert client.post("/live/demo", json={"rocket": "chute_release"}).status_code == 429


def test_the_sender_cli_reads_csv_and_json_lines():
    from telemetry.live_cli import read_lines
    csv_lines = ["time,x,y,z,vehicle_id\n", "0,0,0,0,LEC\n", "\n", "0.1,1,0,2.5,LEC\n"]
    assert list(read_lines(csv_lines)) == [{"time": 0.0, "x": 0.0, "y": 0.0, "z": 0.0, "vehicle_id": "LEC"},
                                           {"time": 0.1, "x": 1.0, "y": 0.0, "z": 2.5, "vehicle_id": "LEC"}]
    json_lines = ['{"time": 0, "x": 0, "y": 0, "z": 1}\n', "garbage\n", '{"event": "apogee", "time": 9.8}\n']
    assert [i.get("event") for i in read_lines(json_lines)] == [None, "apogee"]
