"""Stock by storage location, as a file — and the question that must be asked first.

"Download what is on Floor 1" is two different files, and the difference between them
IS the report. `whs_warehouse_locations` is a tree, and stock sits at whatever rung it
was put down on (rule 14): a pallet of drums standing at the end of a lane is recorded
against the lane, everything else on that floor is recorded against the forty bays
beneath it. So there are two honest answers:

* **LOCATION** — stock recorded against that one row and nothing else. On a FLOOR or a
  LANE this is routinely EMPTY, because a floor is not somewhere anybody puts a carton
  down.
* **HIERARCHY** — that location and every location beneath it, to any depth. This is
  what somebody asking for "the Floor 1 report" nearly always means.

Neither is right for every rung, which is why the screen asks instead of guessing.
What makes the asking honest is that BOTH answers are counted before either is
downloaded (`report_scopes`), so the choice reads "Only F1 — nothing is stored here
directly" beside "F1 and everything inside — 40 locations, 122 items, 3,204 units".
Two unlabelled radio buttons are the same choice with the answer hidden, and the
person who picks wrong finds out by opening an empty spreadsheet.

**Every sentence on those two options is SERVED from here**, for the same reason the
capacity verdicts are (rule 14): a screen that can word a scope differently from the
file that scope produces will eventually word it wrongly, and nothing will say so.

Three things this report deliberately does NOT do the way the grid above it does:

* **It counts reserved stock.** The grid reads `available_qty > 0`, so a bay whose
  every unit is reserved against an issue reads as empty — true of the DECISION the
  grid supports (what can I give out), false of the question this file answers (what
  is standing in this location). The file takes `total_qty > 0`, carries Available,
  Reserved and On hand as separate columns, and says so in its own header block.
* **It applies floor access.** `locations.floor_location_ids_for_user` bounds which
  locations a position may see, and a download is the one place where getting that
  wrong leaves the building. `inventory.get_item_locations`, which feeds the grid,
  does not apply it today — so for a floor-restricted user this file can be SHORTER
  than the grid above it. That is the grid being too wide, not the file too narrow.
* **It is capped.** `MAX_REPORT_ROWS` rows, stated on the file's face when it bites,
  because a truncated extract that does not admit to being truncated is read as a
  complete one.
"""
from __future__ import annotations

import asyncio
import csv
import io
import re
import unicodedata
from collections import defaultdict
from collections.abc import Mapping, Sequence
from datetime import date, datetime
from decimal import Decimal
from urllib.parse import quote

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.modules.inventory import locations as stock_locations
from app.modules.inventory.models import NO_BIN, Stock
from app.modules.inventory.service import warehouse_ids_for_user
from app.modules.warehouse import storage_types
from app.shared.models.master import Item
from app.shared.models.warehouse import Warehouse, WarehouseLocation
from app.shared.time import now as ist_now, today as ist_today

SCOPE_LOCATION = "LOCATION"
SCOPE_HIERARCHY = "HIERARCHY"
SCOPES = (SCOPE_LOCATION, SCOPE_HIERARCHY)

#: Same guard `get_item_locations` walks its ancestry with. A tree that has somehow
#: grown a cycle must not hang the request; twenty rungs is far past floor→lane→rack→
#: shelf→bay and anything deeper is a data defect, not a building.
MAX_DEPTH = 20

#: Matches the reports module. A bigger extract is a job for the queue that is still
#: outstanding (`docs/09_CAPACITY_BACKLOG.md`), not for a longer request.
MAX_REPORT_ROWS = 20_000

#: A stock row can name many units. The whole list in one cell makes a column nothing
#: can read; the count plus the first few is what a person actually checks against.
SERIALS_SHOWN = 12

Col = tuple[str, str]

COLUMNS: tuple[Col, ...] = (
    ("location_code", "Location"),
    ("location_name", "Location name"),
    ("location_kind", "Kind"),
    ("depth", "Level"),
    ("parent_code", "Sits inside"),
    ("location_path", "Full path"),
    ("item_code", "Item code"),
    ("item_name", "Item"),
    ("uom_code", "UOM"),
    ("batch_no", "Batch"),
    ("expiry_date", "Expiry"),
    ("days_to_expiry", "Days left"),
    ("shelf_life", "Shelf life"),
    ("project_name", "Project"),
    ("asset_code", "Asset code"),
    ("serial_numbers", "Serial / IMEI"),
    ("available_qty", "Available"),
    ("reserved_qty", "Reserved"),
    ("total_qty", "On hand"),
)

