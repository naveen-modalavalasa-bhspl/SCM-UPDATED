"""SCM_0078: Correction never offered on a classic (stage-based) workflow indent.

`wf_instances.resolved_chain` is only ever frozen by a ladder-routed submit
(`platform/workflow/engine.py`) — an indent on the old stage-based workflow
(`workflow_id = 1`, like indents 206/207 on QA) carries `resolved_chain = NULL`
forever. `_active_position_matches_return_task` read that as "no ladder link for
this stage" and refused every pending approver, on every classic-workflow indent,
company-wide — Correction simply never appeared for OE/DM/RM/SPH.

The fix: no `resolved_chain` at all means there is no ladder to disambiguate a
rank from a position, and the pending-approval row already proved this user is
the approver at the CURRENT stage — which is the whole question on that kind of
workflow. See `app/modules/indents/service.py::_active_position_matches_return_task`.
"""
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

from app.modules.indents import service
from app.modules.indents.models import Indent
from app.platform.workflow.models import Instance, Pending
from app.shared.enums import IndentStatus, InstanceStatus


async def _pending_indent(db, *, requested_by_id: int, approver_id: int,
                          resolved_chain) -> tuple[Indent, Instance]:
    indent = Indent(
        indent_no=f"IND-{approver_id}-{resolved_chain is None}",
        indent_date=date.today(),
        requested_by_id=requested_by_id,
        requested_by_name="Raiser",
        status=IndentStatus.PENDING_APPROVAL.value,
        total_items=0,
        total_qty=Decimal("0"),
    )
    db.add(indent)
    await db.flush()

    instance = Instance(
        doc_type="INDENT", doc_id=indent.id, workflow_id=1,
        resolved_chain=resolved_chain, current_sequence=1,
        status=InstanceStatus.IN_PROGRESS.value,
    )
    db.add(instance)
    await db.flush()

    db.add(Pending(
        instance_id=instance.id, stage_sequence=1, approver_id=approver_id,
        doc_type="INDENT", doc_id=indent.id,
    ))
    await db.commit()
    return indent, instance


async def test_classic_workflow_pending_approver_can_return_for_correction(db):
    """No `resolved_chain` (classic workflow): the pending row alone is enough."""
    indent, _ = await _pending_indent(
        db, requested_by_id=77, approver_id=501, resolved_chain=None)
    approver = SimpleNamespace(id=501, active_position_id=None)

    allowed = await service.can_return_indent_for_correction(
        db, indent, approver, user_perms={"indent.approve"})

    assert allowed is True


async def test_classic_workflow_refuses_someone_not_pending(db):
    indent, _ = await _pending_indent(
        db, requested_by_id=77, approver_id=501, resolved_chain=None)
    stranger = SimpleNamespace(id=999, active_position_id=None)

    allowed = await service.can_return_indent_for_correction(
        db, indent, stranger, user_perms={"indent.approve"})

    assert allowed is False
