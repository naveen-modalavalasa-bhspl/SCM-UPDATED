"""The 14 read feeds. All logic here; the router stays 3-5 lines a route (rule 2).

Every feed is `(SELECT, row -> dict)`. The SELECT is ordinary SQLAlchemy Core over the
mapped models — this module reads other modules' tables and writes none of them, the
same standing `reports` has.

Three rules of the ask shape all of this:

  * **Stable ids** (rule 8). Every feed is ordered by the primary key of its own table,
    so page 2 cannot repeat a row page 1 already returned, and nothing is keyed on a
    row's position.
  * **`is_active` must filter correctly** (rule 6). One helper, `_active`, applied the
    same way everywhere: absent means every row, `true`/`false` means exactly that.
  * **`updated_since`** (rule 11) is applied where the table has a change column and is
    ignored where it has none — `mst_uom` and `mst_item_categories` carry no timestamp,
    so a delta pull of them returns the whole (tiny) master rather than nothing.

Quantities go out as JSON numbers, not strings: the ask's examples are numbers and its
client parses them as such. Decimal -> float is exact for the 3-decimal quantities and
4-decimal rates these columns hold.
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Callable, Mapping

from sqlalchemy import Select, and_, func, literal, or_, select, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationError
from app.modules.indents.models import Indent, IndentItem
from app.modules.integrations.adapters.cams.enums import DEFAULT_PAGE_SIZE, Tier
from app.modules.integrations.enums import MAX_EXT_PAGE_SIZE
from app.modules.inventory.models import NO_BATCH, PositionLocation, Stock
from app.modules.warehouse.enums import WarehouseDocType
from app.modules.warehouse.models import (
    Batch, Dispatch, DispatchSource, MaterialIssue, MaterialIssueLine, SerialNumber,
)
from app.platform.hcm.models import (
    HcmEmployee, HcmOffice, HcmPosition, HcmPositionAssignment,
)
from app.shared.enums import WarehouseType
from app.shared.models.master import (
    Item, ItemCategory, ItemPackaging, ItemSpec, PackHierarchy, Uom, UomConversion,
)
from app.shared.models.warehouse import Warehouse

Row = Mapping[str, Any]
Mapper = Callable[[Row], dict]

TRUE_WORDS = {"true", "yes", "y", "1", "t"}
FALSE_WORDS = {"false", "no", "n", "0", "f"}


# --------------------------------------------------------------------------- #
# Parameter handling — one reading of page/page_size/is_active/updated_since
# --------------------------------------------------------------------------- #

def page_of(query: Mapping[str, str]) -> tuple[int, int]:
    """`(page, page_size)`. `size` is accepted as an alias so the same key works here
    and on the console's own endpoints."""
    page = max(1, _int(query, "page", 1))
    size = _int(query, "page_size", _int(query, "size", DEFAULT_PAGE_SIZE))
    return page, max(1, min(size, MAX_EXT_PAGE_SIZE))


