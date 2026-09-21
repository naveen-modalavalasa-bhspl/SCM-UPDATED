from types import SimpleNamespace

import pytest
from pydantic import ValidationError as PydanticValidationError

from app.core.exceptions import ValidationError
from app.modules.approvals.schemas import ApprovalQuantityIn, IndentRejectionIn
from app.modules.approvals.service import _approval_ceiling, _validated_quantities


def _indent(approved_1=0, approved_2=0):
    return SimpleNamespace(items=[
        SimpleNamespace(id=1, quantity=10, approved_quantity=approved_1,
                        item_name="Gloves", item_code="GLV"),
        SimpleNamespace(id=2, quantity=4, approved_quantity=approved_2,
                        item_name="Masks", item_code="MSK"),
    ])


def test_rejection_reason_is_mandatory():
    with pytest.raises(PydanticValidationError):
        IndentRejectionIn(comments="   ")


def test_approved_quantities_allow_reduction_and_zero():
    result = _validated_quantities(_indent(), [
        ApprovalQuantityIn(line_id=1, approved_quantity=7),
        ApprovalQuantityIn(line_id=2, approved_quantity=0),
    ])
    assert float(result[1]) == 7
    assert float(result[2]) == 0


def test_approved_quantity_cannot_exceed_request():
    with pytest.raises(ValidationError, match="cannot exceed the requested quantity"):
        _validated_quantities(_indent(), [
            ApprovalQuantityIn(line_id=1, approved_quantity=11),
            ApprovalQuantityIn(line_id=2, approved_quantity=4),
        ])


def test_ceiling_message_names_the_item_and_the_limit():
    with pytest.raises(ValidationError, match=r"Gloves.*\(10\)"):
        _validated_quantities(_indent(), [
            ApprovalQuantityIn(line_id=1, approved_quantity=10.5),
            ApprovalQuantityIn(line_id=2, approved_quantity=4),
        ])


def test_later_level_cannot_raise_what_the_level_below_approved():
    indent = _indent(approved_1=6, approved_2=4)
    with pytest.raises(ValidationError, match="previous level"):
        _validated_quantities(indent, [
            ApprovalQuantityIn(line_id=1, approved_quantity=7),
            ApprovalQuantityIn(line_id=2, approved_quantity=4),
        ], True)

    result = _validated_quantities(indent, [
        ApprovalQuantityIn(line_id=1, approved_quantity=6),
        ApprovalQuantityIn(line_id=2, approved_quantity=1),
    ], True)
    assert float(result[1]) == 6
    assert float(result[2]) == 1


def test_ladder_ceiling_walks_down_and_never_back_up():
    line = SimpleNamespace(id=1, quantity=5, approved_quantity=0,
                           item_name="Pepsi", item_code="PEP")
    # First rung: capped by the request. Zero here means "never approved yet".
    assert _approval_ceiling(line, False) == 5
    line.approved_quantity = 3
    # Second rung: capped by what the rung below approved, not by the request.
    assert _approval_ceiling(line, True) == 3
    # A rung that approved nothing leaves nothing for the rung above it.
    line.approved_quantity = 0
    assert _approval_ceiling(line, True) == 0


def test_quantity_is_rounded_down_before_the_ceiling_is_checked():
    """4.9995 must not clear a ceiling of 4.999 and then store as 5.000."""
    indent = SimpleNamespace(items=[
        SimpleNamespace(id=1, quantity=4.999, approved_quantity=0,
                        item_name="Gloves", item_code="GLV"),
    ])
    result = _validated_quantities(indent, [
        ApprovalQuantityIn(line_id=1, approved_quantity=4.9995),
    ])
    assert str(result[1]) == "4.999"


def test_infinite_quantity_is_refused_at_the_wire():
    with pytest.raises(PydanticValidationError):
        ApprovalQuantityIn(line_id=1, approved_quantity=float("inf"))
    with pytest.raises(PydanticValidationError):
        ApprovalQuantityIn(line_id=1, approved_quantity=-1)


def test_every_indent_line_must_be_submitted_once():
    with pytest.raises(ValidationError, match="missing lines"):
        _validated_quantities(_indent(), [
            ApprovalQuantityIn(line_id=1, approved_quantity=5),
        ])


