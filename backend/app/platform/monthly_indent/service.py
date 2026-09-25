"""Monthly indent cycle calculation and notification dispatch."""
from __future__ import annotations

import calendar
import re
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import desc, or_, select
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
    MonthlyIndentSubmissionRule,
)
from app.platform.monthly_indent.schemas import (
    MonthlyIndentCycle, MonthlyIndentRuleIn, MonthlyIndentSubmissionRuleIn,
)
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
    #: How many months apart consecutive cycles open (`cycle_period_months`).
    period: int = 1


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


def cycle_period_months(cycle: MonthlyIndentCycle) -> int:
    """How many months apart consecutive cycles open.

    A window that closes on an earlier day than it opened (26th -> 5th) ends before
    the same day comes round again, so it can open every `span` months — every month
    for the usual one-month wrap. Any other window reaches the opening day of the
    month it closes in, so the next cycle has to wait one month more: "1st of this
    month to the 31st of next" opens every second month. Opening it monthly would
    put two cycles in force on every day of the second month.
    """
    span = cycle_span_months(cycle)
    if span >= 1 and cycle.end_day < cycle.start_day:
        return span
    return span + 1


def cycle_anchor(cycle: MonthlyIndentCycle, today: date) -> date:
    """The first of a month a cycle opens in. Stored once; derived only for a row
    saved before `anchor_month` existed, from the offset that row carried."""
    if cycle.anchor_month:
        return cycle.anchor_month.replace(day=1)
    return _add_months(today.replace(day=1), cycle.cycle_month_offset)


def _month_index(value: date) -> int:
    return value.year * 12 + value.month - 1


def _window_opening_in(cycle: MonthlyIndentCycle, opening: date) -> tuple[date, date]:
    start = _clamped_day(opening.year, opening.month, cycle.start_day)
    end_anchor = _add_months(opening, cycle_span_months(cycle))
    end = _clamped_day(end_anchor.year, end_anchor.month, cycle.end_day)
    if end < start:
        raise ValidationError("Cycle end must be on or after cycle start")
    return start, end


def local_now(timezone: str, reference: datetime | None = None) -> datetime:
    tz = ZoneInfo(timezone)
    value = reference or datetime.now(tz)
    if value.tzinfo is None:
        value = value.replace(tzinfo=tz)
    return value.astimezone(tz)


def calculate_cycle(cycle: MonthlyIndentCycle, reference: datetime | None = None) -> CycleWindow:
    """The cycle in force today — or, between two cycles, the next one to open.

    The window is two independent decisions — a day, and which month that day is in —
    on each end, so it may be any length from one day to just over a year. "The 1st of
    this month to the 31st of next" is `start_day=1, end_month_offset=1, end_day=31`.

    Cycles open in `cycle_anchor`'s month and every `cycle_period_months` either side
    of it. This used to anchor on the CURRENT month, which is only right while the
    window sits inside one month: a 26th -> 5th cycle was replaced on the 1st by the
    one opening on the 26th, so for five days the window that was actually open could
    not be submitted into, and a two-month window slid forward a month at a time.

    Days above the month's length are clamped, so an end day of 31 means "last day"
    for February, leap years included.
    """
    today = local_now(cycle.timezone, reference).date()
    span = cycle_span_months(cycle)
    period = cycle_period_months(cycle)
    anchor = cycle_anchor(cycle, today)
    offset = _month_index(today) - _month_index(anchor)
    current = upcoming = None
    # Any cycle containing today opened within the last `span` months; the one after
    # the latest of those always opens after today.
    for k in range((offset - span) // period - 1, offset // period + 2):
        opening = _add_months(anchor, k * period)
        start, end = _window_opening_in(cycle, opening)
        if start <= today <= end:
            current = (opening, start, end)   # the later of two (a clamped overlap) wins
        elif start > today and upcoming is None:
            upcoming = (opening, start, end)
    opening, start, end = current or upcoming
    serves = _add_months(opening, cycle.serves_month_offset)
    return CycleWindow(start=start, end=end, key=f"{start.isoformat()}_{end.isoformat()}",
                       timezone=cycle.timezone, serves=serves, period=period)


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
        anchor_month=row.anchor_month,
        restrict_to_rules=bool(row.restrict_to_rules),
        timezone=row.timezone,
        scheduler_enabled=row.scheduler_enabled,
        scheduler_interval_minutes=row.scheduler_interval_minutes,
    )


