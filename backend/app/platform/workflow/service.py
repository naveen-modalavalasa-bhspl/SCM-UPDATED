"""Workflow endpoint services."""
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.platform.hcm import service as hcm_service
from app.platform.hcm.models import HcmEmployee, HcmPosition, HcmPositionAssignment
from app.platform.rbac import permissions as perms
from app.platform.rbac.models import Role
from app.platform.rbac.service import get_user_permissions
from app.platform.settings.service import write_audit
from app.platform.workflow import engine, ladder
from app.platform.workflow.models import Action, Delegation, Instance, Pending, Stage, StageCondition, Workflow
from app.platform.workflow.schemas import DelegationIn, WorkflowIn
from app.shared.enums import (
    ApprovalAction, ApprovalMode, ApproverType, AuditAction, ConditionLogic,
    ConditionOperator, DocType,
)
from app.shared.models.base import utcnow
from app.shared.time import to_ist


# This policy is deliberately code, not configuration. Configuration may replace the
# approvers, conditions and number of stages; it may never remove the safe business
# path the application falls back to.
DEFAULT_FLOW = [
    {
        "doc_type": DocType.INDENT.value,
        "title": "Indent approval",
        "steps": ["Reporting-manager approval chain", "Send to Inventory"],
        "fallback": "The request climbs the employee's reporting hierarchy.",
    },
    {
        "doc_type": DocType.ALLOCATION.value,
        "title": "Inventory allocation",
        "steps": ["Inventory Executive decides quantity", "Inventory Manager approves"],
        "fallback": "The allocator's reporting manager approves; Admin is last resort.",
    },
    {
        "doc_type": DocType.MR.value,
        "title": "Shortage request",
        "steps": ["Create one MR for the shortage", "Approval makes it Procurement-ready"],
        "fallback": "The creator's reporting manager approves; Admin is last resort.",
    },
]


def _action_out(instance) -> dict:
    return {
        "doc_type": instance.doc_type,
        "doc_id": instance.doc_id,
        "status": instance.status,
        "current_sequence": instance.current_sequence,
        "current_stage_name": instance.current_stage_name,
    }


async def return_document(
    db: AsyncSession, doc_type: str, doc_id: int, comments: str, context: dict, user,
) -> dict:
    _validate_doc_type(doc_type)
    await _require_action_permission(db, doc_type, user)
    instance = await engine.act(
        db, doc_type, doc_id, ApprovalAction.RETURNED.value, user, comments,
        context=context,
    )
    await db.commit()
    return _action_out(instance)


async def delegate(db: AsyncSession, data: DelegationIn, user) -> Delegation:
    if data.valid_to < data.valid_from:
        raise ValidationError("valid_to cannot be before valid_from")
    if data.doc_type:
        _validate_doc_type(data.doc_type)
    to_employee = await hcm_service.get_employee(db, data.to_employee_id)
    if to_employee is None or not to_employee.is_active:
        raise ValidationError("Delegate employee not found or inactive")
    if to_employee.id == user.id:
        raise ValidationError("Cannot delegate to yourself")
    if await _would_create_delegation_cycle(db, user.id, to_employee.id, data.doc_type):
        raise ValidationError("This delegation would create a circular approval route")

    row = Delegation(
        from_employee_id=user.id,
        from_employee_name=user.full_name,
        to_employee_id=to_employee.id,
        to_employee_name=to_employee.full_name,
        doc_type=data.doc_type,
        valid_from=data.valid_from,
        valid_to=data.valid_to,
        reason=data.reason,
        is_active=True,
    )
    db.add(row)
    await db.flush()
    await write_audit(
        db, entity="wf_delegations", entity_id=row.id,
        action=AuditAction.CREATE, actor=user,
        after={
            "from_employee_id": row.from_employee_id,
            "to_employee_id": row.to_employee_id,
            "doc_type": row.doc_type,
            "valid_from": row.valid_from.isoformat(),
            "valid_to": row.valid_to.isoformat(),
        },
    )
    await db.commit()
    await db.refresh(row)
    return row


