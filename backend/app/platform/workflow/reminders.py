"""Chasing approvals that have gone past their due date.

Two things happen, in order. An approval that is overdue gets reminded, at most
`max_reminders` times and no more than once per `gap_hours`. Once it has had all its
reminders and is still sitting there, it escalates once to the approver's own
reporting manager — the post above theirs in HCM, the same climb `resolver` does.

**How many reminders have already gone out is counted, not stored.** Every reminder
is a `sys_notifications` row tagged with this module's entity types, so counting those
rows for a `wf_pending` id gives the answer without a counter column. That keeps the
whole feature inside tables that already exist, and it means a reminder that was never
actually delivered was never counted either.

Nothing here decides anything about the document. It writes notifications and stops —
the approval itself is untouched, so a misfiring reminder can never move a document.
"""
import logging
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.platform.hcm import service as hcm_service
from app.platform.hcm.models import HcmPosition, HcmPositionAssignment
from app.platform.notifications import service as notifications
from app.platform.settings.models import Notification
from app.platform.settings.service import get_setting, set_setting
from app.platform.workflow.models import Instance, Pending
from app.shared.enums import InstanceStatus
from app.shared.models.base import utcnow

logger = logging.getLogger(__name__)

# The two tags that make the count possible. They are entity_type values on
# sys_notifications, never a status on a document.
REMINDER = "APPROVAL_REMINDER"
ESCALATION = "APPROVAL_ESCALATION"

SETTING_ENABLED = "approvals.reminders.enabled"
SETTING_INTERVAL = "approvals.reminders.interval_minutes"
SETTING_MAX = "approvals.reminders.max_reminders"
SETTING_GAP = "approvals.reminders.gap_hours"
SETTING_OVERDUE_DAYS = "approvals.reminders.overdue_after_days"

# Defaults chosen to match the process document: two reminders, then escalate.
DEFAULTS = {
    SETTING_ENABLED: "false",   # off until an administrator turns it on
    SETTING_INTERVAL: "60",     # how often the job wakes up
    SETTING_MAX: "2",           # reminders before escalation
    SETTING_GAP: "24",          # hours between reminders to the same person
    SETTING_OVERDUE_DAYS: "3",  # when wf_pending.due_at is NULL — see _due_cutoff
}


async def get_config(db: AsyncSession) -> dict:
    """The four knobs, with the defaults applied. Never raises on a bad stored value —
    a typo in `sys_settings` must not stop the job from running at all."""
    def as_int(value: str | None, fallback: str) -> int:
        try:
            return max(0, int(str(value if value is not None else fallback).strip()))
        except (TypeError, ValueError):
            return int(fallback)

    return {
        "enabled": str(await get_setting(db, SETTING_ENABLED, DEFAULTS[SETTING_ENABLED])
                       ).strip().lower() == "true",
        "interval_minutes": as_int(await get_setting(db, SETTING_INTERVAL),
                                   DEFAULTS[SETTING_INTERVAL]),
        "max_reminders": as_int(await get_setting(db, SETTING_MAX),
                                DEFAULTS[SETTING_MAX]),
        "gap_hours": as_int(await get_setting(db, SETTING_GAP), DEFAULTS[SETTING_GAP]),
        "overdue_after_days": as_int(await get_setting(db, SETTING_OVERDUE_DAYS),
                                     DEFAULTS[SETTING_OVERDUE_DAYS]),
    }


async def save_config(db: AsyncSession, *, enabled: bool, interval_minutes: int,
                      max_reminders: int, gap_hours: int,
                      overdue_after_days: int) -> dict:
    await set_setting(db, SETTING_ENABLED, "true" if enabled else "false",
                      value_type="bool", category="approvals")
    await set_setting(db, SETTING_INTERVAL, max(0, interval_minutes),
                      value_type="int", category="approvals")
    await set_setting(db, SETTING_MAX, max(0, max_reminders),
                      value_type="int", category="approvals")
    await set_setting(db, SETTING_GAP, max(0, gap_hours),
                      value_type="int", category="approvals")
    await set_setting(db, SETTING_OVERDUE_DAYS, max(0, overdue_after_days),
                      value_type="int", category="approvals")
    return await get_config(db)