async def local_today(db: AsyncSession) -> date:
    """Today in the cycle's own clock. A monthly indent is dated by THIS, not by
    UTC: an indent raised at 00:30 IST on the opening day was dated the day before
    the window opened and then refused at submit for being outside it."""
    cycle = await get_cycle_settings(db)
    return local_now(cycle.timezone).date()


async def update_cycle_settings(db: AsyncSession, data: MonthlyIndentCycle, actor) -> dict:
    if data.anchor_month is None:
        data = data.model_copy(update={
            "anchor_month": cycle_anchor(data, local_now(data.timezone).date())})
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
    # Always served with an anchor, so the screen draws the same cycles the server
    # resolves even on a row that has never been saved.
    anchor = cycle_anchor(cycle, local_now(cycle.timezone).date())
    return {**cycle.model_dump(), "anchor_month": anchor,
            "cycle_start": window.start,
            "cycle_end": window.end, "cycle_key": window.key,
            "serves_start": window.serves,
            "serves_month": window.serves.strftime("%B %Y"),
            "period_months": window.period}


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
        "escalation_after_days": row.escalation_after_days,
        "escalation_levels": row.escalation_levels or 1,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


def _submission_rule_out(row: MonthlyIndentSubmissionRule) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "is_active": row.is_active,
        "target_type": row.target_type,
        "target_ref_id": row.target_ref_id,
        "target_name": row.target_name,
        "max_submissions": row.max_submissions,
        "deadline_day": row.deadline_day,
        "allow_after_deadline": row.allow_after_deadline,
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


async def list_submission_rules(db: AsyncSession) -> list[dict]:
    rows = (await db.execute(
        select(MonthlyIndentSubmissionRule)
        .order_by(MonthlyIndentSubmissionRule.target_type,
                  MonthlyIndentSubmissionRule.target_name,
                  MonthlyIndentSubmissionRule.id)
    )).scalars().all()
    return [_submission_rule_out(row) for row in rows]


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
            "submission_rules": await list_submission_rules(db),
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
        if not data.escalation_target_type:
            raise ValidationError("Choose who is told when the reminder is ignored")
        if data.escalation_after_days is None:
            # Pinned to a day of the month: both halves of the date are needed. A
            # follow-up counted from the reminder may leave the time out and inherit
            # the reminder's own.
            if not data.escalation_day or not data.escalation_time:
                raise ValidationError(
                    "Escalation needs a day and a time, or a number of days after the "
                    "reminder")
        if data.escalation_levels > 1 and data.escalation_target_type != "REPORTING_MANAGER":
            raise ValidationError(
                "Only a reporting-line escalation can climb more than one level — a job "
                "role or a named person has no 'next one up'")
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


async def _validate_submission_rule(
    db: AsyncSession, data: MonthlyIndentSubmissionRuleIn, rule_id: int | None = None,
) -> str:
    target_name = await _target_name(db, data.target_type, data.target_ref_id)
    if not target_name:
        raise ValidationError(f"No {data.target_type.lower()} with id {data.target_ref_id}")
    duplicate_stmt = select(MonthlyIndentSubmissionRule).where(
        MonthlyIndentSubmissionRule.target_type == data.target_type,
        MonthlyIndentSubmissionRule.target_ref_id == data.target_ref_id,
    )
    if rule_id is not None:
        duplicate_stmt = duplicate_stmt.where(MonthlyIndentSubmissionRule.id != rule_id)
    existing = (await db.execute(
        duplicate_stmt.limit(1)
    )).scalar_one_or_none()
    if existing:
        raise ValidationError(
            f"A monthly indent submission rule already exists for {target_name}. Edit that "
            "rule instead of adding another one."
        )
    return target_name


async def create_submission_rule(
    db: AsyncSession, data: MonthlyIndentSubmissionRuleIn, actor,
) -> dict:
    target_name = await _validate_submission_rule(db, data)
    row = MonthlyIndentSubmissionRule(
        **data.model_dump(), target_name=target_name,
        created_by_id=getattr(actor, "id", None),
    )
    db.add(row)
    await db.flush()
    await write_audit(db, entity="mi_submission_rules", entity_id=row.id,
                      action=AuditAction.CREATE, actor=actor,
                      after=_submission_rule_out(row))
    await db.commit()
    await db.refresh(row)
    return _submission_rule_out(row)


