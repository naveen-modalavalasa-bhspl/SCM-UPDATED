"""The transaction chain under load — writes, not reads.

The read profile (`locustfile.py`) answers "can the server serve 1,000 people looking
at screens". It says nothing about the half that can actually corrupt data. Every
write in this system takes row locks — `stk_balance` and `stk_ledger` for stock,
`sys_doc_series` for document numbering, `wf_instances` for approvals — and under
concurrency the failure mode is not slowness. It is deadlocks, duplicate document
numbers and reservations that do not add up.

**The chain, in the order a document travels:**

    indent raised -> submitted -> approved (one rung per ladder level)
      -> allocated -> allocation approved
      -> material issue created -> posted
      -> QC outward (outbound inspection) created -> approved
      -> consignment created -> dispatch raised (transport request)
      -> indent acknowledged by the requester

**It is a PIPELINE, not a script.** A user does not walk the whole chain: each persona
works whatever queue its own permissions give it, and the queues are fed by the
personas upstream. Requesters keep raising indents, approvers keep approving whatever
is pending, storekeepers allocate whatever is owed. That is how the floor actually
behaves, and it is the only way to keep every stage busy for the length of a run —
a scripted end-to-end journey spends its whole time waiting for stage one.

**Personas come from permissions, not from configuration.** After signing in, a user
reads its own `/api/auth/me` permission list and takes the roles it is actually
entitled to. A test that assumes a persona it has no grant for measures the RBAC
guard returning 403, which is a real answer to a different question.

`starved` in the timeline is the number counted when a persona looked for work and its
queue was empty. A run where `starved` climbs is a run where the pipeline dried up,
and its throughput numbers mean nothing.
"""
import os
import random
from datetime import date, timedelta

from locust import FastHttpUser, between, events, task

import telemetry

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