def test_operational_approvals_router_declares_required_routes():
    from app.modules.approvals.router import router

    paths = {route.path for route in router.routes}
    assert "/api/approvals/pending" in paths
    assert "/api/approvals/my-decisions" in paths
    assert "/api/approvals/team-queue" in paths
    assert "/api/approvals/consolidation" in paths


# --------------------------------------------------------------------------- #
# The decision ledger's visibility cut (2026-09-20)
#
# An approver reads the document as it REACHED them and the decision they took on
# it, never the stage above. Both halves are pure functions and are tested here
# without a database, because the failure they exist to stop is silent: every figure
# still renders, and one of them quietly belongs to somebody else.
# --------------------------------------------------------------------------- #
from datetime import datetime

from app.modules.approvals.service import _item_snapshot, _visible_quantity_events


def _change(actor_id, previous, new, at):
    return {
        "audit_id": actor_id, "previous_quantity": previous, "new_quantity": new,
        "delta": new - previous, "reduction": max(previous - new, 0),
        "actor_id": actor_id, "actor_name": f"Actor {actor_id}",
        "changed_at": at, "stage_sequence": None, "stage_name": None,
        "reason": None, "source": "sys_audit_log",
    }


def _line(line_id=1, quantity=10, approved=3):
    return SimpleNamespace(
        id=line_id, item_id=99, item_code="COT", item_name="Absorbent Cotton",
        uom_code="NOS", quantity=quantity, approved_quantity=approved, line_no=1,
        is_excluded=False, excluded_by_name=None, excluded_at=None,
    )


def _approval(actor_id, at):
    return SimpleNamespace(
        id=actor_id, actor_id=actor_id, actor_name=f"Actor {actor_id}",
        action="APPROVED", acted_at=at, stage_sequence=1, stage_name="OE",
        comments=None, actor_position="OE",
    )


def test_a_cut_drops_the_changes_made_after_it():
    history = {1: [
        _change(7702, 10, 5, "2026-09-20T10:38:43"),
        _change(9283, 10, 3, "2026-09-20T11:07:18"),
    ]}
    visible = _visible_quantity_events(history, datetime(2026, 9, 20, 10, 38, 43))
    assert [row["actor_id"] for row in visible[1]] == [7702]
    # No cut is no filtering at all — the auditor and the approver holding it now.
    assert _visible_quantity_events(history, None) == history


def test_a_scoped_reader_never_sees_the_live_approved_quantity():
    """The defect this exists for: the OE approved 10 on a line they never touched,
    the DM later cut it to 3, and the OE's own card reported 3 and called it their
    reduction. `line.approved_quantity` is the rung above's number."""
    action = _approval(7702, datetime(2026, 9, 20, 10, 38, 43))
    snapshot = _item_snapshot(_line(), action=action, user_audit=None,
                              history=[], scoped=True)
    assert snapshot["received_by_approver_quantity"] == 10
    assert snapshot["approved_by_approver_quantity"] == 10
    assert snapshot["final_approved_quantity"] == 10
    assert snapshot["change_quantity"] == 0
    assert snapshot["decision"] == "APPROVED"


def test_a_scoped_reader_still_sees_what_reached_them():
    """A line an EARLIER rung cut: the reader received 5, not the raised 10."""
    action = _approval(9283, datetime(2026, 9, 20, 11, 7, 18))
    history = [_change(7702, 10, 5, "2026-09-20T10:38:43")]
    snapshot = _item_snapshot(_line(approved=5), action=action, user_audit=None,
                              history=history, scoped=True)
    assert snapshot["requested_quantity"] == 10
    assert snapshot["received_by_approver_quantity"] == 5
    assert snapshot["approved_by_approver_quantity"] == 5
    assert snapshot["final_approved_quantity"] == 5


def test_a_full_trail_reader_keeps_the_live_number():
    action = _approval(7702, datetime(2026, 9, 20, 10, 38, 43))
    snapshot = _item_snapshot(_line(), action=action, user_audit=None,
                              history=[], scoped=False)
    assert snapshot["final_approved_quantity"] == 3


# ---------------- The monthly cycle ledger ----------------
#
# Pure halves only, as above: the rules a cycle roll-up is right or wrong by, with
# no database anywhere near them.

from app.modules.approvals.service import (  # noqa: E402
    _cycle_summary, _last_decision, _member_reading, _rollup_decision,
)


