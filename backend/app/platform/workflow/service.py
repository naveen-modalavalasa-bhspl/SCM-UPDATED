"""Workflow endpoint services."""
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationError
from app.platform.hcm import service as hcm_service
from app.platform.rbac import permissions as perms
from app.platform.rbac.service import get_user_permissions
from app.platform.settings.service import write_audit
from app.platform.workflow import engine
from app.platform.workflow.models import Delegation
from app.platform.workflow.schemas import DelegationIn
from app.shared.enums import ApprovalAction, AuditAction, DocType


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


def _validate_doc_type(doc_type: str) -> None:
    if doc_type not in {d.value for d in DocType}:
        raise ValidationError(
            "doc_type must be one of " + ", ".join(d.value for d in DocType)
        )


async def _require_action_permission(db: AsyncSession, doc_type: str, user) -> None:
    required = {
        DocType.INDENT.value: perms.INDENT_APPROVE,
        DocType.ALLOCATION.value: perms.ALLOCATION_APPROVE,
        DocType.MR.value: perms.MR_APPROVE,
        DocType.PO.value: perms.PO_APPROVE,
        DocType.GRN.value: perms.GRN_QC,
        DocType.ISSUE.value: perms.ISSUE_ISSUE,
    }[doc_type]
    permissions = await get_user_permissions(
        db, user, getattr(user, "active_position_id", None),
    )
    if required not in permissions:
        from app.core.exceptions import PermissionError_

        raise PermissionError_(f"Missing permission: {required}")