class Operator(FastHttpUser):
    """One signed-in person, doing whatever their grants allow.

    A single user class rather than one per persona: which desk somebody works is a
    property of their RBAC role, and Locust would otherwise have to be told a
    distribution that the data already decides.
    """

    wait_time = between(1, 4)
    network_timeout = 60.0
    connection_timeout = 60.0

    # ---------------------------------------------------------------- session

    def on_start(self):
        self.token = None
        self.perms = set()
        self.role_label = "unknown"
        response = self.client.post(
            "/api/auth/login",
            data={"username": random.choice(_pool), "password": PASSWORD},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            name="POST /api/auth/login",
        )
        if response.status_code != 200:
            telemetry.record("login_failures")
            return
        telemetry.record("logins")
        self.token = response.json().get("access_token")
        self.headers = {"Authorization": f"Bearer {self.token}"}

        me = self.client.get("/api/auth/me", headers=self.headers,
                             name="GET /api/auth/me")
        if me.status_code == 200:
            body = me.json()
            self.perms = set(body.get("permissions") or [])
            roles = body.get("roles") or []
            self.role_label = roles[0] if roles else "no-role"
        telemetry.session_started(self.role_label)

    def on_stop(self):
        if self.token:
            telemetry.session_ended(self.role_label)

    # ---------------------------------------------------------------- helpers

    def _get(self, path, name=None):
        if not self.token:
            return None
        return self.client.get(path, headers=self.headers, name=name or path)

    def _post(self, path, payload=None, name=None):
        if not self.token:
            return None
        return self.client.post(path, json=payload if payload is not None else {},
                                headers=self.headers, name=name or path)

    def _rows(self, response):
        """Items out of a paginated body, or an empty list. Never raises: a 500 under
        load returns HTML or a truncated body, and a JSON error here would be counted
        as a load-generator failure rather than as the server fault it is."""
        if response is None or response.status_code != 200:
            return []
        try:
            body = response.json()
        except Exception:
            return []
        if isinstance(body, list):
            return body
        return body.get("items") or []

    def _can(self, *codes):
        return any(code in self.perms for code in codes)

    # ------------------------------------------------------- 1. raise + submit

    @task(6)
    def raise_indent(self):
        if not self._can("indent.create"):
            return
        items = self._rows(self._get("/api/indents/eligible-items?page=1&size=20",
                                     name="GET /api/indents/eligible-items"))
        if not items:
            telemetry.record("starved")
            return
        chosen = random.sample(items, min(len(items), random.randint(1, 3)))
        payload = {
            # Mandatory, and refused if it is in the past — so it is dated forward
            # rather than defaulted, which is what a requester actually does.
            "required_date": (date.today() + timedelta(days=random.randint(3, 30))
                              ).isoformat(),
            # NORMAL | URGENT — the enum, not the three-level scale the UI suggests.
            "priority": random.choice(["NORMAL", "URGENT"]),
            "remarks": "load test",
            "items": [{"item_id": row.get("id") or row.get("item_id"),
                       "quantity": random.randint(1, 5)}
                      for row in chosen if (row.get("id") or row.get("item_id"))],
        }
        if not payload["items"]:
            telemetry.record("starved")
            return
        created = self._post("/api/indents", payload, name="POST /api/indents")
        # 200, not 201 — the route declares no status_code, so FastAPI's default
        # applies. Checking for 201 alone silently counted every successful create as
        # a failure, which is how a first pass at this profile reported a working
        # pipeline as producing nothing.
        if created is None or created.status_code not in (200, 201):
            return
        telemetry.record("indents_raised")
        try:
            indent_id = created.json().get("id")
        except Exception:
            return
        # Submitted straight away: a draft nobody submits never reaches the ladder, and
        # the approval stages downstream would starve.
        submitted = self._post(f"/api/indents/{indent_id}/submit", {},
                               name="POST /api/indents/{id}/submit")
        if submitted is not None and submitted.status_code in (200, 201):
            telemetry.record("indents_submitted")

    # ------------------------------------------------------------ 2. approvals

    @task(6)
    def approve_pending(self):
        """Approve whatever this login is the current approver for.

        Three things this had to learn from the running system rather than assume:

        * the rung is `stage_sequence` on the pending row — not `level`, `sequence` or
          `stage_order`, none of which exist. Counting rungs separately is the point:
          a ladder where level 1 clears and level 2 backs up looks identical to a
          healthy one in an aggregate approvals-per-second number;
        * an INDENT approval REQUIRES per-line quantities (`items: [{line_id,
          approved_quantity}]`) because approving an indent is also the act of
          deciding how much of it is approved. Sending only `comments` is a 422;
        * every other document type — MR, RFQ, REQUISITION, PO, OWN_STOCK_ALLOCATION —
          goes through the generic `/documents/{type}/{id}` route with comments alone.
          One inbox, two contracts.
        """
        if not self._can("indent.approve", "approval.act"):
            return
        rows = self._rows(self._get("/api/approvals/pending?page=1&size=10",
                                    name="GET /api/approvals/pending"))
        if not rows:
            telemetry.record("starved")
            return
        row = random.choice(rows)
        doc_id = row.get("doc_id")
        doc_type = (row.get("doc_type") or "").upper()
        try:
            rung = int(row.get("stage_sequence") or 1)
        except (TypeError, ValueError):
            rung = 1
        if not doc_id or not doc_type:
            return

        if doc_type == "INDENT":
            detail = self._get(f"/api/approvals/indents/{doc_id}",
                               name="GET /api/approvals/indents/{id}")
            if detail is None or detail.status_code != 200:
                return
            try:
                lines = detail.json().get("items") or []
            except Exception:
                return
            if not lines:
                telemetry.record("starved")
                return
            payload = {
                "comments": "load test",
                # Approve what was asked, capped at what the rung above allowed. A
                # rung may only ever narrow, so `max_quantity` is the ceiling.
                "items": [{"line_id": line["id"],
                           "approved_quantity": float(
                               line.get("max_quantity")
                               or line.get("requested_quantity") or 0)}
                          for line in lines if line.get("id")],
            }
            path = f"/api/approvals/indents/{doc_id}/approve"
            name = "POST /api/approvals/indents/{id}/approve"
        else:
            payload = {"comments": "load test"}
            path = f"/api/approvals/documents/{doc_type}/{doc_id}/approve"
            name = "POST /api/approvals/documents/{type}/{id}/approve"

        result = self._post(path, payload, name=name)
        if result is None:
            return
        if result.status_code in (200, 201):
            telemetry.record("approvals_l1" if rung <= 1
                             else "approvals_l2" if rung == 2 else "approvals_l3plus")
            telemetry.record("approvals_indent" if doc_type == "INDENT"
                             else "approvals_other")
        # A 409 here is somebody else approving the same document between the list and
        # the press. Expected under concurrency and NOT a defect — it is the document
        # status check doing its job, and it is counted as http_409 in the timeline.

    # ---------------------------------------------------------- 3. allocations

    @task(5)
    def allocate(self):
        if not self._can("allocation.create"):
            return
        rows = self._rows(self._get(
            "/api/indents?page=1&size=10&has_remainder=true&to_serve=true",
            name="GET /api/indents [to serve]"))
        if not rows:
            telemetry.record("starved")
            return
        indent_id = random.choice(rows).get("id")
        if not indent_id:
            return
        detail = self._get(f"/api/approvals/indents/{indent_id}/availability",
                           name="GET /api/approvals/indents/{id}/availability")
        lines = self._rows(detail)
        decisions = []
        for line in lines[:5]:
            line_id = line.get("indent_item_id") or line.get("line_id") or line.get("id")
            available = line.get("available_qty") or line.get("availability") or 0
            try:
                available = float(available)
            except (TypeError, ValueError):
                available = 0
            if line_id and available > 0:
                decisions.append({"indent_item_id": line_id,
                                  "allocated_quantity": min(1, available)})
        if not decisions:
            telemetry.record("starved")
            return
        created = self._post("/api/allocations",
                             {"indent_id": indent_id, "decisions": decisions,
                              "remarks": "load test"},
                             name="POST /api/allocations")
        if created is not None and created.status_code in (200, 201):
            telemetry.record("allocations_created")

    @task(4)
    def approve_allocation(self):
        if not self._can("allocation.approve"):
            return
        rows = self._rows(self._get("/api/approvals/pending?page=1&size=10&doc_type=ALLOCATION",
                                    name="GET /api/approvals/pending [allocation]"))
        if not rows:
            telemetry.record("starved")
            return
        doc_id = random.choice(rows).get("doc_id")
        if not doc_id:
            return
        result = self._post(f"/api/allocations/{doc_id}/approve",
                            {"comments": "load test"},
                            name="POST /api/allocations/{id}/approve")
        if result is not None and result.status_code in (200, 201):
            telemetry.record("allocations_approved")

    # ------------------------------------------------------- 4. material issue

    @task(4)
    def material_issue(self):
        if not self._can("issue.create", "issue.post"):
            return
        rows = self._rows(self._get("/api/warehouse/issues?page=1&size=10",
                                    name="GET /api/warehouse/issues"))
        if not rows:
            telemetry.record("starved")
            return
        row = random.choice(rows)
        issue_id, status = row.get("id"), (row.get("status") or "").upper()
        if not issue_id:
            return
        # Move it one rung, whichever rung it is on. Posting is the interesting press:
        # that is the one that takes the stock lock and writes the ledger.
        if status == "DRAFT" and self._can("issue.create"):
            if (self._post(f"/api/warehouse/issues/{issue_id}/submit", {},
                           name="POST /api/warehouse/issues/{id}/submit")
                    or {}) and True:
                telemetry.record("issues_created")
        elif status in ("APPROVED", "READY", "PICKED") and self._can("issue.post"):
            result = self._post(f"/api/warehouse/issues/{issue_id}/issue", {},
                                name="POST /api/warehouse/issues/{id}/issue")
            if result is not None and result.status_code in (200, 201):
                telemetry.record("issues_posted")

    # ---------------------------------------------------------- 5. QC outward

    @task(3)
    def qc_outward(self):
        if not self._can("qc_outward.create", "qc_outward.approve"):
            return
        rows = self._rows(self._get("/api/warehouse/outbound-inspections?page=1&size=10",
                                    name="GET /api/warehouse/outbound-inspections"))
        if not rows:
            telemetry.record("starved")
            return
        row = random.choice(rows)
        inspection_id, status = row.get("id"), (row.get("status") or "").upper()
        if not inspection_id:
            return
        if status in ("DRAFT", "IN_PROGRESS") and self._can("qc_outward.create"):
            result = self._post(
                f"/api/warehouse/outbound-inspections/{inspection_id}/complete", {},
                name="POST /api/warehouse/outbound-inspections/{id}/complete")
            if result is not None and result.status_code in (200, 201):
                telemetry.record("qc_outward_created")
        elif self._can("qc_outward.approve"):
            result = self._post(
                f"/api/warehouse/outbound-inspections/{inspection_id}/approve",
                {"comments": "load test"},
                name="POST /api/warehouse/outbound-inspections/{id}/approve")
            if result is not None and result.status_code in (200, 201):
                telemetry.record("qc_outward_approved")

    # ------------------------------------------------- 6. consignment/dispatch

    @task(3)
    def consignment_and_dispatch(self):
        if not self._can("dispatch.view", "transport.create"):
            return
        rows = self._rows(self._get("/api/warehouse/consignments?page=1&size=10",
                                    name="GET /api/warehouse/consignments"))
        if not rows:
            telemetry.record("starved")
            return
        row = random.choice(rows)
        consignment_id = row.get("id")
        status = (row.get("status") or "").upper()
        if not consignment_id:
            return
        # Only a packed/released consignment can travel; anything else is somebody
        # else's stage and pressing it would measure the status guard.
        if status in ("PACKED", "READY", "APPROVED", "RELEASED") and self._can("transport.create"):
            result = self._post("/api/transport/dispatch-consignment",
                                {"consignment_id": consignment_id,
                                 "mode": "OWN_VEHICLE",
                                 "remarks": "load test"},
                                name="POST /api/transport/dispatch-consignment")
            if result is not None and result.status_code in (200, 201):
                telemetry.record("dispatches_raised")

    # ------------------------------------------------------ 7. acknowledgement

    @task(3)
    def acknowledge(self):
        if not self._can("indent.acknowledge"):
            return
        rows = self._rows(self._get("/api/indents/acknowledgments?page=1&size=10",
                                    name="GET /api/indents/acknowledgments"))
        if not rows:
            telemetry.record("starved")
            return
        row = random.choice(rows)
        indent_id = row.get("indent_id") or row.get("id")
        lines = row.get("lines") or row.get("items") or []
        if not indent_id or not lines:
            telemetry.record("starved")
            return
        payload = {
            "condition": "GOOD",
            "remarks": "load test",
            "lines": [{"indent_item_id": line.get("indent_item_id") or line.get("id"),
                       "received_quantity": 1}
                      for line in lines[:3]
                      if (line.get("indent_item_id") or line.get("id"))],
        }
        if not payload["lines"]:
            return
        result = self._post(f"/api/indents/{indent_id}/acknowledge", payload,
                            name="POST /api/indents/{id}/acknowledge")
        if result is not None and result.status_code in (200, 201):
            telemetry.record("acknowledgements")

    # ------------------------------------------------------------ 8. read load
    # Real desks read far more than they write, and the reads share the same pool and
    # the same workers. Leaving them out would flatter every write number here.

    @task(8)
    def read_around(self):
        random.choice([
            lambda: self._get("/api/indents?page=1&size=25", name="GET /api/indents [list]"),
            lambda: self._get("/api/home/summary", name="GET /api/home/summary"),
            lambda: self._get("/api/approvals/pending/summary",
                              name="GET /api/approvals/pending/summary"),
            lambda: self._get("/api/notifications/unread-count",
                              name="GET /api/notifications/unread-count"),
        ])()
