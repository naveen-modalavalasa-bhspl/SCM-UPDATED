"""How finely a unit may be divided, and the one split rule that respects it.

`mst_uom.decimal_places` is 3 on every live row — the column default, never set by
anyone — so it says nothing about the unit and is deliberately not read here. What the
unit MEASURES does say something: nobody issues 5.7 gloves, while 5.7 grams is
ordinary. That lives in `mst_uom.uom_class`, which is already mapped.

The live mirror spells the class two ways: the seeded masters say COUNT / PACKAGING,
HCM's own list says "Quantity" (UOM-NOS, UOM-BOX). Both mean whole units, so the
comparison is case-folded and covers all three spellings. Anything else — Weight,
Volume, Length, Area — keeps the three decimals NUMERIC(16,3) can hold.

`share_out` is here rather than in a module because two modules split the same way:
approvals divides an approved total across the indents that asked for an item, and
indents divides stock across the lines competing for it. One implementation means the
number an approver is shown and the number a storekeeper reserves round identically.
"""

from collections.abc import Iterable
from decimal import ROUND_DOWN, Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.shared.models.master import Uom

#: Classes whose quantities only exist in whole units, in every spelling the live
#: mst_uom carries. Compared case-folded.
WHOLE_UNIT_CLASSES = {"COUNT", "PACKAGING", "QUANTITY"}

#: What `NUMERIC(16,3)` holds — the cap for anything genuinely divisible.
MAX_DECIMALS = 3


def _d(value) -> Decimal:
    """Decimal from anything a caller might hold, floats included."""
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value or 0))


def decimals_for(uom_class: str | None) -> int:
    """Decimal places this class of unit may carry. Unknown class → the full three:
    a unit nobody classified must not silently start rounding people's quantities."""
    return 0 if (uom_class or "").strip().upper() in WHOLE_UNIT_CLASSES else MAX_DECIMALS


def quantum(decimals: int) -> Decimal:
    """The smallest step of the unit — 1 for a countable one, 0.001 for the rest."""
    return Decimal(1).scaleb(-max(0, int(decimals)))


def quantize(value, decimals: int = MAX_DECIMALS) -> Decimal:
    """Round DOWN to the unit's step.

    Down, always: every other quantity door in the system rounds down (see
    `approvals.service._quantize`), so a number that has already cleared a ceiling can
    never grow back over it on the way in.
    """
    return _d(value).quantize(quantum(decimals), rounding=ROUND_DOWN)


async def decimals_by_code(db: AsyncSession, codes: Iterable[str | None]) -> dict[str, int]:
    """{uom_code: decimals} for the codes given, in one query.

    Documents snapshot `uom_code`, not `uom_id`, so this is keyed on the code — but
    what they snapshot is not always a code. 14 live items carry `NOS` and one carries
    `ml`: the unit's NAME, since `UOM-NOS` is named "nos" and `UOM-ML` is named "ml".
    An exact-code lookup missed every one of them, fell back to three decimals, and
    split 33 countable items into 4.643 and 1.857 — quantities nobody can hand over.

    So: match the code, else the code case-folded, else the NAME case-folded. Anything
    still unmatched (`g`, `Kg` — units nobody has added) keeps MAX_DECIMALS, which is
    the safe answer for a unit whose class is unknown.
    """
    wanted = {code for code in codes if code}
    if not wanted:
        return {}
    # Every unit, not a filtered set: the table is ~33 rows, and the fallbacks below
    # cannot be expressed as one IN clause across two columns.
    rows = (await db.execute(select(Uom.code, Uom.name, Uom.uom_class))).all()
    by_code = {row.code: row.uom_class for row in rows if row.code}
    folded = {row.code.strip().lower(): row.uom_class for row in rows if row.code}
    by_name = {row.name.strip().lower(): row.uom_class
               for row in rows if row.name}

    out: dict[str, int] = {}
    for code in wanted:
        key = code.strip().lower()
        if code in by_code:
            out[code] = decimals_for(by_code[code])
        elif key in folded:
            out[code] = decimals_for(folded[key])
        elif key in by_name:
            out[code] = decimals_for(by_name[key])
    return out


def share_out(
    total,
    weights: list,
    caps: list | None = None,
    decimals: int = MAX_DECIMALS,
) -> list[Decimal]:
    """Split `total` in proportion to `weights`, never past `caps`, losing nothing.

    Largest remainder (Hamilton), counted in whole steps of the unit: 45 across five
    equal 10s is 9/9/9/9/9 and 43 is 9/9/9/8/8 — never 8.6 five times, because an
    indent line is a quantity somebody has to physically issue. For a countable unit
    the step is 1, so a fractional share cannot be produced at all.

    `caps` is what makes an exclusion safe. Handing one indent's share to the rest must
    not push any of them past their own ceiling, so a share that would is trimmed to
    the ceiling and what it could not take is re-offered to whoever still has room.
    The loop ends when nothing is left or nobody can take any more — a total larger
    than every cap combined simply comes back short, which is the honest answer.
    """
    step = quantum(decimals)
    caps = caps if caps is not None else [None] * len(weights)
    weight_units = [max(Decimal("0"), _d(w)) for w in weights]
    cap_units: list[int | None] = [
        None if cap is None else int(quantize(cap, decimals) / step) for cap in caps
    ]

    given = [0] * len(weight_units)
    left = int(quantize(total, decimals) / step)
    open_rows = [
        i for i, weight in enumerate(weight_units)
        if weight > 0 and (cap_units[i] is None or cap_units[i] > 0)
    ]

    while left > 0 and open_rows:
        total_weight = sum(weight_units[i] for i in open_rows)
        if total_weight <= 0:
            break
        raw = {i: (weight_units[i] / total_weight) * left for i in open_rows}
        base = {i: int(raw[i]) for i in open_rows}
        spare = left - sum(base.values())
        # Biggest fraction first; a tie goes to the bigger request, then to the earlier
        # row, so the same numbers always produce the same split.
        for i in sorted(open_rows, key=lambda i: (-(raw[i] - base[i]), -weight_units[i], i)):
            if spare <= 0:
                break
            base[i] += 1
            spare -= 1

        moved = False
        for i in list(open_rows):
            room = base[i] if cap_units[i] is None else min(base[i], cap_units[i] - given[i])
            if room > 0:
                given[i] += room
                left -= room
                moved = True
            if cap_units[i] is not None and given[i] >= cap_units[i]:
                open_rows.remove(i)
        if not moved:
            break

    return [Decimal(units) * step for units in given]
