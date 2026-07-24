"""Stage condition evaluation: decide whether a stage applies to a document."""
from app.shared.enums import ConditionLogic, ConditionOperator


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def eval_condition(field_value, operator: str, target: str) -> bool:
    op = operator
    if op == ConditionOperator.IN.value:
        options = [o.strip() for o in str(target).split(",")]
        return str(field_value) in options

    if op == ConditionOperator.EQ.value:
        if _num(field_value) is not None and _num(target) is not None:
            return _num(field_value) == _num(target)
        return str(field_value) == str(target)

    a, b = _num(field_value), _num(target)
    if a is None or b is None:
        return False
    return {
        ConditionOperator.GT.value: a > b,
        ConditionOperator.GTE.value: a >= b,
        ConditionOperator.LT.value: a < b,
        ConditionOperator.LTE.value: a <= b,
    }.get(op, False)


def stage_applies(conditions: list, context: dict) -> bool:
    """No conditions -> always applies. Otherwise combine each condition left-to-right
    using its own logic connector (AND/OR)."""
    if not conditions:
        return True
    context = context or {}
    ordered = sorted(conditions, key=lambda c: c.id)
    result = eval_condition(context.get(ordered[0].field), ordered[0].operator, ordered[0].value)
    for cond in ordered[1:]:
        val = eval_condition(context.get(cond.field), cond.operator, cond.value)
        if cond.logic == ConditionLogic.OR.value:
            result = result or val
        else:
            result = result and val
    return result