SUMMARY_COLUMNS: tuple[Col, ...] = (
    ("location_code", "Location"),
    ("location_name", "Location name"),
    ("location_kind", "Kind"),
    ("depth", "Level"),
    ("location_path", "Full path"),
    ("items", "Items"),
    ("lines", "Stock lines"),
    ("available_qty", "Available"),
    ("reserved_qty", "Reserved"),
    ("total_qty", "On hand"),
)


# --------------------------------------------------------------------------- #
# The tree. Pure, so the scope arithmetic is testable without a database.
# --------------------------------------------------------------------------- #

def child_index(rows: Sequence) -> dict[int | None, list[int]]:
    """`{parent id: [child ids]}`, with the roots under `None`."""
    children: dict[int | None, list[int]] = defaultdict(list)
    for row in rows:
        parent = int(row.parent_id) if row.parent_id else None
        children[parent].append(int(row.id))
    return dict(children)


def descendants(children: Mapping[int | None, Sequence[int]], root_id: int) -> set[int]:
    """Every location beneath `root_id`, to any depth, EXCLUDING the root itself.

    Breadth-first over a `seen` set rather than recursion: a mis-parented row that
    points at its own ancestor is a data defect somebody will eventually create, and
    the report it breaks should be this one, not the whole request.
    """
    found: set[int] = set()
    frontier = [root_id]
    for _ in range(MAX_DEPTH):
        if not frontier:
            break
        nxt: list[int] = []
        for parent in frontier:
            for child in children.get(parent, ()):
                if child == root_id or child in found:
                    continue
                found.add(child)
                nxt.append(child)
        frontier = nxt
    return found


def ancestry(by_id: Mapping[int, object], loc_id: int | None) -> list:
    """The trail from the top of the building down to `loc_id`, inclusive."""
    trail: list = []
    current = by_id.get(int(loc_id)) if loc_id else None
    for _ in range(MAX_DEPTH):
        if current is None:
            break
        trail.append(current)
        parent = getattr(current, "parent_id", None)
        current = by_id.get(int(parent)) if parent else None
    trail.reverse()
    return trail


def depth_of(by_id: Mapping[int, object], loc_id: int | None) -> int:
    """1 for a top-level location, 2 for its children, and so on. 0 for the warehouse
    itself, which is not a row in this table."""
    return len(ancestry(by_id, loc_id))


# --------------------------------------------------------------------------- #
# Wording. Served, never composed in a screen.
# --------------------------------------------------------------------------- #

def _plural(count: int, one: str, many: str | None = None) -> str:
    return f"{count:,} {one if count == 1 else (many or one + 's')}"


def _place_name(row) -> str:
    """How a location is named in a sentence: the code, with its name when it has one
    and the two differ. `F1 — Ground floor` reads; `F1 — F1` does not."""
    code = (getattr(row, "code", None) or "").strip()
    name = (getattr(row, "name", None) or "").strip()
    if name and name.lower() != code.lower():
        return f"{code} — {name}"
    return code or name or "this location"


def scope_sentence(place: str, scope: str, *, descendant_count: int) -> str:
    """One line naming exactly which locations a file covers. The file header and the
    button on the screen both print this, so they cannot drift."""
    if scope == SCOPE_HIERARCHY:
        if descendant_count:
            return (f"{place}, and all {_plural(descendant_count, 'location')} "
                    f"inside it")
        return f"{place} — nothing is stored inside it"
    return f"{place} only — nothing from inside it"


# --------------------------------------------------------------------------- #
# Reading the shelf
# --------------------------------------------------------------------------- #

async def _tree(db: AsyncSession, warehouse_id: int):
    rows = (await db.execute(
        select(WarehouseLocation)
        .where(WarehouseLocation.warehouse_id == warehouse_id)
    )).scalars().all()
    return {int(r.id): r for r in rows}, child_index(rows), rows


async def _resolve(db: AsyncSession, *, warehouse_id: int, location_id: int | None,
                   user):
    """The warehouse, the tree, the chosen location and the floor-access bound.

    One place, because every entry point here needs all four and a second copy of the
    permission half is how one of them ends up without it.
    """
    allowed = await warehouse_ids_for_user(db, user)
    if allowed is not None and warehouse_id not in allowed:
        raise ValidationError("Warehouse is outside your assigned office")

    warehouse = await db.get(Warehouse, warehouse_id)
    if warehouse is None:
        raise NotFoundError(f"Warehouse {warehouse_id} not found")

    by_id, children, _rows = await _tree(db, warehouse_id)
    location = None
    if location_id is not None:
        location = by_id.get(int(location_id))
        if location is None:
            raise NotFoundError(
                f"Storage location {location_id} is not in {warehouse.name}")

    floors = await stock_locations.floor_location_ids_for_user(db, user)
    if floors is not None and location is not None and int(location.id) not in floors:
        raise ValidationError(
            f"{_place_name(location)} is outside the floors you have access to")
    return warehouse, by_id, children, location, floors


