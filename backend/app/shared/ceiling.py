"""A quantity that was asked for may come DOWN, never go up (2026-11-03).

A material request, a requisition and a quotation amendment each start from a
quantity somebody asked for: the shortfall the allocation could not cover, the
material request behind a requisition line, the quantity on the RFQ. Every later
change — an approver's revision, the raiser's correction, a buyer's edit of a draft,
a counter-offer — may lower that figure or leave it, and is refused if it raises it.
Raising it is new demand, and new demand is a new document that goes through its own
approval, not a number changed underneath a signature.

Pure: no database, so the three modules that enforce it phrase the refusal the same
way, and the rule is tested without one.
"""
from decimal import Decimal

from app.core.exceptions import ValidationError


def _d(value) -> Decimal:
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value or 0))


def fmt(value) -> str:
    """12 not 12.000, 2.5 not 2.500."""
    text = format(_d(value).normalize(), "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def ceiling_of(requested, current) -> Decimal:
    """The line's ceiling: what it asked for, or — for a row saved before the ceiling
    was recorded — what it holds now, which is the most it has ever been allowed."""
    return _d(requested) if requested is not None else _d(current)


def assert_not_raised(quantity, cap, *, label: str, uom: str | None = None,
                      asked: str = "was requested") -> None:
    """Refuse `quantity` above `cap`, naming the item and the limit."""
    if cap is None:
        return
    quantity, cap = _d(quantity), _d(cap)
    if quantity > cap:
        unit = f" {uom}" if uom else ""
        raise ValidationError(
            f"{label}: {fmt(cap)}{unit} {asked} — the quantity can be reduced or left "
            f"as it is, never increased (you entered {fmt(quantity)}{unit}).")