async def update_submission_rule(
    db: AsyncSession, rule_id: int, data: MonthlyIndentSubmissionRuleIn, actor,
) -> dict:
    row = await db.get(MonthlyIndentSubmissionRule, rule_id)
    if row is None:
        raise NotFoundError("Monthly indent submission rule not found")
    target_name = await _validate_submission_rule(db, data, rule_id)
    before = _submission_rule_out(row)
    for key, value in data.model_dump().items():
        setattr(row, key, value)
    row.target_name = target_name
    await db.flush()
    await write_audit(db, entity="mi_submission_rules", entity_id=row.id,
                      action=AuditAction.UPDATE, actor=actor,
                      before=before, after=_submission_rule_out(row))
    await db.commit()
    await db.refresh(row)
    return _submission_rule_out(row)


async def delete_submission_rule(db: AsyncSession, rule_id: int, actor) -> dict:
    row = await db.get(MonthlyIndentSubmissionRule, rule_id)
    if row is None:
        raise NotFoundError("Monthly indent submission rule not found")
    before = _submission_rule_out(row)
    row.is_active = False
    await db.flush()
    await write_audit(db, entity="mi_submission_rules", entity_id=row.id,
                      action=AuditAction.UPDATE, actor=actor,
                      before=before, after=_submission_rule_out(row))
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


async def _employee_targets(db: AsyncSession, employee_id: int) -> tuple[list[int], list[int]]:
    assignments = (await db.execute(
        select(HcmPositionAssignment)
        .where(HcmPositionAssignment.employee_id == employee_id,
               HcmPositionAssignment.is_active.is_(True))
        .order_by(HcmPositionAssignment.is_primary.desc(), HcmPositionAssignment.id)
    )).scalars().all()
    position_ids = list(dict.fromkeys(a.position_id for a in assignments if a.position_id))
    if not position_ids:
        return [], []
    role_ids = (await db.execute(
        select(HcmPosition.role_id)
        .where(HcmPosition.id.in_(position_ids),
               HcmPosition.is_active.is_(True),
               HcmPosition.role_id.is_not(None))
    )).scalars().all()
    return position_ids, list(dict.fromkeys(role_ids))


async def submission_rule_for_employee(
    db: AsyncSession, employee_id: int, window: CycleWindow,
) -> MonthlyIndentSubmissionRule | None:
    position_ids, role_ids = await _employee_targets(db, employee_id)
    clauses = [
        (MonthlyIndentSubmissionRule.target_type == "EMPLOYEE")
        & (MonthlyIndentSubmissionRule.target_ref_id == employee_id)
    ]
    if position_ids:
        clauses.append(
            (MonthlyIndentSubmissionRule.target_type == "POSITION")
            & (MonthlyIndentSubmissionRule.target_ref_id.in_(position_ids))
        )
    if role_ids:
        clauses.append(
            (MonthlyIndentSubmissionRule.target_type == "HCM_ROLE")
            & (MonthlyIndentSubmissionRule.target_ref_id.in_(role_ids))
        )
    rows = (await db.execute(
        select(MonthlyIndentSubmissionRule)
        .where(MonthlyIndentSubmissionRule.is_active.is_(True), or_(*clauses))
    )).scalars().all()
    if not rows:
        return None
    specificity = {"EMPLOYEE": 3, "POSITION": 2, "HCM_ROLE": 1}
    return sorted(
        rows,
        key=lambda row: (
            -specificity.get(row.target_type, 0),
            occurrence(window, row.deadline_day),
            row.max_submissions,
            -row.id,
        ),
    )[0]


async def submitted_count_for_employee(
    db: AsyncSession, employee_id: int, window: CycleWindow, *, exclude_indent_id: int | None = None,
) -> int:
    stmt = select(Indent.id).where(
        Indent.requested_by_id == employee_id,
        Indent.indent_type == IndentType.MONTHLY.value,
        Indent.indent_date >= window.start,
        Indent.indent_date <= window.end,
        Indent.status.not_in([IndentStatus.DRAFT.value, IndentStatus.REJECTED.value]),
    )
    if exclude_indent_id is not None:
        stmt = stmt.where(Indent.id != exclude_indent_id)
    return len((await db.execute(stmt)).scalars().all())


