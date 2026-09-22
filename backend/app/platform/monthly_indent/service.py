"""Monthly indent cycle calculation and notification dispatch."""
from __future__ import annotations

import calendar
import re
from dataclasses import dataclass
from datetime import date, datetime, time
from zoneinfo import ZoneInfo

from sqlalchemy import desc, exists, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.modules.indents.enums import IndentStatus, IndentType
from app.modules.indents.models import Indent
from app.platform.hcm.models import (
    HcmEmployee, HcmPosition, HcmPositionAssignment, HcmRole,
)
from app.platform.monthly_indent.models import (
    MonthlyIndentNotificationLog, MonthlyIndentNotificationRule, MonthlyIndentSetting,
)
from app.platform.monthly_indent.schemas import MonthlyIndentCycle, MonthlyIndentRuleIn
from app.platform.notifications import service as notification_service
from app.platform.settings.service import write_audit
from app.platform.workflow.models import Instance, Pending
from app.shared.enums import AuditAction, DocType, InstanceStatus
from app.shared.models.base import utcnow

VARIABLES = {
    "employee_name", "role", "month", "cycle_start", "cycle_end",
    "pending_since", "approval_level",
}
#: The ladder a monthly indent climbs when the site has switched on a chain of its
#: own. Read off the enum rather than spelled again here: this constant and
#: `ladder.DOC_TYPE_LABEL` naming the same document by two independent strings is
#: precisely how the 422 on Settings > Monthly Indent came about.
MONTHLY_INDENT_LADDER_DOC_TYPE = DocType.MONTHLY_INDENT.value


@dataclass(frozen=True)
class CycleWindow:
    start: date
    end: date
    key: str
    timezone: str
    #: The first of the month these indents are FOR. Defaults to the opening month,
    #: and is never a date the window is measured against — only what it is called.
    serves: date


@dataclass(frozen=True)
class Candidate:
    employee_id: int
    employee_name: str
    role: str | None = None
    pending_since: datetime | None = None
    approval_level: str | None = None