def scope_location_ids(children: Mapping[int | None, Sequence[int]],
                       location_id: int | None, scope: str) -> set[int] | None:
    """Which locations a scope covers. `None` means the whole warehouse — no location
    was chosen, so there is nothing to narrow to and both scopes are the same file.

    An unknown scope is REFUSED, not read as the narrow one. Falling through to
    `{root}` would hand somebody who mistyped the parameter an almost-empty file that
    looks like a complete one, which is the failure this whole module exists to stop.
    """
    if scope not in SCOPES:
        raise ValidationError(
            f"Scope must be one of {', '.join(SCOPES)}, not {scope!r}")
    if location_id is None:
        return None
    root = int(location_id)
    if scope == SCOPE_HIERARCHY:
        return {root, *descendants(children, root)}
    return {root}


async def _stock_rows(db: AsyncSession, *, warehouse_id: int,
                      location_ids: set[int] | None, floors: set[int] | None,
                      item_id: int | None, limit: int | None = None) -> list[Stock]:
    stmt = select(Stock).where(Stock.warehouse_id == warehouse_id,
                               Stock.total_qty > 0)
    if item_id is not None:
        stmt = stmt.where(Stock.item_id == item_id)
    bounded = location_ids
    if floors is not None:
        # Bulk storage has no location row (`bin_id` is NO_BIN), so it belongs to no
        # floor and a floor-restricted position does not see it.
        bounded = floors if bounded is None else (bounded & floors)
    if bounded is not None:
        if not bounded:
            return []
        stmt = stmt.where(Stock.bin_id.in_(bounded))
    stmt = stmt.order_by(Stock.bin_id, Stock.item_id,
                         Stock.expiry_date.is_(None), Stock.expiry_date.asc(),
                         Stock.id)
    if limit is not None:
        stmt = stmt.limit(limit)
    return list((await db.execute(stmt)).scalars().all())


async def _scope_tallies(db: AsyncSession, *, warehouse_id: int,
                         location_ids: set[int] | None, floors: set[int] | None,
                         item_id: int | None) -> list[tuple[int, int, int, Decimal]]:
    """`[(location id, item id, stock lines, on hand)]` — one row per (location, item).

    The same bounds `_stock_rows` applies, so the counts on the buttons describe
    exactly the file the button produces. Anything that narrows one and not the other
    puts a number on a button that the download then contradicts.
    """
    stmt = (select(Stock.bin_id, Stock.item_id, func.count(),
                   func.coalesce(func.sum(Stock.total_qty), 0))
            .where(Stock.warehouse_id == warehouse_id, Stock.total_qty > 0)
            .group_by(Stock.bin_id, Stock.item_id))
    if item_id is not None:
        stmt = stmt.where(Stock.item_id == item_id)
    bounded = location_ids
    if floors is not None:
        bounded = floors if bounded is None else (bounded & floors)
    if bounded is not None:
        if not bounded:
            return []
        stmt = stmt.where(Stock.bin_id.in_(bounded))
    return [(int(b or NO_BIN), int(i), int(n), Decimal(str(q or 0)))
            for b, i, n, q in (await db.execute(stmt)).all()]


def _shelf_life(days: int | None, *, is_asset: bool = False) -> str:
    """The expiry bucket the screen shows, in words a spreadsheet can be sorted on.

    A raw date is arithmetic homework; "Expired 12 days ago" is the decision. Both are
    in the file — this column and `Expiry` — because a person reads this one and a
    pivot table reads the other.
    """
    if days is None:
        return "No expiry recorded"
    word = "Warranty" if is_asset else "Expiry"
    if days < 0:
        return f"{word} ended {_plural(-days, 'day')} ago"
    if days == 0:
        return f"{word} ends today"
    if days <= 30:
        return f"Within 30 days ({_plural(days, 'day')})"
    if days <= 90:
        return f"Within 90 days ({_plural(days, 'day')})"
    return f"{_plural(days, 'day')} left"