async def _would_create_delegation_cycle(
    db: AsyncSession, from_employee_id: int, to_employee_id: int, doc_type: str | None,
) -> bool:
    """A delegate must never be able to route an approval back to its source."""
    rows = list((await db.execute(
        select(Delegation).where(Delegation.is_active.is_(True))
    )).scalars().all())
    graph: dict[int, set[int]] = {}
    for row in rows:
        if row.doc_type not in {None, doc_type} and doc_type is not None:
            continue
        graph.setdefault(row.from_employee_id, set()).add(row.to_employee_id)
    graph.setdefault(from_employee_id, set()).add(to_employee_id)
    seen: set[int] = set()
    stack = [to_employee_id]
    while stack:
        employee_id = stack.pop()
        if employee_id == from_employee_id:
            return True
        if employee_id in seen:
            continue
        seen.add(employee_id)
        stack.extend(graph.get(employee_id, ()))
    return False


async def list_delegations(db: AsyncSession, user, scope: str = "mine") -> list[Delegation]:
    """The inbox exposes a person's outgoing and incoming cover arrangements."""
    stmt = select(Delegation)
    if scope == "incoming":
        stmt = stmt.where(Delegation.to_employee_id == user.id)
    elif scope == "team":
        team_ids = await _team_employee_ids(db, user)
        if not team_ids:
            return []
        stmt = stmt.where(
            Delegation.from_employee_id.in_(team_ids)
            | Delegation.to_employee_id.in_(team_ids)
        )
    else:
        stmt = stmt.where(Delegation.from_employee_id == user.id)
    return list((await db.execute(stmt.order_by(Delegation.created_at.desc()))).scalars().all())


async def delegation_options(db: AsyncSession, user) -> list[dict]:
    """Active employees inside the caller's own reporting branch.

    Delegation is personal, but the picker must not double as a company-wide staff
    directory. A caller without an assigned position has no org branch to delegate
    into and therefore gets no options.
    """
    employee_ids = await _team_employee_ids(db, user)
    if not employee_ids:
        return []
    rows = list((await db.execute(
        select(HcmEmployee).where(
            HcmEmployee.is_active.is_(True),
            HcmEmployee.id.in_(employee_ids),
            HcmEmployee.id != user.id,
        ).order_by(HcmEmployee.full_name)
    )).scalars().all())
    return [{"id": row.id, "name": row.full_name} for row in rows]


async def end_delegation(db: AsyncSession, delegation_id: int, user, reason: str | None = None) -> Delegation:
    row = await db.get(Delegation, delegation_id)
    if row is None:
        raise NotFoundError("Delegation not found")
    if row.from_employee_id != user.id:
        from app.core.exceptions import PermissionError_
        raise PermissionError_("Only the original approver can end this delegation")
    if row.is_active:
        row.is_active = False
        await write_audit(
            db, entity="wf_delegations", entity_id=row.id, action=AuditAction.UPDATE,
            actor=user, before={"is_active": True}, after={"is_active": False, "reason": reason},
            summary="Ended approval delegation",
        )
        await db.commit()
        await db.refresh(row)
    return row


async def _team_employee_ids(db: AsyncSession, user) -> set[int]:
    active_position_id = getattr(user, "active_position_id", None)
    if active_position_id is None:
        return set()
    positions = list((await db.execute(
        select(HcmPosition).where(HcmPosition.is_active.is_(True))
    )).scalars().all())
    children: dict[int, set[int]] = {}
    for position in positions:
        if position.parent_position_id is not None:
            children.setdefault(position.parent_position_id, set()).add(position.id)
    descendants: set[int] = set()
    stack = list(children.get(active_position_id, set()))
    while stack:
        position_id = stack.pop()
        if position_id in descendants:
            continue
        descendants.add(position_id)
        stack.extend(children.get(position_id, set()))
    if not descendants:
        return set()
    assignments = list((await db.execute(
        select(HcmPositionAssignment.employee_id).where(
            HcmPositionAssignment.position_id.in_(descendants),
            HcmPositionAssignment.is_active.is_(True),
        )
    )).scalars().all())
    return set(assignments)


