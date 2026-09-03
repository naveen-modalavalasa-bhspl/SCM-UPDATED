"""One row per second of the run: what actually happened, by business event.

Locust's own statistics are per endpoint and aggregated over the whole run, which
answers "how fast is POST /api/indents" and not "how many indents were raised in the
second where everything went wrong". For a transaction test the second matters — lock
contention, deadlocks and queue starvation all show up as a shape over time, not as an
average.

So every business event is counted here as it lands, and a background greenlet
snapshots the counters once a second into a CSV. The counters are reset each tick, so
a row is a RATE (events in that second), except the gauges, which are levels.

Nothing in here may slow the test down or throw: a telemetry bug that fails a request
would corrupt the very numbers it exists to collect.
"""
import csv
import time
from collections import Counter, defaultdict

import gevent
from locust import events

#: Events counted in the second currently being measured. Reset on every tick.
_tick: Counter = Counter()
#: Levels, not rates — read as-is at tick time.
_gauges: dict[str, int] = defaultdict(int)
#: Which roles have at least one signed-in user right now. A set, because "how many
#: DIFFERENT roles were working at once" is the question, not how many sessions.
_active_roles: set[str] = set()
_role_sessions: Counter = Counter()

#: The order columns appear in the CSV. Fixed, so a run is diffable against another.
COLUMNS = [
    "t", "elapsed",
    # --- who is on the system ---
    "users_spawned", "logins", "login_failures", "roles_active", "sessions",
    # --- the transaction chain, in the order a document travels ---
    "indents_raised", "indents_submitted",
    "approvals_l1", "approvals_l2", "approvals_l3plus", "approvals_total",
    # Same presses, split the other way: an indent approval decides quantities, every
    # other document type is a straight yes. Both matter, and one number hides which.
    "approvals_indent", "approvals_other", "rejections",
    "allocations_created", "allocations_approved",
    "issues_created", "issues_posted",
    "qc_outward_created", "qc_outward_approved",
    "consignments_created", "dispatches_raised",
    "acknowledgements",
    # --- health ---
    "reads", "writes", "http_5xx", "http_409", "http_422", "http_403",
    "starved",
]

_writer = None
_handle = None
_started = 0.0
_runner = None


def record(event: str, count: int = 1) -> None:
    """Count one business event. Called from user code; must never raise."""
    try:
        _tick[event] += count
    except Exception:
        pass


def session_started(role: str) -> None:
    try:
        _role_sessions[role] += 1
        _active_roles.add(role)
        _gauges["sessions"] += 1
    except Exception:
        pass


def session_ended(role: str) -> None:
    try:
        _role_sessions[role] -= 1
        if _role_sessions[role] <= 0:
            _active_roles.discard(role)
        _gauges["sessions"] -= 1
    except Exception:
        pass


@events.request.add_listener
def _on_request(request_type, name, response_time, response_length, exception,
                context, **kwargs):
    """Classify every HTTP call, so read/write mix and error codes are in the timeline
    without each task having to remember to report them."""
    try:
        if request_type == "GET":
            _tick["reads"] += 1
        else:
            _tick["writes"] += 1
        code = getattr(kwargs.get("response", None), "status_code", None)
        if code is None:
            return
        if code >= 500:
            _tick["http_5xx"] += 1
        elif code == 409:
            _tick["http_409"] += 1
        elif code == 422:
            _tick["http_422"] += 1
        elif code == 403:
            _tick["http_403"] += 1
    except Exception:
        pass


def _tick_loop():
    global _tick
    while True:
        gevent.sleep(1.0)
        try:
            snapshot, _tick = _tick, Counter()
            now = time.time()
            row = {
                "t": time.strftime("%H:%M:%S", time.localtime(now)),
                "elapsed": round(now - _started, 1),
                "users_spawned": getattr(_runner, "user_count", 0) if _runner else 0,
                "roles_active": len(_active_roles),
                "sessions": _gauges["sessions"],
            }
            for column in COLUMNS:
                if column not in row:
                    row[column] = snapshot.get(column, 0)
            row["approvals_total"] = (row["approvals_l1"] + row["approvals_l2"]
                                      + row["approvals_l3plus"])
            _writer.writerow(row)
            _handle.flush()
        except Exception:
            # A telemetry failure must never take the run down with it.
            pass


@events.test_start.add_listener
def _start(environment, **_kwargs):
    global _writer, _handle, _started, _runner
    import os

    path = os.getenv("LOADTEST_TIMELINE", "loadtest/results/timeline.csv")
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    _handle = open(path, "w", newline="", encoding="utf8")
    _writer = csv.DictWriter(_handle, fieldnames=COLUMNS)
    _writer.writeheader()
    _started = time.time()
    _runner = environment.runner
    gevent.spawn(_tick_loop)
    print(f"[telemetry] per-second timeline -> {path}")


@events.test_stop.add_listener
def _stop(**_kwargs):
    try:
        _handle.flush()
        _handle.close()
    except Exception:
        pass