def _serials(value) -> str | None:
    """`stk_balance.serial_number` is a JSON LIST — one lot holds many units. Rendered
    as a count plus the first few, because the whole list in one cell is a column
    nobody can read and a lot of 500 makes the file unopenable."""
    if not value:
        return None
    codes = [str(v) for v in value if v] if isinstance(value, (list, tuple)) \
        else [str(value)]
    if not codes:
        return None
    if len(codes) <= SERIALS_SHOWN:
        return ", ".join(codes)
    rest = len(codes) - SERIALS_SHOWN
    return ", ".join(codes[:SERIALS_SHOWN]) + f" … (+{rest:,} more)"


async def build_rows(db: AsyncSession, *, warehouse_id: int, location_id: int | None,
                     scope: str, item_id: int | None, user) -> tuple[dict, list[dict]]:
    """(meta, rows) for one scope — the file's contents, before it is a file."""
    if scope not in SCOPES:
        raise ValidationError(
            f"Scope must be one of {', '.join(SCOPES)}, not {scope!r}")

    warehouse, by_id, children, location, floors = await _resolve(
        db, warehouse_id=warehouse_id, location_id=location_id, user=user)
    covered = scope_location_ids(children, location_id, scope)
    stock = await _stock_rows(db, warehouse_id=warehouse_id, location_ids=covered,
                              floors=floors, item_id=item_id,
                              limit=MAX_REPORT_ROWS + 1)
    truncated = len(stock) > MAX_REPORT_ROWS
    stock = stock[:MAX_REPORT_ROWS]

    label_kind = await storage_types.labeller(db)
    items = {}
    item_ids = {int(r.item_id) for r in stock}
    if item_ids:
        items = {int(i.id): i for i in (await db.execute(
            select(Item).where(Item.id.in_(item_ids)))).scalars().all()}

    today = ist_today()
    rows: list[dict] = []
    for balance in stock:
        bin_id = int(balance.bin_id or NO_BIN)
        place = by_id.get(bin_id)
        trail = ancestry(by_id, bin_id) if place is not None else []
        item = items.get(int(balance.item_id))
        expiry = balance.expiry_date
        if isinstance(expiry, datetime):
            expiry = expiry.date()
        days = (expiry - today).days if isinstance(expiry, date) else None
        rows.append({
            "location_id": bin_id or None,
            "location_code": (place.code if place is not None
                              else (balance.bin_code or "Bulk storage")),
            "location_name": place.name if place is not None else None,
            "location_kind": (label_kind(place.storage_type_id, place.bin_type)
                              if place is not None else None),
            "depth": len(trail) or None,
            "parent_code": trail[-2].code if len(trail) > 1 else None,
            "location_path": " › ".join(
                [warehouse.name or "", *(p.name or p.code for p in trail)]).strip(" ›"),
            "item_id": int(balance.item_id),
            "item_code": (item.code if item is not None else None)
                         or balance.item_code,
            "item_name": (item.name if item is not None else None)
                         or balance.item_name,
            "uom_code": balance.uom_code
                        or (getattr(item, "uom_code", None) if item else None),
            "batch_no": balance.batch_no,
            "expiry_date": expiry,
            "days_to_expiry": days,
            "shelf_life": _shelf_life(
                days, is_asset=bool(getattr(item, "is_asset", False))),
            "project_name": balance.project_name,
            "asset_code": balance.asset_code or balance.consumable_code,
            "serial_numbers": _serials(balance.serial_number),
            "available_qty": balance.available_qty or Decimal("0"),
            "reserved_qty": balance.reserved_qty or Decimal("0"),
            "total_qty": balance.total_qty or Decimal("0"),
        })

    item_filter = None
    if item_id is not None:
        named = items.get(int(item_id))
        item_filter = (f"{named.code} — {named.name}" if named
                       else f"Item {item_id}")
    place_label = _place_name(location) if location is not None \
        else (warehouse.name or "this warehouse")
    meta = {
        "warehouse_id": warehouse_id,
        "warehouse_name": warehouse.name,
        "location_id": int(location.id) if location is not None else None,
        "location_code": location.code if location is not None else None,
        "location_label": place_label,
        "location_kind": (label_kind(location.storage_type_id, location.bin_type)
                          if location is not None else None),
        "location_path": " › ".join(
            [warehouse.name or "",
             *(p.name or p.code for p in ancestry(by_id, location_id))]).strip(" ›"),
        "scope": scope,
        "scope_sentence": scope_sentence(
            place_label, scope,
            descendant_count=len(descendants(children, int(location.id)))
            if location is not None else 0)
        if location is not None else f"Every storage location in {warehouse.name}",
        "item_filter": item_filter,
        "locations_with_stock": len({r["location_id"] for r in rows}),
        "items": len({r["item_id"] for r in rows}),
        "total_qty": sum((r["total_qty"] for r in rows), Decimal("0")),
        "available_qty": sum((r["available_qty"] for r in rows), Decimal("0")),
        "reserved_qty": sum((r["reserved_qty"] for r in rows), Decimal("0")),
        "truncated": truncated,
        "floor_restricted": floors is not None,
    }
    return meta, rows


