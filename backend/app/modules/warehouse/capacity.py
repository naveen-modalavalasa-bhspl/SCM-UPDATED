"""How full a storage location is, in cubic metres — read, never stored.

`whs_warehouse_locations.capacity_volume` has existed since the DB team built the
table and nothing has ever read it, because the goods that go into a bin had no
volume of their own. `mst_items.unit_volume_cbm` (and the three dimensions behind it)
is the missing half; this module is the arithmetic that joins them.

Three rules shape everything here.

**Occupancy is READ, never stored.** It is `SUM(stock in this location and everything
under it) x volume per unit`, computed on demand — the same invariant the fulfilment
desk runs on. There is no `occupied_volume` column to drift, no hook to fire when
stock moves, and nothing to rebuild after a correction: a putaway, an issue, a
transfer or a stock adjustment changes the answer by existing. Adding a stored
counter later would reintroduce exactly the class of defect the allocation rewrite
removed, so do not.

**A full location never blocks the work.** Capacity here is advice, loudly given and
recorded, and every caller is expected to carry on regardless — the goods are
physically on the floor whether or not the master data says they fit, and refusing
the putaway only means the stock sits in a bin nobody wrote down. The one thing that
would make this worse than useless is silence, so `status` and the sentences beside
it are served from here rather than assembled in a screen.

**An unmeasured item has NO volume, not zero.** Zero would report a packed bin as
empty, which reads as "there is room" — the one answer worse than "nobody has
measured this". Every result therefore carries `unmeasured_items` / `unmeasured_qty`
and an `is_partial` flag, and the screens say so.
"""
from decimal import Decimal, InvalidOperation

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError
from app.shared.models.master import Item
from app.shared.models.warehouse import BIN_TYPES, Bin

ZERO = Decimal("0")
#: cm3 -> m3. A carton measured 40 x 30 x 25 is 0.03 cbm, not 30000 of anything.
CUBIC_CM_PER_CBM = Decimal("1000000")
#: Above this share of capacity a location is called TIGHT — near enough to full that
#: the storekeeper should be told before they walk over, not after.
TIGHT_AT = Decimal("0.9")

#: What a location can be told about itself. Served, never mapped in a screen.
STATUS_OK = "OK"
STATUS_TIGHT = "TIGHT"
STATUS_FULL = "FULL"
STATUS_OVER = "OVER"
STATUS_NO_CAPACITY = "NO_CAPACITY"
STATUS_UNMEASURED = "UNMEASURED"

IN = "IN"
OUT = "OUT"

CBM = "m³"


def _d(value) -> Decimal:
    """Decimal or zero. MySQL DECIMALs arrive as strings and a bad one must not 500."""
    if value is None:
        return ZERO
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return ZERO


def unit_volume(item: Item | None) -> Decimal | None:
    """Cubic metres taken by ONE unit of the item, in the item's own UOM, or None.

    The typed-in figure wins over the dimensions: somebody who entered both meant the
    figure, and a carton's outer dimensions overstate a soft good that packs down.
    None — not zero — when the item has neither, so a caller can tell "takes no room"
    (which nothing does) from "nobody has measured this".
    """
    if item is None:
        return None
    explicit = _d(getattr(item, "unit_volume_cbm", None))
    if explicit > ZERO:
        return explicit
    length = _d(getattr(item, "length_cm", None))
    width = _d(getattr(item, "width_cm", None))
    height = _d(getattr(item, "height_cm", None))
    if length > ZERO and width > ZERO and height > ZERO:
        return (length * width * height) / CUBIC_CM_PER_CBM
    return None


def fill_status(capacity: Decimal | None, occupied: Decimal) -> str:
    """What to call a location holding `occupied` out of `capacity`.

    One function so the putaway meter, the suggestion chips and the location tree
    cannot disagree about what "full" means — they did not have to agree while only
    one of them existed, which is exactly how they would drift.
    """
    if capacity is None or capacity <= ZERO:
        return STATUS_NO_CAPACITY
    if occupied > capacity:
        return STATUS_OVER
    if occupied == capacity:
        return STATUS_FULL
    if occupied >= capacity * TIGHT_AT:
        return STATUS_TIGHT
    return STATUS_OK


def _q(value: Decimal | None, places: str = "0.000001") -> Decimal | None:
    """Rounded for display. Volumes are quoted to six places because a small part in a
    big warehouse is a genuinely small number, not because anyone measures that far."""
    return None if value is None else value.quantize(Decimal(places))


