"""The return journey at step level — no database needed.

Every function under test reads plain rows: audit rows, `wf_actions` rows, a frozen
resolved chain and the phase list `journey()` has already computed. So the rules worth
pinning are pinned here rather than behind the DB-backed suite, which drops and recreates
~85 tables per test.

What these protect is the two things this screen can get silently wrong: counting one
signature twice (the press wrote an audit row AND a rung), and dropping a leg entirely
(nothing has happened in it yet, so nothing describes it).
"""
import json
from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace

from app.modules.returns import service
from app.modules.returns.enums import Disposition, ReturnStatus
from app.shared.enums import ApprovalAction, AuditAction, InstanceStatus


def _audit(row_id: int, changed: dict | None, *, action=AuditAction.UPDATE,
           actor: str = "A Anil Kumar", minute: int = 0):
    return SimpleNamespace(
        id=row_id,
        action=action.value,
        changed_fields=changed,
        actor_name=actor,
        created_at=datetime(2026, 9, 7, 10, minute),
    )


def _changed(**fields):
    """The audit shape: only what actually differed, as `{"from": x, "to": y}`."""
    return {key: {"from": None, "to": value} for key, value in fields.items()}


def _action(row_id: int, sequence: int, action=ApprovalAction.APPROVED, *,
            name: str = "Regional Manager", actor: str = "R Rao",
            comments: str | None = None, minute: int = 0):
    return SimpleNamespace(
        id=row_id,
        stage_sequence=sequence,
        stage_name=name,
        actor_name=actor,
        actor_position="RM Kadapa",
        action=action.value,
        comments=comments,
        acted_at=datetime(2026, 9, 7, 11, minute),
    )


def _doc(**payload):
    return SimpleNamespace(
        id=7,
        sto_no="RET-0007",
        requested_by_name="A Anil Kumar",
        from_warehouse_name="Chilamathur LIP",
        created_at=datetime(2026, 9, 7, 9, 0),
        items=[SimpleNamespace(requested_qty=Decimal("5"))],
        remarks=service.MARKER + json.dumps(payload),
    )


def _phases(**states):
    """The eight legs, in order, at whatever state the test cares about."""
    return [{"key": key, "label": label, "sequence": index + 1,
             "state": states.get(key, "pending"), "caption": f"{key} caption"}
            for index, (key, label) in enumerate(service.PHASES)]


class TestTheTrail:
    """One audit row per press, and each one read for what it actually says."""

    def test_every_press_is_named_from_what_it_changed(self):
        events = service._journey_events(_doc(), [
            _audit(1, _changed(status=ReturnStatus.DRAFT.value, reason="EXPIRED"),
                   action=AuditAction.CREATE),
            _audit(2, _changed(status=ReturnStatus.PENDING_APPROVAL.value,
                               phase=service.PHASE_DECISION), minute=1),
            _audit(3, _changed(status=ReturnStatus.PENDING_APPROVAL.value,
                               disposition=Disposition.SEND_TO_POINT.value,
                               note="Send it to the district store"), minute=2),
            _audit(4, _changed(objections=1, objection="Wrong point"), minute=3),
            _audit(5, _changed(send_backs=1, note="Photograph shows something else"),
                   minute=4),
            _audit(6, _changed(status=ReturnStatus.DISPATCHED.value,
                               transport_request_no="TR-0009"), minute=5),
            _audit(7, _changed(condition="GOOD", transport_request_no="TR-0009"),
                   minute=6),
            _audit(8, _changed(status=ReturnStatus.RECEIVED.value,
                               acknowledged_by="A Anil Kumar"), minute=7),
        ], rejected_stage_type=None)

        assert [event["event_type"] for event in events] == [
            "CREATED", "SUBMITTED", "DECIDED", "DECISION_OBJECTED", "SENT_BACK",
            "DISPATCHED", "DELIVERED", "ACKNOWLEDGED",
        ]
        # The decision's own wording comes from the disposition, not from the status.
        assert events[2]["title"] == "Send to a stocking point"
        assert events[2]["comments"] == "Send it to the district store"
        # A send-back is only ever explained by its note, so it must survive the trip.
        assert events[4]["comments"] == "Photograph shows something else"
        assert events[6]["reference_no"] == "TR-0009"

    def test_a_press_that_wrote_a_rung_is_trail_only(self):
        # The decide, the endorse and the final approval all write a `wf_actions` row.
        # The rung is the step; drawing the audit row as one too would count the same
        # signature twice on the same leg.
        events = service._journey_events(_doc(), [
            _audit(1, _changed(status=ReturnStatus.PENDING_APPROVAL.value,
                               disposition=Disposition.SEND_TO_POINT.value, note="ok")),
            _audit(2, _changed(phase=service.PHASE_FIELD, comments="Agreed"), minute=1),
            _audit(3, _changed(status=ReturnStatus.APPROVED.value, comments="Signed"),
                   minute=2),
        ], rejected_stage_type=None)
        assert [event["stage_type"] for event in events] == [None, None, None]

    def test_the_second_submit_is_a_resubmission(self):
        events = service._journey_events(_doc(), [
            _audit(1, _changed(status=ReturnStatus.PENDING_APPROVAL.value)),
            _audit(2, _changed(send_backs=1, note="Fix the quantity"), minute=1),
            _audit(3, _changed(status=ReturnStatus.PENDING_APPROVAL.value), minute=2),
        ], rejected_stage_type=None)
        assert events[0]["title"] == "Submitted for approval"
        assert events[2]["title"] == service.RESUBMISSION_TITLE
        # Both are steps on the request leg: a corrected return went back up the ladder,
        # and the timeline has to keep the correction that was asked for.
        assert [event["stage_type"] for event in events] == [
            "submission", "submission", "submission",
        ]

    def test_a_rejection_becomes_a_step_only_where_no_chain_recorded_it(self):
        rows = [_audit(1, _changed(status=ReturnStatus.REJECTED.value,
                                   comments="Not coming back"))]
        # At the decision desk no instance is open yet, so the audit row is the whole
        # record and has to carry the step.
        desk = service._journey_events(_doc(), rows, rejected_stage_type="decision")
        assert desk[0]["stage_type"] == "decision"
        assert desk[0]["comments"] == "Not coming back"
        # With a rung behind it, the rung is the step.
        assert service._journey_events(_doc(), rows,
                                       rejected_stage_type=None)[0]["stage_type"] is None