def summarise(rows: Sequence[Mapping]) -> list[dict]:
    """One line per location: what that bay holds, without its batches.

    A hierarchy file is long by design, and the first question anybody asks of it —
    which bays is this stock actually in — is a pivot table they should not have to
    build.
    """
    by_place: dict[int | None, dict] = {}
    for row in rows:
        key = row["location_id"]
        bucket = by_place.setdefault(key, {
            "location_code": row["location_code"],
            "location_name": row["location_name"],
            "location_kind": row["location_kind"],
            "depth": row["depth"],
            "location_path": row["location_path"],
            "_items": set(),
            "lines": 0,
            "available_qty": Decimal("0"),
            "reserved_qty": Decimal("0"),
            "total_qty": Decimal("0"),
        })
        bucket["_items"].add(row["item_id"])
        bucket["lines"] += 1
        for field in ("available_qty", "reserved_qty", "total_qty"):
            bucket[field] += row[field]
    out = []
    for bucket in by_place.values():
        bucket["items"] = len(bucket.pop("_items"))
        out.append(bucket)
    out.sort(key=lambda b: (b["depth"] or 0, b["location_code"] or ""))
    return out


# --------------------------------------------------------------------------- #
# The two options, counted before either is downloaded
# --------------------------------------------------------------------------- #

async def report_scopes(db: AsyncSession, *, warehouse_id: int,
                        location_id: int | None, item_id: int | None,
                        user) -> dict:
    """What each of the two downloads would contain, so the choice is informed.

    Both scopes are counted off the same read, so they cannot disagree about a putaway
    that landed between two queries — the pair being consistent is the whole point of
    showing them side by side.

    GROUPED in SQL, not loaded and counted in Python. This runs on every click in the
    location browser, and a floor's subtree is every stock row under it; the grouped
    form returns one row per (location, item) instead, which is what the counts are
    made of anyway and is bounded by the size of the building rather than by how many
    batches are standing in it.
    """
    warehouse, by_id, children, location, floors = await _resolve(
        db, warehouse_id=warehouse_id, location_id=location_id, user=user)

    inside = descendants(children, int(location.id)) if location is not None else set()
    covered = scope_location_ids(children, location_id, SCOPE_HIERARCHY)
    grouped = await _scope_tallies(db, warehouse_id=warehouse_id,
                                   location_ids=covered, floors=floors,
                                   item_id=item_id)

    here_id = int(location.id) if location is not None else None

    def tally(predicate) -> dict:
        picked = [g for g in grouped if predicate(g[0])]
        return {
            "rows": sum(g[2] for g in picked),
            # DISTINCT across the scope: one item in nine bays is one item, and
            # summing each bay's own item count would report it as nine.
            "items": len({g[1] for g in picked}),
            "locations": len({g[0] for g in picked}),
            "total_qty": sum((g[3] for g in picked), Decimal("0")),
        }

    whole = tally(lambda _: True)
    here = tally(lambda b: b == here_id) if here_id is not None else dict(whole)
    place = _place_name(location) if location is not None \
        else (warehouse.name or "this warehouse")

    # A location with nothing inside it: the two files are byte-for-byte the same, and
    # offering them as a choice invites somebody to look for a difference that is not
    # there.
    identical = location is None or not inside

    if location is None:
        # No location picked, so there is no narrowing to offer and nothing to say
        # about what is "inside": both scopes are the whole warehouse. Running the
        # per-location wording here produced "nothing is stored inside CENTRAL
        # WAREHOUSE-1 — so this is the whole of it", which is false about a building
        # holding 779,580 units and reads as a broken report rather than a whole one.
        title = f"Everything in {place}"
        sentence = f"Every storage location in {place}"
        hint = (f"{_plural(whole['locations'], 'location')} holding "
                f"{_plural(whole['items'], 'item')}. Pick a location on the left to "
                f"narrow it down." if whole["rows"]
                else f"No stock is recorded anywhere in {place}.")
        options = [
            {
                "key": key, "title": title, "sentence": sentence, "hint": hint,
                "locations_in_scope": len(by_id), **whole,
                "is_empty": whole["rows"] == 0, "same_as_other": True,
            }
            for key in SCOPES
        ]
    else:
        options = [
            {
                "key": SCOPE_LOCATION,
                "title": f"Only {place}",
                "sentence": scope_sentence(place, SCOPE_LOCATION,
                                           descendant_count=len(inside)),
                "hint": _location_hint(here, whole, place, inside),
                "locations_in_scope": 1,
                **here,
                "is_empty": here["rows"] == 0,
                "same_as_other": identical,
            },
            {
                "key": SCOPE_HIERARCHY,
                "title": (f"{place} and everything inside" if inside
                          else f"{place} (nothing inside it)"),
                "sentence": scope_sentence(place, SCOPE_HIERARCHY,
                                           descendant_count=len(inside)),
                "hint": _hierarchy_hint(whole, place, inside),
                "locations_in_scope": len(inside) + 1,
                **whole,
                "is_empty": whole["rows"] == 0,
                "same_as_other": identical,
            },
        ]
    # What the screen should land on. A rung that holds nothing itself but has stock
    # beneath it is the ordinary case for a floor, and defaulting it to the empty file
    # is how somebody concludes a full floor is empty.
    recommended = SCOPE_HIERARCHY if (inside and whole["rows"] > here["rows"]) \
        else SCOPE_LOCATION
    for option in options:
        option["recommended"] = option["key"] == recommended

    return {
        "warehouse_id": warehouse_id,
        "warehouse_name": warehouse.name,
        "location_id": here_id,
        "location_code": location.code if location is not None else None,
        "location_name": location.name if location is not None else None,
        "location_label": place,
        "location_kind": (await storage_types.labeller(db))(
            location.storage_type_id, location.bin_type) if location is not None
            else None,
        "location_path": [warehouse.name or "",
                          *(p.name or p.code for p in ancestry(by_id, location_id))],
        "depth": depth_of(by_id, here_id),
        "child_count": len(children.get(here_id, ())) if location is not None
                       else len(children.get(None, ())),
        "descendant_count": len(inside),
        "item_filter": item_id,
        "floor_restricted": floors is not None,
        "row_cap": MAX_REPORT_ROWS,
        "options": options,
    }


