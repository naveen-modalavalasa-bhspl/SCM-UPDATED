"""How a final payable figure is rounded, in one place.

A freight price is quoted whole and then has tax applied to it, so the number the
company actually pays is arithmetic rather than something anybody typed: a 4,830.51
base at 18% is 5,700.0018. Carried into a document that figure prints, exports and
reconciles as 5,700.00 in one place and 5,700.0018 in another, and nobody can say
which is the payable.

**The rounding happens at the CALCULATION, not at the display.** A screen that rounds
what it draws leaves the stored value unrounded, so the total on the page and the
total in the export disagree by paise and the ledger never balances against either.
`round_money` is called where the figure is derived, and every reader — the register,
the comparison sheet, the award, the exports and the reports — takes the same number
because they all read the same column.

Only ONE rule exists on purpose. Two rounding methods in one system means two answers
to "what do we owe", and the first time they differ is an argument with a carrier.
Changing the rule is changing these two constants, which is a deliberate, reviewable
edit rather than a per-screen decision or a setting somebody can flip mid-month while
half the open shipments were priced under the old rule.
"""
from decimal import ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_UP, Decimal

#: Standard round-off: .50 and above goes up, below stays. The other two the business
#: named are `ROUND_CEILING` (always up, the freight convention where a carrier bills
#: whole rupees in their own favour) and `ROUND_FLOOR` (always down).
ROUNDING_METHOD = ROUND_HALF_UP

#: WHOLE RUPEES. The paise are what the business asked to be rid of — 5,700.0018 is
#: reported and paid as 5,701 — and a freight invoice is not settled in paise. Set to
#: Decimal("0.01") to keep two places instead; nothing else has to change.
ROUNDING_STEP = Decimal("1")

METHODS = {
    "HALF_UP": ROUND_HALF_UP,
    "CEILING": ROUND_CEILING,
    "FLOOR": ROUND_FLOOR,
}


def round_money(amount: Decimal | float | int | None,
                *, method: str | None = None) -> Decimal:
    """The payable value of `amount` under the company's rounding rule.

    `None` is 0, not None: this returns something a column can hold and something
    arithmetic can continue from, and a missing price is a price of nothing.

    `method` overrides the default for a caller that genuinely needs a different one
    — a supplier contract that specifies always-up, say. It takes the NAME from
    `METHODS` rather than a `decimal` constant, so a caller cannot invent a rule that
    only exists at that call site.
    """
    value = amount if isinstance(amount, Decimal) else Decimal(str(amount or 0))
    rule = METHODS[method] if method else ROUNDING_METHOD
    return value.quantize(ROUNDING_STEP, rounding=rule)
