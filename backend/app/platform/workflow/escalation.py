"""Approvals that wait too long move UP THE DOCUMENT'S OWN LADDER (2026-11-20).

MoM 2026-11-18, point 2. Not to the approver's HCM parent position: to the next rung
of the ladder that was frozen onto this document when it was submitted
(`wf_instances.resolved_chain`, configured on Settings > Approvals Config) — the same
step the engine takes when somebody approves.

The timeline of ONE waiting approval (both thresholds are settings):

- **12 h** (`approvals.escalation.attention_hours`) — nothing moves; the Home Approvals
  card counts it as "waiting over 12 h" (amber).
- **24 h** (`approvals.escalation.after_hours`), not the last rung — it MOVES to the next
  rung. The history gets a system row ("Escalated — waited 24 h with Anita (Regional
  Manager). Moved to District Manager."), the new approvers are told as for any new
  step, and the ones it left are told it moved on.
- **24 h**, the LAST rung — nobody is above it, so nothing moves. It is "stuck at final
  approval": red on the Home card, and its approver gets ONE pinned, urgent
  notification (entity type `APPROVAL_STUCK`, keyed on the waiting row, so the sweep
  never sends it twice).

The clock is the waiting row's own `created_at` — when the document reached THIS rung —
so every escalation restarts it. A document is moved at most one rung per sweep.

Only ladder documents (a frozen `resolved_chain`) escalate. A document on the old
stage workflow has no ladder to follow and is left to the reminders job.

Nothing here decides the document. It never approves or rejects; the module that owns
the document is told through `ON_ESCALATED` (a list of async callables), the same
hook shape the other modules use, so a module that keeps a "waiting on" name can
refresh it without the platform importing a module (rule 5).
"""
from __future__ import annotations

import logging
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.platform.hcm import service as hcm_service
from app.platform.notifications import service as notifications
from app.platform.settings.models import Notification
from app.platform.settings.service import get_setting, set_setting
from app.platform.workflow import engine
from app.platform.workflow.models import Action, Instance, Pending
from app.shared.enums import ApprovalAction, InstanceStatus
from app.shared.models.base import utcnow

logger = logging.getLogger(__name__)

SETTING_ENABLED = "approvals.escalation.enabled"
SETTING_AFTER = "approvals.escalation.after_hours"
SETTING_ATTENTION = "approvals.escalation.attention_hours"
DEFAULTS = {SETTING_ENABLED: "true", SETTING_AFTER: "24", SETTING_ATTENTION: "12"}

#: The tag on the one pinned notification a stuck final approval sends.
STUCK = "APPROVAL_STUCK"
SYSTEM_NAME = "System (auto-escalation)"

#: async def hook(db, instance) — called after a document moved up a rung.
ON_ESCALATED: list = []


async def get_config(db: AsyncSession) -> dict:
    def hours(value, fallback: str) -> float:
        try:
            return max(1.0, float(str(value if value is not None else fallback).strip()))
        except (TypeError, ValueError):
            return float(fallback)
    return {
        "enabled": str(await get_setting(db, SETTING_ENABLED, DEFAULTS[SETTING_ENABLED])
                       ).strip().lower() == "true",
        "after_hours": hours(await get_setting(db, SETTING_AFTER), DEFAULTS[SETTING_AFTER]),
        "attention_hours": hours(await get_setting(db, SETTING_ATTENTION),
                                 DEFAULTS[SETTING_ATTENTION]),
    }


async def save_config(db: AsyncSession, *, enabled: bool, after_hours: float,
                      attention_hours: float) -> dict:
    await set_setting(db, SETTING_ENABLED, "true" if enabled else "false",
                      value_type="bool", category="approvals")
    await set_setting(db, SETTING_AFTER, max(1, int(after_hours)), value_type="int",
                      category="approvals")
    await set_setting(db, SETTING_ATTENTION, max(1, int(attention_hours)),
                      value_type="int", category="approvals")
    return await get_config(db)


def is_last_rung(instance: Instance, sequence: int | None = None) -> bool:
    """No rung after the one it sits on — escalation has nowhere to go."""
    current = sequence if sequence is not None else (instance.current_sequence or 0)
    return not any(int(link.get("sequence", 0)) > int(current)
                   for link in engine._chain_links(instance))


def hours_label(hours: float) -> str:
    """Whole hours, the way a person says a wait: "25 h", never "25.0003 h"."""
    whole = int(round(float(hours)))
    return "under 1 h" if whole < 1 else f"{whole} h"


def escalation_note(waited_hours: float, from_names: list[str], from_role: str | None,
                    to_role: str | None) -> str:
    """The sentence written into the approval history — pure, so it is tested."""
    who = ", ".join(n for n in from_names if n) or "the approver"
    role = f" ({from_role})" if from_role else ""
    return (f"Escalated — waited {hours_label(waited_hours)} with {who}{role}. "
            f"Moved to {to_role or 'the next level'} by the system.")