def _submission(actor_id, at):
    return SimpleNamespace(
        id=actor_id, actor_id=actor_id, actor_name=f"Actor {actor_id}",
        action="SUBMITTED", acted_at=at, stage_sequence=0, stage_name=None,
        comments=None, actor_position=None,
    )


def test_a_group_nobody_decided_is_waiting_not_approved():
    """`_item_snapshot` fills `received` for a waiting line, so a roll-up that reads
    the quantity as the answer reports a queue as finished."""
    assert _rollup_decision(40, None, 0) == "WAITING"
    assert _rollup_decision(40, 40, 0) == "WAITING"


def test_a_group_is_worded_from_its_numbers():
    assert _rollup_decision(112, 112, 8) == "APPROVED"
    assert _rollup_decision(112, 62, 8) == "PARTIALLY_APPROVED"
    assert _rollup_decision(112, 0, 8) == "DENIED"


def test_submitting_your_own_monthly_indent_is_not_a_decision():
    """A storekeeper who raised the indent is below every rung of its ladder. Count
    the submission and their own document reads as signed by them."""
    at = datetime(2026, 9, 21, 9, 43, 56)
    user = SimpleNamespace(id=7702)
    assert _last_decision([_submission(7702, at)], user) is None
    assert _last_decision([_submission(7702, at), _approval(7702, at)], user) is not None


def test_the_last_decision_wins_when_a_member_came_back():
    """An indent returned for correction and approved again reached this login
    twice. The reading they may have is the LATEST of the two."""
    user = SimpleNamespace(id=7702)
    first = _approval(7702, datetime(2026, 9, 14, 10, 9, 1))
    second = _approval(7702, datetime(2026, 9, 21, 9, 43, 56))
    assert _last_decision([first, second], user) is second


def test_a_member_sitting_with_you_is_read_whole():
    """Nothing has happened to it above this approver yet, so there is nothing to
    hide — and it is NOT counted as signed."""
    user = SimpleNamespace(id=7702)
    pending = [{"approver_id": 7702, "stage_sequence": 2}]
    action, cut = _member_reading(user, [], pending, full_trail=False)
    assert action is None and cut is None


def test_a_member_you_signed_is_cut_at_your_signature():
    user = SimpleNamespace(id=7702)
    at = datetime(2026, 9, 21, 9, 43, 56)
    action, cut = _member_reading(user, [_approval(7702, at)], [], full_trail=False)
    assert action is not None and cut == at


def test_the_auditor_reads_every_member_to_the_end():
    user = SimpleNamespace(id=7702)
    at = datetime(2026, 9, 21, 9, 43, 56)
    action, cut = _member_reading(user, [_approval(7702, at)], [], full_trail=True)
    assert action is not None and cut is None


def test_a_member_that_is_neither_yours_nor_on_your_desk_is_left_out():
    """The scoping that keeps one OE's cycle out of another OE's roll-up: no
    decision and no cut, which is what `cycle_ledger` filters a member out on."""
    user = SimpleNamespace(id=7702)
    other = [_approval(9283, datetime(2026, 9, 21, 9, 43, 56))]
    action, cut = _member_reading(user, other, [], full_trail=False)
    assert action is None and cut is None


def test_the_headline_never_claims_a_cut_that_is_only_a_pending_line():
    """The trap the served summary exists to avoid: `requested` counts every site,
    and printing it against `approved` reports an approver with one site still to
    sign as having cut the difference. The sentence is fed DECIDED requested."""
    whole = _cycle_summary(6, 6, 6, 4, 264, 264, 0)
    assert "all 264 requested units approved" in whole
    assert "cut" not in whole
    part = _cycle_summary(10, 11, 11, 4, 394, 360, 1)
    assert "360 of 394 units approved, 34 cut" in part
    assert "1 still waiting for you" in part


def test_the_headline_says_so_when_nothing_has_been_signed():
    assert _cycle_summary(0, 0, 11, 0, 0, 0, 0).startswith("None of this cycle")
    waiting = _cycle_summary(0, 3, 11, 2, 0, 0, 3)
    assert "3 of the 11 indents" in waiting and "waiting for your decision" in waiting


def test_one_site_is_not_pluralised():
    assert "across 1 site —" in _cycle_summary(1, 1, 1, 1, 10, 10, 0)
