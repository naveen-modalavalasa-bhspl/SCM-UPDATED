from types import SimpleNamespace

import pytest
from pydantic import ValidationError as PydanticValidationError

from app.core.exceptions import ValidationError
from app.modules.approvals.schemas import ApprovalQuantityIn, IndentRejectionIn
from app.modules.approvals.service import _validated_quantities


def _indent():
    return SimpleNamespace(items=[
        SimpleNamespace(id=1, quantity=10, item_name="Gloves", item_code="GLV"),
        SimpleNamespace(id=2, quantity=4, item_name="Masks", item_code="MSK"),
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
    with pytest.raises(ValidationError, match="cannot exceed"):
        _validated_quantities(_indent(), [
            ApprovalQuantityIn(line_id=1, approved_quantity=11),
            ApprovalQuantityIn(line_id=2, approved_quantity=4),
        ])


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
