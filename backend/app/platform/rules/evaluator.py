"""Rule evaluation. `fire()` is the whole public surface other modules use.

    actions = await rules.fire(db, "INDENT_SUBMITTED", ctx, doc_type="INDENT", doc_id=42)

The engine decides *what should happen* and returns it. It deliberately does not carry
the actions out: routing an approval belongs to the workflow engine (rule 8), and
setting a document's status belongs to the module that owns the document (rule 2).
"""
from dataclasses import dataclass
from datetime import date
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.platform.rules.models import (
    Rule, RuleAction, RuleCondition, RuleExecution,
)
from app.platform.workflow.conditions import matches
from app.shared.time import now as ist_now, today as ist_today


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Action:
    """One thing a matched rule says to do."""
    action_type: str
    params: dict[str, Any]
    rule_id: int
    rule_name: str

    def as_dict(self) -> dict:
        return {"action_type": self.action_type, "params": self.params,
                "rule_id": self.rule_id, "rule_name": self.rule_name}


def _in_effect(rule: Rule, today: date) -> bool:
    if rule.effective_from and today < rule.effective_from:
        return False
    if rule.effective_to and today > rule.effective_to:
        return False
    return True


async def active_rules(db: AsyncSession, event_code: str,
                       today: date | None = None) -> list[Rule]:
    today = today or ist_today()
    rows = (await db.execute(
        select(Rule).where(Rule.event_code == event_code, Rule.is_active.is_(True))
        .order_by(Rule.priority, Rule.id)
    )).scalars().all()
    return [r for r in rows if _in_effect(r, today)]


async def _conditions_by_rule(db: AsyncSession,
                              rule_ids: list[int]) -> dict[int, list[RuleCondition]]:
    """One query for every rule's conditions rather than one per rule: fire() sits on
    the request path of document submission."""
    if not rule_ids:
        return {}
    rows = (await db.execute(
        select(RuleCondition).where(RuleCondition.rule_id.in_(rule_ids))
        .order_by(RuleCondition.id)
    )).scalars().all()
    out: dict[int, list[RuleCondition]] = {}
    for row in rows:
        out.setdefault(row.rule_id, []).append(row)
    return out


async def _actions_by_rule(db: AsyncSession,
                           rule_ids: list[int]) -> dict[int, list[RuleAction]]:
    if not rule_ids:
        return {}
    rows = (await db.execute(
        select(RuleAction).where(RuleAction.rule_id.in_(rule_ids))
        .order_by(RuleAction.seq, RuleAction.id)
    )).scalars().all()
    out: dict[int, list[RuleAction]] = {}
    for row in rows:
        out.setdefault(row.rule_id, []).append(row)
    return out


async def evaluate(db: AsyncSession, event_code: str, context: dict) -> list[Action]:
    """Match rules against a context and collect the actions, without recording."""
    rules = await active_rules(db, event_code)
    if not rules:
        return []

    ids = [r.id for r in rules]
    conditions = await _conditions_by_rule(db, ids)
    actions = await _actions_by_rule(db, ids)

    collected: list[Action] = []
    for rule in rules:
        if not matches(conditions.get(rule.id, []), context):
            continue
        collected.extend(
            Action(action_type=a.action_type, params=a.params or {},
                   rule_id=rule.id, rule_name=rule.name)
            for a in actions.get(rule.id, [])
        )
        if rule.stop_on_match:
            break
    return collected


async def fire(db: AsyncSession, event_code: str, context: dict,
               doc_type: str | None = None, doc_id: int | None = None,
               record: bool = True) -> list[Action]:
    """Evaluate an event and record what happened.

    The execution row is written even when nothing matched, because "no rule covered
    this" is the failure people actually need to debug.
    """
    collected = await evaluate(db, event_code, context)

    if record:
        db.add(RuleExecution(
            event_code=event_code,
            rule_id=collected[0].rule_id if collected else None,
            doc_type=doc_type,
            doc_id=doc_id,
            matched=bool(collected),
            context=_jsonable(context),
            actions=[a.as_dict() for a in collected] or None,
        ))
        await db.flush()
    return collected


async def safe_fire(
    db: AsyncSession,
    event_code: str,
    context: dict,
    doc_type: str | None = None,
    doc_id: int | None = None,
) -> list[Action]:
    """Fire rules as an optional overlay, never as the business-flow floor.

    A bad administrator-entered condition/action must not roll back an indent or an
    allocation. The savepoint removes any partial execution row and the owning module
    continues with its code-level default. Database unavailability still surfaces when
    the caller later persists its own document; this is configuration resilience, not
    an attempt to hide infrastructure failure.
    """
    try:
        async with db.begin_nested():
            return await fire(
                db, event_code, context, doc_type=doc_type, doc_id=doc_id,
            )
    except Exception:
        logger.exception(
            "Rules engine failed for %s %s/%s; using code-level fallback",
            event_code, doc_type, doc_id,
        )
        return []


def _jsonable(context: dict) -> dict:
    """Contexts carry Decimals and dates from the ORM, which the JSON column rejects."""
    out = {}
    for key, value in (context or {}).items():
        if isinstance(value, (str, int, float, bool)) or value is None:
            out[key] = value
        else:
            out[key] = str(value)
    return out


def actions_of_type(actions: list[Action], action_type: str) -> list[Action]:
    """Convenience for callers that only care about one kind, e.g. fulfillment."""
    return [a for a in actions if a.action_type == action_type]
