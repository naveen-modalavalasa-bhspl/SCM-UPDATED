"""Conflict detection, run when a rule is saved.

Two rules conflict when they answer the same question differently: same event,
condition sets that can both be true at once, and the same action type pointing
somewhere else. Same priority is an error, because which one wins is then arbitrary.
Different priority is a warning, because priority is a deliberate answer to the
overlap and stop_on_match may well be intended.

Overlap is decided per field. Two conditions on *different* fields never make the
rules disjoint on their own, so the check only proves separation when some shared
field makes the two sets impossible to satisfy together.
"""
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.platform.rules.models import Rule, RuleAction, RuleCondition
from app.shared.enums import ConditionLogic, ConditionOperator

INFINITY = float("inf")


@dataclass
class Conflict:
    severity: str          # "error" | "warning"
    rule_id: int
    rule_name: str
    action_type: str
    message: str

    def as_dict(self) -> dict:
        return {"severity": self.severity, "rule_id": self.rule_id,
                "rule_name": self.rule_name, "action_type": self.action_type,
                "message": self.message}


def _num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _range_of(operator: str, value: str) -> tuple[float, float] | None:
    """The numeric interval a condition allows, or None when it is not numeric."""
    number = _num(value)
    if operator == ConditionOperator.BETWEEN.value:
        parts = [p.strip() for p in str(value).split(",")]
        low, high = (_num(parts[0]) if parts else None,
                     _num(parts[1]) if len(parts) > 1 else None)
        return (low, high) if low is not None and high is not None else None
    if number is None:
        return None
    return {
        ConditionOperator.GT.value: (number, INFINITY),
        ConditionOperator.GTE.value: (number, INFINITY),
        ConditionOperator.LT.value: (-INFINITY, number),
        ConditionOperator.LTE.value: (-INFINITY, number),
        ConditionOperator.EQ.value: (number, number),
    }.get(operator)


def _set_of(operator: str, value: str) -> set[str] | None:
    """The value set a condition allows, or None when it is not a set test."""
    if operator == ConditionOperator.EQ.value:
        return {str(value).strip()}
    if operator == ConditionOperator.IN.value:
        return {v.strip() for v in str(value).split(",")}
    return None


def _fields_are_disjoint(left: RuleCondition, right: RuleCondition) -> bool:
    """True when these two conditions on the same field cannot both hold."""
    # Exclusions are open-ended, so they are never proof of separation.
    if ConditionOperator.NEQ.value in (left.operator, right.operator):
        return False
    if ConditionOperator.NOT_IN.value in (left.operator, right.operator):
        return False

    left_range, right_range = (_range_of(left.operator, left.field_value),
                               _range_of(right.operator, right.field_value))
    if left_range and right_range:
        return left_range[1] < right_range[0] or right_range[1] < left_range[0]

    left_set, right_set = (_set_of(left.operator, left.field_value),
                           _set_of(right.operator, right.field_value))
    if left_set is not None and right_set is not None:
        return not (left_set & right_set)

    return False


def conditions_overlap(left: list[RuleCondition], right: list[RuleCondition]) -> bool:
    """Can some document satisfy both condition sets at once?

    An unconditional rule matches everything, so it overlaps anything. Otherwise the
    sets are separate only if a shared field makes them contradict. OR-joined
    conditions widen a rule, so they are not used as proof of separation.
    """
    if not left or not right:
        return True
    if any(c.logic == ConditionLogic.OR.value for c in left[1:] + right[1:]):
        return True

    by_field: dict[str, list[RuleCondition]] = {}
    for cond in right:
        by_field.setdefault(cond.field_name, []).append(cond)

    for cond in left:
        for other in by_field.get(cond.field_name, []):
            if _fields_are_disjoint(cond, other):
                return False
    return True


async def find_conflicts(db: AsyncSession, event_code: str, priority: int,
                         conditions: list[RuleCondition],
                         actions: list[RuleAction],
                         exclude_rule_id: int | None = None) -> list[Conflict]:
    """Compare a rule about to be saved against every other active rule on its event."""
    candidates = (await db.execute(
        select(Rule).where(Rule.event_code == event_code, Rule.is_active.is_(True))
    )).scalars().all()
    others = [r for r in candidates if r.id != exclude_rule_id]
    if not others:
        return []

    other_ids = [r.id for r in others]
    their_conditions = await _group(db, RuleCondition, other_ids)
    their_actions = await _group(db, RuleAction, other_ids)
    our_types = {a.action_type for a in actions}

    conflicts: list[Conflict] = []
    for other in others:
        shared = our_types & {a.action_type for a in their_actions.get(other.id, [])}
        if not shared:
            continue
        if not conditions_overlap(conditions, their_conditions.get(other.id, [])):
            continue

        for action_type in sorted(shared):
            ours = _params_for(actions, action_type)
            theirs = _params_for(their_actions.get(other.id, []), action_type)
            if ours == theirs:
                continue   # same conclusion, so the overlap changes nothing

            same_priority = other.priority == priority
            conflicts.append(Conflict(
                severity="error" if same_priority else "warning",
                rule_id=other.id,
                rule_name=other.name,
                action_type=action_type,
                message=(
                    f"'{other.name}' also sets {action_type} for overlapping conditions "
                    + ("at the same priority, so which one applies is undefined."
                       if same_priority
                       else f"at priority {other.priority}; priority decides the order.")
                ),
            ))
    return conflicts


def _params_for(actions, action_type: str) -> list[dict]:
    return [a.params or {} for a in actions if a.action_type == action_type]


async def _group(db: AsyncSession, model, rule_ids: list[int]) -> dict[int, list]:
    rows = (await db.execute(
        select(model).where(model.rule_id.in_(rule_ids))
    )).scalars().all()
    out: dict[int, list] = {}
    for row in rows:
        out.setdefault(row.rule_id, []).append(row)
    return out