async def assert_can_submit_monthly(
    db: AsyncSession, user, *, indent: Indent | None = None,
    now_: datetime | None = None,
) -> None:
    """Refuse a monthly indent the cycle does not allow — at SUBMIT, and at CREATE
    (called with no `indent`), so nobody fills in a whole indent only to be told at the
    end that collection is closed or that they are not on the list."""
    cycle = await get_cycle_settings(db)
    if not cycle.is_enabled:
        return
    window = calculate_cycle(cycle, now_)
    today = local_now(window.timezone, now_).date()
    # The window binds everybody while collection is on, rule or no rule — the screen
    # says so ("the collection window is not enforced until this is switched back
    # on"), and before this it bound only the people a submission rule named.
    if today < window.start:
        raise ValidationError(
            f"Monthly indent collection for {window.serves.strftime('%B %Y')} opens on "
            f"{window.start.isoformat()}."
        )
    if today > window.end:
        raise ValidationError(
            f"Monthly indent collection closed on {window.end.isoformat()}."
        )
    if indent and not (window.start <= indent.indent_date <= window.end):
        raise ValidationError(
            "This monthly indent draft was created outside the current collection "
            "window. Raise or copy a fresh monthly indent for this cycle."
        )
    rule = await submission_rule_for_employee(db, user.id, window)
    if rule is None:
        if cycle.restrict_to_rules:
            raise ValidationError(
                "Monthly indents are raised only by the people listed under Settings > "
                "Monthly Indent > Who can submit. Ask an administrator to add you."
            )
        return

    deadline = occurrence(window, rule.deadline_day)
    if today > deadline and not rule.allow_after_deadline:
        raise ValidationError(
            f"The last day to submit the monthly indent for {rule.target_name} was "
            f"{deadline.isoformat()}."
        )

    used = await submitted_count_for_employee(
        db, user.id, window, exclude_indent_id=indent.id if indent else None)
    if used >= rule.max_submissions:
        raise ValidationError(
            f"{rule.target_name} can submit {rule.max_submissions} monthly "
            f"indent{'s' if rule.max_submissions != 1 else ''} in this cycle. "
            f"{used} already submitted."
        )


async def _employee_map(db: AsyncSession, employee_ids: list[int]) -> dict[int, HcmEmployee]:
    if not employee_ids:
        return {}
    rows = (await db.execute(
        select(HcmEmployee).where(HcmEmployee.id.in_(employee_ids))
    )).scalars().all()
    return {row.id: row for row in rows}


PRIMARY = "PRIMARY"
ESCALATION = "ESCALATION"
SENT = "SENT"
SKIPPED = "SKIPPED"

#: A monthly indent in one of these has not really been sent: a returned indent is
#: back with its raiser, so a reminder to send it is still in order.
_NOT_SENT_STATUSES = [
    IndentStatus.DRAFT.value,
    IndentStatus.REJECTED.value,
    IndentStatus.RETURNED_FOR_CORRECTION.value,
]
_IN_CHUNK = 1000


def _chunks(ids: list[int]):
    for index in range(0, len(ids), _IN_CHUNK):
        yield ids[index:index + _IN_CHUNK]


async def _submitted_employee_ids(db: AsyncSession, employee_ids: list[int],
                                  window: CycleWindow) -> set[int]:
    """Who among these has sent a monthly indent this cycle.

    One query per thousand people, not one per person: a Store Keeper reminder
    reaches about a thousand holders and is re-read on every check from its due time
    to the end of the cycle.
    """
    found: set[int] = set()
    for chunk in _chunks(employee_ids):
        found.update((await db.execute(
            select(Indent.requested_by_id).where(
                Indent.requested_by_id.in_(chunk),
                Indent.indent_type == IndentType.MONTHLY.value,
                Indent.indent_date >= window.start,
                Indent.indent_date <= window.end,
                Indent.status.not_in(_NOT_SENT_STATUSES),
            ).distinct()
        )).scalars().all())
    return found


