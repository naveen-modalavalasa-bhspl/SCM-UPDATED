"""Trays on a material issue line (MoM 2026-11-18, point 14).

The storekeeper picks a line in the order the shelf asks for it: the quantity, then
the lot (batch and location), then puts it into TRAYS — a tray number, how much goes
into it, and which codes (serial, IMEI, asset or consumable) went in. One pick can fill
any number of trays; one tray can hold several items, each listed on its own line.

The rules, checked on every save and again before submit and post:

- a tray has a number (typed or scanned) and a quantity above zero;
- one tray number appears once per pick — two entries of "T-04" on one line are one tray;
- one code is in one tray only, and a tray holds no more codes than its quantity;
- the trays of a pick add up to no more than the pick on SAVE (it is being filled), and
  to exactly the pick on SUBMIT and POST — a tray list that stops short leaves units
  in nobody's tray.

A pick with no trays is fine: trays are how a point that uses them says where things
went, never a requirement on a point that does not. Trays travel to the consignment,
the dispatch and the acknowledgement, and are never printed on the Delivery Challan.
"""
from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationError

ZERO = Decimal("0")


def _qty(value) -> Decimal:
    try:
        return Decimal(str(value if value is not None else 0))
    except Exception:  # noqa: BLE001
        return ZERO


def _fmt(value: Decimal) -> str:
    text = format(value.normalize(), "f")
    return text


def clean(trays, *, issued, label: str, line_codes: list[str] | None = None) -> list[dict] | None:
    """The trays as stored, or None for none. Refuses anything that cannot be a tray."""
    if not trays:
        return None
    out: list[dict] = []
    seen_trays: set[str] = set()
    seen_codes: dict[str, str] = {}
    allowed = {code for code in (line_codes or []) if code}
    for index, tray in enumerate(trays, start=1):
        get = tray.get if isinstance(tray, dict) else (lambda k, t=tray: getattr(t, k, None))
        number = str(get("tray_no") or "").strip()
        qty = _qty(get("quantity"))
        codes = [str(c).strip() for c in (get("codes") or []) if str(c or "").strip()]
        if not number:
            raise ValidationError(f"{label}: tray {index} has no tray number — type or scan it.")
        key = number.upper()
        if key in seen_trays:
            raise ValidationError(
                f"{label}: tray {number} is listed twice — put both quantities in one tray.")
        seen_trays.add(key)
        if qty <= ZERO:
            raise ValidationError(f"{label}: say how much goes into tray {number}.")
        if len(codes) > qty:
            raise ValidationError(
                f"{label}: tray {number} holds {_fmt(qty)} but {len(codes)} codes were put in it.")
        for code in codes:
            if code in seen_codes:
                raise ValidationError(
                    f"{label}: {code} is in tray {seen_codes[code]} and tray {number} — "
                    "a unit can be in one tray only.")
            if allowed and code not in allowed:
                raise ValidationError(f"{label}: {code} is not one of this pick's codes.")
            seen_codes[code] = number
        out.append({"tray_no": number, "quantity": float(qty), "codes": codes})
    total = sum((_qty(t["quantity"]) for t in out), ZERO)
    if total > _qty(issued):
        raise ValidationError(
            f"{label}: the trays hold {_fmt(total)} but the pick is {_fmt(_qty(issued))}.")
    return out


def assert_complete(issue) -> None:
    """Before submit and post: every pick that uses trays has all of it in them."""
    for line in issue.items:
        trays = line.trays or []
        if not trays:
            continue
        total = sum((_qty(t.get("quantity")) for t in trays), ZERO)
        issued = _qty(line.issued_qty)
        if total != issued:
            label = f"Line {line.line_no} ({line.item_name or line.item_code})"
            short = issued - total
            raise ValidationError(
                f"{label}: {_fmt(abs(short))} {'not yet in a tray' if short > 0 else 'too many in the trays'} — "
                f"the trays hold {_fmt(total)} of {_fmt(issued)}.")


