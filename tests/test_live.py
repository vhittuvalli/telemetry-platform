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
        assert snapshot["type"] == "snapshot" and snapshot["columns"]["time"] == []
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
    assert session.columns["time"] == [0.3, 0.5, 0.9]
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


def test_only_rocket_sessions_for_now():
    res = client.post("/live/sessions", json={"domain": "f1", "meta": META})
    assert res.status_code == 422
