"""Condition evaluation, shared by the approval engine and the rules engine.

The approval engine asks "does this stage apply to this document"; the rules engine
asks "does this rule match this event". Both are the same question over a list of
(field_name, operator, field_value, logic) rows, so both call `matches()` and only
one implementation of the operators exists.
"""
from app.shared.enums import ConditionLogic, ConditionOperator


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _options(target: str) -> list[str]:
    return [o.strip() for o in str(target).split(",")]


def eval_condition(field_value, operator: str, target: str) -> bool:
    op = operator

    if op == ConditionOperator.IN.value:
        return str(field_value) in _options(target)
    if op == ConditionOperator.NOT_IN.value:
        return str(field_value) not in _options(target)

    if op in (ConditionOperator.EQ.value, ConditionOperator.NEQ.value):
        a, b = _num(field_value), _num(target)
        equal = a == b if a is not None and b is not None else str(field_value) == str(target)
        return equal if op == ConditionOperator.EQ.value else not equal

    if op == ConditionOperator.BETWEEN.value:
        bounds = _options(target)
        lo, hi, val = (_num(bounds[0]) if bounds else None,
                       _num(bounds[1]) if len(bounds) > 1 else None,
                       _num(field_value))
        if lo is None or hi is None or val is None:
            return False
        return lo <= val <= hi

    a, b = _num(field_value), _num(target)
    if a is None or b is None:
        return False
    return {
        ConditionOperator.GT.value: a > b,
        ConditionOperator.GTE.value: a >= b,
        ConditionOperator.LT.value: a < b,
        ConditionOperator.LTE.value: a <= b,
    }.get(op, False)


def matches(conditions: list, context: dict) -> bool:
    """No conditions -> always matches. Otherwise combine each condition
    left-to-right using its own logic connector (AND/OR)."""
    if not conditions:
        return True
    context = context or {}
    ordered = sorted(conditions, key=lambda c: c.id or 0)

    def evaluate(cond) -> bool:
        return eval_condition(context.get(cond.field_name), cond.operator, cond.field_value)

    result = evaluate(ordered[0])
    for cond in ordered[1:]:
        value = evaluate(cond)
        if cond.logic == ConditionLogic.OR.value:
            result = result or value
        else:
            result = result and value
    return result


# The approval engine's name for the same question. Kept so engine.py reads clearly.
stage_applies = matches
