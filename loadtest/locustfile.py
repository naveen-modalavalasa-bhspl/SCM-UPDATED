"""Load profile for SCM ERP: what 1,000 people signing in and working actually costs.

Run against the CLONE (SCM_LOADTEST), never the working database — see
`backend/scripts/clone_for_loadtest.py`.

Two deliberate choices about what this measures:

**Every user is a different user.** The pool is 1,200 real employees from the mirror,
each with their own position and one of eight job-profile roles. Signing one account
in a thousand times would warm a single permission-cache key and a single position
lookup, and the RBAC cost that dominates an authenticated request — an employee
SELECT, a joined position lookup across four hcm_ tables, a roles query and a
permissions join — would never appear.

**The sign-in rush is its own scenario.** `SignInRush` does nothing but authenticate.
That is the 09:00 shift change, and it is the one moment where bcrypt (250-300 ms of
pure CPU per attempt) decides the ceiling for the whole application. Run it separately
from the working profile; mixed in, it hides behind the read traffic.

`FastHttpUser` throughout: the default `HttpUser` uses `requests`, which cannot keep a
thousand greenlets busy without the load generator becoming the bottleneck and being
mistaken for the server.
"""
import os
import random

from locust import FastHttpUser, between, events, task

PASSWORD = os.getenv("LOADTEST_PASSWORD", "LoadTest#2026")
USERS_FILE = os.getenv("LOADTEST_USERS", "loadtest/users.txt")

_pool: list[str] = []


@events.test_start.add_listener
def _load_pool(**_kwargs):
    global _pool
    with open(USERS_FILE, encoding="utf8") as handle:
        _pool = [line.strip() for line in handle if line.strip()]
    if not _pool:
        raise RuntimeError(f"No users in {USERS_FILE}")
    print(f"[loadtest] {len(_pool)} logins in the pool")


class _Authenticated(FastHttpUser):
    """Signs in once at spawn, then works. Abstract — the profiles below are concrete."""

    abstract = True
    # Long enough to notice a queued request rather than reporting it as a failure at
    # the moment the server starts to slow down, which is the interesting part.
    network_timeout = 60.0
    connection_timeout = 60.0

    def on_start(self):
        self.employee_id = random.choice(_pool)
        self.token = None
        response = self.client.post(
            "/api/auth/login",
            data={"username": self.employee_id, "password": PASSWORD},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            name="POST /api/auth/login",
        )
        if response.status_code != 200:
            # 429/401 here is almost always the login throttle, not the server
            # struggling — all of this load comes from one address, so
            # LOGIN_RATE_PER_MINUTE has to be raised on the server under test or the
            # run measures the rate limiter instead of the application.
            return
        self.token = response.json().get("access_token")
        self.headers = {"Authorization": f"Bearer {self.token}"}
        # Every screen in the app starts here: it is what builds the menu, the
        # permission set and the position list.
        self.client.get("/api/auth/me", headers=self.headers, name="GET /api/auth/me")

    def get(self, path, name=None):
        if not self.token:
            return None
        return self.client.get(path, headers=self.headers, name=name or path)


class OfficeWorker(_Authenticated):
    """A normal working session: the dashboard, then lists and documents.

    Weights are roughly what a desk does in an hour — the register is opened far more
    often than any one document is read, and the dashboard is hit on every sign-in and
    every return to Home.
    """

    weight = 9
    wait_time = between(1, 5)

    @task(6)
    def indent_register(self):
        page = random.randint(1, 3)
        self.get(f"/api/indents?page={page}&size=25", name="GET /api/indents [list]")

    @task(4)
    def home_dashboard(self):
        # The single most expensive endpoint in the system: ~17 awaited calls, several
        # of them multi-query, plus a per-item replenishment loop. Uncached.
        self.get("/api/home/summary", name="GET /api/home/summary")

    @task(3)
    def indent_detail(self):
        self.get("/api/indents?page=1&size=5", name="GET /api/indents [list]")
        self.get("/api/indents/stats", name="GET /api/indents/stats")

    @task(3)
    def approvals_inbox(self):
        self.get("/api/approvals/pending?page=1&size=25", name="GET /api/approvals/pending")

    @task(2)
    def approvals_badge(self):
        self.get("/api/approvals/pending/summary", name="GET /api/approvals/pending/summary")

    @task(2)
    def notifications(self):
        self.get("/api/notifications/unread-count", name="GET /api/notifications/unread-count")

    @task(2)
    def activity_ledger(self):
        self.get("/api/indents/activity?page=1&size=25", name="GET /api/indents/activity")

    @task(1)
    def acknowledgements(self):
        self.get("/api/indents/acknowledgments?page=1&size=25",
                 name="GET /api/indents/acknowledgments")


class SignInRush(_Authenticated):
    """09:00. Everybody signs in at once and nothing else happens.

    One task, and it re-authenticates rather than reusing the token, because the thing
    under test is the hash — not the session.
    """

    weight = 1
    wait_time = between(5, 15)

    @task
    def sign_in_again(self):
        self.client.post(
            "/api/auth/login",
            data={"username": random.choice(_pool), "password": PASSWORD},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            name="POST /api/auth/login",
        )
