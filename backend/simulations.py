"""Rocket flights simulated on request. Kept in memory (the most recent few), not written to disk."""

import threading
from collections import OrderedDict

MAX_FLIGHTS = 16

_lock = threading.Lock()
_flights: "OrderedDict[str, dict]" = OrderedDict()


def put(flight_id: str, frame, meta: dict, dispersion: dict | None) -> None:
    with _lock:
        _flights[flight_id] = {"frame": frame, "meta": meta, "dispersion": dispersion}
        _flights.move_to_end(flight_id)
        while len(_flights) > MAX_FLIGHTS:
            _flights.popitem(last=False)


def get(flight_id: str) -> dict | None:
    with _lock:
        flight = _flights.get(flight_id)
        if flight:
            _flights.move_to_end(flight_id)
        return flight