async def my_decisions(db: AsyncSession, user) -> list[dict]:
    rows = (await db.execute(
        select(Action, Instance)
        .join(Instance, Instance.id == Action.instance_id)
        .where(
            Action.actor_id == user.id,
            Action.action.in_([
                ApprovalAction.APPROVED.value, ApprovalAction.REJECTED.value,
                ApprovalAction.RETURNED.value,
            ]),
        )
        .order_by(Action.acted_at.desc(), Action.id.desc())
    )).all()
    return [{
        "id": action.id,
        "doc_type": instance.doc_type,
        "doc_id": instance.doc_id,
        "doc_no": instance.doc_no,
        "stage_sequence": action.stage_sequence,
        "stage_name": action.stage_name,
        "decision": action.action,
        "comments": action.comments,
        "decision_at": action.acted_at.isoformat() if action.acted_at else None,
        "requester": instance.started_by_name,
        "workflow_status": instance.status,
    } for action, instance in rows]


def _utc_datetime(value: datetime | None) -> datetime | None:
    """MySQL hands back naive datetimes even for `DateTime(timezone=True)` columns.

    Subtracting one of those from an aware `utcnow()` raises TypeError, which is
    what took the whole Team Queue down for anybody who had a pending row.
    """
    if value is None:
        return None
    return to_ist(value)


async def team_queue(db: AsyncSession, user) -> list[dict]:
    team_ids = await _team_employee_ids(db, user)
    if not team_ids:
        return []
    rows = list((await db.execute(
        select(Pending, HcmEmployee)
        .join(HcmEmployee, HcmEmployee.id == Pending.approver_id)
        .where(Pending.approver_id.in_(team_ids))
        .order_by(Pending.created_at)
    )).all())
    grouped: dict[int, dict] = {}
    now = utcnow()
    for pending, employee in rows:
        result = grouped.setdefault(employee.id, {
            "approver_id": employee.id,
            "approver_name": employee.full_name,
            "pending_count": 0,
            "overdue_count": 0,
            "oldest_waiting_since": None,
            "average_waiting_hours": 0,
            "document_types": set(),
            "_waiting_hours": [],
        })
        result["pending_count"] += 1
        result["document_types"].add(pending.doc_type)
        due_at = _utc_datetime(pending.due_at)
        created_at = _utc_datetime(pending.created_at)
        if due_at and due_at < now:
            result["overdue_count"] += 1
        if result["oldest_waiting_since"] is None or created_at < result["oldest_waiting_since"]:
            result["oldest_waiting_since"] = created_at
        result["_waiting_hours"].append(round((now - created_at).total_seconds() / 3600, 1))
    output = []
    for result in grouped.values():
        waits = result.pop("_waiting_hours")
        result["average_waiting_hours"] = round(sum(waits) / len(waits), 1) if waits else 0
        result["document_types"] = sorted(result["document_types"])
        result["oldest_waiting_since"] = (
            result["oldest_waiting_since"].isoformat() if result["oldest_waiting_since"] else None
        )
        output.append(result)
    return sorted(output, key=lambda item: (-item["overdue_count"], -item["pending_count"]))


def _condition_out(row: StageCondition) -> dict:
    return {
        "id": row.id,
        "field_name": row.field_name,
        "operator": row.operator,
        "field_value": row.field_value,
        "logic": row.logic,
    }


async def _workflow_out(db: AsyncSession, workflow: Workflow) -> dict:
    stages = list((await db.execute(
        select(Stage).where(Stage.workflow_id == workflow.id).order_by(Stage.sequence)
    )).scalars().all())
    condition_rows = list((await db.execute(
        select(StageCondition)
        .where(StageCondition.stage_id.in_([stage.id for stage in stages] or [-1]))
        .order_by(StageCondition.id)
    )).scalars().all())
    conditions: dict[int, list[dict]] = {}
    for row in condition_rows:
        conditions.setdefault(row.stage_id, []).append(_condition_out(row))
    return {
        "id": workflow.id,
        "code": workflow.code,
        "name": workflow.name,
        "doc_type": workflow.doc_type,
        "version": workflow.version,
        "is_active": workflow.is_active,
        "effective_from": workflow.effective_from,
        "effective_to": workflow.effective_to,
        "created_at": workflow.created_at,
        "is_fallback": workflow.code.startswith("WF-FALLBACK-"),
        "stages": [{
            "id": stage.id,
            "sequence": stage.sequence,
            "name": stage.name,
            "approver_type": stage.approver_type,
            "position_id": stage.position_id,
            "role_id": stage.role_id,
            "employee_id": stage.employee_id,
            "approval_mode": stage.approval_mode,
            "is_optional": stage.is_optional,
            "can_edit_document": stage.can_edit_document,
            "sla_hours": stage.sla_hours,
            "conditions": conditions.get(stage.id, []),
        } for stage in stages],
    }