async def _reminded_elsewhere(db: AsyncSession, rule_id: int, window: CycleWindow,
                              employee_ids: list[int]) -> set[int]:
    """Who has already been SENT a first reminder this cycle by some OTHER rule.

    That is what NOT_RESPONDED means. It used to ask exactly the NOT_SUBMITTED
    question, so a "still not sent after the first reminder" nudge went out to people
    who had never had a first one.
    """
    found: set[int] = set()
    for chunk in _chunks(employee_ids):
        found.update((await db.execute(
            select(MonthlyIndentNotificationLog.target_employee_id).where(
                MonthlyIndentNotificationLog.cycle_key == window.key,
                MonthlyIndentNotificationLog.kind == PRIMARY,
                MonthlyIndentNotificationLog.status == SENT,
                MonthlyIndentNotificationLog.rule_id != rule_id,
                MonthlyIndentNotificationLog.target_employee_id.in_(chunk),
            ).distinct()
        )).scalars().all())
    return found


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
    if rule.condition in {"NOT_SUBMITTED", "NOT_RESPONDED"}:
        submitted = await _submitted_employee_ids(db, ids, window)
        reminded = (await _reminded_elsewhere(db, rule.id, window, ids)
                    if rule.condition == "NOT_RESPONDED" else None)
        for employee_id in ids:
            emp = employees.get(employee_id)
            if emp is None or not emp.is_active or employee_id in submitted:
                continue
            if reminded is not None and employee_id not in reminded:
                continue
            out.append(Candidate(
                employee_id=employee_id, employee_name=emp.full_name,
                role=rule.target_name,
            ))
    elif rule.condition == "PENDING_APPROVAL":
        for employee_id in ids:
            emp = employees.get(employee_id)
            if emp is None or not emp.is_active:
                continue
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


async def can_still_submit(db: AsyncSession, cycle: MonthlyIndentCycle, employee_id: int,
                           window: CycleWindow, today: date) -> bool:
    """Whether a "please send it" reminder still asks for something possible.

    The same three refusals `assert_can_submit_monthly` makes, read without raising:
    outside the window, not on the list when the list is enforced, past their own last
    day with no late submission allowed. Reminding somebody the submit button will
    refuse only teaches them the reminders are noise.
    """
    if today < window.start or today > window.end:
        return False
    rule = await submission_rule_for_employee(db, employee_id, window)
    if rule is None:
        return not cycle.restrict_to_rules
    return bool(rule.allow_after_deadline) or today <= occurrence(window, rule.deadline_day)


async def _primary_assignment(db: AsyncSession, employee_id: int) -> HcmPositionAssignment | None:
    return (await db.execute(
        select(HcmPositionAssignment)
        .where(HcmPositionAssignment.employee_id == employee_id,
               HcmPositionAssignment.is_active.is_(True))
        .order_by(HcmPositionAssignment.is_primary.desc(), HcmPositionAssignment.id)
        .limit(1)
    )).scalar_one_or_none()


async def _role_holders(db: AsyncSession, role_id: int) -> list[HcmEmployee]:
    ids = await _employee_ids_for_target(db, "HCM_ROLE", role_id)
    return list((await _employee_map(db, ids)).values())


def escalation_levels(rule: MonthlyIndentNotificationRule) -> int:
    """How many follow-ups this rule sends: none without escalation, one to a named
    person or a job role, and up to `escalation_levels` rungs of a reporting line."""
    if not rule.escalation_enabled or not rule.escalation_target_type:
        return 0
    if rule.escalation_target_type != "REPORTING_MANAGER":
        return 1
    return max(1, int(rule.escalation_levels or 1))


def escalation_kind(level: int) -> str:
    """Level 1 keeps the kind every log written before levels existed carries."""
    return ESCALATION if level == 1 else f"{ESCALATION}_L{level}"