def _add_months(value: date, months: int) -> date:
    month = value.month - 1 + months
    year = value.year + month // 12
    month = month % 12 + 1
    day = min(value.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def _clamped_day(year: int, month: int, day: int) -> date:
    return date(year, month, min(day, calendar.monthrange(year, month)[1]))


def cycle_span_months(cycle: MonthlyIndentCycle) -> int:
    """How many months after the opening month the window closes in.

    `end_month_offset` states it outright. Zero keeps the one shorthand that existed
    before the column did — a closing day EARLIER than the opening day means the next
    month — so a cycle configured as 26 -> 5 still resolves to the window it always
    resolved to, without anybody editing it.
    """
    if cycle.end_month_offset:
        return cycle.end_month_offset
    return 1 if cycle.end_day < cycle.start_day else 0


def calculate_cycle(cycle: MonthlyIndentCycle, reference: datetime | None = None) -> CycleWindow:
    """Resolve the configured cycle using the company's timezone.

    The window is two independent decisions — a day, and which month that day is in —
    on each end, so it may be any length from one day to just over a year. "The 1st of
    this month to the 31st of next" is `start_day=1, end_month_offset=1, end_day=31`.

    Days above the month's length are clamped, so an end day of 31 means "last day"
    for February, leap years included.
    """
    tz = ZoneInfo(cycle.timezone)
    local_now = (reference or datetime.now(tz))
    if local_now.tzinfo is None:
        local_now = local_now.replace(tzinfo=tz)
    local_now = local_now.astimezone(tz)
    anchor = _add_months(local_now.date().replace(day=1), cycle.cycle_month_offset)
    start = _clamped_day(anchor.year, anchor.month, cycle.start_day)
    end_anchor = _add_months(anchor, cycle_span_months(cycle))
    end = _clamped_day(end_anchor.year, end_anchor.month, cycle.end_day)
    if end < start:
        raise ValidationError("Cycle end must be on or after cycle start")
    serves = _add_months(anchor, cycle.serves_month_offset)
    return CycleWindow(start=start, end=end, key=f"{start.isoformat()}_{end.isoformat()}",
                       timezone=cycle.timezone, serves=serves)


def render_template(template: str, values: dict[str, object]) -> str:
    def repl(match):
        key = match.group(1).strip()
        return str(values.get(key, ""))
    return re.sub(r"{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}", repl, template)


async def _setting_row(db: AsyncSession) -> MonthlyIndentSetting | None:
    return (await db.execute(
        select(MonthlyIndentSetting).order_by(MonthlyIndentSetting.id).limit(1)
    )).scalar_one_or_none()


async def get_cycle_settings(db: AsyncSession) -> MonthlyIndentCycle:
    row = await _setting_row(db)
    if row is None:
        return MonthlyIndentCycle()
    return MonthlyIndentCycle(
        is_enabled=row.is_enabled,
        approval_flow_enabled=row.approval_flow_enabled,
        cycle_month_offset=row.cycle_month_offset,
        start_day=row.start_day,
        end_month_offset=row.end_month_offset,
        end_day=row.end_day,
        serves_month_offset=row.serves_month_offset,
        timezone=row.timezone,
        scheduler_enabled=row.scheduler_enabled,
        scheduler_interval_minutes=row.scheduler_interval_minutes,
    )


async def update_cycle_settings(db: AsyncSession, data: MonthlyIndentCycle, actor) -> dict:
    calculate_cycle(data)
    row = await _setting_row(db)
    before = (await get_cycle_settings(db)).model_dump()
    if row is None:
        row = MonthlyIndentSetting()
        db.add(row)
    for key, value in data.model_dump().items():
        setattr(row, key, value)
    row.updated_by_id = getattr(actor, "id", None)
    await db.flush()
    after = (await get_cycle_settings(db)).model_dump()
    await write_audit(
        db, entity="mi_settings", entity_id=row.id, action=AuditAction.UPDATE,
        actor=actor, before=before, after=after,
        summary="Monthly indent cycle updated",
    )
    await db.commit()
    return await overview(db)


def _cycle_out(cycle: MonthlyIndentCycle) -> dict:
    window = calculate_cycle(cycle)
    return {**cycle.model_dump(), "cycle_start": window.start,
            "cycle_end": window.end, "cycle_key": window.key,
            "serves_start": window.serves,
            "serves_month": window.serves.strftime("%B %Y")}


async def custom_approval_flow_enabled(db: AsyncSession) -> bool:
    return (await get_cycle_settings(db)).approval_flow_enabled


def _rule_out(row: MonthlyIndentNotificationRule) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "is_active": row.is_active,
        "trigger_day": row.trigger_day,
        "trigger_time": row.trigger_time,
        "target_type": row.target_type,
        "target_ref_id": row.target_ref_id,
        "target_name": row.target_name,
        "condition": row.condition,
        "message_template": row.message_template,
        "escalation_enabled": row.escalation_enabled,
        "escalation_day": row.escalation_day,
        "escalation_time": row.escalation_time,
        "escalation_target_type": row.escalation_target_type,
        "escalation_target_ref_id": row.escalation_target_ref_id,
        "escalation_target_name": row.escalation_target_name,
        "escalation_message_template": row.escalation_message_template,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


def _log_out(row: MonthlyIndentNotificationLog) -> dict:
    return {
        "id": row.id, "rule_id": row.rule_id, "cycle_key": row.cycle_key,
        "kind": row.kind, "target_employee_id": row.target_employee_id,
        "target_employee_name": row.target_employee_name,
        "recipient_employee_id": row.recipient_employee_id,
        "recipient_employee_name": row.recipient_employee_name,
        "status": row.status, "reason": row.reason, "title": row.title,
        "message": row.message, "sent_at": row.sent_at,
    }


async def list_rules(db: AsyncSession) -> list[dict]:
    rows = (await db.execute(
        select(MonthlyIndentNotificationRule)
        .order_by(MonthlyIndentNotificationRule.trigger_day,
                  MonthlyIndentNotificationRule.trigger_time,
                  MonthlyIndentNotificationRule.id)
    )).scalars().all()
    return [_rule_out(row) for row in rows]


async def list_logs(db: AsyncSession, limit: int = 50) -> list[dict]:
    rows = (await db.execute(
        select(MonthlyIndentNotificationLog)
        .order_by(desc(MonthlyIndentNotificationLog.sent_at))
        .limit(limit)
    )).scalars().all()
    return [_log_out(row) for row in rows]


async def overview(db: AsyncSession) -> dict:
    cycle = await get_cycle_settings(db)
    return {"cycle": _cycle_out(cycle), "rules": await list_rules(db),
            "logs": await list_logs(db)}


async def _target_name(db: AsyncSession, target_type: str, ref_id: int | None) -> str | None:
    # REPORTING_MANAGER is checked BEFORE the "no id, no name" guard, and is the one
    # target that means something without one: the manager is found at send time by
    # climbing the raiser's own reporting line, so there is no row to name here. The
    # guard used to run first, which made its `ref_id is None` arm unreachable — and
    # since REPORTING_MANAGER is the escalation the screen offers by default and sends
    # with no id, every reminder that escalated to a manager was refused with
    # "Escalation recipient could not be resolved".
    if target_type == "REPORTING_MANAGER" and ref_id is None:
        return "Reporting manager"
    if ref_id is None:
        return None
    if target_type == "HCM_ROLE":
        row = await db.get(HcmRole, ref_id)
        if row:
            return row.name
        return (await db.execute(
            select(HcmPosition.role_name)
            .where(HcmPosition.role_id == ref_id, HcmPosition.role_name.is_not(None))
            .limit(1)
        )).scalar_one_or_none()
    if target_type == "POSITION":
        row = await db.get(HcmPosition, ref_id)
        return row.name if row else None
    if target_type == "EMPLOYEE":
        row = await db.get(HcmEmployee, ref_id)
        return row.full_name if row else None
    if target_type == "REPORTING_MANAGER":
        # With an id it is "climb until you reach somebody of THIS rank", so the name
        # to record is the rank's.
        return await _target_name(db, "HCM_ROLE", ref_id)
    return None


async def _validate_rule(db: AsyncSession, data: MonthlyIndentRuleIn) -> tuple[str, str | None]:
    if data.trigger_day < 1 or data.trigger_day > 31:
        raise ValidationError("Trigger day must be between 1 and 31")
    target_name = await _target_name(db, data.target_type, data.target_ref_id)
    if not target_name:
        raise ValidationError(f"No {data.target_type.lower()} with id {data.target_ref_id}")
    escalation_name = None
    if data.escalation_enabled:
        if not data.escalation_day or not data.escalation_time or not data.escalation_target_type:
            raise ValidationError("Escalation day, time, and recipient are required")
        if data.escalation_target_type == "REPORTING_MANAGER":
            escalation_name = await _target_name(
                db, data.escalation_target_type, data.escalation_target_ref_id)
        else:
            if data.escalation_target_ref_id is None:
                raise ValidationError("Escalation recipient id is required")
            escalation_name = await _target_name(
                db, data.escalation_target_type, data.escalation_target_ref_id)
        if not escalation_name:
            raise ValidationError("Escalation recipient could not be resolved")
    return target_name, escalation_name


async def create_rule(db: AsyncSession, data: MonthlyIndentRuleIn, actor) -> dict:
    target_name, escalation_name = await _validate_rule(db, data)
    row = MonthlyIndentNotificationRule(
        **data.model_dump(), target_name=target_name,
        escalation_target_name=escalation_name,
        created_by_id=getattr(actor, "id", None),
    )
    db.add(row)
    await db.flush()
    await write_audit(db, entity="mi_notification_rules", entity_id=row.id,
                      action=AuditAction.CREATE, actor=actor, after=_rule_out(row))
    await db.commit()
    await db.refresh(row)
    return _rule_out(row)


async def update_rule(db: AsyncSession, rule_id: int, data: MonthlyIndentRuleIn, actor) -> dict:
    row = await db.get(MonthlyIndentNotificationRule, rule_id)
    if row is None:
        raise NotFoundError("Monthly indent notification rule not found")
    target_name, escalation_name = await _validate_rule(db, data)
    before = _rule_out(row)
    for key, value in data.model_dump().items():
        setattr(row, key, value)
    row.target_name = target_name
    row.escalation_target_name = escalation_name
    await db.flush()
    await write_audit(db, entity="mi_notification_rules", entity_id=row.id,
                      action=AuditAction.UPDATE, actor=actor,
                      before=before, after=_rule_out(row))
    await db.commit()
    await db.refresh(row)
    return _rule_out(row)


async def delete_rule(db: AsyncSession, rule_id: int, actor) -> dict:
    row = await db.get(MonthlyIndentNotificationRule, rule_id)
    if row is None:
        raise NotFoundError("Monthly indent notification rule not found")
    before = _rule_out(row)
    row.is_active = False
    await db.flush()
    await write_audit(db, entity="mi_notification_rules", entity_id=row.id,
                      action=AuditAction.UPDATE, actor=actor,
                      before=before, after=_rule_out(row))
    await db.commit()
    return {"success": True, "id": rule_id}


async def _employee_ids_for_target(db: AsyncSession, target_type: str, ref_id: int) -> list[int]:
    if target_type == "EMPLOYEE":
        emp = await db.get(HcmEmployee, ref_id)
        return [ref_id] if emp and emp.is_active else []
    if target_type == "POSITION":
        stmt = select(HcmPositionAssignment.employee_id).where(
            HcmPositionAssignment.position_id == ref_id,
            HcmPositionAssignment.is_active.is_(True),
        )
    else:
        stmt = (
            select(HcmPositionAssignment.employee_id)
            .join(HcmPosition, HcmPosition.id == HcmPositionAssignment.position_id)
            .where(
                HcmPosition.role_id == ref_id,
                HcmPosition.is_active.is_(True),
                HcmPositionAssignment.is_active.is_(True),
            )
        )
    ids = list(dict.fromkeys((await db.execute(stmt)).scalars().all()))
    if not ids:
        return []
    active = (await db.execute(
        select(HcmEmployee.id).where(HcmEmployee.id.in_(ids), HcmEmployee.is_active.is_(True))
    )).scalars().all()
    return list(active)


async def _employee_map(db: AsyncSession, employee_ids: list[int]) -> dict[int, HcmEmployee]:
    if not employee_ids:
        return {}
    rows = (await db.execute(
        select(HcmEmployee).where(HcmEmployee.id.in_(employee_ids))
    )).scalars().all()
    return {row.id: row for row in rows}


def _submitted_monthly_exists(employee_id: int, window: CycleWindow):
    return exists(select(Indent.id).where(
        Indent.requested_by_id == employee_id,
        Indent.indent_type == IndentType.MONTHLY.value,
        Indent.indent_date >= window.start,
        Indent.indent_date <= window.end,
        Indent.status.not_in([
            IndentStatus.DRAFT.value,
            IndentStatus.REJECTED.value,
            IndentStatus.RETURNED_FOR_CORRECTION.value,
        ]),
    ))


async def _pending_candidate(db: AsyncSession, employee_id: int,
                             window: CycleWindow) -> Candidate | None:
    row = (await db.execute(
        select(Pending, Instance)
        .join(Instance, Instance.id == Pending.instance_id)
        .join(Indent, Indent.id == Pending.doc_id)
        .where(
            Pending.approver_id == employee_id,
            Pending.doc_type == DocType.INDENT.value,
            Instance.status == InstanceStatus.IN_PROGRESS.value,
            Indent.indent_type == IndentType.MONTHLY.value,
            Indent.indent_date >= window.start,
            Indent.indent_date <= window.end,
        )
        .order_by(Pending.created_at)
        .limit(1)
    )).first()
    if row is None:
        return None
    pending, instance = row
    emp = await db.get(HcmEmployee, employee_id)
    return Candidate(
        employee_id=employee_id,
        employee_name=emp.full_name if emp else str(employee_id),
        pending_since=pending.created_at,
        approval_level=instance.current_stage_name or f"Level {pending.stage_sequence}",
    )


async def eligible_candidates(db: AsyncSession, rule: MonthlyIndentNotificationRule,
                              window: CycleWindow) -> list[Candidate]:
    ids = await _employee_ids_for_target(db, rule.target_type, rule.target_ref_id)
    employees = await _employee_map(db, ids)
    out: list[Candidate] = []
    for employee_id in ids:
        emp = employees.get(employee_id)
        if emp is None or not emp.is_active:
            continue
        if rule.condition in {"NOT_SUBMITTED", "NOT_RESPONDED"}:
            submitted = (await db.execute(
                select(_submitted_monthly_exists(employee_id, window))
            )).scalar()
            if not submitted:
                out.append(Candidate(
                    employee_id=employee_id, employee_name=emp.full_name,
                    role=rule.target_name,
                ))
        elif rule.condition == "PENDING_APPROVAL":
            candidate = await _pending_candidate(db, employee_id, window)
            if candidate:
                out.append(Candidate(
                    employee_id=candidate.employee_id,
                    employee_name=candidate.employee_name,
                    role=rule.target_name,
                    pending_since=candidate.pending_since,
                    approval_level=candidate.approval_level,
                ))
    return out


async def _primary_assignment(db: AsyncSession, employee_id: int) -> HcmPositionAssignment | None:
    return (await db.execute(
        select(HcmPositionAssignment)
        .where(HcmPositionAssignment.employee_id == employee_id,
               HcmPositionAssignment.is_active.is_(True))
        .order_by(HcmPositionAssignment.is_primary.desc())
        .limit(1)
    )).scalar_one_or_none()


async def _role_holders(db: AsyncSession, role_id: int) -> list[HcmEmployee]:
    ids = await _employee_ids_for_target(db, "HCM_ROLE", role_id)
    return list((await _employee_map(db, ids)).values())


async def escalation_recipients(db: AsyncSession, rule: MonthlyIndentNotificationRule,
                                candidate: Candidate) -> list[HcmEmployee]:
    if not rule.escalation_enabled or not rule.escalation_target_type:
        return []
    if rule.escalation_target_type == "EMPLOYEE" and rule.escalation_target_ref_id:
        emp = await db.get(HcmEmployee, rule.escalation_target_ref_id)
        return [emp] if emp and emp.is_active else []
    if rule.escalation_target_type == "HCM_ROLE" and rule.escalation_target_ref_id:
        return await _role_holders(db, rule.escalation_target_ref_id)
    if rule.escalation_target_type != "REPORTING_MANAGER":
        return []

    assignment = await _primary_assignment(db, candidate.employee_id)
    position = await db.get(HcmPosition, assignment.position_id) if assignment else None
    seen: set[int] = set()
    while position and position.parent_position_id and position.id not in seen:
        seen.add(position.id)
        position = await db.get(HcmPosition, position.parent_position_id)
        if not position:
            break
        if rule.escalation_target_ref_id and position.role_id != rule.escalation_target_ref_id:
            continue
        holder_ids = (await db.execute(
            select(HcmPositionAssignment.employee_id).where(
                HcmPositionAssignment.position_id == position.id,
                HcmPositionAssignment.is_active.is_(True),
            )
        )).scalars().all()
        holders = (await _employee_map(db, list(holder_ids))).values()
        active = [emp for emp in holders if emp.is_active]
        if active:
            return active
    return []


def occurrence(window: CycleWindow, day: int) -> date:
    """The date inside the window that carries this day of the month.

    A reminder is a day number, and a window that spans months carries that day
    number more than once — so the FIRST occurrence inside the window wins. Reading
    the day against the opening month alone (which is all this did while a window was
    at most one month long) sent every reminder for a day before the opening one to
    the opening day, so a two-month cycle could not be nudged in its second month at
    all.

    A day the window genuinely never reaches is still pulled to the nearest edge
    rather than dropped: a reminder that does not run is indistinguishable on screen
    from one nobody configured.
    """
    cursor = date(window.start.year, window.start.month, 1)
    last = date(window.end.year, window.end.month, 1)
    while cursor <= last:
        candidate = _clamped_day(cursor.year, cursor.month, day)
        if window.start <= candidate <= window.end:
            return candidate
        cursor = _add_months(cursor, 1)
    first = _clamped_day(window.start.year, window.start.month, day)
    return window.start if first < window.start else window.end


def _due_at(window: CycleWindow, day: int, value: time) -> datetime:
    return datetime.combine(occurrence(window, day), value, ZoneInfo(window.timezone))


def _is_due(window: CycleWindow, day: int | None, value: time | None,
            now_: datetime) -> bool:
    if day is None or value is None:
        return False
    due = _due_at(window, day, value)
    if now_.tzinfo is None:
        now_ = now_.replace(tzinfo=ZoneInfo(window.timezone))
    return due <= now_.astimezone(ZoneInfo(window.timezone))


def _values(candidate: Candidate, window: CycleWindow) -> dict[str, str]:
    pending = candidate.pending_since.isoformat(sep=" ", timespec="minutes") if candidate.pending_since else ""
    return {
        "employee_name": candidate.employee_name,
        "role": candidate.role or "",
        "month": window.serves.strftime("%B %Y"),
        "cycle_start": window.start.isoformat(),
        "cycle_end": window.end.isoformat(),
        "pending_since": pending,
        "approval_level": candidate.approval_level or "",
    }


async def _already_logged(db: AsyncSession, *, rule_id: int, cycle_key: str,
                          target_id: int, recipient_id: int, kind: str) -> bool:
    return (await db.execute(select(MonthlyIndentNotificationLog.id).where(
        MonthlyIndentNotificationLog.rule_id == rule_id,
        MonthlyIndentNotificationLog.cycle_key == cycle_key,
        MonthlyIndentNotificationLog.target_employee_id == target_id,
        MonthlyIndentNotificationLog.recipient_employee_id == recipient_id,
        MonthlyIndentNotificationLog.kind == kind,
    ).limit(1))).scalar_one_or_none() is not None


async def _write_log(
    db: AsyncSession,
    rule: MonthlyIndentNotificationRule,
    window: CycleWindow,
    candidate: Candidate,
    recipient: HcmEmployee | None,
    *,
    kind: str,
    status: str,
    reason: str | None,
    title: str,
    message: str,
) -> bool:
    recipient_id = recipient.id if recipient else 0
    if await _already_logged(
        db, rule_id=rule.id, cycle_key=window.key, target_id=candidate.employee_id,
        recipient_id=recipient_id, kind=kind,
    ):
        return False
    db.add(MonthlyIndentNotificationLog(
        rule_id=rule.id,
        cycle_key=window.key,
        kind=kind,
        target_employee_id=candidate.employee_id,
        target_employee_name=candidate.employee_name,
        recipient_employee_id=recipient_id,
        recipient_employee_name=recipient.full_name if recipient else None,
        status=status,
        reason=reason,
        title=title,
        message=message,
    ))
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        return False
    if status == "SENT" and recipient:
        await notification_service.notify(
            db, [recipient.id], title=title, body=message,
            deep_link="/indents", entity_type="MONTHLY_INDENT",
            entity_id=rule.id,
        )
    return True


async def run_due(db: AsyncSession, now_: datetime | None = None) -> dict:
    cycle = await get_cycle_settings(db)
    if not cycle.is_enabled:
        return {"checked": 0, "sent": 0, "skipped": 0}
    window = calculate_cycle(cycle, now_)
    now_local = now_ or datetime.now(ZoneInfo(window.timezone))
    rows = (await db.execute(
        select(MonthlyIndentNotificationRule)
        .where(MonthlyIndentNotificationRule.is_active.is_(True))
    )).scalars().all()
    checked = sent = skipped = 0
    for rule in rows:
        primary_due = _is_due(window, rule.trigger_day, rule.trigger_time, now_local)
        escalation_due = rule.escalation_enabled and _is_due(
            window, rule.escalation_day, rule.escalation_time, now_local)
        if not primary_due and not escalation_due:
            continue
        for candidate in await eligible_candidates(db, rule, window):
            checked += 1
            values = _values(candidate, window)
            if primary_due:
                body = render_template(rule.message_template, values)
                if await _write_log(
                    db, rule, window, candidate,
                    HcmEmployee(id=candidate.employee_id, full_name=candidate.employee_name,
                                is_active=True, synced_at=utcnow()),
                    kind="PRIMARY", status="SENT", reason=None,
                    title="Monthly indent reminder", message=body,
                ):
                    sent += 1
            if escalation_due:
                recipients = await escalation_recipients(db, rule, candidate)
                template = rule.escalation_message_template or rule.message_template
                body = render_template(template, values)
                if not recipients:
                    wrote = await _write_log(
                        db, rule, window, candidate, None,
                        kind="ESCALATION", status="SKIPPED",
                        reason="No active escalation recipient found",
                        title="Monthly indent escalation", message=body,
                    )
                    skipped += 1 if wrote else 0
                    continue
                for recipient in recipients:
                    if await _write_log(
                        db, rule, window, candidate, recipient,
                        kind="ESCALATION", status="SENT", reason=None,
                        title="Monthly indent escalation", message=body,
                    ):
                        sent += 1
    await db.commit()
    return {"checked": checked, "sent": sent, "skipped": skipped}