def _location_hint(here: Mapping, whole: Mapping, place: str,
                   inside: set[int]) -> str:
    """Why somebody would pick — or must not pick — the narrow file.

    The sentence that matters is the one for a floor: it holds nothing itself, its
    file is empty, and without being told so the person downloads it and reads an
    empty spreadsheet as an empty floor.
    """
    if not inside:
        return f"Nothing is stored inside {place}, so this is the whole of it."
    if here["rows"] == 0 and whole["rows"] > 0:
        return (f"Nothing is recorded against {place} itself — all "
                f"{_plural(whole['locations'], 'location')} holding stock are inside "
                f"it. This file would be empty.")
    if here["rows"] == 0:
        return f"Nothing is recorded against {place} itself."
    return (f"Only what is booked to {place} itself. Leaves out "
            f"{_plural(whole['rows'] - here['rows'], 'line')} held in the "
            f"{_plural(len(inside), 'location')} inside it.")


def _hierarchy_hint(whole: Mapping, place: str, inside: set[int]) -> str:
    if not inside:
        return f"Same file — {place} has no locations inside it."
    if whole["rows"] == 0:
        return (f"{place} and the {_plural(len(inside), 'location')} inside it are "
                f"all empty.")
    return (f"{_plural(whole['locations'], 'location')} holding "
            f"{_plural(whole['items'], 'item')}, everywhere under {place}.")


# --------------------------------------------------------------------------- #
# The file
# --------------------------------------------------------------------------- #

_HEADER_FILL = "1F3A5F"
_TITLE_COLOUR = "1F3A5F"
_META_COLOUR = "5B6B7F"
_WARN_COLOUR = "B7791F"
_MAX_COL_WIDTH = 46
_TITLE = "SCM ERP — Stock by Storage Location"


def _clean(value):
    """DB value -> something CSV and openpyxl can both carry."""
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime):
        return value.strftime("%d %b %Y %H:%M")
    if isinstance(value, date):
        return value.isoformat()
    return value