async def list_workflows(db: AsyncSession) -> dict:
    rows = list((await db.execute(
        select(Workflow).order_by(Workflow.doc_type, Workflow.is_active.desc(),
                                  Workflow.version.desc(), Workflow.id.desc())
    )).scalars().all())
    return {"items": [await _workflow_out(db, row) for row in rows], "total": len(rows)}


async def get_workflow(db: AsyncSession, workflow_id: int) -> dict:
    workflow = await db.get(Workflow, workflow_id)
    if workflow is None:
        raise NotFoundError("Workflow not found")
    return await _workflow_out(db, workflow)


def _validate_workflow(data: WorkflowIn) -> None:
    _validate_doc_type(data.doc_type)
    if not data.code.strip() or not data.name.strip():
        raise ValidationError("Workflow code and name are required")
    if not data.stages:
        raise ValidationError("A workflow needs at least one approval stage")
    sequences = [stage.sequence for stage in data.stages]
    if len(sequences) != len(set(sequences)):
        raise ValidationError("Stage sequence numbers must be unique")
    approver_types = {value.value for value in ApproverType}
    approval_modes = {value.value for value in ApprovalMode}
    operators = {value.value for value in ConditionOperator}
    logics = {value.value for value in ConditionLogic}
    for stage in data.stages:
        if not stage.name.strip():
            raise ValidationError("Every stage needs a name")
        if stage.approver_type not in approver_types:
            raise ValidationError(f"Unknown approver type: {stage.approver_type}")
        if stage.approval_mode not in approval_modes:
            raise ValidationError(f"Unknown approval mode: {stage.approval_mode}")
        required_id = {
            ApproverType.POSITION.value: stage.position_id,
            ApproverType.ROLE.value: stage.role_id,
            ApproverType.SPECIFIC_USER.value: stage.employee_id,
        }.get(stage.approver_type, True)
        if required_id is None:
            raise ValidationError(
                f"{stage.name} needs a {stage.approver_type.lower().replace('_', ' ')}"
            )
        for condition in stage.conditions:
            if condition.operator not in operators or condition.logic not in logics:
                raise ValidationError("Unknown workflow condition operator or join")


async def _materialize_definition(
    db: AsyncSession, data: WorkflowIn, user, version: int,
) -> Workflow:
    workflow = Workflow(
        code=data.code.strip().upper(),
        name=data.name.strip(),
        doc_type=data.doc_type,
        version=version,
        is_active=data.is_active,
        effective_from=utcnow().date(),
        created_by_id=user.id,
    )
    db.add(workflow)
    await db.flush()
    for stage_data in sorted(data.stages, key=lambda item: item.sequence):
        stage = Stage(
            workflow_id=workflow.id,
            sequence=stage_data.sequence,
            name=stage_data.name.strip(),
            approver_type=stage_data.approver_type,
            position_id=stage_data.position_id,
            role_id=stage_data.role_id,
            employee_id=stage_data.employee_id,
            approval_mode=stage_data.approval_mode,
            is_optional=stage_data.is_optional,
            can_edit_document=stage_data.can_edit_document,
            sla_hours=stage_data.sla_hours,
        )
        db.add(stage)
        await db.flush()
        for condition in stage_data.conditions:
            db.add(StageCondition(
                stage_id=stage.id,
                field_name=condition.field_name.strip(),
                operator=condition.operator,
                field_value=condition.field_value,
                logic=condition.logic,
            ))
    await db.flush()
    return workflow


