"""The quote scorer — pure functions, no database.

Worth its own file because this arithmetic decides who gets paid, and it is the one
piece of the transport/RFQ chain that can be tested without a MySQL round trip. Every
case below is a rule stated in `shared/evaluation.py`'s docstrings; if one of these
fails, a comparison sheet somewhere is recommending the wrong carrier.
"""
from decimal import Decimal

import pytest

from app.shared import evaluation
from app.shared.enums import DEFAULT_EVALUATION_METHOD, EvaluationMethod

C = evaluation.Candidate


def d(value) -> Decimal:
    return Decimal(str(value))


def _ranks(rows):
    """{ref: rank}, so a test asserts placement rather than list order."""
    return {row.ref: row.rank for row in rows}


def test_method_of_falls_back_to_the_default():
    # A document raised before evaluation methods existed carries None.
    assert evaluation.method_of(None) == DEFAULT_EVALUATION_METHOD
    # A bad string must not make the sheet unreadable.
    assert evaluation.method_of("NONSENSE") == DEFAULT_EVALUATION_METHOD
    assert evaluation.method_of("lowest_price") == EvaluationMethod.LOWEST_PRICE.value


def test_is_valid():
    assert evaluation.is_valid("WEIGHTED_SCORE")
    assert evaluation.is_valid("weighted_score")
    assert not evaluation.is_valid("CHEAPEST")
    assert not evaluation.is_valid(None)


def test_describe_offers_exactly_one_default():
    rows = evaluation.describe()
    assert {row["value"] for row in rows} == {m.value for m in EvaluationMethod}
    assert sum(1 for row in rows if row["is_default"]) == 1


def test_no_candidates_ranks_nothing():
    assert evaluation.rank([], EvaluationMethod.LOWEST_PRICE.value) == []
    # Priced at zero everywhere is a data-entry error, not a set of bargains.
    assert evaluation.rank([C(ref=1, price=d(0), landed_cost=d(0))], None) == []


def test_lowest_price_ignores_the_freight_on_top():
    """The whole reason price and landed cost are separate inputs."""
    cheap_headline = C(ref=1, price=d(100), landed_cost=d(400))
    dear_headline = C(ref=2, price=d(200), landed_cost=d(210))

    by_price = _ranks(evaluation.rank([cheap_headline, dear_headline],
                                      EvaluationMethod.LOWEST_PRICE.value))
    by_landed = _ranks(evaluation.rank([cheap_headline, dear_headline],
                                       EvaluationMethod.LOWEST_LANDED_COST.value))

    assert by_price[1] == 1, "cheapest headline wins on price"
    assert by_landed[2] == 1, "cheapest all-in wins on landed cost"


def test_shortest_lead_time_ignores_money_entirely():
    rows = evaluation.rank([
        C(ref=1, price=d(100), landed_cost=d(100), lead_days=9),
        C(ref=2, price=d(900), landed_cost=d(900), lead_days=2),
    ], EvaluationMethod.SHORTEST_LEAD_TIME.value)
    assert _ranks(rows)[2] == 1


def test_a_quote_with_no_lead_time_is_treated_as_the_worst():
    """A silent quote must never win "fastest" by defaulting to zero days."""
    rows = evaluation.rank([
        C(ref=1, price=d(100), landed_cost=d(100), lead_days=None),
        C(ref=2, price=d(100), landed_cost=d(100), lead_days=5),
    ], EvaluationMethod.SHORTEST_LEAD_TIME.value)
    assert _ranks(rows)[2] == 1


def test_weighted_score_lets_cost_outweigh_a_small_delay():
    # Half the price for one extra day: 70/30 says take the cheaper one.
    rows = evaluation.rank([
        C(ref=1, price=d(100), landed_cost=d(100), lead_days=3),
        C(ref=2, price=d(200), landed_cost=d(200), lead_days=2),
    ], EvaluationMethod.WEIGHTED_SCORE.value)
    assert _ranks(rows)[1] == 1


def test_higher_score_is_always_better_whichever_method():
    """The one invariant every reader of a comparison sheet relies on."""
    candidates = [
        C(ref=1, price=d(100), landed_cost=d(150), lead_days=4),
        C(ref=2, price=d(120), landed_cost=d(130), lead_days=2),
        C(ref=3, price=d(90), landed_cost=d(300), lead_days=9),
    ]
    for method in EvaluationMethod:
        rows = evaluation.rank(candidates, method.value)
        scores = [row.score for row in rows]
        assert scores == sorted(scores, reverse=True), method.value
        assert [row.rank for row in rows] == [1, 2, 3]
        assert rows[0].is_recommended
        assert not any(row.is_recommended for row in rows[1:])


def test_the_best_quote_always_scores_one():
    """Scores are normalised against the best in the set, not an absolute."""
    rows = evaluation.rank([
        C(ref=1, price=d(500), landed_cost=d(500), lead_days=5),
        C(ref=2, price=d(1000), landed_cost=d(1000), lead_days=5),
    ], EvaluationMethod.LOWEST_LANDED_COST.value)
    assert rows[0].score == Decimal("1")
    assert rows[1].score == Decimal("0.5")


def test_ties_keep_submission_order():
    """First to quote wins a dead heat — defensible, and stable across reloads."""
    rows = evaluation.rank([
        C(ref=7, price=d(100), landed_cost=d(100), lead_days=3),
        C(ref=9, price=d(100), landed_cost=d(100), lead_days=3),
    ], EvaluationMethod.WEIGHTED_SCORE.value)
    assert [row.ref for row in rows] == [7, 9]


@pytest.mark.parametrize("method", [m.value for m in EvaluationMethod])
def test_a_zero_priced_quote_never_scores_best(method):
    """Zero is an error, not a bargain — it must not divide by zero either."""
    rows = evaluation.rank([
        C(ref=1, price=d(0), landed_cost=d(0), lead_days=1),
        C(ref=2, price=d(250), landed_cost=d(250), lead_days=4),
    ], method)
    # The zero-priced row is dropped from scoring entirely (no price at all), so the
    # only real quote is the recommendation.
    assert rows[0].ref == 2
    assert rows[0].is_recommended