def header_block(meta: Mapping, *, actor: str | None) -> list[list[str]]:
    """What this file is, which locations it covers and who pulled it.

    Rows rather than a comment prefix, so it survives an Excel round-trip — and so the
    scope is stated ON the file. A stock extract with no scope on it is a column of
    numbers somebody will later attribute to the wrong floor.
    """
    lines = [
        [_TITLE],
        [meta["scope_sentence"]],
        [],
        ["Warehouse", meta["warehouse_name"] or "—"],
        ["Storage location", meta["location_label"]],
        ["Kind", meta["location_kind"] or "—"],
        ["Full path", meta["location_path"] or "—"],
        ["Scope", "This location and everything inside it"
                  if meta["scope"] == SCOPE_HIERARCHY else "This location only"],
        ["Item filter", meta["item_filter"] or "All items"],
        ["Generated at", ist_now().strftime("%d %b %Y %H:%M IST")],
        ["Generated by", actor or "—"],
        [],
        ["Locations holding stock", f"{meta['locations_with_stock']:,}"],
        ["Distinct items", f"{meta['items']:,}"],
        ["Stock lines in this file", f"{meta.get('row_count', 0):,}"],
        ["On hand", f"{meta['total_qty']:,}"],
        ["Of which available", f"{meta['available_qty']:,}"],
        ["Of which reserved", f"{meta['reserved_qty']:,}"],
        # Said out loud because the Available/Reserved split is the one place this file
        # and the grid it was pulled from give different totals.
        ["Note", "Includes stock reserved against another document, which the "
                 "Stock Segregation grid leaves out."],
    ]
    if meta.get("floor_restricted"):
        lines.append(["Note", "Limited to the floors you have access to — another "
                              "person may pull a longer file."])
    if meta.get("truncated"):
        lines.append(["TRUNCATED", f"Stopped at {MAX_REPORT_ROWS:,} lines. Narrow by "
                                   f"item or pick a location further in."])
    lines.append([])
    return lines


#: Typographic characters this module puts into a filename, and the plain spellings
#: for the ASCII half of the Content-Disposition header. Mapped rather than stripped:
#: NFKD does not decompose an em dash, so "ignore" would silently eat it and leave
#: "SCM Stock  F1", with the gap where the dash was.
_ASCII_SWAPS = {"—": "-", "–": "-", "›": ">", "·": "-", "…": "...", " ": " "}


def ascii_filename(filename: str) -> str:
    """The same name with nothing outside ASCII in it.

    Accented characters keep their letter (NFKD drops the combining mark); anything
    with no plain spelling at all is dropped. Never empty: a `filename=""` is a
    download the browser names `download`.
    """
    for fancy, plain in _ASCII_SWAPS.items():
        filename = filename.replace(fancy, plain)
    folded = unicodedata.normalize("NFKD", filename)
    stripped = folded.encode("ascii", "ignore").decode("ascii")
    # A quote or a backslash would end the quoted-string early and let the rest of
    # the name be read as header parameters.
    stripped = stripped.replace('"', "").replace("\\", "").strip()
    return stripped or "stock-report"


def content_disposition(filename: str) -> str:
    """The download header, in both spellings of the name.

    HTTP headers are LATIN-1. Starlette encodes them with no fallback, so a header
    carrying this module's em dash raises `UnicodeEncodeError` — and it does so in
    `Response.__init__`, AFTER the workbook has been built, which surfaces as a bare
    500 on a request that had already done all of its work. A warehouse name or a
    location code is free text and may hold anything at all, so the fix is not to
    change the dash.

    `filename=` carries the ASCII fallback for anything ancient; `filename*=` carries
    the real name, percent-encoded per RFC 5987, and is what every browser of the last
    fifteen years actually uses. Both are latin-1 safe by construction.
    """
    plain = ascii_filename(filename)
    encoded = quote(filename, safe="")
    return f"attachment; filename=\"{plain}\"; filename*=UTF-8''{encoded}"


def _filename(meta: Mapping, extension: str) -> str:
    stamp = ist_now().strftime("%d-%b-%Y %H%M")
    where = meta["location_code"] or meta["warehouse_name"] or "Warehouse"
    shape = "with everything inside" if meta["scope"] == SCOPE_HIERARCHY \
        else "this location only"
    # Windows refuses these outright, and a location code is free text.
    safe = re.sub(r'[\\/:*?"<>|]+', "-", f"{where}").strip() or "Warehouse"
    return f"SCM Stock — {safe} ({shape}) {stamp}.{extension}"


async def export_csv(db: AsyncSession, *, warehouse_id: int, location_id: int | None,
                     scope: str, item_id: int | None, actor: str | None,
                     user) -> tuple[str, str]:
    meta, rows = await build_rows(db, warehouse_id=warehouse_id,
                                  location_id=location_id, scope=scope,
                                  item_id=item_id, user=user)
    meta = {**meta, "row_count": len(rows)}
    return await asyncio.to_thread(_build_csv, meta, rows, actor)


