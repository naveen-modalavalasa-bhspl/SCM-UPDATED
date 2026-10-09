"""Operator semantics, shared by the approval engine and the rules engine.

No database: these are pure functions, and they are the part most likely to be wrong
in a way that silently routes a document to the wrong place.
"""
from types import SimpleNamespace

import pytest

from app.platform.workflow.conditions import eval_condition, matches
from app.shared.enums import ConditionLogic, ConditionOperator


def cond(field_name, operator, field_value, logic=ConditionLogic.AND.value, id=1):
    return SimpleNamespace(id=id, field_name=field_name, operator=operator,
                           field_value=field_value, logic=logic)


@pytest.mark.parametrize("value,operator,target,expected", [
    (150, ConditionOperator.GT.value, "100", True),
    (100, ConditionOperator.GT.value, "100", False),
    (100, ConditionOperator.GTE.value, "100", True),
    (50, ConditionOperator.LT.value, "100", True),
    (100, ConditionOperator.LTE.value, "100", True),
    ("CONSUMABLE", ConditionOperator.EQ.value, "CONSUMABLE", True),
    ("CAPITAL", ConditionOperator.EQ.value, "CONSUMABLE", False),
    ("CAPITAL", ConditionOperator.NEQ.value, "CONSUMABLE", True),
    ("A", ConditionOperator.IN.value, "A, B, C", True),
    ("D", ConditionOperator.IN.value, "A, B, C", False),
    ("D", ConditionOperator.NOT_IN.value, "A, B, C", True),
    ("A", ConditionOperator.NOT_IN.value, "A, B, C", False),
    (25, ConditionOperator.BETWEEN.value, "10,50", True),
    (10, ConditionOperator.BETWEEN.value, "10,50", True),
    (50, ConditionOperator.BETWEEN.value, "10,50", True),
    (51, ConditionOperator.BETWEEN.value, "10,50", False),
])
def test_operators(value, operator, target, expected):
    assert eval_condition(value, operator, target) is expected


def test_numeric_equality_ignores_string_formatting():
    """A context carrying Decimal('100.0') must equal a stored "100"."""
    assert eval_condition("100.0", ConditionOperator.EQ.value, "100") is True


def test_missing_context_field_does_not_match():
    assert eval_condition(None, ConditionOperator.GT.value, "100") is False


def test_unknown_operator_does_not_match():
    assert eval_condition(5, "SOMETHING_ELSE", "1") is False


def test_between_with_one_bound_does_not_match():
    assert eval_condition(25, ConditionOperator.BETWEEN.value, "10") is False


def test_no_conditions_always_matches():
    assert matches([], {"anything": 1}) is True


def test_and_requires_every_condition():
    conditions = [
        cond("quantity", ConditionOperator.GT.value, "100", id=1),
        cond("category", ConditionOperator.EQ.value, "CONSUMABLE", id=2),
    ]
    assert matches(conditions, {"quantity": 150, "category": "CONSUMABLE"}) is True
    assert matches(conditions, {"quantity": 150, "category": "CAPITAL"}) is False


def test_or_accepts_either_condition():
    conditions = [
        cond("quantity", ConditionOperator.GT.value, "100", id=1),
        cond("urgent", ConditionOperator.EQ.value, "true",
             logic=ConditionLogic.OR.value, id=2),
    ]
    assert matches(conditions, {"quantity": 5, "urgent": "true"}) is True
    assert matches(conditions, {"quantity": 5, "urgent": "false"}) is False


def test_conditions_are_evaluated_in_id_order():
    """Order decides the result for mixed AND/OR, so it must come from the stored id
    rather than however the rows came back from the database."""
    first = cond("a", ConditionOperator.EQ.value, "1", id=1)
    second = cond("b", ConditionOperator.EQ.value, "2",
                  logic=ConditionLogic.OR.value, id=2)
    assert matches([second, first], {"a": "1", "b": "999"}) is True


def test_reads_field_name_not_field():
    """Regression: the evaluator used to read `.field`/`.value`, but the model columns
    are `field_name`/`field_value`, so every conditional stage raised AttributeError."""
    assert matches([cond("quantity", ConditionOperator.GT.value, "10")],
                   {"quantity": 50}) is True