async def escalation_recipients(db: AsyncSession, rule: MonthlyIndentNotificationRule,
                                candidate: Candidate, level: int = 1) -> list[HcmEmployee]:
    """Who hears about `candidate` at this level of the follow-up.

    REPORTING_MANAGER climbs the candidate's own reporting line; level k is the k-th
    OCCUPIED post above them (of the chosen rank, when one is set). A vacant post is
    stepped over, not counted, so level 2 is always a second real person.
    """
    if not rule.escalation_enabled or not rule.escalation_target_type:
        return []
    if rule.escalation_target_type != "REPORTING_MANAGER":
        if level != 1:
            return []
        if rule.escalation_target_type == "EMPLOYEE" and rule.escalation_target_ref_id:
            emp = await db.get(HcmEmployee, rule.escalation_target_ref_id)
            return [emp] if emp and emp.is_active else []
        if rule.escalation_target_type == "HCM_ROLE" and rule.escalation_target_ref_id:
            return await _role_holders(db, rule.escalation_target_ref_id)
        return []

    assignment = await _primary_assignment(db, candidate.employee_id)
    position = await db.get(HcmPosition, assignment.position_id) if assignment else None
    seen: set[int] = set()
    found = 0
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
            found += 1
            if found == level:
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


def primary_due_at(window: CycleWindow, rule: MonthlyIndentNotificationRule) -> datetime:
    return _due_at(window, rule.trigger_day, rule.trigger_time)


def escalation_due_at(window: CycleWindow, rule: MonthlyIndentNotificationRule,
                      level: int = 1) -> datetime | None:
    """When follow-up `level` goes out.

    Counted from the reminder when `escalation_after_days` is set ("1" is the next
    day, at the reminder's own time unless another is given) — which is what "if the
    storekeeper has not responded, tell the manager the next day" means, and which a
    fixed day of the month could only approximate and had to be re-typed every time
    the reminder moved. Otherwise pinned to `escalation_day`, as before.

    Each further level is one more gap later (one day for a pinned follow-up). A
    follow-up that would land after the window closes is pulled back to the closing
    day: once the next cycle opens this one is never evaluated again, so a later date
    would simply never happen.
    """
    if not rule.escalation_enabled:
        return None
    if rule.escalation_after_days:
        gap = int(rule.escalation_after_days)
        first = occurrence(window, rule.trigger_day) + timedelta(days=gap)
        at = rule.escalation_time or rule.trigger_time
    else:
        if not rule.escalation_day or not rule.escalation_time:
            return None
        gap = 1
        first = occurrence(window, rule.escalation_day)
        at = rule.escalation_time
    day = min(first + timedelta(days=gap * (level - 1)), window.end)
    return datetime.combine(day, at, ZoneInfo(window.timezone))


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


@dataclass
class _RuleLog:
    """What one rule has already written this cycle, read ONCE per rule per run.

    It was one SELECT per candidate per kind, on every check for the rest of the
    cycle. `keys` is the unique key the table enforces; `told` is who has already
    had a follow-up of each kind actually delivered, so a level that reached
    somebody is not climbed again.
    """
    keys: dict[tuple[int, int, str], str]
    told: set[tuple[int, str]]


async def _rule_log(db: AsyncSession, rule_id: int, cycle_key: str) -> _RuleLog:
    rows = (await db.execute(
        select(MonthlyIndentNotificationLog.target_employee_id,
               MonthlyIndentNotificationLog.recipient_employee_id,
               MonthlyIndentNotificationLog.kind,
               MonthlyIndentNotificationLog.status)
        .where(MonthlyIndentNotificationLog.rule_id == rule_id,
               MonthlyIndentNotificationLog.cycle_key == cycle_key)
    )).all()
    keys = {(target, recipient, kind): status for target, recipient, kind, status in rows}
    told = {(target, kind) for (target, _, kind), status in keys.items() if status == SENT}
    return _RuleLog(keys=keys, told=told)