def tray_for(trays, code: str | None) -> str | None:
    """The tray a code went into, if one says so."""
    if not code:
        return None
    for tray in trays or []:
        if code in (tray.get("codes") or []):
            return tray.get("tray_no")
    return None


def tray_numbers(trays) -> list[str]:
    return [t.get("tray_no") for t in trays or [] if t.get("tray_no")]


async def by_issue_line(db: AsyncSession, line_ids) -> dict[int, list[dict]]:
    """{issue line id: its trays} for the lines that have any."""
    from app.modules.warehouse import models as m
    ids = {int(i) for i in line_ids if i}
    if not ids:
        return {}
    rows = (await db.execute(
        select(m.MaterialIssueLine.id, m.MaterialIssueLine.trays)
        .where(m.MaterialIssueLine.id.in_(ids), m.MaterialIssueLine.trays.isnot(None))
    )).all()
    return {int(line_id): list(trays) for line_id, trays in rows if trays}


def split_for_pieces(parent_trays, pieces: list[dict]) -> list[list[dict] | None]:
    """Hand one parent pick's trays to the floor pieces cut from it (2026-11-20).

    `pieces` is each piece line in order: {"qty": what it issues, "codes": the codes it
    holds}. A CODE decides its tray: the unit is on that piece's floor, so the tray it
    was put into goes with it. What is left of each piece is then filled from the trays'
    UNCODED room, in tray order — the same way the storekeeper filled them. A tray cut
    across two pieces appears on both, each with its own share.

    A piece the trays cannot cover in full gets None rather than a short list: post
    refuses a pick whose trays do not hold all of it, and a floor piece must never be
    stranded by a tray plan made before the split.
    """
    trays = [{"tray_no": t.get("tray_no"), "codes": list(t.get("codes") or []),
              "free": _qty(t.get("quantity")) - len(t.get("codes") or [])}
             for t in (parent_trays or []) if t.get("tray_no")]
    if not trays:
        return [None for _ in pieces]
    tray_of = {code: t["tray_no"] for t in trays for code in t["codes"]}
    by_no = {t["tray_no"]: t for t in trays}
    out: list[list[dict] | None] = []
    for piece in pieces:
        need = _qty(piece.get("qty"))
        mine: dict[str, dict] = {}
        for code in piece.get("codes") or []:
            no = tray_of.pop(code, None)
            if no is None or need <= ZERO:
                continue
            entry = mine.setdefault(no, {"tray_no": no, "quantity": ZERO, "codes": []})
            entry["quantity"] += 1
            entry["codes"].append(code)
            by_no[no]["codes"].remove(code)
            need -= 1
        for tray in trays:
            if need <= ZERO:
                break
            take = min(tray["free"], need)
            if take <= ZERO:
                continue
            tray["free"] -= take
            need -= take
            entry = mine.setdefault(tray["tray_no"], {"tray_no": tray["tray_no"], "quantity": ZERO, "codes": []})
            entry["quantity"] += take
        if need > ZERO:
            # Coded room no piece claimed (a code that went to no floor) is still room.
            for tray in trays:
                if need <= ZERO:
                    break
                spare = [c for c in tray["codes"] if c in tray_of]
                take = min(_qty(len(spare)), need)
                if take <= ZERO:
                    continue
                for code in spare[:int(take)]:
                    tray_of.pop(code, None)
                    tray["codes"].remove(code)
                need -= take
                entry = mine.setdefault(tray["tray_no"], {"tray_no": tray["tray_no"], "quantity": ZERO, "codes": []})
                entry["quantity"] += take
        order = [t["tray_no"] for t in trays]
        out.append(None if need > ZERO or not mine else [
            {"tray_no": e["tray_no"], "quantity": float(e["quantity"]), "codes": e["codes"]}
            for e in sorted(mine.values(), key=lambda e: order.index(e["tray_no"]))])
    return out