def _int(query: Mapping[str, str], name: str, default: int) -> int:
    raw = str(query.get(name) or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ValidationError(f"{name} must be a whole number") from exc


def flag(value: str | bool | None) -> bool | None:
    """`None` means "the caller said nothing", which is not the same as False."""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in TRUE_WORDS:
        return True
    if text in FALSE_WORDS:
        return False
    raise ValidationError("is_active must be true or false")


def _active(stmt: Select, column, wanted: bool | None) -> Select:
    """Rule 6 of the ask: `is_active=true` returns active rows and nothing else."""
    if wanted is None:
        return stmt
    return stmt.where(column.is_(True) if wanted else column.is_(False))


def since(value: str | None) -> datetime | None:
    if not value:
        return None
    text = str(value).strip().replace("Z", "").replace(" ", "T")
    try:
        if len(text) <= 10:
            return datetime.combine(date.fromisoformat(text[:10]), datetime.min.time())
        # An offset is dropped rather than converted: the columns store naive IST wall
        # clock (see shared/time.py), so converting would shift every delta by 5h30.
        return datetime.fromisoformat(text[:26].split("+")[0])
    except ValueError as exc:
        raise ValidationError(
            "updated_since must be YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS") from exc


def _since(stmt: Select, column, value: str | None) -> Select:
    stamp = since(value)
    return stmt if stamp is None else stmt.where(column >= stamp)


def ids(raw: str | int | None) -> list[int]:
    """`?item_id=1,2,3` as well as `?item_id=1`. Empty means no filter."""
    if raw is None or raw == "":
        return []
    out = []
    for part in str(raw).split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(int(part))
        except ValueError as exc:
            raise ValidationError(f"'{part}' is not a valid id") from exc
    return out


# --------------------------------------------------------------------------- #
# Value shaping
# --------------------------------------------------------------------------- #

def num(value) -> float | None:
    """Decimal -> JSON number. The ask's client reads these as numbers."""
    if value is None:
        return None
    return float(value) if isinstance(value, Decimal) else value


def stamp(value) -> str | None:
    return value.isoformat() if isinstance(value, (datetime, date)) else value


def clean(text) -> str | None:
    """Rule 10 of the ask: no embedded newline or tab inside a name. One item master
    row carries a wrapped name today and it broke their item search."""
    if text is None:
        return None
    return " ".join(str(text).split()) or None


def _boolish(value) -> bool:
    return bool(value)


def _nullable_id(value, sentinel: int = 0) -> int | None:
    """`stk_balance.batch_id` is NOT NULL and uses 0 for "no batch". Outside SCM, 0 is
    a real id someone will try to join on, so it leaves as null."""
    return None if value is None or int(value) == sentinel else int(value)


# --------------------------------------------------------------------------- #
# Paging
# --------------------------------------------------------------------------- #

async def page(db: AsyncSession, stmt: Select, mapper: Mapper,
               query: Mapping[str, str]) -> dict:
    """The one response shape of §3.1 — `{items, total, page, page_size}`.

    `total` is the full unpaged count, as §3.2 requires. `size` is echoed alongside
    `page_size` so an SCM-side caller reading the house shape sees what it expects.
    """
    number, size = page_of(query)
    total = await db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = (await db.execute(stmt.offset((number - 1) * size).limit(size))).all()
    return {
        "items": [mapper(row._mapping) for row in rows],
        "total": int(total), "page": number, "page_size": size, "size": size,
    }


# --------------------------------------------------------------------------- #
# 1. Items
# --------------------------------------------------------------------------- #

# The two item types that reach B-CAMS, in the exact spelling §2 pins. The live column
# holds either case, so what goes out is normalised rather than passed through: their
# client treats an item missing from `?item_type=consumable` as deleted from the
# catalog (rule 7), and a case mismatch would wipe a whole class off every stock screen.
ITEM_TYPES = {"consumable": "Consumable", "reagent": "Reagent"}

# Q6. `pack_size_text`, `pack_volume_ml` and `tests_per_kit` are on the CHS-104 kit
# sheet and have no column of their own on `mst_items`. They live where SCM already
# keeps per-item technical detail: `mst_item_specs.specifications`, the JSON keyed by
# attribute code that the masters overhaul made the one tagging surface. So these three
# are read from there rather than added to the item master — no migration, and the item
# form can carry them as ordinary category tags.
#
# Several spellings are accepted per field because the tag is typed by whoever set the
# category up, and "TESTS_PER_KIT" and "tests per kit" are the same fact.
SPEC_ALIASES = {
    "pack_size_text": ("pack_size_text", "packsizetext", "pack size", "pack size text",
                       "pack_size_txt"),
    "pack_volume_ml": ("pack_volume_ml", "packvolumeml", "pack volume ml",
                       "pack volume (ml)", "volume_ml"),
    "tests_per_kit": ("tests_per_kit", "testsperkit", "tests per kit",
                      "tests_per_pack", "tests per pack"),
}


def _spec_value(specifications, field: str):
    """One kit-sheet field out of an item's spec JSON, or None."""
    if not isinstance(specifications, dict):
        return None
    folded = {str(k).strip().lower().replace("-", "_"): v
              for k, v in specifications.items()}
    for alias in SPEC_ALIASES[field]:
        value = folded.get(alias) or folded.get(alias.replace(" ", "_"))
        if value not in (None, ""):
            return value
    return None


def _spec_number(specifications, field: str) -> float | None:
    """The same, as a number. A tag typed as "160 ml" still yields 160."""
    raw = _spec_value(specifications, field)
    if raw is None:
        return None
    if isinstance(raw, (int, float, Decimal)):
        return num(raw)
    digits = "".join(c for c in str(raw) if c.isdigit() or c == ".")
    try:
        return float(digits) if digits else None
    except ValueError:
        return None


def items(item_type: str | None = None, is_active: bool | None = None,
          updated_since: str | None = None) -> tuple[Select, Mapper]:
    """`pack_size` (Q6) is the level-1 rung of the item's packing ladder — the smallest
    pack, counted in the item's own UOM. The three kit-sheet fields come from the item's
    spec JSON (see `SPEC_ALIASES`), and `shelf_life_days` falls back to the spec row
    where the master's own value was never set.

    **Assets are never returned** (Q6c). An analyser, a centrifuge or a printer is an
    asset and belongs to AIMS, so `is_asset` items are excluded from this feed
    regardless of how their `item_type` was typed — the guarantee is enforced here
    rather than trusted to the master data being tidy.
    """
    pack = (
        select(ItemPackaging.item_id.label("item_id"),
               ItemPackaging.quantity.label("pack_size"))
        # The DEFAULT hierarchy's smallest pack only (2026-10-08): an item packed in
        # strips of 10 and strips of 15 has two level-1 rungs, and joining both would
        # send the item twice.
        .join(PackHierarchy, PackHierarchy.id == ItemPackaging.hierarchy_id)
        .where(ItemPackaging.level == 1, ItemPackaging.is_active.is_(True),
               PackHierarchy.is_default.is_(True))
        .subquery()
    )
    stmt = (
        select(
            Item.id, Item.code, Item.name, Item.item_type, Item.category_id,
            Item.category_name, Item.uom_id, Item.uom_code, Item.is_batch_tracked,
            Item.has_expiry, Item.reorder_level, Item.safety_stock,
            Item.purchase_price, Item.mrp, Item.shelf_life_days, Item.is_active,
            Item.updated_at, pack.c.pack_size,
            ItemSpec.specifications,
            ItemSpec.shelf_life_days.label("spec_shelf_life"),
        )
        .select_from(Item)
        .join(pack, pack.c.item_id == Item.id, isouter=True)
        .join(ItemSpec, ItemSpec.item_id == Item.id, isouter=True)
        .where(Item.is_asset.is_(False))
        .order_by(Item.id)
    )
    # Two gates, not one. `is_asset` catches an item flagged as an asset; the type gate
    # catches one that is an asset in all but the flag — the live master carries
    # `ASSET`, `Acessories`, `material`, `ICLS-AST` and `TESTCLASS` in that column, and
    # an item typed `ASSET` with the flag left unset was reaching this feed. B-CAMS is
    # promised exactly two classes, so exactly two classes are servable, and an
    # `item_type` filter can only narrow within them.
    wanted = [t.strip().lower() for t in (item_type or "").split(",") if t.strip()]
    servable = [t for t in ITEM_TYPES if not wanted or t in wanted]
    stmt = stmt.where(func.lower(Item.item_type).in_(servable) if servable
                      else literal(False))
    stmt = _active(stmt, Item.is_active, is_active)
    return _since(stmt, Item.updated_at, updated_since), _item_out


def _item_out(row: Row) -> dict:
    specifications = row["specifications"]
    kind = str(row["item_type"] or "").strip()
    # `category_id` is NULL on items that predate the mandatory-category rule. Sent as
    # null rather than invented: their §2 marks it must-never-be-NULL, and the fix is in
    # the item master, not in this feed.
    return {
        "id": row["id"],
        "item_code": row["code"],
        "name": clean(row["name"]),
        "item_type": ITEM_TYPES.get(kind.lower(), kind or None),
        "category_id": row["category_id"],
        "category_name": clean(row["category_name"]),
        "primary_uom_id": row["uom_id"],
        "uom_code": row["uom_code"],
        "has_batch": _boolish(row["is_batch_tracked"]),
        "has_expiry": _boolish(row["has_expiry"]),
        "reorder_level": num(row["reorder_level"]),
        "safety_stock": num(row["safety_stock"]),
        "purchase_price": num(row["purchase_price"]),
        "mrp": num(row["mrp"]),
        "pack_size": num(row["pack_size"]),
        "pack_size_text": clean(_spec_value(specifications, "pack_size_text")),
        "pack_volume_ml": _spec_number(specifications, "pack_volume_ml"),
        "tests_per_kit": _spec_number(specifications, "tests_per_kit"),
        # The master's column is NOT NULL DEFAULT 0, so a 0 there means "never set"
        # rather than "expires immediately" — the spec row is the better answer.
        "shelf_life_days": row["shelf_life_days"] or row["spec_shelf_life"] or None,
        "is_active": _boolish(row["is_active"]),
    }


# --------------------------------------------------------------------------- #
# 2. Item categories
# --------------------------------------------------------------------------- #

def item_categories(is_active: bool | None = None,
                    parent_id: str | int | None = None) -> tuple[Select, Mapper]:
    """The panel dimension — which group an item belongs to, alongside its `item_type`.

    Q6b asks for panel groups (Lipid, Liver Function, Hematology …) rather than one
    category per item. This feed serves whatever the category master holds: it is a
    faithful read, and restructuring the tree is a masters job on SCM's side, not
    something an integration endpoint can paper over. `parent_name` and `level` are
    included so the shape of the tree is visible from their end while that happens.
    """
    parent = ItemCategory.__table__.alias("parent")
    stmt = (
        select(ItemCategory.id, ItemCategory.parent_id, ItemCategory.name,
               ItemCategory.code, ItemCategory.level, parent.c.name.label("parent_name"))
        .select_from(ItemCategory)
        .join(parent, parent.c.id == ItemCategory.parent_id, isouter=True)
        .order_by(ItemCategory.id)
    )
    if ids(parent_id):
        stmt = stmt.where(ItemCategory.parent_id.in_(ids(parent_id)))
    return _active(stmt, ItemCategory.is_active, is_active), lambda r: {
        "id": r["id"], "parent_id": r["parent_id"],
        "name": clean(r["name"]), "code": r["code"],
        "parent_name": clean(r["parent_name"]), "level": r["level"],
    }


# --------------------------------------------------------------------------- #
# 3. UOM
# --------------------------------------------------------------------------- #

def uoms(is_active: bool | None = None) -> tuple[Select, Mapper]:
    """Q7. `mst_uom_conversions` stores only the forward direction of a pair, so the
    base is the smallest unit this one converts INTO and the factor is that row's.
    A UOM with no conversion is its own base at factor 1."""
    lowest = (
        select(UomConversion.from_uom_id.label("from_id"),
               func.min(UomConversion.to_uom_id).label("to_id"))
        .group_by(UomConversion.from_uom_id)
        .subquery()
    )
    conv = (
        select(lowest.c.from_id, lowest.c.to_id, UomConversion.factor)
        .join(UomConversion,
              and_(UomConversion.from_uom_id == lowest.c.from_id,
                   UomConversion.to_uom_id == lowest.c.to_id))
        .subquery()
    )
    stmt = (
        select(Uom.id, Uom.code, Uom.name, conv.c.to_id, conv.c.factor)
        .select_from(Uom)
        .join(conv, conv.c.from_id == Uom.id, isouter=True)
        .order_by(Uom.id)
    )
    return _active(stmt, Uom.is_active, is_active), lambda r: {
        "id": r["id"], "name": clean(r["name"]), "abbreviation": r["code"],
        "base_uom_id": r["to_id"] or r["id"],
        "conversion_factor": num(r["factor"]) if r["factor"] is not None else 1,
    }


# --------------------------------------------------------------------------- #
# 4. Warehouses
# --------------------------------------------------------------------------- #

def tier_of(warehouse_type: str | None) -> str:
    """Q1. LIP and MDP are the two rungs below a warehouse; everything else is a WH."""
    kind = (warehouse_type or "").upper()
    if kind == WarehouseType.LIP.value:
        return Tier.LIP.value
    if kind == WarehouseType.MDP.value:
        return Tier.MDP.value
    return Tier.WH.value


def warehouses(is_active: bool | None = None,
               tier: str | None = None) -> tuple[Select, Mapper]:
    """`hcm_office_id` (Q2) is `whs_warehouses.office_id`, the soft FK to the HCM
    mirror. City and state come from that office — a warehouse row has neither."""
    stmt = (
        select(Warehouse.id, Warehouse.code, Warehouse.name, Warehouse.warehouse_type,
               Warehouse.office_id, Warehouse.facility_id, Warehouse.is_active,
               HcmOffice.city, HcmOffice.state)
        .select_from(Warehouse)
        .join(HcmOffice, HcmOffice.id == Warehouse.office_id, isouter=True)
        .order_by(Warehouse.id)
    )
    stmt = _active(stmt, Warehouse.is_active, is_active)
    wanted = [t.strip().upper() for t in (tier or "").split(",") if t.strip()]
    if wanted:
        # Filtering on the derived value means filtering on what it is derived FROM:
        # every warehouse type that maps to a wanted tier, WH being "none of the rungs".
        rungs = {WarehouseType.LIP.value, WarehouseType.MDP.value}
        types = {t for t in rungs if tier_of(t) in wanted}
        clauses = [Warehouse.warehouse_type.in_(sorted(types))] if types else []
        if Tier.WH.value in wanted:
            clauses.append(or_(Warehouse.warehouse_type.notin_(sorted(rungs)),
                               Warehouse.warehouse_type.is_(None)))
        stmt = stmt.where(or_(*clauses)) if clauses else stmt.where(literal(False))
    return stmt, _warehouse_out


def _warehouse_out(row: Row) -> dict:
    return {
        "id": row["id"], "code": row["code"], "name": clean(row["name"]),
        "type": row["warehouse_type"],
        "tier": tier_of(row["warehouse_type"]),
        # SCM's warehouses are a flat list — the hierarchy is the tier, not a parent
        # row. Sent as null rather than omitted so the field is always present.
        "parent_id": None,
        "hcm_office_id": row["office_id"],
        "hcm_facility_id": row["facility_id"],
        "city": row["city"], "state": row["state"],
        "is_active": _boolish(row["is_active"]),
    }


# --------------------------------------------------------------------------- #
# 5. Batches
# --------------------------------------------------------------------------- #

def batches(item_id: str | int | None = None,
            updated_since: str | None = None) -> tuple[Select, Mapper]:
    stmt = select(Batch.id, Batch.item_id, Batch.batch_no, Batch.mfg_date,
                  Batch.expiry_date, Batch.status, Batch.created_at).order_by(Batch.id)
    wanted = ids(item_id)
    if wanted:
        stmt = stmt.where(Batch.item_id.in_(wanted))
    # stk_batches has no updated_at; a batch is written once by the GRN and only its
    # status ever changes, so created_at is the honest change column here.
    return _since(stmt, Batch.created_at, updated_since), lambda r: {
        "id": r["id"], "item_id": r["item_id"], "batch_number": r["batch_no"],
        # No lot column on stk_batches. Sent as null rather than dropped so the field
        # is always present and never has to be guessed at.
        "lot_number": None,
        "manufacturing_date": stamp(r["mfg_date"]),
        "expiry_date": stamp(r["expiry_date"]),
        "status": r["status"],
    }


# --------------------------------------------------------------------------- #
# 6. Stock balance
# --------------------------------------------------------------------------- #

def stock_balance(warehouse_id: str | int | None = None,
                  item_id: str | int | None = None,
                  updated_since: str | None = None) -> tuple[Select, Mapper]:
    """Q8: `batch_number` and `expiry_date` stay inline — both are columns on
    `stk_balance` itself, so keeping them costs no join and cannot go missing."""
    stmt = (
        select(Stock.id, Stock.item_id, Stock.warehouse_id, Stock.batch_id,
               Stock.batch_no, Stock.expiry_date, Stock.available_qty,
               Stock.reserved_qty, Stock.total_qty, Stock.valuation_rate,
               Stock.stock_value, Stock.updated_at, Stock.uom_code, Item.uom_id)
        .select_from(Stock)
        .join(Item, Item.id == Stock.item_id, isouter=True)
        .order_by(Stock.id)
    )
    if ids(warehouse_id):
        stmt = stmt.where(Stock.warehouse_id.in_(ids(warehouse_id)))
    if ids(item_id):
        stmt = stmt.where(Stock.item_id.in_(ids(item_id)))
    return _since(stmt, Stock.updated_at, updated_since), _stock_out


def _stock_out(row: Row) -> dict:
    return {
        "id": row["id"], "item_id": row["item_id"],
        "warehouse_id": row["warehouse_id"],
        "batch_id": _nullable_id(row["batch_id"], NO_BATCH),
        "batch_number": row["batch_no"],
        "expiry_date": stamp(row["expiry_date"]),
        "available_qty": num(row["available_qty"]),
        "reserved_qty": num(row["reserved_qty"]),
        "total_qty": num(row["total_qty"]),
        "uom_id": row["uom_id"], "uom_code": row["uom_code"],
        # Q9: the live costing columns are zero across most rows today. A real zero is
        # sent rather than a rate invented here — see the note in the handover.
        "valuation_rate": num(row["valuation_rate"]),
        "stock_value": num(row["stock_value"]),
        "last_updated": stamp(row["updated_at"]),
    }


# --------------------------------------------------------------------------- #
# 7. Material issues
# --------------------------------------------------------------------------- #

def _latest_dispatch():
    """One consignment per issue — the most recent, when an issue was dispatched twice.

    SCM keeps the destination on the consignment (`out_dispatches.to_warehouse_id`),
    not on the issue, because an issue is "stock left this store" and a consignment is
    "and it went there". Grouped to MAX(id) rather than LEFT JOINed directly, or an
    issue with two consignments would come back as two rows and break the paging count.
    """
    # Both ways a consignment names its issue: `ref_id` for one, `out_dispatch_sources`
    # for a consignment carrying several (whose `ref_id` is empty).
    carried = union_all(
        select(Dispatch.ref_id.label("issue_id"), Dispatch.id.label("dispatch_id"))
        .where(Dispatch.ref_type == WarehouseDocType.WH_ISSUE.value,
               Dispatch.ref_id.isnot(None)),
        select(DispatchSource.issue_id.label("issue_id"),
               DispatchSource.dispatch_id.label("dispatch_id"))
        .where(DispatchSource.issue_id.isnot(None)),
    ).subquery()
    newest = (
        select(carried.c.issue_id.label("issue_id"),
               func.max(carried.c.dispatch_id).label("dispatch_id"))
        .group_by(carried.c.issue_id)
        .subquery()
    )
    return (
        select(newest.c.issue_id, Dispatch.to_warehouse_id, Dispatch.gate_out_at,
               Dispatch.dispatch_date, Dispatch.vehicle_number.label("d_vehicle"))
        .join(Dispatch, Dispatch.id == newest.c.dispatch_id)
        .subquery()
    )


def material_issues(destination_warehouse_id: str | int | None = None,
                    status: str | None = None,
                    warehouse_id: str | int | None = None,
                    updated_since: str | None = None) -> tuple[Select, Mapper]:
    dispatch = _latest_dispatch()
    # Falls back to the indent's own warehouse: an issue collected at the counter has
    # no consignment, and the point that raised the indent is where it went.
    destination = func.coalesce(dispatch.c.to_warehouse_id, Indent.warehouse_id)
    stmt = (
        select(MaterialIssue.id, MaterialIssue.issue_no, MaterialIssue.indent_id,
               MaterialIssue.warehouse_id, MaterialIssue.issue_date,
               MaterialIssue.issued_to_id, MaterialIssue.issued_by_id,
               MaterialIssue.status, MaterialIssue.vehicle_number,
               MaterialIssue.acknowledged_at, MaterialIssue.updated_at,
               destination.label("destination_warehouse_id"),
               dispatch.c.gate_out_at, dispatch.c.dispatch_date,
               dispatch.c.d_vehicle)
        .select_from(MaterialIssue)
        .join(dispatch, dispatch.c.issue_id == MaterialIssue.id, isouter=True)
        .join(Indent, Indent.id == MaterialIssue.indent_id, isouter=True)
        .where(MaterialIssue.direction == "OUT")
        .order_by(MaterialIssue.id)
    )
    if ids(destination_warehouse_id):
        stmt = stmt.where(destination.in_(ids(destination_warehouse_id)))
    if ids(warehouse_id):
        stmt = stmt.where(MaterialIssue.warehouse_id.in_(ids(warehouse_id)))
    wanted = [s.strip().upper() for s in (status or "").split(",") if s.strip()]
    if wanted:
        stmt = stmt.where(func.upper(MaterialIssue.status).in_(wanted))
    return _since(stmt, MaterialIssue.updated_at, updated_since), _issue_out


def _issue_out(row: Row) -> dict:
    return {
        "id": row["id"], "issue_number": row["issue_no"],
        "indent_id": row["indent_id"],
        "warehouse_id": row["warehouse_id"],
        "destination_warehouse_id": row["destination_warehouse_id"],
        "issue_date": stamp(row["issue_date"]),
        "issued_to": row["issued_to_id"], "issued_by": row["issued_by_id"],
        "status": row["status"],
        "vehicle_number": row["vehicle_number"] or row["d_vehicle"],
        # The gate-out stamp is the moment the goods physically left. Where security
        # never recorded one, the consignment's own date is the best answer there is.
        "dispatched_at": stamp(row["gate_out_at"] or row["dispatch_date"]),
        "acknowledged_at": stamp(row["acknowledged_at"]),
    }


# --------------------------------------------------------------------------- #
# 8. Material issue items
# --------------------------------------------------------------------------- #

def material_issue_items(issue_id: str | int | None = None) -> tuple[Select, Mapper]:
    stmt = (
        select(MaterialIssueLine.id, MaterialIssueLine.issue_id,
               MaterialIssueLine.item_id, MaterialIssueLine.batch_id,
               MaterialIssueLine.batch_no, MaterialIssueLine.expiry_date,
               MaterialIssueLine.issued_qty, MaterialIssueLine.rate,
               MaterialIssueLine.uom_code, Item.uom_id)
        .select_from(MaterialIssueLine)
        .join(Item, Item.id == MaterialIssueLine.item_id, isouter=True)
        .order_by(MaterialIssueLine.id)
    )
    if ids(issue_id):
        stmt = stmt.where(MaterialIssueLine.issue_id.in_(ids(issue_id)))
    return stmt, lambda r: {
        "id": r["id"], "issue_id": r["issue_id"], "item_id": r["item_id"],
        "batch_id": _nullable_id(r["batch_id"]),
        "batch_number": r["batch_no"],
        "expiry_date": stamp(r["expiry_date"]),
        "qty": num(r["issued_qty"]),
        "uom_id": r["uom_id"], "uom_code": r["uom_code"],
        "rate": num(r["rate"]),
    }


# --------------------------------------------------------------------------- #
# 9. User -> warehouse
# --------------------------------------------------------------------------- #

def user_warehouses(warehouse_id: str | int | None = None,
                    is_active: bool | None = None) -> tuple[Select, Mapper]:
    """Q5. The rebuild has no `users` and no `user_warehouses`; the mapping is
    position-shaped instead, and this is the join that flattens it back to a person:

        inv_position_locations -> hcm_position_assignments -> hcm_employees

    Keyed on the POST, not the person, on purpose — people move, the post does not — so
    a storekeeper who transfers takes no stale warehouse rows with them.
    """
    stmt = (
        select(HcmEmployee.id.label("user_id"), HcmEmployee.emp_code,
               PositionLocation.warehouse_id, PositionLocation.is_primary,
               PositionLocation.is_active, HcmEmployee.is_active.label("emp_active"),
               HcmPositionAssignment.position_id)
        .select_from(PositionLocation)
        .join(HcmPositionAssignment,
              and_(HcmPositionAssignment.position_id == PositionLocation.position_id,
                   HcmPositionAssignment.is_active.is_(True)))
        .join(HcmEmployee, HcmEmployee.id == HcmPositionAssignment.employee_id)
        .order_by(PositionLocation.id, HcmEmployee.id)
    )
    if ids(warehouse_id):
        stmt = stmt.where(PositionLocation.warehouse_id.in_(ids(warehouse_id)))
    if is_active is not None:
        # A pairing is live only while BOTH ends are: `inv_position_locations.is_active`
        # is an INT flag, the employee's is a real boolean.
        live = and_(PositionLocation.is_active == 1, HcmEmployee.is_active.is_(True))
        stmt = stmt.where(live if is_active else ~live)
    return stmt, lambda r: {
        "user_id": r["user_id"], "employee_code": r["emp_code"],
        "warehouse_id": r["warehouse_id"],
        "position_id": r["position_id"],
        "is_default": bool(r["is_primary"]),
        "is_active": bool(r["is_active"]) and bool(r["emp_active"]),
    }


# --------------------------------------------------------------------------- #
# 10. Users
# --------------------------------------------------------------------------- #

def users(is_active: bool | None = None,
          employee_code: str | None = None) -> tuple[Select, Mapper]:
    """Q5 again. There is no users table (see CLAUDE.md): identity IS the HCM employee,
    so `id` is the HCM employee id and `employee_code` is `hcm_employees.emp_code` —
    the key §7 makes the person join across all three systems.

    Nothing about pay, bank, EPFO or health is selectable here, and rule 10 keeps those
    columns out of the mirror entirely.
    """
    primary = (
        select(HcmPositionAssignment.employee_id.label("employee_id"),
               func.min(HcmPositionAssignment.position_id).label("position_id"))
        .where(HcmPositionAssignment.is_active.is_(True),
               HcmPositionAssignment.is_primary.is_(True))
        .group_by(HcmPositionAssignment.employee_id)
        .subquery()
    )
    stmt = (
        select(HcmEmployee.id, HcmEmployee.emp_code, HcmEmployee.full_name,
               HcmEmployee.is_active, HcmPosition.role_name, HcmPosition.name
               .label("position_name"))
        .select_from(HcmEmployee)
        .join(primary, primary.c.employee_id == HcmEmployee.id, isouter=True)
        .join(HcmPosition, HcmPosition.id == primary.c.position_id, isouter=True)
        .order_by(HcmEmployee.id)
    )
    stmt = _active(stmt, HcmEmployee.is_active, is_active)
    if employee_code:
        codes = [c.strip() for c in str(employee_code).split(",") if c.strip()]
        stmt = stmt.where(HcmEmployee.emp_code.in_(codes))
    return stmt, _user_out


def _user_out(row: Row) -> dict:
    full = clean(row["full_name"]) or ""
    first, _, last = full.partition(" ")
    return {
        "id": row["id"],
        # There are no local usernames — the employee code is what a person signs in
        # with, so it is what goes in both fields rather than a second identity.
        "username": row["emp_code"],
        "first_name": first or None,
        "last_name": last or None,
        "full_name": full or None,
        "employee_code": row["emp_code"],
        # HCM's org role ("Store Keeper", "Driver"), not an SCM permission role.
        "user_type": row["role_name"],
        "position_name": row["position_name"],
        "is_active": _boolish(row["is_active"]),
    }


# --------------------------------------------------------------------------- #
# 11-12. Indents and indent items (display only)
# --------------------------------------------------------------------------- #

def indents(warehouse_id: str | int | None = None, status: str | None = None,
            updated_since: str | None = None) -> tuple[Select, Mapper]:
    stmt = select(Indent.id, Indent.indent_no, Indent.warehouse_id, Indent.indent_date,
                  Indent.status, Indent.requested_by_id, Indent.requested_by_code,
                  Indent.updated_at).order_by(Indent.id)
    if ids(warehouse_id):
        stmt = stmt.where(Indent.warehouse_id.in_(ids(warehouse_id)))
    wanted = [s.strip().upper() for s in (status or "").split(",") if s.strip()]
    if wanted:
        stmt = stmt.where(func.upper(Indent.status).in_(wanted))
    return _since(stmt, Indent.updated_at, updated_since), lambda r: {
        "id": r["id"], "indent_number": r["indent_no"],
        "warehouse_id": r["warehouse_id"],
        "indent_date": stamp(r["indent_date"]),
        "status": r["status"],
        "raised_by": r["requested_by_id"],
        "raised_by_employee_code": r["requested_by_code"],
    }


def indent_items(indent_id: str | int | None = None) -> tuple[Select, Mapper]:
    """`issued_qty` is not a column on the line — it is what the issues actually gave
    against it, so it is summed from `out_issue_items.indent_item_id`."""
    issued = (
        select(MaterialIssueLine.indent_item_id.label("line_id"),
               func.sum(MaterialIssueLine.issued_qty).label("issued_qty"))
        .where(MaterialIssueLine.indent_item_id.isnot(None))
        .group_by(MaterialIssueLine.indent_item_id)
        .subquery()
    )
    stmt = (
        select(IndentItem.id, IndentItem.indent_id, IndentItem.item_id,
               IndentItem.quantity, IndentItem.approved_quantity,
               IndentItem.uom_code, Item.uom_id, issued.c.issued_qty)
        .select_from(IndentItem)
        .join(Item, Item.id == IndentItem.item_id, isouter=True)
        .join(issued, issued.c.line_id == IndentItem.id, isouter=True)
        .order_by(IndentItem.id)
    )
    if ids(indent_id):
        stmt = stmt.where(IndentItem.indent_id.in_(ids(indent_id)))
    return stmt, lambda r: {
        "id": r["id"], "indent_id": r["indent_id"], "item_id": r["item_id"],
        "requested_qty": num(r["quantity"]),
        "approved_qty": num(r["approved_quantity"]),
        "issued_qty": num(r["issued_qty"]) or 0,
        "uom_id": r["uom_id"], "uom_code": r["uom_code"],
    }


# --------------------------------------------------------------------------- #
# 13. Vehicles
# --------------------------------------------------------------------------- #

def vehicles(warehouse_id: str | int | None = None) -> tuple[Select, Mapper]:
    """SCM has no vehicle master — `trn_vehicles` belongs to the transport team and is
    not mirrored here (see `ind_indents.vehicle_id`, an unconstrained id plus a
    snapshot registration number). So this feed is DERIVED: every vehicle that has
    actually carried an indent or an issue, with the point it served.

    Said plainly rather than served as if it were a master: §7 of the ask names HCM as
    the owner of `vehicle_number`, and this is SCM reporting what it saw, not the
    allocation.
    """
    from_indents = (
        select(Indent.vehicle_id.label("id"),
               Indent.vehicle_number.label("vehicle_number"),
               Indent.warehouse_id.label("warehouse_id"))
        .where(Indent.vehicle_id.isnot(None))
    )
    from_issues = (
        select(MaterialIssue.vehicle_id.label("id"),
               MaterialIssue.vehicle_number.label("vehicle_number"),
               MaterialIssue.warehouse_id.label("warehouse_id"))
        .where(MaterialIssue.vehicle_id.isnot(None))
    )
    seen = from_indents.union(from_issues).subquery()
    stmt = (
        select(seen.c.id, seen.c.vehicle_number, seen.c.warehouse_id)
        .order_by(seen.c.id, seen.c.warehouse_id)
    )
    if ids(warehouse_id):
        stmt = stmt.where(seen.c.warehouse_id.in_(ids(warehouse_id)))
    return stmt, lambda r: {
        "id": r["id"],
        "vehicle_code": r["vehicle_number"],
        "vehicle_number": r["vehicle_number"],
        "warehouse_id": r["warehouse_id"],
        "is_active": True,
    }


# --------------------------------------------------------------------------- #
# 14. Serial numbers
# --------------------------------------------------------------------------- #

def serial_numbers(consumable_code: str | None = None,
                   item_id: str | int | None = None,
                   warehouse_id: str | int | None = None,
                   updated_since: str | None = None) -> tuple[Select, Mapper]:
    stmt = select(SerialNumber.id, SerialNumber.item_id, SerialNumber.batch_id,
                  SerialNumber.serial_number, SerialNumber.consumable_code,
                  SerialNumber.status, SerialNumber.warehouse_id,
                  SerialNumber.updated_at).order_by(SerialNumber.id)
    if consumable_code:
        codes = [c.strip() for c in str(consumable_code).split(",") if c.strip()]
        stmt = stmt.where(SerialNumber.consumable_code.in_(codes))
    if ids(item_id):
        stmt = stmt.where(SerialNumber.item_id.in_(ids(item_id)))
    if ids(warehouse_id):
        stmt = stmt.where(SerialNumber.warehouse_id.in_(ids(warehouse_id)))
    return _since(stmt, SerialNumber.updated_at, updated_since), lambda r: {
        "id": r["id"], "item_id": r["item_id"],
        "batch_id": _nullable_id(r["batch_id"]),
        "serial_number": r["serial_number"],
        "consumable_code": r["consumable_code"],
        "status": r["status"], "warehouse_id": r["warehouse_id"],
    }
