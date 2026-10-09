"""The tender's recommendation and the multi-carrier dispatch — pure, no database.

`shared/evaluation.py` decides who ranks first; this file covers what the RFQ desk is
then TOLD about that ranking — which quote is simply cheapest, which is simply
quickest, what the top one saves against the runner-up and what it gives away in days.
That is the whole reason the recommendation exists: a rank is one number hiding two
facts, and a desk that cannot see both is being handed a decision rather than shown
one.

No MySQL round trip needed for any of it, which is why it is a file of its own —
`_flag_best`, `_recommendation` and `_chosen_carriers` take plain dicts and namespaces.
"""
from types import SimpleNamespace

from app.modules.logistics import transport


def row(quote_id, *, cost, days=None, rank=1, score=1.0, carrier=None):
    """One line of a ranked comparison sheet, as `_rank_quotes` builds it."""
    return {
        "quote_id": quote_id, "carrier_id": quote_id * 10,
        "carrier_name": carrier or f"Carrier {quote_id}",
        "status": "SUBMITTED", "freight_amount": cost, "other_charges": 0.0,
        "tax_percent": 0.0, "landed_cost": cost, "transit_days": days,
        "vehicle_type": None, "valid_until": None, "remarks": None,
        "score": score, "rank": rank, "is_recommended": rank == 1,
    }


# --------------------------------------------------------------------------- #
#  Cheapest and fastest, flagged apart from the rank
# --------------------------------------------------------------------------- #

def test_cheapest_and_fastest_are_flagged_independently():
    rows = [row(1, cost=1000, days=5), row(2, cost=1200, days=2)]
    transport._flag_best(rows)

    assert (rows[0]["is_cheapest"], rows[0]["is_fastest"]) == (True, False)
    assert (rows[1]["is_cheapest"], rows[1]["is_fastest"]) == (False, True)


def test_ties_are_all_flagged_not_just_the_first():
    # Two carriers at the same price are both the cheapest; picking one of them to
    # wear the badge is arbitrary and reads as a ranking that was never made.
    rows = [row(1, cost=1000, days=4), row(2, cost=1000, days=4)]
    transport._flag_best(rows)

    assert [r["is_cheapest"] for r in rows] == [True, True]
    assert [r["is_fastest"] for r in rows] == [True, True]


def test_nobody_is_fastest_when_no_quote_stated_a_transit_time():
    rows = [row(1, cost=1000), row(2, cost=1200)]
    transport._flag_best(rows)

    assert [r["is_fastest"] for r in rows] == [False, False]
    assert rows[0]["is_cheapest"] is True


def test_a_silent_transit_time_never_wins_fastest():
    # A quote that said nothing must not beat one that committed to three days.
    rows = [row(1, cost=1000, days=None), row(2, cost=1200, days=3)]
    transport._flag_best(rows)

    assert rows[0]["is_fastest"] is False
    assert rows[1]["is_fastest"] is True


# --------------------------------------------------------------------------- #
#  The recommendation
# --------------------------------------------------------------------------- #

def test_no_quotes_means_no_recommendation():
    assert transport._recommendation([]) is None


def test_the_top_ranked_quote_is_the_recommendation():
    rows = [row(1, cost=1000, days=5, rank=1), row(2, cost=1200, days=2, rank=2)]
    transport._flag_best(rows)
    rec = transport._recommendation(rows)

    assert rec["quote_id"] == 1
    assert rec["runner_up"]["quote_id"] == 2


def test_saving_is_measured_against_the_next_best_price():
    rows = [row(1, cost=1000, days=5, rank=1), row(2, cost=1200, days=2, rank=2)]
    transport._flag_best(rows)
    rec = transport._recommendation(rows)

    assert rec["saving"] == 200
    # Cheapest and fastest are different carriers, so the desk is told what the
    # recommendation costs in time as well as what it saves in money.
    assert rec["is_trade_off"] is True
    assert rec["days_slower"] == 3
    assert rec["fastest"]["quote_id"] == 2


def test_no_trade_off_when_one_carrier_is_both_cheapest_and_fastest():
    rows = [row(1, cost=900, days=2, rank=1), row(2, cost=1200, days=4, rank=2)]
    transport._flag_best(rows)
    rec = transport._recommendation(rows)

    assert rec["is_trade_off"] is False
    assert rec["days_slower"] == 0
    assert (rec["is_cheapest"], rec["is_fastest"]) == (True, True)


def test_a_single_quote_has_no_runner_up_and_no_saving():
    # One price is a rate, not a competition. Inventing a saving against nothing is
    # exactly the number an auditor would ask where it came from.
    rows = [row(1, cost=1000, days=3, rank=1)]
    transport._flag_best(rows)
    rec = transport._recommendation(rows)

    assert rec["runner_up"] is None
    assert rec["saving"] is None
    assert rec["days_slower"] == 0


def test_days_slower_is_none_when_nobody_quoted_a_transit_time():
    # A comparison that invents a lead time is worse than one that admits it has none.
    rows = [row(1, cost=1000, rank=1), row(2, cost=1200, rank=2)]
    transport._flag_best(rows)
    rec = transport._recommendation(rows)

    assert rec["days_slower"] is None
    assert rec["fastest"] is None
    assert rec["saving"] == 200


def test_the_recommendation_can_lose_on_price():
    # Ranked by fastest delivery: the winner is the dearest quote, and the sheet has
    # to say so rather than quietly relabelling it "best price".
    rows = [row(1, cost=1500, days=1, rank=1), row(2, cost=900, days=6, rank=2)]
    transport._flag_best(rows)
    rec = transport._recommendation(rows)

    assert rec["quote_id"] == 1
    assert rec["is_cheapest"] is False
    assert rec["is_fastest"] is True
    # Negative: choosing speed costs 600 here, and that is the fact worth showing.
    assert rec["saving"] == -600


# --------------------------------------------------------------------------- #
#  Who a dispatch was sent to
# --------------------------------------------------------------------------- #

def test_plural_and_singular_carrier_fields_are_merged():
    data = SimpleNamespace(carrier_ids=[7, 9], carrier_id=3)
    assert transport._chosen_carriers(data) == [7, 9, 3]


def test_a_carrier_named_twice_is_invited_once():
    # `ix_lgs_quote_tr_carrier` is unique, so a duplicate would have been refused by
    # the database rather than ignored by the tender.
    data = SimpleNamespace(carrier_ids=[7, 9, 7], carrier_id=9)
    assert transport._chosen_carriers(data) == [7, 9]


def test_the_singular_field_alone_still_works():
    # Anything sending the old body — a courier booking, an older client — must keep
    # dispatching exactly as it did.
    data = SimpleNamespace(carrier_ids=[], carrier_id=4)
    assert transport._chosen_carriers(data) == [4]


def test_no_provider_named_at_all():
    data = SimpleNamespace(carrier_ids=None, carrier_id=None)
    assert transport._chosen_carriers(data) == []


def test_the_audit_line_names_every_partner_asked():
    assert transport._and_list(["Amazon"]) == "Amazon"
    assert transport._and_list(["Amazon", "Flipkart"]) == "Amazon and Flipkart"
    assert (transport._and_list(["Amazon", "Flipkart", "Misaba"])
            == "Amazon, Flipkart and Misaba")
    assert transport._and_list([]) == "the provider"