def _build_csv(meta: Mapping, rows: Sequence[Mapping], actor) -> tuple[str, str]:
    buffer = io.StringIO()
    # Excel on Windows opens \r\n cleanly; \n alone puts everything on one line.
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerows(header_block(meta, actor=actor))
    writer.writerow([label for _key, label in COLUMNS])
    for row in rows:
        writer.writerow(["" if (v := _clean(row.get(key))) is None else v
                         for key, _label in COLUMNS])
    return _filename(meta, "csv"), buffer.getvalue()


async def export_xlsx(db: AsyncSession, *, warehouse_id: int, location_id: int | None,
                      scope: str, item_id: int | None, actor: str | None,
                      user) -> tuple[str, bytes]:
    meta, rows = await build_rows(db, warehouse_id=warehouse_id,
                                  location_id=location_id, scope=scope,
                                  item_id=item_id, user=user)
    meta = {**meta, "row_count": len(rows)}
    # Off the event loop for the same reason the reports exports are: building an
    # openpyxl workbook is CPU-bound from start to finish, and one person pulling a
    # 20,000-line floor used to stop every other request until it finished.
    return await asyncio.to_thread(_build_xlsx, meta, rows, actor)


def _sheet(sheet, columns: Sequence[Col], rows: Sequence[Mapping], *, head_row: int):
    """The styled grid: one accent, frozen panes, an autofilter and measured widths.

    The first thing anybody does with a stock extract is sort it by quantity or filter
    it to one item, and a sheet that arrives without a filter row makes them build one.
    """
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter

    fill = PatternFill("solid", start_color=_HEADER_FILL, end_color=_HEADER_FILL)
    edge = Side(style="thin", color="D5DAE2")
    for index, (_key, label) in enumerate(columns, start=1):
        cell = sheet.cell(row=head_row, column=index, value=label)
        cell.fill = fill
        cell.font = Font(bold=True, color="FFFFFF")
        cell.alignment = Alignment(vertical="center", wrap_text=True)

    for row in rows:
        sheet.append([_clean(row.get(key)) for key, _label in columns])

    for index, (key, label) in enumerate(columns, start=1):
        # Width from the widest value actually present, capped — a path column left
        # unclamped pushes every quantity off the screen.
        widest = max([len(label)]
                     + [len(str(_clean(r.get(key)) or "")) for r in rows[:500]])
        sheet.column_dimensions[get_column_letter(index)].width = min(
            _MAX_COL_WIDTH, max(11, widest + 2))
        for row_index in range(head_row + 1, head_row + 1 + len(rows)):
            sheet.cell(row=row_index, column=index).border = Border(bottom=edge)

    last = get_column_letter(len(columns))
    sheet.freeze_panes = f"A{head_row + 1}"
    sheet.auto_filter.ref = f"A{head_row}:{last}{head_row + len(rows)}"


def _build_xlsx(meta: Mapping, rows: Sequence[Mapping], actor) -> tuple[str, bytes]:
    from openpyxl import Workbook
    from openpyxl.styles import Font

    book = Workbook()
    sheet = book.active
    sheet.title = "Stock"

    block = header_block(meta, actor=actor)
    for line in block:
        sheet.append(line)
    sheet["A1"].font = Font(bold=True, size=14, color=_TITLE_COLOUR)
    sheet["A2"].font = Font(italic=True, color=_META_COLOUR)
    for index, line in enumerate(block[3:], start=4):
        sheet.cell(row=index, column=1).font = Font(bold=True, color=_META_COLOUR)
        warn = line and line[0] in ("TRUNCATED", "Note")
        sheet.cell(row=index, column=2).font = Font(
            color=_WARN_COLOUR if warn else _META_COLOUR, bold=bool(warn))

    _sheet(sheet, COLUMNS, rows, head_row=len(block) + 1)

    # A hierarchy file is long by design; the roll-up is the sheet most people open
    # first. Pointless on a single location, where it would be one line restating the
    # header.
    if meta["scope"] == SCOPE_HIERARCHY and meta["locations_with_stock"] > 1:
        summary = book.create_sheet("By location")
        summary.append([f"{_TITLE} — by location"])
        summary.append([meta["scope_sentence"]])
        summary.append([])
        summary["A1"].font = Font(bold=True, size=14, color=_TITLE_COLOUR)
        summary["A2"].font = Font(italic=True, color=_META_COLOUR)
        _sheet(summary, SUMMARY_COLUMNS, summarise(rows), head_row=4)

    stream = io.BytesIO()
    book.save(stream)
    return _filename(meta, "xlsx"), stream.getvalue()
