"""Condition-overlap logic behind conflict detection. Pure functions, no database.

The property that matters: overlap must never be reported as "separate" when the two
rules can in fact both fire. A false "separate" lets contradictory rules be saved; a
false "overlap" is only a spurious warning, so the check errs toward overlap.
"""
from types import SimpleNamespace

from app.platform.rules.conflicts import conditions_overlap
from app.shared.enums import ConditionLogic, ConditionOperator


def cond(field_name, operator, field_value, logic=ConditionLogic.AND.value, id=1):
    return SimpleNamespace(id=id, field_name=field_name, operator=operator,
                           field_value=field_value, logic=logic)


def test_unconditional_rule_overlaps_everything():
    other = [cond("quantity", ConditionOperator.GT.value, "100")]
    assert conditions_overlap([], other) is True
    assert conditions_overlap(other, []) is True


def test_disjoint_numeric_ranges_do_not_overlap():
    low = [cond("quantity", ConditionOperator.LT.value, "50")]
    high = [cond("quantity", ConditionOperator.GT.value, "100")]
    assert conditions_overlap(low, high) is False


def test_touching_numeric_ranges_overlap():
    low = [cond("quantity", ConditionOperator.LTE.value, "100")]
    high = [cond("quantity", ConditionOperator.GTE.value, "100")]
    assert conditions_overlap(low, high) is True


def test_overlapping_numeric_ranges_overlap():
    a = [cond("quantity", ConditionOperator.GT.value, "10")]
    b = [cond("quantity", ConditionOperator.LT.value, "500")]
    assert conditions_overlap(a, b) is True


def test_between_ranges_that_miss_each_other():
    a = [cond("quantity", ConditionOperator.BETWEEN.value, "1,10")]
    b = [cond("quantity", ConditionOperator.BETWEEN.value, "20,30")]
    assert conditions_overlap(a, b) is False


def test_between_ranges_that_meet():
    a = [cond("quantity", ConditionOperator.BETWEEN.value, "1,25")]
    b = [cond("quantity", ConditionOperator.BETWEEN.value, "20,30")]
    assert conditions_overlap(a, b) is True


def test_different_categories_do_not_overlap():
    a = [cond("category", ConditionOperator.EQ.value, "CONSUMABLE")]
    b = [cond("category", ConditionOperator.EQ.value, "CAPITAL")]
    assert conditions_overlap(a, b) is False


def test_intersecting_value_sets_overlap():
    a = [cond("category", ConditionOperator.IN.value, "A,B")]
    b = [cond("category", ConditionOperator.IN.value, "B,C")]
    assert conditions_overlap(a, b) is True


def test_separate_value_sets_do_not_overlap():
    a = [cond("category", ConditionOperator.IN.value, "A,B")]
    b = [cond("category", ConditionOperator.IN.value, "C,D")]
    assert conditions_overlap(a, b) is False


def test_conditions_on_unrelated_fields_overlap():
    """Nothing stops a document having quantity 200 and category CAPITAL at once."""
    a = [cond("quantity", ConditionOperator.GT.value, "100")]
    b = [cond("category", ConditionOperator.EQ.value, "CAPITAL")]
    assert conditions_overlap(a, b) is True


def test_one_contradicting_field_separates_the_rules():
    a = [cond("category", ConditionOperator.EQ.value, "CONSUMABLE", id=1),
         cond("quantity", ConditionOperator.GT.value, "100", id=2)]
    b = [cond("category", ConditionOperator.EQ.value, "CAPITAL", id=3),
         cond("quantity", ConditionOperator.GT.value, "200", id=4)]
    assert conditions_overlap(a, b) is False


def test_exclusion_operators_are_never_proof_of_separation():
    """NEQ is open-ended: "not CAPITAL" still covers CONSUMABLE, so these overlap."""
    a = [cond("category", ConditionOperator.NEQ.value, "CAPITAL")]
    b = [cond("category", ConditionOperator.EQ.value, "CONSUMABLE")]
    assert conditions_overlap(a, b) is True


def test_or_joined_conditions_are_treated_as_overlapping():
    """An OR widens a rule beyond what the per-field check models, so the safe answer
    is to report overlap rather than wrongly clear the pair."""
    a = [cond("category", ConditionOperator.EQ.value, "CONSUMABLE", id=1),
         cond("category", ConditionOperator.EQ.value, "SPARE",
              logic=ConditionLogic.OR.value, id=2)]
    b = [cond("category", ConditionOperator.EQ.value, "CAPITAL", id=3)]
    assert conditions_overlap(a, b) is True


def test_non_numeric_comparison_falls_back_to_overlap():
    a = [cond("site", ConditionOperator.GT.value, "north")]
    b = [cond("site", ConditionOperator.LT.value, "south")]
    assert conditions_overlap(a, b) is True
