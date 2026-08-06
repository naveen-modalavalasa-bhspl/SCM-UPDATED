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