def _naive(value):
    """Drop the tzinfo so DB values and `utcnow()` can be compared.

    `utcnow()` returns an aware datetime; every datetime read back from MySQL is naive
    UTC. Subtracting one from the other raises, and it has bitten this module's
    neighbours before — `workflow/service.py` carries the same guard.
    """
    if value is None:
        return None
    return value.replace(tzinfo=None) if value.tzinfo is not None else value


def _deadline(pending, overdue_after_days: int):
    """When this task should have been decided.

    `wf_pending.due_at` is the right answer and is used whenever it is set — but the
    engine does not currently populate it, and all 157 live pending rows have it NULL.
    Chasing only on `due_at` would therefore chase nothing, for ever. So a task with no
    due date is treated as due `overdue_after_days` after it landed on the desk, which
    is the only other honest signal the row carries.

    Set `due_at` in the engine later and this falls straight through to it: the
    fallback is second, not first.
    """
    if pending.due_at is not None:
        return _naive(pending.due_at)
    created = _naive(pending.created_at)
    if not created:
        return None
    return created + timedelta(days=overdue_after_days)


async def _overdue(db: AsyncSession, overdue_after_days: int) -> list:
    """Pending tasks past their deadline whose workflow is still running.

    The instance join is what stops a finished document being chased: `wf_pending`
    rows outlive a cancelled workflow, and the approvals inbox filters them the same
    way. The deadline itself is applied in Python rather than SQL — it is two columns
    and a setting, and this list is hundreds of rows, not millions.
    """
    now = _naive(utcnow())
    rows = (await db.execute(
        select(Pending, Instance)
        .join(Instance, Instance.id == Pending.instance_id)
        .where(Instance.status == InstanceStatus.IN_PROGRESS.value)
        .order_by(Pending.created_at)
    )).all()
    out = []
    for pending, instance in rows:
        deadline = _deadline(pending, overdue_after_days)
        if deadline is not None and deadline < now:
            out.append((pending, instance, deadline))
    return out


async def _counts(db: AsyncSession, pending_ids: list[int]) -> dict[int, dict]:
    """Per pending id: how many reminders have gone out, when the last one was, and
    whether it has already been escalated. One query, not one per row."""
    if not pending_ids:
        return {}
    rows = (await db.execute(
        select(
            Notification.entity_id,
            Notification.entity_type,
            func.count(Notification.id),
            func.max(Notification.created_at),
        )
        .where(
            Notification.entity_type.in_([REMINDER, ESCALATION]),
            Notification.entity_id.in_(pending_ids),
        )
        .group_by(Notification.entity_id, Notification.entity_type)
    )).all()

    out: dict[int, dict] = {}
    for entity_id, entity_type, count, last_at in rows:
        slot = out.setdefault(int(entity_id), {"reminders": 0, "last_at": None,
                                               "escalated": False})
        if entity_type == REMINDER:
            slot["reminders"] = int(count or 0)
            slot["last_at"] = last_at
        else:
            slot["escalated"] = bool(count)
    return out


async def _manager_ids(db: AsyncSession, employee_id: int) -> list[int]:
    """Whoever holds the post above this person's. Empty when they are at the top, or
    when their post has no parent — which is common in the live mirror, so escalation
    quietly does nothing rather than inventing a recipient."""
    position_id = await db.scalar(
        select(HcmPositionAssignment.position_id).where(
            HcmPositionAssignment.employee_id == employee_id,
            HcmPositionAssignment.is_active.is_(True),
        ).limit(1)
    )
    if not position_id:
        return []
    parent_id = await db.scalar(
        select(HcmPosition.parent_position_id).where(HcmPosition.id == position_id)
    )
    if not parent_id:
        return []
    holders = await hcm_service.get_position_holders(db, parent_id)
    return [h.id for h in holders if getattr(h, "is_active", True)]