async def save_workflow(
    db: AsyncSession, data: WorkflowIn, user, workflow_id: int | None = None,
) -> dict:
    """Create a new immutable definition version.

    Running instances keep their pinned workflow_id. Editing never mutates the stages
    underneath a document already awaiting approval.
    """
    _validate_workflow(data)
    old = await db.get(Workflow, workflow_id) if workflow_id is not None else None
    if workflow_id is not None and old is None:
        raise NotFoundError("Workflow not found")

    if data.is_active:
        # Company-wide definitions only. Project ladders (Settings > Approvals Config)
        # are scoped to a project and must not be retired by a save on this screen.
        active = list((await db.execute(
            select(Workflow).where(
                Workflow.doc_type == data.doc_type,
                Workflow.project_id.is_(None),
                Workflow.is_active.is_(True),
            )
        )).scalars().all())
        for row in active:
            row.is_active = False
            row.effective_to = utcnow().date()
    if old is not None:
        old.is_active = False
        old.effective_to = utcnow().date()

    version = int(await db.scalar(
        select(func.coalesce(func.max(Workflow.version), 0)).where(
            Workflow.code == data.code.strip().upper()
        )
    ) or 0) + 1
    workflow = await _materialize_definition(db, data, user, version)
    await write_audit(
        db,
        entity="wf_workflows",
        entity_id=workflow.id,
        entity_no=workflow.code,
        action=AuditAction.CREATE if old is None else AuditAction.UPDATE,
        actor=user,
        before={"workflow_id": old.id, "version": old.version} if old else None,
        after={
            "doc_type": workflow.doc_type,
            "version": workflow.version,
            "stages": len(data.stages),
            "is_active": workflow.is_active,
        },
        summary=f"Saved approval workflow {workflow.name}",
    )
    await db.commit()
    return await _workflow_out(db, workflow)


async def deactivate_workflow(db: AsyncSession, workflow_id: int, user) -> dict:
    workflow = await db.get(Workflow, workflow_id)
    if workflow is None:
        raise NotFoundError("Workflow not found")
    workflow.is_active = False
    workflow.effective_to = utcnow().date()
    await write_audit(
        db, entity="wf_workflows", entity_id=workflow.id,
        entity_no=workflow.code, action=AuditAction.UPDATE, actor=user,
        before={"is_active": True}, after={"is_active": False},
        summary=f"Turned off approval workflow {workflow.name}",
    )
    await db.commit()
    return {"success": True, "id": workflow.id, "is_active": False}


async def workflow_options(db: AsyncSession) -> dict:
    positions = list((await db.execute(
        select(HcmPosition).where(HcmPosition.is_active.is_(True))
        .order_by(HcmPosition.name)
    )).scalars().all())
    roles = list((await db.execute(
        select(Role).where(Role.is_active.is_(True)).order_by(Role.name)
    )).scalars().all())
    employees = list((await db.execute(
        select(HcmEmployee).where(HcmEmployee.is_active.is_(True))
        .order_by(HcmEmployee.full_name)
    )).scalars().all())
    return {
        # The types the engine actually READS a workflow for, not every enum value.
        #
        # This used to be `[v.value for v in DocType]`, which offered the Workflows
        # screen two types nothing ever starts an instance with: ISSUE (the legacy
        # value superseded by WH_ISSUE) and QUOTATION (a vendor's document; nobody
        # inside the company approves one). A workflow saved against either was
        # written, never read, and the document silently fell through to the
        # reporting-line fallback — the exact trap `ladder.MODULE_BY_DOC_TYPE`
        # already documents for ISSUE.
        #
        # `_validate_doc_type` still accepts every enum value, so no existing row and
        # no API call breaks; only the picker narrows.
        "doc_types": ladder.configurable_doc_types(),
        "approver_types": [value.value for value in ApproverType],
        "approval_modes": [value.value for value in ApprovalMode],
        "operators": [value.value for value in ConditionOperator],
        "positions": [{"id": row.id, "name": row.name} for row in positions],
        "roles": [{"id": row.id, "name": row.name} for row in roles],
        "employees": [{"id": row.id, "name": row.full_name} for row in employees],
        "default_flow": DEFAULT_FLOW,
    }


def _validate_doc_type(doc_type: str) -> None:
    if doc_type not in {d.value for d in DocType}:
        raise ValidationError(
            "doc_type must be one of " + ", ".join(d.value for d in DocType)
        )


