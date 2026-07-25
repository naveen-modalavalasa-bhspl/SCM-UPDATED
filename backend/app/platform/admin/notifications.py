"""Notification settings: who is told when an event or workflow stage is reached.

This module decides recipients only. Actually delivering a message is a separate
concern and is not built yet, so `recipients_for` is the seam a delivery worker will
call once it exists.
"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.platform.admin import groups as group_service
from app.platform.hcm.models import HcmEmployee, HcmPositionAssignment
from app.platform.rbac.models import Role, UserGroup, UserRole
from app.platform.settings.models import NotificationRule
from app.platform.settings.service import write_audit
from app.shared.enums import (
    AuditAction, NotificationChannel, RecipientType,
)


def rule_out(r: NotificationRule) -> dict:
    return {"id": r.id, "event_code": r.event_code, "stage": r.stage,
            "recipient_type": r.recipient_type, "recipient_id": r.recipient_id,
            "recipient_name": r.recipient_name, "channel": r.channel,
            "template": r.template, "is_active": r.is_active}


async def _resolve_recipient_name(db: AsyncSession, recipient_type: str,
                                  recipient_id: int | None) -> str | None:
    """Snapshot the recipient's name so the settings list renders without four joins.

    Returning None means "no such recipient", which is what makes _validate reject it.
    """
    if recipient_id is None:
        return None

    if recipient_type == RecipientType.POSITION.value:
        # Positions are mirrored from HCM and have no local table; the assignment rows
        # carry the name, so any one of them answers the question.
        return (await db.execute(
            select(HcmPositionAssignment.position_name)
            .where(HcmPositionAssignment.position_id == recipient_id).limit(1)
        )).scalar_one_or_none()

    by_type = {
        RecipientType.ROLE.value: (Role, "name"),
        RecipientType.GROUP.value: (UserGroup, "name"),
        RecipientType.EMPLOYEE.value: (HcmEmployee, "full_name"),
    }
    if recipient_type not in by_type:
        return None
    model, attr = by_type[recipient_type]
    row = await db.get(model, recipient_id)
    return getattr(row, attr) if row else None


async def _validate(db: AsyncSession, data) -> str | None:
    if data.recipient_type not in {t.value for t in RecipientType}:
        raise ValidationError(
            f"recipient_type must be one of "
            f"{', '.join(t.value for t in RecipientType)}")
    if data.channel not in {c.value for c in NotificationChannel}:
        raise ValidationError(
            f"channel must be one of {', '.join(c.value for c in NotificationChannel)}")
    if data.recipient_id is None:
        raise ValidationError("recipient_id is required")
    name = await _resolve_recipient_name(db, data.recipient_type, data.recipient_id)
    if name is None:
        raise ValidationError(
            f"No {data.recipient_type.lower()} with id {data.recipient_id}")
    return name


async def list_rules(db: AsyncSession, event_code: str | None = None) -> dict:
    stmt = select(NotificationRule)
    if event_code:
        stmt = stmt.where(NotificationRule.event_code == event_code)
    rows = (await db.execute(
        stmt.order_by(NotificationRule.event_code, NotificationRule.id)
    )).scalars().all()
    return {"items": [rule_out(r) for r in rows]}


async def create_rule(db: AsyncSession, data, actor) -> dict:
    name = await _validate(db, data)
    row = NotificationRule(**data.model_dump(), recipient_name=name)
    db.add(row)
    await db.flush()
    await write_audit(db, entity="sys_notification_rules", entity_id=row.id,
                      action=AuditAction.CREATE, actor=actor, after=rule_out(row))
    await db.commit()
    await db.refresh(row)
    return rule_out(row)


async def update_rule(db: AsyncSession, rule_id: int, data, actor) -> dict:
    row = await db.get(NotificationRule, rule_id)
    if row is None:
        raise NotFoundError("Notification rule not found")
    name = await _validate(db, data)
    before = rule_out(row)
    for key, value in data.model_dump().items():
        setattr(row, key, value)
    row.recipient_name = name
    await db.flush()
    await write_audit(db, entity="sys_notification_rules", entity_id=row.id,
                      action=AuditAction.UPDATE, actor=actor,
                      before=before, after=rule_out(row))
    await db.commit()
    await db.refresh(row)
    return rule_out(row)


async def delete_rule(db: AsyncSession, rule_id: int, actor) -> dict:
    row = await db.get(NotificationRule, rule_id)
    if row is None:
        raise NotFoundError("Notification rule not found")
    row.is_active = False
    await db.flush()
    await write_audit(db, entity="sys_notification_rules", entity_id=rule_id,
                      action=AuditAction.DEACTIVATE, actor=actor)
    await db.commit()
    return {"success": True, "id": rule_id, "is_active": False}


async def recipients_for(db: AsyncSession, event_code: str,
                         stage: str | None = None) -> set[int]:
    """Employee ids to notify for an event. A rule with no stage covers every stage."""
    rows = (await db.execute(
        select(NotificationRule).where(NotificationRule.event_code == event_code,
                                       NotificationRule.is_active.is_(True))
    )).scalars().all()

    recipients: set[int] = set()
    for rule in rows:
        if rule.stage and stage and rule.stage != stage:
            continue
        recipients |= await _expand(db, rule)
    return recipients


async def _expand(db: AsyncSession, rule: NotificationRule) -> set[int]:
    if rule.recipient_type == RecipientType.EMPLOYEE.value:
        return {rule.recipient_id}
    if rule.recipient_type == RecipientType.ROLE.value:
        rows = await db.execute(
            select(UserRole.employee_id).where(UserRole.role_id == rule.recipient_id))
        return set(rows.scalars().all())
    if rule.recipient_type == RecipientType.POSITION.value:
        rows = await db.execute(
            select(HcmPositionAssignment.employee_id).where(
                HcmPositionAssignment.position_id == rule.recipient_id,
                HcmPositionAssignment.is_active.is_(True)))
        return set(rows.scalars().all())
    if rule.recipient_type == RecipientType.GROUP.value:
        return await group_service.resolve_member_ids(db, rule.recipient_id)
    return set()
