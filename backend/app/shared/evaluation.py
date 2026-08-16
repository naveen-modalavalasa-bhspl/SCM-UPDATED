"""Ranking a set of competing quotes.

Both buying chains do the same arithmetic on different tables: procurement compares
vendor quotations for an RFQ, logistics compares carrier quotes for a shipment. The
inputs differ (`grand_total` and `delivery_days` on one, `freight_amount` and
`transit_days` on the other), so this module takes neither model — the caller flattens
its rows into `Candidate` and gets the ranking back.

Kept in shared/ rather than in procurement because logistics sits LATER in the import
chain and may not be imported back (rule 5). Duplicating the scoring in both modules
was the alternative, and two copies of a formula that decides who gets paid is exactly
the kind of drift an auditor finds.

The one invariant every method holds to: **higher score is better**. A reader of a
comparison sheet should never have to know which method produced it to see who won.
"""
from dataclasses import dataclass
from decimal import Decimal

from app.shared.enums import (
    DEFAULT_EVALUATION_METHOD,
    WEIGHTED_COST_SHARE,
    WEIGHTED_TIME_SHARE,
    EvaluationMethod,
)

ONE = Decimal("1")
ZERO = Decimal("0")


def _d(value) -> Decimal:
    return Decimal(str(value or 0))


@dataclass
class Candidate:
    """One quote, flattened to the four numbers any method needs.

    `price` is the headline figure the vendor named; `landed_cost` is what the company
    actually pays once freight, other charges and tax are in. They are separate inputs
    because LOWEST_PRICE and LOWEST_LANDED_COST genuinely rank the same set
    differently — a cheap quote with expensive freight loses one and wins the other,
    and collapsing them would hide that.
    """
    ref: int
    price: Decimal
    landed_cost: Decimal
    # None means the quote did not say. Treated as the WORST in the set rather than as
    # zero — a silent quote must never win "fastest" by default.
    lead_days: int | None = None


@dataclass
class Ranked:
    ref: int
    score: Decimal
    rank: int
    is_recommended: bool


def method_of(stored: str | None) -> str:
    """The method to use, given whatever the document has on it.

    A document raised before evaluation methods existed has None, and gets the
    default. An unrecognised value gets the default too rather than raising: a bad
    string in one column must not make a comparison sheet unreadable.
    """
    candidate = (stored or "").upper()
    if candidate in {m.value for m in EvaluationMethod}:
        return candidate
    return DEFAULT_EVALUATION_METHOD


def is_valid(method: str | None) -> bool:
    return (method or "").upper() in {m.value for m in EvaluationMethod}


def describe() -> list[dict]:
    """The methods, as the dropdown shows them. Served rather than hardcoded in the
    screen so the label and the arithmetic cannot disagree."""
    return [
        {"value": EvaluationMethod.LOWEST_LANDED_COST.value,
         "label": "Lowest landed cost",
         "help": "Price plus freight, other charges and tax — what it actually "
                 "costs. The default.",
         "is_default": True},
        {"value": EvaluationMethod.LOWEST_PRICE.value,
         "label": "Lowest price",
         "help": "The headline figure only, before freight and tax.",
         "is_default": False},
        {"value": EvaluationMethod.SHORTEST_LEAD_TIME.value,
         "label": "Fastest delivery",
         "help": "Fewest days to deliver. Price is ignored.",
         "is_default": False},
        {"value": EvaluationMethod.WEIGHTED_SCORE.value,
         "label": "Best value",
         "help": (f"Landed cost and delivery time together, "
                  f"{int(WEIGHTED_COST_SHARE * 100)}/"
                  f"{int(WEIGHTED_TIME_SHARE * 100)}, each scored against the best "
                  "quote received."),
         "is_default": False},
    ]


def _ratio(best: Decimal, actual: Decimal) -> Decimal:
    """best/actual, clamped so a zero or missing figure cannot divide by zero or
    score infinitely well. A quote of zero is a data-entry error, not a bargain."""
    if actual <= ZERO:
        return ZERO
    return best / actual


def rank(candidates: list[Candidate], method: str | None = None) -> list[Ranked]:
    """Score and order. Ties keep the caller's order, which is normally submission
    order — first to quote wins a dead heat, which is both defensible and stable."""
    method = method_of(method)
    priced = [c for c in candidates if c.landed_cost > ZERO or c.price > ZERO]
    if not priced:
        return []

    # A quote that did not state a lead time is scored as strictly WORSE than the
    # slowest one that did — `max + 1`, not `max`. Using the worst stated value made
    # it tie with the slowest quote, and a tie is broken by submission order, so a
    # silent quote could still come first on "fastest". Saying nothing must never be
    # as good as saying something.
    stated = [c.lead_days for c in priced if c.lead_days is not None]
    worst_days = Decimal(max(stated)) + ONE if stated else ONE
    days = {c.ref: (Decimal(c.lead_days) if c.lead_days is not None else worst_days)
            for c in priced}

    best_price = min((c.price for c in priced if c.price > ZERO), default=ONE)
    best_landed = min((c.landed_cost for c in priced if c.landed_cost > ZERO),
                      default=ONE)
    best_days = min(days.values(), default=ONE) or ONE

    scores: dict[int, Decimal] = {}
    for candidate in priced:
        if method == EvaluationMethod.LOWEST_PRICE.value:
            scores[candidate.ref] = _ratio(best_price, candidate.price)
        elif method == EvaluationMethod.SHORTEST_LEAD_TIME.value:
            scores[candidate.ref] = _ratio(best_days, days[candidate.ref])
        elif method == EvaluationMethod.WEIGHTED_SCORE.value:
            cost = _ratio(best_landed, candidate.landed_cost)
            time = _ratio(best_days, days[candidate.ref])
            scores[candidate.ref] = (cost * _d(WEIGHTED_COST_SHARE)
                                     + time * _d(WEIGHTED_TIME_SHARE))
        else:  # LOWEST_LANDED_COST
            scores[candidate.ref] = _ratio(best_landed, candidate.landed_cost)

    # `sorted` is stable, so equal scores stay in the order they were handed in.
    ordered = sorted(priced, key=lambda c: scores[c.ref], reverse=True)
    return [
        Ranked(ref=candidate.ref, score=round(scores[candidate.ref], 4),
               rank=position, is_recommended=position == 1)
        for position, candidate in enumerate(ordered, start=1)
    ]