class TestTheRungs:
    """The receipt chain is one chain and two legs, because it holds two decisions."""

    def test_the_first_rung_is_the_decision_and_the_rest_are_the_sign_off(self):
        receipt = [_action(1, 1, name="SCM HEAD", actor="MAHENDRA"),
                   _action(2, 2, name="Inventory Manager", actor="S Rao", minute=1)]
        decision = service._rung_stages(receipt, "decision", only_sequence_one=True)
        sign_off = service._rung_stages(receipt, "sign_off", skip_sequence_one=True)
        assert [row["approver_name"] for row in decision] == ["MAHENDRA"]
        assert [row["approver_name"] for row in sign_off] == ["S Rao"]
        assert decision[0]["sequence"] < sign_off[0]["sequence"]

    def test_a_rejected_rung_keeps_its_refusal(self):
        stages = service._rung_stages(
            [_action(1, 1, ApprovalAction.REJECTED, comments="No")], "approval")
        assert stages[0]["status"] == "REJECTED"
        assert stages[0]["comments"] == "No"

    def test_only_a_live_chain_still_owes_a_decision(self):
        chain = [{"sequence": 1, "role_name": "District Manager",
                  "approver_names": ["D Kumar"]},
                 {"sequence": 2, "role_name": "Regional Manager",
                  "approver_names": ["R Rao"]}]
        live = SimpleNamespace(status=InstanceStatus.IN_PROGRESS.value,
                               current_sequence=2, resolved_chain=chain)
        upcoming = service._upcoming_rungs(live, "approval", signed={1})
        assert [(row["title"], row["is_current"]) for row in upcoming] == [
            ("Regional Manager", True)]

        done = SimpleNamespace(status=InstanceStatus.APPROVED.value,
                               current_sequence=2, resolved_chain=chain)
        # A finished chain owes nothing. Listing its rungs would draw a signature that
        # has already happened as though it were still awaited.
        assert service._upcoming_rungs(done, "approval", signed=set()) == []
        assert service._upcoming_rungs(None, "approval", signed=set()) == []


class TestTheWholeRoad:
    """Every leg is drawn, whether or not anybody has pressed anything in it."""

    def test_a_leg_nothing_has_reached_yet_still_says_so(self):
        stages = service._journey_steps(
            _doc(reason_note="Screen cracked in transit"),
            _phases(draft="completed", submitted="completed", decision="current"),
            events=[], actions=[], receipt_actions=[], field_instance=None,
            receipt_instance=None, decision=None, approver_names=["MAHENDRA"],
            raised_by_position="STORE KEEPER LIP Chilamathur", travels=False,
            landed=False,
        )
        by_leg = {row["stage_type"]: row for row in stages}
        # All eight legs of `PHASES`, and no leg the return does not travel.
        assert set(by_leg) == {"draft", "submission", "decision", "sign_off", "approval",
                               "logistics", "movement", "acknowledgement"}
        # The raise is drawn from the document itself, so a return whose audit rows
        # predate this screen still opens with the step that started it.
        assert by_leg["draft"]["timestamp"] == datetime(2026, 9, 7, 9, 0)
        assert by_leg["draft"]["approver_name"] == "A Anil Kumar"
        assert by_leg["draft"]["comments"] == "Screen cracked in transit"
        # The leg holding the document says who it is waiting on, in its phase's words.
        assert by_leg["decision"]["is_current"] is True
        assert by_leg["decision"]["approver_name"] == "MAHENDRA"
        assert by_leg["decision"]["comments"] == "decision caption"
        # In flow order, never in insertion order.
        assert stages == sorted(stages, key=lambda row: row["sequence"])

    def test_the_movement_is_dated_off_the_press_that_moved_it(self):
        events = service._journey_events(_doc(), [
            _audit(1, _changed(status=ReturnStatus.APPROVED.value, comments="Signed"),
                   minute=5),
        ], rejected_stage_type=None)
        stages = service._journey_steps(
            _doc(), _phases(movement="completed"), events=events, actions=[],
            receipt_actions=[], field_instance=None, receipt_instance=None,
            decision=None, approver_names=[], raised_by_position=None,
            travels=False, landed=True,
        )
        movement = next(row for row in stages if row["stage_type"] == "movement")
        # Nothing travelled, so the stock moved on the final approval — which is already
        # dated in the trail. Nothing is written for this screen's benefit.
        assert movement["timestamp"] == datetime(2026, 9, 7, 10, 5)
        assert movement["quantity_summary"] == "5 across 1 line"