async def subtree_ids(db: AsyncSession, location_id: int) -> list[int]:
    """This location and every location under it.

    A capacity may be set on a rack as easily as on a bin, and stock only ever sits in
    a bin — so "how full is this rack" is the sum of the bins beneath it. Walked
    breadth-first through `parent_id` for the reason `service.bin_tree` gives: derived
    ancestry cannot disagree with the tree it describes. The visited set stops a cycle
    in the data from becoming an infinite loop.
    """
    found: list[int] = [location_id]
    seen: set[int] = {location_id}
    frontier = [location_id]
    while frontier:
        children = [
            row[0] for row in (await db.execute(
                select(Bin.id).where(Bin.parent_id.in_(frontier))
            )).all()
        ]
        frontier = [cid for cid in children if cid not in seen]
        seen.update(frontier)
        found.extend(frontier)
    return found


async def occupied_volume(db: AsyncSession, location_ids: list[int]) -> dict:
    """What the stock standing in these locations takes up.

    Returns the volume plus what could not be counted, because a total that silently
    omits the items nobody measured is a total that reads as the truth and is not.
    """
    from app.modules.inventory.models import Stock

    empty = {"volume": ZERO, "unmeasured_items": 0, "unmeasured_qty": ZERO,
             "measured_items": 0}
    if not location_ids:
        return empty

    rows = (await db.execute(
        select(Stock.item_id, func.coalesce(func.sum(Stock.total_qty), 0))
        .where(Stock.bin_id.in_(location_ids), Stock.total_qty > 0)
        .group_by(Stock.item_id)
    )).all()
    if not rows:
        return empty

    items = {
        i.id: i for i in (await db.execute(
            select(Item).where(Item.id.in_([r[0] for r in rows]))
        )).scalars().all()
    }

    total, unmeasured_items, unmeasured_qty, measured = ZERO, 0, ZERO, 0
    for item_id, qty in rows:
        each = unit_volume(items.get(item_id))
        if each is None:
            unmeasured_items += 1
            unmeasured_qty += _d(qty)
            continue
        measured += 1
        total += each * _d(qty)
    return {"volume": total, "unmeasured_items": unmeasured_items,
            "unmeasured_qty": unmeasured_qty, "measured_items": measured}


def _describe(status: str, *, code: str, capacity, free, over_by, move_volume,
              is_partial: bool, direction: str) -> tuple[str, str]:
    """The headline and the sentence under it.

    Wording lives here so the putaway screen, the issue screen and anything added
    later say the same thing about the same state — the rule the alert catalog exists
    for. A screen picks the colour from `status`; it never writes the words.
    """
    caveat = (
        " Some of what is already here has no measured volume, so the real figure is "
        "higher than this." if is_partial else ""
    )
    if status == STATUS_NO_CAPACITY:
        return ("No volume capacity set",
                f"Nobody has told {code} how much it holds, so there is nothing to "
                f"check against. Set a volume capacity on the location under "
                f"Warehouse masters to turn this on.")
    if status == STATUS_UNMEASURED:
        return ("Item volume not measured",
                f"This item carries no dimensions and no unit volume, so its share of "
                f"{code} cannot be worked out. Add them under Masters > Items to see "
                f"the space it uses.")
    if status == STATUS_OVER:
        return (f"{code} does not have room",
                f"This puts {over_by} {CBM} more into {code} than it holds. Nothing is "
                f"stopped — place it and the overflow is recorded — but the location "
                f"will be over its stated capacity.{caveat}")
    if status == STATUS_FULL:
        return (f"{code} will be exactly full",
                f"This fills the last of {capacity} {CBM}. Nothing more fits here "
                f"afterwards.{caveat}")
    # "after this" is a lie when nothing is being moved — this is then simply a
    # reading of the shelf, which is what the location screens ask for.
    when = " after this" if move_volume else ""
    if status == STATUS_TIGHT:
        return (f"{code} is nearly full",
                f"{free} {CBM} of {capacity} {CBM} is left{when}.{caveat}")
    if direction == OUT and move_volume:
        return (f"{code} frees up {move_volume} {CBM}",
                f"{free} {CBM} of {capacity} {CBM} free once this leaves.{caveat}")
    return (f"{code} has room",
            f"{free} {CBM} of {capacity} {CBM} free{when}.{caveat}")