async def _move_up(db: AsyncSession, instance: Instance, rows: list[Pending],
                   waited_hours: float) -> None:
    link = engine._link(instance) or {}
    nxt = [c for c in engine._chain_links(instance)
           if int(c.get("sequence", 0)) > int(instance.current_sequence or 0)]
    target = nxt[0]
    from_names = list(link.get("approver_names") or [])
    if not from_names:
        for row in rows:
            emp = await hcm_service.get_employee(db, row.approver_id)
            if emp and emp.full_name:
                from_names.append(emp.full_name)
    left_ids = sorted({row.approver_id for row in rows})
    note = escalation_note(waited_hours, from_names, link.get("role_name"),
                           target.get("role_name"))
    db.add(Action(
        instance_id=instance.id, stage_sequence=instance.current_sequence,
        stage_name=link.get("role_name"), actor_id=None, actor_name=SYSTEM_NAME,
        actor_position=None, action=ApprovalAction.ESCALATED.value, comments=note,
    ))
    await db.flush()
    sample = rows[0]
    await engine._clear_pending(db, instance.id)
    await engine._open_ladder_link(db, instance, target, {
        "doc_summary": sample.doc_summary, "amount": sample.amount,
    })
    label = instance.doc_no or f"{instance.doc_type} #{instance.doc_id}"
    await notifications.notify(
        db, left_ids,
        title=f"{label} moved up to {target.get('role_name') or 'the next level'}",
        body=f"It waited {hours_label(waited_hours)} for your approval and was escalated.",
        deep_link=notifications.link_for(instance.doc_type, instance.doc_id),
        entity_type=instance.doc_type, entity_id=instance.doc_id,
    )
    for hook in list(ON_ESCALATED):
        try:
            await hook(db, instance)
        except Exception:  # noqa: BLE001 - a module's refresh must never undo the move
            logger.exception("Escalation hook failed for %s", label)


async def _flag_stuck(db: AsyncSession, instance: Instance, rows: list[Pending],
                      waited_hours: float) -> bool:
    """One pinned notification per waiting row, never two."""
    row_ids = [row.id for row in rows]
    already = set((await db.execute(
        select(Notification.entity_id).where(
            Notification.entity_type == STUCK, Notification.entity_id.in_(row_ids))
    )).scalars().all())
    sent = False
    label = instance.doc_no or f"{instance.doc_type} #{instance.doc_id}"
    for row in rows:
        if row.id in already:
            continue
        await notifications.notify(
            db, [row.approver_id],
            title=f"Urgent: {label} is stuck at final approval",
            body=(f"It has waited {hours_label(waited_hours)} with you, and yours is the "
                  "last approval — nobody above can take it. Please decide today."),
            deep_link=notifications.link_for(instance.doc_type, instance.doc_id),
            entity_type=STUCK, entity_id=row.id,
        )
        sent = True
    return sent


async def sweep(db: AsyncSession, now=None) -> dict:
    """Move what has waited past `after_hours` one rung up; flag what cannot move.
    Never raises: one bad document must not stop the rest of the queue."""
    config = await get_config(db)
    if not config["enabled"]:
        return {"enabled": False, "moved": 0, "stuck": 0, "skipped": 0}
    now = now or utcnow()
    cutoff = now - timedelta(hours=config["after_hours"])
    rows = (await db.execute(
        select(Pending, Instance)
        .join(Instance, Instance.id == Pending.instance_id)
        .where(Instance.status == InstanceStatus.IN_PROGRESS.value,
               Instance.resolved_chain.isnot(None),
               Pending.stage_sequence == Instance.current_sequence,
               Pending.created_at <= cutoff)
        .order_by(Pending.instance_id, Pending.id)
    )).all()
    by_instance: dict[int, tuple[Instance, list[Pending]]] = {}
    for pending, instance in rows:
        by_instance.setdefault(instance.id, (instance, []))[1].append(pending)

    moved = stuck = skipped = 0
    for instance, waiting in by_instance.values():
        waited = (now - min(r.created_at for r in waiting)).total_seconds() / 3600
        try:
            async with db.begin_nested():
                if is_last_rung(instance):
                    if await _flag_stuck(db, instance, waiting, waited):
                        stuck += 1
                else:
                    await _move_up(db, instance, waiting, waited)
                    moved += 1
        except Exception:  # noqa: BLE001
            logger.exception("Escalation failed for instance %s", instance.id)
            skipped += 1
    await db.commit()
    summary = {"enabled": True, "moved": moved, "stuck": stuck, "skipped": skipped}
    if moved or stuck or skipped:
        logger.info("Approval escalation: %s", summary)
    return summary


async def ageing_counts(db: AsyncSession, conditions: list) -> dict:
    """For the Home Approvals card: of the rows `conditions` select, how many have
    waited past the attention mark, and how many are stuck at their final rung."""
    config = await get_config(db)
    now = utcnow()
    rows = (await db.execute(
        select(Pending.created_at, Pending.stage_sequence, Instance.resolved_chain)
        .select_from(Pending).join(Instance, Instance.id == Pending.instance_id)
        .where(*conditions,
               Pending.created_at <= now - timedelta(hours=config["attention_hours"]))
    )).all()
    attention = stuck = 0
    after = timedelta(hours=config["after_hours"])
    for created_at, sequence, chain in rows:
        last = bool(chain) and not any(
            isinstance(link, dict) and int(link.get("sequence", 0)) > int(sequence or 0)
            for link in chain)
        if last and now - created_at >= after:
            stuck += 1
        else:
            attention += 1
    return {"attention": attention, "stuck": stuck,
            "attention_hours": config["attention_hours"], "after_hours": config["after_hours"]}