def _age_days(due_at, now) -> int:
    return max(0, (now - due_at).days) if due_at else 0


async def preview(db: AsyncSession) -> dict:
    """What the job would do right now, without doing any of it. This is what the
    admin screen shows, so "turn it on" is never a leap of faith."""
    config = await get_config(db)
    rows = await _overdue(db, config["overdue_after_days"])
    counts = await _counts(db, [p.id for p, _, _ in rows])
    now = _naive(utcnow())

    items = []
    for pending, instance, deadline in rows:
        seen = counts.get(pending.id, {"reminders": 0, "last_at": None,
                                       "escalated": False})
        last_at = _naive(seen["last_at"])
        due_gap = (now - last_at) if last_at else None
        can_remind = (
            seen["reminders"] < config["max_reminders"]
            and (due_gap is None or due_gap >= timedelta(hours=config["gap_hours"]))
        )
        items.append({
            "pending_id": pending.id,
            "doc_type": pending.doc_type,
            "doc_no": pending.doc_no,
            "doc_id": pending.doc_id,
            "approver_id": pending.approver_id,
            "raised_by": pending.requested_by_name,
            "stage_name": instance.current_stage_name,
            "due_at": deadline.isoformat() if deadline else None,
            # False when the deadline came from the fallback rather than from
            # wf_pending.due_at — the screen says so rather than implying somebody set
            # a date that nobody set.
            "due_at_is_set": pending.due_at is not None,
            "days_overdue": _age_days(deadline, now),
            "reminders_sent": seen["reminders"],
            "escalated": seen["escalated"],
            "next_action": (
                "ESCALATE" if (not seen["escalated"]
                               and seen["reminders"] >= config["max_reminders"])
                else "REMIND" if can_remind else "WAIT"
            ),
        })
    return {"config": config, "items": items, "total": len(items)}


async def run(db: AsyncSession) -> dict:
    """Send what is due. Returns a small summary for the log and the screen.

    Never raises: this runs unattended on a timer, and a single unreachable manager
    must not stop the rest of the queue being chased.
    """
    config = await get_config(db)
    plan = await preview(db)
    reminded = escalated = skipped = 0

    for item in plan["items"]:
        try:
            link = notifications.link_for(item["doc_type"], item["doc_id"])
            label = item["doc_no"] or f"{item['doc_type']} #{item['doc_id']}"

            if item["next_action"] == "REMIND":
                await notifications.notify(
                    db, [item["approver_id"]],
                    title=f"Reminder: {label} is waiting for you",
                    body=(f"{label} has been waiting {item['days_overdue']} day"
                          f"{'s' if item['days_overdue'] != 1 else ''} past its due "
                          f"date at {item['stage_name'] or 'your stage'}."),
                    deep_link=link,
                    entity_type=REMINDER, entity_id=item["pending_id"],
                )
                reminded += 1

            elif item["next_action"] == "ESCALATE":
                managers = await _manager_ids(db, item["approver_id"])
                if not managers:
                    skipped += 1
                    continue
                await notifications.notify(
                    db, managers,
                    title=f"Escalation: {label} is still unapproved",
                    body=(f"{label} has had {item['reminders_sent']} reminder"
                          f"{'s' if item['reminders_sent'] != 1 else ''} and is "
                          f"{item['days_overdue']} day"
                          f"{'s' if item['days_overdue'] != 1 else ''} overdue at "
                          f"{item['stage_name'] or 'its current stage'}."),
                    deep_link=link,
                    entity_type=ESCALATION, entity_id=item["pending_id"],
                )
                escalated += 1
        except Exception:  # noqa: BLE001 - one bad row must not stop the sweep
            logger.exception("Approval chase failed for pending %s", item["pending_id"])
            skipped += 1

    await db.commit()
    summary = {"overdue": plan["total"], "reminded": reminded,
               "escalated": escalated, "skipped": skipped,
               "enabled": config["enabled"]}
    logger.info("Approval chase: %s", summary)
    return summary