async def _resolve_moves(db: AsyncSession, moves: list[dict]) -> list[dict]:
    """Turn `{item_id, qty, direction}` into the volume each move actually shifts.

    A move whose item has no measured volume keeps its place in the list with
    `volume=None`, rather than being dropped: the screen has to be able to say "two of
    these five lines could not be measured", and a silently shorter list says the
    opposite.
    """
    if not moves:
        return []
    ids = {int(mv["item_id"]) for mv in moves if mv.get("item_id")}
    items = {
        i.id: i for i in (await db.execute(
            select(Item).where(Item.id.in_(ids))
        )).scalars().all()
    } if ids else {}

    resolved: list[dict] = []
    for mv in moves:
        item = items.get(int(mv["item_id"])) if mv.get("item_id") else None
        each = unit_volume(item)
        qty = _d(mv.get("qty"))
        direction = (mv.get("direction") or IN).upper()
        volume = None if each is None else each * qty
        resolved.append({
            "item_id": item.id if item else None,
            "item_name": item.name if item else None,
            "item_code": item.code if item else None,
            "uom_code": item.uom_code if item else None,
            "qty": _q(qty, "0.001"),
            "direction": direction,
            "unit_volume_cbm": _q(each),
            "volume": volume,
            "signed": None if volume is None else (
                volume if direction == IN else -volume
            ),
        })
    return resolved


async def location_occupancy(
    db: AsyncSession,
    location_id: int,
    *,
    item_id: int | None = None,
    qty: Decimal | float | str | None = None,
    direction: str = IN,
    moves: list[dict] | None = None,
) -> dict:
    """The whole capacity picture for one location, optionally for proposed moves.

    With nothing proposed this answers "how full is this". With `item_id`/`qty` it also
    answers "and what happens if I put this here" (`direction=IN`) or "what does taking
    this out give me back" (`direction=OUT`) — one function, because putaway and
    material issue are the same question asked from either side, and two would drift.

    `moves` is the same question for a whole document: an issue takes several lines out
    of one bin and the freed space is their sum, so they are netted here rather than
    asked for one at a time and added up in a screen.
    """
    location = await db.get(Bin, location_id)
    if location is None:
        raise NotFoundError(f"Location {location_id} was not found")

    if moves is None:
        moves = ([{"item_id": item_id, "qty": qty, "direction": direction}]
                 if item_id else [])
    resolved = await _resolve_moves(db, moves)

    ids = await subtree_ids(db, location.id)
    held = await occupied_volume(db, ids)

    capacity = _d(location.capacity_volume)
    capacity = capacity if capacity > ZERO else None
    occupied = held["volume"]

    measured = [mv for mv in resolved if mv["signed"] is not None]
    unmeasured_moves = [mv for mv in resolved if mv["signed"] is None]
    net = sum((mv["signed"] for mv in measured), ZERO)
    # Unsigned, because "this parcel is 0.6 m3" reads the same whichever way it is
    # going; `move_direction` says which way it moves the total.
    move_volume = abs(net) if measured else None
    move_direction = OUT if net < ZERO else IN

    projected = occupied + net
    # Taking more out than the arithmetic says is in there is a measurement gap, not a
    # negative shelf. Floored so the screen never shows minus one cubic metre.
    projected = projected if projected > ZERO else ZERO

    free = None if capacity is None else capacity - occupied
    projected_free = None if capacity is None else capacity - projected
    over_by = ZERO if (projected_free is None or projected_free >= ZERO) else -projected_free
    # The bar is drawn from measured stock alone, so it has to admit what it left out —
    # unmeasured goods already on the shelf, or an unmeasured line about to go on it.
    is_partial = held["unmeasured_items"] > 0 or bool(unmeasured_moves)

    # UNMEASURED outranks the fill verdict: a projection that could not count the very
    # line being entered is not a statement about whether it fits.
    status = (STATUS_UNMEASURED if (capacity is not None and resolved and not measured)
              else fill_status(capacity, projected))

    headline, detail = _describe(
        status,
        code=location.code,
        capacity=_q(capacity, "0.001"),
        free=_q(projected_free if projected_free and projected_free > ZERO else ZERO,
                "0.001"),
        over_by=_q(over_by, "0.001"),
        move_volume=_q(move_volume, "0.001"),
        is_partial=is_partial,
        direction=move_direction,
    )

    def pct(value: Decimal | None) -> float | None:
        if capacity is None or value is None:
            return None
        return float(round(value * 100 / capacity, 2))

    # The single-move fields the putaway screen reads. A document with several lines
    # has no one item or quantity, so they stay None and the screen shows `lines`.
    only = resolved[0] if len(resolved) == 1 else None

    return {
        "location_id": location.id,
        "location_code": location.code,
        "location_name": location.name,
        "bin_type": location.bin_type,
        "is_pickable": location.is_pickable,
        # A capacity set on a rack covers the bins under it, so the caller is told how
        # many locations this figure actually sums over.
        "counts_locations": len(ids),
        "capacity_volume": _q(capacity),
        "occupied_volume": _q(occupied),
        "free_volume": _q(free),
        "utilisation_pct": pct(occupied),
        "unmeasured_items": held["unmeasured_items"],
        "unmeasured_qty": _q(held["unmeasured_qty"], "0.001"),
        "measured_items": held["measured_items"],
        "unmeasured_lines": len(unmeasured_moves),
        "is_partial": is_partial,
        "item_id": only["item_id"] if only else None,
        "item_name": only["item_name"] if only else None,
        "unit_volume_cbm": only["unit_volume_cbm"] if only else None,
        "qty": only["qty"] if only else None,
        "direction": move_direction,
        "move_volume": _q(move_volume),
        "lines": [
            {**{k: mv[k] for k in ("item_id", "item_code", "item_name", "uom_code",
                                   "qty", "direction", "unit_volume_cbm")},
             "volume": _q(mv["volume"])}
            for mv in resolved
        ],
        "projected_volume": _q(projected),
        "projected_free_volume": _q(projected_free),
        "projected_pct": pct(projected),
        "over_by": _q(over_by),
        "status": status,
        "headline": headline,
        "detail": detail,
    }