# Which permission lets you send a document back for correction — one per document
# type that the engine can actually be asked to act on.
#
# A module-level constant, not a dict literal built inside the function. As a literal
# it referenced `perms.ISSUE_APPROVE`, which does not exist, so every call raised
# AttributeError before it could index anything: "Return for correction" 500'd for
# EVERY document type, not just that one. At module level a bad name fails at import,
# where it is impossible to miss.
#
# Deliberately not exhaustive over DocType: QUOTATION is a vendor's document that
# nobody inside the company approves, and ISSUE is the legacy value nothing starts a
# workflow with (see ladder.MODULE_BY_DOC_TYPE). Both fall through to the fail-closed
# branch below rather than being given a permission that implies they are actionable.
RETURN_PERMISSION_BY_DOC_TYPE: dict[str, str] = {
    DocType.INDENT.value: perms.INDENT_APPROVE,
    # Same document, same signatures, therefore the same code: a monthly indent is an
    # indent raised on the cycle, and whoever may send one back may send back the
    # other. A configurable type missing from this map is not "no rule" — it is a 403
    # on a button the approvals screen has already drawn (`_require_action_permission`
    # fails closed), which is what `test_every_configurable_type_can_be_returned`
    # exists to catch.
    DocType.MONTHLY_INDENT.value: perms.INDENT_APPROVE,
    # Both of these were configurable on Approvals Config and absent here since the day
    # they were added, so a bin-to-bin movement and an outward QC could be approved and
    # never returned for correction. Each takes its OWN approve code rather than
    # borrowing a neighbour's — returning a document is a decision on that document.
    DocType.STOCK_MOVEMENT_ORDER.value: perms.MOVEMENT_APPROVE,
    DocType.QC_OUTWARD.value: perms.QC_OUTWARD_APPROVE,
    DocType.ALLOCATION.value: perms.ALLOCATION_APPROVE,
    DocType.OWN_STOCK_ALLOCATION.value: perms.ALLOCATION_APPROVE,
    # The issue family shares `issue.issue`: the same people move stock out of a
    # point whether they own it, are forwarding it, or are working the ordinary queue.
    DocType.OWN_STOCK_ISSUE.value: perms.ISSUE_ISSUE,
    DocType.FORWARD_ISSUE.value: perms.ISSUE_ISSUE,
    DocType.WH_ISSUE.value: perms.ISSUE_ISSUE,
    DocType.MR.value: perms.MR_APPROVE,
    DocType.REQUISITION.value: perms.REQUISITION_APPROVE,
    DocType.CONSOLIDATION.value: perms.CONSOLIDATION_APPROVE,
    DocType.RFQ.value: perms.RFQ_APPROVE,
    DocType.PO.value: perms.PO_APPROVE,
    DocType.GRN.value: perms.GRN_QC,
    DocType.DISPATCH.value: perms.DISPATCH_APPROVE,
    DocType.STOCK_TRANSFER.value: perms.STOCK_TRANSFER_APPROVE,
    # All three returns share `return.approve` — the code is one resource used by
    # both the purchase and the stock-return chains.
    DocType.PURCHASE_RETURN.value: perms.RETURN_APPROVE,
    DocType.STOCK_RETURN.value: perms.RETURN_APPROVE,
    DocType.STOCK_RETURN_RECEIPT.value: perms.RETURN_APPROVE,
    DocType.TRANSPORT_REQUEST.value: perms.TRANSPORT_APPROVE,
    DocType.CARRIER_AWARD.value: perms.TRANSPORT_APPROVE,
}


async def _require_action_permission(db: AsyncSession, doc_type: str, user) -> None:
    from app.core.exceptions import PermissionError_

    required = RETURN_PERMISSION_BY_DOC_TYPE.get(doc_type)
    if required is None:
        # Fail closed. A KeyError here was a 500 that read as a broken server rather
        # than as a refusal, and it is a refusal: nothing sends this type back.
        raise PermissionError_(
            f"{doc_type} documents cannot be returned for correction")

    permissions = await get_user_permissions(
        db, user, getattr(user, "active_position_id", None),
    )
    if required not in permissions:
        raise PermissionError_(f"Missing permission: {required}")