async def _write_log(
    db: AsyncSession,
    ledger: _RuleLog,
    *,
    rule_id: int,
    window: CycleWindow,
    candidate: Candidate,
    recipient_id: int,
    recipient_name: str | None,
    kind: str,
    status: str,
    reason: str | None,
    title: str,
    message: str,
) -> bool:
    key = (candidate.employee_id, recipient_id, kind)
    if key in ledger.keys:
        return False
    try:
        # A savepoint, so a collision with another run (the scheduler and "Check and
        # send now" together) undoes THIS row only. It was a full rollback, which
        # discarded every message this run had already recorded and left the loop
        # holding expired rows.
        async with db.begin_nested():
            db.add(MonthlyIndentNotificationLog(
                rule_id=rule_id,
                cycle_key=window.key,
                kind=kind,
                target_employee_id=candidate.employee_id,
                target_employee_name=candidate.employee_name,
                recipient_employee_id=recipient_id,
                recipient_employee_name=recipient_name,
                status=status,
                reason=reason,
                title=title,
                message=message,
            ))
    except IntegrityError:
        ledger.keys[key] = status
        return False
    ledger.keys[key] = status
    if status == SENT and recipient_id:
        ledger.told.add((candidate.employee_id, kind))
        await notification_service.notify(
            db, [recipient_id], title=title, body=message,
            deep_link="/indents", entity_type="MONTHLY_INDENT",
            entity_id=rule_id,
        )
    return True


async def run_due(db: AsyncSession, now_: datetime | None = None) -> dict:
    cycle = await get_cycle_settings(db)
    if not cycle.is_enabled:
        return {"checked": 0, "sent": 0, "skipped": 0}
    window = calculate_cycle(cycle, now_)
    now_local = local_now(window.timezone, now_)
    today = now_local.date()
    rows = (await db.execute(
        select(MonthlyIndentNotificationRule)
        .where(MonthlyIndentNotificationRule.is_active.is_(True))
    )).scalars().all()
    checked = sent = skipped = 0
    for rule in rows:
        rule_id = rule.id
        primary_due = primary_due_at(window, rule) <= now_local
        due_levels = [
            level for level in range(1, escalation_levels(rule) + 1)
            if (at := escalation_due_at(window, rule, level)) is not None and at <= now_local
        ]
        if not primary_due and not due_levels:
            continue
        ledger = await _rule_log(db, rule_id, window.key)
        asks_to_submit = rule.condition in {"NOT_SUBMITTED", "NOT_RESPONDED"}
        for candidate in await eligible_candidates(db, rule, window):
            checked += 1
            values = _values(candidate, window)
            me = candidate.employee_id
            if primary_due and (me, me, PRIMARY) not in ledger.keys:
                body = render_template(rule.message_template, values)
                if asks_to_submit and not await can_still_submit(
                        db, cycle, me, window, today):
                    # Recorded against nobody (recipient 0), so it shows on the screen
                    # once — and the real reminder can still go out if the admin then
                    # allows late submission or adds them to the list.
                    if await _write_log(
                        db, ledger, rule_id=rule_id, window=window, candidate=candidate,
                        recipient_id=0, recipient_name=None, kind=PRIMARY,
                        status=SKIPPED,
                        reason="Past their last day to submit, or not on the list of "
                               "who may submit — there is nothing left to ask of them",
                        title="Monthly indent reminder", message=body,
                    ):
                        skipped += 1
                elif await _write_log(
                    db, ledger, rule_id=rule_id, window=window, candidate=candidate,
                    recipient_id=me, recipient_name=candidate.employee_name,
                    kind=PRIMARY, status=SENT, reason=None,
                    title="Monthly indent reminder", message=body,
                ):
                    sent += 1
            for level in due_levels:
                kind = escalation_kind(level)
                if (me, kind) in ledger.told:
                    continue
                recipients = await escalation_recipients(db, rule, candidate, level)
                template = rule.escalation_message_template or rule.message_template
                body = render_template(template, values)
                title = ("Monthly indent escalation" if level == 1
                         else f"Monthly indent escalation (level {level})")
                if not recipients:
                    reason = ("No active escalation recipient found" if level == 1
                              else "No active escalation recipient found at level "
                                   f"{level} of the reporting line")
                    if await _write_log(
                        db, ledger, rule_id=rule_id, window=window, candidate=candidate,
                        recipient_id=0, recipient_name=None, kind=kind,
                        status=SKIPPED, reason=reason, title=title, message=body,
                    ):
                        skipped += 1
                    continue
                for recipient in recipients:
                    if await _write_log(
                        db, ledger, rule_id=rule_id, window=window, candidate=candidate,
                        recipient_id=recipient.id, recipient_name=recipient.full_name,
                        kind=kind, status=SENT, reason=None, title=title, message=body,
                    ):
                        sent += 1
    await db.commit()
    return {"checked": checked, "sent": sent, "skipped": skipped}