async def occupancy_preview(db: AsyncSession, moves: list[dict]) -> list[dict]:
    """One occupancy row per location a document touches, netted over its lines.

    The material issue form asks this: a draft takes five lines out of three bins, and
    "what does this do to each of those bins" is three answers, not fifteen. Moves with
    no location are dropped — a line whose bin has not been chosen yet is not yet a
    claim on anybody's shelf.
    """
    grouped: dict[int, list[dict]] = {}
    for mv in moves or []:
        location_id = mv.get("location_id")
        if not location_id:
            continue
        grouped.setdefault(int(location_id), []).append(mv)
    rows = [await location_occupancy(db, location_id, moves=lines)
            for location_id, lines in grouped.items()]
    # Worst first: a shelf that will not take the load is the row the storekeeper has
    # to see, and it must not be the one below the fold.
    order = {STATUS_OVER: 0, STATUS_FULL: 1, STATUS_TIGHT: 2, STATUS_UNMEASURED: 3,
             STATUS_OK: 4, STATUS_NO_CAPACITY: 5}
    return sorted(rows, key=lambda r: (order.get(r["status"], 9), r["location_code"]))


async def bin_occupancy_map(db: AsyncSession, bins: list[Bin]) -> dict[int, dict]:
    """`{bin_id: {capacity, occupied, free, status}}` for a handful of bins, in two
    queries.

    The suggested-bin chips need "how much room is left" for every option at once, and
    calling `location_occupancy` per chip would be a subtree walk plus two queries
    each. Only real bins are summed — a suggestion is always a bin, so there is no
    subtree to roll up here.
    """
    from app.modules.inventory.models import Stock

    ids = [b.id for b in bins if b.id]
    if not ids:
        return {}

    rows = (await db.execute(
        select(Stock.bin_id, Stock.item_id, func.coalesce(func.sum(Stock.total_qty), 0))
        .where(Stock.bin_id.in_(ids), Stock.total_qty > 0)
        .group_by(Stock.bin_id, Stock.item_id)
    )).all()
    items = {
        i.id: i for i in (await db.execute(
            select(Item).where(Item.id.in_({r[1] for r in rows}))
        )).scalars().all()
    } if rows else {}

    held: dict[int, Decimal] = {}
    partial: set[int] = set()
    for bin_id, item_id, qty in rows:
        each = unit_volume(items.get(item_id))
        if each is None:
            partial.add(bin_id)
            continue
        held[bin_id] = held.get(bin_id, ZERO) + each * _d(qty)

    out: dict[int, dict] = {}
    for b in bins:
        capacity = _d(b.capacity_volume)
        capacity = capacity if capacity > ZERO else None
        occupied = held.get(b.id, ZERO)
        free = None if capacity is None else capacity - occupied
        out[b.id] = {
            "capacity_volume": _q(capacity),
            "occupied_volume": _q(occupied),
            "free_volume": _q(free),
            "utilisation_pct": (
                None if capacity is None
                else float(round(occupied * 100 / capacity, 2))
            ),
            "is_partial": b.id in partial,
            "status": fill_status(capacity, occupied),
        }
    return out


__all__ = [
    "BIN_TYPES", "IN", "OUT", "STATUS_FULL", "STATUS_NO_CAPACITY", "STATUS_OK",
    "STATUS_OVER", "STATUS_TIGHT", "STATUS_UNMEASURED", "bin_occupancy_map",
    "fill_status",
    "location_occupancy", "occupancy_preview", "occupied_volume", "subtree_ids",
    "unit_volume",
]
