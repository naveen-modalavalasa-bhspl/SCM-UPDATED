"""All warehouse business logic. Routers call these and do nothing else.

Three rules shape every function here:

* Stock changes only through `inventory.service.move_stock()`, which always writes a
  `stk_ledger` row. Nothing in this module assigns to `stk_balance`.
* Approvals go through `platform/workflow/engine.py`. The engine owns the chain; this
  module owns the document status and snapshots who is holding it.
* Every state change is: load, reject if the current status does not allow it, change,
  write an audit row, commit. A guard that is missing is a document someone can put
  into a state the next step cannot handle.

Snapshot columns (`item_code`, `item_name`, `uom_code`, every `*_name`) are written at
creation from the masters and never refreshed, so a document keeps saying what things
were called when it was raised.
"""
import logging
import re
from collections import defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from types import SimpleNamespace
from uuid import uuid4

from sqlalchemy import String, and_, false, func, or_, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased, selectinload

from app.core.exceptions import AppException, NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
from app.modules.inventory import allocation as stock_allocation
from app.modules.inventory import locations as stock_locations
from app.modules.inventory.service import move_stock, move_stock_out, take_units
from app.modules.warehouse import models as m
from app.modules.warehouse import schemas as s
from app.modules.warehouse.enums import (
    DEAD_ISSUE_STATUSES,
    DispatchEventType, DispatchStatus, DispatchType, InspectionResult, InspectionStatus,
    InspectionType, IssueDirection, IssueStatus, IssueType, PackageStatus,
    PickLineStatus,
    PickingStatus, PutawayStatus, PutawayType, QcStatus, ReceiptStatus, ReceiptType,
    ReturnStatus, SerialStatus, WarehouseDocType,
)
from app.platform.settings import attachments, codeformat
from app.platform.settings import service as settings_service
from app.platform.settings.service import write_audit
from app.platform.workflow import engine
from app.platform.workflow import ladder as wf_ladder
from app.platform.workflow.models import Instance as WfInstance
from app.modules.inventory.service import warehouse_ids_for_user
from app.shared.scope import scope_condition
from app.shared.enums import (
    ApprovalAction, AuditAction, DespatchNoteStatus, DocType, IndentStatus,
    InstanceStatus, POStatus,
    ReservationStatus,
    RefType as InventoryRefType, StockDirection, UomClass,
)
from app.shared.models.base import utcnow
from app.shared.models.master import Item, Uom, Vendor
from app.shared.models.warehouse import Bin, Warehouse
from app.shared.numbering import next_number
from app.shared.time import now as ist_now, today as ist_today

logger = logging.getLogger(__name__)

ZERO = Decimal("0")

# The unit classes whose stock is made of separable things. Everything else UomClass
# names — WEIGHT, VOLUME, LENGTH, AREA, TEMPERATURE, TIME, PRESSURE, ENERGY — measures
# a continuous quantity, which has no "one unit" to hang an identity on.
_COUNTABLE_UOM_CLASSES = {UomClass.COUNT.value, UomClass.PACKAGING.value}


def _d(value) -> Decimal:
    """Decimal or zero. MySQL DECIMALs arrive as strings and a bad one must not 500."""
    if value is None:
        return ZERO
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return ZERO


def _any_case(*values: str) -> list[str]:
    """Both spellings of a status, for the tables the live data wrote in mixed case.

    `whs_inspections` holds COMPLETED and completed side by side. A collation that
    ignores case would hide that, but the live server's does not agree with itself
    across tables, so the comparison says what it means instead of hoping.
    """
    out: list[str] = []
    for value in values:
        for spelling in (value.upper(), value.lower()):
            if spelling not in out:
                out.append(spelling)
    return out


async def _page_or_empty(db: AsyncSession, stmt, params: PageParams, table: str) -> dict:
    """Paginate, but survive a table the live schema never got.

    The deployed database is older than the ORM in places (`whs_stock_movement_orders`
    is the current one). MySQL answers those reads with error 1146 and the screen
    turned into a 500 with no message at all — a dead page for the three warehouse
    lists a store keeper can open. An empty page plus a loud log is the honest answer:
    there are no rows, because there is nowhere for rows to live yet.
    """
    try:
        return await paginate(db, stmt, params)
    except DBAPIError as exc:
        if getattr(exc.orig, "args", (None,))[0] != 1146:
            raise
        await db.rollback()
        logger.error(
            "%s is missing from the live schema — returning an empty page. "
            "Run the migration that creates it.", table,
        )
        return {"items": [], "total": 0, "page": params.page, "size": params.size}


def _name(user) -> str | None:
    return getattr(user, "full_name", None) or getattr(user, "name", None)


async def _get(db: AsyncSession, model, pk_value: int, label: str):
    row = await db.get(model, pk_value)
    if row is None:
        raise NotFoundError(f"{label} {pk_value} not found")
    return row


async def _load(db: AsyncSession, model, pk_value: int, label: str, *loads):
    """Loads one document with its children eagerly — rule 11's `selectinload()`,
    so rendering a detail response never fires a lazy query per line."""
    stmt = select(model).where(model.id == pk_value)
    for rel in loads:
        stmt = stmt.options(selectinload(rel))
    row = (await db.execute(stmt)).scalar_one_or_none()
    if row is None:
        raise NotFoundError(f"{label} {pk_value} not found")
    return row


def _guard(current: str, allowed: set[str], action: str, doc: str) -> None:
    """Rejects an action the current status does not allow, naming both — an error
    that says only "invalid status" leaves the user guessing what to do next."""
    if current not in allowed:
        raise ValidationError(
            f"Cannot {action} a {doc} that is {current}. "
            f"Allowed from: {', '.join(sorted(allowed))}."
        )


async def _item_snapshot(db: AsyncSession, item_id: int) -> Item:
    item = await db.get(Item, item_id)
    if item is None:
        raise NotFoundError(f"Item {item_id} not found")
    return item


async def _warehouse(db: AsyncSession, warehouse_id: int) -> Warehouse:
    wh = await db.get(Warehouse, warehouse_id)
    if wh is None:
        raise NotFoundError(f"Warehouse {warehouse_id} not found")
    if not wh.is_active:
        raise ValidationError(f"Warehouse {wh.code} is inactive")
    return wh


#: Company-wide answer for stocking points that have not set their own policy.
#: 'false' — acknowledging a consignment credits its stock — is what this code did
#: unconditionally before the policy existed, so an unconfigured database is unchanged.
INWARD_DEFAULT_KEY = "warehouse.requires_inward_default"


async def requires_inward(db: AsyncSession, warehouse_id: int | None) -> bool:
    """Does a consignment landing here have to be inwarded before its stock counts?

    True is the MDP/LIP that runs the full receiving desk: Material Inward -> GRN ->
    QC, and only the GRN posts stock. False is the point that just signs for the
    lorry — `acknowledge_dispatch` credits what arrived and there is no GRN at all.

    The column is nullable on purpose: NULL is "nobody has decided for this point",
    which reads the company default rather than silently picking a side.
    """
    if not warehouse_id:
        return False
    wh = await db.get(Warehouse, warehouse_id)
    if wh is not None and wh.requires_inward is not None:
        return bool(wh.requires_inward)
    default = await settings_service.get_setting(db, INWARD_DEFAULT_KEY, "false")
    return str(default).strip().lower() == "true"


async def _bin_code(db: AsyncSession, bin_id: int | None) -> str | None:
    if not bin_id:
        return None
    row = await db.get(Bin, bin_id)
    return row.code if row else None


async def _bin_floor(db: AsyncSession, bin_id: int | None) -> int | None:
    """Which floor a bin stands on. Already on the bin master and drawn on the floor
    plan; Stock Segregation showed only the bin code, so "where is this unit" was
    answered with a code you had to go and look up."""
    if not bin_id:
        return None
    row = await db.get(Bin, bin_id)
    return getattr(row, "floor_level", None) if row else None


async def _warehouse_code(db: AsyncSession, warehouse_id: int | None) -> str | None:
    """For the {warehouse} token in a generated serial or unit code."""
    if not warehouse_id:
        return None
    row = await db.get(Warehouse, warehouse_id)
    return getattr(row, "code", None)


async def _serials_in_use(db: AsyncSession, item_id: int) -> set[str]:
    """Every serial this item must not be given again, lower-cased.

    Two sources, because a serial exists in two states. The registered units are rows
    in `whs_serial_numbers`. The ones on receipts that have been submitted but not yet
    put away have NO row yet — they are still a JSON list on the line — and minting
    without them handed a second open GRN the same numbers, which then collided at
    registration with "serial is already recorded against this item".
    """
    registered = (await db.execute(
        select(m.SerialNumber.serial_number)
        .where(m.SerialNumber.item_id == item_id)
    )).scalars().all()
    on_open_lines = (await db.execute(
        select(m.ReceiptItem.serial_numbers)
        .where(m.ReceiptItem.item_id == item_id,
               m.ReceiptItem.serial_numbers.is_not(None))
    )).scalars().all()
    used = {value.strip().lower() for value in registered if value}
    for values in on_open_lines:
        used |= {str(v).strip().lower() for v in (values or []) if str(v).strip()}
    return used


# "Who named this unit, us or the vendor" is answerable without a column: every minted
# serial carries the literal part of the configured Serial format (Settings > Code
# Formats), and the GRN's audit row records the list as submitted. A per-row remark was
# tried and removed — the rows are written by a LATER request than the one that mints,
# so anything held on the line in memory is gone by then, and `whs_serial_numbers` is
# not ours to extend.


async def _ancestry(db: AsyncSession, bin_id: int | None) -> list[Bin]:
    """The chain from the outermost structure down to this location, inclusive.

    Walked through `parent_id` rather than read from a stored path, for the reason
    `bin_tree` gives: a derived ancestry cannot disagree with the tree. The visited
    set stops a cycle in the data from becoming an infinite loop here.
    """
    if not bin_id:
        return []
    chain: list[Bin] = []
    seen: set[int] = set()
    current = await db.get(Bin, bin_id)
    while current is not None and current.id not in seen:
        seen.add(current.id)
        chain.append(current)
        current = await db.get(Bin, current.parent_id) if current.parent_id else None
    chain.reverse()
    return chain


# Enough of a code to recognise the level by, short enough that six of them still read
# as one lot number.
_LOT_TOKEN = re.compile(r"[A-Za-z0-9]+")


def _lot_token(location: Bin) -> str:
    """One path segment of a lot number, e.g. `flr-1` -> `F1`, `block A` -> `A`.

    The last alphanumeric group of the code is what people actually say ("rack one",
    "bin A1"); a purely numeric one is prefixed with the storage type's initial so
    `flr-1` and `lane -1` do not both collapse to `1`.
    """
    parts = _LOT_TOKEN.findall(location.code or "")
    tail = parts[-1] if parts else str(location.id)
    if tail.isdigit():
        tail = f"{(location.bin_type or 'L')[:1].upper()}{tail}"
    return tail.upper()


async def _next_lot_no(db: AsyncSession, warehouse: Warehouse, target: Bin) -> str:
    """`LOT/WH10/A-F1-L1-R1-S1-A1/2026-27/00001`.

    The path is where the stock physically is, so the lot number answers "where did
    this come to rest" without a join. The counter is the ordinary document series,
    which means a lot number is gapless and admin-editable like every other number.
    """
    chain = await _ancestry(db, target.id)
    path = "-".join(_lot_token(node) for node in chain) or _lot_token(target)
    return await next_number(
        db, WarehouseDocType.LOT.value,
        WH=f"WH{warehouse.id}" if warehouse else "WH0", PATH=path,
    )


# ---------------------------------------------------------------------------
# Warehouse master
# ---------------------------------------------------------------------------


# FIXED 2026-08-20 — attachments were readable by document id with no visibility check
# at all: `GET /warehouse/attachments?entity_type=RECEIPT&entity_id=<any>` and
# `/attachments/{id}/download` took an ARBITRARY entity and served whatever was filed
# against it, behind `stock.view` alone. That is every scanned invoice, gate pass,
# damage photo and QC report in the company, reachable by walking ids — and the list
# endpoints they hang off are all scoped, so the files were the one way around the rung.
#
# WITHOUT this, scoping a document's list is decorative: the paperwork attached to it
# still comes out.
#
# The entity types are the four the screens actually use. An unknown type is REFUSED
# rather than allowed, because a type nobody can map is a document nobody can bound.
_ATTACHMENT_PARENTS = {
    "RECEIPT": (lambda: m.Receipt, lambda: m.Receipt.warehouse_id),
    "INSPECTION": (lambda: m.Inspection, lambda: m.Inspection.warehouse_id),
    "ISSUE": (lambda: m.MaterialIssue, lambda: m.MaterialIssue.warehouse_id),
    "DISPATCH": (lambda: m.Dispatch, lambda: m.Dispatch.warehouse_id),
}


async def assert_attachment_scope(db: AsyncSession, user, entity_type: str,
                                  entity_id: int) -> None:
    """May this login read the document these files are filed against?"""
    if user is None:
        return
    parent = _ATTACHMENT_PARENTS.get((entity_type or "").upper())
    if parent is None:
        raise ValidationError(
            f"{entity_type!r} is not a document attachments can be read for")
    model, warehouse_col = parent[0](), parent[1]()
    allowed = await warehouse_ids_for_user(db, user)
    stmt = select(model.id).where(model.id == entity_id)
    if allowed is not None:
        stmt = stmt.where(warehouse_col.in_(allowed or {0}))
    if await db.scalar(stmt) is None:
        # 404, not 403 — an id that is not yours must not confirm it exists.
        raise NotFoundError(f"{entity_type} {entity_id} not found")


async def assert_attachment_readable(db: AsyncSession, user, attachment_id: int) -> None:
    """Same check, reached from the attachment row rather than the document."""
    row = await db.get(attachments.Attachment, attachment_id)
    if row is None:
        raise NotFoundError(f"Attachment {attachment_id} not found")
    await assert_attachment_scope(db, user, row.entity_type, row.entity_id)


async def list_warehouses(db: AsyncSession, params: PageParams, *, search: str | None = None,
                          is_active: bool | None = None, user=None) -> dict:
    stmt = select(Warehouse)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(Warehouse.code.ilike(like), Warehouse.name.ilike(like)))
    if is_active is not None:
        stmt = stmt.where(Warehouse.is_active.is_(is_active))
    return await paginate(db, stmt.order_by(Warehouse.code), params)


async def get_warehouse(db: AsyncSession, warehouse_id: int) -> Warehouse:
    return await _get(db, Warehouse, warehouse_id, "Warehouse")


async def create_warehouse(db: AsyncSession, data: s.WarehouseWrite, user) -> Warehouse:
    existing = await db.scalar(select(Warehouse).where(Warehouse.code == data.code))
    if existing:
        raise ValidationError(f"Warehouse code {data.code} is already in use")

    wh = Warehouse(**data.model_dump())
    db.add(wh)
    await db.flush()
    await write_audit(db, entity="whs_warehouses", entity_id=wh.id, entity_no=wh.code,
                      action=AuditAction.CREATE, actor=user, after=data.model_dump(mode="json"))
    await db.commit()
    await db.refresh(wh)
    return wh


async def update_warehouse(db: AsyncSession, warehouse_id: int, data: s.WarehouseWrite,
                           user) -> Warehouse:
    wh = await _get(db, Warehouse, warehouse_id, "Warehouse")
    before = {c: getattr(wh, c) for c in data.model_dump()}

    if data.code != wh.code:
        clash = await db.scalar(
            select(Warehouse).where(Warehouse.code == data.code, Warehouse.id != warehouse_id))
        if clash:
            raise ValidationError(f"Warehouse code {data.code} is already in use")

    # Turning bin management off on a site that already holds binned stock would
    # strand that stock in bins nothing can pick from.
    if wh.is_bin_managed and not data.is_bin_managed:
        binned = await db.scalar(
            select(func.count()).select_from(Bin).where(Bin.warehouse_id == warehouse_id))
        if binned:
            raise ValidationError(
                "This warehouse has bins. Remove them before switching it to bulk storage.")

    for field, value in data.model_dump().items():
        setattr(wh, field, value)
    await db.flush()
    await write_audit(db, entity="whs_warehouses", entity_id=wh.id, entity_no=wh.code,
                      action=AuditAction.UPDATE, actor=user,
                      before={k: str(v) for k, v in before.items()},
                      after=data.model_dump(mode="json"))
    await db.commit()
    await db.refresh(wh)
    return wh


async def bin_tree(db: AsyncSession, warehouse_id: int) -> list[dict]:
    """The whole tree in one query, nested in Python.

    `whs_warehouse_locations` nests through `parent_id` with no depth limit, so a
    recursive query per level would be one round trip per rack. A warehouse has hundreds
    of locations, not millions — fetching them flat and threading them here is one query
    either way.

    Depth and ancestry are computed from the parent links rather than read from stored
    `level`/`path` columns, so they cannot disagree with the tree they describe.
    """
    wh = await _get(db, Warehouse, warehouse_id, "Warehouse")
    # A bulk warehouse stocks at warehouse level, so there is no tree to walk.
    if not wh.is_bin_managed:
        return []
    rows = (await db.execute(
        select(Bin).where(Bin.warehouse_id == warehouse_id).order_by(Bin.code)
    )).scalars().all()

    nodes: dict[int, dict] = {}
    for b in rows:
        nodes[b.id] = {
            "id": b.id, "warehouse_id": b.warehouse_id, "code": b.code, "name": b.name,
            "description": b.description,
            "parent_id": b.parent_id, "bin_type": b.bin_type,
            "storage_type_id": b.storage_type_id,
            "barcode": b.barcode,
            "floor_level": b.floor_level,
            "shelf_level": b.shelf_level,
            "path": None,
            "level": None,
            "capacity_qty": b.capacity_qty,
            "capacity_volume": b.capacity_volume,
            "max_weight_capacity": b.max_weight_capacity,
            "height_cm": b.height_cm,
            "aisle_width_meters": b.aisle_width_meters,
            "temperature_controlled": b.temperature_controlled,
            "humidity_percentage": b.humidity_percentage,
            "target_temperature_celsius": b.target_temperature_celsius,
            "min_temperature_celsius": b.min_temperature_celsius,
            "max_temperature_celsius": b.max_temperature_celsius,
            "is_pickable": b.is_pickable, "is_active": b.is_active,
            "occupied_qty": None, "children": [],
        }

    def describe(node: dict, depth: int, prefix: str) -> None:
        node["level"] = depth
        node["path"] = f"{prefix}/{node['code']}" if prefix else node["code"]
        for child in node["children"]:
            describe(child, depth + 1, node["path"])

    roots: list[dict] = []
    for node in nodes.values():
        parent = nodes.get(node["parent_id"]) if node["parent_id"] else None
        # A location whose parent is missing (or points outside this warehouse) is shown
        # at the root rather than dropped — invisible data is worse than misplaced data.
        (parent["children"] if parent else roots).append(node)
    for root in roots:
        describe(root, 1, "")
    return roots


async def create_bin(db: AsyncSession, data: s.BinWrite, user) -> Bin:
    wh = await _warehouse(db, data.warehouse_id)
    if not wh.is_bin_managed:
        raise ValidationError(f"{wh.code} is a bulk warehouse and cannot hold bins")

    clash = await db.scalar(select(Bin).where(
        Bin.warehouse_id == data.warehouse_id, Bin.code == data.code))
    if clash:
        raise ValidationError(f"Bin {data.code} already exists in {wh.code}")

    if data.parent_id:
        parent = await _get(db, Bin, data.parent_id, "Parent bin")
        if parent.warehouse_id != data.warehouse_id:
            raise ValidationError("A bin cannot sit under a parent in another warehouse")

    # `name` is NOT NULL in the table but optional on the form — a location that is only
    # ever referred to by its code needs no second label. Fall back to the code rather
    # than sending an explicit NULL, which the database rejects with 1048.
    row = Bin(**{**data.model_dump(), "name": data.name or data.code})
    db.add(row)
    await db.flush()
    await write_audit(db, entity="whs_warehouse_locations", entity_id=row.id,
                      entity_no=row.code,
                      action=AuditAction.CREATE, actor=user, after=data.model_dump(mode="json"))
    await db.commit()
    await db.refresh(row)
    return row


async def update_bin(db: AsyncSession, bin_id: int, data: s.BinWrite, user) -> Bin:
    row = await _get(db, Bin, bin_id, "Bin")
    before = {"code": row.code, "bin_type": row.bin_type, "is_active": row.is_active}

    if data.parent_id == bin_id:
        raise ValidationError("A bin cannot be its own parent")

    for field, value in data.model_dump().items():
        setattr(row, field, value)
    row.name = data.name or data.code          # NOT NULL — see create_bin.
    if data.parent_id:
        # Validates the parent exists; depth is derived when the tree is built.
        parent = await _get(db, Bin, data.parent_id, "Parent bin")
        # Same rule as create_bin. Without it a location can be re-parented into
        # another warehouse, where it is invisible to that warehouse's tree and to
        # its own — which is exactly how BIN1 ended up under a lane in warehouse 10.
        if parent.warehouse_id != row.warehouse_id:
            raise ValidationError("A bin cannot sit under a parent in another warehouse")

    await db.flush()
    await write_audit(db, entity="whs_warehouse_locations", entity_id=row.id,
                      entity_no=row.code,
                      action=AuditAction.UPDATE, actor=user,
                      before={k: str(v) for k, v in before.items()},
                      after=data.model_dump(mode="json"))
    await db.commit()
    await db.refresh(row)
    return row


async def delete_bin(db: AsyncSession, bin_id: int, user) -> None:
    row = await _get(db, Bin, bin_id, "Bin")

    children = await db.scalar(
        select(func.count()).select_from(Bin).where(Bin.parent_id == bin_id))
    if children:
        raise ValidationError("This bin has bins under it. Remove those first, "
                              "or deactivate this one instead.")

    # Stock in a deleted bin would be unreachable, so the bin stays and is deactivated.
    from app.modules.inventory.models import Stock
    held = await db.scalar(
        select(func.coalesce(func.sum(Stock.total_qty), 0)).where(Stock.bin_id == bin_id))
    if _d(held) > ZERO:
        raise ValidationError("This bin holds stock. Move it out first, "
                              "or deactivate the bin instead.")

    await write_audit(db, entity="whs_bins", entity_id=row.id, entity_no=row.code,
                      action=AuditAction.DEACTIVATE, actor=user, before={"code": row.code})
    await db.delete(row)
    await db.commit()


async def list_locations(db: AsyncSession, warehouse_id: int) -> list[m.WarehouseLocation]:
    return (await db.execute(
        select(m.WarehouseLocation)
        .where(m.WarehouseLocation.warehouse_id == warehouse_id)
        .order_by(m.WarehouseLocation.code)
    )).scalars().all()


async def list_storage_types(db: AsyncSession) -> list[m.StorageType]:
    return (await db.execute(
        select(m.StorageType).order_by(m.StorageType.name)
    )).scalars().all()


def _storage_type_code(data: s.StorageTypeWrite) -> str:
    return ((data.code or re.sub(r"[^A-Z0-9]+", "_", data.name.upper())).strip("_") or "COLD")[:50]


async def create_storage_type(
    db: AsyncSession,
    data: s.StorageTypeWrite,
    user,
) -> m.StorageType:
    code = _storage_type_code(data)
    existing = await db.scalar(select(m.StorageType).where(
        or_(
            func.lower(m.StorageType.name) == data.name.strip().lower(),
            func.lower(m.StorageType.code) == code.lower(),
        )
    ))
    if existing:
        raise ValidationError(f"Storage type {data.name} already exists")
    row = m.StorageType(
        code=code,
        name=data.name.strip(),
        description=data.description or None,
        is_active=data.is_active,
    )
    db.add(row)
    await db.flush()
    await write_audit(
        db,
        entity="whs_warehouse_storage_types",
        entity_id=row.id,
        entity_no=row.name,
        action=AuditAction.CREATE,
        actor=user,
        after=data.model_dump(mode="json"),
    )
    await db.commit()
    await db.refresh(row)
    return row


async def update_storage_type(
    db: AsyncSession,
    storage_type_id: int,
    data: s.StorageTypeWrite,
    user,
) -> m.StorageType:
    row = await _get(db, m.StorageType, storage_type_id, "Storage type")
    before = {
        "code": row.code,
        "name": row.name,
        "description": row.description,
        "is_active": row.is_active,
    }
    row.code = _storage_type_code(data)
    row.name = data.name.strip()
    row.description = data.description or None
    row.is_active = data.is_active
    await write_audit(
        db,
        entity="whs_warehouse_storage_types",
        entity_id=row.id,
        entity_no=row.name,
        action=AuditAction.UPDATE,
        actor=user,
        before=before,
        after=data.model_dump(mode="json"),
    )
    await db.commit()
    await db.refresh(row)
    return row


# ---------------------------------------------------------------------------
# Inward — gate entry and GRN
# ---------------------------------------------------------------------------

def _receipt_totals(receipt: m.Receipt) -> None:
    """Recomputes the rollups from the lines. Called on every write so a list screen
    reading `total_*` can never disagree with the lines behind it."""
    lines = receipt.items
    receipt.total_items = len(lines)
    receipt.total_received_qty = sum((_d(l.received_qty) for l in lines), ZERO)
    receipt.total_accepted_qty = sum((_d(l.accepted_qty) for l in lines), ZERO)
    receipt.total_rejected_qty = sum((_d(l.rejected_qty) for l in lines), ZERO)
    receipt.total_value = sum((_d(l.amount) for l in lines), ZERO)


async def _apply_receipt_lines(db: AsyncSession, receipt: m.Receipt,
                               lines: list[s.ReceiptItemWrite], *,
                               at_gate: bool = False) -> None:
    """Replaces the receipt's lines, deriving what must be derived.

    Accepted is capped at received and rejected is the remainder, so the three
    quantities cannot contradict each other whatever the client sent. `short_qty` is
    only meaningful against an order, so it stays zero on a free line.

    Serial-tracked items are strict at GRN: one received unit must have one serial
    number before the line can be saved. QC and putaway then work from that unit list.

    At the gate they are optional. A gate entry is a head count taken while the vehicle
    is still outside — cartons unopened, nothing yours yet — so whatever the guard can
    read off the paperwork is captured and the rest is left to the GRN, which reuses the
    same row and so inherits them. Every other serial rule (unique, not already
    recorded, tracked item) still applies to whatever was entered.

    `at_gate` is the caller's intent, not the row's type: the GRN is built by saving the
    gate entry's own row with GRN content and converting it afterwards, so the stored
    `receipt_type` still reads GATE_ENTRY while the storekeeper is filling in the GRN.
    """
    # Lines are UPDATED IN PLACE where they already exist, not wiped and rebuilt.
    #
    # `clear()` deleted every row and inserted fresh ones with new ids on every save.
    # Anything pointing at a line — an inspection raised off this GRN, above all —
    # was left aiming at an id that no longer existed, and completing that inspection
    # died with "line 187 is not on this GRN" even though the item was plainly there.
    # Matching on the client's `id` first, then on (item, batch) for a line the client
    # has no id for, keeps a line the same row across saves.
    existing = list(receipt.items)
    by_id = {row.id: row for row in existing if row.id is not None}
    by_key: dict[tuple, list] = {}
    for row in existing:
        by_key.setdefault((row.item_id, row.batch_no or ""), []).append(row)
    reused: set[int] = set()

    def _take_existing(line_in, item_id: int):
        """The row this incoming line already is, if any."""
        row = by_id.get(line_in.id) if line_in.id else None
        if row is None:
            pool = by_key.get((item_id, line_in.batch_no or ""))
            while pool:
                candidate = pool.pop(0)
                if id(candidate) not in reused:
                    row = candidate
                    break
        if row is not None:
            reused.add(id(row))
        return row

    seen_serials_by_item: dict[int, set[str]] = {}
    seen_imeis_by_item: dict[int, set[str]] = {}
    # (item, batch) already claimed by an earlier line of THIS receipt. Serials and
    # IMEIs are deduplicated below and this was not, so one GRN could carry the same
    # item and batch on ten lines — REC/2026-27/00095 did — and each line posted its
    # own IN movement. Ten receipts of one batch, while `_ensure_batch` recorded the
    # first line's quantity as the batch's `initial_qty` and returned early for the
    # rest. Refused rather than merged: a repeated line is a typo, and silently adding
    # the quantities would hide the one case where it is not.
    seen_batch_by_item: dict[int, dict[str, int]] = {}

    # A consignment inward re-receives units that ALREADY EXIST: the very serials a
    # warehouse or MDP issued are the ones arriving here, so "this serial is already
    # recorded" is the normal case, not a duplicate. Only a purchase brings units the
    # network has never seen. Read off the transfer reference as well as the type,
    # because a gate entry still stores `receipt_type` as GATE_ENTRY while the
    # storekeeper is filling in the GRN behind it.
    inbound_transfer = (receipt.transfer_id is not None
                        or receipt.receipt_type == ReceiptType.DISPATCH.value)

    for index, line in enumerate(lines, start=1):
        item = await _item_snapshot(db, line.item_id)
        received = _d(line.received_qty)
        if received < ZERO:
            raise ValidationError(f"Line {index}: received quantity cannot be negative")
        # One line per item per batch. A second line for the same pair is the same
        # goods entered twice, and each one would post its own stock movement.
        batch_key = (line.batch_no or "").strip().lower()
        claimed = seen_batch_by_item.setdefault(item.id, {})
        if batch_key in claimed:
            where = (f"batch {line.batch_no}" if line.batch_no else "no batch")
            raise ValidationError(
                f"Line {index}: {item.code} with {where} is already on line "
                f"{claimed[batch_key]} of this GRN. Record it once, with the total "
                f"quantity."
            )
        claimed[batch_key] = index

        serials = [value.strip() for value in (line.serial_numbers or []) if value.strip()]
        normalized_serials = [value.lower() for value in serials]
        if len(normalized_serials) != len(set(normalized_serials)):
            raise ValidationError(f"Line {index}: serial numbers must be unique")
        if serials and not item.is_serial_tracked:
            raise ValidationError(
                f"Line {index}: {item.code} is not configured for serial tracking"
            )
        if item.is_serial_tracked and received != received.to_integral_value():
            raise ValidationError(
                f"Line {index}: serialized quantity must be a whole number"
            )
        # More serials than units is always wrong. FEWER is not: goods arrive
        # unlabelled, and the units nobody could read a number off are given one from
        # the Serial format (Settings > Code Formats) when the receipt is submitted.
        # Demanding the full set here is what stopped those lorries at the gate.
        if item.is_serial_tracked and len(serials) > int(received):
            raise ValidationError(
                f"Line {index}: {len(serials)} serial numbers for {int(received)} "
                f"received units of {item.code}"
            )
        if serials:
            seen_for_item = seen_serials_by_item.setdefault(item.id, set())
            duplicate_in_receipt = next(
                (serial for serial in serials if serial.lower() in seen_for_item),
                None,
            )
            if duplicate_in_receipt:
                raise ValidationError(
                    f"Line {index}: serial {duplicate_in_receipt} is already used for {item.code} in this GRN"
                )
            existing_row = (await db.execute(select(m.SerialNumber).where(
                m.SerialNumber.item_id == item.id,
                func.lower(m.SerialNumber.serial_number).in_(normalized_serials),
                m.SerialNumber.is_active.is_(True),
                # On a consignment inward the unit already exists — it is the one the
                # sending point issued. Two states are legitimate: still in flight
                # (not AVAILABLE), or already re-homed here by an earlier save of
                # this same GRN. What is NOT legitimate is a unit sitting AVAILABLE
                # at some OTHER point, because then two units claim one serial.
                *([m.SerialNumber.status == SerialStatus.AVAILABLE.value,
                   m.SerialNumber.warehouse_id != receipt.warehouse_id]
                  if inbound_transfer else []),
            ))).scalars().first()
            if existing_row is not None:
                raise ValidationError(
                    f"Line {index}: serial {existing_row.serial_number} is already "
                    f"recorded for {item.code}"
                )
            seen_for_item.update(normalized_serials)

        # IMEIs follow exactly the serial rules above: anything may be captured at the
        # gate, but a GRN must account for every unit. `is_imei_tracked` had no
        # consumer at all until now — the flag was on the item master and nothing read
        # it, so ticking it changed nothing anywhere.
        imeis = [value.strip() for value in (line.imei_numbers or []) if value.strip()]
        normalized_imeis = [value.lower() for value in imeis]
        if len(normalized_imeis) != len(set(normalized_imeis)):
            raise ValidationError(f"Line {index}: IMEI numbers must be unique")
        if imeis and not item.is_imei_tracked:
            raise ValidationError(
                f"Line {index}: {item.code} is not configured for IMEI tracking"
            )
        if item.is_imei_tracked and received != received.to_integral_value():
            raise ValidationError(
                f"Line {index}: IMEI-tracked quantity must be a whole number"
            )
        if item.is_imei_tracked and at_gate and len(imeis) > int(received):
            raise ValidationError(
                f"Line {index}: {len(imeis)} IMEI numbers for {int(received)} "
                f"received units of {item.code}"
            )
        if item.is_imei_tracked and not at_gate and len(imeis) != int(received):
            raise ValidationError(
                f"Line {index}: enter exactly {int(received)} IMEI numbers for {item.code}"
            )
        if imeis:
            seen_for_item = seen_imeis_by_item.setdefault(item.id, set())
            duplicate = next(
                (imei for imei in imeis if imei.lower() in seen_for_item), None)
            if duplicate:
                raise ValidationError(
                    f"Line {index}: IMEI {duplicate} is already used for {item.code} in this GRN"
                )
            seen_for_item.update(normalized_imeis)

        # Batch and expiry were captured on every line and enforced on none, so a
        # batch-tracked drug could be received with no batch number and no expiry
        # date. Only checked on a GRN: at the gate nobody has opened the carton yet.
        if not at_gate and received > ZERO:
            if item.is_batch_tracked and not (line.batch_no or "").strip():
                raise ValidationError(
                    f"Line {index}: {item.code} is batch tracked — enter a batch number"
                )
            if item.has_expiry and line.expiry_date is None:
                # One flag, two words for it: a consumable expires, an asset's
                # warranty ends. The item master says "Has Expiry / Warranty".
                what = "warranty end date" if item.is_asset else "expiry date"
                raise ValidationError(
                    f"Line {index}: {item.code} needs a {what}"
                )
            if (line.expiry_date is not None and line.mfg_date is not None
                    and line.expiry_date < line.mfg_date):
                raise ValidationError(
                    f"Line {index}: expiry cannot be before the manufacturing date"
                )

        accepted = received if line.accepted_qty is None else min(_d(line.accepted_qty), received)
        rejected = received - accepted
        ordered = _d(line.ordered_qty)
        short = max(ordered - received, ZERO) if ordered > ZERO else ZERO
        rate = _d(line.rate)

        if rejected > ZERO and not (line.rejection_reason or "").strip():
            raise ValidationError(
                f"Line {index}: {rejected} rejected — say why before saving.")

        values = dict(
            line_no=index,
            po_item_id=line.po_item_id,
            indent_id=line.indent_id,
            item_id=item.id,
            item_code=item.code,
            item_name=item.name,
            uom_code=item.uom_code,
            ordered_qty=ordered,
            received_qty=received,
            accepted_qty=accepted,
            rejected_qty=rejected,
            short_qty=short,
            rate=rate or None,
            amount=(accepted * rate) if rate else None,
            batch_id=m.NO_BATCH,
            batch_no=line.batch_no,
            mfg_date=line.mfg_date,
            expiry_date=line.expiry_date,
            bin_id=line.bin_id or m.NO_BIN,
            bin_code=await _bin_code(db, line.bin_id),
            rejection_reason=line.rejection_reason,
            remarks=line.remarks,
            serial_numbers=serials or None,
            imei_numbers=imeis or None,
        )
        row = _take_existing(line, item.id)
        if row is None:
            # qc_status only on a NEW row: re-saving a GRN must not quietly undo a
            # QC decision already recorded against the line.
            receipt.items.append(m.ReceiptItem(
                qc_status=QcStatus.PENDING.value, **values))
        else:
            for field, value in values.items():
                setattr(row, field, value)

    # Whatever the client no longer sends is genuinely gone.
    for row in existing:
        if id(row) not in reused:
            receipt.items.remove(row)
    await db.flush()
    _receipt_totals(receipt)


def _receipt_types_for(receipt_type: str) -> tuple[str, ...]:
    """The stored `receipt_type` values one filter value stands for.

    "GRN" is an umbrella, not a stored value: every inward document that is not a gate
    entry is a GRN once it has been opened. Older imports called ordinary purchase
    receipts "direct", so that spelling rides along until the data-hardening migration
    normalises the rows. Shared with the lookups — a filter that means one thing on the
    list screen and another in the picker behind it is how a GRN goes missing.
    """
    if receipt_type == "GRN":
        return (
            ReceiptType.PURCHASE.value,
            ReceiptType.DIRECT.value,
            ReceiptType.RETURN.value,
            ReceiptType.TRANSFER.value,
            ReceiptType.DISPATCH.value,
            "direct",
        )
    if receipt_type == ReceiptType.PURCHASE.value:
        return (ReceiptType.PURCHASE.value, "direct")
    return (receipt_type,)


async def list_receipts(db: AsyncSession, params: PageParams, *, receipt_type: str | None = None,
                        status: str | None = None, warehouse_id: int | None = None,
                        search: str | None = None, date_from: date | None = None,
                        date_to: date | None = None, gate_register: bool = False, user=None) -> dict:
    stmt = select(m.Receipt)
    if user is not None:
        stmt = stmt.where(await scope_condition(
            db, user,
            warehouse_col=m.Receipt.warehouse_id,
            warehouse_ids=await warehouse_ids_for_user(db, user),
            owner_col=m.Receipt.created_by_id,
            project_col=m.Receipt.project_id,
        ))
    if gate_register:
        # The gate register is a log of vehicles that arrived, not a queue of open ones.
        # Converting a gate entry rewrites `receipt_type` to PURCHASE on the same row, so
        # filtering on the type emptied the screen the moment the entry was worked on.
        # The gate entry number is the thing that never changes: it is stamped once at
        # the gate and carried onto the GRN.
        stmt = stmt.where(m.Receipt.gate_entry_no.is_not(None))
    elif receipt_type:
        stmt = stmt.where(m.Receipt.receipt_type.in_(_receipt_types_for(receipt_type)))
    if status:
        stmt = stmt.where(m.Receipt.status == status)
    if warehouse_id:
        stmt = stmt.where(m.Receipt.warehouse_id == warehouse_id)
    if date_from:
        stmt = stmt.where(m.Receipt.grn_date >= date_from)
    if date_to:
        stmt = stmt.where(m.Receipt.grn_date <= date_to)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(
            m.Receipt.grn_no.ilike(like), m.Receipt.po_no.ilike(like),
            m.Receipt.vendor_name.ilike(like), m.Receipt.invoice_no.ilike(like),
            m.Receipt.gate_entry_no.ilike(like), m.Receipt.vehicle_no.ilike(like),
        ))
    return await paginate(db, stmt.order_by(m.Receipt.id.desc()), params)



# FIXED 2026-08-20 — the warehouse LISTS were all scoped and the DETAIL endpoints were
# not, which is the whole point of scoping a list away again: a login could not see a
# receipt on the register and could still open it by putting its id in the URL. Every
# `GET /{id}` on a warehouse document now runs the same rung its list runs, and answers
# 404 — not 403 — for a document out of scope, so an id that is not yours does not even
# confirm it exists.
#
# WITHOUT this, `warehouse_ids_for_user` bounds what people BROWSE and nothing at all
# about what they can READ.
async def _assert_in_scope(db: AsyncSession, user, model, obj, *,
                           warehouse_col=None, owner_col=None, label: str = "Document"):
    if user is None or obj is None:
        return obj
    stmt = select(model.id).where(model.id == obj.id)
    stmt = stmt.where(await scope_condition(
        db, user,
        warehouse_col=warehouse_col,
        warehouse_ids=await warehouse_ids_for_user(db, user),
        owner_col=owner_col,
    ))
    if await db.scalar(stmt) is None:
        raise NotFoundError(f"{label} {obj.id} not found")
    return obj


async def get_receipt(db: AsyncSession, receipt_id: int, user=None) -> m.Receipt:
    receipt = await _load(db, m.Receipt, receipt_id, "Receipt", m.Receipt.items)
    await _assert_in_scope(db, user, m.Receipt, receipt,
                           warehouse_col=m.Receipt.warehouse_id,
                           owner_col=m.Receipt.created_by_id, label="Receipt")
    item_ids = {line.item_id for line in receipt.items}
    if item_ids:
        rows = (await db.execute(
            select(Item.id, Item.is_asset, Item.is_serial_tracked).where(Item.id.in_(item_ids))
        )).all()
        asset_by_item = {item_id: bool(is_asset) for item_id, is_asset, _ in rows}
        serial_by_item = {
            item_id: bool(is_serial_tracked)
            for item_id, _, is_serial_tracked in rows
        }
        for line in receipt.items:
            line.is_asset = asset_by_item.get(line.item_id, False)
            line.is_serial_tracked = serial_by_item.get(line.item_id, False)
    return receipt


async def _transfer_for_receipt(
    db: AsyncSession,
    *,
    receipt_type: ReceiptType,
    transfer_id: int | None,
    warehouse_id: int,
):
    """Validate and return the dispatched STO behind a transfer receipt."""
    if receipt_type != ReceiptType.TRANSFER:
        if transfer_id is not None:
            raise ValidationError("A stock transfer can only be used on a transfer receipt")
        return None
    if transfer_id is None:
        raise ValidationError("Select the dispatched stock transfer being received")

    from app.modules.inventory.models import StockTransferOrder

    transfer = await _get(db, StockTransferOrder, transfer_id, "Stock transfer")
    if transfer.status != "DISPATCHED":
        raise ValidationError(
            f"{transfer.sto_no} is {transfer.status}; only dispatched transfers can be received"
        )
    if transfer.to_warehouse_id != warehouse_id:
        raise ValidationError(
            f"{transfer.sto_no} is addressed to {transfer.to_warehouse_name}, "
            "not the selected warehouse"
        )
    return transfer


#: The two consignment types that definitionally leave the company. Everything else
#: ends on a shelf we own, whatever the form called it.
_LEAVES_THE_COMPANY = (DispatchType.CUSTOMER.value, DispatchType.VENDOR_RETURN.value)


async def credit_arrival(db: AsyncSession, dispatch: m.Dispatch, user) -> None:
    """Post the destination's inward leg for a consignment that has arrived.

    THE one place a consignment becomes stock at the far end. There are three doors
    onto the same physical event — the receiver signs the lorry (`acknowledge_dispatch`),
    the warehouse signs the issue (`acknowledge_issue`), or the requester confirms in
    My Deliveries (`auto_acknowledge_for_indent`, via `_apply_issue_acknowledgement`) —
    and the credit used to live inside the first one only. Going through either of the
    other two flipped the issue and the consignment to ACKNOWLEDGED and left the goods
    off the books entirely: the LIP storekeeper confirmed his delivery and his inventory
    stayed empty. Which door was used is a UI detail; the goods arrived either way.

    Silent on every case where the credit is somebody else's job, so all three callers
    can call it unconditionally:

      * the consignment left the company (customer, vendor return) — nothing of ours
        to credit;
      * the destination runs a receiving desk — the GRN is the stock event, not the
        signature, and posting here would shelve goods nobody inspected;
      * a GRN was already raised against this consignment — it posted what it kept;
      * a DISPATCH inward row already exists — this ran once already.

    That last check is on `stk_ledger` itself, which makes this idempotent against any
    combination of doors: two people signing the same delivery from two screens post
    the goods once.
    """
    from app.modules.inventory.models import StockMovement

    if not _lands_on_internal_shelf(dispatch):
        return
    if await requires_inward(db, dispatch.to_warehouse_id):
        return
    if await _inward_receipt_for_dispatch(db, dispatch.id) is not None:
        return
    if await db.scalar(
        select(StockMovement.id).where(
            StockMovement.ref_type == InventoryRefType.DISPATCH.value,
            StockMovement.ref_id == dispatch.id,
            StockMovement.direction == StockDirection.IN.value,
        ).limit(1)
    ):
        return

    # Which documents the units in this consignment are travelling under. Both, and
    # in this order: the goods were claimed against the issue when one was posted, and
    # against the consignment itself when it was gated out directly.
    markers = (_shipped_unit_marker("dispatch", dispatch.id),)
    if dispatch.ref_type == WarehouseDocType.WH_ISSUE.value and dispatch.ref_id:
        markers += (_shipped_unit_marker("issue", dispatch.ref_id),)

    # Credit only what actually arrived; a shortage stays visible on the consignment
    # instead of becoming phantom stock at the destination.
    for line in dispatch.items:
        delivered = _d(line.delivered_qty)
        if delivered <= ZERO:
            continue
        # The units land BEFORE the quantity does, so the ledger row can name them.
        # Only as many as were delivered: a short delivery leaves the rest in flight
        # under the same marker rather than shelving units that never turned up.
        units = await _land_units(
            db, markers=markers, item_id=line.item_id, qty=delivered,
            to_warehouse_id=dispatch.to_warehouse_id, ref_no=dispatch.dispatch_no,
        )
        await move_stock(
            db, item_id=line.item_id, qty=delivered,
            direction=StockDirection.IN.value,
            ref_type=InventoryRefType.DISPATCH.value, ref_id=dispatch.id,
            ref_no=dispatch.dispatch_no, user=user,
            warehouse_id=dispatch.to_warehouse_id,
            bin_id=m.NO_BIN, batch_id=line.batch_id or m.NO_BATCH,
            project_id=dispatch.project_id or 0,
            serial_numbers=units or None,
        )


def _lands_on_internal_shelf(dispatch: m.Dispatch) -> bool:
    """Does this consignment end on a stocking point of ours?

    `to_warehouse_id` is the test. `dispatch_type` deliberately is not: the type says
    WHY the goods are going — a project delivery, a plain transfer, a return to a
    vendor — and the consignment form defaults it per screen. It never answered whether
    the far end is a shelf we own.

    Gating the destination credit on TRANSFER meant a consignment raised as PROJECT to
    an MDP left the source warehouse and landed NOWHERE: `stk_ledger` held the OUT row
    and no IN row, and the unit was simply gone from the books. It surfaced as
    "0 available" on a forward that was otherwise perfectly built, but the loss had
    already happened one step earlier, silently, on every non-TRANSFER consignment
    between two of our own points.

    A consignment that genuinely leaves — to a customer, back to a vendor — is excluded
    by type as well as by usually carrying no destination warehouse at all, so an
    auto-filled `to_warehouse_id` can never book a sale back onto our own stock.
    """
    return (dispatch.to_warehouse_id is not None
            and dispatch.dispatch_type not in _LEAVES_THE_COMPANY)


_INWARDABLE_DISPATCH_STATUSES = (
    DispatchStatus.DISPATCHED.value,
    DispatchStatus.IN_TRANSIT.value,
    DispatchStatus.DELIVERED.value,
    DispatchStatus.ACKNOWLEDGED.value,
)


async def _inward_receipt_for_dispatch(
    db: AsyncSession,
    dispatch_id: int,
    *,
    exclude_receipt_id: int | None = None,
) -> m.Receipt | None:
    """The live inward GRN raised against this consignment, if there is one."""
    stmt = select(m.Receipt).where(
        m.Receipt.receipt_type == ReceiptType.DISPATCH.value,
        m.Receipt.transfer_id == dispatch_id,
        m.Receipt.status != ReceiptStatus.CANCELLED.value,
    )
    if exclude_receipt_id is not None:
        stmt = stmt.where(m.Receipt.id != exclude_receipt_id)
    return (await db.execute(stmt.limit(1))).scalar_one_or_none()


async def _dispatch_for_receipt(
    db: AsyncSession,
    *,
    receipt_type: ReceiptType,
    dispatch_id: int | None,
    warehouse_id: int,
    receipt_id: int | None = None,
) -> m.Dispatch | None:
    """Validate and return the consignment behind an inward-from-dispatch receipt.

    This is the MDP/LIP end of the chain: a warehouse issues, packs and dispatches,
    and the point it was addressed to inwards the same consignment here. Nothing
    reaches `stk_balance` at the destination until it does — a consignment sitting in
    a vehicle is not stock anybody can draw on.
    """
    if receipt_type != ReceiptType.DISPATCH:
        if dispatch_id is not None:
            raise ValidationError(
                "A consignment can only be used on an inward-from-consignment receipt"
            )
        return None
    if dispatch_id is None:
        raise ValidationError("Select the incoming consignment being received")

    # Eager-loaded, not `_get`: every caller reads `dispatch.items` — the inward form
    # is built from the lines that were sent — and a lazy load on an async session
    # raises MissingGreenlet, which surfaced as a bare 500 on the GRN screen.
    dispatch = await _load(db, m.Dispatch, dispatch_id, "Consignment", m.Dispatch.items)
    if dispatch.status not in _INWARDABLE_DISPATCH_STATUSES:
        raise ValidationError(
            f"{dispatch.dispatch_no} is {dispatch.status}; only a consignment that has "
            "left the gate can be inwarded"
        )
    if dispatch.to_warehouse_id != warehouse_id:
        raise ValidationError(
            f"{dispatch.dispatch_no} is addressed to "
            f"{dispatch.to_warehouse_name or 'another point'}, not the selected point"
        )
    existing = await _inward_receipt_for_dispatch(
        db, dispatch.id, exclude_receipt_id=receipt_id
    )
    if existing is not None:
        raise ValidationError(
            f"{dispatch.dispatch_no} has already been inwarded on {existing.grn_no}"
        )
    # A consignment that was acknowledged before anybody inwarded it has already been
    # credited to the destination by `acknowledge_dispatch`. Inwarding it now would
    # book the same goods twice. Unless this destination runs a receiving desk, in
    # which case acknowledgement deliberately credited nothing and the GRN below is
    # the stock event it was waiting for.
    if (_lands_on_internal_shelf(dispatch)
            and dispatch.status == DispatchStatus.ACKNOWLEDGED.value
            and not await requires_inward(db, dispatch.to_warehouse_id)):
        raise ValidationError(
            f"{dispatch.dispatch_no} was acknowledged as a transfer, so its stock is "
            "already at the destination. Inward it before acknowledging next time."
        )
    return dispatch


async def create_receipt(db: AsyncSession, data: s.ReceiptWrite, user) -> m.Receipt:
    wh = await _warehouse(db, data.warehouse_id)
    is_gate_entry = data.receipt_type == ReceiptType.GATE_ENTRY
    if not data.items:
        raise ValidationError("A receipt must contain at least one item")
    transfer = await _transfer_for_receipt(
        db,
        receipt_type=data.receipt_type,
        transfer_id=data.transfer_id,
        warehouse_id=wh.id,
    )
    dispatch = await _dispatch_for_receipt(
        db,
        receipt_type=data.receipt_type,
        dispatch_id=data.dispatch_id,
        warehouse_id=wh.id,
    )

    vendor_id, vendor_name, vendor_gstin = await _receipt_vendor(db, data)
    if data.project_id:
        from app.shared.models.master import Project
        project = await db.get(Project, data.project_id)
    else:
        project = None

    receipt = m.Receipt(
        items=[],   # see create_issue: keeps _apply_*_lines()'s clear() off a lazy load
        grn_no=await next_number(db, WarehouseDocType.RECEIPT.value),
        receipt_type=data.receipt_type.value,
        grn_date=data.grn_date,
        po_id=data.po_id,
        po_no=await _receipt_po_number(db, data),
        despatch_note_id=data.despatch_note_id,
        despatch_note_no=await _despatch_note_number(db, data.despatch_note_id),
        transfer_id=(transfer.id if transfer else dispatch.id if dispatch else None),
        transfer_no=(transfer.sto_no if transfer
                     else dispatch.dispatch_no if dispatch else None),
        vendor_id=vendor_id,
        vendor_name=vendor_name,
        vendor_gstin=vendor_gstin,
        warehouse_id=wh.id,
        warehouse_name=wh.name,
        project_id=data.project_id,
        project_name=project.name if project else None,
        invoice_no=data.invoice_no,
        invoice_date=data.invoice_date,
        invoice_amount=data.invoice_amount,
        eway_bill_no=data.eway_bill_no,
        vehicle_no=data.vehicle_no,
        transporter_name=data.transporter_name,
        lr_no=data.lr_no,
        gate_entry_no=(
            data.gate_entry_no
            or (await next_number(db, WarehouseDocType.GATE_ENTRY.value)
                if is_gate_entry else None)
        ),
        gate_entry_at=utcnow() if is_gate_entry else None,
        status=(ReceiptStatus.GATE_ENTRY if is_gate_entry else ReceiptStatus.DRAFT).value,
        received_by_id=getattr(user, "id", None),
        received_by_name=_name(user),
        remarks=data.remarks,
        created_by_id=getattr(user, "id", None),
        created_by_name=_name(user),
    )
    db.add(receipt)
    await db.flush()

    await _apply_receipt_lines(db, receipt, data.items, at_gate=is_gate_entry)
    await db.flush()

    await write_audit(db, entity="inb_receipts", entity_id=receipt.id, entity_no=receipt.grn_no,
                      action=AuditAction.CREATE, actor=user,
                      after={"status": receipt.status, "lines": len(receipt.items)})
    await db.commit()
    return await get_receipt(db, receipt.id)


async def update_receipt(db: AsyncSession, receipt_id: int, data: s.ReceiptWrite,
                         user) -> m.Receipt:
    receipt = await get_receipt(db, receipt_id)
    _guard(receipt.status, {ReceiptStatus.DRAFT.value, ReceiptStatus.GATE_ENTRY.value},
           "edit", "receipt")
    if not data.items:
        raise ValidationError("A receipt must contain at least one item")

    before = {"status": receipt.status, "total_received_qty": str(receipt.total_received_qty)}
    wh = await _warehouse(db, data.warehouse_id)
    transfer = await _transfer_for_receipt(
        db,
        receipt_type=data.receipt_type,
        transfer_id=data.transfer_id,
        warehouse_id=wh.id,
    )
    dispatch = await _dispatch_for_receipt(
        db,
        receipt_type=data.receipt_type,
        dispatch_id=data.dispatch_id,
        warehouse_id=wh.id,
        receipt_id=receipt.id,
    )
    vendor_id, vendor_name, vendor_gstin = await _receipt_vendor(db, data)
    if data.project_id:
        from app.shared.models.master import Project
        project = await db.get(Project, data.project_id)
    else:
        project = None

    receipt.grn_date = data.grn_date
    receipt.po_id = data.po_id
    receipt.po_no = await _receipt_po_number(db, data)
    receipt.despatch_note_id = data.despatch_note_id
    receipt.despatch_note_no = await _despatch_note_number(db, data.despatch_note_id)
    receipt.transfer_id = (transfer.id if transfer
                           else dispatch.id if dispatch else None)
    receipt.transfer_no = (transfer.sto_no if transfer
                           else dispatch.dispatch_no if dispatch else None)
    receipt.vendor_id = vendor_id
    receipt.vendor_name = vendor_name
    receipt.vendor_gstin = vendor_gstin
    receipt.warehouse_id = wh.id
    receipt.warehouse_name = wh.name
    receipt.project_id = data.project_id
    receipt.project_name = project.name if project else None
    receipt.invoice_no = data.invoice_no
    receipt.invoice_date = data.invoice_date
    receipt.invoice_amount = data.invoice_amount
    receipt.eway_bill_no = data.eway_bill_no
    receipt.vehicle_no = data.vehicle_no
    receipt.transporter_name = data.transporter_name
    receipt.lr_no = data.lr_no
    receipt.gate_entry_no = data.gate_entry_no
    receipt.remarks = data.remarks

    # Both sides must agree: the payload says this is still gate work, and the row has
    # not already been promoted. A converted GRN cannot be relaxed by re-sending the
    # old type.
    await _apply_receipt_lines(
        db, receipt, data.items,
        at_gate=(data.receipt_type == ReceiptType.GATE_ENTRY
                 and receipt.receipt_type == ReceiptType.GATE_ENTRY.value),
    )
    await db.flush()

    await write_audit(db, entity="inb_receipts", entity_id=receipt.id, entity_no=receipt.grn_no,
                      action=AuditAction.UPDATE, actor=user, before=before,
                      after={"status": receipt.status,
                             "total_received_qty": str(receipt.total_received_qty)})
    await db.commit()
    return await get_receipt(db, receipt_id)


async def submit_receipt(db: AsyncSession, receipt_id: int, user) -> m.Receipt:
    """Freeze the GRN — through approval first, if this project configured one.

    A goods receipt was the one document on the Approval Flow screen that could be
    configured and then ignored: nothing ever called the engine for `GRN`, so a chain
    saved against it was written and never read.

    The guard is the same one `dispatch_consignment` uses: ask whether a chain exists
    BEFORE starting anything. With none configured — which is every project today —
    `_process_submitted_receipt` runs exactly as this function always did, in the same
    transaction, and the GRN never learns that approvals happened. Only a project that
    has deliberately built a chain gets the extra rung.
    """
    receipt = await get_receipt(db, receipt_id)
    _guard(receipt.status, {ReceiptStatus.DRAFT.value, ReceiptStatus.GATE_ENTRY.value},
           "submit", "receipt")
    if not receipt.items:
        raise ValidationError("A receipt with no lines has nothing to inspect")

    if await _grn_needs_approval(db, receipt, user):
        return await _send_receipt_for_approval(db, receipt, user)
    return await _process_submitted_receipt(db, receipt, user)


async def _grn_needs_approval(db: AsyncSession, receipt: m.Receipt, user) -> bool:
    """Is a GRN chain configured for this receipt's project?

    Read through `find_ladder`, which is what the engine itself would consult, so the
    answer here and the routing there can never disagree.
    """
    position_id = getattr(user, "active_position_id", None)
    project_id = receipt.project_id
    if project_id is None:
        project_id, _name = await wf_ladder.project_for(db, position_id, user)
    raiser_role_id = await wf_ladder.role_of_position(db, position_id)
    found = await wf_ladder.find_ladder(
        db, project_id, DocType.GRN.value, raiser_role_id)
    return found is not None


async def _send_receipt_for_approval(db: AsyncSession, receipt: m.Receipt,
                                     user) -> m.Receipt:
    """Park the GRN on SUBMITTED and hand it to the engine.

    Nothing is inspected, nothing is posted and no putaway is raised until somebody
    signs — the whole point of asking. `SUBMITTED` is an existing ReceiptStatus that
    nothing else sets, and `cancel_receipt` already accepts it, so a GRN waiting on a
    signature can still be withdrawn.
    """
    position_id = getattr(user, "active_position_id", None)
    project_id = receipt.project_id
    if project_id is None:
        project_id, _name = await wf_ladder.project_for(db, position_id, user)
    context = {
        "doc_no": receipt.grn_no,
        "doc_summary": f"Goods receipt {receipt.grn_no}",
        "requester_position_id": position_id,
        "project_id": project_id,
        "warehouse_id": receipt.warehouse_id,
    }
    instance = await engine.start(db, DocType.GRN.value, receipt.id, context, user)
    if instance.status == InstanceStatus.APPROVED.value:
        # A chain the raiser sits at the top of (or one set to "no approval needed")
        # comes back already approved. Carry straight on rather than parking a GRN
        # nobody will ever be asked to sign.
        return await _process_submitted_receipt(db, receipt, user)

    receipt.status = ReceiptStatus.SUBMITTED.value
    await write_audit(db, entity="inb_receipts", entity_id=receipt.id,
                      entity_no=receipt.grn_no, action=AuditAction.UPDATE, actor=user,
                      before={"status": ReceiptStatus.DRAFT.value},
                      after={"status": receipt.status, "sent_for_approval": True})
    await db.commit()
    return await get_receipt(db, receipt.id)


async def approve_receipt(db: AsyncSession, receipt_id: int, user, *,
                          approve: bool = True, comments: str = "") -> m.Receipt:
    """Record one decision on a GRN waiting for approval.

    The engine decides whether this caller may act and whether the chain is finished;
    this only reacts to what it says. On the last approval the GRN carries on into
    exactly the path an unapproved one takes — one implementation of "what a submitted
    receipt does", reached two ways.
    """
    receipt = await get_receipt(db, receipt_id)
    _guard(receipt.status, {ReceiptStatus.SUBMITTED.value}, "approve", "receipt")
    instance = await engine.act(
        db, DocType.GRN.value, receipt.id,
        (ApprovalAction.APPROVED if approve else ApprovalAction.REJECTED).value,
        user, comments,
        {"requester_position_id": getattr(user, "active_position_id", None)},
    )
    if instance.status == InstanceStatus.REJECTED.value:
        receipt.status = ReceiptStatus.CANCELLED.value
        note = comments or "no reason given"
        receipt.remarks = (
            f"{receipt.remarks or ''}\nRejected in approval: {note}"
        ).strip()
        await write_audit(db, entity="inb_receipts", entity_id=receipt.id,
                          entity_no=receipt.grn_no, action=AuditAction.UPDATE,
                          actor=user, after={"status": receipt.status})
        await db.commit()
        return await get_receipt(db, receipt.id)
    if instance.status != InstanceStatus.APPROVED.value:
        # More rungs to climb; the GRN stays parked.
        await db.commit()
        return await get_receipt(db, receipt.id)
    return await _process_submitted_receipt(db, receipt, user)


async def _process_submitted_receipt(db: AsyncSession, receipt: m.Receipt,
                                     user) -> m.Receipt:
    """Everything submitting a GRN does once it is allowed to proceed.

    Lifted out of `submit_receipt` unchanged so the approved path and the
    nobody-configured-a-chain path are the same code, not two that drift.
    """
    qc_lines: list[m.ReceiptItem] = []
    direct_lines: list[m.ReceiptItem] = []
    # Read once for the whole GRN: the formula cannot change between two lines of one
    # lorry, and it is five queries every time it is read.
    code_config = await codeformat.code_settings(db)
    for line in receipt.items:
        item = await _item_snapshot(db, line.item_id)
        # The last gate: the partial list a gate entry is allowed to carry must be
        # finished before the document moves on, because QC selects the units it is
        # keeping from this list and putaway names each one from what QC passed.
        if item.is_serial_tracked:
            captured = [str(v).strip() for v in (line.serial_numbers or []) if str(v).strip()]
            received = _d(line.received_qty)
            if received != received.to_integral_value():
                raise ValidationError(
                    f"{item.code}: serialized quantity must be a whole number"
                )
            if len(captured) > int(received):
                raise ValidationError(
                    f"{item.code}: {len(captured)} serial numbers for "
                    f"{int(received)} received units"
                )
            # Goods that arrive unlabelled used to stop the GRN here. The units that
            # have no vendor serial are given one from the Serial format in
            # Settings > Code Formats — a typed serial is never replaced, so a part-
            # scanned lorry keeps every serial the storekeeper actually read.
            if len(captured) < int(received):
                minted = await codeformat.mint_serials(
                    db, item=item, count=int(received) - len(captured),
                    warehouse_code=await _warehouse_code(db, receipt.warehouse_id),
                    config=code_config,
                    taken=await _serials_in_use(db, item.id) | set(captured),
                )
                line.serial_numbers = captured + minted
        if item.requires_qi:
            line.qc_status = QcStatus.PENDING.value
            qc_lines.append(line)
        else:
            line.accepted_qty = _d(line.received_qty)
            line.rejected_qty = ZERO
            line.qc_status = QcStatus.PASSED.value
            direct_lines.append(line)

    for line in direct_lines:
        await _prepare_receipt_line(db, receipt, line, user)

    inspection = (
        await _raise_inspection_for(db, receipt, user, qc_lines)
        if qc_lines else None
    )
    wh = await _warehouse(db, receipt.warehouse_id)
    if qc_lines:
        receipt.status = ReceiptStatus.PENDING_QC.value
    elif wh.is_bin_managed:
        receipt.status = ReceiptStatus.QC_PASSED.value
    else:
        receipt.status = ReceiptStatus.COMPLETED.value
        receipt.is_stock_posted = True
        receipt.posted_at = utcnow()
        await _sync_po_receipt_status(db, receipt.po_id)
        await _sync_receipt_source(db, receipt)

    await write_audit(db, entity="inb_receipts", entity_id=receipt.id, entity_no=receipt.grn_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": ReceiptStatus.DRAFT.value},
                      after={
                          "status": receipt.status,
                          "inspection_no": inspection.inspection_no if inspection else None,
                          "qc_lines": len(qc_lines),
                          "direct_putaway_lines": len(direct_lines),
                      })
    await db.commit()
    return await get_receipt(db, receipt.id)


async def complete_receipt(db: AsyncSession, receipt_id: int, user) -> m.Receipt:
    """Posts the accepted quantity to stock and raises the putaway tasks.

    This is the only place inward stock comes into existence, and it is deliberately
    idempotent through `is_stock_posted`: a double-clicked button must not double the
    stock. Quantity lands in bulk (`bin_id = 0`) and moves into its bin when the
    putaway task is confirmed — the goods are on the floor, not on the shelf, and the
    stock record should say so.
    """
    receipt = await get_receipt(db, receipt_id)
    _guard(receipt.status,
           {ReceiptStatus.QC_PASSED.value, ReceiptStatus.PARTIALLY_RECEIVED.value},
           "post", "receipt")
    accepted_lines = [l for l in receipt.items if _d(l.accepted_qty) > ZERO]
    if not accepted_lines:
        raise ValidationError("Nothing on this receipt was accepted, so there is "
                              "nothing to post. Cancel it or raise a return instead.")

    wh = await _warehouse(db, receipt.warehouse_id)
    if wh.is_bin_managed:
        for line in accepted_lines:
            await _prepare_receipt_line(db, receipt, line, user)
        pending = await db.scalar(
            select(func.count()).select_from(m.PutawayTask).where(
                m.PutawayTask.grn_id == receipt.id,
                m.PutawayTask.status.notin_(
                    (PutawayStatus.COMPLETED.value, PutawayStatus.CANCELLED.value)
                ),
            )
        )
        if pending:
            raise ValidationError(
                f"{pending} putaway task(s) are still open; complete them before "
                "closing the GRN"
            )
    elif not receipt.is_stock_posted:
        for line in accepted_lines:
            await _prepare_receipt_line(db, receipt, line, user)

    receipt.is_stock_posted = True
    receipt.posted_at = utcnow()
    receipt.status = ReceiptStatus.COMPLETED.value
    await _sync_po_receipt_status(db, receipt.po_id)
    await _sync_receipt_source(db, receipt)

    await write_audit(db, entity="inb_receipts", entity_id=receipt.id, entity_no=receipt.grn_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"is_stock_posted": False},
                      after={"is_stock_posted": True,
                             "total_accepted_qty": str(receipt.total_accepted_qty)})
    await db.commit()
    return await get_receipt(db, receipt_id)


async def convert_gate_entry(db: AsyncSession, receipt_id: int, user) -> m.Receipt:
    """Promote a saved gate entry to the GRN draft represented by the same row."""
    receipt = await get_receipt(db, receipt_id)
    _guard(receipt.status, {ReceiptStatus.GATE_ENTRY.value}, "convert", "gate entry")
    if receipt.receipt_type != ReceiptType.GATE_ENTRY.value:
        raise ValidationError(f"{receipt.grn_no} is not a gate entry")
    if not receipt.items:
        raise ValidationError("Record the received items before converting this gate entry")

    before = {
        "receipt_type": receipt.receipt_type,
        "status": receipt.status,
        "grn_no": receipt.grn_no,
    }
    receipt.receipt_type = ReceiptType.PURCHASE.value
    receipt.grn_no = await next_number(db, WarehouseDocType.RECEIPT.value)
    receipt.grn_date = ist_today()
    receipt.status = ReceiptStatus.DRAFT.value
    await write_audit(
        db,
        entity="inb_receipts",
        entity_id=receipt.id,
        entity_no=receipt.grn_no,
        action=AuditAction.UPDATE,
        actor=user,
        before=before,
        after={
            "receipt_type": receipt.receipt_type,
            "status": receipt.status,
            "grn_no": receipt.grn_no,
            "gate_entry_no": receipt.gate_entry_no,
        },
    )
    await db.commit()
    return await get_receipt(db, receipt_id)


async def _sync_po_receipt_status(db: AsyncSession, po_id: int | None) -> None:
    """Reflect posted warehouse receipts back onto the purchase order."""
    if not po_id:
        return

    from app.modules.procurement.models import POItem, PurchaseOrder

    po = await db.get(PurchaseOrder, po_id)
    if po is None:
        return
    lines = (await db.execute(
        select(POItem).where(POItem.po_id == po_id)
    )).scalars().all()


    if not lines:
        return

    received_rows = (await db.execute(
        select(
            m.ReceiptItem.po_item_id,
            func.coalesce(func.sum(m.ReceiptItem.received_qty), 0),
        )
        .join(m.Receipt, m.Receipt.id == m.ReceiptItem.receipt_id)
        .where(
            m.Receipt.po_id == po_id,
            m.Receipt.is_stock_posted.is_(True),
            m.Receipt.status != ReceiptStatus.CANCELLED.value,
        )
        .group_by(m.ReceiptItem.po_item_id)
    )).all()
    received = {line_id: _d(qty) for line_id, qty in received_rows}
    complete = all(
        received.get(line.id, ZERO)
        >= _d(getattr(line, "quantity", None) or getattr(line, "qty", None))
        for line in lines
    )
    po.status = (
        POStatus.RECEIVED.value if complete else POStatus.PARTIALLY_RECEIVED.value
    )

    # The receipt also settles the material requests this order was raised for. Without
    # it "on order" never stops counting: the goods reach the shelf, and the indent
    # whose shortfall bought them is refused an allocation because the system still
    # believes they are coming. Keyed by INDENT LINE — the only id an MR line and a PO
    # line share — and cumulative, so a part delivery leaves the request open.
    #
    # Here rather than in `logistics.qc_pass`: this is the path a live receipt takes
    # (`whs_receipts`), and `lgs_grn` carries no rows on this install.
    from app.modules.inventory import service as inventory_service

    await inventory_service.mark_mrs_received(
        db, await _receipts_by_indent_line(db, po, lines, received))


async def _receipts_by_indent_line(db: AsyncSession, po, lines,
                                   received: dict[int, Decimal]) -> dict[int, Decimal]:
    """Received quantity per INDENT LINE — the only id a PO line and an MR line share.

    Two ways there, because the direct one is not always populated. A PO line raised
    from an indent carries `indent_item_id`; one raised through the buying chain does
    not always, and PO/2026-27/00010 is the live proof — its requisition line lost the
    pointer, so the receipt had nothing to settle. The fallback walks the trail the
    documents DO keep: PO -> `requisition_id` -> `source_mr_id` -> that request's lines,
    matched on item. Same item, same request, same order — there is no second candidate
    to confuse it with.
    """
    from app.modules.inventory.models import MaterialRequestItem
    from app.modules.procurement.models import Requisition

    by_indent_line: dict[int, Decimal] = {}
    unlinked: dict[int, Decimal] = {}
    for line in lines:
        quantity = received.get(line.id, ZERO)
        indent_line_id = getattr(line, "indent_item_id", None)
        if indent_line_id:
            by_indent_line[int(indent_line_id)] = (
                by_indent_line.get(int(indent_line_id), ZERO) + quantity
            )
        elif quantity > ZERO:
            unlinked[int(line.item_id)] = unlinked.get(int(line.item_id), ZERO) + quantity

    requisition_id = getattr(po, "requisition_id", None)
    if not unlinked or not requisition_id:
        return by_indent_line

    source_mr_id = await db.scalar(
        select(Requisition.source_mr_id).where(Requisition.id == requisition_id)
    )
    if not source_mr_id:
        return by_indent_line

    for item_id, indent_line_id in (await db.execute(
        select(MaterialRequestItem.item_id, MaterialRequestItem.indent_item_id)
        .where(MaterialRequestItem.mr_id == source_mr_id,
               MaterialRequestItem.indent_item_id.isnot(None))
    )).all():
        quantity = unlinked.get(int(item_id))
        if quantity:
            by_indent_line[int(indent_line_id)] = (
                by_indent_line.get(int(indent_line_id), ZERO) + quantity
            )
    return by_indent_line


async def _sync_receipt_source(db: AsyncSession, receipt: m.Receipt) -> None:
    """Reflect a posted receipt back onto the document it was received against.

    `transfer_id` carries either an STO or a consignment — `receipt_type` says
    which — so the branch lives here rather than at four call sites, where getting
    it wrong would mark an unrelated STO received.
    """
    if receipt.receipt_type == ReceiptType.DISPATCH.value:
        await _sync_dispatch_receipt_status(db, receipt.transfer_id)
    else:
        await _sync_transfer_receipt_status(db, receipt.transfer_id)


async def _sync_dispatch_receipt_status(
    db: AsyncSession,
    dispatch_id: int | None,
) -> None:
    """Inwarding a consignment is the destination saying it landed.

    The delivered quantity is what the receiving point actually booked, so the
    consignment stops reading "in transit" the moment its GRN posts. The raiser's own
    acknowledgement is a separate signature and is left alone.
    """
    if not dispatch_id:
        return
    # Eager-loaded: the loop below walks `dispatch.items` to book delivered quantities,
    # and a lazy load on an async session raises MissingGreenlet — which surfaced as a
    # bare 500 on "Submit for QC" and on completing an inspection, both of which post
    # the receipt and then sync the consignment behind it.
    dispatch = (await db.execute(
        select(m.Dispatch)
        .options(selectinload(m.Dispatch.items))
        .where(m.Dispatch.id == dispatch_id)
    )).scalars().first()
    if dispatch is None or dispatch.status not in (
        DispatchStatus.DISPATCHED.value, DispatchStatus.IN_TRANSIT.value,
    ):
        return
    received_rows = (await db.execute(
        select(
            m.ReceiptItem.item_id,
            func.coalesce(func.sum(m.ReceiptItem.accepted_qty), 0),
        )
        .join(m.Receipt, m.Receipt.id == m.ReceiptItem.receipt_id)
        .where(
            m.Receipt.receipt_type == ReceiptType.DISPATCH.value,
            m.Receipt.transfer_id == dispatch_id,
            m.Receipt.is_stock_posted.is_(True),
            m.Receipt.status != ReceiptStatus.CANCELLED.value,
        )
        .group_by(m.ReceiptItem.item_id)
    )).all()
    received = {item_id: _d(qty) for item_id, qty in received_rows}
    for line in dispatch.items:
        available = received.get(line.item_id, ZERO)
        booked = min(available, _d(line.quantity))
        line.delivered_qty = booked
        received[line.item_id] = max(available - booked, ZERO)
    dispatch.status = DispatchStatus.DELIVERED.value
    dispatch.delivered_at = dispatch.delivered_at or utcnow()


async def _sync_transfer_receipt_status(
    db: AsyncSession,
    transfer_id: int | None,
) -> None:
    """Update the dispatched STO without replaying its all-at-once receive command."""
    if not transfer_id:
        return

    from app.modules.inventory.models import StockTransferOrder, StockTransferOrderItem

    transfer = await db.get(StockTransferOrder, transfer_id)
    if transfer is None:
        return
    transfer_lines = (await db.execute(
        select(StockTransferOrderItem).where(
            StockTransferOrderItem.sto_id == transfer_id
        )
    )).scalars().all()
    if not transfer_lines:
        return

    received_rows = (await db.execute(
        select(
            m.ReceiptItem.item_id,
            func.coalesce(func.sum(m.ReceiptItem.accepted_qty), 0),
        )
        .join(m.Receipt, m.Receipt.id == m.ReceiptItem.receipt_id)
        .where(
            m.Receipt.transfer_id == transfer_id,
            m.Receipt.is_stock_posted.is_(True),
            m.Receipt.status != ReceiptStatus.CANCELLED.value,
        )
        .group_by(m.ReceiptItem.item_id)
    )).all()
    remaining_by_item = {item_id: _d(qty) for item_id, qty in received_rows}
    complete = True
    for line in transfer_lines:
        available = remaining_by_item.get(line.item_id, ZERO)
        target = _d(line.dispatched_qty) or _d(line.requested_qty)
        allocated = min(available, target)
        line.received_qty = allocated
        remaining_by_item[line.item_id] = max(available - allocated, ZERO)
        if allocated < target:
            complete = False

    transfer.status = "RECEIVED" if complete else "PARTIALLY_RECEIVED"
    transfer.received_at = utcnow() if complete else None


async def cancel_receipt(db: AsyncSession, receipt_id: int, reason: str | None,
                         user) -> m.Receipt:
    receipt = await get_receipt(db, receipt_id)
    if receipt.is_stock_posted:
        raise ValidationError(
            f"{receipt.grn_no} is already in stock. Raise a purchase return instead — "
            "cancelling would leave stock nothing accounts for.")
    _guard(receipt.status,
           {ReceiptStatus.DRAFT.value, ReceiptStatus.GATE_ENTRY.value,
            ReceiptStatus.PENDING_QC.value, ReceiptStatus.SUBMITTED.value},
           "cancel", "receipt")

    before = {"status": receipt.status}
    receipt.status = ReceiptStatus.CANCELLED.value
    receipt.remarks = f"{receipt.remarks or ''}\nCancelled: {reason or 'no reason given'}".strip()

    await write_audit(db, entity="inb_receipts", entity_id=receipt.id, entity_no=receipt.grn_no,
                      action=AuditAction.UPDATE, actor=user, before=before,
                      after={"status": receipt.status, "reason": reason})
    await db.commit()
    return await get_receipt(db, receipt_id)


async def _ensure_batch(db: AsyncSession, receipt: m.Receipt,
                        line: m.ReceiptItem) -> m.Batch | None:
    """Creates the `stk_batches` row for a batch-tracked line, once.

    Batches are keyed on (batch_no, item) rather than per receipt: the same batch can
    arrive across two deliveries, and giving it two ids would split its expiry.
    """
    if not line.batch_no:
        return None

    existing = await db.scalar(select(m.Batch).where(
        m.Batch.batch_no == line.batch_no, m.Batch.item_id == line.item_id))
    if existing:
        if line.mfg_date and not existing.mfg_date:
            existing.mfg_date = line.mfg_date
        if line.expiry_date and not existing.expiry_date:
            existing.expiry_date = line.expiry_date
        return existing

    batch = m.Batch(
        batch_no=line.batch_no, item_id=line.item_id,
        item_code=line.item_code, item_name=line.item_name,
        vendor_id=receipt.vendor_id, vendor_name=receipt.vendor_name,
        mfg_date=line.mfg_date, expiry_date=line.expiry_date,
        received_date=receipt.grn_date,
        grn_id=receipt.id, grn_no=receipt.grn_no,
        initial_qty=_d(line.accepted_qty), rate=line.rate,
        status="ACTIVE",
    )
    db.add(batch)
    await db.flush()
    return batch


async def _register_serials(
    db: AsyncSession,
    receipt: m.Receipt,
    line: m.ReceiptItem,
    *,
    serial_numbers: list[str] | None = None,
    status: str = SerialStatus.AVAILABLE.value,
    bin_id: int | None = None,
    remarks: str | None = None,
) -> list[m.SerialNumber]:
    """Records each serial on a serial-tracked line.

    A duplicate serial is refused rather than silently reused — two physical units
    sharing one serial makes every later movement ambiguous. The asset/consumable
    code is not generated here: that happens at putaway, once the unit has a bin.

    The line's IMEIs are written onto the units in the same pass. `create_receipt`
    captures both lists in unit order, so position i of one names position i of the
    other; the IMEI stayed a JSON blob on the receipt line before this, which is why
    nothing downstream could show it.
    """
    all_serials = list(line.serial_numbers or [])
    all_imeis = list(getattr(line, "imei_numbers", None) or [])
    imei_by_serial = {
        str(serial).strip().lower(): str(imei).strip()
        for serial, imei in zip(all_serials, all_imeis)
        if serial and imei
    }

    rows: list[m.SerialNumber] = []
    for serial in serial_numbers if serial_numbers is not None else (line.serial_numbers or []):
        clash = await db.scalar(select(m.SerialNumber).where(
            m.SerialNumber.item_id == line.item_id,
            m.SerialNumber.serial_number == serial,
            m.SerialNumber.is_active.is_(True)))
        if clash:
            if clash.warehouse_id != receipt.warehouse_id:
                # A unit that is still AVAILABLE elsewhere was never sent here, so
                # two units are claiming one serial and that stays an error. One the
                # sending point already ISSUED is in transit, and this receipt is
                # where it lands — so it is re-homed rather than refused. Without
                # this, every consignment a warehouse dispatched to an MDP or LIP was
                # rejected on arrival by the serials that prove it is the right load.
                if clash.status == SerialStatus.AVAILABLE.value:
                    raise ValidationError(
                        f"Serial {serial} is already recorded against this item "
                        f"(warehouse {clash.warehouse_id}).")
                clash.warehouse_id = receipt.warehouse_id
                clash.batch_id = line.batch_id or clash.batch_id
            clash.bin_id = bin_id if bin_id is not None else clash.bin_id
            clash.status = status
            # A unit re-homed by an onward GRN keeps the IMEI it was first recorded
            # with unless this receipt states one — the handset does not change hands.
            clash.imei = imei_by_serial.get(serial.strip().lower()) or clash.imei
            rows.append(clash)
            continue
        row = m.SerialNumber(
            item_id=line.item_id, serial_number=serial,
            imei=imei_by_serial.get(serial.strip().lower()),
            batch_id=line.batch_id or None, warehouse_id=receipt.warehouse_id,
            bin_id=bin_id, status=status, remarks=remarks, is_active=True,
        )
        db.add(row)
        rows.append(row)
    await db.flush()
    return rows


async def _prepare_receipt_line(
    db: AsyncSession,
    receipt: m.Receipt,
    line: m.ReceiptItem,
    user,
) -> None:
    """Release one accepted line either to putaway or directly into bulk stock."""
    if _d(line.accepted_qty) <= ZERO:
        return
    batch = await _ensure_batch(db, receipt, line)
    if batch is not None:
        line.batch_id = batch.id

    wh = await _warehouse(db, receipt.warehouse_id)
    if wh.is_bin_managed:
        await _raise_putaway_task(db, receipt, line, user)
        return

    stock = await move_stock(
        db,
        item_id=line.item_id,
        qty=_d(line.accepted_qty),
        direction=StockDirection.IN.value,
        ref_type=InventoryRefType.RECEIPT.value,
        ref_id=receipt.id,
        ref_no=receipt.grn_no,
        user=user,
        warehouse_id=receipt.warehouse_id,
        bin_id=m.NO_BIN,
        batch_id=line.batch_id or m.NO_BATCH,
        project_id=receipt.project_id or 0,
        # What the goods cost, carried onto the balance they become. The GRN has
        # captured this rate all along; it just never reached stk_balance.
        rate=line.rate,
    )
    if batch is not None:
        stock.batch_no = batch.batch_no
        stock.expiry_date = batch.expiry_date
    units = await _register_serials(db, receipt, line)

    # A unit's identity is minted HERE too, not only at putaway. The asset/consumable
    # code used to be stamped exclusively in `confirm_putaway`, so on a site with no
    # bins — which is every stocking point but two — goods were banked into stock
    # carrying no code at all and nothing downstream could quote them. There is no
    # bin and no lot on this path; the code does not depend on either.
    item = await _item_snapshot(db, line.item_id)
    if units:
        await _code_serial_rows(db, units, item=item,
                                warehouse_id=receipt.warehouse_id)
    elif await _is_countable(db, item):
        await _place_unit_codes(
            db,
            item_id=line.item_id,
            warehouse_id=receipt.warehouse_id,
            batch_id=line.batch_id or None,
            bin_id=None,
            lot_no=None,
            qty=_d(line.accepted_qty),
        )
    else:
        await _code_lot(db, stock, item=item, warehouse_id=receipt.warehouse_id)


async def _raise_putaway_task(db: AsyncSession, receipt: m.Receipt, line: m.ReceiptItem,
                              user) -> m.PutawayTask | None:
    """One putaway task per accepted line, on a bin-managed site.

    A bulk warehouse has nowhere to put anything away to, so it gets no task — the
    stock posted in `complete_receipt` is already where it lives.
    """
    wh = await db.get(Warehouse, receipt.warehouse_id)
    if wh is None or not wh.is_bin_managed:
        return None
    existing = await db.scalar(
        select(m.PutawayTask).where(
            m.PutawayTask.grn_item_id == line.id,
            m.PutawayTask.status != PutawayStatus.CANCELLED.value,
        ).limit(1)
    )
    if existing is not None:
        return existing

    return await _build_putaway_task(db, receipt, line, user)


async def _build_putaway_task(db: AsyncSession, receipt: m.Receipt, line: m.ReceiptItem,
                              user) -> m.PutawayTask:
    """Creates the task itself. Split from `_raise_putaway_task` so the manual route
    can apply its own rules about what may be re-raised before building one."""
    suggested = await _suggest_bin(db, receipt.warehouse_id, line.item_id)
    item = await _item_snapshot(db, line.item_id)
    task = m.PutawayTask(
        putaway_no=await next_number(db, WarehouseDocType.PUTAWAY.value),
        grn_id=receipt.id, grn_item_id=line.id,
        warehouse_id=receipt.warehouse_id,
        item_id=line.item_id, batch_id=line.batch_id or None,
        # `whs_warehouse_items.uom_id` is NOT NULL in the live schema while the mapped
        # column says otherwise, so leaving it unset raised an IntegrityError the moment
        # an inspection released a line to a bin-managed site. It carries no foreign key,
        # so an item without a unit still gets a task rather than blocking the putaway.
        uom_id=item.uom_id or 0,
        qty=_d(line.accepted_qty),
        suggested_bin_id=suggested.id if suggested else None,
        putaway_type=(PutawayType.SYSTEM_DIRECTED if suggested
                      else PutawayType.MANUAL).value,
        status=PutawayStatus.PENDING.value,
        assigned_to=getattr(user, "id", None),
        is_active=True,
    )
    db.add(task)
    await db.flush()
    return task


async def _suggest_bin(db: AsyncSession, warehouse_id: int, item_id: int) -> Bin | None:
    """Picks a bin for an incoming line.

    Preference is the bin that already holds this item — keeping one item in one place
    is what makes picking fast — falling back to any active pickable bin. Capacity is
    not modelled per item, so this suggests rather than decides; the storekeeper can
    override, and the override is recorded.
    """
    from app.modules.inventory.models import Stock

    held = (await db.execute(
        select(Stock.bin_id).where(
            Stock.warehouse_id == warehouse_id, Stock.item_id == item_id,
            Stock.bin_id != m.NO_BIN, Stock.total_qty > 0)
        .order_by(Stock.total_qty.desc()).limit(1)
    )).scalar_one_or_none()
    if held:
        return await db.get(Bin, held)

    return (await db.execute(
        select(Bin).where(
            Bin.warehouse_id == warehouse_id, Bin.is_active.is_(True),
            Bin.bin_type.in_(m.BIN_TYPES))
        .order_by(Bin.code).limit(1)
    )).scalar_one_or_none()


async def _po_number(db: AsyncSession, po_id: int | None) -> str | None:
    """Selects `po_no` and nothing else.

    `db.get(PurchaseOrder, ...)` names every column the procurement ORM maps, and the
    live `pro_purchase_orders` has fewer of them (no `indent_id`, `office_id`,
    `facility_id`, `total_amount`), so MySQL answers 1054 and the whole receipt 500s.
    The warehouse only ever wants the number to snapshot, so it asks for the number.
    """
    if not po_id:
        return None
    from app.modules.procurement.models import PurchaseOrder
    return await db.scalar(select(PurchaseOrder.po_no).where(PurchaseOrder.id == po_id))


async def _receipt_po_number(db: AsyncSession, data: s.ReceiptWrite) -> str | None:
    """A PO-backed receipt snapshots the order's own number; a gate entry carries the
    one the driver's paperwork says, typed in by the storekeeper — the goods arrive
    whether or not the order was ever raised in this system."""
    return await _po_number(db, data.po_id) or (data.po_no or "").strip() or None


async def _despatch_note_number(db: AsyncSession, note_id: int | None) -> str | None:
    """Snapshot the note's own number, so a receipt still reads correctly on its own."""
    if not note_id:
        return None
    from app.modules.procurement.models import DespatchNote

    return await db.scalar(
        select(DespatchNote.dn_no).where(DespatchNote.id == note_id))


async def despatch_note_options(db: AsyncSession, po_id: int) -> list[dict]:
    """The notes a vendor has filed against this order, for the gate to pick from.

    Only SUBMITTED ones: a draft is the vendor still typing, and receiving against a
    document they have not finished is how the gate ends up holding figures that change
    underneath it.
    """
    from app.modules.procurement.models import DespatchNote

    rows = (await db.execute(
        select(DespatchNote.id, DespatchNote.dn_no, DespatchNote.invoice_no,
               DespatchNote.vehicle_no)
        .where(DespatchNote.po_id == po_id,
               DespatchNote.status == DespatchNoteStatus.SUBMITTED.value)
        .order_by(DespatchNote.id.desc())
    )).all()
    return [{
        "id": row[0], "code": row[1],
        # What a storekeeper actually matches against the paper in their hand.
        "name": " · ".join(part for part in (row[2], row[3]) if part) or row[1],
    } for row in rows]


async def despatch_note_prefill(db: AsyncSession, note_id: int) -> s.DespatchPrefill:
    """Everything a receipt would otherwise be typed from.

    Header and lines in one call, because they are one act at the gate — the paperwork
    and the cartons arrive together. `received_qty` is seeded from what the vendor says
    they sent, as a count to CONFIRM rather than a figure to trust: the storekeeper
    overwrites it with what is physically there, and the difference is the shortage the
    GRN is for.
    """
    from app.modules.procurement.models import (
        DespatchNote, DespatchNoteItem, POItem,
    )

    note = (await db.execute(
        select(DespatchNote).where(DespatchNote.id == note_id))).scalars().first()
    if note is None:
        raise NotFoundError(f"Despatch note {note_id} not found")

    lines = (await db.execute(
        select(DespatchNoteItem)
        .where(DespatchNoteItem.despatch_note_id == note.id)
        .order_by(DespatchNoteItem.line_no))).scalars().all()

    ordered = {row[0]: _d(row[1]) for row in (await db.execute(
        select(POItem.id, POItem.quantity).where(POItem.po_id == note.po_id)))
        .all()} if note.po_id else {}
    rates = {row[0]: row[1] for row in (await db.execute(
        select(POItem.id, POItem.rate).where(POItem.po_id == note.po_id)))
        .all()} if note.po_id else {}

    return s.DespatchPrefill(
        despatch_note_id=note.id, despatch_note_no=note.dn_no,
        po_id=note.po_id, po_no=note.po_no,
        vendor_id=note.vendor_id, vendor_name=note.vendor_name,
        invoice_no=note.invoice_no, invoice_date=note.invoice_date,
        invoice_amount=note.invoice_amount, eway_bill_no=note.eway_bill_no,
        vehicle_no=note.vehicle_no, transporter_name=note.transporter_name,
        lr_no=note.lr_no,
        lines=[s.DespatchPrefillLine(
            po_item_id=line.po_item_id, item_id=line.item_id,
            item_code=line.item_code, item_name=line.item_name,
            uom_code=line.uom_code,
            ordered_qty=ordered.get(line.po_item_id or 0, ZERO),
            despatched_qty=_d(line.despatched_qty),
            rate=rates.get(line.po_item_id or 0),
            batch_no=line.batch_no, mfg_date=line.mfg_date,
            expiry_date=line.expiry_date,
        ) for line in lines],
    )


async def _receipt_vendor(db: AsyncSession, data) -> tuple[int | None, str | None, str | None]:
    """Who the goods came from — id, name and GSTIN, for the receipt's snapshot.

    What the gate chose wins; failing that it is a fact of the order, not a choice at
    the gate. The ORDER's own snapshot name is the last resort, because a vendor whose
    master row has since been removed still delivered the goods, and a receipt naming
    nobody is worse than one naming who it was bought from.

    Two columns, not the mapped row — see `_po_number`: selecting `PurchaseOrder`
    itself is a 1054 against the live schema.
    """
    vendor_id, po_vendor_name = data.vendor_id, None
    if not vendor_id and data.po_id:
        from app.modules.procurement.models import PurchaseOrder
        row = (await db.execute(
            select(PurchaseOrder.vendor_id, PurchaseOrder.vendor_name)
            .where(PurchaseOrder.id == data.po_id))).first()
        if row:
            vendor_id, po_vendor_name = row[0], row[1]

    vendor = await db.get(Vendor, vendor_id) if vendor_id else None
    if vendor is not None:
        return vendor.id, vendor.name, vendor.gstin
    return vendor_id, po_vendor_name, None


async def po_lines(db: AsyncSession, po_id: int) -> list[s.PoLineOption]:
    """Open lines of a PO, so a GRN fills itself from the order.

    Already-received quantity is summed from the receipts against this PO rather than
    trusted from a column, because a line can be received across several deliveries.
    """
    from app.modules.procurement.models import POItem

    # Named columns on both tables — the mapped rows carry columns the live schema does
    # not have (see _po_number), and the GRN form only needs what a line orders.
    if await _po_number(db, po_id) is None:
        raise NotFoundError(f"Purchase order {po_id} not found")

    items = (await db.execute(
        select(POItem.id, POItem.item_id, POItem.item_code, POItem.item_name,
               POItem.uom_code, POItem.quantity, POItem.rate)
        .where(POItem.po_id == po_id).order_by(POItem.id))).all()

    received_rows = (await db.execute(
        select(m.ReceiptItem.po_item_id, func.coalesce(func.sum(m.ReceiptItem.received_qty), 0))
        .join(m.Receipt, m.Receipt.id == m.ReceiptItem.receipt_id)
        .where(m.Receipt.po_id == po_id,
               m.Receipt.status != ReceiptStatus.CANCELLED.value)
        .group_by(m.ReceiptItem.po_item_id)
    )).all()
    received = {row[0]: _d(row[1]) for row in received_rows if row[0]}

    out: list[s.PoLineOption] = []
    for line in items:
        ordered = _d(getattr(line, "quantity", None) or getattr(line, "qty", None))
        already = received.get(line.id, ZERO)
        pending = max(ordered - already, ZERO)
        if pending <= ZERO:
            continue
        out.append(s.PoLineOption(
            po_item_id=line.id,
            item_id=line.item_id,
            item_code=getattr(line, "item_code", None),
            item_name=getattr(line, "item_name", None),
            uom_code=getattr(line, "uom_code", None),
            ordered_qty=ordered,
            received_qty=already,
            pending_qty=pending,
            rate=getattr(line, "rate", None),
            indent_id=getattr(line, "indent_id", None),
            indent_no=getattr(line, "indent_no", None),
        ))
    return out


# ---------------------------------------------------------------------------
# Quality inspection
# ---------------------------------------------------------------------------

def _inspection_totals(inspection: m.Inspection) -> None:
    lines = inspection.items
    inspection.total_items = len(lines)
    inspection.passed_items = sum(1 for l in lines if l.result == InspectionResult.PASSED.value)
    inspection.failed_items = sum(1 for l in lines if l.result == InspectionResult.FAILED.value)


def _derive_result(inspected: Decimal, accepted: Decimal) -> str:
    if inspected <= ZERO:
        return InspectionResult.PENDING.value
    if accepted >= inspected:
        return InspectionResult.PASSED.value
    if accepted <= ZERO:
        return InspectionResult.FAILED.value
    return InspectionResult.PARTIAL.value


async def _raise_inspection_for(
    db: AsyncSession,
    receipt: m.Receipt,
    user,
    lines: list[m.ReceiptItem] | None = None,
) -> m.Inspection:
    """The inspection a submitted receipt creates, seeded from its lines."""
    inspection = m.Inspection(
        # see create_receipt: once the flush below makes this row persistent, the first
        # touch of an uninitialised collection is a lazy SELECT, which async has no
        # greenlet to run in. Handing it an empty list loads it up front.
        items=[],
        inspection_no=await next_number(db, WarehouseDocType.INSPECTION.value),
        inspection_date=ist_today(),
        receipt_id=receipt.id, grn_no=receipt.grn_no,
        warehouse_id=receipt.warehouse_id, warehouse_name=receipt.warehouse_name,
        vendor_id=receipt.vendor_id, vendor_name=receipt.vendor_name,
        inspection_type=InspectionType.INCOMING.value,
        status=InspectionStatus.DRAFT.value,
        inspector_id=getattr(user, "id", None), inspector_name=_name(user),
    )
    db.add(inspection)
    await db.flush()

    for line in lines if lines is not None else receipt.items:
        inspection.items.append(m.InspectionItem(
            receipt_item_id=line.id, item_id=line.item_id,
            item_code=line.item_code, item_name=line.item_name, uom_code=line.uom_code,
            batch_no=line.batch_no,
            inspected_qty=_d(line.received_qty), accepted_qty=_d(line.received_qty),
            rejected_qty=ZERO, result=InspectionResult.PENDING.value,
            serial_numbers=list(line.serial_numbers or []),
        ))
    _inspection_totals(inspection)
    await db.flush()
    return inspection


async def list_inspections(db: AsyncSession, params: PageParams, *,
                           inspection_type: str | None = None, status: str | None = None,
                           warehouse_id: int | None = None, search: str | None = None, user=None) -> dict:
    stmt = select(m.Inspection)
    if user is not None:
        # Warehouse scope, plus the inspections this person ran. Every other document
        # here falls back to its owner (see `list_receipts`); this one did not, so an
        # inspector who QC'd a delivery at a point outside their own scope watched it
        # vanish the moment they saved it — their own signature on a document they
        # could no longer open.
        stmt = stmt.where(await scope_condition(
            db, user,
            warehouse_col=m.Inspection.warehouse_id,
            warehouse_ids=await warehouse_ids_for_user(db, user),
            owner_col=m.Inspection.inspector_id,
        ))
    if inspection_type:
        stmt = stmt.where(m.Inspection.inspection_type == inspection_type)
    if status:
        stmt = stmt.where(m.Inspection.status.in_(_any_case(status)))
    if warehouse_id:
        stmt = stmt.where(m.Inspection.warehouse_id == warehouse_id)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(
            m.Inspection.inspection_no.ilike(like), m.Inspection.grn_no.ilike(like),
            m.Inspection.vendor_name.ilike(like)))
    return await paginate(db, stmt.order_by(m.Inspection.id.desc()), params)


async def get_inspection(db: AsyncSession, inspection_id: int, user=None) -> m.Inspection:
    inspection = await _load(db, m.Inspection, inspection_id, "Inspection",
                             m.Inspection.items)
    # FIXED — see `_assert_in_scope`. `whs_inspections` has no owner column, so the
    # warehouse is the only dimension; that is the same one `list_inspections` uses.
    return await _assert_in_scope(db, user, m.Inspection, inspection,
                                  warehouse_col=m.Inspection.warehouse_id,
                                  label="Inspection")


async def _apply_inspection_lines(db: AsyncSession, inspection: m.Inspection,
                                  lines: list[s.InspectionItemWrite]) -> None:
    inspection.items.clear()
    await db.flush()

    # What the GRN says arrived. QC decides how much of a delivery is kept, so it can
    # never be about more than the delivery: inspecting 1 unit of a line that received
    # 0.999 wrote 1 unit into stock that nobody ever unloaded.
    received_by_line: dict[int, Decimal] = {}
    received_by_item: dict[int, Decimal] = {}
    line_id_by_item: dict[int, int] = {}
    if inspection.receipt_id:
        for row_id, item_id, qty in (await db.execute(
            select(m.ReceiptItem.id, m.ReceiptItem.item_id, m.ReceiptItem.received_qty)
            .where(m.ReceiptItem.receipt_id == inspection.receipt_id)
        )).all():
            received_by_line[row_id] = _d(qty)
            received_by_item[item_id] = received_by_item.get(item_id, ZERO) + _d(qty)
            line_id_by_item.setdefault(item_id, row_id)

    for line in lines:
        item = await _item_snapshot(db, line.item_id)
        inspected = _d(line.inspected_qty)
        if inspected < ZERO:
            raise ValidationError(f"{item.code}: inspected quantity cannot be negative")
        # An inspection against a GRN must name the GRN line it judges: complete_
        # inspection writes its verdict back by `receipt_item_id`, so a line that
        # arrives without one is inspected, saved, and then silently ignored — the
        # receipt keeps its full received quantity, the rejection disappears, and the
        # GRN still closes. Resolve it from the item, the same repoint the dead-id
        # branch below does, and refuse only if the item is genuinely not on the GRN.
        if line.receipt_item_id is None and inspection.receipt_id:
            line.receipt_item_id = line_id_by_item.get(line.item_id)
            if line.receipt_item_id is None:
                raise ValidationError(f"{item.code} is not on this GRN")
        if line.receipt_item_id is not None:
            if line.receipt_item_id not in received_by_line:
                # The GRN line was rebuilt under a new id after this inspection was
                # raised (see _apply_receipt_lines, which no longer does that). Repoint
                # rather than refuse: the item is on the GRN, only the id moved, and
                # refusing strands an inspection nobody can finish or delete.
                repointed = line_id_by_item.get(line.item_id)
                if repointed is None:
                    raise ValidationError(
                        f"{item.code} is not on this GRN"
                    )
                logger.warning(
                    "inspection %s line pointed at dead GRN line %s; repointed to %s",
                    inspection.inspection_no, line.receipt_item_id, repointed,
                )
                line.receipt_item_id = repointed
            received = received_by_line[line.receipt_item_id]
            if inspected > received:
                raise ValidationError(
                    f"{item.code}: {inspected} inspected but only {received} was "
                    f"received. QC cannot pass more than arrived."
                )
        if _d(line.accepted_qty) > inspected:
            raise ValidationError(
                f"{item.code}: {line.accepted_qty} accepted out of {inspected} "
                f"inspected. Accepted cannot exceed inspected."
            )
        accepted = min(_d(line.accepted_qty), inspected)
        rejected = inspected - accepted
        result = (line.result.value if line.result != InspectionResult.PENDING
                  else _derive_result(inspected, accepted))
        serials = [value.strip() for value in (line.serial_numbers or []) if value.strip()]
        if len(serials) != len(set(serials)):
            raise ValidationError(f"{item.code}: accepted serial numbers must be unique")
        # IMEIs are checked but not stored: `inb_inspection_items` has no column for
        # them, and it needs none — an IMEI names the same physical unit its serial
        # does, and the GRN line it came off already holds the list.
        imeis = [value.strip() for value in (line.imei_numbers or []) if value.strip()]
        if len(imeis) != len(set(imeis)):
            raise ValidationError(f"{item.code}: accepted IMEI numbers must be unique")
        if item.is_serial_tracked and accepted != accepted.to_integral_value():
            raise ValidationError(
                f"{item.code}: accepted quantity must be a whole number for serialized items"
            )
        if item.is_serial_tracked and len(serials) != int(accepted):
            raise ValidationError(
                f"{item.code}: select exactly {int(accepted)} accepted serial numbers"
            )
        reason = line.rejection_reason or line.defect_type

        if rejected > ZERO and not (reason or "").strip():
            raise ValidationError(
                f"{item.code}: a failed line needs a defect type — "
                "'failed' with no reason cannot be put to a vendor.")

        inspection.items.append(m.InspectionItem(
            receipt_item_id=line.receipt_item_id,
            item_id=item.id, item_code=item.code, item_name=item.name,
            uom_code=item.uom_code, batch_no=line.batch_no,
            inspected_qty=inspected, accepted_qty=accepted, rejected_qty=rejected,
            parameters=[p.model_dump() for p in line.parameters] if line.parameters else None,
            result=result, defect_type=reason, remarks=line.remarks,
            serial_numbers=serials or None,
        ))
    _inspection_totals(inspection)


async def create_inspection(db: AsyncSession, data: s.InspectionWrite, user) -> m.Inspection:
    receipt = await db.get(m.Receipt, data.receipt_id) if data.receipt_id else None
    wh = await db.get(Warehouse, data.warehouse_id) if data.warehouse_id else None

    if receipt is not None:
        # One GRN, one QC. Submitting a receipt raises its inspection automatically, so
        # this route is only ever a second one — and a second one re-decides quantities
        # the first already wrote onto the receipt. REC/2026-27/00066 collected three.
        existing = await db.scalar(
            select(m.Inspection).where(
                m.Inspection.receipt_id == receipt.id,
                m.Inspection.status != InspectionStatus.CANCELLED.value,
            ).limit(1)
        )
        if existing is not None:
            raise ValidationError(
                f"{receipt.grn_no} is already inspected on {existing.inspection_no} "
                f"({existing.status.lower()}). Cancel that one to inspect it again."
            )
        if receipt.is_stock_posted:
            raise ValidationError(
                f"{receipt.grn_no} is already in stock. QC decides what to keep before "
                "it is banked, so there is nothing left for an inspection to change."
            )

    inspection = m.Inspection(
        items=[],   # see create_issue: keeps _apply_*_lines()'s clear() off a lazy load
        inspection_no=await next_number(db, WarehouseDocType.INSPECTION.value),
        inspection_date=data.inspection_date,
        receipt_id=data.receipt_id,
        grn_no=receipt.grn_no if receipt else None,
        warehouse_id=data.warehouse_id or (receipt.warehouse_id if receipt else None),
        warehouse_name=wh.name if wh else (receipt.warehouse_name if receipt else None),
        vendor_id=receipt.vendor_id if receipt else None,
        vendor_name=receipt.vendor_name if receipt else None,
        inspection_type=data.inspection_type.value,
        status=InspectionStatus.DRAFT.value,
        inspector_id=data.inspector_id or getattr(user, "id", None),
        inspector_name=_name(user) if not data.inspector_id else None,
        remarks=data.remarks,
    )
    db.add(inspection)
    await db.flush()

    await _apply_inspection_lines(db, inspection, data.items)
    await db.flush()

    await write_audit(db, entity="inb_inspections", entity_id=inspection.id,
                      entity_no=inspection.inspection_no, action=AuditAction.CREATE, actor=user,
                      after={"status": inspection.status, "lines": len(inspection.items)})
    await db.commit()
    return await get_inspection(db, inspection.id)


async def update_inspection(db: AsyncSession, inspection_id: int, data: s.InspectionWrite,
                            user) -> m.Inspection:
    inspection = await get_inspection(db, inspection_id)
    _guard(inspection.status,
           {InspectionStatus.DRAFT.value, InspectionStatus.IN_PROGRESS.value},
           "edit", "inspection")

    before = {"status": inspection.status, "failed_items": inspection.failed_items}
    inspection.inspection_date = data.inspection_date
    inspection.inspector_id = data.inspector_id or inspection.inspector_id
    inspection.remarks = data.remarks
    inspection.status = InspectionStatus.IN_PROGRESS.value

    await _apply_inspection_lines(db, inspection, data.items)
    await db.flush()

    await write_audit(db, entity="inb_inspections", entity_id=inspection.id,
                      entity_no=inspection.inspection_no, action=AuditAction.UPDATE, actor=user,
                      before=before,
                      after={"status": inspection.status, "failed_items": inspection.failed_items})
    await db.commit()
    return await get_inspection(db, inspection_id)


async def complete_inspection(db: AsyncSession, inspection_id: int, user) -> m.Inspection:
    """Writes the outcome back onto the receipt lines.

    The receipt is the document stock is posted from, so the accepted quantity the
    inspection decided has to land there — an inspection that only recorded its own
    verdict would let a failed line still be posted in full.
    """
    inspection = await get_inspection(db, inspection_id)
    _guard(inspection.status,
           {InspectionStatus.DRAFT.value, InspectionStatus.IN_PROGRESS.value},
           "complete", "inspection")
    if not inspection.items:
        raise ValidationError("An inspection with no lines has no result to record")

    pending = [l for l in inspection.items if l.result == InspectionResult.PENDING.value]
    if pending:
        raise ValidationError(
            f"{len(pending)} line(s) are still pending. Record a result on every line first.")

    if inspection.receipt_id:
        receipt = await get_receipt(db, inspection.receipt_id)
        by_line = {l.receipt_item_id: l for l in inspection.items if l.receipt_item_id}
        released_lines: list[m.ReceiptItem] = []
        for line in receipt.items:
            verdict = by_line.get(line.id)
            if verdict is None:
                continue
            original_serials = list(line.serial_numbers or [])
            accepted_serials = list(verdict.serial_numbers or [])
            # A serial-tracked line always reaches QC with its full list, because the GRN
            # will not save without one serial per received unit. The guard stays
            # conditional for the untracked lines, whose list is empty and whose
            # inspection therefore has nothing to select from.
            if original_serials and not set(accepted_serials).issubset(set(original_serials)):
                raise ValidationError(
                    f"{line.item_code}: accepted serials must come from the GRN"
                )
            rejected_serials = [
                serial for serial in original_serials if serial not in set(accepted_serials)
            ]
            line.accepted_qty = _d(verdict.accepted_qty)
            line.rejected_qty = _d(verdict.rejected_qty)
            line.qc_status = verdict.result
            line.rejection_reason = verdict.defect_type or line.rejection_reason
            line.serial_numbers = accepted_serials or None
            rate = _d(line.rate)
            line.amount = (line.accepted_qty * rate) if rate else None
            if rejected_serials:
                await _register_serials(
                    db,
                    receipt,
                    line,
                    serial_numbers=rejected_serials,
                    status=SerialStatus.MAINTENANCE.value,
                    remarks=f"Rejected by inspection {inspection.inspection_no}",
                )
            if line.accepted_qty > ZERO:
                released_lines.append(line)
        _receipt_totals(receipt)
        accepted = _d(receipt.total_accepted_qty)
        rejected = _d(receipt.total_rejected_qty)
        if accepted > ZERO and rejected > ZERO:
            receipt.status = ReceiptStatus.PARTIALLY_RECEIVED.value
        elif accepted > ZERO:
            receipt.status = ReceiptStatus.QC_PASSED.value
        else:
            receipt.status = ReceiptStatus.QC_FAILED.value

        # Posting is guarded, the status is not. A bulk point banks its stock the
        # moment the GRN is submitted, and an inspection raised against that GRN
        # afterwards used to run every line through `_prepare_receipt_line` a second
        # time: one unit received, two in `stk_balance`. But the receipt still has to
        # reach COMPLETED — gating the status on the same flag left it sitting at
        # QC_PASSED with its stock already banked, which is a state no screen lists.
        already_posted = receipt.is_stock_posted
        if not already_posted:
            for line in released_lines:
                await _prepare_receipt_line(db, receipt, line, user)
        wh = await _warehouse(db, receipt.warehouse_id)
        # `is_stock_posted` is a claim about `stk_ledger`, so it is only ever set where
        # stock genuinely reached it: either an earlier submit banked the lines, or the
        # loop above just did. Setting it on `accepted > ZERO` alone marked a GRN that
        # posted nothing as posted — and `cancel_receipt` then refuses to touch the
        # document, because it believes there is stock behind it to account for.
        if not wh.is_bin_managed and accepted > ZERO and (already_posted or released_lines):
            receipt.status = ReceiptStatus.COMPLETED.value
            receipt.is_stock_posted = True
            receipt.posted_at = receipt.posted_at or utcnow()
            if not already_posted:
                await _sync_po_receipt_status(db, receipt.po_id)
                await _sync_receipt_source(db, receipt)

    inspection.status = InspectionStatus.COMPLETED.value

    await write_audit(db, entity="inb_inspections", entity_id=inspection.id,
                      entity_no=inspection.inspection_no, action=AuditAction.UPDATE, actor=user,
                      before={"status": InspectionStatus.IN_PROGRESS.value},
                      after={"status": inspection.status,
                             "passed": inspection.passed_items,
                             "failed": inspection.failed_items})
    await db.commit()
    return await get_inspection(db, inspection_id)


async def _reopen_receipt_after_cancel(db: AsyncSession, inspection: m.Inspection,
                                       user) -> None:
    """Walk a receipt back to DRAFT when the inspection holding it is cancelled.

    Submitting moves the receipt to PENDING_QC and hands it to an inspection. Cancel that
    inspection and the receipt was stranded: PENDING_QC has nothing left to complete it,
    and the status is outside what `update_receipt` will edit — the document could not be
    corrected or finished by anyone. A receipt whose serials were never captured wedged
    exactly this way.

    It only reopens what is genuinely untouched. Lines that do not require QC are
    released to stock or putaway at submit (`_prepare_receipt_line`), and re-submitting
    would post them a second time, so a receipt with any released line stays where it is.
    """
    if not inspection.receipt_id:
        return
    receipt = await get_receipt(db, inspection.receipt_id)
    if receipt.status != ReceiptStatus.PENDING_QC.value or receipt.is_stock_posted:
        return

    other_open = (await db.execute(
        select(m.Inspection.id).where(
            m.Inspection.receipt_id == receipt.id,
            m.Inspection.id != inspection.id,
            m.Inspection.status.in_((InspectionStatus.DRAFT.value,
                                     InspectionStatus.IN_PROGRESS.value)),
        ).limit(1))).scalars().first()
    if other_open:
        return

    if any(line.qc_status == QcStatus.PASSED.value for line in receipt.items):
        return   # a line already went to stock or putaway; re-submitting would repeat it

    before = {"status": receipt.status}
    receipt.status = ReceiptStatus.DRAFT.value
    await write_audit(db, entity="inb_receipts", entity_id=receipt.id,
                      entity_no=receipt.grn_no, action=AuditAction.UPDATE, actor=user,
                      before=before,
                      after={"status": receipt.status,
                             "reason": f"{inspection.inspection_no} cancelled"})


async def cancel_inspection(db: AsyncSession, inspection_id: int, reason: str | None,
                            user) -> m.Inspection:
    inspection = await get_inspection(db, inspection_id)
    _guard(inspection.status,
           {InspectionStatus.DRAFT.value, InspectionStatus.IN_PROGRESS.value},
           "cancel", "inspection")
    before = {"status": inspection.status}
    inspection.status = InspectionStatus.CANCELLED.value
    inspection.remarks = f"{inspection.remarks or ''}\nCancelled: {reason or '—'}".strip()

    await write_audit(db, entity="inb_inspections", entity_id=inspection.id,
                      entity_no=inspection.inspection_no, action=AuditAction.UPDATE, actor=user,
                      before=before, after={"status": inspection.status, "reason": reason})
    await _reopen_receipt_after_cancel(db, inspection, user)
    await db.commit()
    return await get_inspection(db, inspection_id)


# ---------------------------------------------------------------------------
# Putaway
# ---------------------------------------------------------------------------

async def _decorate_putaway(db: AsyncSession, task: m.PutawayTask) -> dict:
    """`whs_warehouse_items` is a work queue and carries only ids, so the labels the
    screen needs are resolved here rather than being snapshotted onto the table —
    a task lives for hours, not years, and cannot go stale in that time."""
    item = await db.get(Item, task.item_id)
    wh = await db.get(Warehouse, task.warehouse_id)
    batch = await db.get(m.Batch, task.batch_id) if task.batch_id else None
    receipt = await get_receipt(db, task.grn_id) if task.grn_id else None
    receipt_item = (
        await db.get(m.ReceiptItem, task.grn_item_id)
        if task.grn_item_id else None
    )
    return {
        "id": task.id, "putaway_no": task.putaway_no,
        "grn_id": task.grn_id, "grn_no": receipt.grn_no if receipt else None,
        "grn_item_id": task.grn_item_id,
        "warehouse_id": task.warehouse_id, "warehouse_name": wh.name if wh else None,
        "item_id": task.item_id,
        "item_code": item.code if item else None,
        "item_name": item.name if item else None,
        "uom_id": task.uom_id, "uom_code": item.uom_code if item else None,
        "batch_id": task.batch_id, "batch_no": batch.batch_no if batch else None,
        "expiry_date": (
            batch.expiry_date if batch else (
                receipt_item.expiry_date if receipt_item else None
            )
        ),
        "qty": task.qty,
        "suggested_bin_id": task.suggested_bin_id,
        "suggested_bin_code": await _bin_code(db, task.suggested_bin_id),
        "actual_bin_id": task.actual_bin_id,
        "actual_bin_code": await _bin_code(db, task.actual_bin_id),
        # The whole storage path, so the screen can say "block A > flr-1 > … > bin A1"
        # rather than a bin code with no context.
        "actual_bin_path": " / ".join(
            node.code for node in await _ancestry(db, task.actual_bin_id)
        ) or None,
        "lot_no": task.lot_no,
        "putaway_type": task.putaway_type, "status": task.status,
        "assigned_to": task.assigned_to, "assigned_to_name": None,
        "scanned_by": task.scanned_by, "scanned_at": task.scanned_at,
        "started_at": task.started_at, "completed_at": task.completed_at,
        "remarks": task.remarks,
        # Whatever was captured upstream, which may be nothing: serials are optional at
        # the GRN and at inspection. Putaway is where every unit is named, so the screen
        # needs to know whether to ask — hence the flag beside them.
        "serial_numbers": list(receipt_item.serial_numbers or []) if receipt_item else [],
        "is_serial_tracked": bool(item.is_serial_tracked) if item else False,
        "is_asset": bool(item.is_asset) if item else False,
        "created_at": task.created_at,
    }


async def list_putaways(db: AsyncSession, params: PageParams, *, status: str | None = None,
                        warehouse_id: int | None = None, search: str | None = None,
                        user=None) -> dict:
    stmt = select(m.PutawayTask)
    if user is not None:
        stmt = stmt.where(await scope_condition(
            db, user,
            warehouse_col=m.PutawayTask.warehouse_id,
            warehouse_ids=await warehouse_ids_for_user(db, user),
        )).where(m.PutawayTask.is_active.is_(True))
    if status:
        stmt = stmt.where(m.PutawayTask.status == status)
    if warehouse_id:
        stmt = stmt.where(m.PutawayTask.warehouse_id == warehouse_id)
    if search:
        # The list screen's search box reaches the server now, so it has to be
        # answerable here: the task number, the GRN it came from, or the lot code.
        like = f"%{search}%"
        stmt = stmt.where(or_(
            m.PutawayTask.putaway_no.ilike(like), m.PutawayTask.lot_no.ilike(like)))

    page = await paginate(db, stmt.order_by(m.PutawayTask.id.desc()), params)
    page["items"] = [await _decorate_putaway(db, t) for t in page["items"]]
    return page


async def get_putaway(db: AsyncSession, task_id: int, user=None) -> dict:
    task = await _get(db, m.PutawayTask, task_id, "Putaway task")
    # FIXED — see `_assert_in_scope`.
    await _assert_in_scope(db, user, m.PutawayTask, task,
                           warehouse_col=m.PutawayTask.warehouse_id,
                           label="Putaway task")
    return await _decorate_putaway(db, task)


# A line with a task in one of these already has its putaway accounted for: three of
# them are work in hand and the fourth has been placed. Skipped and cancelled are the
# two that leave the stock still standing on the floor, so those may be re-raised.
_SETTLED_PUTAWAY_STATUSES = (
    PutawayStatus.DRAFT.value,
    PutawayStatus.PENDING.value,
    PutawayStatus.IN_PROGRESS.value,
    PutawayStatus.COMPLETED.value,
)


async def putaway_candidates(db: AsyncSession, receipt_id: int) -> list[dict]:
    """The GRN lines a manual putaway could be raised for, with a reason when it
    cannot. The screen shows the ineligible ones too — "why can I not put this away"
    is the question being asked, and an empty list does not answer it."""
    receipt = await get_receipt(db, receipt_id)
    wh = await _warehouse(db, receipt.warehouse_id)
    rows: list[dict] = []
    for line in receipt.items:
        blocking = await db.scalar(
            select(m.PutawayTask).where(
                m.PutawayTask.grn_item_id == line.id,
                m.PutawayTask.status.in_(_SETTLED_PUTAWAY_STATUSES),
            ).limit(1)
        )
        reason = _putaway_block_reason(receipt, wh, line, blocking)
        rows.append({
            "grn_item_id": line.id,
            "item_id": line.item_id,
            "item_code": line.item_code,
            "item_name": line.item_name,
            "uom_code": line.uom_code,
            "batch_no": line.batch_no,
            "accepted_qty": _d(line.accepted_qty),
            "qc_status": line.qc_status,
            "existing_putaway_no": blocking.putaway_no if blocking else None,
            "eligible": reason is None,
            "reason": reason,
        })
    return rows


def _putaway_block_reason(receipt: m.Receipt, wh: Warehouse, line: m.ReceiptItem,
                          blocking: m.PutawayTask | None) -> str | None:
    """Why this line cannot be put away, or None if it can."""
    if not wh.is_bin_managed:
        return f"{wh.name} does not use bins — its stock is posted at receipt"
    if receipt.is_stock_posted:
        return f"{receipt.grn_no} is already posted to stock"
    if line.qc_status != QcStatus.PASSED.value:
        return f"QC is {line.qc_status.lower()}"
    if _d(line.accepted_qty) <= ZERO:
        return "nothing was accepted on this line"
    if blocking is not None:
        return f"{blocking.putaway_no} already covers this line ({blocking.status})"
    return None


async def create_putaway(db: AsyncSession, data: s.PutawayCreate, user) -> list[dict]:
    """Raise putaway tasks by hand for GRN lines that have none.

    QC passing a line raises its task automatically, so this is the repair path — a
    task that was cancelled, or one skipped back when skipping was still a thing and
    the pallet is still standing there. It is anchored to a GRN line on purpose:
    `confirm_putaway` only moves stock IN, so a task with no receipt behind it would
    conjure stock into a bin that nothing was ever received into.
    """
    receipt = await get_receipt(db, data.grn_id)
    wh = await _warehouse(db, receipt.warehouse_id)
    wanted = set(data.grn_item_ids)
    unknown = wanted - {line.id for line in receipt.items}
    if unknown:
        raise ValidationError(
            f"{receipt.grn_no} has no line {sorted(unknown)[0]}"
        )
    lines = [line for line in receipt.items if not wanted or line.id in wanted]

    tasks: list[m.PutawayTask] = []
    for line in lines:
        blocking = await db.scalar(
            select(m.PutawayTask).where(
                m.PutawayTask.grn_item_id == line.id,
                m.PutawayTask.status.in_(_SETTLED_PUTAWAY_STATUSES),
            ).limit(1)
        )
        reason = _putaway_block_reason(receipt, wh, line, blocking)
        if reason is not None:
            # Selected lines are the operator's explicit ask, so a blocked one is an
            # error. "Everything eligible" is a filter, so a blocked one is just skipped.
            if wanted:
                raise ValidationError(f"{line.item_code}: {reason}")
            continue
        tasks.append(await _build_putaway_task(db, receipt, line, user))

    if not tasks:
        raise ValidationError(
            f"{receipt.grn_no} has no line waiting to be put away"
        )

    for task in tasks:
        await write_audit(db, entity="whs_warehouse_items", entity_id=task.id,
                          entity_no=task.putaway_no, action=AuditAction.CREATE,
                          actor=user,
                          after={"grn_no": receipt.grn_no, "grn_item_id": task.grn_item_id,
                                 "qty": str(task.qty), "raised": "manual"})
    await db.commit()
    return [await get_putaway(db, task.id) for task in tasks]


async def start_putaway(db: AsyncSession, task_id: int, user) -> dict:
    task = await _get(db, m.PutawayTask, task_id, "Putaway task")
    _guard(task.status, {PutawayStatus.PENDING.value, PutawayStatus.DRAFT.value},
           "start", "putaway task")
    task.status = PutawayStatus.IN_PROGRESS.value
    task.started_at = utcnow()
    task.assigned_to = task.assigned_to or getattr(user, "id", None)

    await write_audit(db, entity="whs_warehouse_items", entity_id=task.id,
                      entity_no=task.putaway_no, action=AuditAction.UPDATE, actor=user,
                      before={"status": PutawayStatus.PENDING.value},
                      after={"status": task.status})
    await db.commit()
    return await get_putaway(db, task_id)


async def confirm_putaway(db: AsyncSession, task_id: int, data: s.PutawayConfirm, user) -> dict:
    """Moves the stock out of bulk and into the bin.

    Two movements, not one: OUT of `bin_id = 0` and IN to the chosen bin. `move_stock`
    is the only thing that touches stock and it moves one location at a time, so a
    transfer between bins is a pair — and the pair leaves two ledger rows that read as
    what physically happened.
    """
    task = await _get(db, m.PutawayTask, task_id, "Putaway task")
    _guard(task.status,
           {PutawayStatus.PENDING.value, PutawayStatus.IN_PROGRESS.value,
            PutawayStatus.DRAFT.value},
           "confirm", "putaway task")

    target = await _get(db, Bin, data.actual_bin_id, "Bin")
    if target.warehouse_id != task.warehouse_id:
        raise ValidationError(f"Bin {target.code} is not in this warehouse")
    if not target.is_active:
        raise ValidationError(f"Bin {target.code} is inactive")
    if target.bin_type not in m.BIN_TYPES:
        raise ValidationError(
            f"{target.code} is a {target.bin_type.lower()}, not a stock-holding bin"
        )

    qty = _d(data.qty) if data.qty is not None else _d(task.qty)
    if qty <= ZERO:
        raise ValidationError("Putaway quantity must be positive")
    if qty > _d(task.qty):
        raise ValidationError(
            f"This task is for {task.qty}; {qty} is more than was received.")

    receipt = await get_receipt(db, task.grn_id) if task.grn_id else None
    project_id = (receipt.project_id if receipt else None) or 0
    ref_no = task.putaway_no or f"PUT-{task.id}"
    receipt_item = (
        await db.get(m.ReceiptItem, task.grn_item_id)
        if task.grn_item_id else None
    )
    item = await _item_snapshot(db, task.item_id)
    serials = list(data.serial_numbers or (
        receipt_item.serial_numbers if receipt_item else []
    ) or [])
    if item.is_serial_tracked:
        if qty != qty.to_integral_value() or len(serials) != int(qty):
            raise ValidationError(
                f"Select exactly {int(qty)} serial numbers for this putaway"
            )
        if qty != _d(task.qty):
            raise ValidationError(
                "A serialized putaway cannot be split; place all selected units together"
            )
    batch = await db.get(m.Batch, task.batch_id) if task.batch_id else None
    stock = await move_stock(db, item_id=task.item_id, qty=qty, direction=StockDirection.IN.value,
                             ref_type=InventoryRefType.RECEIPT.value,
                             ref_id=receipt.id if receipt else task.id,
                             ref_no=receipt.grn_no if receipt else ref_no,
                             user=user, warehouse_id=task.warehouse_id,
                             bin_id=target.id, batch_id=task.batch_id or m.NO_BATCH,
                             project_id=project_id,
                             # Putaway moves the same goods into their bin, so it
                             # carries the same cost the batch was received at.
                             rate=batch.rate if batch else None)
    if batch is not None:
        stock.batch_no = batch.batch_no
        stock.expiry_date = batch.expiry_date
    stock.bin_code = target.code

    # The lot is stamped here and only here: it names the storage path, so it cannot
    # be known before a bin is chosen. A split putaway leaves the remainder without
    # one until it is itself confirmed into a bin, which may be a different one.
    task.lot_no = await _next_lot_no(db, await db.get(Warehouse, task.warehouse_id), target)

    await _place_serials(db, task, target, serials, receipt, receipt_item, qty=qty)
    # A continuous item has no unit to name, so its identity goes on the LOT — the same
    # rule the bulk-receipt path applies. Without this a bin-managed putaway of grams or
    # litres produced no unit rows AND no lot code, and the stock screens, which read
    # the code off `stk_balance`, showed a dash for goods that had been put away.
    if not serials and not await _is_countable(db, item):
        await _code_lot(db, stock, item=item, warehouse_id=task.warehouse_id)

    task.actual_bin_id = target.id
    task.scanned_by = getattr(user, "id", None)
    task.scanned_at = utcnow()
    task.remarks = data.remarks or task.remarks
    remainder = _d(task.qty) - qty
    task.status = PutawayStatus.COMPLETED.value
    task.completed_at = utcnow()
    task.qty = qty
    if remainder > ZERO:
        db.add(m.PutawayTask(
            putaway_no=await next_number(db, WarehouseDocType.PUTAWAY.value),
            grn_id=task.grn_id,
            grn_item_id=task.grn_item_id,
            warehouse_id=task.warehouse_id,
            item_id=task.item_id,
            batch_id=task.batch_id,
            uom_id=task.uom_id,
            qty=remainder,
            suggested_bin_id=task.suggested_bin_id,
            putaway_type=task.putaway_type,
            status=PutawayStatus.PENDING.value,
            assigned_to=task.assigned_to,
            is_active=True,
            remarks=f"Remainder from {task.putaway_no}",
        ))

    await write_audit(db, entity="whs_warehouse_items", entity_id=task.id,
                      entity_no=task.putaway_no, action=AuditAction.UPDATE, actor=user,
                      before={"status": PutawayStatus.IN_PROGRESS.value,
                              "suggested_bin_id": task.suggested_bin_id},
                      after={"status": task.status, "actual_bin_id": target.id,
                             "qty": str(qty)})
    if receipt is not None:
        open_tasks = await db.scalar(
            select(func.count()).select_from(m.PutawayTask).where(
                m.PutawayTask.grn_id == receipt.id,
                m.PutawayTask.status.notin_(
                    (PutawayStatus.COMPLETED.value, PutawayStatus.CANCELLED.value)
                ),
            )
        )
        pending_qc = any(
            line.qc_status == QcStatus.PENDING.value for line in receipt.items
        )
        if not open_tasks and not pending_qc:
            receipt.status = ReceiptStatus.COMPLETED.value
            receipt.is_stock_posted = True
            receipt.posted_at = utcnow()
            await _sync_po_receipt_status(db, receipt.po_id)
    await db.commit()
    return await get_putaway(db, task_id)


async def _place_serials(
    db: AsyncSession,
    task: m.PutawayTask,
    target: Bin,
    serial_numbers: list[str],
    receipt: m.Receipt | None,
    receipt_item: m.ReceiptItem | None,
    qty=None,
) -> None:
    """Puts the line's serials in the bin and gives each its asset/consumable code.

    The code is generated here rather than in masters (CLAUDE.md, masters overhaul):
    a unit only becomes an asset once it is physically somewhere.

    Its SHAPE, though, is not decided here. The formula lives in
    Settings > Code Formats (`platform/settings/codeformat.py`) because the business
    changes it — item-code plus a running number one quarter, item-code plus a
    new/old flag plus an 8-digit serial the next — and each change was a code change.
    """
    if not serial_numbers:
        await _place_unit_codes(
            db,
            item_id=task.item_id,
            warehouse_id=task.warehouse_id,
            batch_id=task.batch_id,
            bin_id=target.id,
            lot_no=task.lot_no,
            qty=qty if qty is not None else task.qty,
        )
        return
    if receipt is None or receipt_item is None:
        raise ValidationError("Serialized putaway is missing its GRN line")
    serials = await _register_serials(
        db,
        receipt,
        receipt_item,
        serial_numbers=serial_numbers,
        status=SerialStatus.AVAILABLE.value,
        bin_id=target.id,
    )

    item = await db.get(Item, task.item_id)
    for serial in serials:
        serial.batch_id = task.batch_id or receipt_item.batch_id or serial.batch_id
        serial.warehouse_id = task.warehouse_id
        serial.bin_id = target.id
        serial.status = SerialStatus.AVAILABLE.value
        serial.lot_no = task.lot_no
    await _code_serial_rows(db, serials, item=item, warehouse_id=task.warehouse_id)


async def _is_countable(db: AsyncSession, item) -> bool:
    """Whether this item's stock is made of units that can each carry a code.

    Grams of cotton and litres of spirit cannot: a code names ONE physical thing and
    there is no "one" in a continuous measure. 30 grams is a single lot, not 30 things
    to label. Those get one code on the LOT instead — see `_code_lot`.

    This is the same rule `scripts/inventory_reconcile.py` applies when it strips
    `is_serial_tracked` off measured items and deactivates the per-unit rows that flag
    produced. Enforcing it here is what stops those rows being minted again.

    An item with no unit reads as countable, which is what this did before the check
    existed — an unset field must not silently stop goods being coded.
    """
    uom_id = getattr(item, "uom_id", None)
    if not uom_id:
        return True
    uom = await db.get(Uom, uom_id)
    return (getattr(uom, "uom_class", None) or "").upper() in _COUNTABLE_UOM_CLASSES


async def _code_lot(
    db: AsyncSession,
    stock,
    *,
    item,
    warehouse_id: int | None,
    config: dict | None = None,
) -> None:
    """One asset / consumable code for a lot whose units cannot each carry one.

    A continuous item is one `stk_balance` row and no unit rows, so its identity has
    to live on the lot. Same formula, rendered against the balance row id — which is
    what `scripts/backfill_codes_and_prices.code_unserialised_lots` did for the stock
    that predates this, so old and new lots read the same.

    Never re-stamped, and never below the top rung, for the reasons in
    `_place_unit_codes`.
    """
    if stock is None or item is None:
        return
    if stock.asset_code or stock.consumable_code:
        return
    warehouse = await db.get(Warehouse, warehouse_id) if warehouse_id else None
    if stock_locations.tier_of(getattr(warehouse, "warehouse_type", None)) \
            is not stock_locations.LocationTier.WAREHOUSE:
        return
    config = config or await codeformat.code_settings(db)
    if not codeformat.is_code_tracked(item, config):
        return
    # The formula runs off the row id, so the lot must exist before it can be named.
    if stock.id is None:
        await db.flush()
    is_asset = bool(getattr(item, "is_asset", False))
    code = await codeformat.unit_code(
        db, item=item, is_asset=is_asset, seq=stock.id,
        warehouse_code=getattr(warehouse, "code", None), config=config,
    )
    if is_asset:
        stock.asset_code, stock.consumable_code = code, None
    else:
        stock.consumable_code, stock.asset_code = code, None
    await db.flush()


async def _code_serial_rows(
    db: AsyncSession,
    serials: list[m.SerialNumber],
    *,
    item,
    warehouse_id: int | None,
    config: dict | None = None,
) -> None:
    """Stamp the asset / consumable code onto units that already have their rows.

    Split out of `_place_serials` so the bulk-receipt path can call it: a stocking
    point with no bins never reaches a putaway, and its units were left uncoded.
    """
    if not serials:
        return
    is_asset = bool(getattr(item, "is_asset", False)) if item else False
    warehouse = await db.get(Warehouse, warehouse_id) if warehouse_id else None
    config = config or await codeformat.code_settings(db)
    # The item master's asset/consumable-code toggle. Off means the unit keeps its
    # serial / IMEI as its only identity — no code is minted for it.
    if not codeformat.is_code_tracked(item, config):
        await db.flush()
        return

    for serial in serials:
        code = await codeformat.unit_code(
            db, item=item, is_asset=is_asset,
            serial=serial.serial_number, seq=serial.id,
            warehouse_code=getattr(warehouse, "code", None), config=config,
        )
        # Never re-stamped: a unit's code is on its label and in every document that
        # has already quoted it, so changing the formula only affects units received
        # from now on.
        if is_asset:
            serial.asset_code = serial.asset_code or code
        else:
            serial.consumable_code = serial.consumable_code or code
    await db.flush()


async def _place_unit_codes(
    db: AsyncSession,
    *,
    item_id: int,
    warehouse_id: int | None,
    batch_id: int | None,
    bin_id: int | None,
    lot_no: str | None,
    qty,
) -> None:
    """Gives every UNIT of an unserialised receipt its own asset/consumable code.

    A code names one physical thing. Before this, a line of 30 produced one row in
    `whs_serial_numbers` at best and usually none, so the issue screen offered a
    single code for 30 units and the other 29 could not be told apart on a shelf or
    quoted on a document.

    One row per whole unit, each coded by the same `codeformat.unit_code` the
    serialized path uses. The code doubles as the row's `serial_number` because for
    an unserialised unit that IS its identity — the column is NOT NULL and nothing
    else distinguishes two units of the same item. Assets and consumables both: a
    consumable is drawn by the unit too, and its code is what the far end quotes.

    AT A WAREHOUSE ONLY. Goods enter the company at the top of the chain and are
    coded once, there; what an MDP or a LIP inwards is that same unit arriving,
    already carrying its code from the warehouse that received it. Coding it again
    at each rung would mint a second identity for one physical thing and break the
    trail the code exists to keep.

    Serial-tracked items are left alone: their units are named by `_place_serials`
    and re-coding them here would create a second row for the same physical thing.
    Continuous units (`_is_countable`) and fractional quantities are skipped — half a
    litre of oil is not a unit; that stock is named one lot at a time by `_code_lot`.
    """
    item = await db.get(Item, item_id)
    if item is None or bool(getattr(item, "is_serial_tracked", False)):
        return
    # Grams and litres have no unit to name. Guarded here as well as at the caller so
    # the putaway route cannot mint 30 rows for 30 grams of cotton either.
    if not await _is_countable(db, item):
        return
    units = _d(qty)
    if units <= ZERO or units != units.to_integral_value():
        return

    warehouse = await db.get(Warehouse, warehouse_id) if warehouse_id else None
    tier = stock_locations.tier_of(getattr(warehouse, "warehouse_type", None))
    if tier is not stock_locations.LocationTier.WAREHOUSE:
        return
    is_asset = bool(getattr(item, "is_asset", False))
    # Read once for the whole putaway: the formula cannot change between two units of
    # the same lorry, and it costs five queries every time it is read.
    config = await codeformat.code_settings(db)
    # The item master's asset/consumable-code toggle. Off means no unit rows are
    # minted for this item at all — an unserialised unit exists here ONLY to carry a
    # code, so with no code there is nothing to record.
    if not codeformat.is_code_tracked(item, config):
        return
    rows: list[m.SerialNumber] = []
    for _ in range(int(units)):
        row = m.SerialNumber(
            # `whs_serial_numbers.serial_number` is UNIQUE in the live database (the
            # ORM does not declare it, so nothing here warned about it). Every unit of
            # a line used to be inserted holding "", which meant any putaway of two or
            # more units died on a duplicate-key IntegrityError the moment this flush
            # ran — the 500 storekeepers hit confirming an inward. The placeholder only
            # has to survive one flush before the real code replaces it below, so it is
            # made unique per row and marked so a stray one is recognisable.
            item_id=item_id, serial_number=f"~PENDING-{uuid4().hex}",
            batch_id=batch_id or None, warehouse_id=warehouse_id,
            bin_id=bin_id, lot_no=lot_no,
            status=SerialStatus.AVAILABLE.value, is_active=True,
        )
        db.add(row)
        rows.append(row)
    # Flushed first: the code formula runs off the row id when there is no serial to
    # build on, so the rows must exist before they can be named.
    await db.flush()

    # Every code already spoken for, so a formula that does not vary per unit cannot
    # collide either. Read once, and only for this item: `{seq}` makes the default
    # shape unique on its own, but the format is a SETTING and a shape without it
    # renders the same string for all 30 units of a line.
    taken = {
        code.strip().lower()
        for code in (await db.execute(
            select(m.SerialNumber.serial_number)
            .where(m.SerialNumber.item_id == item_id,
                   m.SerialNumber.id.notin_([row.id for row in rows]))
        )).scalars()
        if code
    }
    for row in rows:
        code = await codeformat.unit_code(
            db, item=item, is_asset=is_asset, seq=row.id,
            warehouse_code=getattr(warehouse, "code", None), config=config,
        )
        if code.lower() in taken:
            # The row id is the one thing that cannot repeat, so it is what settles a
            # tie. Suffixed rather than replaced: the configured shape is still legible
            # on the label, and it is only reached when the format itself is ambiguous.
            code = f"{code}-{row.id}"
        taken.add(code.lower())
        row.serial_number = code
        if is_asset:
            row.asset_code = code
        else:
            row.consumable_code = code
    await db.flush()


async def skip_putaway(db: AsyncSession, task_id: int, reason: str | None, user) -> dict:
    task = await _get(db, m.PutawayTask, task_id, "Putaway task")
    _guard(task.status,
           {PutawayStatus.PENDING.value, PutawayStatus.IN_PROGRESS.value,
            PutawayStatus.DRAFT.value},
           "skip", "putaway task")
    before = {"status": task.status}
    task.status = PutawayStatus.SKIPPED.value
    task.remarks = reason or task.remarks

    await write_audit(db, entity="whs_warehouse_items", entity_id=task.id,
                      entity_no=task.putaway_no, action=AuditAction.UPDATE, actor=user,
                      before=before, after={"status": task.status, "reason": reason})
    await db.commit()
    return await get_putaway(db, task_id)


# ---------------------------------------------------------------------------
# Internal stock movements
# ---------------------------------------------------------------------------

async def _pick_bin_for(db: AsyncSession, *, item_id: int, warehouse_id: int,
                        batch_id: int | None = None) -> int | None:
    """Where this item should be picked from, or None when stock cannot say.

    The ordering is inventory's, not a second copy of it: FEFO for anything with an
    expiry so the nearest-dated lot leaves first, FIFO otherwise. Returns None
    rather than guessing when no binned balance exists — an honest "no bin" beats a
    bin the picker will find empty.
    """
    from app.modules.inventory import availability
    from app.modules.inventory.models import Stock

    item = await db.get(Item, item_id)
    stmt = select(Stock).where(
        Stock.item_id == item_id,
        Stock.warehouse_id == warehouse_id,
        Stock.bin_id != m.NO_BIN,
        Stock.available_qty > 0,
    )
    if batch_id:
        stmt = stmt.where(Stock.batch_id == batch_id)
    rows = list((await db.execute(stmt)).scalars().all())
    if not rows:
        return None
    rows.sort(key=availability.sort_key(availability.pick_strategy_for(item)))
    return rows[0].bin_id


async def stock_availability(
    db: AsyncSession,
    *,
    warehouse_id: int,
    source_bin_id: int,
    item_id: int,
    batch_id: int | None = None,
) -> dict:
    from app.modules.inventory.models import Stock
    from app.shared.models.master import Item

    item = await _get(db, Item, item_id, "Item")

    stmt = select(func.coalesce(func.sum(Stock.available_qty), 0)).where(
        Stock.warehouse_id == warehouse_id,
        Stock.bin_id == source_bin_id,
        Stock.item_id == item_id,
    )
    if batch_id:
        stmt = stmt.where(Stock.batch_id == batch_id)
    available = _d(await db.scalar(stmt))
    serial_stmt = select(m.SerialNumber).where(
        m.SerialNumber.warehouse_id == warehouse_id,
        m.SerialNumber.bin_id == source_bin_id,
        m.SerialNumber.item_id == item_id,
        m.SerialNumber.status == SerialStatus.AVAILABLE.value,
        m.SerialNumber.is_active.is_(True),
    )
    if batch_id:
        serial_stmt = serial_stmt.where(m.SerialNumber.batch_id == batch_id)
    serials = (await db.execute(
        serial_stmt.order_by(m.SerialNumber.serial_number)
    )).scalars().all()
    return {
        "available_qty": available,
        "is_serial_tracked": item.is_serial_tracked,
        "serial_numbers": [
            row.serial_number
            for row in serials
            if not (row.remarks or "").startswith("Reserved for issue ")
        ],
    }


async def create_stock_movement(
    db: AsyncSession,
    data: s.StockMovementWrite,
    user,
) -> dict:
    from app.modules.inventory.models import Stock

    wh = await _warehouse(db, data.warehouse_id)
    source = await _get(db, Bin, data.source_bin_id, "Source bin")
    destination = await _get(db, Bin, data.destination_bin_id, "Destination bin")
    if source.id == destination.id:
        raise ValidationError("Source and destination bins must be different")
    if source.warehouse_id != wh.id or destination.warehouse_id != wh.id:
        raise ValidationError("Both bins must belong to the selected warehouse")
    if not source.is_pickable or not destination.is_pickable:
        raise ValidationError("Stock can move only between stock-holding bins")
    if not source.is_active or not destination.is_active:
        raise ValidationError("Source and destination bins must be active")

    item = await _item_snapshot(db, data.item_id)
    batch_id = data.batch_id or m.NO_BATCH
    stock = (await db.execute(
        select(Stock).where(
            Stock.warehouse_id == wh.id,
            Stock.bin_id == source.id,
            Stock.item_id == item.id,
            Stock.batch_id == batch_id,
            Stock.project_id == 0,
        ).with_for_update()
    )).scalar_one_or_none()
    if stock is None or _d(stock.available_qty) < _d(data.quantity):
        available = _d(stock.available_qty) if stock else ZERO
        raise ValidationError(
            f"Only {available} is available in source bin {source.code}"
        )

    serial_numbers = [
        value.strip() for value in (data.serial_numbers or []) if value.strip()
    ]
    if len(serial_numbers) != len(set(serial_numbers)):
        raise ValidationError("Movement serial numbers must be unique")
    serial_rows: list[m.SerialNumber] = []
    if item.is_serial_tracked:
        quantity = _d(data.quantity)
        if quantity != quantity.to_integral_value() \
                or len(serial_numbers) != int(quantity):
            raise ValidationError(
                f"Select exactly {int(quantity)} serial numbers for this movement"
            )
        serial_rows = (await db.execute(
            select(m.SerialNumber).where(
                m.SerialNumber.item_id == item.id,
                m.SerialNumber.warehouse_id == wh.id,
                m.SerialNumber.bin_id == source.id,
                m.SerialNumber.batch_id == (data.batch_id if data.batch_id else None),
                m.SerialNumber.serial_number.in_(serial_numbers),
                m.SerialNumber.status == SerialStatus.AVAILABLE.value,
                m.SerialNumber.is_active.is_(True),
            ).with_for_update()
        )).scalars().all()
        if len(serial_rows) != len(serial_numbers):
            raise ValidationError(
                "One or more serial numbers are not available in the source bin"
            )
        if any((row.remarks or "").startswith("Reserved for issue ") for row in serial_rows):
            raise ValidationError("A selected serial is reserved for a material issue")
    elif serial_numbers:
        raise ValidationError(f"{item.code} is not serial tracked")

    movement_no = await next_number(db, WarehouseDocType.STOCK_MOVEMENT.value)
    await move_stock(
        db,
        item_id=item.id,
        qty=data.quantity,
        direction=StockDirection.OUT.value,
        ref_type=InventoryRefType.STOCK_MOVEMENT.value,
        ref_id=0,
        ref_no=movement_no,
        user=user,
        warehouse_id=wh.id,
        bin_id=source.id,
        batch_id=batch_id,
        project_id=0,
    )
    await move_stock(
        db,
        item_id=item.id,
        qty=data.quantity,
        direction=StockDirection.IN.value,
        ref_type=InventoryRefType.STOCK_MOVEMENT.value,
        ref_id=0,
        ref_no=movement_no,
        user=user,
        warehouse_id=wh.id,
        bin_id=destination.id,
        batch_id=batch_id,
        project_id=0,
    )
    for row in serial_rows:
        row.bin_id = destination.id
        row.remarks = f"Moved by {movement_no}"

    await write_audit(
        db,
        entity="whs_stock_movements",
        entity_id=0,
        entity_no=movement_no,
        action=AuditAction.CREATE,
        actor=user,
        after={
            "movement_type": data.movement_type,
            "warehouse_id": wh.id,
            "source_bin_id": source.id,
            "destination_bin_id": destination.id,
            "item_id": item.id,
            "batch_id": data.batch_id,
            "quantity": str(data.quantity),
            "serial_count": len(serial_numbers),
            "remarks": data.remarks,
        },
    )
    await db.commit()
    return {
        "movement_no": movement_no,
        "movement_type": data.movement_type,
        "warehouse_id": wh.id,
        "warehouse_name": wh.name,
        "source_bin_id": source.id,
        "source_bin_code": source.code,
        "destination_bin_id": destination.id,
        "destination_bin_code": destination.code,
        "item_id": item.id,
        "item_code": item.code,
        "item_name": item.name,
        "batch_id": data.batch_id,
        "batch_no": (await db.get(m.Batch, data.batch_id)).batch_no if data.batch_id else None,
        "quantity": data.quantity,
        "serial_numbers": serial_numbers,
        "status": "COMPLETED",
        "moved_by_name": _name(user),
        "moved_at": utcnow(),
        "remarks": data.remarks,
    }


async def get_stock_movement_order(db: AsyncSession, order_no: str) -> dict:
    from app.modules.inventory.models import StockMovement

    rows = (await db.execute(
        select(StockMovement)
        .where(StockMovement.ref_type == InventoryRefType.STOCK_MOVEMENT.value,
               StockMovement.ref_no == order_no)
        .order_by(StockMovement.id.asc())
    )).scalars().all()

    if not rows:
        raise ValidationError("Stock movement order not found")

    items = []
    out_rows = [r for r in rows if r.direction == StockDirection.OUT.value]
    in_rows = [r for r in rows if r.direction == StockDirection.IN.value]

    for i in range(min(len(out_rows), len(in_rows))):
        out_r = out_rows[i]
        in_r = in_rows[i]
        items.append({
            "id": i + 1,
            "order_id": 0,
            "item_id": out_r.item_id,
            "item_code": out_r.item_code,
            "item_name": out_r.item_name,
            "uom_code": out_r.uom_code,
            "source_bin_id": out_r.bin_id,
            "source_bin_code": out_r.bin_code,
            "destination_bin_id": in_r.bin_id,
            "destination_bin_code": in_r.bin_code,
            "quantity": out_r.quantity,
            "batch_id": out_r.batch_id,
            "serial_numbers": []
        })

    first = rows[0]
    return {
        "id": 0,
        "order_no": order_no,
        "warehouse_id": first.warehouse_id,
        "warehouse_name": first.warehouse_name,
        "status": "COMPLETED",
        "reason": first.remarks,
        "created_by_name": first.created_by_name,
        "created_at": first.created_at,
        "items": items
    }


async def list_stock_movement_orders(db: AsyncSession, params: PageParams, *,
                                     search: str | None = None, user=None) -> dict:
    """Multi-line bin-to-bin movements, rebuilt from the ledger.

    There is no header table. `whs_stock_movement_orders` and its items table were
    mapped and queried but have never existed on this database, so both endpoints
    answered 1054. They are not needed: every line of a movement already writes its
    OUT and IN through `move_stock` under one `ref_no` drawn from `sys_doc_series`,
    which is what makes it one document — the same way `list_stock_movements` reads
    the single-line version back. A second copy of the same fact could only drift
    from `stk_ledger`, and the ledger is the append-only record (rule 7).
    """
    from app.modules.inventory.models import StockMovement

    grouped = (
        select(
            StockMovement.ref_no.label("order_no"),
            func.max(StockMovement.id).label("last_id"),
            func.max(StockMovement.warehouse_id).label("warehouse_id"),
            func.max(StockMovement.warehouse_name).label("warehouse_name"),
            func.count().label("total_lines"),
            func.max(StockMovement.created_at).label("created_at"),
            func.max(StockMovement.created_by_name).label("created_by_name"),
            func.max(StockMovement.remarks).label("reason"),
        )
        .where(StockMovement.ref_type == InventoryRefType.STOCK_MOVEMENT.value,
               StockMovement.direction == StockDirection.OUT.value)
        .group_by(StockMovement.ref_no)
    )
    # FIXED 2026-08-20 — same leak as `list_stock_movements`, and it has to be applied
    # BEFORE the GROUP BY: filtering afterwards would still count another warehouse's
    # lines into this login's totals even where the row itself was hidden.
    if user is not None:
        grouped = grouped.where(await scope_condition(
            db, user,
            warehouse_col=StockMovement.warehouse_id,
            warehouse_ids=await warehouse_ids_for_user(db, user),
            project_col=StockMovement.project_id,
            owner_col=StockMovement.created_by_id,
        ))
    if search:
        like = f"%{search}%"
        grouped = grouped.having(or_(
            StockMovement.ref_no.ilike(like),
            func.max(StockMovement.warehouse_name).ilike(like)))
    grouped = grouped.order_by(func.max(StockMovement.id).desc())

    total = await db.scalar(select(func.count()).select_from(grouped.subquery()))
    rows = (await db.execute(
        grouped.offset(params.offset).limit(params.size))).all()
    return {
        "items": [{
            "order_no": r.order_no,
            "warehouse_id": r.warehouse_id,
            "warehouse_name": r.warehouse_name,
            "total_lines": r.total_lines,
            "status": "COMPLETED",
            "reason": r.reason,
            "created_by_name": r.created_by_name,
            "created_at": r.created_at,
        } for r in rows],
        "total": total or 0, "page": params.page, "size": params.size,
    }


async def create_stock_movement_order(
    db: AsyncSession,
    data: s.StockMovementOrderWrite,
    user,
) -> dict:
    """Move several items between bins as one numbered document.

    The document IS its `ref_no`: one number from `sys_doc_series`, carried onto every
    ledger row the lines write. No header row is stored — see
    `list_stock_movement_orders` for why — so `ref_id` is 0 rather than a foreign key
    to a table that does not exist.
    """
    from app.modules.inventory.models import Stock

    wh = await _warehouse(db, data.warehouse_id)
    order_no = await next_number(db, WarehouseDocType.STOCK_MOVEMENT.value)
    moved: list[dict] = []

    for line in data.items:
        source = await _get(db, Bin, line.source_bin_id, "Source bin")
        destination = await _get(db, Bin, line.destination_bin_id, "Destination bin")
        if source.id == destination.id:
            raise ValidationError("Source and destination bins must be different")
        if source.warehouse_id != wh.id or destination.warehouse_id != wh.id:
            raise ValidationError("Both bins must belong to the selected warehouse")
        if not source.is_pickable or not destination.is_pickable:
            raise ValidationError("Stock can move only between stock-holding bins")
        if not source.is_active or not destination.is_active:
            raise ValidationError("Source and destination bins must be active")

        item = await _item_snapshot(db, line.item_id)
        batch_id = line.batch_id or m.NO_BATCH
        stock = (await db.execute(
            select(Stock).where(
                Stock.warehouse_id == wh.id,
                Stock.bin_id == source.id,
                Stock.item_id == item.id,
                Stock.batch_id == batch_id,
                Stock.project_id == 0,
            ).with_for_update()
        )).scalar_one_or_none()
        if stock is None or _d(stock.available_qty) < _d(line.quantity):
            available = _d(stock.available_qty) if stock else ZERO
            raise ValidationError(
                f"Only {available} is available in source bin {source.code} for item {item.code}"
            )

        serial_numbers = [
            value.strip() for value in (line.serial_numbers or []) if value.strip()
        ]
        if len(serial_numbers) != len(set(serial_numbers)):
            raise ValidationError("Movement serial numbers must be unique")
        serial_rows: list[m.SerialNumber] = []
        if item.is_serial_tracked:
            quantity = _d(line.quantity)
            if quantity != quantity.to_integral_value() \
                    or len(serial_numbers) != int(quantity):
                raise ValidationError(
                    f"Select exactly {int(quantity)} serial numbers for {item.code}"
                )
            serial_rows = (await db.execute(
                select(m.SerialNumber).where(
                    m.SerialNumber.item_id == item.id,
                    m.SerialNumber.warehouse_id == wh.id,
                    m.SerialNumber.bin_id == source.id,
                    m.SerialNumber.batch_id == (line.batch_id if line.batch_id else None),
                    m.SerialNumber.serial_number.in_(serial_numbers),
                    m.SerialNumber.status == SerialStatus.AVAILABLE.value,
                    m.SerialNumber.is_active.is_(True),
                ).with_for_update()
            )).scalars().all()
            if len(serial_rows) != len(serial_numbers):
                raise ValidationError(
                    f"One or more serial numbers are not available in the source bin for {item.code}"
                )
            if any((row.remarks or "").startswith("Reserved for issue ") for row in serial_rows):
                raise ValidationError(f"A selected serial is reserved for a material issue on {item.code}")
        elif serial_numbers:
            raise ValidationError(f"{item.code} is not serial tracked")

        await move_stock(
            db,
            item_id=item.id,
            qty=line.quantity,
            direction=StockDirection.OUT.value,
            ref_type=InventoryRefType.STOCK_MOVEMENT.value,
            ref_id=0,
            ref_no=order_no,
            user=user,
            warehouse_id=wh.id,
            bin_id=source.id,
            batch_id=batch_id,
            project_id=0,
        )
        await move_stock(
            db,
            item_id=item.id,
            qty=line.quantity,
            direction=StockDirection.IN.value,
            ref_type=InventoryRefType.STOCK_MOVEMENT.value,
            ref_id=0,
            ref_no=order_no,
            user=user,
            warehouse_id=wh.id,
            bin_id=destination.id,
            batch_id=batch_id,
            project_id=0,
        )
        for row in serial_rows:
            row.bin_id = destination.id
            row.remarks = f"Moved by {order_no}"
        moved.append({
            "item_id": item.id,
            "item_code": item.code,
            "item_name": item.name,
            "uom_code": item.uom_code,
            "batch_id": line.batch_id or None,
            "source_bin_id": source.id,
            "source_bin_code": source.code,
            "destination_bin_id": destination.id,
            "destination_bin_code": destination.code,
            "quantity": line.quantity,
            "serial_numbers": serial_numbers,
        })

    await write_audit(
        db,
        entity="whs_stock_movements",
        entity_id=0,
        entity_no=order_no,
        action=AuditAction.CREATE,
        actor=user,
        after={
            "warehouse_id": wh.id,
            "lines": len(data.items),
            "remarks": data.reason,
        },
    )
    await db.commit()

    return {
        "order_no": order_no,
        "warehouse_id": wh.id,
        "warehouse_name": wh.name,
        "status": "COMPLETED",
        "reason": data.reason,
        "total_lines": len(moved),
        "items": moved,
        "created_by_name": _name(user),
        "created_at": utcnow(),
    }


async def list_stock_movements(db: AsyncSession, params: PageParams, user=None) -> dict:
    """FIXED 2026-08-20 — was unscoped while every other warehouse list on this screen
    obeys a rung. A stock movement is a fact about a WAREHOUSE, so with no rung the
    Stock Movements register showed bin-to-bin moves at all 983 stocking points to
    anyone holding `stock.view`. WITHOUT this a storekeeper reads what every other
    branch shifted, and the warehouse rung on Job Profiles is silently ignored on one
    screen out of a dozen."""
    from app.modules.inventory.models import StockMovement

    stmt = select(StockMovement).where(
        StockMovement.ref_type == InventoryRefType.STOCK_MOVEMENT.value,
        StockMovement.direction == StockDirection.OUT.value,
    )
    if user is not None:
        stmt = stmt.where(await scope_condition(
            db, user,
            warehouse_col=StockMovement.warehouse_id,
            warehouse_ids=await warehouse_ids_for_user(db, user),
            project_col=StockMovement.project_id,
            owner_col=StockMovement.created_by_id,
        ))
    page = await paginate(db, stmt.order_by(StockMovement.id.desc()), params)
    rows: list[dict] = []
    for outward in page["items"]:
        inward = await db.scalar(select(StockMovement).where(
            StockMovement.ref_type == InventoryRefType.STOCK_MOVEMENT.value,
            StockMovement.ref_no == outward.ref_no,
            StockMovement.direction == StockDirection.IN.value,
        ).limit(1))
        serials = (await db.execute(select(m.SerialNumber).where(
            m.SerialNumber.remarks == f"Moved by {outward.ref_no}"
        ))).scalars().all()
        rows.append({
            "movement_no": outward.ref_no,
            "movement_type": "BIN_TO_BIN",
            "warehouse_id": outward.warehouse_id,
            "warehouse_name": outward.warehouse_name,
            "source_bin_id": outward.bin_id,
            "source_bin_code": await _bin_code(db, outward.bin_id),
            "destination_bin_id": inward.bin_id if inward else 0,
            "destination_bin_code": await _bin_code(db, inward.bin_id if inward else None),
            "item_id": outward.item_id,
            "item_code": outward.item_code,
            "item_name": outward.item_name,
            "batch_id": outward.batch_id or None,
            "batch_no": outward.batch_no,
            "quantity": outward.quantity,
            "serial_numbers": [row.serial_number for row in serials],
            "status": "COMPLETED",
            "moved_by_name": outward.created_by_name,
            "moved_at": outward.created_at,
            "remarks": outward.remarks,
        })
    page["items"] = rows
    return page


async def suggested_bins(db: AsyncSession, task_id: int, limit: int = 8) -> list[Bin]:
    """Bins worth offering for a task, best first: the ones already holding this item,
    then any active pickable bin."""
    from app.modules.inventory.models import Stock

    task = await _get(db, m.PutawayTask, task_id, "Putaway task")

    held_ids = [row[0] for row in (await db.execute(
        select(Stock.bin_id).where(
            Stock.warehouse_id == task.warehouse_id, Stock.item_id == task.item_id,
            Stock.bin_id != m.NO_BIN, Stock.total_qty > 0)
        .order_by(Stock.total_qty.desc()).limit(limit)
    )).all()]

    preferred = []
    if held_ids:
        preferred = (await db.execute(
            select(Bin).where(Bin.id.in_(held_ids), Bin.is_active.is_(True))
        )).scalars().all()

    remaining = limit - len(preferred)
    others = []
    if remaining > 0:
        others = (await db.execute(
            select(Bin).where(
                Bin.warehouse_id == task.warehouse_id, Bin.is_active.is_(True),
                Bin.bin_type.in_(m.BIN_TYPES), Bin.id.notin_(held_ids or [0]))
            .order_by(Bin.code).limit(remaining)
        )).scalars().all()
    return [*preferred, *others]


# ---------------------------------------------------------------------------
# Picking
# ---------------------------------------------------------------------------

async def list_pickings(db: AsyncSession, params: PageParams, *, status: str | None = None,
                        warehouse_id: int | None = None, search: str | None = None,
                        user=None) -> dict:
    stmt = select(m.Picking)
    if user is not None:
        stmt = stmt.where(await scope_condition(
            db, user,
            warehouse_col=m.Picking.warehouse_id,
            warehouse_ids=await warehouse_ids_for_user(db, user),
        ))
    if status:
        stmt = stmt.where(m.Picking.status == status)
    if warehouse_id:
        stmt = stmt.where(m.Picking.warehouse_id == warehouse_id)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(
            m.Picking.pick_no.ilike(like), m.Picking.ref_no.ilike(like),
            m.Picking.assigned_to_name.ilike(like)))
    return await paginate(db, stmt.order_by(m.Picking.id.desc()), params)


async def get_picking(db: AsyncSession, picking_id: int, user=None) -> m.Picking:
    picking = await _load(db, m.Picking, picking_id, "Material fulfilment",
                          m.Picking.items)
    # FIXED — see `_assert_in_scope`.
    return await _assert_in_scope(db, user, m.Picking, picking,
                                  warehouse_col=m.Picking.warehouse_id,
                                  label="Material fulfilment")


# ---------------------------------------------------------------------------
# How much of an indent is still owed
#
# An indent is served over time, not in one shot: ten asked, eight approved, four
# issued from the store that had them, the rest sent to procurement, and another four
# issued when that stock lands. A split allocation does the same thing in one go —
# one document per warehouse. Both are normal.
#
# The guards these replace counted DOCUMENTS: one live fulfilment per indent, one
# live issue per indent. That reads "you already served this indent once, go away",
# which is wrong on both counts — it refused the second warehouse of a split
# allocation (so a split could never be approved at all) and the second round after
# procurement.
#
# What actually must not happen is issuing MORE than was approved. So the test is on
# quantity, and each document type counts only its own kind: a picklist counts other
# picklists, an issue counts other issues. Counting both would double-count the
# ordinary picklist -> issue chain, where the same units legitimately appear twice.
# ---------------------------------------------------------------------------

async def _indent_cap(db: AsyncSession, indent_id: int) -> dict[int, Decimal]:
    """Per item, the most this indent may ever be served — what was approved, or what
    was asked for when nothing has been approved yet."""
    from app.modules.indents.models import IndentItem

    caps: dict[int, Decimal] = {}
    for item_id, approved, requested in (await db.execute(
        # The ORM names differ from the columns: `quantity` IS requested_qty.
        select(IndentItem.item_id, IndentItem.approved_quantity, IndentItem.quantity)
        .where(IndentItem.indent_id == indent_id)
    )).all():
        allowed = _d(approved) if _d(approved) > ZERO else _d(requested)
        caps[item_id] = caps.get(item_id, ZERO) + allowed
    return caps


async def _already_issued(db: AsyncSession, indent_id: int,
                          warehouse_id: int | None = None) -> dict[int, Decimal]:
    """Per item, what live issues from THIS POINT already cover.

    Per point, not per indent, because one indent is served down a chain: the main
    warehouse issues to the MDP, the MDP forwards to the LIP, and both movements are
    the same units travelling — not the indent being served twice. Counting every
    issue anywhere meant the warehouse's leg consumed the whole allowance and the MDP
    could never forward what it had just received.

    Within a point the cap still bites: that point cannot issue more than was approved.
    Cancelled and rejected issues hold nothing, so they free their quantity back up.
    """
    conditions = [
        m.MaterialIssue.indent_id == indent_id,
        m.MaterialIssue.direction == IssueDirection.OUT.value,
        m.MaterialIssue.status.notin_(DEAD_ISSUE_STATUSES),
    ]
    if warehouse_id is not None:
        conditions.append(m.MaterialIssue.warehouse_id == warehouse_id)
    rows = (await db.execute(
        select(m.MaterialIssueLine.item_id,
               func.coalesce(func.sum(m.MaterialIssueLine.issued_qty), 0))
        .join(m.MaterialIssue, m.MaterialIssue.id == m.MaterialIssueLine.issue_id)
        .where(*conditions)
        .group_by(m.MaterialIssueLine.item_id)
    )).all()
    return {item_id: _d(qty) for item_id, qty in rows}


async def _already_picking(db: AsyncSession, indent_id: int,
                           warehouse_id: int | None = None) -> dict[int, Decimal]:
    """Per item, what open fulfilments already cover. `out_picking_items` carries no
    indent line, so this matches on the item — which is the level the cap is at too."""
    rows = (await db.execute(
        select(m.PickingItem.item_id,
               func.coalesce(func.sum(m.PickingItem.required_qty), 0))
        .join(m.Picking, m.Picking.id == m.PickingItem.picking_id)
        .where(
            m.Picking.ref_type == "INDENT",
            m.Picking.ref_id == indent_id,
            m.Picking.status != PickingStatus.CANCELLED.value,
            *([m.Picking.warehouse_id == warehouse_id]
              if warehouse_id is not None else []),
        )
        .group_by(m.PickingItem.item_id)
    )).all()
    return {item_id: _d(qty) for item_id, qty in rows}


async def _live_issue_labels(db: AsyncSession, indent_id: int,
                             warehouse_id: int | None) -> str:
    """The issues already holding this indent's quantity here, named and with status.

    "Nothing is outstanding" is a true answer to the wrong question when the thing
    holding the quantity is a draft the same person raised a minute ago. Name it:
    the store can open it and finish it instead of guessing what drew the stock.
    """
    conditions = [
        m.MaterialIssue.indent_id == indent_id,
        m.MaterialIssue.direction == IssueDirection.OUT.value,
        m.MaterialIssue.status.notin_(DEAD_ISSUE_STATUSES),
    ]
    if warehouse_id is not None:
        conditions.append(m.MaterialIssue.warehouse_id == warehouse_id)
    rows = (await db.execute(
        select(m.MaterialIssue.issue_no, m.MaterialIssue.status)
        .where(*conditions).order_by(m.MaterialIssue.id)
    )).all()
    return ", ".join(f"{issue_no} ({status})" for issue_no, status in rows)


async def _guard_indent_quantity(db: AsyncSession, indent_id: int, indent_no: str,
                                 wanted: dict[int, Decimal], taken: dict[int, Decimal],
                                 doc: str, holders: str = "") -> None:
    """Refuses a document that would take an indent past what was approved.

    `taken` is what documents of this same kind already hold — the new document's own
    lines are not in it yet, so the sum is what the indent would stand at afterwards.
    `holders` names those documents, so the refusal says what to go and look at.
    """
    caps = await _indent_cap(db, indent_id)
    if not caps:
        return   # nothing to measure against; the indent lines are gone
    for item_id, qty in wanted.items():
        if qty <= ZERO:
            continue
        cap = caps.get(item_id)
        if cap is None:
            continue   # an item the indent never asked for — other guards own that
        outstanding = cap - taken.get(item_id, ZERO)
        if qty > outstanding:
            name = (await db.get(Item, item_id)) if item_id else None
            label = getattr(name, "name", None) or f"item {item_id}"
            by = f" by {holders}" if holders else ""
            if outstanding <= ZERO:
                raise ValidationError(
                    f"{indent_no} is already covered for {label} — {cap} of {cap}"
                    f"{by}. Open that document to continue; there is nothing left to "
                    f"{doc.lower()} against this indent."
                )
            raise ValidationError(
                f"{indent_no} only has {outstanding} of {label} outstanding "
                f"({taken.get(item_id, ZERO)} of {cap} already covered{by}). "
                f"Reduce this {doc.lower()} to {outstanding} or less."
            )


async def _build_picking(db: AsyncSession, data: s.PickingWrite, user) -> m.Picking:
    """Build one material-fulfilment draft without committing it.

    Keeping construction separate from the public create endpoint lets allocation
    approval create every warehouse draft in the same transaction as its stock
    reservations. A split allocation therefore either creates all of its drafts or
    none of them.
    """
    wh = await _warehouse(db, data.warehouse_id)
    if not data.items:
        raise ValidationError("A material fulfilment with no lines gives the warehouse nothing to do")
    if data.ref_type == "INDENT" and not data.ref_id:
        raise ValidationError("An indent fulfilment needs an indent reference")

    if data.ref_type == "INDENT" and data.ref_id:
        # An indent may carry as many fulfilments as it takes to serve it — one per
        # warehouse in a split, and another round when procurement lands the shortfall.
        # What it may not do is total more than was approved. See _guard_indent_quantity.
        from app.modules.indents.models import Indent as _Indent

        indent_row = await db.get(_Indent, data.ref_id)
        wanted_by_item: dict[int, Decimal] = {}
        for line in data.items:
            wanted_by_item[line.item_id] = (
                wanted_by_item.get(line.item_id, ZERO) + _d(line.required_qty))
        await _guard_indent_quantity(
            db, data.ref_id,
            getattr(indent_row, "indent_no", None) or f"Indent {data.ref_id}",
            wanted_by_item, await _already_picking(db, data.ref_id, wh.id),
            "material fulfilment",
        )

        requested_by_item: dict[int, Decimal] = {}
        for line in data.items:
            requested_by_item[line.item_id] = (
                requested_by_item.get(line.item_id, ZERO) + _d(line.required_qty)
            )
        for item_id, required in requested_by_item.items():
            held = await stock_allocation.reserved_quantity(
                db,
                InventoryRefType.RESERVATION.value,
                data.ref_id,
                item_id=item_id,
                warehouse_id=wh.id,
            )
            if required > held:
                raise ValidationError(
                    f"Item {item_id}: fulfilment asks for {required}, but only {held} "
                    "is reserved for this indent in the warehouse."
                )

    picking = m.Picking(
        items=[],   # see create_issue: keeps the append below off a lazy load
        pick_no=await next_number(db, WarehouseDocType.PICKING.value),
        pick_date=data.pick_date,
        warehouse_id=wh.id, warehouse_name=wh.name,
        ref_type=data.ref_type, ref_id=data.ref_id,
        ref_no=await _warehouse_reference_no(db, data.ref_type, data.ref_id),
        strategy=data.strategy.value,
        status=PickingStatus.DRAFT.value,
        assigned_to_id=data.assigned_to_id,
        total_lines=len(data.items), picked_lines=0,
    )
    db.add(picking)
    await db.flush()

    for index, line in enumerate(data.items, start=1):
        item = await _item_snapshot(db, line.item_id)
        required = _d(line.required_qty)
        if required <= ZERO:
            raise ValidationError(f"Line {index}: required quantity must be positive")
        if line.bin_id:
            source_bin = await _get(db, Bin, line.bin_id, "Bin")
            if source_bin.warehouse_id != wh.id:
                raise ValidationError(
                    f"Line {index}: bin {source_bin.code} is not in {wh.name}"
                )
        batch = await db.get(m.Batch, line.batch_id) if line.batch_id else None
        # Nobody named a bin, so ask stock where the item is rather than sending the
        # picker out with "any". See _pick_bin_for.
        resolved_bin = line.bin_id or await _pick_bin_for(
            db, item_id=item.id, warehouse_id=wh.id, batch_id=line.batch_id or None,
        )
        picking.items.append(m.PickingItem(
            line_no=index, item_id=item.id, item_code=item.code, item_name=item.name,
            uom_code=item.uom_code,
            # The sentinel, not NULL. out_picking_items.bin_id and .batch_id are
            # NOT NULL DEFAULT 0 in the live schema even though the model says
            # nullable, so an unbinned/unbatched line has to be written as 0 the way
            # every other whs_ table already does.
            bin_id=resolved_bin or m.NO_BIN,
            bin_code=await _bin_code(db, resolved_bin),
            batch_id=line.batch_id or m.NO_BATCH,
            batch_no=batch.batch_no if batch else None,
            required_qty=required, picked_qty=ZERO,
            status=PickLineStatus.PENDING.value,
        ))
    await db.flush()

    await write_audit(db, entity="out_picking", entity_id=picking.id, entity_no=picking.pick_no,
                      action=AuditAction.CREATE, actor=user,
                      after={"status": picking.status, "lines": picking.total_lines})
    return picking


async def create_picking(db: AsyncSession, data: s.PickingWrite, user) -> m.Picking:
    picking = await _build_picking(db, data, user)
    await db.commit()
    return await get_picking(db, picking.id)


async def create_fulfilment_drafts_for_allocation(db: AsyncSession, alloc, user) -> list[m.MaterialIssue]:
    """Create one material issue draft per warehouse in an approved allocation.

    The automatic Inventory -> Warehouse handoff, and the head of the draft chain:
    allocation approved -> ISSUE draft -> (post stock) -> PICKING draft ->
    (complete pick) -> CONSIGNMENT. The issue comes first because posting stock is
    what turns an allocation into goods the floor can pick; a picklist raised before
    that would be asking someone to walk for stock nothing had committed yet.

    Allocation lines are combined by item within a warehouse. A split allocation
    therefore yields one draft per site, each carrying its own lines.
    """
    by_warehouse: dict[int, dict[int, dict]] = {}
    for line in alloc.items:
        qty = _d(line.quantity)
        if qty <= ZERO or not line.warehouse_id:
            continue
        by_item = by_warehouse.setdefault(line.warehouse_id, {})
        seen = by_item.get(line.item_id)
        if seen is None:
            by_item[line.item_id] = {
                "qty": qty,
                "requested": _d(line.requested_qty),
                # Only carried when the item maps to exactly one indent line. A line
                # split across warehouses would otherwise point every draft at the
                # same indent line and double-count it on the fulfilment view.
                "indent_item_id": line.indent_item_id,
                "project_id": line.project_id,
            }
        else:
            seen["qty"] += qty
            seen["requested"] += _d(line.requested_qty)
            if seen["indent_item_id"] != line.indent_item_id:
                seen["indent_item_id"] = None

    # The person the goods are for is the one who raised the indent — the same answer
    # _issue_destination already falls back to. Filling it here means the draft opens
    # with "Issued to" named instead of blank; the store can still change it.
    from app.modules.indents.models import Indent
    indent = await db.get(Indent, alloc.indent_id) if alloc.indent_id else None
    issued_to_id = getattr(indent, "requested_by_id", None) if indent else None
    # The indent already named the vehicle it is going out on. Same rule as the
    # person: default it in, leave it typeable.
    vehicle_id = getattr(indent, "vehicle_id", None) if indent else None
    vehicle_number = (getattr(indent, "vehicle_number", None) if indent else None) or (
        _vehicle_from_office_name(getattr(indent, "office_name", None) if indent else None)
    )

    drafts: list[m.MaterialIssue] = []
    for warehouse_id, lines in by_warehouse.items():
        project_id = next(
            (v["project_id"] for v in lines.values() if v["project_id"]), None
        )
        items: list[s.IssueItemWrite] = []
        for item_id, v in lines.items():
            items.extend(await _allocation_lines_by_batch(
                db, alloc.indent_id, warehouse_id, item_id, v,
            ))
        data = s.IssueWrite(
            issue_date=ist_today(),
            warehouse_id=warehouse_id,
            indent_id=alloc.indent_id,
            project_id=project_id,
            issued_to_id=issued_to_id,
            vehicle_id=vehicle_id,
            vehicle_number=vehicle_number,
            items=items,
        )
        drafts.append(await _build_issue(db, data, user))
    return drafts


async def _allocation_lines_by_batch(
    db: AsyncSession,
    indent_id: int,
    warehouse_id: int,
    item_id: int,
    allocated: dict,
) -> list[s.IssueItemWrite]:
    """Split one allocated quantity into the batches and bins it was reserved from.

    `inv_allocation_items` records a quantity and a warehouse, nothing finer, so this
    used to draft one issue line on NO_BATCH/NO_BIN. Every document after it inherited
    that blank: no batch number, no expiry, no manufacturing date on the issue, the
    consignment, or the GRN at the receiving point — and the serial picker fell back to
    every unit the warehouse holds instead of the ones actually set aside.

    The detail was never missing, only unread. `allocate_for_indent` writes one
    `inv_reservations` row per stock row it draws from, and a stock row IS a
    (warehouse, bin, batch) — so the reservations spell out exactly which goods were
    promised. Read them back and draft one line per rung.

    Falls back to a single unsplit line when the reservations do not add up to what was
    allocated: a hand-edited allocation must still produce an issue, just a vaguer one.
    """
    from app.modules.inventory.models import Reservation

    qty = _d(allocated["qty"])
    base = {
        "item_id": item_id,
        "indent_item_id": allocated["indent_item_id"],
        "requested_qty": _d(allocated["requested"]) or qty,
    }
    rows = (await db.execute(
        select(Reservation)
        .where(
            Reservation.ref_type == InventoryRefType.RESERVATION.value,
            Reservation.ref_id == indent_id,
            Reservation.item_id == item_id,
            Reservation.warehouse_id == warehouse_id,
        )
        .order_by(Reservation.id)
    )).scalars().all()

    reserved = sum((_d(row.quantity) for row in rows), ZERO)
    if not rows or reserved != qty:
        if rows:
            logger.warning(
                "indent %s item %s at warehouse %s: reservations total %s but %s was "
                "allocated; issue line left unsplit",
                indent_id, item_id, warehouse_id, reserved, qty,
            )
        return [s.IssueItemWrite(**base, issued_qty=qty)]

    # One line per (bin, batch), so a quantity drawn from two batches stays two lines
    # with two expiry dates rather than one line claiming a batch it half came from.
    merged: dict[tuple[int, int], Decimal] = {}
    for row in rows:
        key = (row.bin_id or m.NO_BIN, row.batch_id or m.NO_BATCH)
        merged[key] = merged.get(key, ZERO) + _d(row.quantity)

    lines: list[s.IssueItemWrite] = []
    for (bin_id, batch_id), line_qty in merged.items():
        lines.append(s.IssueItemWrite(
            **{**base, "requested_qty": line_qty},
            issued_qty=line_qty,
            bin_id=bin_id or None,
            batch_id=batch_id or None,
        ))
    return lines


async def _warehouse_reference_no(
    db: AsyncSession, ref_type: str | None, ref_id: int | None,
) -> str | None:
    if not ref_type or not ref_id:
        return None
    if ref_type == "INDENT":
        from app.modules.indents.models import Indent
        row = await db.get(Indent, ref_id)
        return row.indent_no if row else None
    if ref_type == "ISSUE":
        row = await db.get(m.MaterialIssue, ref_id)
        return row.issue_no if row else None
    if ref_type == "DISPATCH":
        row = await db.get(m.Dispatch, ref_id)
        return row.dispatch_no if row else None
    return None


async def release_picking(db: AsyncSession, picking_id: int, user) -> m.Picking:
    picking = await get_picking(db, picking_id)
    _guard(picking.status, {PickingStatus.DRAFT.value}, "release", "material fulfilment")
    picking.status = PickingStatus.RELEASED.value

    await write_audit(db, entity="out_picking", entity_id=picking.id, entity_no=picking.pick_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": PickingStatus.DRAFT.value},
                      after={"status": picking.status})
    await db.commit()
    return await get_picking(db, picking_id)


async def pick_line(db: AsyncSession, picking_id: int, line_id: int, data: s.PickLine,
                    user) -> m.Picking:
    """Confirms one line.

    Each line is its own request so a picker who loses signal halfway has not lost the
    first half of the trolley. Picking does not move stock — the issue that follows
    does; a picked line is stock in a trolley, still in the warehouse.
    """
    picking = await get_picking(db, picking_id)
    _guard(picking.status, {PickingStatus.RELEASED.value, PickingStatus.IN_PROGRESS.value},
           "pick against", "material fulfilment")

    line = next((l for l in picking.items if l.id == line_id), None)
    if line is None:
        raise NotFoundError(f"Line {line_id} is not on {picking.pick_no}")
    if line.status == PickLineStatus.PICKED.value:
        raise ValidationError(f"Line {line.line_no} is already picked")

    picked = _d(data.picked_qty)
    if picked <= ZERO:
        raise ValidationError("Picked quantity must be positive")
    if picked > _d(line.required_qty):
        raise ValidationError(
            f"Line {line.line_no} needs {line.required_qty}; {picked} is more than that.")

    line.picked_qty = picked
    line.status = (PickLineStatus.PICKED if picked >= _d(line.required_qty)
                   else PickLineStatus.SHORT).value
    line.picked_by_id = getattr(user, "id", None)
    line.picked_at = utcnow()
    if data.bin_id:
        source_bin = await _get(db, Bin, data.bin_id, "Bin")
        if source_bin.warehouse_id != picking.warehouse_id:
            raise ValidationError(
                f"Bin {source_bin.code} is not in {picking.warehouse_name}"
            )
        line.bin_id = source_bin.id
        line.bin_code = source_bin.code

    picking.picked_lines = sum(
        1 for l in picking.items
        if l.status in (PickLineStatus.PICKED.value, PickLineStatus.SHORT.value))
    if picking.status == PickingStatus.RELEASED.value:
        picking.status = PickingStatus.IN_PROGRESS.value
        picking.started_at = picking.started_at or utcnow()

    await write_audit(db, entity="out_picking_items", entity_id=line.id,
                      entity_no=picking.pick_no, action=AuditAction.UPDATE, actor=user,
                      after={"line_no": line.line_no, "picked_qty": str(picked),
                             "status": line.status})
    await db.commit()
    return await get_picking(db, picking_id)


async def _raise_consignment_for_picking(
    db: AsyncSession, picking: m.Picking, user,
) -> "m.Dispatch | None":
    """Raise the consignment that follows a completed pick.

    Rung three of the draft chain. Only picks raised off an issue carry a
    consignment — a pick against an indent under the older pick-then-issue path has
    no posted issue behind it yet, and a consignment has to point at one.

    Everything issued goes into a single package, since the storekeeper who just
    filled one trolley is the one who knows how it actually splits into boxes; the
    consignment form lets them break it up. Packing is validated as exactly-equals
    issued, so anything less than the whole issue would be rejected here.

    A failure here must not lose the pick, which is a physical fact already recorded.
    The consignment is convenience; it can be raised by hand from the issue.
    """
    if picking.ref_type != "ISSUE" or not picking.ref_id:
        return None
    if picking.status != PickingStatus.COMPLETED.value:
        return None      # a short pick cannot pack to the issued quantity

    existing = await db.scalar(
        select(m.Dispatch.id).where(
            m.Dispatch.ref_type.in_(["ISSUE", WarehouseDocType.WH_ISSUE.value]),
            m.Dispatch.ref_id == picking.ref_id,
            m.Dispatch.status != DispatchStatus.CANCELLED.value,
        ).limit(1)
    )
    if existing is not None:
        return None

    issue = await get_issue(db, picking.ref_id)
    if not issue.is_stock_posted or issue.direction != IssueDirection.OUT.value:
        return None

    # Serial-tracked lines have to name their serials, and only the ones this issue
    # actually put out; the packer validates against exactly that set.
    serials_by_key: dict[tuple[int, int], list[str]] = {}
    serials_by_item: dict[int, list[str]] = {}
    for row in (await _issued_serial_index(db, issue)).values():
        serials_by_key.setdefault(
            (row.item_id, row.batch_id or m.NO_BATCH), []
        ).append(row.serial_number)
        serials_by_item.setdefault(row.item_id, []).append(row.serial_number)

    lines: list[s.ConsignmentPackageItemWrite] = []
    for (item_id, batch_id), qty in _issue_qty_by_item_batch(issue).items():
        if qty <= ZERO:
            continue
        item = await db.get(Item, item_id)
        picked = serials_by_key.get((item_id, batch_id))
        if not picked and (not batch_id or batch_id == m.NO_BATCH):
            picked = serials_by_item.get(item_id, [])
        if picked is None:
            picked = []
        if item is not None and item.is_serial_tracked and len(picked) != int(qty):
            return None       # serials incomplete — let the storekeeper pack by hand
        lines.append(s.ConsignmentPackageItemWrite(
            item_id=item_id,
            batch_id=None if batch_id == m.NO_BATCH else batch_id,
            serial_numbers=picked,
            quantity=qty,
            indent_id=issue.indent_id,
        ))
    if not lines:
        return None

    # A savepoint, because _build_consignment flushes the header before it packs:
    # without one, a rejected package list would leave that half-built PACKED row
    # behind to be committed with the pick.
    try:
        async with db.begin_nested():
            return await _build_consignment(db, s.ConsignmentWrite(
                issue_id=issue.id,
                # PROJECT, not the TRANSFER default: a transfer needs a destination
                # warehouse, and nothing upstream of here has chosen one.
                dispatch_type=DispatchType.PROJECT,
                dispatch_date=ist_today(),
                project_id=issue.project_id,
                packages=[s.ConsignmentPackageWrite(items=lines)],
            ), user)
    except AppException as exc:
        logger.warning("auto-consignment for %s skipped: %s", picking.pick_no, exc)
        return None


async def complete_picking(db: AsyncSession, picking_id: int, user) -> m.Picking:
    picking = await get_picking(db, picking_id)
    _guard(picking.status, {PickingStatus.IN_PROGRESS.value, PickingStatus.RELEASED.value},
           "complete", "material fulfilment")
    if picking.picked_lines == 0:
        raise ValidationError("Nothing has been picked yet")

    picking.status = (PickingStatus.COMPLETED if picking.picked_lines >= picking.total_lines
                      else PickingStatus.PICKED).value
    picking.completed_at = utcnow()

    consignment = await _raise_consignment_for_picking(db, picking, user)

    await write_audit(db, entity="out_picking", entity_id=picking.id, entity_no=picking.pick_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": PickingStatus.IN_PROGRESS.value},
                      after={"status": picking.status,
                             "picked_lines": picking.picked_lines,
                             "total_lines": picking.total_lines,
                             "consignment_no": consignment.dispatch_no if consignment else None})
    await db.commit()
    return await get_picking(db, picking_id)


# ---------------------------------------------------------------------------
# Material issues
# ---------------------------------------------------------------------------

def _issue_totals(issue: m.MaterialIssue) -> None:
    lines = issue.items
    issue.total_items = len(lines)
    issue.total_qty = sum((_d(l.issued_qty) for l in lines), ZERO)
    issue.total_value = sum((_d(l.amount) for l in lines), ZERO)


def _issue_serial_marker(issue_id: int) -> str:
    return f"Reserved for issue {issue_id}"


async def _project_name(db: AsyncSession, project_id: int | None) -> str | None:
    """The project's display name, snapshotted beside its id (rule 10)."""
    from app.shared.models.master import Project
    project = await db.get(Project, project_id) if project_id else None
    return project.name if project else None


async def _issue_snapshot_values(
    db: AsyncSession,
    *,
    department_id: int | None,
    project_id: int | None,
    vehicle_id: int | None,
    issued_to_id: int | None,
    vehicle_number: str | None = None,
) -> dict[str, str | None]:
    from app.platform.hcm.models import HcmDepartment, HcmEmployee
    from app.shared.models.master import Project

    department = await db.get(HcmDepartment, department_id) if department_id else None
    project = await db.get(Project, project_id) if project_id else None
    employee = await db.get(HcmEmployee, issued_to_id) if issued_to_id else None
    vehicles = await vehicle_options(db) if vehicle_id else []
    vehicle = next((row for row in vehicles if row["id"] == vehicle_id), None)
    return {
        "department_name": department.name if department else None,
        "project_name": project.name if project else None,
        # A registered vehicle names itself; otherwise keep what was typed.
        "vehicle_number": vehicle["name"] if vehicle else (vehicle_number or None),
        "issued_to_name": employee.full_name if employee else None,
    }


async def _clear_issue_serial_reservations(
    db: AsyncSession,
    issue_id: int,
) -> None:
    rows = (await db.execute(
        select(m.SerialNumber).where(
            m.SerialNumber.remarks == _issue_serial_marker(issue_id),
            m.SerialNumber.status.in_(
                (SerialStatus.AVAILABLE.value, SerialStatus.ISSUED.value)
            ),
        )
    )).scalars().all()
    for row in rows:
        row.remarks = None


UNIT_MODE_SERIAL = "SERIAL"
UNIT_MODE_IMEI = "IMEI"
UNIT_MODE_CODE = "CODE"

# What one unit is called in a message, per mode.
_UNIT_NOUN = {
    UNIT_MODE_SERIAL: "serial numbers",
    UNIT_MODE_IMEI: "IMEI numbers",
    UNIT_MODE_CODE: "unit codes",
}


def _unit_mode(item) -> str:
    """Which identifier names one unit of this item: serial → IMEI → code.

    The fallback ladder the business asked for. A serial is the primary identity
    whenever the item carries one; an item that has only IMEIs is named by those;
    everything else is named by the asset / consumable code stamped at putaway.
    The three are not alternatives on the same unit — they are the same row in
    `whs_serial_numbers` read through whichever column that item actually fills,
    so validating on one always yields the other two from the matched row.
    """
    if bool(getattr(item, "is_serial_tracked", False)):
        return UNIT_MODE_SERIAL
    if bool(getattr(item, "is_imei_tracked", False)):
        return UNIT_MODE_IMEI
    return UNIT_MODE_CODE


def _unit_keys(row, mode: str) -> list[str]:
    """Every value that may be typed or scanned to mean this unit, in this mode.

    A code-mode row answers to its code AND to its serial_number, because for an
    unserialised unit `_place_unit_codes` writes the same string into both.
    """
    if mode == UNIT_MODE_SERIAL:
        return [row.serial_number] if row.serial_number else []
    if mode == UNIT_MODE_IMEI:
        return [row.imei] if row.imei else []
    values = [row.asset_code, row.consumable_code, row.serial_number]
    seen: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.append(value)
    return seen


async def _reserve_issue_serials(
    db: AsyncSession,
    issue: m.MaterialIssue,
    inputs: list[s.IssueItemWrite],
) -> None:
    marker = _issue_serial_marker(issue.id)
    for line, data in zip(issue.items, inputs, strict=True):
        item = await _item_snapshot(db, line.item_id)
        serials = [value.strip() for value in (data.serial_numbers or []) if value.strip()]
        if len(serials) != len(set(serials)):
            raise ValidationError(f"{item.code}: serial numbers must be unique")
        mode = _unit_mode(item)
        noun = _UNIT_NOUN[mode]
        issued = _d(line.issued_qty)
        if mode == UNIT_MODE_SERIAL and issued != issued.to_integral_value():
            raise ValidationError(
                f"{item.code}: a serialized quantity must be a whole number"
            )
        if not serials:
            # Unchanged for every line that names no units, which is most of them:
            # nothing is reserved and nothing is demanded here.
            setattr(line, "serial_numbers", [])
            setattr(line, "unit_keys", [])
            setattr(line, "unit_mode", mode)
            continue
        if issued != issued.to_integral_value():
            raise ValidationError(
                f"{item.code}: a quantity named by {noun} must be a whole number"
            )
        # A draft may hold fewer serials than units, and usually holds none.
        #
        # These drafts are created for the storekeeper by
        # create_fulfilment_drafts_for_allocation, which runs when INVENTORY approves
        # an allocation. Inventory approves quantities; it has no idea which physical
        # units will be picked, and no screen on which to say. Demanding the full set
        # here made "Approve and reserve" fail with "select 5 serial numbers for the
        # issued quantity" — an error about a warehouse detail, raised on an inventory
        # screen, against a document the approver could not edit.
        #
        # The full set is required at post_issue, which is where stock actually moves
        # and where the storekeeper has the goods in hand. Same shape as the gate
        # entry / GRN split on inbound.
        if len(serials) > int(issued):
            raise ValidationError(
                f"{item.code}: {len(serials)} {noun} for {int(issued)} units"
            )
        expected_status = (
            SerialStatus.AVAILABLE.value
            if issue.direction == IssueDirection.OUT.value
            else SerialStatus.ISSUED.value
        )
        stmt = select(m.SerialNumber).where(
            m.SerialNumber.item_id == line.item_id,
            m.SerialNumber.warehouse_id == issue.warehouse_id,
            m.SerialNumber.status == expected_status,
            m.SerialNumber.is_active.is_(True),
        )
        # The one place the ladder is applied to the lookup itself: the same row is
        # found by whichever column this item names its units with.
        if mode == UNIT_MODE_SERIAL:
            stmt = stmt.where(m.SerialNumber.serial_number.in_(serials))
        elif mode == UNIT_MODE_IMEI:
            stmt = stmt.where(m.SerialNumber.imei.in_(serials))
        else:
            stmt = stmt.where(or_(
                m.SerialNumber.asset_code.in_(serials),
                m.SerialNumber.consumable_code.in_(serials),
                m.SerialNumber.serial_number.in_(serials)))
        rows = (await db.execute(stmt.with_for_update())).scalars().all()

        by_key: dict[str, m.SerialNumber] = {}
        for row in rows:
            for key in _unit_keys(row, mode):
                by_key.setdefault(key, row)
        chosen = [by_key.get(value) for value in serials]
        if any(row is None for row in chosen) or \
                len({row.id for row in chosen if row}) != len(serials):
            raise ValidationError(
                f"{item.code}: one or more selected units are unavailable"
            )
        for value, row in zip(serials, chosen, strict=True):
            if line.bin_id and row.bin_id != line.bin_id:
                raise ValidationError(f"{value} is not in the selected source bin")
            if line.batch_id and row.batch_id != line.batch_id:
                raise ValidationError(f"{value} is not in the selected batch")
            if row.remarks and row.remarks.startswith("Reserved for issue ") \
                    and row.remarks != marker:
                raise ValidationError(f"{value} is reserved by another issue")
            row.remarks = marker
        # The document always keeps the canonical serial — in code mode that IS the
        # code — while `unit_keys` echoes back what the storekeeper actually validated.
        setattr(line, "serial_numbers", [row.serial_number for row in chosen])
        setattr(line, "unit_keys", serials)
        setattr(line, "unit_mode", mode)


async def _decorate_issue_serials(
    db: AsyncSession,
    issue: m.MaterialIssue,
) -> m.MaterialIssue:
    rows = (await db.execute(
        select(m.SerialNumber).where(
            m.SerialNumber.remarks.in_(
                (
                    _issue_serial_marker(issue.id),
                    f"Issued by issue {issue.id}",
                    f"Returned by issue {issue.id}",
                )
            )
        )
    )).scalars().all()
    by_item: dict[int, list[str]] = {}
    # IMEI travels with the serial, so the issue screen and everything downstream can
    # show both without going back to whs_serial_numbers per line.
    imeis_by_item: dict[int, list[str]] = {}
    rows_by_item: dict[int, list[m.SerialNumber]] = {}
    for row in rows:
        by_item.setdefault(row.item_id, []).append(row.serial_number)
        rows_by_item.setdefault(row.item_id, []).append(row)
        if row.imei:
            imeis_by_item.setdefault(row.item_id, []).append(row.imei)
    item_ids = {line.item_id for line in issue.items}
    serial_by_item: dict[int, bool] = {}
    imei_tracked_by_item: dict[int, bool] = {}
    item_by_id: dict[int, object] = {}
    coded_items: set[int] = set()
    if item_ids:
        item_rows = (await db.execute(
            select(Item.id, Item.is_serial_tracked, Item.is_imei_tracked)
            .where(Item.id.in_(item_ids))
        )).all()
        serial_by_item = {
            item_id: bool(is_serial_tracked)
            for item_id, is_serial_tracked, _ in item_rows
        }
        imei_tracked_by_item = {
            item_id: bool(is_imei_tracked)
            for item_id, _, is_imei_tracked in item_rows
        }
        item_by_id = {
            item_id: SimpleNamespace(is_serial_tracked=bool(serial),
                                     is_imei_tracked=bool(imei))
            for item_id, serial, imei in item_rows
        }
        # Which items actually have identified units AT THIS POINT. Without it the
        # screen would offer a unit picker on every bulk line, where there is nothing
        # to pick — and units coded at the warehouse are not pickable from an MDP.
        coded_items = set((await db.execute(
            select(m.SerialNumber.item_id)
            .where(m.SerialNumber.item_id.in_(item_ids),
                   m.SerialNumber.warehouse_id == issue.warehouse_id,
                   m.SerialNumber.is_active.is_(True))
            .distinct()
        )).scalars().all())
    for line in issue.items:
        mode = _unit_mode(item_by_id.get(line.item_id))
        setattr(line, "serial_numbers", by_item.get(line.item_id, []))
        setattr(line, "imei_numbers", imeis_by_item.get(line.item_id, []))
        setattr(line, "is_serial_tracked", serial_by_item.get(line.item_id, False))
        setattr(line, "is_imei_tracked", imei_tracked_by_item.get(line.item_id, False))
        setattr(line, "unit_mode", mode)
        setattr(line, "has_units", line.item_id in coded_items)
        # What the storekeeper validated on, echoed back in the same currency he typed:
        # the serial for a serialized item, the IMEI for a handset, the code otherwise.
        setattr(line, "unit_keys", [
            keys[0] for keys in
            (_unit_keys(row, mode) for row in rows_by_item.get(line.item_id, []))
            if keys
        ])
    return issue


async def _apply_issue_lines(db: AsyncSession, issue: m.MaterialIssue,
                             lines: list[s.IssueItemWrite]) -> None:
    issue.items.clear()
    await db.flush()

    for index, line in enumerate(lines, start=1):
        item = await _item_snapshot(db, line.item_id)
        requested = _d(line.requested_qty)
        if requested <= ZERO:
            raise ValidationError(f"Line {index}: requested quantity must be positive")
        issued = requested if line.issued_qty is None else _d(line.issued_qty)
        if issued > requested:
            raise ValidationError(
                f"Line {index}: cannot issue {issued} against a request for {requested}")

        batch = await db.get(m.Batch, line.batch_id) if line.batch_id else None
        rate = _d(line.rate)
        if rate < ZERO:
            # WHI/2026-27/00030 carries rates of -1323, -233 and -4343, which is how
            # a material issue came to be worth ₹ -62,617. Goods leaving a store have
            # a cost or they have none; they never have a negative one.
            raise ValidationError(f"Line {index}: rate cannot be negative")
        if rate <= ZERO:
            # A drafted line carries no rate — the allocation and the picklist both
            # name goods, never a cost — so every automatic issue was worth ₹ 0. The
            # cost is already recorded: the batch was received at one, and the item
            # keeps the last purchase price as the valuation fallback (masters). Read
            # it here, once, so every creation path is costed the same way. Still
            # editable, and still ₹ 0 when nothing knows the cost.
            rate = _d(batch.rate if batch and batch.rate else None) or _d(
                getattr(item, "purchase_price", None))
        issue.items.append(m.MaterialIssueLine(
            line_no=index, indent_item_id=line.indent_item_id,
            item_id=item.id, item_code=item.code, item_name=item.name, uom_code=item.uom_code,
            # 0, not NULL. The live out_issue_items has bin_id and batch_id NOT NULL
            # DEFAULT 0 — the module's own NO_BIN/NO_BATCH convention — while the ORM
            # calls them nullable. Passing the NULL through failed the insert outright,
            # so an indent-linked issue (where bin and batch come from the reservation,
            # not from the line) could not be created at all.
            bin_id=line.bin_id or m.NO_BIN, bin_code=await _bin_code(db, line.bin_id),
            batch_id=line.batch_id or m.NO_BATCH,
            batch_no=batch.batch_no if batch else None,
            mfg_date=batch.mfg_date if batch else None,
            expiry_date=batch.expiry_date if batch else None,
            requested_qty=requested, issued_qty=issued, returned_qty=ZERO,
            rate=rate or None, amount=(issued * rate) if rate else None,
            remarks=line.remarks,
        ))
    _issue_totals(issue)


async def list_issues(db: AsyncSession, params: PageParams, *, direction: str | None = None,
                      status: str | None = None, warehouse_id: int | None = None,
                      search: str | None = None, user=None) -> dict:
    stmt = select(m.MaterialIssue)
    if user is not None:
        stmt = stmt.where(await scope_condition(
            db, user,
            warehouse_col=m.MaterialIssue.warehouse_id,
            warehouse_ids=await warehouse_ids_for_user(db, user),
            owner_col=m.MaterialIssue.created_by_id,
            project_col=m.MaterialIssue.project_id,
        ))
    if direction:
        stmt = stmt.where(m.MaterialIssue.direction == direction)
    if status:
        stmt = stmt.where(m.MaterialIssue.status == status)
    if warehouse_id:
        stmt = stmt.where(m.MaterialIssue.warehouse_id == warehouse_id)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(
            m.MaterialIssue.issue_no.ilike(like), m.MaterialIssue.indent_no.ilike(like),
            m.MaterialIssue.issued_to_name.ilike(like), m.MaterialIssue.department_name.ilike(like)))
    return await paginate(db, stmt.order_by(m.MaterialIssue.id.desc()), params)


async def _decorate_can_approve(db: AsyncSession, doc, doc_type: str, user):
    """Set `can_approve` — is this document waiting on THIS person right now?

    The engine already owns the answer (`wf_pending`), but nothing exposed it, so the
    screens fell back to gating the Approve button on the permission alone. Every
    warehouse post shares one HCM rank, so all eleven holders saw Approve on a document
    only one of them could act on, and the other ten got "You are not a valid approver"
    after clicking. Hiding the button is not the security — `engine.act` still decides —
    it is simply telling the truth about whose turn it is.

    `user` is optional because get_issue() is also called from create_consignment() and
    other server-side paths where there is no one to answer this for; those get False.
    """
    can = False
    if user is not None:
        approvers = await engine.current_approvers(db, doc_type, doc.id)
        can = any(approver.id == user.id for approver in approvers)
    setattr(doc, "can_approve", can)
    return doc


async def get_issue(db: AsyncSession, issue_id: int, user=None) -> m.MaterialIssue:
    issue = await _load(db, m.MaterialIssue, issue_id, "Issue", m.MaterialIssue.items)
    issue = await _decorate_issue_serials(db, issue)
    # The doc type the issue actually runs under, not a hardcoded WH_ISSUE: one that
    # left a point the submitter holds runs under OWN_STOCK_ISSUE, and asking the
    # engine for the wrong type finds no instance, returns no approvers, and hides the
    # Approve button from the very person it is waiting on.
    issue = await _decorate_can_approve(
        db, issue, await _issue_doc_type_of(db, issue.id), user)
    setattr(issue, "can_acknowledge", await _receiver_confirmed(db, issue))
    return await _decorate_issue_destination(db, issue)


async def _receiver_confirmed(db: AsyncSession, issue: m.MaterialIssue) -> bool:
    """Has the indent raiser said this issue's goods reached them?

    Acknowledging is the shipping side signing that a delivery landed, and it used to
    open the moment stock was posted — so the store that sent the goods could close the
    loop on itself, with the requester never asked. Only the raiser can say they
    arrived (`indents.acknowledge_receipt` writes `received_qty` and nothing else does).

    Measured per ISSUE, not per indent. A 10-unit indent served by a 4-unit issue is
    settled for THAT issue once those 4 are confirmed; the other 6 stay pending against
    whatever issue carries them later. So the test is a running total: everything
    delivered on this line up to and including this issue must be covered by what the
    raiser has confirmed on it.

    Lines with no `indent_item_id` are stock leaving against no request — nobody is
    waiting to confirm them, so they never hold the document up.
    """
    lines = [line for line in issue.items if line.indent_item_id]
    if not lines:
        return True

    from app.modules.indents.models import IndentItem

    confirmed = dict((await db.execute(
        select(IndentItem.id, IndentItem.received_quantity)
        .where(IndentItem.id.in_([line.indent_item_id for line in lines]))
    )).all())

    # Everything the same line already had on the road before this document. Relay legs
    # are excluded exactly as Acknowledgements excludes them (_relayed_onward): the raiser
    # never sees the WH -> MDP hop, so counting it would demand a confirmation nobody
    # can give.
    delivered = dict((await db.execute(
        select(m.MaterialIssueLine.indent_item_id,
               func.sum(m.MaterialIssueLine.issued_qty
                        - func.coalesce(m.MaterialIssueLine.returned_qty, 0)))
        .join(m.MaterialIssue, m.MaterialIssue.id == m.MaterialIssueLine.issue_id)
        .where(m.MaterialIssueLine.indent_item_id.in_(
                   [line.indent_item_id for line in lines]),
               m.MaterialIssue.direction == IssueDirection.OUT.value,
               m.MaterialIssue.is_stock_posted.is_(True),
               m.MaterialIssue.id <= issue.id,
               ~_relayed_onward())
        .group_by(m.MaterialIssueLine.indent_item_id)
    )).all())

    return all(
        _d(confirmed.get(line.indent_item_id)) >= _d(delivered.get(line.indent_item_id))
        for line in lines
    )


async def _office_sac(db: AsyncSession, office_id: int | None) -> str | None:
    """The service area code of one office, read live from the HCM mirror.

    Not snapshotted onto the document, for the same reason the indent does not
    snapshot it (`indents.service._attach_office_sac`): no column holds it, and
    reading it at serve time means every issue and consignment already in the table
    shows one instead of only those raised from now on. It is a label on the office,
    so the current value is the right one. `mappers.office_sac` owns the HCM field
    name (rule 10) — nothing here knows what key it sits under.

    `db.get` goes through the session identity map, so a page of documents heading to
    the same office costs one query, not one per row.
    """
    from app.platform.hcm import mappers
    from app.platform.hcm.models import HcmOffice

    if not office_id:
        return None
    office = await db.get(HcmOffice, office_id)
    return mappers.office_sac(office.raw) if office else None


async def _decorate_issue_destination(
    db: AsyncSession,
    issue: m.MaterialIssue,
) -> m.MaterialIssue:
    office_id, office_name = await _issue_destination(db, issue)
    setattr(issue, "destination_office_id", office_id)
    setattr(issue, "destination_office_name", office_name)
    setattr(issue, "destination_office_sac", await _office_sac(db, office_id))
    return issue


_VEHICLE_IN_NAME = re.compile(r"([A-Z]{2}\d{1,2}[A-Z]{1,3}\d{3,4})$")


def _vehicle_from_office_name(office_name: str | None) -> str | None:
    """The registration number an MMU office carries in its own name.

    An indent can name a vehicle, but no live indent does and `trn_vehicles` is empty
    — the register was never populated, so there is nothing to look up. The number is
    recorded anyway: 2660 of 3282 offices are named for the vehicle that serves them
    (`AP-104-MMU-Guraja Phc-AP39TL9202`). Read the trailing token so the issue opens
    with the vehicle already filled. A prefill only — it is typed over freely, and a
    cleared box stays cleared.
    """
    if not office_name:
        return None
    tail = office_name.replace(" ", "").upper().split("-")[-1]
    found = _VEHICLE_IN_NAME.search(tail)
    return found.group(1) if found else None


def _consignment_vehicle(issue, destination_office_name: str | None) -> str | None:
    """The registration number a consignment travels on.

    Derived, never picked: `trn_vehicles` is empty, so the Vehicle box on the
    consignment form was a lookup with nothing in it. The number is already recorded
    twice over — the material issue carries whatever the store typed, and an MMU
    office is named for the vehicle that serves it (`AP-104-MMU-Badangi-AP39UH4792`),
    which is the same string the delivery address is filled from. Read it here so the
    consignment shows the vehicle the goods are actually going out on.
    """
    return (
        getattr(issue, "vehicle_number", None)
        or _vehicle_from_office_name(destination_office_name)
    )


def _address_without_vehicle(office_name: str | None) -> str | None:
    """An MMU office's name with the registration number it ends in taken off.

    The name doubles as the delivery address (`AP-104-MMU-Badangi-AP39UH4792`), so
    the address carried the vehicle number too — printed twice on every consignment
    now that the Vehicle box shows it. The number is on the document in its own
    column; the address is where the goods go.
    """
    if not office_name or not _vehicle_from_office_name(office_name):
        return office_name
    head, _, _tail = office_name.rpartition("-")
    return head.strip(" -") or office_name


async def _issue_destination(
    db: AsyncSession,
    issue: m.MaterialIssue | None,
) -> tuple[int | None, str | None]:
    """Where an issue is headed: the office it is going to, id and name.

    `issued_to_id` is the direct answer but it is empty on most live issues — an
    allocation-approval draft names a warehouse and an indent, not a person. Falling
    back to the INDENT's own office is the same answer arrived at the other way: the
    goods are for whoever raised the request. Without the fallback the consignment
    screen showed "Destination —" and left the delivery address blank on every issue
    the allocation created.
    """
    from app.platform.hcm.models import HcmEmployee
    from app.modules.indents.models import Indent

    if not issue:
        return None, None
    if issue.issued_to_id:
        employee = await db.get(HcmEmployee, issue.issued_to_id)
        if employee is not None and employee.office_id:
            return employee.office_id, employee.office_name
    if issue.indent_id:
        indent = await db.get(Indent, issue.indent_id)
        if indent is not None and getattr(indent, "office_id", None):
            return indent.office_id, indent.office_name
    return None, None


async def _destination_warehouse(
    db: AsyncSession,
    issue: m.MaterialIssue,
    origin_warehouse_id: int,
) -> Warehouse | None:
    """The stocking point a consignment is addressed to, derived from its issue.

    `to_warehouse_id` is the ONLY thing `incoming_dispatch_options` matches on, and
    nothing ever derived it — it was hand-typed, on a field the form labels "for
    transfer only". Half the live consignments went out with it blank, and not one of
    those could be inwarded: the goods arrived, and the receiving point had no
    consignment to raise a GRN against. It struck WH -> LIP direct exactly as hard as
    the MDP relay; the four that worked worked because somebody happened to fill it.

    Where the goods are going is already recorded twice over, so it never had to be
    asked: the issue names the person it is for, and the indent names the office that
    raised it. Either resolves to the one active stocking point serving that office.

    An explicit choice always wins — this only fills a blank. Origin and destination
    being the same point is not a delivery, and `create_dispatch` rejects it, so that
    case stays blank rather than writing a row its own guard would refuse.
    """
    warehouse = await _requesting_point(db, issue)
    if warehouse is None or warehouse.id == origin_warehouse_id:
        return None
    return warehouse


async def _requesting_point(
    db: AsyncSession,
    issue: m.MaterialIssue,
) -> Warehouse | None:
    """The stocking point serving the office this issue is for — origin or not.

    `_destination_warehouse` drops the case where that point IS the origin, because a
    consignment cannot be addressed to the point it leaves. The screens still need to
    know which point it was, so they can say WHY the destination came back blank
    instead of showing an empty box nobody can explain.
    """
    office_id, _ = await _issue_destination(db, issue)
    if office_id is None:
        return None
    return (await db.execute(
        select(Warehouse)
        .where(Warehouse.office_id == office_id, Warehouse.is_active.is_(True))
        .order_by(Warehouse.id)
        .limit(1)
    )).scalar_one_or_none()


async def _is_final_delivery_leg(
    db: AsyncSession,
    issue: m.MaterialIssue,
    dispatch: m.Dispatch,
) -> bool:
    """Did this consignment land where the request was raised, or is it a relay hop?

    WH -> LIP direct is one leg and the acknowledgement at the far end IS the delivery.
    WH -> MDP -> LIP is two, and the signature at the MDP is only "the lorry got here":
    the goods are on the MDP's shelf, the requester has not seen them, and the indent
    is still owed. Treating both the same closed the indent the moment the MDP signed —
    the raiser's request read as fulfilled with nothing in his hands and no way to say
    otherwise.

    Blank destination (a customer or vendor dispatch) and an unresolvable requesting
    point both answer True, which is exactly what this code did before the distinction
    existed. Only the relay case changes.
    """
    if not dispatch.to_warehouse_id:
        return True
    point = await _requesting_point(db, issue)
    return point is None or point.id == dispatch.to_warehouse_id


async def _decorate_dispatch_destination(
    db: AsyncSession,
    dispatch: m.Dispatch,
) -> m.Dispatch:
    issue = None
    if (dispatch.ref_type or "").upper() in {"ISSUE", WarehouseDocType.WH_ISSUE.value} and dispatch.ref_id:
        issue = await db.get(m.MaterialIssue, dispatch.ref_id)
    office_id, office_name = await _issue_destination(db, issue)
    setattr(dispatch, "destination_office_id", office_id)
    setattr(dispatch, "destination_office_name", office_name)
    setattr(dispatch, "destination_office_sac", await _office_sac(db, office_id))
    return dispatch


async def _decorate_dispatch_page_destinations(db: AsyncSession, page: dict) -> dict:
    for dispatch in page.get("items", []):
        await _decorate_dispatch_destination(db, dispatch)
    return page


async def _build_issue(db: AsyncSession, data: s.IssueWrite, user) -> m.MaterialIssue:
    """Build one material issue draft without committing it.

    Same reason as _build_picking: allocation approval creates its warehouse drafts
    in the same transaction as the stock reservations behind them, so a split
    allocation either produces every draft or none.
    """
    wh = await _warehouse(db, data.warehouse_id)
    from app.modules.indents.models import Indent
    indent = await db.get(Indent, data.indent_id) if data.indent_id else None

    if data.direction != IssueDirection.IN and data.items:
        # An indent is served over several issues: one per warehouse when the
        # allocation is split, and another round when procurement covers the
        # shortfall. The cap is the approved quantity, not the document count — see
        # _guard_indent_quantity. A return (direction IN) is exempt: it exists to
        # point back at an issue already made.
        #
        # Grouped per indent, because one issue can now serve a whole consolidated
        # cycle. Capping the batch against the header's indent alone would let one
        # LT's line be checked and the other 899 sail through unchecked.
        wanted: dict[int, dict[int, Decimal]] = defaultdict(dict)
        for line in data.items:
            owner = await _indent_id_for_line(db, line, data.indent_id)
            if not owner:
                continue
            by_item = wanted[owner]
            by_item[line.item_id] = by_item.get(line.item_id, ZERO) + _d(line.issued_qty)
        for indent_id, by_item in wanted.items():
            served = indent if indent and indent.id == indent_id else await db.get(
                Indent, indent_id)
            if served is None:
                continue
            await _guard_indent_quantity(
                db, served.id, served.indent_no, by_item,
                # Scoped to THIS point: the same indent is served down a chain, and the
                # warehouse's leg must not consume the MDP's allowance to forward on.
                await _already_issued(db, served.id, wh.id), "issue",
                await _live_issue_labels(db, served.id, wh.id),
            )

        # A LIP is the bottom of the chain: everything it holds arrived against a
        # request and everything it gives out answers one. Issuing with no indent
        # anywhere — not on the header, not on a line — was letting stock leave a
        # local point with nothing recording who asked for it, and the quantity cap
        # above has nothing to measure against either. Upstream points are
        # deliberately not held to this: a main store issues to departments, writes
        # off scrap and moves stock for reasons no indent covers.
        if not wanted and stock_locations.tier_of(
            wh.warehouse_type
        ) is stock_locations.LocationTier.LIP:
            raise ValidationError(
                f"{wh.name} can only issue against an indent. Pick the indent this "
                "material is being given out for.")

    if not data.items:
        raise ValidationError("An issue with no lines has nothing to issue")

    original = await get_issue(db, data.original_issue_id) if data.original_issue_id else None
    if data.direction == IssueDirection.IN and original is None:
        raise ValidationError("A return has to point at the issue it reverses")
    if original and (
        original.direction != IssueDirection.OUT.value or not original.is_stock_posted
    ):
        raise ValidationError("Materials can only return against a posted outward issue")
    picking = await get_picking(db, data.picking_id) if data.picking_id else None
    if data.picking_id and picking is None:
        raise NotFoundError(f"Material fulfilment {data.picking_id} not found")
    if picking:
        if picking.warehouse_id != wh.id:
            raise ValidationError(
                f"{picking.pick_no} belongs to {picking.warehouse_name}, not {wh.name}"
            )
        _guard(
            picking.status,
            {PickingStatus.PICKED.value, PickingStatus.COMPLETED.value},
            "raise an issue from", "material fulfilment",
        )
        existing = await db.scalar(
            select(m.MaterialIssue.id).where(
                m.MaterialIssue.picking_id == picking.id,
                m.MaterialIssue.status != IssueStatus.CANCELLED.value,
            ).limit(1)
        )
        if existing is not None:
            raise ValidationError(
                f"{picking.pick_no} already has material issue {existing}"
            )
    snapshots = await _issue_snapshot_values(
        db,
        department_id=data.department_id,
        project_id=data.project_id,
        vehicle_id=data.vehicle_id,
        issued_to_id=data.issued_to_id,
        vehicle_number=data.vehicle_number,
    )

    issue = m.MaterialIssue(
        # items=[] is not cosmetic. Without it the collection is unloaded after the
        # flush below, and _apply_issue_lines() opens with .clear(), which fires a lazy
        # SELECT. A lazy load inside an AsyncSession raises MissingGreenlet, so the
        # create failed before writing a single line. Same reason on every create_* here.
        items=[],
        issue_no=await next_number(db, WarehouseDocType.WH_ISSUE.value),
        issue_type=data.issue_type.value,
        issue_date=data.issue_date,
        indent_id=data.indent_id,
        indent_no=indent.indent_no if indent else None,
        picking_id=data.picking_id,
        pick_no=picking.pick_no if picking else None,
        warehouse_id=wh.id, warehouse_name=wh.name,
        department_id=data.department_id,
        department_name=snapshots["department_name"],
        project_id=data.project_id,
        project_name=snapshots["project_name"],
        vehicle_id=data.vehicle_id,
        vehicle_number=snapshots["vehicle_number"],
        issued_to_id=data.issued_to_id,
        issued_to_name=snapshots["issued_to_name"],
        direction=data.direction.value,
        original_issue_id=original.id if original else None,
        original_issue_no=original.issue_no if original else None,
        status=IssueStatus.DRAFT.value,
        remarks=data.remarks,
        created_by_id=getattr(user, "id", None), created_by_name=_name(user),
    )
    db.add(issue)
    await db.flush()

    await _apply_issue_lines(db, issue, data.items)
    await _reserve_issue_serials(db, issue, data.items)
    if original:
        _validate_issue_return(issue, original)
    if picking:
        _validate_picking_issue(issue, picking)
    await db.flush()

    await write_audit(db, entity="out_issues", entity_id=issue.id, entity_no=issue.issue_no,
                      action=AuditAction.CREATE, actor=user,
                      after={"status": issue.status, "total_qty": str(issue.total_qty)})
    return issue


async def _forwardable_serials(
    db: AsyncSession, *, item_id: int, named, warehouse_id: int, qty,
) -> list[str] | None:
    """The units named on this line that are still on the shelf at this point.

    Filtered rather than passed straight through, for two reasons that would both
    turn a handover into a 422. `_reserve_issue_serials` refuses a serial that is not
    AVAILABLE here, so one unit moved by hand would block the whole forward; and a
    partly rejected line carries more serials than it forwards, which trips the
    "N serial numbers for M units" guard. Whatever is dropped here is still editable
    on the draft — the storekeeper reviews it before submitting.

    Takes the serials rather than the line, because the two sources name them
    differently: a GRN line carries a `serial_numbers` list, a consignment line one
    `serial_no` per unit.
    """
    values = [value.strip() for value in (named or []) if value and value.strip()]
    if not values:
        return None
    rows = (await db.execute(
        select(m.SerialNumber.serial_number).where(
            m.SerialNumber.item_id == item_id,
            m.SerialNumber.serial_number.in_(values),
            m.SerialNumber.warehouse_id == warehouse_id,
            m.SerialNumber.status == SerialStatus.AVAILABLE.value,
            m.SerialNumber.is_active.is_(True),
        )
    )).scalars().all()
    on_shelf = {value.lower() for value in rows}
    return [value for value in values if value.lower() in on_shelf][:int(qty)] or None


async def _indent_line_for(db: AsyncSession, indent_id: int, item_id: int) -> int | None:
    """The indent line an onward issue line answers, when the source document did not
    carry `indent_item_id` itself (a consignment line never does)."""
    from app.modules.indents.models import IndentItem

    return await db.scalar(
        select(IndentItem.id).where(
            IndentItem.indent_id == indent_id,
            IndentItem.item_id == item_id,
        ).limit(1)
    )


async def _forward_drafts(db: AsyncSession, *, warehouse_id: int, source_no: str,
                          groups: dict[int, list], user) -> list[m.MaterialIssue]:
    """Build one onward issue draft per indent, out of the point that received them.

    Shared by both doorways into forwarding — the GRN (`forward_arrival`) and the
    consignment itself (`forward_dispatch`) — so the two can never disagree about what
    a handover is. Only drafts: the storekeeper still reviews and submits each one, and
    `_issue_doc_type` files them as FORWARD_ISSUE so Approvals Config can wave them
    through without touching the OWN_STOCK_ISSUE ladder.
    """
    from app.modules.indents.models import Indent

    drafts: list[m.MaterialIssue] = []
    for indent_id, items in groups.items():
        indent = await db.get(Indent, indent_id)
        if indent is None or not items:
            continue
        # Already forwarded once: a second draft would double-issue the same goods.
        if await db.scalar(
            select(m.MaterialIssue.id).where(
                m.MaterialIssue.indent_id == indent_id,
                m.MaterialIssue.warehouse_id == warehouse_id,
                m.MaterialIssue.status.not_in(list(DEAD_ISSUE_STATUSES)),
            ).limit(1)
        ):
            continue

        draft = await _build_issue(db, s.IssueWrite(
            issue_type=IssueType.DEPARTMENT,
            issue_date=ist_today(),
            indent_id=indent_id,
            warehouse_id=warehouse_id,
            department_id=indent.department_id,
            project_id=indent.project_id,
            issued_to_id=indent.requested_by_id,
            remarks=f"Forwarded from {source_no}",
            items=items,
        ), user)
        drafts.append(draft)

    await db.commit()
    return [await get_issue(db, draft.id) for draft in drafts]


async def forward_arrival(db: AsyncSession, receipt_id: int, user) -> list[m.MaterialIssue]:
    """Pass an arrived consignment on to the points below — the MDP leg of WH -> MDP -> LIP.

    The MDP never owned these goods: they landed here on a consignment raised for
    indents whose delivery points sit further down, and the five people who signed
    each indent already sanctioned them. Forwarding is a handover, not a decision, so
    this only builds the onward DRAFTS; the storekeeper still reviews and submits, and
    `_issue_doc_type` will file them as FORWARD_ISSUE so Approvals Config can wave them
    through without touching the OWN_STOCK_ISSUE ladder.

    One draft per INDENT, because each LT is a separate delivery to a separate point —
    an issue cannot cover two destinations or nobody can say who received what.

    This is the doorway for a point that runs a receiving desk. A point that does not
    has no GRN to forward from — see `forward_dispatch`.
    """
    receipt = await get_receipt(db, receipt_id)
    if receipt.receipt_type != ReceiptType.DISPATCH.value:
        raise ValidationError(
            f"{receipt.grn_no} is not an arrived consignment; there is nothing to forward")
    if not receipt.is_stock_posted:
        raise ValidationError(
            f"{receipt.grn_no} has not been put away yet — forward it once the stock is here")

    # What each indent is owed here, keyed by the line so the onward issue points back
    # at the same `indent_item_id` the reservation was written against.
    by_indent: dict[int, list] = defaultdict(list)
    for line in receipt.items:
        if not line.indent_id or _d(line.accepted_qty) <= ZERO:
            continue
        by_indent[line.indent_id].append(line)
    if not by_indent:
        raise ValidationError(
            f"{receipt.grn_no} carries nothing raised against an indent, so there is "
            "nobody below to forward it to")

    groups: dict[int, list] = {}
    for indent_id, lines in by_indent.items():
        items = []
        for line in lines:
            indent_item_id = getattr(line, "indent_item_id", None) or \
                await _indent_line_for(db, indent_id, line.item_id)
            accepted = _d(line.accepted_qty)
            # The consignment landed in a batch, in a bin, as named units. That is the
            # only record of WHICH goods these are, and dropping it left the onward
            # issue on NO_BATCH/NO_BIN: the serial picker then fell back to every unit
            # the point holds — opening stock included — and handed the indent raiser
            # something that never came off this consignment.
            items.append(s.IssueItemWrite(
                indent_item_id=indent_item_id,
                item_id=line.item_id,
                item_code=line.item_code,
                item_name=line.item_name,
                batch_id=line.batch_id or None,
                bin_id=line.bin_id or None,
                requested_qty=accepted,
                issued_qty=accepted,
                serial_numbers=await _forwardable_serials(
                    db, item_id=line.item_id, named=line.serial_numbers,
                    warehouse_id=receipt.warehouse_id, qty=accepted),
                imei_numbers=[value.strip() for value in (line.imei_numbers or [])
                              if value.strip()] or None,
            ))
        groups[indent_id] = items

    return await _forward_drafts(db, warehouse_id=receipt.warehouse_id,
                                 source_no=receipt.grn_no, groups=groups, user=user)


async def can_forward_dispatch(db: AsyncSession, dispatch: m.Dispatch) -> bool:
    """Is `forward_dispatch` the way on from this consignment?

    True only for the relay hop that signed for the lorry and put the goods straight on
    the shelf: acknowledged here, no GRN behind it, and this point does not run a
    receiving desk. Every other case forwards from the GRN, or is the last leg and has
    nothing to forward at all.
    """
    if dispatch.status != DispatchStatus.ACKNOWLEDGED.value:
        return False
    # Nothing was credited here unless the goods landed on our own shelf, and a forward
    # off stock that was never posted builds a draft that dies at "0 available".
    if not _lands_on_internal_shelf(dispatch) or not dispatch.ref_id:
        return False
    if (dispatch.ref_type or "").upper() not in {"ISSUE", WarehouseDocType.WH_ISSUE.value}:
        return False
    if await requires_inward(db, dispatch.to_warehouse_id):
        return False
    if await _inward_receipt_for_dispatch(db, dispatch.id) is not None:
        return False
    issue = await db.get(m.MaterialIssue, dispatch.ref_id)
    if issue is None:
        return False
    return not await _is_final_delivery_leg(db, issue, dispatch)


async def forward_dispatch(db: AsyncSession, dispatch_id: int, user) -> list[m.MaterialIssue]:
    """Forward a consignment that went straight onto stock, with no GRN behind it.

    The relay point that does not run a receiving desk has nothing for `forward_arrival`
    to start from: `acknowledge_dispatch` credited what arrived directly and no GRN was
    ever raised, so the MDP leg of WH -> MDP -> LIP dead-ended there. Same handover and
    the same one-draft-per-indent, started from the consignment instead.
    """
    dispatch = await get_dispatch(db, dispatch_id)
    if dispatch.status != DispatchStatus.ACKNOWLEDGED.value:
        raise ValidationError(
            f"{dispatch.dispatch_no} has not been acknowledged here yet — confirm what "
            "arrived before forwarding it on")
    if not dispatch.to_warehouse_id:
        raise ValidationError(
            f"{dispatch.dispatch_no} names no destination point, so there is nothing "
            "here to forward")
    existing = await _inward_receipt_for_dispatch(db, dispatch.id)
    if existing is not None:
        raise ValidationError(
            f"{dispatch.dispatch_no} was inwarded on {existing.grn_no} — forward it "
            "from there, so the handover carries the accepted quantity")
    if await requires_inward(db, dispatch.to_warehouse_id):
        raise ValidationError(
            f"{dispatch.to_warehouse_name or 'This point'} receives through Material "
            f"Inward, GRN and QC. Inward {dispatch.dispatch_no} first, then forward it "
            "from the GRN.")

    # A serialized item travels as one consignment line per unit, so the lines are
    # folded back to one row per item and batch before they can become an issue line.
    merged: dict[tuple[int, int, int], dict] = {}
    for line in dispatch.items:
        qty = _d(line.delivered_qty)
        if not line.indent_id or qty <= ZERO:
            continue
        row = merged.setdefault(
            (line.indent_id, line.item_id, line.batch_id or 0),
            {"line": line, "qty": ZERO, "serials": [], "imeis": []},
        )
        row["qty"] += qty
        if line.serial_no:
            row["serials"].append(line.serial_no)
        if line.imei_no:
            row["imeis"].append(line.imei_no)
    if not merged:
        raise ValidationError(
            f"{dispatch.dispatch_no} carries nothing raised against an indent, so there "
            "is nobody below to forward it to")

    groups: dict[int, list] = defaultdict(list)
    for (indent_id, item_id, _batch), row in merged.items():
        line, qty = row["line"], row["qty"]
        groups[indent_id].append(s.IssueItemWrite(
            indent_item_id=await _indent_line_for(db, indent_id, item_id),
            item_id=item_id,
            item_code=line.item_code,
            item_name=line.item_name,
            batch_id=line.batch_id or None,
            # Acknowledgement credits bulk (`NO_BIN`) — there was no putaway to move it
            # onto a shelf — so the onward issue draws from bulk too.
            bin_id=None,
            requested_qty=qty,
            issued_qty=qty,
            serial_numbers=await _forwardable_serials(
                db, item_id=item_id, named=row["serials"],
                warehouse_id=dispatch.to_warehouse_id, qty=qty),
            imei_numbers=[value.strip() for value in row["imeis"] if value.strip()] or None,
        ))

    return await _forward_drafts(db, warehouse_id=dispatch.to_warehouse_id,
                                 source_no=dispatch.dispatch_no, groups=dict(groups),
                                 user=user)


async def create_issue(db: AsyncSession, data: s.IssueWrite, user) -> m.MaterialIssue:
    issue = await _build_issue(db, data, user)
    await db.commit()
    return await get_issue(db, issue.id)


async def update_issue(db: AsyncSession, issue_id: int, data: s.IssueWrite, user) -> m.MaterialIssue:
    issue = await get_issue(db, issue_id)
    _guard(issue.status, {IssueStatus.DRAFT.value}, "edit", "issue")

    before = {"total_qty": str(issue.total_qty)}
    wh = await _warehouse(db, data.warehouse_id)
    snapshots = await _issue_snapshot_values(
        db,
        department_id=data.department_id,
        project_id=data.project_id,
        vehicle_id=data.vehicle_id,
        issued_to_id=data.issued_to_id,
        vehicle_number=data.vehicle_number,
    )
    issue.issue_type = data.issue_type.value
    issue.issue_date = data.issue_date
    issue.indent_id = data.indent_id
    if data.indent_id:
        from app.modules.indents.models import Indent
        indent = await db.get(Indent, data.indent_id)
        issue.indent_no = indent.indent_no if indent else None
    else:
        issue.indent_no = None
    issue.picking_id = data.picking_id
    picking = await get_picking(db, data.picking_id) if data.picking_id else None
    issue.pick_no = picking.pick_no if picking else None
    issue.warehouse_id = wh.id
    issue.warehouse_name = wh.name
    issue.department_id = data.department_id
    issue.department_name = snapshots["department_name"]
    issue.project_id = data.project_id
    issue.project_name = snapshots["project_name"]
    issue.vehicle_id = data.vehicle_id
    issue.vehicle_number = snapshots["vehicle_number"]
    issue.issued_to_id = data.issued_to_id
    issue.issued_to_name = snapshots["issued_to_name"]
    issue.remarks = data.remarks

    await _clear_issue_serial_reservations(db, issue.id)
    await _apply_issue_lines(db, issue, data.items)
    await _reserve_issue_serials(db, issue, data.items)
    if issue.direction == IssueDirection.IN.value and issue.original_issue_id:
        original = await get_issue(db, issue.original_issue_id)
        _validate_issue_return(issue, original)
    if picking:
        _validate_picking_issue(issue, picking)
    await db.flush()

    await write_audit(db, entity="out_issues", entity_id=issue.id, entity_no=issue.issue_no,
                      action=AuditAction.UPDATE, actor=user, before=before,
                      after={"total_qty": str(issue.total_qty)})
    await db.commit()
    return await get_issue(db, issue_id)


# ---- which approval event a material issue runs under -------------------------
#
# WH_ISSUE is the ordinary warehouse issue and keeps whatever ladder is configured for
# it. OWN_STOCK_ISSUE is the same document when the point it comes OUT of is one the
# submitter holds — his own MDP, or a LIP reporting under him. Nobody above him owns
# that shelf, so the default approver is him; configurable on its own row in Approvals
# Config without touching the WH_ISSUE ladder.
ISSUE_DOC_TYPES = (DocType.WH_ISSUE.value, DocType.OWN_STOCK_ISSUE.value,
                   DocType.FORWARD_ISSUE.value)


async def _indent_ids_on_issue(db: AsyncSession, issue: m.MaterialIssue) -> set[int]:
    """Every indent this issue serves — the header's, plus the lines'.

    The header carries one `indent_id`; a consolidated issue serving several LTs
    carries the rest on its lines via `indent_item_id`, so both have to be read or a
    batch issue looks like an indent-less one.
    """
    from app.modules.indents.models import IndentItem

    ids = {issue.indent_id} if issue.indent_id else set()
    # Queried, not read off `issue.items`: some callers reach here with an issue loaded
    # by db.get(), where touching the relationship would lazy-load under async and
    # raise MissingGreenlet.
    line_item_ids = [row for row in (await db.execute(
        select(m.MaterialIssueLine.indent_item_id)
        .where(m.MaterialIssueLine.issue_id == issue.id,
               m.MaterialIssueLine.indent_item_id.is_not(None))
    )).scalars().all() if row]
    if line_item_ids:
        ids |= {row for row in (await db.execute(
            select(IndentItem.indent_id).where(IndentItem.id.in_(line_item_ids))
        )).scalars().all() if row}
    return ids


async def _indent_id_for_line(db: AsyncSession, line, header_indent_id: int | None) -> int | None:
    """Which indent one INCOMING issue line serves.

    The line's own `indent_item_id` wins; the header is the fallback so a plain
    single-indent issue behaves exactly as it always did.
    """
    from app.modules.indents.models import IndentItem

    if getattr(line, "indent_item_id", None):
        owner = await db.scalar(
            select(IndentItem.indent_id).where(IndentItem.id == line.indent_item_id))
        if owner:
            return owner
    return header_indent_id


async def _line_indent_ids(db: AsyncSession, issue: m.MaterialIssue) -> dict[int, int]:
    """`{issue line id: the indent that line serves}`.

    One query for the whole document rather than one per line — a consolidated issue
    covering a monthly cycle has hundreds of lines and must not cost hundreds of round
    trips. Lines with no `indent_item_id` are absent; the caller falls back to the
    header, which is what a plain single-indent issue has always used.
    """
    from app.modules.indents.models import IndentItem

    pairs = {line.id: line.indent_item_id for line in (issue.items or [])
             if line.indent_item_id}
    if not pairs:
        return {}
    owner = {row[0]: row[1] for row in (await db.execute(
        select(IndentItem.id, IndentItem.indent_id)
        .where(IndentItem.id.in_(set(pairs.values())))
    )).all()}
    return {line_id: owner[item_id]
            for line_id, item_id in pairs.items() if item_id in owner}


async def _is_forwarding(db: AsyncSession, issue: m.MaterialIssue) -> bool:
    """Is this point merely passing goods along, rather than giving its own stock?

    True when the stock being issued arrived HERE on a consignment raised for the same
    indent — the WH -> MDP -> LIP middle leg. Those goods were sanctioned by the five
    people who signed the indent; the MDP never owned them and is not making a
    decision about them. Read off `inb_receipts` (ReceiptType.DISPATCH) rather than a
    new flag, because that row is already written when the MDP inwards the delivery.
    """
    indent_ids = await _indent_ids_on_issue(db, issue)
    if not indent_ids or not issue.warehouse_id:
        return False
    return bool(await db.scalar(
        select(m.Receipt.id)
        .join(m.ReceiptItem, m.ReceiptItem.receipt_id == m.Receipt.id)
        .where(
            m.Receipt.receipt_type == ReceiptType.DISPATCH.value,
            m.Receipt.warehouse_id == issue.warehouse_id,
            m.ReceiptItem.indent_id.in_(indent_ids),
        ).limit(1)
    ))


async def _issue_doc_type(db: AsyncSession, issue: m.MaterialIssue, user) -> str:
    """At submit: decide which of the three events this issue is.

    Order matters. Forwarding is checked first because it is also an issue out of a
    point the raiser holds, and so would otherwise be read as OWN_STOCK_ISSUE — "I
    chose to give my stock", which is a real decision and must keep its ladder. The
    two cannot share a row in Approvals Config or switching one off silently switches
    off the other.
    """
    my_points = await stock_locations.location_ids_for_user(db, user)
    if not (issue.warehouse_id and issue.warehouse_id in my_points):
        return DocType.WH_ISSUE.value
    if await _is_forwarding(db, issue):
        return DocType.FORWARD_ISSUE.value
    return DocType.OWN_STOCK_ISSUE.value


async def _issue_doc_type_of(db: AsyncSession, issue_id: int) -> str:
    """Afterwards: read back what it was submitted under.

    Off the instance rather than a column on the issue — there is no column, and the
    instance is the authority on which chain is actually running.
    """
    found = (await db.execute(
        select(WfInstance.doc_type)
        .where(WfInstance.doc_id == issue_id,
               WfInstance.doc_type.in_(ISSUE_DOC_TYPES))
        .order_by(WfInstance.id.desc()).limit(1)
    )).scalar_one_or_none()
    return found or DocType.WH_ISSUE.value


async def submit_issue(db: AsyncSession, issue_id: int, user) -> m.MaterialIssue:
    """Hands the document to the workflow engine.

    The engine owns the chain; this module owns the status and snapshots who is
    holding it so a list screen does not have to ask. If the engine has no workflow
    configured it falls back rather than stranding the document (rule 8), which is why
    a failure to start is logged and the document still moves.
    """
    issue = await get_issue(db, issue_id)
    _guard(issue.status, {IssueStatus.DRAFT.value}, "submit", "issue")
    if not issue.items:
        raise ValidationError("An issue with no lines has nothing to approve")

    context = {
        "warehouse_id": issue.warehouse_id,
        "total_value": float(_d(issue.total_value)),
        "department_id": issue.department_id,
        "project_id": issue.project_id,
    }
    context.update({
        "doc_no": issue.issue_no,
        "doc_summary": f"Material issue {issue.issue_no}",
        "requester_position_id": getattr(user, "active_position_id", None),
    })
    doc_type = await _issue_doc_type(db, issue, user)
    instance = await engine.start(
        db, doc_type, issue.id, context, user
    )
    if instance.status == InstanceStatus.APPROVED.value:
        issue.status = IssueStatus.APPROVED.value
        issue.approved_by_name = _name(user)
        issue.approved_at = utcnow()
        issue.current_approver_name = None
    else:
        approvers = await engine.current_approvers(db, doc_type, issue.id)
        issue.current_approver_name = _approver_label(approvers)
        issue.status = IssueStatus.PENDING_APPROVAL.value

    await write_audit(db, entity="out_issues", entity_id=issue.id, entity_no=issue.issue_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": IssueStatus.DRAFT.value},
                      after={"status": issue.status,
                             "current_approver": issue.current_approver_name})
    await db.commit()
    return await get_issue(db, issue_id)


async def act_on_issue(
    db: AsyncSession, issue_id: int, action: str, comments: str, user,
) -> m.MaterialIssue:
    """Apply an approval decision and keep the warehouse document in sync."""
    issue = await get_issue(db, issue_id)
    _guard(
        issue.status, {IssueStatus.PENDING_APPROVAL.value},
        action.lower(), "issue",
    )
    before = issue.status
    doc_type = await _issue_doc_type_of(db, issue.id)
    instance = await engine.act(
        db,
        doc_type,
        issue.id,
        action,
        user,
        comments,
        context={
            "doc_no": issue.issue_no,
            "doc_summary": f"Material issue {issue.issue_no}",
            "warehouse_id": issue.warehouse_id,
            "department_id": issue.department_id,
            "project_id": issue.project_id,
            "total_value": float(_d(issue.total_value)),
        },
    )
    if instance.status == InstanceStatus.APPROVED.value:
        issue.status = IssueStatus.APPROVED.value
        issue.approved_by_name = _name(user)
        issue.approved_at = utcnow()
        issue.current_approver_name = None
    elif instance.status == InstanceStatus.REJECTED.value:
        issue.status = IssueStatus.REJECTED.value
        issue.current_approver_name = None
    else:
        issue.current_approver_name = _approver_label(
            await engine.current_approvers(db, doc_type, issue.id)
        )

    await write_audit(
        db, entity="out_issues", entity_id=issue.id, entity_no=issue.issue_no,
        action=AuditAction.UPDATE, actor=user,
        before={"status": before},
        after={"status": issue.status, "comments": comments},
    )
    await db.commit()
    return await get_issue(db, issue_id)


def _approver_label(approvers: list) -> str | None:
    """A readable "who is holding this" from whatever the engine returned."""
    names = []
    for a in approvers or []:
        name = (a.get("name") or a.get("employee_name") or a.get("full_name")
                if isinstance(a, dict) else getattr(a, "full_name", None))
        if name:
            names.append(name)
    if not names:
        return None
    return names[0] if len(names) == 1 else f"{names[0]} +{len(names) - 1}"


async def _raise_picking_for_issue(
    db: AsyncSession, issue: m.MaterialIssue, user,
) -> m.Picking | None:
    """Raise the picklist draft that follows an issue whose stock has just posted.

    Rung two of the draft chain, and it is strictly a convenience: posting stock is a
    physical fact — the goods have left the shelf — so nothing in here may veto it.
    Everything below either degrades or gives up quietly, and the storekeeper can
    always raise the pick by hand.

    Skipped when the issue already came from a picklist (issue.picking_id) — that is
    the older pick-then-issue path, and re-raising there would loop.
    """
    if issue.picking_id:
        return None
    existing = await db.scalar(
        select(m.Picking.id).where(
            m.Picking.ref_type == "ISSUE",
            m.Picking.ref_id == issue.id,
            m.Picking.status != PickingStatus.CANCELLED.value,
        ).limit(1)
    )
    if existing is not None:
        return None

    # Resolve the bins before handing them over. _build_picking rejects a bin it
    # cannot load, and live issue lines carry ids that no longer exist in
    # whs_warehouse_locations; sending one through would turn a stale reference on a
    # draft into a hard failure to issue stock at all. An unresolved bin becomes "no
    # bin", which is what the picker sees anyway when nothing has told them where to go.
    lines: list[s.PickingItemWrite] = []
    for line in issue.items:
        if _d(line.issued_qty) <= ZERO:
            continue
        bin_id = line.bin_id or None
        if bin_id is not None:
            source = await db.get(Bin, bin_id)
            if source is None or source.warehouse_id != issue.warehouse_id:
                logger.warning(
                    "issue %s line %s: bin %s is unusable, picking line raised unbinned",
                    issue.issue_no, line.line_no, bin_id,
                )
                bin_id = None
        if bin_id is None:
            # Nothing upstream chose a bin — an issue drafted from an allocation never
            # does — so 58 of 64 live pick lines told the picker to go to "any" bin.
            # A picklist without a location is a list of things to hunt for. Ask stock
            # where this item actually is, in the order the strategy says to draw it.
            bin_id = await _pick_bin_for(
                db, item_id=line.item_id, warehouse_id=issue.warehouse_id,
                batch_id=line.batch_id or None,
            )
        lines.append(s.PickingItemWrite(
            item_id=line.item_id,
            bin_id=bin_id,
            batch_id=line.batch_id or None,
            required_qty=_d(line.issued_qty),
        ))
    if not lines:
        return None

    # Savepoint for the same reason as the consignment below: _build_picking flushes
    # its header before its lines, so a rejection partway would otherwise leave a
    # half-built pick to be committed alongside the stock movement.
    try:
        async with db.begin_nested():
            return await _build_picking(db, s.PickingWrite(
                pick_date=ist_today(),
                warehouse_id=issue.warehouse_id,
                ref_type="ISSUE",
                ref_id=issue.id,
                items=lines,
            ), user)
    except AppException as exc:
        logger.warning("auto-picklist for %s skipped: %s", issue.issue_no, exc)
        return None


async def set_issue_serials(db: AsyncSession, issue_id: int,
                            data: s.IssueSerialsIn, user) -> m.MaterialIssue:
    """Name the physical units on an approved issue, without reopening the document.

    The rest of the issue stays frozen after approval — quantities, bins and batches
    are what the approver saw. Only which serials are being handed over is still
    open, because that is decided at the shelf. `update_issue` cannot do this: it
    is DRAFT-only by design, and post_issue refuses an incomplete serial set, so an
    approved serialized issue had no way to reach ISSUED at all.
    """
    issue = await get_issue(db, issue_id)
    _guard(issue.status, {IssueStatus.DRAFT.value, IssueStatus.APPROVED.value},
           "capture serials on", "issue")
    if issue.is_stock_posted:
        raise ValidationError(f"{issue.issue_no} has already been posted")

    by_line = {row.id: row.serial_numbers for row in data.lines}
    unknown = set(by_line) - {line.id for line in issue.items}
    if unknown:
        raise ValidationError(
            f"Line {sorted(unknown)[0]} is not on {issue.issue_no}")

    # _reserve_issue_serials zips strictly against issue.items, so every line is
    # restated — the ones not being edited keep the serials already reserved.
    inputs = [
        s.IssueItemWrite(
            item_id=line.item_id,
            indent_item_id=line.indent_item_id,
            requested_qty=_d(line.requested_qty),
            issued_qty=_d(line.issued_qty),
            rate=_d(line.rate),
            batch_id=line.batch_id,
            bin_id=line.bin_id,
            remarks=line.remarks,
            # `unit_keys`, not `serial_numbers`: an untouched line is restated in the
            # currency its item is validated on, so an IMEI-named unit is not looked
            # up by a serial the IMEI lookup cannot see.
            serial_numbers=by_line.get(
                line.id,
                getattr(line, "unit_keys", None)
                or getattr(line, "serial_numbers", None) or []),
        )
        for line in issue.items
    ]
    await _clear_issue_serial_reservations(db, issue.id)
    await _reserve_issue_serials(db, issue, inputs)

    await write_audit(db, entity="out_issues", entity_id=issue.id,
                      entity_no=issue.issue_no, action=AuditAction.UPDATE, actor=user,
                      after={"serials": {str(line.id): getattr(line, "serial_numbers", [])
                                         for line in issue.items}})
    await db.commit()
    return await get_issue(db, issue.id)


async def _issue_slices(
    db: AsyncSession, issue: m.MaterialIssue, line: m.MaterialIssueLine, qty,
) -> list[tuple[int, int, int, object]]:
    """Where an unreserved issue line's goods actually are:
    (bin, batch, project, quantity).

    All three dimensions come off the balance row, not off the document. `stk_balance`
    is keyed on (item, warehouse, bin, batch, project) and `move_stock_out` filters on
    every one of them, so taking any of them from the issue header re-introduces the
    same miss this function exists to prevent. A forwarded consignment inwards with no
    project on the balance row while the issue itself carries the indent's project —
    that alone was enough to read as "0 available" with the goods on the shelf.

    The line's own bin and batch are honoured whenever they hold enough — a
    storekeeper who named a batch meant it. They are only resolved when the named
    location cannot cover the line, which is what a FORWARDED consignment always
    looks like: the reservation was consumed at the point that dispatched it, so the
    line arrives carrying that point's bin and batch (in practice none), while the
    goods sit here under the batch the inward GRN created.

    Earliest expiry first, then oldest row: goods with a shelf life must leave in the
    order they expire, and this is the one place an unreserved outward issue chooses.
    A line may span batches, so several slices can come back.

    Returns the line's own location unchanged when nothing is found, so a genuine
    shortage still fails in `move_stock_out` with its own message rather than being
    silently swallowed here.
    """
    from app.modules.inventory.models import Stock

    fallback = [(line.bin_id, line.batch_id, issue.project_id or 0, qty)]
    rows = (await db.execute(
        select(Stock)
        .where(Stock.warehouse_id == issue.warehouse_id,
               Stock.item_id == line.item_id,
               Stock.available_qty > 0)
        .order_by(Stock.expiry_date.is_(None), Stock.expiry_date, Stock.id)
    )).scalars().all()
    if not rows:
        return fallback

    named = [r for r in rows
             if r.batch_id == line.batch_id and r.bin_id == line.bin_id
             and r.project_id == (issue.project_id or 0)]
    if named and _d(named[0].available_qty) >= qty:
        return fallback

    slices: list[tuple[int, int, int, object]] = []
    remaining = qty
    for row in rows:
        take = min(remaining, _d(row.available_qty))
        if take <= ZERO:
            continue
        slices.append((row.bin_id, row.batch_id, row.project_id, take))
        remaining -= take
        if remaining <= ZERO:
            break
    # Short overall: leave it to move_stock_out to say so against the line's own
    # location, rather than issuing a partial quantity nobody asked for.
    return slices if remaining <= ZERO else fallback

async def _raise_outbound_inspection_for(
    db: AsyncSession,
    issue: m.MaterialIssue,
    user,
) -> m.OutboundInspection:
    """The outbound inspection a posted issue creates for items requiring QC."""
    inspection = m.OutboundInspection(
        items=[],
        inspection_no=await next_number(db, WarehouseDocType.INSPECTION.value),
        inspection_date=ist_today(),
        issue_id=issue.id,
        issue_no=issue.issue_no,
        warehouse_id=issue.warehouse_id,
        warehouse_name=issue.warehouse_name,
        status=InspectionStatus.DRAFT.value,
        inspector_id=getattr(user, "id", None),
        inspector_name=_name(user),
    )
    db.add(inspection)
    await db.flush()

    issued_serials = await _issued_serial_index(db, issue)
    
    for line in issue.items:
        item = await _item_snapshot(db, line.item_id)
        if not item.requires_qi:
            continue
            
        # Collect serials for this line
        line_serials = []
        if item.is_serial_tracked:
            # Match serials by item_id and batch_id
            for sn, s_row in issued_serials.items():
                if s_row.item_id == line.item_id and (not line.batch_id or s_row.batch_id == line.batch_id):
                    line_serials.append({
                        "serial_no": s_row.serial_number,
                        "imei_no": s_row.imei,
                        "asset_code": s_row.asset_code,
                        "consumable_code": s_row.consumable_code
                    })

        inspection.items.append(m.OutboundInspectionItem(
            issue_item_id=line.id, item_id=line.item_id,
            item_code=line.item_code, item_name=line.item_name, uom_code=line.uom_code,
            batch_no=line.batch_no,
            inspected_qty=_d(line.issued_qty), accepted_qty=_d(line.issued_qty),
            rejected_qty=ZERO, result=InspectionResult.PENDING.value,
            serial_numbers=line_serials if line_serials else None,
        ))
        
    _outbound_inspection_totals(inspection)
    await db.flush()
    return inspection


async def post_issue(db: AsyncSession, issue_id: int, user) -> m.MaterialIssue:
    """Takes the stock off the shelf. The only step here that moves anything."""
    issue = await get_issue(db, issue_id)
    _guard(issue.status, {IssueStatus.APPROVED.value}, "issue stock against", "issue")
    if issue.is_stock_posted:
        raise ValidationError(f"{issue.issue_no} has already been posted")

    outward = issue.direction == IssueDirection.OUT.value
    direction = StockDirection.OUT.value if outward else StockDirection.IN.value

    # The serial set has to be complete before anything leaves the shelf. Checked
    # here rather than at draft creation: this is the first moment the storekeeper
    # has actually handled the units. Every line is reported at once so a picker
    # holding a trolley is not sent back for one item at a time.
    incomplete = []
    needs_qc = False
    for line in issue.items:
        qty = _d(line.issued_qty)
        if qty <= ZERO:
            continue
        item = await _item_snapshot(db, line.item_id)
        if item.requires_qi:
            needs_qc = True
        if not item.is_serial_tracked:
            continue
        captured = len(getattr(line, "serial_numbers", None) or [])
        if captured != int(qty):
            incomplete.append(
                f"{item.code}: {captured} of {int(qty)} serial numbers captured")
    if incomplete:
        raise ValidationError(
            "Serial numbers are incomplete — " + "; ".join(incomplete))

    # Which indent each line belongs to. Read per LINE, not off the header: an issue
    # serving a consolidated batch carries lines from many indents, and a reservation
    # is held against the indent that raised it. Using the header here would look for
    # 900 LTs' holds under one requester's id and find nothing.
    line_indents = await _line_indent_ids(db, issue)

    # The units this issue is taking off the shelf, claimed BEFORE anything moves so
    # each ledger row can name the units it carried. Claiming after the moves (where
    # `_mark_serials` sits) would mean the rows were already written and `stk_ledger`
    # is append-only — the codes could never be added to them.
    line_units = await _claim_issue_units(db, issue) if outward else {}

    # A move between two points of the SAME tier is a transfer between peers, not a
    # warehouse issuing down the chain: WH -> WH, MDP -> MDP and LIP -> LIP all belong
    # on the ledger as STO. `inventory.service` already writes exactly that string for
    # a stock transfer order, so the ledger's own filter and its label cover these rows
    # the day they appear — this names the movement, it does not invent a vocabulary.
    #
    # The destination comes from `_requesting_point`, the office-to-stocking-point
    # answer the consignment screens already run on. NOT `indent.warehouse_id`: that
    # column is written by the warehouse when it fulfils, and is NULL on every live
    # indent, so a rule reading it would classify nothing at all.
    #
    # A return (`outward` False) keeps WH_ISSUE. It reverses whatever the issue was and
    # is matched by ref_id, so re-labelling it would only split one document's rows
    # across two ref_types.
    ledger_ref_type = InventoryRefType.WH_ISSUE.value
    if outward:
        source = await db.get(Warehouse, issue.warehouse_id)
        destination = await _requesting_point(db, issue)
        if (source is not None and destination is not None
                and source.id != destination.id
                and source.warehouse_type == destination.warehouse_type):
            ledger_ref_type = InventoryRefType.STO.value

    for line in issue.items:
        qty = _d(line.issued_qty)
        if qty <= ZERO:
            continue
        line_indent_id = line_indents.get(line.id) or issue.indent_id
        units = line_units.get(line.id)

        # An approved allocation reserves concrete stock rows. Consume and issue those
        # exact rows so the hold disappears with the goods, including its bin, batch
        # and project dimensions. Legacy/manual issues with no reservation retain the
        # explicit line location path below.
        if outward and line_indent_id:
            held = await stock_allocation.reserved_quantity(
                db,
                InventoryRefType.RESERVATION.value,
                line_indent_id,
                ref_line_id=line.indent_item_id,
                item_id=line.item_id,
            )
            if held > ZERO:
                held_here = await stock_allocation.reserved_quantity(
                    db,
                    InventoryRefType.RESERVATION.value,
                    line_indent_id,
                    ref_line_id=line.indent_item_id,
                    item_id=line.item_id,
                    warehouse_id=issue.warehouse_id,
                )
                if qty > held:
                    raise ValidationError(
                        f"{line.item_code or line.item_id}: only {held} is allocated "
                        f"against this indent; cannot issue {qty}."
                    )
                if held_here < qty:
                    raise ValidationError(
                        f"{line.item_code or line.item_id}: {qty} is allocated, but only "
                        f"{held_here} is reserved in {issue.warehouse_name or 'this warehouse'}."
                    )

                slices = await stock_allocation.consume_for_issue(
                    db,
                    InventoryRefType.RESERVATION.value,
                    line_indent_id,
                    quantity=qty,
                    ref_line_id=line.indent_item_id,
                    item_id=line.item_id,
                    warehouse_id=issue.warehouse_id,
                )
                for stock in slices:
                    await move_stock(
                        db, item_id=line.item_id, qty=stock.quantity,
                        direction=StockDirection.OUT.value,
                        ref_type=ledger_ref_type,
                        ref_id=issue.id, ref_no=issue.issue_no, user=user,
                        warehouse_id=stock.warehouse_id,
                        bin_id=stock.bin_id, batch_id=stock.batch_id,
                        project_id=stock.project_id,
                        serial_numbers=take_units(units, stock.quantity),
                    )
                continue

        if outward:
            # Where this line's goods actually sit, not where the line says they do.
            # A forwarded consignment has no reservation at THIS point (the hold was
            # consumed at the warehouse that dispatched it), so it lands here with the
            # bin and batch it was allocated under upstream — usually none at all.
            # `stk_balance` is keyed on (item, warehouse, bin, batch, project), so a
            # line still carrying batch 0 looked up a row that does not exist and the
            # issue failed for "no stock" while the goods sat one key away.
            for source_bin, source_batch, source_project, slice_qty in (
                    await _issue_slices(db, issue, line, qty)):
                await move_stock_out(
                    db, item_id=line.item_id, qty=slice_qty,
                    ref_type=ledger_ref_type,
                    ref_id=issue.id, ref_no=issue.issue_no, user=user,
                    warehouse_id=issue.warehouse_id,
                    bin_id=source_bin, batch_id=source_batch,
                    project_id=source_project,
                    serial_numbers=take_units(units, slice_qty),
                )
        else:
            await move_stock(
                db, item_id=line.item_id, qty=qty, direction=direction,
                ref_type=ledger_ref_type,
                ref_id=issue.id, ref_no=issue.issue_no,
                user=user, warehouse_id=issue.warehouse_id,
                bin_id=line.bin_id or m.NO_BIN, batch_id=line.batch_id or m.NO_BATCH,
                project_id=issue.project_id or 0,
            )

    await _mark_serials(db, issue, outward)
    if not outward and issue.original_issue_id:
        original = await get_issue(db, issue.original_issue_id)
        _apply_issue_return(issue, original)

    issue.is_stock_posted = True
    issue.posted_at = utcnow()
    issue.issued_by_id = getattr(user, "id", None)
    issue.issued_by_name = _name(user)
    issue.status = IssueStatus.ISSUED.value
    issue.qc_status = QcStatus.PENDING.value if needs_qc else QcStatus.NOT_REQUIRED.value

    if needs_qc and outward:
        await _raise_outbound_inspection_for(db, issue, user)

    if outward:
        await _raise_picking_for_issue(db, issue, user)

    await write_audit(db, entity="out_issues", entity_id=issue.id, entity_no=issue.issue_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"is_stock_posted": False},
                      after={"is_stock_posted": True, "status": issue.status,
                             "qc_status": issue.qc_status,
                             "total_qty": str(issue.total_qty)})
    await db.commit()
    return await get_issue(db, issue_id)


def _validate_issue_return(issue: m.MaterialIssue, original: m.MaterialIssue) -> None:
    """Cap an inbound return at what remains outstanding on the original issue."""
    if issue.warehouse_id != original.warehouse_id:
        raise ValidationError(
            f"Return the material to {original.warehouse_name or 'the issuing warehouse'}"
        )
    outstanding: dict[int, Decimal] = {}
    for line in original.items:
        outstanding[line.item_id] = (
            outstanding.get(line.item_id, ZERO)
            + _d(line.issued_qty)
            - _d(line.returned_qty)
        )
    returning: dict[int, Decimal] = {}
    for line in issue.items:
        returning[line.item_id] = returning.get(line.item_id, ZERO) + _d(line.issued_qty)
    for item_id, qty in returning.items():
        allowed = outstanding.get(item_id, ZERO)
        if qty > allowed:
            raise ValidationError(
                f"Item {item_id}: only {allowed} remains returnable against "
                f"{original.issue_no}; cannot return {qty}."
            )


def _validate_picking_issue(issue: m.MaterialIssue, picking: m.Picking) -> None:
    picked: dict[tuple[int, int, int], Decimal] = {}
    for line in picking.items:
        key = (line.item_id, line.bin_id or 0, line.batch_id or 0)
        picked[key] = picked.get(key, ZERO) + _d(line.picked_qty)
    issuing: dict[tuple[int, int, int], Decimal] = {}
    for line in issue.items:
        key = (line.item_id, line.bin_id or 0, line.batch_id or 0)
        issuing[key] = issuing.get(key, ZERO) + _d(line.issued_qty)
    for key, qty in issuing.items():
        if qty > picked.get(key, ZERO):
            raise ValidationError(
                f"Item {key[0]}: issue quantity {qty} exceeds the {picked.get(key, ZERO)} "
                f"picked on {picking.pick_no}."
            )


def _apply_issue_return(issue: m.MaterialIssue, original: m.MaterialIssue) -> None:
    """Apply posted inbound quantities to the original issue's accountability."""
    for returned in issue.items:
        remaining = _d(returned.issued_qty)
        for original_line in original.items:
            if original_line.item_id != returned.item_id or remaining <= ZERO:
                continue
            open_qty = _d(original_line.issued_qty) - _d(original_line.returned_qty)
            take = min(open_qty, remaining)
            original_line.returned_qty = _d(original_line.returned_qty) + take
            remaining -= take

    fully_returned = all(
        _d(line.returned_qty) >= _d(line.issued_qty) for line in original.items
    )
    original.status = (
        IssueStatus.RETURNED.value
        if fully_returned
        else IssueStatus.PARTIALLY_RETURNED.value
    )


def _shipped_unit_marker(doc: str, doc_id: int) -> str:
    """The remark that ties a unit to the document currently carrying it.

    A unit in flight belongs to exactly one document, and this string is the link.
    `credit_arrival` reads it back at the far end to know which units to shelve.
    """
    return f"Issued by {doc} {doc_id}"


#: Remarks that mean "this unit is already spoken for by another document". A unit
#: carrying one of these must never be auto-picked for a second one.
_CLAIMED_REMARK_PREFIXES = ("Reserved for issue ", "Issued by ")


async def _claim_units(
    db: AsyncSession,
    *,
    item_id: int,
    warehouse_id: int,
    qty,
    marker: str,
    batch_id: int | None = None,
    bin_id: int | None = None,
    top_up: bool = True,
) -> list[m.SerialNumber]:
    """Reserve up to `qty` of this item's units at this warehouse under `marker`.

    Rows already carrying `marker` are counted first — those are the ones the
    storekeeper picked by hand on the issue screen, and his choice always stands. The
    shortfall is topped up FIFO (oldest row id first) from what is free at that
    warehouse, skipping anything another document has already claimed.

    BEST EFFORT BY DESIGN. It returns fewer rows than asked rather than raising when
    the warehouse holds fewer coded units than the quantity being shipped, which is
    the normal case for stock that predates unit coding and for bulk goods that never
    had units at all. A missing identity row must never stop real goods from moving —
    the quantity is the stock record, the unit row is a label on it. Callers that DO
    require a complete set (serial-tracked items) check the count themselves.
    """
    wanted = int(_d(qty))
    if wanted <= 0:
        return []

    def _scoped(stmt):
        stmt = stmt.where(
            m.SerialNumber.item_id == item_id,
            m.SerialNumber.warehouse_id == warehouse_id,
            m.SerialNumber.is_active.is_(True),
        )
        # Only narrow by batch/bin when the document actually named one. A line that
        # names neither means "whatever is on the shelf", exactly as move_stock_out
        # reads an unspecified bin.
        if batch_id:
            stmt = stmt.where(m.SerialNumber.batch_id == batch_id)
        if bin_id:
            stmt = stmt.where(m.SerialNumber.bin_id == bin_id)
        return stmt

    mine = list((await db.execute(
        _scoped(select(m.SerialNumber)).where(
            m.SerialNumber.status == SerialStatus.AVAILABLE.value,
            m.SerialNumber.remarks == marker,
        ).order_by(m.SerialNumber.id).with_for_update()
    )).scalars().all())
    if len(mine) >= wanted or not top_up:
        # `top_up=False` is how a serialized item says "the scanned set is the set".
        # Which physical serial left the building is a fact the storekeeper establishes
        # by reading the label, never something this function may decide for him.
        return mine[:wanted]

    free = (await db.execute(
        _scoped(select(m.SerialNumber)).where(
            m.SerialNumber.status == SerialStatus.AVAILABLE.value,
            # AND of the negations, not OR: "Reserved for issue 5" does not start with
            # "Issued by ", so an OR here would have declared every claimed unit free
            # and handed the same code to two documents.
            or_(m.SerialNumber.remarks.is_(None),
                and_(*[~m.SerialNumber.remarks.startswith(prefix)
                       for prefix in _CLAIMED_REMARK_PREFIXES])),
        ).order_by(m.SerialNumber.id)
        .limit(wanted - len(mine))
        .with_for_update()
    )).scalars().all()
    for row in free:
        row.remarks = marker
        mine.append(row)
    return mine


async def _land_units(
    db: AsyncSession,
    *,
    markers: tuple[str, ...],
    item_id: int,
    qty,
    to_warehouse_id: int,
    ref_no: str | None,
) -> list[str]:
    """Shelve the units a consignment carried at the point that received it.

    THE missing half of the unit's journey. `_place_unit_codes` mints a unit at the
    warehouse that first receives the goods and deliberately never mints another one
    downstream — "what an MDP or a LIP inwards is that same unit arriving, already
    carrying its code". Nothing ever moved it, so every unit row in the database sat
    at the warehouse that received it while the quantity it names had long since been
    shipped on. An MDP showed five units of stock and a dash where their codes belong,
    and the source warehouse could pick the same code again the next morning.

    The unit is re-homed, not copied: one physical thing, one row, one code, moving
    from shelf to shelf. `bin_id` is cleared because a stocking point has no bins —
    that is what makes it a stocking point — and the row must key as bulk to sit
    beside the `stk_balance` row the same arrival creates.

    Returns the codes it shelved, so the caller can name them on the ledger row.
    """
    wanted = int(_d(qty))
    if wanted <= 0:
        return []
    rows = (await db.execute(
        select(m.SerialNumber).where(
            m.SerialNumber.item_id == item_id,
            m.SerialNumber.status == SerialStatus.ISSUED.value,
            m.SerialNumber.remarks.in_(markers),
            m.SerialNumber.is_active.is_(True),
        ).order_by(m.SerialNumber.id).limit(wanted).with_for_update()
    )).scalars().all()

    item = await db.get(Item, item_id)
    mode = _unit_mode(item)
    codes: list[str] = []
    for row in rows:
        row.warehouse_id = to_warehouse_id
        row.bin_id = None
        row.status = SerialStatus.AVAILABLE.value
        row.remarks = f"Received by {ref_no}" if ref_no else None
        keys = _unit_keys(row, mode)
        if keys:
            codes.append(keys[0])
    await db.flush()
    return codes


async def _ship_units(
    db: AsyncSession,
    *,
    item_id: int,
    warehouse_id: int,
    qty,
    marker: str,
    batch_id: int | None = None,
) -> list[str]:
    """Claim units and send them out the gate in one step, returning their codes.

    For the door where there is no issue to hang them on — a consignment raised and
    gated out directly. `post_issue` keeps the two steps apart instead, because it has
    to name the units on its ledger rows before `_mark_serials` flips them.
    """
    rows = await _claim_units(
        db, item_id=item_id, warehouse_id=warehouse_id, qty=qty,
        marker=marker, batch_id=batch_id,
    )
    item = await db.get(Item, item_id)
    mode = _unit_mode(item)
    codes: list[str] = []
    for row in rows:
        row.status = SerialStatus.ISSUED.value
        row.remarks = marker
        keys = _unit_keys(row, mode)
        if keys:
            codes.append(keys[0])
    await db.flush()
    return codes


async def _claim_issue_units(
    db: AsyncSession,
    issue: m.MaterialIssue,
) -> dict[int, list[str]]:
    """Reserve the units each outward line is about to ship, and name them.

    The storekeeper's own picks are already stamped by `_reserve_issue_serials` when
    he scans them on the issue screen; this tops the line up to its full issued
    quantity from what is free at the warehouse. Most lines name nothing at all — a
    consolidated fulfilment draft is created for the storekeeper by inventory, which
    approves quantities and has no screen on which to say which physical units — and
    those lines are exactly the ones that used to ship with their codes left behind.

    Returns `{line_id: [code, ...]}` in the currency the item names its units with, for
    the ledger rows the caller is about to write.
    """
    claimed: dict[int, list[str]] = {}
    for line in issue.items:
        qty = _d(line.issued_qty)
        if qty <= ZERO:
            continue
        item = await _item_snapshot(db, line.item_id)
        mode = _unit_mode(item)
        rows = await _claim_units(
            db,
            item_id=line.item_id,
            warehouse_id=issue.warehouse_id,
            qty=qty,
            marker=_issue_serial_marker(issue.id),
            batch_id=line.batch_id or None,
            bin_id=line.bin_id or None,
            # A serialized line ships exactly the serials the storekeeper scanned.
            # `post_issue` has already refused the issue unless he captured one per
            # unit, so there is never a shortfall here worth guessing at.
            top_up=(mode != UNIT_MODE_SERIAL),
        )
        codes = [keys[0] for keys in
                 (_unit_keys(row, mode) for row in rows) if keys]
        if codes:
            claimed[line.id] = codes
    await db.flush()
    return claimed


async def _mark_serials(db: AsyncSession, issue: m.MaterialIssue, outward: bool) -> None:
    """Flips the status of the units leaving or coming back with an issue.

    Runs for EVERY item that names its units, not just serial-tracked ones. It used
    to skip anything without `is_serial_tracked`, which meant a coded consumable's
    units stayed `available` at the source warehouse after they had physically left —
    so the picker offered the same code again on the next issue. The set is still only
    ENFORCED for serial-tracked items, where the storekeeper is required to capture
    one serial per unit; a coded item takes what units it has.
    """
    new_status = (SerialStatus.ISSUED if outward else SerialStatus.RETURNED).value
    from_status = (SerialStatus.AVAILABLE if outward else SerialStatus.ISSUED).value
    marker = _issue_serial_marker(issue.id)

    for line in issue.items:
        item = await _item_snapshot(db, line.item_id)
        wanted = int(_d(line.issued_qty))
        if wanted <= 0:
            continue
        rows = (await db.execute(
            select(m.SerialNumber).where(
                m.SerialNumber.item_id == line.item_id,
                m.SerialNumber.warehouse_id == issue.warehouse_id,
                m.SerialNumber.status == from_status,
                m.SerialNumber.remarks == marker,
                m.SerialNumber.is_active.is_(True))
            .with_for_update()
        )).scalars().all()
        if item.is_serial_tracked and len(rows) != wanted:
            raise ValidationError(
                f"{line.item_code or line.item_id}: {wanted} serials are required, "
                f"but {len(rows)} are reserved for this issue"
            )
        for row in rows[:wanted]:
            row.status = new_status
            row.remarks = (
                _shipped_unit_marker("issue", issue.id)
                if outward
                else f"Returned by issue {issue.id}"
            )
    await db.flush()


async def _dispatch_for_issue(db: AsyncSession, issue_id: int) -> m.Dispatch | None:
    """The consignment carrying this issue, if one was ever raised for it."""
    # Eager-loaded: `acknowledge_issue` books delivered quantities onto these lines,
    # and a lazy load on an async session raises MissingGreenlet.
    return (await db.execute(
        select(m.Dispatch).options(selectinload(m.Dispatch.items)).where(
            m.Dispatch.ref_type == WarehouseDocType.WH_ISSUE.value,
            m.Dispatch.ref_id == issue_id,
            m.Dispatch.status != DispatchStatus.CANCELLED.value,
        ).limit(1)
    )).scalar_one_or_none()


async def _close_indents_on_issue(db: AsyncSession, issue: m.MaterialIssue, user) -> None:
    """Close every indent this issue served, not just the one on its header.

    An issue that covers a consolidated batch names one indent on the header and the
    rest on its lines. Closing only the header's would leave the other requesters'
    indents sitting at ALLOCATED forever, with the goods already in their hands. For a
    single-indent issue this is the same one call it always was.
    """
    for indent_id in await _indent_ids_on_issue(db, issue):
        await _close_indent_if_delivered(db, indent_id, user)


async def _close_indent_if_delivered(db: AsyncSession, indent_id: int | None, user) -> None:
    """Move the indent on once everything issued against it has been received.

    Acknowledgement used to stop at the issue: the indent behind it sat at
    ALLOCATED forever, so nothing on any screen ever showed a request as finished.
    An indent is only closed when no live issue against it is still outstanding AND
    nothing is still owed on it.
    """
    if not indent_id:
        return
    from app.modules.indents.models import Indent
    indent = await db.get(Indent, indent_id)
    if indent is None or indent.status in (
        IndentStatus.CLOSED.value, IndentStatus.REJECTED.value,
    ):
        return
    outstanding = await db.scalar(
        select(func.count(m.MaterialIssue.id)).where(
            m.MaterialIssue.indent_id == indent_id,
            m.MaterialIssue.direction == IssueDirection.OUT.value,
            m.MaterialIssue.status.notin_(
                (*DEAD_ISSUE_STATUSES, IssueStatus.ACKNOWLEDGED.value)
            ),
        )
    )
    if outstanding:
        return

    # A part-served indent is not finished just because the issue carrying that part
    # was acknowledged. An approver who gives 13 of the 20 asked for leaves 7 owed, and
    # that remainder still has to reach the Fulfilment Queue for a second allocation.
    # Closing ended it instead: CLOSED is not in `_ALLOCATION_ELIGIBLE_STATUSES`, so
    # the allocate screen answered "this indent is closed — there is nothing to
    # allocate" and the 7 was lost with the first 13 already in the requester's hands.
    #
    # Only the closing is withheld. The status the allocation path already set
    # (PARTIALLY_FULFILLED, or PENDING_APPROVAL while the remainder is still climbing)
    # is left exactly as it is — both are allocation-eligible and both already list in
    # the queue, so the remainder rejoins the ordinary flow with nothing else touched.
    #
    # `_committed_by_line` is the same arithmetic `list_indents(has_remainder=True)`
    # runs, so the queue and this check can never disagree about whether a request is
    # finished.
    from app.modules.indents.models import IndentItem
    from app.modules.indents.service import _committed_by_line, owed_quantity

    committed = await _committed_by_line(db, indent_id)
    owed_lines = (await db.execute(
        select(IndentItem).where(IndentItem.indent_id == indent_id)
    )).scalars().all()
    # "And something actually covers it", the same half `approvals.service._nothing_owed`
    # carries and for the same reason: an indent issued without ever passing through an
    # allocation has 0 allocated against a full approved quantity, which reads as
    # entirely unserved. Those close on the acknowledgement exactly as they always did —
    # the remainder guard below only speaks for indents the allocation flow has touched.
    covered = sum(
        (_d(line.allocated_quantity) + committed.get(line.id, ZERO)
         for line in owed_lines),
        ZERO,
    )
    if covered > ZERO and any(
        owed_quantity(line) - _d(line.allocated_quantity)
        - committed.get(line.id, ZERO) > ZERO
        for line in owed_lines
    ):
        return

    before_status = indent.status
    indent.status = IndentStatus.CLOSED.value
    await write_audit(db, entity="ind_indents", entity_id=indent.id,
                      entity_no=indent.indent_no, action=AuditAction.UPDATE, actor=user,
                      before={"status": before_status},
                      after={"status": indent.status})


async def _apply_issue_acknowledgement(db: AsyncSession, issue: m.MaterialIssue,
                                       by_name: str | None, remarks: str | None,
                                       user) -> None:
    """Sign the issue off and carry the signature onto what it was attached to.

    Does not commit and writes no audit row: both callers are mid-transaction and own
    their own audit trail.
    """
    issue.status = IssueStatus.ACKNOWLEDGED.value
    issue.acknowledged_by_name = by_name
    issue.acknowledged_at = utcnow()
    if remarks:
        issue.remarks = f"{issue.remarks or ''}\nReceiver: {remarks}".strip()

    # The receiver signs once. Leaving the consignment at DISPATCHED afterwards
    # made the dispatch board disagree with the issue it was carrying, and no
    # dispatch in the live data ever reached acknowledged_at.
    dispatch = await _dispatch_for_issue(db, issue.id)
    if dispatch is not None and dispatch.status in (
        DispatchStatus.DISPATCHED.value, DispatchStatus.IN_TRANSIT.value,
        DispatchStatus.DELIVERED.value,
    ):
        dispatch.status = DispatchStatus.ACKNOWLEDGED.value
        dispatch.acknowledged_by_name = issue.acknowledged_by_name
        dispatch.acknowledged_at = issue.acknowledged_at
        dispatch.delivered_at = dispatch.delivered_at or issue.acknowledged_at
        # The requester has already confirmed every quantity carried by this issue
        # (_receiver_confirmed is the caller's guard). Keep the linked consignment's
        # line evidence in sync when the warehouse signs off through the issue page —
        # without it `out_dispatch_items.delivered_qty` stays 0 forever, and the
        # Journey's Delivery phase sits PENDING on an indent that is already closed.
        for line in dispatch.items:
            line.delivered_qty = _d(line.quantity)

    # Signing here is the same physical event as signing on the consignment screen, so
    # it owes the same inward movement. Without this the LIP storekeeper confirmed his
    # delivery through the indent page, the issue and the consignment both read
    # ACKNOWLEDGED, and his inventory stayed empty — the goods in his hands existed on
    # no shelf in the system. Runs for a consignment that was ALREADY acknowledged too
    # (the `if` above only re-stamps the in-transit ones): `credit_arrival` is
    # idempotent on the ledger, so the credit lands exactly once whichever door ran first.
    if dispatch is not None:
        await credit_arrival(db, dispatch, user)

    await _close_indents_on_issue(db, issue, user)


async def auto_acknowledge_for_indent(db: AsyncSession, indent_id: int,
                                      user, *, condition: str | None = None,
                                      remarks: str | None = None,
                                      fully_received: bool = False) -> list[str]:
    """Sign off every open issue serving this indent that the raiser has now confirmed.

    The warehouse used to click Acknowledge a second time after the requester had
    already recorded what reached them in Acknowledgements — the same fact, entered
    twice, with the indent sitting open until somebody remembered the second click.
    `_receiver_confirmed` was always the real test, so the moment it passes the issue
    signs itself off in the requester's name.

    Called from `indents.acknowledge_receipt` inside its transaction, so this neither
    commits nor audits: the receipt that made the confirmation true and the
    acknowledgement it triggers have to land together or not at all. Returns the issue
    numbers it closed, for the caller's audit row.
    """
    from app.modules.indents.models import IndentItem

    line_issues = select(m.MaterialIssueLine.issue_id).join(
        IndentItem, IndentItem.id == m.MaterialIssueLine.indent_item_id
    ).where(IndentItem.indent_id == indent_id)

    # Eager-loaded: `_receiver_confirmed` walks `issue.items`, and a lazy load on an
    # async session raises MissingGreenlet.
    issues = (await db.execute(
        select(m.MaterialIssue)
        .options(selectinload(m.MaterialIssue.items))
        .where(
            m.MaterialIssue.status.in_(
                (IssueStatus.ISSUED.value, IssueStatus.DISPATCHED.value)),
            or_(m.MaterialIssue.indent_id == indent_id,
                m.MaterialIssue.id.in_(line_issues)),
        )
    )).scalars().all()

    signed: list[str] = []
    for issue in issues:
        # A consolidated issue serves several indents. Only the one whose raiser has
        # confirmed everything it carried is settled — the rest keep it open.
        if not await _receiver_confirmed(db, issue):
            continue
        await _apply_issue_acknowledgement(db, issue, _name(user), None, user)
        signed.append(issue.issue_no)

    signed += await _sign_transport_for_indent(
        db, indent_id, user, condition=condition, remarks=remarks,
        fully_received=fully_received)
    return signed


async def _sign_transport_for_indent(db: AsyncSession, indent_id: int, user, *,
                                     condition: str | None = None,
                                     remarks: str | None = None,
                                     fully_received: bool = False) -> list[str]:
    """Close the outward legs behind an indent its raiser has just confirmed.

    The requester saying "it reached me" is the same signature the logistics
    Acknowledgements desk takes, so a leg still reading in transit after it would
    leave the transport register disagreeing with the indent it was carrying —
    a shipment on the road against goods already in someone's hands.

    Stamped here rather than by calling `transport.acknowledge_tr`: the consignment,
    the issue and the indent were all settled by `_apply_issue_acknowledgement` on the
    way in, and re-entering through the transport service would run that cascade a
    second time. Neither commits — the caller owns the transaction.
    """
    from app.modules.logistics.enums import (
        AWAITING_ACK_STATUSES, SIGNABLE_STATUSES, AckCondition, TransportStatus,
    )
    from app.modules.logistics.models import TransportRequest

    # Not "everything still open". Receipts accumulate (see `acknowledge_receipt`: six
    # today, four next week), so this runs on EVERY partial acknowledgement, not just
    # the last one, and reaching too far back closes a leg that is still carrying goods.
    # DRAFT, PENDING_APPROVAL, QUOTING and AWAITING_CARRIER are never in either set —
    # a live tender signed off here would vanish out of the carriers' portals mid-bid.
    #
    # READY is the one rung that depends on how much arrived, and that distinction is
    # this integration's, not the branch's. READY means settled and sitting in the yard,
    # NOT dispatched. On a partial receipt a READY leg is very often the one carrying
    # the rest of the order, and signing it would mark undelivered material as received.
    # Once every line has been received there is nothing left for such a leg to carry,
    # so READY there is a departure nobody pressed the button for — which is exactly the
    # case `SIGNABLE_STATUSES` was widened for (a third-party leg tracked from the
    # carrier's own portal). Full receipt gets the wide set, a partial one gets the legs
    # that have demonstrably left.
    signable = SIGNABLE_STATUSES if fully_received else AWAITING_ACK_STATUSES
    legs = (await db.execute(
        select(TransportRequest)
        .options(selectinload(TransportRequest.items))
        .where(TransportRequest.indent_id == indent_id,
               TransportRequest.status.in_(signable))
    )).scalars().all()

    # The requester's word on the state of the goods, mapped onto logistics' own enum.
    # Absent (or GOOD) keeps the previous behaviour exactly: the leg closes clean.
    reported = (condition or AckCondition.GOOD.value).strip().upper()

    now = utcnow()
    who = _name(user) or "the requester"
    for leg in legs:
        # A leg signed for straight out of READY never had its departure recorded —
        # nobody pressed "it has left". The goods are in the requester's hands, so it
        # plainly went; stamping it keeps the shipment from reading as delivered on a
        # date it was never dispatched. The consignment and the issue behind it are
        # settled by `_apply_issue_acknowledgement` on the way in, which is why this
        # does not fire the release hook and run that cascade a second time.
        leg.dispatched_at = leg.dispatched_at or now
        leg.delivered_at = leg.delivered_at or now
        leg.status = TransportStatus.ACKNOWLEDGED.value
        leg.acknowledged_at = now
        leg.acknowledged_by_id = getattr(user, "id", None)
        leg.acknowledged_by_name = _name(user)
        leg.ack_condition = leg.ack_condition or reported
        leg.ack_remarks = leg.ack_remarks or remarks
        for line in leg.items:
            if not line.delivered_qty:
                line.delivered_qty = line.quantity
        _stamp_receipt_scans(leg, who, now)
        await write_audit(db, entity="lgs_transport_requests", entity_id=leg.id,
                          entity_no=leg.tr_no, action=AuditAction.UPDATE, actor=user,
                          after={"status": leg.status},
                          summary=(f"{_name(user) or 'The requester'} confirmed "
                                   f"{leg.tr_no} on the indent"))

    await _raise_receipt_claim(db, legs, reported, remarks, user)
    await _close_signed_legs(db, legs, user)
    return [leg.tr_no for leg in legs]


async def _close_signed_legs(db: AsyncSession, legs: list, user) -> None:
    """Take the acknowledged leg its last rung, to CLOSED.

    ACKNOWLEDGED was where the requester's receipt left every leg, whatever the mode,
    and the cycle then waited on a logistics desk pressing "Close shipment" — a
    keystroke that adds no fact. The signature IS the end of the leg: the goods are in
    the requester's hands, the consignment and the issue behind it are settled and the
    indent has closed. Nothing was left for that press to decide, and a queue of
    shipments needing it is a queue nobody works.

    The one thing it DID decide is kept, and it is the same rule `transport.close_tr`
    has always run on: an open claim holds the leg. A receipt reporting SHORT or
    DAMAGED raises one just above (`_raise_receipt_claim`), so those legs stay
    ACKNOWLEDGED with the desk's Close button still on them — the claim is settled
    with the provider before the shipment is done with. Closing around an unsettled
    claim would file the only document it is investigated from.

    Stamped rather than routed through `close_tr`: that call commits, and this runs
    inside the acknowledgement's transaction (rule 9 — the receipt and everything it
    settles land together or not at all).
    """
    from app.modules.logistics.enums import TransportStatus

    for leg in legs:
        if any(event.is_exception and event.resolved_at is None
               for event in leg.events):
            continue
        leg.status = TransportStatus.CLOSED.value
        await write_audit(db, entity="lgs_transport_requests", entity_id=leg.id,
                          entity_no=leg.tr_no, action=AuditAction.UPDATE, actor=user,
                          after={"status": leg.status},
                          summary=(f"{leg.tr_no} closed — "
                                   f"{_name(user) or 'the requester'} signed for it "
                                   f"on {leg.indent_no or 'the indent'}"))


def _stamp_receipt_scans(leg, who: str, now) -> None:
    """Put the requester's receipt on the shipment's own tracking timeline.

    The signature already moved the STATUS to ACKNOWLEDGED, but Tracking is read from
    `lgs_shipment_events` alone, so a leg whose goods were in someone's hands still
    showed "Out for delivery" as its last scan — the panel disagreeing with the header
    above it. The receipt is the arrival, so it is recorded as one.

    Two rows, not one: DELIVERED is stamped only when nothing ever recorded the
    arrival (a leg signed straight out of READY or IN_TRANSIT, where nobody pressed
    "it landed"), and ACKNOWLEDGED always, because who signed and when is the fact the
    Exceptions desk reads back. A leg the carrier already marked delivered keeps its
    own scan with its own timestamp; this never overwrites custody evidence.
    """
    from app.modules.logistics.enums import ShipmentEventType
    from app.modules.logistics.models import ShipmentEvent

    types = {event.event_type for event in leg.events}
    if ShipmentEventType.DELIVERED.value not in types:
        leg.events.append(ShipmentEvent(
            event_type=ShipmentEventType.DELIVERED.value,
            event_at=leg.delivered_at or now,
            location_name=leg.to_location_name,
            description=f"Reached {who}",
        ))
    if ShipmentEventType.ACKNOWLEDGED.value not in types:
        leg.events.append(ShipmentEvent(
            event_type=ShipmentEventType.ACKNOWLEDGED.value, event_at=now,
            location_name=leg.to_location_name,
            description=(f"{who} confirmed receipt on "
                         f"{leg.indent_no or 'the indent'}"),
            recorded_by_id=leg.acknowledged_by_id,
            recorded_by_name=leg.acknowledged_by_name,
        ))


async def _raise_receipt_claim(db: AsyncSession, legs: list, condition: str,
                               remarks: str | None, user) -> None:
    """Damage reported on an indent receipt, opened as a claim on the shipment.

    ONE claim, not one per leg. A requester reports on the delivery in front of them,
    not on the transport paperwork behind it, so an indent served by three legs would
    otherwise open three identical claims for one damaged carton and leave the
    Exceptions desk reconciling them. It lands on the most recently dispatched leg —
    the one the goods most likely came on — and the remarks travel with it, which is
    what the desk actually investigates from.

    DIRECT and OWN_VEHICLE have no carrier, so there is nobody to claim against. The
    damage is still recorded, because the Exceptions desk wants to know a delivery
    arrived broken whoever was driving; it is simply not called a carrier claim.
    """
    from app.modules.logistics.enums import (
        ACK_CLAIM_EVENT, AckCondition, ShipmentEventType, TransportMode,
    )
    from app.modules.logistics.models import ShipmentEvent

    claim_type = ACK_CLAIM_EVENT.get(condition)
    if not legs or condition == AckCondition.GOOD.value or not claim_type:
        return

    target = max(legs, key=lambda leg: (leg.dispatched_at or leg.id, leg.id))
    in_house = target.mode in (TransportMode.DIRECT.value,
                               TransportMode.OWN_VEHICLE.value)
    against = (target.carrier_name if not in_house and target.carrier_name
               else None)
    who = _name(user) or "The requester"
    target.events.append(ShipmentEvent(
        event_type=claim_type, event_at=utcnow(),
        location_name=target.to_location_name,
        description=(f"{who} reported damage on the indent receipt"
                     + (f" — claim against {against}" if against
                        else " — delivered in house, no carrier to claim against")
                     + (f": {remarks}" if remarks else "")),
        is_exception=True,
        recorded_by_id=getattr(user, "id", None),
        recorded_by_name=who,
    ))


async def acknowledge_issue(db: AsyncSession, issue_id: int, remarks: str | None,
                            user) -> m.MaterialIssue:
    issue = await get_issue(db, issue_id)
    # DISPATCHED is the same open state as ISSUED — gate-out only records that the
    # goods left the gate, the receiver still has to acknowledge them.
    _guard(issue.status, {IssueStatus.ISSUED.value, IssueStatus.DISPATCHED.value},
           "acknowledge", "issue")
    # Hiding the button is not the control (rule 6) — the raiser's confirmation is.
    if not await _receiver_confirmed(db, issue):
        raise ValidationError(
            f"{issue.issue_no} has not been confirmed by the requester yet. They "
            "record what reached them in Acknowledgements; this signs off on that.")
    before_status = issue.status
    await _apply_issue_acknowledgement(db, issue, _name(user), remarks, user)

    await write_audit(db, entity="out_issues", entity_id=issue.id, entity_no=issue.issue_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": before_status},
                      after={"status": issue.status})
    await db.commit()
    return await get_issue(db, issue_id)


async def cancel_issue(db: AsyncSession, issue_id: int, reason: str | None, user) -> m.MaterialIssue:
    issue = await get_issue(db, issue_id)
    if issue.is_stock_posted:
        raise ValidationError(
            f"{issue.issue_no} has already left the store. Raise a return against it "
            "instead — cancelling would leave the stock unaccounted for.")
    _guard(issue.status,
           {IssueStatus.DRAFT.value, IssueStatus.PENDING_APPROVAL.value,
            IssueStatus.APPROVED.value, IssueStatus.REJECTED.value},
           "cancel", "issue")

    before = {"status": issue.status}
    issue.status = IssueStatus.CANCELLED.value
    issue.current_approver_name = None
    issue.remarks = f"{issue.remarks or ''}\nCancelled: {reason or '—'}".strip()

    # Withdrawing the document has to withdraw the approval behind it. Without
    # this the engine kept handing the task out: WHI/2026-27/00027 sat CANCELLED
    # in an approver's queue for two days with no decision left to make.
    await engine.abandon(db, await _issue_doc_type_of(db, issue.id), issue.id, user,
                         reason=reason or "Issue cancelled")

    await _clear_issue_serial_reservations(db, issue.id)
    await write_audit(db, entity="out_issues", entity_id=issue.id, entity_no=issue.issue_no,
                      action=AuditAction.UPDATE, actor=user, before=before,
                      after={"status": issue.status, "reason": reason})
    await db.commit()
    return await get_issue(db, issue_id)


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

def _dispatch_totals(dispatch: m.Dispatch) -> None:
    lines = dispatch.items
    dispatch.total_items = len(lines)
    dispatch.total_qty = sum((_d(l.quantity) for l in lines), ZERO)
    dispatch.total_value = sum((_d(l.amount) for l in lines), ZERO)
    dispatch.total_packages = len(dispatch.packages)
    dispatch.total_weight_kg = sum((_d(p.weight_kg) for p in dispatch.packages), ZERO)


def _validate_issue_dispatch(dispatch: m.Dispatch, issue: m.MaterialIssue) -> None:
    issued: dict[int, Decimal] = {}
    for line in issue.items:
        issued[line.item_id] = issued.get(line.item_id, ZERO) + _d(line.issued_qty)
    dispatched: dict[int, Decimal] = {}
    for line in dispatch.items:
        dispatched[line.item_id] = dispatched.get(line.item_id, ZERO) + _d(line.quantity)
    for item_id, qty in dispatched.items():
        if qty > issued.get(item_id, ZERO):
            raise ValidationError(
                f"Item {item_id}: dispatch quantity {qty} exceeds the "
                f"{issued.get(item_id, ZERO)} posted on {issue.issue_no}."
            )


async def _apply_dispatch_lines(db: AsyncSession, dispatch: m.Dispatch,
                                lines: list[s.DispatchItemWrite]) -> None:
    dispatch.items.clear()
    await db.flush()

    for index, line in enumerate(lines, start=1):
        item = await _item_snapshot(db, line.item_id)
        qty = _d(line.quantity)
        if qty <= ZERO:
            raise ValidationError(f"Line {index}: quantity must be positive")
        batch = await db.get(m.Batch, line.batch_id) if line.batch_id else None
        rate = _d(line.rate)
        dispatch.items.append(m.DispatchItem(
            line_no=index, package_id=line.package_id, indent_id=line.indent_id,
            item_id=item.id, item_code=item.code, item_name=item.name, uom_code=item.uom_code,
            # 0, not NULL — out_dispatch_items.batch_id is NOT NULL DEFAULT 0 live.
            batch_id=line.batch_id or m.NO_BATCH,
            batch_no=batch.batch_no if batch else None,
            serial_no=line.serial_no,
            quantity=qty, delivered_qty=ZERO,
            rate=rate or None, amount=(qty * rate) if rate else None,
            remarks=line.remarks,
        ))
    _dispatch_totals(dispatch)


def _issue_qty_by_item_batch(issue: m.MaterialIssue) -> dict[tuple[int, int], Decimal]:
    issued: dict[tuple[int, int], Decimal] = {}
    for line in issue.items:
        key = (line.item_id, line.batch_id or m.NO_BATCH)
        issued[key] = issued.get(key, ZERO) + _d(line.issued_qty)
    return issued


def _issue_serial_markers(issue_id: int) -> tuple[str, str]:
    return (_issue_serial_marker(issue_id), f"Issued by issue {issue_id}")


async def _issued_serial_index(
    db: AsyncSession,
    issue: m.MaterialIssue,
) -> dict[str, m.SerialNumber]:
    rows = (await db.execute(
        select(m.SerialNumber).where(
            m.SerialNumber.warehouse_id == issue.warehouse_id,
            m.SerialNumber.status == SerialStatus.ISSUED.value,
            m.SerialNumber.remarks.in_(_issue_serial_markers(issue.id)),
            m.SerialNumber.is_active.is_(True),
        )
    )).scalars().all()
    index = {}
    for row in rows:
        if row.serial_number:
            index[row.serial_number.lower()] = row
        if row.asset_code:
            index[row.asset_code.lower()] = row
        if row.consumable_code:
            index[row.consumable_code.lower()] = row
    return index


async def _issue_available_qty_and_serials(
    db: AsyncSession,
    issue: m.MaterialIssue
) -> tuple[dict[tuple[int, int], Decimal], dict[str, m.SerialNumber]]:
    issued_qty = _issue_qty_by_item_batch(issue)
    issued_serials = await _issued_serial_index(db, issue)
    
    if issue.qc_status in (QcStatus.PASSED.value, QcStatus.PARTIAL.value):
        inspection = (await db.execute(
            select(m.OutboundInspection).where(
                m.OutboundInspection.issue_id == issue.id,
                m.OutboundInspection.status == InspectionStatus.COMPLETED.value
            ).order_by(m.OutboundInspection.id.desc()).limit(1)
        )).scalar_one_or_none()
        
        if inspection:
            accepted_qty: dict[tuple[int, int], Decimal] = {}
            accepted_serials: set[str] = set()
            
            items = (await db.execute(
                select(m.OutboundInspectionItem, m.MaterialIssueLine.batch_id)
                .join(m.MaterialIssueLine, m.OutboundInspectionItem.issue_item_id == m.MaterialIssueLine.id)
                .where(m.OutboundInspectionItem.inspection_id == inspection.id)
            )).all()
            
            for insp_item, batch_id in items:
                key = (insp_item.item_id, batch_id or m.NO_BATCH)
                accepted_qty[key] = accepted_qty.get(key, ZERO) + _d(insp_item.accepted_qty)
                
                serials_data = insp_item.serial_numbers
                if serials_data:
                    if isinstance(serials_data, dict):
                        passed_list = serials_data.get("accepted", [])
                    elif isinstance(serials_data, list):
                        passed_list = serials_data
                    else:
                        passed_list = []
                    for s in passed_list:
                        accepted_serials.add(s.lower())
                else:
                    for s_key, s_row in issued_serials.items():
                        if s_row.item_id == insp_item.item_id and (not batch_id or s_row.batch_id == batch_id):
                            accepted_serials.add(s_key.lower())
                    
            issued_qty = accepted_qty
            issued_serials = {k: v for k, v in issued_serials.items() if k in accepted_serials}
            
    return issued_qty, issued_serials


async def _apply_consignment_packages(
    db: AsyncSession,
    dispatch: m.Dispatch,
    issue: m.MaterialIssue,
    packages: list[s.ConsignmentPackageWrite],
    user,
) -> None:
    if not packages:
        raise ValidationError("Add at least one package before saving the consignment")

    package_numbers: set[str] = set()
    barcodes: set[str] = set()
    packed_by_key: dict[tuple[int, int], Decimal] = {}
    used_serials: set[str] = set()
    issued_by_key, issued_serials = await _issue_available_qty_and_serials(db, issue)

    existing_barcode_stmt = select(m.DispatchPackage.barcode).join(m.Dispatch).where(
        m.DispatchPackage.barcode.isnot(None),
        m.DispatchPackage.dispatch_id != (dispatch.id or 0),
        m.Dispatch.status != DispatchStatus.CANCELLED.value,
    )
    existing_barcodes = {
        value.lower()
        for value in (await db.execute(existing_barcode_stmt)).scalars().all()
        if value
    }

    dispatch.items.clear()
    dispatch.packages.clear()
    await db.flush()

    line_no = 1
    for package_index, package_data in enumerate(packages, start=1):
        package_no = (
            package_data.package_no
            or f"{dispatch.dispatch_no}-P{package_index:02d}"
        ).strip()
        barcode = (
            package_data.barcode
            or f"{dispatch.dispatch_no}|P{package_index:02d}"
        ).strip()
        if not package_no:
            raise ValidationError(f"Package {package_index}: package no is required")
        if not barcode:
            raise ValidationError(f"Package {package_index}: barcode is required")
        if package_no.lower() in package_numbers:
            raise ValidationError(f"Package {package_no} is repeated in this consignment")
        if barcode.lower() in barcodes:
            raise ValidationError(f"Barcode {barcode} is repeated in this consignment")
        if barcode.lower() in existing_barcodes:
            raise ValidationError(f"Barcode {barcode} is already used on another package")
        if not package_data.items:
            raise ValidationError(f"Package {package_no} must contain at least one item")

        package_numbers.add(package_no.lower())
        barcodes.add(barcode.lower())
        package = m.DispatchPackage(
            dispatch_id=dispatch.id,
            package_no=package_no,
            package_type=package_data.package_type,
            barcode=barcode,
            weight_kg=package_data.weight_kg,
            length_cm=package_data.length_cm,
            width_cm=package_data.width_cm,
            height_cm=package_data.height_cm,
            is_fragile=package_data.is_fragile,
            is_temp_controlled=package_data.is_temp_controlled,
            status=PackageStatus.PACKED.value,
            packed_by_name=_name(user),
            packed_at=utcnow(),
        )
        dispatch.packages.append(package)
        await db.flush()

        for item_data in package_data.items:
            item = await _item_snapshot(db, item_data.item_id)
            qty = _d(item_data.quantity)
            if qty <= ZERO:
                raise ValidationError(
                    f"{package_no}: {item.code} quantity must be positive"
                )
            batch_id = item_data.batch_id or m.NO_BATCH
            serials = [
                value.strip()
                for value in ([item_data.serial_no] if item_data.serial_no else item_data.serial_numbers)
                if value and value.strip()
            ]
            normalized_serials = [value.lower() for value in serials]
            if len(normalized_serials) != len(set(normalized_serials)):
                raise ValidationError(f"{package_no}: duplicate serials for {item.code}")

            is_serialized = item.is_serial_tracked or bool(serials)
            if is_serialized:
                if qty != qty.to_integral_value():
                    raise ValidationError(f"{package_no}: {item.code} serial quantity must be whole")
                if len(serials) != int(qty):
                    raise ValidationError(
                        f"{package_no}: select exactly {int(qty)} serials for {item.code}"
                    )

            key = (item.id, batch_id)
            packed_by_key[key] = packed_by_key.get(key, ZERO) + qty
            if packed_by_key[key] > issued_by_key.get(key, ZERO):
                raise ValidationError(
                    f"{item.code}: packed quantity {packed_by_key[key]} exceeds "
                    f"{issued_by_key.get(key, ZERO)} issued for this batch"
                )

            batch = await db.get(m.Batch, batch_id) if batch_id != m.NO_BATCH else None
            rate = _d(item_data.rate)
            if is_serialized:
                for serial in serials:
                    lowered = serial.lower()
                    if lowered in used_serials:
                        raise ValidationError(f"Serial {serial} is already packed")
                    serial_row = issued_serials.get(lowered)
                    if not serial_row or serial_row.item_id != item.id:
                        raise ValidationError(
                            f"Serial {serial} is not issued against {issue.issue_no}"
                        )
                    if batch_id != m.NO_BATCH and serial_row.batch_id != batch_id:
                        raise ValidationError(
                            f"Serial {serial} is not in the selected batch"
                        )
                    used_serials.add(lowered)
                    dispatch.items.append(m.DispatchItem(
                        line_no=line_no,
                        package_id=package.id,
                        indent_id=item_data.indent_id or issue.indent_id,
                        indent_no=issue.indent_no,
                        item_id=item.id,
                        item_code=item.code,
                        item_name=item.name,
                        uom_code=item.uom_code,
                        batch_id=batch_id,
                        batch_no=batch.batch_no if batch else None,
                        mfg_date=batch.mfg_date if batch else None,
                        expiry_date=batch.expiry_date if batch else None,
                        serial_no=serial,
                        # Off the unit, not off the form. The IMEI is a property of
                        # the handset in the carton; asking the packer to type it
                        # again is how it drifts from what was actually sent.
                        imei_no=serial_row.imei,
                        quantity=Decimal("1"),
                        delivered_qty=ZERO,
                        rate=rate or None,
                        amount=rate if rate else None,
                        remarks=item_data.remarks,
                    ))
                    line_no += 1
            else:
                dispatch.items.append(m.DispatchItem(
                    line_no=line_no,
                    package_id=package.id,
                    indent_id=item_data.indent_id or issue.indent_id,
                    indent_no=issue.indent_no,
                    item_id=item.id,
                    item_code=item.code,
                    item_name=item.name,
                    uom_code=item.uom_code,
                    batch_id=batch_id,
                    batch_no=batch.batch_no if batch else None,
                    mfg_date=batch.mfg_date if batch else None,
                    expiry_date=batch.expiry_date if batch else None,
                    serial_no=None,
                    imei_no=None,
                    quantity=qty,
                    delivered_qty=ZERO,
                    rate=rate or None,
                    amount=(qty * rate) if rate else None,
                    remarks=item_data.remarks,
                ))
                line_no += 1

    for key, issued_qty in issued_by_key.items():
        packed_qty = packed_by_key.get(key, ZERO)
        if packed_qty != issued_qty:
            item = await db.get(Item, key[0])
            item_code = item.code if item else f"item {key[0]}"
            raise ValidationError(
                f"{item_code}: packed quantity {packed_qty} must equal issued quantity {issued_qty}"
            )

    _dispatch_totals(dispatch)


async def list_dispatches(db: AsyncSession, params: PageParams, *, status: str | None = None,
                          warehouse_id: int | None = None, search: str | None = None, user=None) -> dict:
    stmt = select(m.Dispatch)
    if user is not None:
        stmt = stmt.where(await scope_condition(
            db, user,
            warehouse_col=m.Dispatch.warehouse_id,
            warehouse_ids=await warehouse_ids_for_user(db, user),
            owner_col=m.Dispatch.created_by_id,
            project_col=m.Dispatch.project_id,
        ))
    if status:
        stmt = stmt.where(m.Dispatch.status == status)
    if warehouse_id:
        stmt = stmt.where(m.Dispatch.warehouse_id == warehouse_id)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(
            m.Dispatch.dispatch_no.ilike(like), m.Dispatch.vehicle_number.ilike(like),
            m.Dispatch.lr_no.ilike(like), m.Dispatch.customer_name.ilike(like),
            m.Dispatch.to_warehouse_name.ilike(like)))
    return await _decorate_dispatch_page_destinations(
        db,
        await paginate(db, stmt.order_by(m.Dispatch.id.desc()), params),
    )


async def list_consignments(db: AsyncSession, params: PageParams, *, status: str | None = None,
                            warehouse_id: int | None = None, search: str | None = None, user=None) -> dict:
    stmt = select(m.Dispatch)
    if user is not None:
        stmt = stmt.where(await scope_condition(
            db, user,
            warehouse_col=m.Dispatch.warehouse_id,
            warehouse_ids=await warehouse_ids_for_user(db, user),
            owner_col=m.Dispatch.created_by_id,
            project_col=m.Dispatch.project_id,
        )).where(
        m.Dispatch.ref_type.in_(["ISSUE", WarehouseDocType.WH_ISSUE.value]),
        m.Dispatch.packages.any(),
    )
    if status:
        stmt = stmt.where(m.Dispatch.status == status)
    if warehouse_id:
        stmt = stmt.where(m.Dispatch.warehouse_id == warehouse_id)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(
            m.Dispatch.dispatch_no.ilike(like),
            m.Dispatch.ref_no.ilike(like),
            m.Dispatch.customer_name.ilike(like),
            m.Dispatch.vendor_name.ilike(like),
            m.Dispatch.to_warehouse_name.ilike(like),
            m.Dispatch.delivery_address.ilike(like),
        ))
    return await _decorate_dispatch_page_destinations(
        db,
        await paginate(db, stmt.order_by(m.Dispatch.id.desc()), params),
    )


async def get_dispatch(db: AsyncSession, dispatch_id: int, user=None) -> m.Dispatch:
    dispatch = await _load(db, m.Dispatch, dispatch_id, "Dispatch",
                           m.Dispatch.items, m.Dispatch.packages, m.Dispatch.events)
    dispatch = await _decorate_can_approve(
        db, dispatch, WarehouseDocType.DISPATCH.value, user)
    # Detail only: the relay hop needs the Forward button on the consignment it just
    # signed for, and answering this costs three queries — too much for a 50-row board.
    setattr(dispatch, "can_forward", await can_forward_dispatch(db, dispatch))
    return await _decorate_dispatch_destination(db, dispatch)


def _guard_expected_delivery(dispatch_date, expected_delivery) -> None:
    """Goods cannot arrive before they leave.

    Checked here and not only on the form: the date arrives as a plain `date | None`
    on all three consignment/dispatch write paths and nothing compared it to the
    dispatch date, so a consignment could be saved promising delivery a week before
    it shipped. Measured against the dispatch date rather than today, because a
    consignment may be back-dated and its delivery date has to stay consistent with
    the day it actually left.
    """
    if expected_delivery is None or dispatch_date is None:
        return
    if expected_delivery < dispatch_date:
        raise ValidationError(
            f"Expected delivery {expected_delivery} is before the consignment leaves "
            f"({dispatch_date}). Pick a date on or after it."
        )


async def _build_consignment(db: AsyncSession, data: s.ConsignmentWrite, user) -> m.Dispatch:
    """Build one consignment without committing it — see _build_picking / _build_issue.

    A consignment and a dispatch are the same `out_dispatches` row: this writes it at
    PACKED, and gate_out() later moves that same row out of the gate. There is no
    separate dispatch document to raise.
    """
    issue = await get_issue(db, data.issue_id)
    if issue.direction != IssueDirection.OUT.value or not issue.is_stock_posted:
        raise ValidationError("Only a posted outward material issue can become a consignment")
    if issue.qc_status == QcStatus.PENDING.value:
        raise ValidationError(f"{issue.issue_no} is pending outward quality inspection")
    if issue.qc_status == QcStatus.FAILED.value:
        raise ValidationError(f"{issue.issue_no} failed outward quality inspection")

    existing = await db.scalar(
        select(m.Dispatch.id).where(
            m.Dispatch.ref_type.in_(["ISSUE", WarehouseDocType.WH_ISSUE.value]),
            m.Dispatch.ref_id == issue.id,
            m.Dispatch.status != DispatchStatus.CANCELLED.value,
        ).limit(1)
    )
    if existing is not None:
        raise ValidationError(f"{issue.issue_no} already has consignment {existing}")

    wh = await _warehouse(db, issue.warehouse_id)
    to_wh = await db.get(Warehouse, data.to_warehouse_id) if data.to_warehouse_id else None
    if to_wh is None:
        to_wh = await _destination_warehouse(db, issue, wh.id)
    if data.dispatch_type == DispatchType.TRANSFER and to_wh is None:
        raise ValidationError("A stock transfer consignment needs a destination warehouse")
    if to_wh is not None and to_wh.id == wh.id:
        raise ValidationError("A transfer cannot have the same origin and destination")
    # Nothing to carry. The issue came OUT of the very point that raised the indent —
    # an OE serving his own LIP — so the goods are already on the requester's shelf.
    # Left to run, this wrote a consignment with a blank destination, and a blank
    # destination is the one thing `incoming_dispatch_options` cannot match: the
    # storekeeper acknowledged the delivery and then had no consignment to raise a
    # GRN against. Say it here, where it can still be acted on.
    if to_wh is None and not data.customer_id and not data.vendor_id:
        same_point = await _requesting_point(db, issue)
        if same_point is not None and same_point.id == wh.id:
            raise ValidationError(
                f"{issue.issue_no} was issued at {wh.name}, the point that raised the "
                "indent — the goods are already there. Acknowledge the issue instead "
                "of raising a consignment, or pick a destination to forward it on."
            )
    _guard_expected_delivery(data.dispatch_date, data.expected_delivery)
    vendor = await db.get(Vendor, data.vendor_id) if data.vendor_id else None
    _, destination_office_name = await _issue_destination(db, issue)

    dispatch = m.Dispatch(
        items=[], packages=[], events=[],
        dispatch_no=await next_number(db, WarehouseDocType.DISPATCH.value),
        dispatch_type=data.dispatch_type.value,
        dispatch_date=data.dispatch_date,
        warehouse_id=wh.id,
        warehouse_name=wh.name,
        to_warehouse_id=to_wh.id if to_wh else None,
        to_warehouse_name=to_wh.name if to_wh else None,
        customer_id=data.customer_id,
        vendor_id=data.vendor_id,
        vendor_name=vendor.name if vendor else None,
        project_id=data.project_id or issue.project_id,
        # Snapshot the name beside the id, the way every other document here does
        # (rule 10). Live consignments carry project_id 4 with project_name NULL, so
        # the dispatch board and its printouts show a blank where the project goes.
        project_name=await _project_name(db, data.project_id or issue.project_id),
        delivery_address=(data.delivery_address
                          or _address_without_vehicle(destination_office_name)),
        contact_person=data.contact_person,
        contact_phone=data.contact_phone,
        ref_type=InventoryRefType.WH_ISSUE.value,
        ref_id=issue.id,
        ref_no=issue.issue_no,
        transport_mode=data.transport_mode,
        carrier_id=data.carrier_id,
        vehicle_id=data.vehicle_id,
        vehicle_number=_consignment_vehicle(issue, destination_office_name),
        driver_name=data.driver_name,
        driver_phone=data.driver_phone,
        lr_no=data.lr_no,
        eway_bill_no=data.eway_bill_no,
        freight_amount=data.freight_amount,
        expected_delivery=data.expected_delivery,
        status=DispatchStatus.PACKED.value,
        remarks=data.remarks,
        created_by_id=getattr(user, "id", None),
        created_by_name=_name(user),
    )
    db.add(dispatch)
    await db.flush()
    await _apply_consignment_packages(db, dispatch, issue, data.packages, user)
    _validate_issue_dispatch(dispatch, issue)
    dispatch.status = DispatchStatus.PACKED.value
    await write_audit(db, entity="out_dispatches", entity_id=dispatch.id,
                      entity_no=dispatch.dispatch_no, action=AuditAction.CREATE, actor=user,
                      after={"status": dispatch.status, "packages": len(dispatch.packages)})
    return dispatch


async def create_consignment(db: AsyncSession, data: s.ConsignmentWrite, user) -> m.Dispatch:
    dispatch = await _build_consignment(db, data, user)
    await db.commit()
    return await get_dispatch(db, dispatch.id)


async def update_consignment(db: AsyncSession, dispatch_id: int, data: s.ConsignmentWrite,
                             user) -> m.Dispatch:
    dispatch = await get_dispatch(db, dispatch_id)
    _guard(dispatch.status, {DispatchStatus.DRAFT.value, DispatchStatus.PACKED.value},
           "edit", "consignment")
    issue = await get_issue(db, data.issue_id)
    if dispatch.ref_id and dispatch.ref_id != issue.id:
        raise ValidationError("A consignment cannot be moved to another material issue")
    wh = await _warehouse(db, issue.warehouse_id)
    to_wh = await db.get(Warehouse, data.to_warehouse_id) if data.to_warehouse_id else None
    if to_wh is None:
        to_wh = await _destination_warehouse(db, issue, wh.id)
    if data.dispatch_type == DispatchType.TRANSFER and to_wh is None:
        raise ValidationError("A stock transfer consignment needs a destination warehouse")
    if to_wh is not None and to_wh.id == wh.id:
        raise ValidationError("A transfer cannot have the same origin and destination")
    _guard_expected_delivery(data.dispatch_date, data.expected_delivery)
    vendor = await db.get(Vendor, data.vendor_id) if data.vendor_id else None
    _, destination_office_name = await _issue_destination(db, issue)

    before = {"status": dispatch.status, "packages": dispatch.total_packages}
    dispatch.dispatch_type = data.dispatch_type.value
    dispatch.dispatch_date = data.dispatch_date
    dispatch.warehouse_id = wh.id
    dispatch.warehouse_name = wh.name
    dispatch.to_warehouse_id = to_wh.id if to_wh else None
    dispatch.to_warehouse_name = to_wh.name if to_wh else None
    dispatch.customer_id = data.customer_id
    dispatch.vendor_id = data.vendor_id
    dispatch.vendor_name = vendor.name if vendor else None
    dispatch.project_id = data.project_id or issue.project_id
    dispatch.delivery_address = (data.delivery_address
                                 or _address_without_vehicle(destination_office_name))
    dispatch.contact_person = data.contact_person
    dispatch.contact_phone = data.contact_phone
    dispatch.ref_type = WarehouseDocType.WH_ISSUE.value
    dispatch.ref_id = issue.id
    dispatch.ref_no = issue.issue_no
    dispatch.transport_mode = data.transport_mode
    dispatch.carrier_id = data.carrier_id
    dispatch.vehicle_id = data.vehicle_id
    dispatch.vehicle_number = _consignment_vehicle(issue, destination_office_name)
    dispatch.driver_name = data.driver_name
    dispatch.driver_phone = data.driver_phone
    dispatch.lr_no = data.lr_no
    dispatch.eway_bill_no = data.eway_bill_no
    dispatch.freight_amount = data.freight_amount
    dispatch.expected_delivery = data.expected_delivery
    dispatch.remarks = data.remarks

    await _apply_consignment_packages(db, dispatch, issue, data.packages, user)
    _validate_issue_dispatch(dispatch, issue)
    dispatch.status = DispatchStatus.PACKED.value
    await db.flush()
    await write_audit(db, entity="out_dispatches", entity_id=dispatch.id,
                      entity_no=dispatch.dispatch_no, action=AuditAction.UPDATE, actor=user,
                      before=before,
                      after={"status": dispatch.status, "packages": dispatch.total_packages})
    await db.commit()
    return await get_dispatch(db, dispatch_id)


async def create_dispatch(db: AsyncSession, data: s.DispatchWrite, user) -> m.Dispatch:
    wh = await _warehouse(db, data.warehouse_id)
    if not data.items:
        raise ValidationError("A dispatch with no lines has nothing to send")

    to_wh = await db.get(Warehouse, data.to_warehouse_id) if data.to_warehouse_id else None
    _guard_expected_delivery(data.dispatch_date, data.expected_delivery)

    vendor = await db.get(Vendor, data.vendor_id) if data.vendor_id else None
    ref_issue = None
    destination_office_name = None
    if (data.ref_type or "").upper() in {"ISSUE", "WH_ISSUE"}:
        if not data.ref_id:
            raise ValidationError("An issue-linked dispatch needs an issue reference")
        ref_issue = await get_issue(db, data.ref_id)
        if not ref_issue.is_stock_posted:
            raise ValidationError(f"{ref_issue.issue_no} has not posted stock yet")
        if ref_issue.warehouse_id != wh.id:
            raise ValidationError(f"{ref_issue.issue_no} belongs to another warehouse")
        existing = await db.scalar(
            select(m.Dispatch.id).where(
                m.Dispatch.ref_type.in_(["ISSUE", WarehouseDocType.WH_ISSUE.value]),
                m.Dispatch.ref_id == ref_issue.id,
                m.Dispatch.status != DispatchStatus.CANCELLED.value,
            ).limit(1)
        )
        if existing is not None:
            raise ValidationError(
                f"{ref_issue.issue_no} already has dispatch {existing}"
            )
        _, destination_office_name = await _issue_destination(db, ref_issue)

    # Derive the destination from the issue when nobody typed one. Has to sit here, not
    # up with the other to_wh handling: it needs the issue, and the issue is only loaded
    # above. It read an undefined `issue` there and raised NameError on every dispatch
    # that left the field blank — which is every issue-linked delivery, since the form
    # labels that field "for transfer only".
    if to_wh is None and ref_issue is not None:
        to_wh = await _destination_warehouse(db, ref_issue, wh.id)

    if data.dispatch_type == DispatchType.TRANSFER and to_wh is None:
        raise ValidationError("A stock transfer needs a destination warehouse")
    if to_wh is not None and to_wh.id == wh.id:
        raise ValidationError("A transfer cannot have the same origin and destination")

    dispatch = m.Dispatch(
        # See create_issue. All three are delete-orphan collections, so the flush wants
        # them loaded to work out the cascade — which is a lazy load, which an
        # AsyncSession cannot do.
        items=[], packages=[], events=[],
        dispatch_no=await next_number(db, WarehouseDocType.DISPATCH.value),
        dispatch_type=data.dispatch_type.value,
        dispatch_date=data.dispatch_date,
        warehouse_id=wh.id, warehouse_name=wh.name,
        to_warehouse_id=to_wh.id if to_wh else None,
        to_warehouse_name=to_wh.name if to_wh else None,
        customer_id=data.customer_id,
        vendor_id=data.vendor_id, vendor_name=vendor.name if vendor else None,
        project_id=data.project_id,
        delivery_address=data.delivery_address or destination_office_name,
        contact_person=data.contact_person, contact_phone=data.contact_phone,
        ref_type=data.ref_type, ref_id=data.ref_id,
        ref_no=ref_issue.issue_no if ref_issue else None,
        transport_mode=data.transport_mode,
        carrier_id=data.carrier_id, vehicle_id=data.vehicle_id,
        driver_name=data.driver_name, driver_phone=data.driver_phone,
        lr_no=data.lr_no, eway_bill_no=data.eway_bill_no,
        freight_amount=data.freight_amount,
        expected_delivery=data.expected_delivery,
        status=DispatchStatus.DRAFT.value,
        remarks=data.remarks,
        created_by_id=getattr(user, "id", None), created_by_name=_name(user),
    )
    db.add(dispatch)
    await db.flush()

    await _apply_dispatch_lines(db, dispatch, data.items)
    if ref_issue:
        _validate_issue_dispatch(dispatch, ref_issue)
    await db.flush()

    await write_audit(db, entity="out_dispatches", entity_id=dispatch.id,
                      entity_no=dispatch.dispatch_no, action=AuditAction.CREATE, actor=user,
                      after={"status": dispatch.status, "total_qty": str(dispatch.total_qty)})
    await db.commit()
    return await get_dispatch(db, dispatch.id)


async def update_dispatch(db: AsyncSession, dispatch_id: int, data: s.DispatchWrite,
                          user) -> m.Dispatch:
    dispatch = await get_dispatch(db, dispatch_id)
    _guard(dispatch.status, {DispatchStatus.DRAFT.value}, "edit", "dispatch")

    before = {"total_qty": str(dispatch.total_qty)}
    wh = await _warehouse(db, data.warehouse_id)
    to_wh = await db.get(Warehouse, data.to_warehouse_id) if data.to_warehouse_id else None

    dispatch.dispatch_type = data.dispatch_type.value
    dispatch.dispatch_date = data.dispatch_date
    dispatch.warehouse_id = wh.id
    dispatch.warehouse_name = wh.name
    dispatch.to_warehouse_id = to_wh.id if to_wh else None
    dispatch.to_warehouse_name = to_wh.name if to_wh else None
    dispatch.customer_id = data.customer_id
    dispatch.vendor_id = data.vendor_id
    dispatch.project_id = data.project_id
    dispatch.contact_person = data.contact_person
    dispatch.contact_phone = data.contact_phone
    dispatch.ref_type = data.ref_type
    dispatch.ref_id = data.ref_id
    ref_issue = None
    if (data.ref_type or "").upper() in {"ISSUE", "WH_ISSUE"} and data.ref_id:
        ref_issue = await get_issue(db, data.ref_id)
        if not ref_issue.is_stock_posted:
            raise ValidationError(f"{ref_issue.issue_no} has not posted stock yet")
        if ref_issue.warehouse_id != wh.id:
            raise ValidationError(f"{ref_issue.issue_no} belongs to another warehouse")
    dispatch.ref_no = ref_issue.issue_no if ref_issue else None
    _, destination_office_name = await _issue_destination(db, ref_issue)
    dispatch.delivery_address = data.delivery_address or destination_office_name
    dispatch.transport_mode = data.transport_mode
    dispatch.carrier_id = data.carrier_id
    dispatch.vehicle_id = data.vehicle_id
    dispatch.driver_name = data.driver_name
    dispatch.driver_phone = data.driver_phone
    dispatch.lr_no = data.lr_no
    dispatch.eway_bill_no = data.eway_bill_no
    dispatch.freight_amount = data.freight_amount
    dispatch.expected_delivery = data.expected_delivery
    dispatch.remarks = data.remarks

    await _apply_dispatch_lines(db, dispatch, data.items)
    if ref_issue:
        _validate_issue_dispatch(dispatch, ref_issue)
    await db.flush()

    await write_audit(db, entity="out_dispatches", entity_id=dispatch.id,
                      entity_no=dispatch.dispatch_no, action=AuditAction.UPDATE, actor=user,
                      before=before, after={"total_qty": str(dispatch.total_qty)})
    await db.commit()
    return await get_dispatch(db, dispatch_id)


async def _apply_dispatch_submit(db: AsyncSession, dispatch: m.Dispatch, user):
    """Start the consignment's approval chain and set its status from the answer.

    Split out of `submit_dispatch` for the same reason `_apply_gate_out` was: the
    release guard (`transport_release_blocked`) has to ask the ladder the real
    question — does anyone actually have to sign this — and it runs inside the
    transport service's transaction. Neither commits nor audits; the caller owns both.
    Returns the workflow instance, so "nobody had to sign" is distinguishable from
    "it is now with an approver".
    """
    context = {
        "warehouse_id": dispatch.warehouse_id,
        "total_value": float(_d(dispatch.total_value)),
        "dispatch_type": dispatch.dispatch_type,
    }
    context.update({
        "doc_no": dispatch.dispatch_no,
        "doc_summary": f"Dispatch {dispatch.dispatch_no}",
        "requester_position_id": getattr(user, "active_position_id", None),
    })
    instance = await engine.start(
        db, WarehouseDocType.DISPATCH.value, dispatch.id, context, user
    )
    if instance.status == InstanceStatus.APPROVED.value:
        dispatch.status = DispatchStatus.APPROVED.value
        dispatch.approved_by_name = _name(user)
        dispatch.approved_at = utcnow()
        dispatch.current_approver_name = None
    else:
        approvers = await engine.current_approvers(
            db, WarehouseDocType.DISPATCH.value, dispatch.id
        )
        dispatch.current_approver_name = _approver_label(approvers)
        dispatch.status = DispatchStatus.PENDING_APPROVAL.value
    return instance


async def submit_dispatch(db: AsyncSession, dispatch_id: int, user) -> m.Dispatch:
    dispatch = await get_dispatch(db, dispatch_id)
    # PACKED as well as DRAFT: a consignment is packed before anyone is asked to
    # release it, so PACKED is the normal state to submit from — the Consignments
    # screen saves straight to it. Allowing only DRAFT meant a packed consignment
    # could never enter its own approval chain.
    _guard(dispatch.status,
           {DispatchStatus.DRAFT.value, DispatchStatus.PACKED.value},
           "submit", "dispatch")

    await _apply_dispatch_submit(db, dispatch, user)

    await write_audit(db, entity="out_dispatches", entity_id=dispatch.id,
                      entity_no=dispatch.dispatch_no, action=AuditAction.UPDATE, actor=user,
                      before={"status": DispatchStatus.DRAFT.value},
                      after={"status": dispatch.status})
    await db.commit()
    return await get_dispatch(db, dispatch_id)


async def act_on_dispatch(
    db: AsyncSession, dispatch_id: int, action: str, comments: str, user,
) -> m.Dispatch:
    dispatch = await get_dispatch(db, dispatch_id)
    _guard(
        dispatch.status, {DispatchStatus.PENDING_APPROVAL.value},
        action.lower(), "dispatch",
    )
    before = dispatch.status
    instance = await engine.act(
        db,
        WarehouseDocType.DISPATCH.value,
        dispatch.id,
        action,
        user,
        comments,
        context={
            "doc_no": dispatch.dispatch_no,
            "doc_summary": f"Dispatch {dispatch.dispatch_no}",
            "warehouse_id": dispatch.warehouse_id,
            "dispatch_type": dispatch.dispatch_type,
            "total_value": float(_d(dispatch.total_value)),
        },
    )
    if instance.status == InstanceStatus.APPROVED.value:
        dispatch.status = DispatchStatus.APPROVED.value
        dispatch.approved_by_name = _name(user)
        dispatch.approved_at = utcnow()
        dispatch.current_approver_name = None
    elif instance.status == InstanceStatus.REJECTED.value:
        dispatch.status = DispatchStatus.REJECTED.value
        dispatch.current_approver_name = None
    else:
        dispatch.current_approver_name = _approver_label(
            await engine.current_approvers(
                db, WarehouseDocType.DISPATCH.value, dispatch.id
            )
        )

    await write_audit(
        db, entity="out_dispatches", entity_id=dispatch.id,
        entity_no=dispatch.dispatch_no, action=AuditAction.UPDATE, actor=user,
        before={"status": before},
        after={"status": dispatch.status, "comments": comments},
    )
    await db.commit()
    return await get_dispatch(db, dispatch_id)


async def add_package(db: AsyncSession, dispatch_id: int, data: s.PackageWrite,
                      user) -> m.Dispatch:
    """Boxes some lines up.

    Assigning lines to a package is what makes an "it arrived short" call answerable:
    `out_dispatch_items.package_id` says which carton each item went into.
    """
    dispatch = await get_dispatch(db, dispatch_id)
    _guard(dispatch.status,
           {DispatchStatus.APPROVED.value, DispatchStatus.PACKED.value,
            DispatchStatus.DRAFT.value},
           "pack", "dispatch")

    sequence = len(dispatch.packages) + 1
    package = m.DispatchPackage(
        dispatch_id=dispatch.id,
        package_no=f"{dispatch.dispatch_no}-P{sequence:02d}",
        package_type=data.package_type,
        barcode=f"{dispatch.dispatch_no}|P{sequence:02d}",
        weight_kg=data.weight_kg,
        length_cm=data.length_cm, width_cm=data.width_cm, height_cm=data.height_cm,
        is_fragile=data.is_fragile, is_temp_controlled=data.is_temp_controlled,
        status=PackageStatus.PACKED.value,
        packed_by_name=_name(user), packed_at=utcnow(),
    )
    dispatch.packages.append(package)
    await db.flush()

    if data.item_ids:
        by_id = {l.id: l for l in dispatch.items}
        for line_id in data.item_ids:
            line = by_id.get(line_id)
            if line is None:
                raise ValidationError(f"Line {line_id} is not on {dispatch.dispatch_no}")
            if line.package_id:
                raise ValidationError(
                    f"{line.item_code or line.item_id} is already in another package")
            line.package_id = package.id

    _dispatch_totals(dispatch)
    if dispatch.status == DispatchStatus.APPROVED.value:
        dispatch.status = DispatchStatus.PACKED.value

    await write_audit(db, entity="out_dispatch_packages", entity_id=package.id,
                      entity_no=package.package_no, action=AuditAction.CREATE, actor=user,
                      after={"lines": len(data.item_ids)})
    await db.commit()
    return await get_dispatch(db, dispatch_id)


async def delete_package(db: AsyncSession, dispatch_id: int, package_id: int,
                         user) -> m.Dispatch:
    dispatch = await get_dispatch(db, dispatch_id)
    _guard(dispatch.status,
           {DispatchStatus.APPROVED.value, DispatchStatus.PACKED.value,
            DispatchStatus.DRAFT.value},
           "unpack", "dispatch")

    package = next((p for p in dispatch.packages if p.id == package_id), None)
    if package is None:
        raise NotFoundError(f"Package {package_id} is not on {dispatch.dispatch_no}")

    for line in dispatch.items:
        if line.package_id == package_id:
            line.package_id = None

    dispatch.packages.remove(package)
    await db.flush()
    _dispatch_totals(dispatch)

    await write_audit(db, entity="out_dispatch_packages", entity_id=package_id,
                      entity_no=package.package_no, action=AuditAction.DEACTIVATE, actor=user,
                      before={"package_no": package.package_no})
    await db.commit()
    return await get_dispatch(db, dispatch_id)


async def _dispatch_approval_pending(db: AsyncSession, dispatch: m.Dispatch,
                                     user) -> bool:
    """Does this consignment still owe a signature before it may leave?

    Gate-out has always accepted PACKED as well as APPROVED, so Confirm dispatch took
    goods out of the building without the DISPATCH workflow ever starting. A Logistics
    ladder configured on Approvals Config would simply never fire, which reads as the
    screen being ignored.

    Deliberately conditional on a ladder EXISTING for this scope. Where nobody has
    configured one, nothing changes and a packed consignment still gates straight out —
    this must not become a new mandatory step for every site that never asked for one.
    Configuring a Dispatch chain is what turns it on, which is the whole contract of
    that screen.

    Returns True when the caller should stop and leave the document in approval.
    """
    if dispatch.status == DispatchStatus.APPROVED.value:
        return False

    project_id, _project_name = await wf_ladder.project_for(
        db, getattr(user, "active_position_id", None), user)
    if await wf_ladder.find_ladder(
            db, project_id, WarehouseDocType.DISPATCH.value) is None:
        return False

    instance = (await db.execute(
        select(WfInstance)
        .where(WfInstance.doc_type == WarehouseDocType.DISPATCH.value,
               WfInstance.doc_id == dispatch.id)
        .order_by(WfInstance.id.desc()).limit(1)
    )).scalars().first()
    if instance is not None and instance.status == InstanceStatus.APPROVED.value:
        return False
    if instance is not None and instance.status == InstanceStatus.IN_PROGRESS.value:
        raise ValidationError(
            f"{dispatch.dispatch_no} is waiting on "
            f"{dispatch.current_approver_name or 'approval'} and cannot leave yet"
        )

    # Never submitted. Send it rather than refusing: to the person at the gate,
    # "Confirm dispatch" means "send this consignment", and where the project asks for
    # a signature that means starting the chain, not an error telling them to go and
    # find another button. If the chain resolves to NO_APPROVAL the engine returns it
    # approved immediately and gate-out carries straight on below.
    dispatch = await submit_dispatch(db, dispatch.id, user)
    return dispatch.status != DispatchStatus.APPROVED.value


async def gate_out(db: AsyncSession, dispatch_id: int, gate_pass_no: str | None,
                   user) -> m.Dispatch:
    """Releases the consignment and takes the stock out of the warehouse.

    This is where a dispatch moves stock, not at packing: goods on the packing bench
    are still yours. A transfer only takes stock out here; it comes back in at the
    destination through that site's own GRN, so it is never in two places at once.
    """
    dispatch = await get_dispatch(db, dispatch_id)
    _guard(dispatch.status, {DispatchStatus.APPROVED.value, DispatchStatus.PACKED.value},
           "gate out", "dispatch")
    if await _dispatch_approval_pending(db, dispatch, user):
        # Now with its approvers. The goods stay on the bench until they sign.
        return await get_dispatch(db, dispatch_id)

    await _apply_gate_out(db, dispatch, gate_pass_no, user)

    await write_audit(db, entity="out_dispatches", entity_id=dispatch.id,
                      entity_no=dispatch.dispatch_no, action=AuditAction.UPDATE, actor=user,
                      before={"status": DispatchStatus.PACKED.value},
                      after={"status": dispatch.status,
                             "gate_pass_no": dispatch.gate_pass_no})
    await db.commit()
    return await get_dispatch(db, dispatch_id)


async def _apply_gate_out(db: AsyncSession, dispatch: m.Dispatch,
                          gate_pass_no: str | None, user) -> None:
    """The gate-out itself: stock leaves, the consignment reads DISPATCHED.

    Split out so the logistics desk releasing the same load (`hooks.ON_RELEASE`) does
    exactly this and not a second, drifting copy of it. Neither commits nor audits —
    both callers are mid-transaction and own their own audit row.
    """
    already_issued = False
    linked_issue: m.MaterialIssue | None = None
    if (dispatch.ref_type or "").upper() in {"ISSUE", "WH_ISSUE"} and dispatch.ref_id:
        linked_issue = await get_issue(db, dispatch.ref_id)
        if not linked_issue.is_stock_posted:
            raise ValidationError(
                f"{linked_issue.issue_no} has not posted stock yet; dispatch cannot gate out"
            )
        if linked_issue.warehouse_id != dispatch.warehouse_id:
            raise ValidationError(
                f"{linked_issue.issue_no} belongs to a different warehouse"
            )
        issued_by_item: dict[int, Decimal] = {}
        for line in linked_issue.items:
            issued_by_item[line.item_id] = (
                issued_by_item.get(line.item_id, ZERO) + _d(line.issued_qty)
            )
        dispatched_by_item: dict[int, Decimal] = {}
        for line in dispatch.items:
            dispatched_by_item[line.item_id] = (
                dispatched_by_item.get(line.item_id, ZERO) + _d(line.quantity)
            )
        for item_id, qty in dispatched_by_item.items():
            if qty > issued_by_item.get(item_id, ZERO):
                raise ValidationError(
                    f"Item {item_id}: dispatch quantity {qty} exceeds the "
                    f"{issued_by_item.get(item_id, ZERO)} posted on {linked_issue.issue_no}."
                )
        already_issued = True

    if not already_issued:
        for line in dispatch.items:
            qty = _d(line.quantity)
            if qty <= ZERO:
                continue
            # No issue behind this consignment, so the units are claimed against the
            # consignment itself. Without this a directly-gated dispatch left its
            # units on the source shelf, free to be picked again tomorrow.
            units = await _ship_units(
                db, item_id=line.item_id, warehouse_id=dispatch.warehouse_id,
                qty=qty, batch_id=line.batch_id,
                marker=_shipped_unit_marker("dispatch", dispatch.id),
            )
            await move_stock_out(
                db, item_id=line.item_id, qty=qty,
                ref_type=InventoryRefType.DISPATCH.value, ref_id=dispatch.id,
                ref_no=dispatch.dispatch_no, user=user,
                warehouse_id=dispatch.warehouse_id,
                batch_id=line.batch_id,
                project_id=dispatch.project_id or 0,
                serial_numbers=units or None,
            )

    dispatch.gate_pass_no = gate_pass_no or f"GP/{dispatch.dispatch_no}"
    dispatch.gate_out_at = utcnow()
    dispatch.security_by_name = _name(user)
    dispatch.status = DispatchStatus.DISPATCHED.value
    if linked_issue is not None:
        linked_issue.status = IssueStatus.DISPATCHED.value

    for package in dispatch.packages:
        package.status = PackageStatus.LOADED.value

    db.add(m.DispatchEvent(
        dispatch_id=dispatch.id, event_type="GATE_OUT", event_at=utcnow(),
        location_name=dispatch.warehouse_name, is_breach=False,
        recorded_by_id=getattr(user, "id", None), recorded_by_name=_name(user),
    ))


async def add_dispatch_event(db: AsyncSession, dispatch_id: int, data: s.DispatchEventWrite,
                             user) -> m.Dispatch:
    """Records a stop, a scan or a temperature reading.

    A breach is decided here, not sent by the client: the thresholds live on the
    destination's `whs_locations` row, and a reading outside them is a breach whatever
    the device that reported it thinks.
    """
    dispatch = await get_dispatch(db, dispatch_id)
    if dispatch.status in (DispatchStatus.DRAFT.value, DispatchStatus.CANCELLED.value):
        raise ValidationError(
            f"Cannot record an event against a dispatch that is {dispatch.status}")

    is_breach = False
    if data.temperature_c is not None:
        is_breach = await _is_temperature_breach(db, dispatch, _d(data.temperature_c))

    db.add(m.DispatchEvent(
        dispatch_id=dispatch.id,
        event_type=data.event_type.value,
        event_at=utcnow(),
        location_name=data.location_name,
        latitude=data.latitude, longitude=data.longitude,
        temperature_c=data.temperature_c, humidity_percent=data.humidity_percent,
        is_breach=is_breach, notes=data.notes,
        recorded_by_id=getattr(user, "id", None), recorded_by_name=_name(user),
    ))

    if (
        data.event_type == DispatchEventType.IN_TRANSIT
        and dispatch.status == DispatchStatus.DISPATCHED.value
    ):
        dispatch.status = DispatchStatus.IN_TRANSIT.value
    if data.event_type == DispatchEventType.DELIVERED:
        dispatch.status = DispatchStatus.DELIVERED.value
        dispatch.delivered_at = utcnow()
        # Recording the consignment as delivered is the claim that all of it arrived —
        # the same claim `acknowledge_dispatch` records when no per-line detail is
        # given. Without it `out_dispatch_items.delivered_qty` stays 0, and the
        # indent's Delivery phase sits PENDING on goods the warehouse has already
        # handed over. A later acknowledgement overwrites these with what the
        # receiver actually counted, so a shortage still ends up on the record.
        for line in dispatch.items:
            if _d(line.delivered_qty) <= ZERO:
                line.delivered_qty = _d(line.quantity)

    await write_audit(db, entity="out_dispatch_events", entity_id=dispatch.id,
                      entity_no=dispatch.dispatch_no, action=AuditAction.CREATE, actor=user,
                      after={"event_type": data.event_type.value, "is_breach": is_breach})
    await db.commit()
    return await get_dispatch(db, dispatch_id)


async def _is_temperature_breach(db: AsyncSession, dispatch: m.Dispatch,
                                 reading: Decimal) -> bool:
    """True when the reading is outside the destination's allowed range.

    With no temperature-controlled location on the destination there is no range to
    breach, so a reading is recorded and not flagged — flagging everything would make
    the flag meaningless.
    """
    if not dispatch.to_warehouse_id:
        return False
    row = (await db.execute(
        select(m.WarehouseLocation).where(
            m.WarehouseLocation.warehouse_id == dispatch.to_warehouse_id,
            m.WarehouseLocation.temperature_controlled.is_(True),
            m.WarehouseLocation.is_active.is_(True)).limit(1)
    )).scalar_one_or_none()
    if row is None:
        return False
    low = _d(row.min_temperature_celsius) if row.min_temperature_celsius is not None else None
    high = _d(row.max_temperature_celsius) if row.max_temperature_celsius is not None else None
    return (low is not None and reading < low) or (high is not None and reading > high)


async def acknowledge_dispatch(db: AsyncSession, dispatch_id: int, data: s.AcknowledgeWrite,
                               user) -> m.Dispatch:
    """Confirms what actually arrived, line by line.

    Delivered quantity is recorded per line rather than accepted wholesale: an
    acknowledgement on a consignment that arrived two cartons short is exactly the
    record that makes a shortage unprovable later.
    """
    dispatch = await get_dispatch(db, dispatch_id)
    _guard(dispatch.status,
           {DispatchStatus.DISPATCHED.value, DispatchStatus.IN_TRANSIT.value,
            DispatchStatus.DELIVERED.value},
           "acknowledge", "dispatch")

    short = await _apply_dispatch_acknowledgement(db, dispatch, data, user)

    await write_audit(db, entity="out_dispatches", entity_id=dispatch.id,
                      entity_no=dispatch.dispatch_no, action=AuditAction.UPDATE, actor=user,
                      before={"status": DispatchStatus.IN_TRANSIT.value},
                      after={"status": dispatch.status, "short_qty": str(short)})
    await db.commit()
    return await get_dispatch(db, dispatch_id)


async def _apply_dispatch_acknowledgement(db: AsyncSession, dispatch: m.Dispatch,
                                          data: s.AcknowledgeWrite, user) -> Decimal:
    """Sign the consignment off and settle what it was carrying.

    Split out so the logistics desk taking the same signature on the transport leg
    (`hooks.ON_ACKNOWLEDGE`) settles the issue and the indent through exactly this
    path. Neither commits nor audits — both callers own their transaction. Returns the
    shortfall, for the caller's audit row.
    """
    by_id = {l.id: l for l in dispatch.items}
    for entry in data.lines:
        line = by_id.get(entry.id)
        if line is None:
            raise ValidationError(f"Line {entry.id} is not on {dispatch.dispatch_no}")
        delivered = _d(entry.delivered_qty)
        if delivered < ZERO or delivered > _d(line.quantity):
            raise ValidationError(
                f"{line.item_code or line.item_id}: delivered quantity must be between "
                f"0 and {line.quantity}")
        line.delivered_qty = delivered

    # No per-line detail means everything arrived; that is a claim worth recording
    # explicitly rather than leaving the column at zero.
    if not data.lines:
        for line in dispatch.items:
            line.delivered_qty = _d(line.quantity)

    short = sum((_d(l.quantity) - _d(l.delivered_qty) for l in dispatch.items), ZERO)

    await credit_arrival(db, dispatch, user)

    dispatch.acknowledged_by_name = data.acknowledged_by_name or _name(user)
    dispatch.acknowledged_at = utcnow()
    dispatch.delivered_at = dispatch.delivered_at or utcnow()
    dispatch.pod_url = data.pod_url or dispatch.pod_url
    dispatch.status = DispatchStatus.ACKNOWLEDGED.value
    if data.remarks:
        dispatch.remarks = f"{dispatch.remarks or ''}\nReceiver: {data.remarks}".strip()

    for package in dispatch.packages:
        package.status = PackageStatus.DELIVERED.value

    # Acknowledging the consignment acknowledges what it was carrying. Without this
    # the two documents drift: the dispatch reads ACKNOWLEDGED while the issue it
    # came from still reads DISPATCHED, and the indent never closes.
    #
    # Closing the INDENT is the separate question, and only the last leg may answer it.
    # A consignment addressed to an MDP on its way to a LIP ends this issue's journey —
    # it reached the point it was sent to — but the requester still has nothing, so the
    # indent stays open until the MDP forwards it on and the LIP signs for it there.
    if dispatch.ref_type == WarehouseDocType.WH_ISSUE.value and dispatch.ref_id:
        issue = await db.get(m.MaterialIssue, dispatch.ref_id)
        if issue is not None and issue.status in (
            IssueStatus.ISSUED.value, IssueStatus.DISPATCHED.value,
        ):
            issue.status = IssueStatus.ACKNOWLEDGED.value
            issue.acknowledged_by_name = dispatch.acknowledged_by_name
            issue.acknowledged_at = dispatch.acknowledged_at
            if await _is_final_delivery_leg(db, issue, dispatch):
                await _close_indents_on_issue(db, issue, user)

    return short


async def cancel_dispatch(db: AsyncSession, dispatch_id: int, reason: str | None,
                          user) -> m.Dispatch:
    dispatch = await get_dispatch(db, dispatch_id)
    _guard(dispatch.status,
           {DispatchStatus.DRAFT.value, DispatchStatus.PENDING_APPROVAL.value,
            DispatchStatus.APPROVED.value, DispatchStatus.PACKED.value},
           "cancel", "dispatch")

    before = {"status": dispatch.status}
    dispatch.status = DispatchStatus.CANCELLED.value
    dispatch.remarks = f"{dispatch.remarks or ''}\nCancelled: {reason or '—'}".strip()

    await write_audit(db, entity="out_dispatches", entity_id=dispatch.id,
                      entity_no=dispatch.dispatch_no, action=AuditAction.UPDATE, actor=user,
                      before=before, after={"status": dispatch.status, "reason": reason})
    await db.commit()
    return await get_dispatch(db, dispatch_id)


# ---------------------------------------------------------------------------
# Purchase returns
# ---------------------------------------------------------------------------

def _return_totals(doc: m.PurchaseReturn) -> None:
    doc.total_items = len(doc.items)
    doc.total_qty = sum((_d(l.quantity) for l in doc.items), ZERO)
    doc.total_value = sum((_d(l.amount) for l in doc.items), ZERO)


async def _apply_return_lines(db: AsyncSession, doc: m.PurchaseReturn,
                              lines: list[s.ReturnItemWrite]) -> None:
    """Replaces the lines, capped at what the GRN actually rejected.

    Returning more than was received is the mistake this document exists to prevent,
    so the cap is enforced here rather than trusted from the screen.
    """
    caps: dict[int, Decimal] = {}
    if doc.grn_id:
        receipt = await _load(db, m.Receipt, doc.grn_id, "Receipt", m.Receipt.items)
        caps = {l.id: _d(l.rejected_qty) for l in receipt.items}
        already_rows = (await db.execute(
            select(
                m.PurchaseReturnItem.grn_item_id,
                func.coalesce(func.sum(m.PurchaseReturnItem.quantity), 0),
            )
            .join(
                m.PurchaseReturn,
                m.PurchaseReturn.id == m.PurchaseReturnItem.return_id,
            )
            .where(
                m.PurchaseReturn.grn_id == doc.grn_id,
                m.PurchaseReturn.id != doc.id,
                m.PurchaseReturn.status != ReturnStatus.CANCELLED.value,
                m.PurchaseReturnItem.grn_item_id.isnot(None),
            )
            .group_by(m.PurchaseReturnItem.grn_item_id)
        )).all()
        for grn_item_id, returned in already_rows:
            caps[grn_item_id] = max(
                caps.get(grn_item_id, ZERO) - _d(returned), ZERO
            )

    doc.items.clear()
    await db.flush()

    for index, line in enumerate(lines, start=1):
        item = await _item_snapshot(db, line.item_id)
        qty = _d(line.quantity)
        if qty <= ZERO:
            raise ValidationError(f"Line {index}: quantity must be positive")

        cap = caps.get(line.grn_item_id) if line.grn_item_id else None
        if cap is not None and qty > cap:
            raise ValidationError(
                f"{item.code}: only {cap} rejected quantity remains returnable; "
                f"{qty} cannot be returned against it.")

        batch = await db.get(m.Batch, line.batch_id) if line.batch_id else None
        rate = _d(line.rate)
        doc.items.append(m.PurchaseReturnItem(
            line_no=index, po_item_id=line.po_item_id, grn_item_id=line.grn_item_id,
            item_id=item.id, item_code=item.code, item_name=item.name, uom_code=item.uom_code,
            batch_id=line.batch_id, batch_no=batch.batch_no if batch else None,
            quantity=qty, rate=rate or None, amount=(qty * rate) if rate else None,
            reason=line.reason,
        ))
    _return_totals(doc)


async def list_returns(db: AsyncSession, params: PageParams, *, status: str | None = None,
                       warehouse_id: int | None = None, search: str | None = None, user=None) -> dict:
    stmt = select(m.PurchaseReturn)
    if user is not None:
        stmt = stmt.where(await scope_condition(
            db, user,
            warehouse_col=m.PurchaseReturn.warehouse_id,
            warehouse_ids=await warehouse_ids_for_user(db, user),
            owner_col=m.PurchaseReturn.created_by_id,
        ))
    if status:
        stmt = stmt.where(m.PurchaseReturn.status == status)
    if warehouse_id:
        stmt = stmt.where(m.PurchaseReturn.warehouse_id == warehouse_id)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(
            m.PurchaseReturn.return_no.ilike(like), m.PurchaseReturn.grn_no.ilike(like),
            m.PurchaseReturn.vendor_name.ilike(like),
            m.PurchaseReturn.credit_note_no.ilike(like)))
    return await paginate(db, stmt.order_by(m.PurchaseReturn.id.desc()), params)


async def get_return(db: AsyncSession, return_id: int, user=None) -> m.PurchaseReturn:
    doc = await _load(db, m.PurchaseReturn, return_id, "Return", m.PurchaseReturn.items)
    return await _decorate_can_approve(
        db, doc, WarehouseDocType.PURCHASE_RETURN.value, user)


async def create_return(db: AsyncSession, data: s.ReturnWrite, user) -> m.PurchaseReturn:
    if not data.items:
        raise ValidationError("A return with no lines sends nothing back")

    receipt = await db.get(m.Receipt, data.grn_id) if data.grn_id else None
    vendor = await db.get(Vendor, data.vendor_id) if data.vendor_id else None
    wh = await db.get(Warehouse, data.warehouse_id) if data.warehouse_id else None

    doc = m.PurchaseReturn(
        items=[],   # see create_issue: keeps _apply_*_lines()'s clear() off a lazy load
        return_no=await next_number(db, WarehouseDocType.PURCHASE_RETURN.value),
        return_date=data.return_date,
        po_id=data.po_id or (receipt.po_id if receipt else None),
        po_no=receipt.po_no if receipt else None,
        grn_id=data.grn_id, grn_no=receipt.grn_no if receipt else None,
        vendor_id=data.vendor_id or (receipt.vendor_id if receipt else None),
        vendor_name=vendor.name if vendor else (receipt.vendor_name if receipt else None),
        warehouse_id=data.warehouse_id or (receipt.warehouse_id if receipt else None),
        warehouse_name=wh.name if wh else (receipt.warehouse_name if receipt else None),
        reason=data.reason,
        status=ReturnStatus.DRAFT.value,
        created_by_id=getattr(user, "id", None), created_by_name=_name(user),
    )
    db.add(doc)
    await db.flush()

    await _apply_return_lines(db, doc, data.items)
    await db.flush()

    await write_audit(db, entity="pro_returns", entity_id=doc.id, entity_no=doc.return_no,
                      action=AuditAction.CREATE, actor=user,
                      after={"status": doc.status, "total_qty": str(doc.total_qty)})
    await db.commit()
    return await get_return(db, doc.id)


async def update_return(db: AsyncSession, return_id: int, data: s.ReturnWrite,
                        user) -> m.PurchaseReturn:
    doc = await get_return(db, return_id)
    _guard(doc.status, {ReturnStatus.DRAFT.value}, "edit", "return")

    before = {"total_qty": str(doc.total_qty)}
    doc.return_date = data.return_date
    doc.reason = data.reason
    if data.grn_id and data.grn_id != doc.grn_id:
        receipt = await db.get(m.Receipt, data.grn_id)
        doc.grn_id = data.grn_id
        doc.grn_no = receipt.grn_no if receipt else None

    await _apply_return_lines(db, doc, data.items)
    await db.flush()

    await write_audit(db, entity="pro_returns", entity_id=doc.id, entity_no=doc.return_no,
                      action=AuditAction.UPDATE, actor=user, before=before,
                      after={"total_qty": str(doc.total_qty)})
    await db.commit()
    return await get_return(db, return_id)


async def submit_return(db: AsyncSession, return_id: int, user) -> m.PurchaseReturn:
    doc = await get_return(db, return_id)
    _guard(doc.status, {ReturnStatus.DRAFT.value}, "submit", "return")

    context = {"warehouse_id": doc.warehouse_id, "total_value": float(_d(doc.total_value)),
               "vendor_id": doc.vendor_id}
    context.update({
        "doc_no": doc.return_no,
        "doc_summary": f"Purchase return {doc.return_no}",
        "requester_position_id": getattr(user, "active_position_id", None),
    })
    instance = await engine.start(
        db, WarehouseDocType.PURCHASE_RETURN.value, doc.id, context, user
    )
    doc.status = (
        ReturnStatus.APPROVED.value
        if instance.status == InstanceStatus.APPROVED.value
        else ReturnStatus.PENDING_APPROVAL.value
    )

    await write_audit(db, entity="pro_returns", entity_id=doc.id, entity_no=doc.return_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": ReturnStatus.DRAFT.value},
                      after={"status": doc.status})
    await db.commit()
    return await get_return(db, return_id)


async def act_on_return(
    db: AsyncSession, return_id: int, action: str, comments: str, user,
) -> m.PurchaseReturn:
    doc = await get_return(db, return_id)
    _guard(
        doc.status, {ReturnStatus.PENDING_APPROVAL.value},
        action.lower(), "return",
    )
    before = doc.status
    instance = await engine.act(
        db,
        WarehouseDocType.PURCHASE_RETURN.value,
        doc.id,
        action,
        user,
        comments,
        context={
            "doc_no": doc.return_no,
            "doc_summary": f"Purchase return {doc.return_no}",
            "warehouse_id": doc.warehouse_id,
            "vendor_id": doc.vendor_id,
            "total_value": float(_d(doc.total_value)),
        },
    )
    if instance.status == InstanceStatus.APPROVED.value:
        doc.status = ReturnStatus.APPROVED.value
    elif instance.status == InstanceStatus.REJECTED.value:
        doc.status = ReturnStatus.REJECTED.value

    await write_audit(
        db, entity="pro_returns", entity_id=doc.id, entity_no=doc.return_no,
        action=AuditAction.UPDATE, actor=user,
        before={"status": before},
        after={"status": doc.status, "comments": comments},
    )
    await db.commit()
    return await get_return(db, return_id)


async def complete_return(db: AsyncSession, return_id: int, credit_note_no: str | None,
                          user) -> m.PurchaseReturn:
    """Closes the physical vendor return.

    QC-rejected quantities never entered available inventory, so sending those back
    must not subtract them a second time. A manual/posted-stock return line still
    moves OUT through move_stock().
    """
    doc = await get_return(db, return_id)
    _guard(doc.status, {ReturnStatus.APPROVED.value, ReturnStatus.DISPATCHED.value},
           "complete", "return")

    rejected_line_ids: set[int] = set()
    if doc.grn_id:
        receipt = await _load(db, m.Receipt, doc.grn_id, "Receipt", m.Receipt.items)
        rejected_line_ids = {
            line.id for line in receipt.items if _d(line.rejected_qty) > ZERO
        }

    for line in doc.items:
        qty = _d(line.quantity)
        if qty <= ZERO:
            continue
        if line.grn_item_id in rejected_line_ids:
            continue
        await move_stock_out(
            db, item_id=line.item_id, qty=qty,
            ref_type=InventoryRefType.PURCHASE_RETURN.value, ref_id=doc.id,
            ref_no=doc.return_no, user=user,
            warehouse_id=doc.warehouse_id,
            batch_id=line.batch_id,
        )

    doc.credit_note_no = credit_note_no or doc.credit_note_no
    doc.status = ReturnStatus.COMPLETED.value

    await write_audit(db, entity="pro_returns", entity_id=doc.id, entity_no=doc.return_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": ReturnStatus.APPROVED.value},
                      after={"status": doc.status, "credit_note_no": doc.credit_note_no,
                             "total_qty": str(doc.total_qty)})
    await db.commit()
    return await get_return(db, return_id)


async def cancel_return(db: AsyncSession, return_id: int, reason: str | None,
                        user) -> m.PurchaseReturn:
    doc = await get_return(db, return_id)
    _guard(doc.status,
           {ReturnStatus.DRAFT.value, ReturnStatus.PENDING_APPROVAL.value,
            ReturnStatus.APPROVED.value},
           "cancel", "return")
    before = {"status": doc.status}
    doc.status = ReturnStatus.CANCELLED.value
    doc.reason = f"{doc.reason or ''}\nCancelled: {reason or '—'}".strip()

    await write_audit(db, entity="pro_returns", entity_id=doc.id, entity_no=doc.return_no,
                      action=AuditAction.UPDATE, actor=user, before=before,
                      after={"status": doc.status, "reason": reason})
    await db.commit()
    return await get_return(db, return_id)


async def returnable_lines(db: AsyncSession, grn_id: int) -> list[m.ReceiptItem]:
    """The rejected lines of a GRN — the only ones a return may be raised against."""
    receipt = await _load(db, m.Receipt, grn_id, "Receipt", m.Receipt.items)
    return [l for l in receipt.items if _d(l.rejected_qty) > ZERO]


# ---------------------------------------------------------------------------
# Serials, batches, scanning
# ---------------------------------------------------------------------------

async def list_serials(db: AsyncSession, params: PageParams, *, status: str | None = None,
                       item_id: int | None = None, batch_id: int | None = None,
                       warehouse_id: int | None = None, bin_id: int | None = None,
                       search: str | None = None, user=None) -> dict:
    stmt = select(m.SerialNumber)
    if user is not None:
        stmt = stmt.where(await scope_condition(
            db, user,
            warehouse_col=m.SerialNumber.warehouse_id,
            warehouse_ids=await warehouse_ids_for_user(db, user),
        )).where(m.SerialNumber.is_active.is_(True))
    if status:
        stmt = stmt.where(m.SerialNumber.status == status)
    if item_id:
        stmt = stmt.where(m.SerialNumber.item_id == item_id)
    if batch_id:
        stmt = stmt.where(m.SerialNumber.batch_id == batch_id)
    if warehouse_id:
        stmt = stmt.where(m.SerialNumber.warehouse_id == warehouse_id)
    if bin_id:
        stmt = stmt.where(m.SerialNumber.bin_id == bin_id)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(
            m.SerialNumber.serial_number.ilike(like),
            m.SerialNumber.imei.ilike(like),
            m.SerialNumber.asset_code.ilike(like),
            m.SerialNumber.consumable_code.ilike(like)))

    page = await paginate(db, stmt.order_by(m.SerialNumber.id.desc()), params)
    page["items"] = [await _decorate_serial(db, row) for row in page["items"]]
    return page


async def serial_summary(db: AsyncSession, *, item_ids: list[int],
                         warehouse_ids: list[int] | None = None,
                         user=None) -> list[dict]:
    """Serials and their asset/consumable codes, grouped by item and stocking point.

    The stock screens live in inventory, which may not import this module (rule 5) and
    has nowhere to keep a per-unit identity: `stk_balance` is one row per LOT and a lot
    here holds up to 88 serials, so its single `serial_number` column cannot answer
    "which units are these". Rather than denormalise 10,000 serials into a column that
    only fits one, the screens ask this endpoint for the page they are showing and
    merge — the same shape as the KPI summary calls beside them.

    Returns a few sample codes plus the count, which is what a list row can show; the
    full list is one `/serials?item_id=&warehouse_id=` call away for the detail panel.
    """
    if not item_ids:
        return []
    stmt = (
        select(m.SerialNumber.item_id, m.SerialNumber.warehouse_id,
               m.SerialNumber.bin_id, m.SerialNumber.batch_id,
               m.SerialNumber.serial_number, m.SerialNumber.imei,
               m.SerialNumber.asset_code, m.SerialNumber.consumable_code)
        .where(m.SerialNumber.item_id.in_(item_ids),
               m.SerialNumber.is_active.is_(True))
        .order_by(m.SerialNumber.id)
    )
    if warehouse_ids:
        stmt = stmt.where(m.SerialNumber.warehouse_id.in_(warehouse_ids))
    if user is not None:
        stmt = stmt.where(await scope_condition(
            db, user,
            warehouse_col=m.SerialNumber.warehouse_id,
            warehouse_ids=await warehouse_ids_for_user(db, user),
        ))

    # Which of these items the master says actually carry a per-unit identity. A unit
    # row for a MEASURED item (cotton in grams, spirit in litres) still holds a real
    # putaway code — the label on the package a storekeeper shelved — but its serial
    # number is an artefact: you cannot serialise a gram. `serial_number` is UNIQUE and
    # NOT NULL on the table, so the artefact cannot be blanked in place; it is
    # suppressed here instead, which keeps the row's key and its code intact.
    tracked = {r[0] for r in (await db.execute(
        select(Item.id).where(Item.id.in_(item_ids),
                              Item.is_serial_tracked.is_(True))
    )).all()}

    # Keyed down to the BIN and the BATCH, not just the stocking point: "which units
    # are in this bin" is the question the stock screens are actually asked, and one
    # warehouse holds the same item in several bins. The caller indexes the result
    # from the most specific key it has down to item+warehouse, so a serial row that
    # has not been given a bin yet (most of the live data) still finds its lot.
    grouped: dict[tuple, dict] = {}
    for (item_id, warehouse_id, bin_id, batch_id,
         serial, imei, asset, consumable) in (await db.execute(stmt)).all():
        key = (item_id, warehouse_id, bin_id, batch_id)
        bucket = grouped.setdefault(key, {
            "item_id": item_id, "warehouse_id": warehouse_id,
            "bin_id": bin_id, "batch_id": batch_id,
            "count": 0, "serials": [], "imeis": [], "codes": [],
            # Split by kind as well as merged: the stock ledger gives an asset code and
            # a consumable code a column each, and one unit is only ever one of the two.
            "asset_codes": [], "consumable_codes": [],
            "asset_count": 0, "consumable_count": 0,
        })
        bucket["count"] += 1
        # Five is enough to recognise the lot; the rest are behind the detail panel.
        if serial and item_id in tracked and len(bucket["serials"]) < 5:
            bucket["serials"].append(serial)
        if imei and item_id in tracked and len(bucket["imeis"]) < 5:
            bucket["imeis"].append(imei)
        code = asset or consumable
        if code and len(bucket["codes"]) < 5:
            bucket["codes"].append(code)
        if asset:
            bucket["asset_count"] += 1
            if len(bucket["asset_codes"]) < 5:
                bucket["asset_codes"].append(asset)
        elif consumable:
            bucket["consumable_count"] += 1
            if len(bucket["consumable_codes"]) < 5:
                bucket["consumable_codes"].append(consumable)
    return list(grouped.values())


async def unit_lookup(db: AsyncSession, code: str, user=None) -> dict:
    """Everything known about ONE physical unit, found by any identity it carries.

    Serial, IMEI, asset code or consumable code — a store user has whichever one is
    printed on the label in front of them, and should not have to know which kind it
    is. Exact match first so a full code never loses to a partial one, then a prefix
    match so a half-typed code still finds its unit.
    """
    value = (code or "").strip()
    if not value:
        raise ValidationError("Enter a serial, IMEI, asset code or consumable code")

    cols = (m.SerialNumber.serial_number, m.SerialNumber.imei,
            m.SerialNumber.asset_code, m.SerialNumber.consumable_code)
    base = select(m.SerialNumber).where(m.SerialNumber.is_active.is_(True))
    if user is not None:
        base = base.where(await scope_condition(
            db, user,
            warehouse_col=m.SerialNumber.warehouse_id,
            warehouse_ids=await warehouse_ids_for_user(db, user),
        ))

    row = await db.scalar(base.where(or_(*(c == value for c in cols))))
    if row is None:
        row = await db.scalar(
            base.where(or_(*(c.ilike(f"{value}%") for c in cols)))
            .order_by(m.SerialNumber.id))
    # "Nothing carries this" is an ordinary answer to a search box, not a fault: the
    # stock screens ask on every keystroke, and raising here would file a 404 in
    # sys_app_logs for every word anyone typed while looking for an item by name.
    if row is None:
        return {"found": False, "matched": value}

    unit = await _decorate_serial(db, row)
    unit["found"] = True
    unit["matched"] = value
    return unit


async def _decorate_serial(db: AsyncSession, row: m.SerialNumber) -> dict:
    item = await db.get(Item, row.item_id)
    wh = await db.get(Warehouse, row.warehouse_id) if row.warehouse_id else None
    batch = await db.get(m.Batch, row.batch_id) if row.batch_id else None
    return {
        "id": row.id, "item_id": row.item_id,
        "item_code": item.code if item else None,
        "item_name": item.name if item else None,
        "is_asset": bool(getattr(item, "is_asset", False)) if item else False,
        "serial_number": row.serial_number,
        "imei": row.imei,
        "batch_id": row.batch_id, "batch_no": batch.batch_no if batch else None,
        "mfg_date": batch.mfg_date if batch else None,
        "expiry_date": batch.expiry_date if batch else None,
        "warehouse_id": row.warehouse_id, "warehouse_name": wh.name if wh else None,
        "bin_id": row.bin_id, "bin_code": await _bin_code(db, row.bin_id),
        "bin_floor_level": await _bin_floor(db, row.bin_id),
        "asset_code": row.asset_code, "consumable_code": row.consumable_code,
        "status": row.status, "remarks": row.remarks, "is_active": row.is_active,
    }


async def list_batches(db: AsyncSession, params: PageParams, *, item_id: int | None = None,
                       expiring_days: int | None = None, search: str | None = None,
                       user=None) -> dict:
    """FIXED 2026-08-20 — was unscoped. `whs_batches` carries the VENDOR a batch came
    from and the GRN it landed on, so an unscoped register told every stock viewer who
    supplies which branch. It has no warehouse column of its own, so it is bounded
    through the stock that actually holds the batch — the same warehouse rung the
    balance grid uses, which keeps the two screens agreeing about which shelves a login
    owns."""
    stmt = select(m.Batch)
    if user is not None:
        allowed = await warehouse_ids_for_user(db, user)
        if allowed is not None:
            from app.modules.inventory.models import Stock
            stmt = stmt.where(m.Batch.id.in_(
                select(Stock.batch_id).where(Stock.warehouse_id.in_(allowed or {0}))))
    if item_id:
        stmt = stmt.where(m.Batch.item_id == item_id)
    if expiring_days is not None:
        cutoff = ist_today() + timedelta(days=expiring_days)
        stmt = stmt.where(m.Batch.expiry_date.isnot(None), m.Batch.expiry_date <= cutoff)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(
            m.Batch.batch_no.ilike(like), m.Batch.item_code.ilike(like),
            m.Batch.item_name.ilike(like), m.Batch.grn_no.ilike(like)))
    # MySQL has no `NULLS LAST` syntax. Sorting by the null predicate first is
    # portable and puts dated batches before undated ones.
    page = await paginate(
        db,
        stmt.order_by(m.Batch.expiry_date.is_(None), m.Batch.expiry_date.asc()),
        params,
    )
    item_ids = {row.item_id for row in page["items"]}
    if item_ids:
        rows = (await db.execute(select(Item.id, Item.is_asset).where(Item.id.in_(item_ids)))).all()
        asset_by_item = {item_id: bool(is_asset) for item_id, is_asset in rows}
        for row in page["items"]:
            row.is_asset = asset_by_item.get(row.item_id, False)
    return page


def _dispatch_destination(dispatch: m.Dispatch) -> str | None:
    return (dispatch.to_warehouse_name or dispatch.customer_name
            or dispatch.project_name or dispatch.delivery_address)


async def _dispatch_lines(db: AsyncSession, dispatch_id: int) -> list[m.DispatchItem]:
    return list((await db.scalars(
        select(m.DispatchItem).where(m.DispatchItem.dispatch_id == dispatch_id)
        .order_by(m.DispatchItem.line_no)
    )).all())


def _scan_line(line: m.DispatchItem, package_no: str | None = None,
               unit_code: str | None = None) -> s.ScanLine:
    return s.ScanLine(
        item_code=line.item_code, item_name=line.item_name, uom_code=line.uom_code,
        quantity=line.quantity or Decimal(0), batch_no=line.batch_no,
        serial_no=line.serial_no, package_no=package_no,
        imei_no=line.imei_no, expiry_date=line.expiry_date, unit_code=unit_code,
    )


async def _unit_codes(db: AsyncSession,
                      lines: list[m.DispatchItem]) -> dict[tuple[int, int | None], str]:
    """The asset / consumable code for each (item, batch) a scan is about to show.

    One query for the whole scan, not one per line. The codes live on `stk_balance`
    (put-away mints them there), and warehouse may not import inventory's service —
    rule 5 — so this reads the model directly and writes nothing.
    """
    # Imported here, as elsewhere in this file: the model is inventory's and a
    # module-level import of it is not worth widening for one lookup.
    from app.modules.inventory.models import Stock

    keys = {(line.item_id, line.batch_id) for line in lines if line.item_id}
    if not keys:
        return {}
    rows = (await db.execute(
        select(Stock.item_id, Stock.batch_id, Stock.asset_code, Stock.consumable_code)
        .where(Stock.item_id.in_({item_id for item_id, _ in keys}))
    )).all()
    found: dict[tuple[int, int | None], str] = {}
    for item_id, batch_id, asset_code, consumable_code in rows:
        code = asset_code or consumable_code
        if code:
            found.setdefault((item_id, batch_id), code)
    # Fall back to any code held for the item when the batch does not line up: an
    # allocation-drafted issue carries no batch_id, and "no code at all" is a worse
    # answer than the code the item's stock actually holds.
    by_item = {item_id: code for (item_id, _), code in found.items()}
    return {key: found.get(key) or by_item.get(key[0]) for key in keys
            if found.get(key) or by_item.get(key[0])}


async def _scanned_dispatch(db: AsyncSession, dispatch: m.Dispatch) -> s.ScanResult:
    """A consignment label answers with the cartons it holds."""
    lines = await _dispatch_lines(db, dispatch.id)
    packages = list((await db.scalars(
        select(m.DispatchPackage).where(m.DispatchPackage.dispatch_id == dispatch.id)
        .order_by(m.DispatchPackage.id)
    )).all())
    by_package: dict[int | None, list[m.DispatchItem]] = defaultdict(list)
    for line in lines:
        by_package[line.package_id].append(line)
    unit_codes = await _unit_codes(db, lines)

    return s.ScanResult(
        kind="DISPATCH", id=dispatch.id, doc_no=dispatch.dispatch_no,
        deep_link=f"/warehouse/dispatch/consignments/{dispatch.id}",
        title=f"Consignment {dispatch.dispatch_no}",
        subtitle=f"Material issue {dispatch.ref_no}" if dispatch.ref_no else None,
        status=dispatch.status,
        meta=[
            {"label": "From", "value": dispatch.warehouse_name},
            {"label": "Destination", "value": _dispatch_destination(dispatch)},
            {"label": "Date", "value": str(dispatch.dispatch_date) if dispatch.dispatch_date else None},
            {"label": "Vehicle", "value": dispatch.vehicle_number},
        ],
        packages=[
            s.ScanPackage(
                id=pkg.id, package_no=pkg.package_no, barcode=pkg.barcode,
                package_type=pkg.package_type, status=pkg.status,
                item_count=len(by_package.get(pkg.id, [])),
                quantity=sum((line.quantity or Decimal(0) for line in by_package.get(pkg.id, [])),
                             Decimal(0)),
                weight_kg=pkg.weight_kg, is_fragile=bool(pkg.is_fragile),
                is_temp_controlled=bool(pkg.is_temp_controlled),
            )
            for pkg in packages
        ],
        # Unpacked lines included: a consignment scanned mid-packing must still say
        # what it is carrying, not report an empty load.
        items=[_scan_line(line, unit_code=unit_codes.get((line.item_id, line.batch_id)))
               for line in lines],
        package_count=len(packages),
        item_count=len(lines),
        total_qty=sum((line.quantity or Decimal(0) for line in lines), Decimal(0)),
    )


async def _scanned_package(db: AsyncSession, value: str) -> s.ScanResult | None:
    """A carton label answers with the item codes, names and counts inside it.

    Matched on the stored barcode first, then on `<DISPATCH_NO>|<PACKAGE_NO>`, because
    the barcode a label prints is minted from the material issue's number while the
    fallback the screen renders uses the consignment's.
    """
    head, _, tail = value.partition("|")
    tail = tail.strip()
    pkg = await db.scalar(select(m.DispatchPackage).where(m.DispatchPackage.barcode == value))
    if not pkg and tail:
        pkg = await db.scalar(
            select(m.DispatchPackage)
            .join(m.Dispatch, m.Dispatch.id == m.DispatchPackage.dispatch_id)
            .where(m.Dispatch.dispatch_no == head, m.DispatchPackage.package_no == tail))
    if not pkg:
        return None

    dispatch = await db.get(m.Dispatch, pkg.dispatch_id)
    lines = [line for line in await _dispatch_lines(db, pkg.dispatch_id)
             if line.package_id == pkg.id]
    unit_codes = await _unit_codes(db, lines)
    return s.ScanResult(
        kind="PACKAGE", id=pkg.id, doc_no=pkg.barcode or pkg.package_no,
        deep_link=f"/warehouse/dispatch/consignments/{pkg.dispatch_id}",
        title=f"Package {pkg.package_no}",
        subtitle=f"Consignment {dispatch.dispatch_no}" if dispatch else None,
        status=pkg.status,
        meta=[
            {"label": "Type", "value": pkg.package_type},
            {"label": "Weight", "value": f"{pkg.weight_kg} kg" if pkg.weight_kg else None},
            {"label": "Consignment", "value": dispatch.dispatch_no if dispatch else None},
            {"label": "Destination", "value": _dispatch_destination(dispatch) if dispatch else None},
        ],
        items=[_scan_line(line, pkg.package_no,
                          unit_codes.get((line.item_id, line.batch_id)))
               for line in lines],
        item_count=len(lines),
        total_qty=sum((line.quantity or Decimal(0) for line in lines), Decimal(0)),
    )


async def scan(db: AsyncSession, code: str) -> s.ScanResult:
    """Works out what a scanned code is.

    One endpoint rather than one per kind, because a scanner cannot tell the operator
    which screen to be on first. Order matters: document numbers are checked before
    bins so a code that could be either resolves to the document someone scanned it
    from.

    A package label carries a pipe (`<ISSUE_OR_DISPATCH_NO>|PKG-01`) and no document
    number ever does, so the package lookup runs first: the head of a package label is
    the material issue's number, and without this it resolved to the issue instead of
    the carton that was actually in someone's hand.
    """
    value = (code or "").strip()
    if not value:
        raise ValidationError("Nothing was scanned")

    head = value.split("|")[0]

    if "|" in value:
        pkg = await _scanned_package(db, value)
        if pkg:
            return pkg

    dispatch = await db.scalar(select(m.Dispatch).where(m.Dispatch.dispatch_no == head))
    if dispatch:
        return await _scanned_dispatch(db, dispatch)

    receipt = await db.scalar(select(m.Receipt).where(
        or_(m.Receipt.grn_no == head, m.Receipt.gate_entry_no == head)))
    if receipt:
        return s.ScanResult(kind="RECEIPT", id=receipt.id, doc_no=receipt.grn_no,
                            deep_link=f"/warehouse/transactions/grn/{receipt.id}")

    issue = await db.scalar(select(m.MaterialIssue).where(m.MaterialIssue.issue_no == head))
    if issue:
        return s.ScanResult(kind="ISSUE", id=issue.id, doc_no=issue.issue_no,
                            deep_link=f"/warehouse/transactions/material-issues/{issue.id}")

    serial = await db.scalar(select(m.SerialNumber).where(
        or_(m.SerialNumber.serial_number == value, m.SerialNumber.asset_code == value,
            m.SerialNumber.consumable_code == value)))
    if serial:
        return s.ScanResult(kind="SERIAL", id=serial.id, doc_no=serial.serial_number,
                            deep_link="/warehouse/stock-segregation")

    bin_row = await db.scalar(select(Bin).where(Bin.code == value))
    if bin_row:
        return s.ScanResult(kind="BIN", id=bin_row.id, doc_no=bin_row.code, deep_link=None)

    raise NotFoundError(f"Nothing in the warehouse matches {value}")


# ---------------------------------------------------------------------------
# Attachments and notifications
# ---------------------------------------------------------------------------

# The implementation moved to platform/settings/attachments.py so indents can use the
# same store for delivery photos and bills. Re-exported under the names the warehouse
# router already calls, so its endpoints are unchanged.
list_attachments = attachments.list_attachments
add_attachment = attachments.add_attachment
attachment_file = attachments.attachment_file
delete_attachment = attachments.delete_attachment


async def list_notifications(db: AsyncSession, params: PageParams, user, *,
                             unread_only: bool = False) -> dict:
    stmt = select(m.Notification).where(m.Notification.employee_id == getattr(user, "id", 0))
    if unread_only:
        stmt = stmt.where(m.Notification.is_read.is_(False))
    return await paginate(db, stmt.order_by(m.Notification.id.desc()), params)


async def mark_notification_read(db: AsyncSession, notification_id: int,
                                 user) -> m.Notification:
    row = await _get(db, m.Notification, notification_id, "Notification")
    if row.employee_id != getattr(user, "id", None):
        raise NotFoundError(f"Notification {notification_id} not found")
    row.is_read = True
    await db.commit()
    await db.refresh(row)
    return row


async def mark_all_notifications_read(db: AsyncSession, user) -> dict:
    rows = (await db.execute(
        select(m.Notification).where(
            m.Notification.employee_id == getattr(user, "id", 0),
            m.Notification.is_read.is_(False))
    )).scalars().all()
    for row in rows:
        row.is_read = True
    await db.commit()
    return {"updated": len(rows)}


# ---------------------------------------------------------------------------
# Acknowledgements owed by a requester
# ---------------------------------------------------------------------------

# Statuses at which a consignment has physically left the warehouse. Before these it is
# still on site however finished the paperwork looks.
_ON_THE_ROAD = (
    DispatchStatus.DISPATCHED.value,
    DispatchStatus.IN_TRANSIT.value,
    DispatchStatus.DELIVERED.value,
    DispatchStatus.ACKNOWLEDGED.value,
)


def _pending_with(approved: Decimal, issued: Decimal, dispatched: Decimal,
                  received: Decimal, indent_status: str) -> str | None:
    """Plain-English answer to "where is the rest of my stuff".

    Read top-down: the nearest place the goods have got to is the honest answer. Derived
    at read time from the issue and dispatch state, never stored, so it cannot go stale
    behind the documents it describes.
    """
    if received >= approved:
        return None
    if dispatched > received:
        return "On the way to you"
    if issued > dispatched:
        return "Issued, waiting to be dispatched"
    if indent_status in (IndentStatus.PENDING_PROCUREMENT.value,
                         IndentStatus.PARTIALLY_ORDERED.value,
                         IndentStatus.ORDERED.value):
        return "With procurement"
    return "In the warehouse, not yet issued"


def _relayed_onward():
    """True for an issue line whose goods did NOT stop at the delivery point.

    WH -> MDP -> LIP is one indent served by TWO posted issues, both carrying the same
    `indent_item_id`. Summing them told the requester an approved quantity of 1 had
    been issued twice — "2 waiting for you to confirm" against a single unit.

    The leg that must not count is the one whose dispatch handed the goods to another
    stocking point WHICH THEN ISSUED THEM ON. Both halves matter: a dispatch to a LIP
    also names a `to_warehouse_id`, and dropping every leg with one would have blanked
    the direct WH -> LIP flow, where that first leg is the whole delivery.

    Correlated per LINE, not per document: a consignment part-forwarded and part-held
    at the MDP should count only what actually moved on.
    """
    onward = aliased(m.MaterialIssue)
    onward_line = aliased(m.MaterialIssueLine)
    return (
        select(onward_line.id)
        .select_from(m.Dispatch)
        .join(onward, and_(
            onward.warehouse_id == m.Dispatch.to_warehouse_id,
            onward.id != m.Dispatch.ref_id,
            onward.direction == IssueDirection.OUT.value,
            onward.is_stock_posted.is_(True),
        ))
        .join(onward_line, and_(
            onward_line.issue_id == onward.id,
            onward_line.indent_item_id == m.MaterialIssueLine.indent_item_id,
        ))
        .where(
            m.Dispatch.ref_id == m.MaterialIssueLine.issue_id,
            m.Dispatch.ref_type.in_(["ISSUE", WarehouseDocType.WH_ISSUE.value]),
            m.Dispatch.to_warehouse_id.isnot(None),
        )
        .exists()
    )


async def _delivery_rows(db: AsyncSession, indents: list) -> list[dict]:
    """Approved / issued / dispatched / received per line, for a set of indents.

    Shared by the requester's delivery list and by one indent's fulfilment trail, so the
    two can never disagree about how far an order has got.
    """
    from app.modules.indents.service import owed_quantity

    if not indents:
        return []

    indent_ids = [indent.id for indent in indents]
    relayed = _relayed_onward()
    # Posted issues only: a draft or in-approval issue has moved nothing, and showing it
    # as "issued" would tell the requester their goods are on the way when they are not.
    issued_rows = (await db.execute(
        select(m.MaterialIssueLine.indent_item_id,
               func.sum(m.MaterialIssueLine.issued_qty - func.coalesce(m.MaterialIssueLine.returned_qty, 0)))
        .join(m.MaterialIssue, m.MaterialIssue.id == m.MaterialIssueLine.issue_id)
        .where(m.MaterialIssue.indent_id.in_(indent_ids),
               m.MaterialIssue.direction == IssueDirection.OUT.value,
               m.MaterialIssue.is_stock_posted.is_(True),
               m.MaterialIssueLine.indent_item_id.isnot(None),
               ~relayed)
        .group_by(m.MaterialIssueLine.indent_item_id)
    )).all()
    issued_by_line = {row[0]: _d(row[1]) for row in issued_rows}

    dispatched_rows = (await db.execute(
        select(m.MaterialIssueLine.indent_item_id,
               func.sum(m.MaterialIssueLine.issued_qty - func.coalesce(m.MaterialIssueLine.returned_qty, 0)))
        .join(m.MaterialIssue, m.MaterialIssue.id == m.MaterialIssueLine.issue_id)
        .join(m.Dispatch, and_(
            m.Dispatch.ref_id == m.MaterialIssue.id,
            m.Dispatch.ref_type.in_(["ISSUE", WarehouseDocType.WH_ISSUE.value])))
        .where(m.MaterialIssue.indent_id.in_(indent_ids),
               m.MaterialIssue.is_stock_posted.is_(True),
               m.Dispatch.status.in_(_ON_THE_ROAD),
               m.MaterialIssueLine.indent_item_id.isnot(None),
               ~relayed)
        .group_by(m.MaterialIssueLine.indent_item_id)
    )).all()
    dispatched_by_line = {row[0]: _d(row[1]) for row in dispatched_rows}

    shipments = await _shipments_by_indent(db, indent_ids)

    out = []
    for indent in indents:
        lines = []
        for item in sorted(indent.items, key=lambda i: i.line_no or 0):
            approved = owed_quantity(item)
            received = _d(item.received_quantity)
            issued = issued_by_line.get(item.id, ZERO)
            dispatched = dispatched_by_line.get(item.id, ZERO)
            lines.append({
                "indent_item_id": item.id,
                "item_code": item.item_code,
                "item_name": item.item_name,
                "uom_code": item.uom_code,
                "approved_quantity": float(approved),
                "issued_quantity": float(issued),
                "dispatched_quantity": float(dispatched),
                "received_quantity": float(received),
                "pending_with": _pending_with(approved, issued, dispatched, received,
                                              indent.status),
            })
        out.append({
            "indent_id": indent.id,
            "indent_no": indent.indent_no,
            "indent_date": indent.indent_date,
            "required_date": indent.required_date,
            "status": indent.status,
            "priority": indent.priority,
            "project_name": indent.project_name,
            # Nothing has reached the requester yet, so there is nothing to confirm. The
            # row still shows, because "where is my stuff" is the other half of the job.
            "can_acknowledge": any(line["dispatched_quantity"] > line["received_quantity"]
                                   for line in lines),
            "lines": lines,
            # "Where is it and how do I follow it" — the courier docket and the
            # tracking link, on the same row as the confirm button. Without this the
            # requester was told a consignment had left and given no way to chase it.
            "shipments": shipments.get(indent.id, []),
        })
    return out


async def _shipments_by_indent(db: AsyncSession,
                               indent_ids: list[int]) -> dict[int, list[dict]]:
    """The transport legs carrying each of these indents, newest first.

    Read from `lgs_transport_requests` directly: logistics owns the leg and sits before
    this module in the import chain (rule 5), so reading it here is the allowed
    direction — and it keeps the requester's screen to one round trip.

    Matched on `indent_id` OR on the consignment the leg is carrying, because a leg
    raised against a consolidated consignment names the dispatch and not always an
    indent, and a requester whose parcel travelled in somebody else's carton still has
    to be able to track it.
    """
    from app.modules.logistics.models import TransportRequest

    if not indent_ids:
        return {}

    dispatch_rows = (await db.execute(
        select(m.Dispatch.id, m.MaterialIssue.indent_id)
        .join(m.MaterialIssue, and_(
            m.Dispatch.ref_id == m.MaterialIssue.id,
            m.Dispatch.ref_type.in_(["ISSUE", WarehouseDocType.WH_ISSUE.value])))
        .where(m.MaterialIssue.indent_id.in_(indent_ids),
               m.Dispatch.status != DispatchStatus.CANCELLED.value)
    )).all()
    indent_of_dispatch = {row[0]: row[1] for row in dispatch_rows}

    legs = (await db.execute(
        select(TransportRequest)
        .where(or_(TransportRequest.indent_id.in_(indent_ids),
                   TransportRequest.dispatch_id.in_(list(indent_of_dispatch) or [0])))
        .order_by(TransportRequest.id.desc())
    )).scalars().all()

    by_indent: dict[int, list[dict]] = {}
    for leg in legs:
        indent_id = leg.indent_id or indent_of_dispatch.get(leg.dispatch_id)
        if indent_id not in indent_ids:
            continue
        by_indent.setdefault(indent_id, []).append({
            "tr_id": leg.id,
            "tr_no": leg.tr_no,
            "mode": leg.mode,
            "status": leg.status,
            "carrier_name": leg.carrier_name,
            "vehicle_number": leg.vehicle_number,
            "driver_name": leg.driver_name,
            "driver_phone": leg.driver_phone,
            # The handle the field is given. A courier books on a docket, a truck on
            # an LR; the screen shows whichever one exists.
            "lr_no": leg.lr_no,
            "docket_no": leg.docket_no,
            "tracking_url": leg.tracking_url,
            "expected_delivery": leg.expected_delivery,
            "dispatched_at": leg.dispatched_at,
            "delivered_at": leg.delivered_at,
            "acknowledged_at": leg.acknowledged_at,
        })
    return by_indent


async def acknowledgements_for_requester(db: AsyncSession, user, *, search: str | None = None,
                                         status: str | None = None,
                                         only_actionable: bool = False) -> list[dict]:
    """Every indent this person raised that has reached the delivery stage.

    Served from the warehouse module because the evidence — what was issued, what was
    dispatched — lives in `out_issues` and `out_dispatches`. Indents may not import this
    module (rule 5), so the join happens on this side of the line and indents keeps
    ownership of the acknowledgement itself.

    CLOSED is included alongside the still-receiving statuses. Confirming the last line
    of an indent sets it CLOSED (`indents._fulfilment_status`), so listing only the
    receivable ones made a delivery vanish from this screen at the exact moment the
    requester finished with it — no record of what they had confirmed, and no way back
    to the photo they attached. `can_acknowledge` is already false for them, so they
    read as history; "Ready to confirm" still narrows to the ones that need work.
    """
    from app.modules.indents.models import Indent, IndentItem
    from app.modules.indents.service import _RECEIVABLE_STATUSES

    visible_statuses = tuple(_RECEIVABLE_STATUSES | {IndentStatus.CLOSED.value})
    # The person AND the hat they are wearing. `requested_by_id` alone identifies the
    # employee, and an employee holds more than one position — a storekeeper who also
    # drives read both sets of indents here from either session, because this endpoint
    # is the one indent list that does not go through `indent_access_condition` (which
    # ANDs exactly this predicate for exactly this reason). Nothing in RBAC could fix
    # it: no scope rung was ever consulted.
    #
    # A NULL `position_id` stays visible. Those are indents raised before the column
    # was written, they belong to no hat, and dropping them would take a requester's
    # own delivery off the only screen that confirms it.
    position_id = getattr(user, "active_position_id", None)
    stmt = (
        select(Indent)
        .options(selectinload(Indent.items))
        .where(Indent.requested_by_id == getattr(user, "id", 0),
               Indent.status.in_(visible_statuses))
    )
    if position_id is not None:
        stmt = stmt.where(or_(Indent.position_id == position_id,
                              Indent.position_id.is_(None)))
    if status:
        stmt = stmt.where(Indent.status == status)
    if search:
        like = f"%{search.strip()}%"
        # Item text as well as the indent number: people look for "the masks", not for
        # a document number they never memorised.
        stmt = stmt.where(or_(
            Indent.indent_no.ilike(like),
            Indent.project_name.ilike(like),
            select(IndentItem.id).where(
                IndentItem.indent_id == Indent.id,
                or_(IndentItem.item_code.ilike(like), IndentItem.item_name.ilike(like)),
            ).exists(),
        ))
    indents = list((await db.execute(stmt.order_by(Indent.id.desc()))).scalars().all())

    rows = await _delivery_rows(db, indents)
    if only_actionable:
        rows = [row for row in rows if row["can_acknowledge"]]
    return rows


async def indent_fulfilment(db: AsyncSession, indent_id: int) -> list[dict]:
    """The delivery half of an indent's journey, as stepper stages.

    The approval journey stops at "Ready for Allocation" — everything that physically
    happens to the goods after that lived only in the warehouse module and never showed
    on the indent. These are the missing steps.
    """
    from app.modules.indents.models import Indent

    indent = (await db.execute(
        select(Indent).options(selectinload(Indent.items)).where(Indent.id == indent_id)
    )).scalar_one_or_none()
    if indent is None:
        raise NotFoundError(f"Indent {indent_id} not found")

    rows = await _delivery_rows(db, [indent])
    if not rows:
        return []
    lines = rows[0]["lines"]

    owed = sum(line["approved_quantity"] for line in lines)
    issued = sum(line["issued_quantity"] for line in lines)
    dispatched = sum(line["dispatched_quantity"] for line in lines)
    received = sum(line["received_quantity"] for line in lines)

    # Delivered is a stronger claim than dispatched: the consignment has to have been
    # marked as arrived, not merely sent.
    delivered_docs = list((await db.execute(
        select(m.Dispatch.dispatch_no, m.Dispatch.status)
        .join(m.MaterialIssue, m.MaterialIssue.id == m.Dispatch.ref_id)
        .where(m.MaterialIssue.indent_id == indent_id,
               m.Dispatch.ref_type.in_(["ISSUE", WarehouseDocType.WH_ISSUE.value]),
               m.Dispatch.status.in_(_ON_THE_ROAD))
        .order_by(m.Dispatch.id.desc())
    )).all())
    delivered = any(row[1] in (DispatchStatus.DELIVERED.value,
                               DispatchStatus.ACKNOWLEDGED.value)
                    for row in delivered_docs)
    dispatch_label = ", ".join(row[0] for row in delivered_docs[:2]) or None

    def step(key, label, done, started, caption):
        # "current" means started but not finished — the stage somebody is waiting on.
        return {"key": key, "label": label, "caption": caption,
                "state": "completed" if done else "current" if started else "pending"}

    def part(moved: float) -> str:
        return f"{moved:g} of {owed:g}"

    return [
        step("allocated", "Stock allocated",
             indent.status != IndentStatus.AWAITING_ALLOCATION.value,
             True,
             indent.status.replace("_", " ").title()),
        step("issued", "Issued from store", issued >= owed and owed > 0, issued > 0,
             part(issued) if issued else "Not yet issued"),
        step("dispatched", "Dispatched", dispatched >= owed and owed > 0, dispatched > 0,
             dispatch_label or (part(dispatched) if dispatched else "Not yet sent")),
        step("delivered", "Delivered", delivered, dispatched > 0,
             "Arrived" if delivered else "In transit" if dispatched else "Not yet sent"),
        step("received", "Confirmed by requester",
             indent.status == IndentStatus.CLOSED.value, received > 0,
             part(received) if received else "Awaiting confirmation"),
    ]


# ---------------------------------------------------------------------------
# Dashboard and reports
# ---------------------------------------------------------------------------

async def dashboard(db: AsyncSession, warehouse_id: int | None = None, user=None) -> dict:
    """Queue depths in one call.

    The screen this feeds used to fire eight list requests and count the rows it got
    back, which meant every number was the size of the first page rather than the size
    of the queue.

    Every count is bounded by the warehouses this login may see — the same set
    `list_receipts`, `list_stock` and the rest of the module already use. Without it
    these tiles counted the whole network: "At gate 2" for a storekeeper with exactly
    one gate entry of their own, and no way to reach the other one from any screen.
    A tile has to agree with the list it links to.
    """
    from app.modules.inventory.models import Stock

    allowed = await warehouse_ids_for_user(db, user)

    def scoped(stmt, column):
        if warehouse_id:
            return stmt.where(column == warehouse_id)
        # None means unrestricted (admin, stock.view.all). An empty set means this
        # login reaches no warehouse at all, and every queue is genuinely zero.
        if allowed is not None:
            return stmt.where(column.in_(allowed) if allowed else false())
        return stmt

    async def count(model, column, *conditions) -> int:
        stmt = select(func.count()).select_from(model).where(*conditions)
        return int(await db.scalar(scoped(stmt, column)) or 0)

    pending_gate = await count(
        m.Receipt, m.Receipt.warehouse_id,
        m.Receipt.receipt_type == ReceiptType.GATE_ENTRY.value,
        m.Receipt.status == ReceiptStatus.GATE_ENTRY.value)
    pending_grn = await count(
        m.Receipt, m.Receipt.warehouse_id,
        m.Receipt.receipt_type == ReceiptType.PURCHASE.value,
        m.Receipt.status.in_([ReceiptStatus.DRAFT.value, ReceiptStatus.PENDING_QC.value]))
    pending_qc = await count(
        m.Inspection, m.Inspection.warehouse_id,
        m.Inspection.status.in_(_any_case(InspectionStatus.DRAFT.value,
                                          InspectionStatus.IN_PROGRESS.value)))
    pending_put = await count(
        m.PutawayTask, m.PutawayTask.warehouse_id,
        m.PutawayTask.status.in_([PutawayStatus.PENDING.value,
                                  PutawayStatus.IN_PROGRESS.value]),
        m.PutawayTask.is_active.is_(True))
    open_picks = await count(
        m.Picking, m.Picking.warehouse_id,
        m.Picking.status.in_([
            PickingStatus.DRAFT.value,
            PickingStatus.RELEASED.value,
            PickingStatus.IN_PROGRESS.value,
        ]))
    pending_issues = await count(
        m.MaterialIssue, m.MaterialIssue.warehouse_id,
        m.MaterialIssue.status.in_([IssueStatus.PENDING_APPROVAL.value, IssueStatus.APPROVED.value]))
    in_transit = await count(
        m.Dispatch, m.Dispatch.warehouse_id,
        m.Dispatch.status.in_([DispatchStatus.DISPATCHED.value,
                               DispatchStatus.IN_TRANSIT.value]))
    open_returns = await count(
        m.PurchaseReturn, m.PurchaseReturn.warehouse_id,
        m.PurchaseReturn.status.in_([ReturnStatus.DRAFT.value,
                                     ReturnStatus.PENDING_APPROVAL.value,
                                     ReturnStatus.APPROVED.value]))

    # The same costed value Inventory > Overview and the stock balance tiles report:
    # an uncosted row falls back to the item's last known price rather than counting
    # as worthless. Summing total_qty * valuation_rate here made this tile disagree
    # with Overview on the very same warehouse. The join is OUTER so a balance row
    # whose item has gone still contributes its qty at zero rather than vanishing.
    from app.shared.models.master import Item as _Item
    from app.modules.inventory.service import costed_value_sum

    if hasattr(Stock, "valuation_rate"):
        value_stmt = (
            select(costed_value_sum(Stock.total_qty, Stock.valuation_rate,
                                    _Item.purchase_price))
            .select_from(Stock)
            .outerjoin(_Item, _Item.id == Stock.item_id)
        )
    else:
        value_stmt = select(func.coalesce(func.sum(Stock.total_qty), 0))
    stock_value = _d(await db.scalar(scoped(value_stmt, Stock.warehouse_id)))

    # Utilisation is bins in use over active bins: capacity per item is not modelled,
    # so "how many bins are doing something" is the honest measure to show.
    bin_total = int(await db.scalar(
        scoped(select(func.count()).select_from(Bin).where(Bin.is_active.is_(True)),
               Bin.warehouse_id)) or 0)
    bin_used = int(await db.scalar(
        scoped(select(func.count(func.distinct(Stock.bin_id)))
               .where(Stock.bin_id != m.NO_BIN, Stock.total_qty > 0), Stock.warehouse_id)) or 0)
    utilisation = Decimal(round(bin_used * 100 / bin_total, 2)) if bin_total else ZERO

    # Both take the same bound as the tiles above: the activity list and the inward
    # chart sit on the same screen and must describe the same warehouses.
    recent = await _recent_activity(db, warehouse_id, allowed=allowed)
    trend = await _inward_trend(db, warehouse_id, allowed=allowed)

    return {
        "pending_gate_entries": pending_gate,
        "pending_grn": pending_grn,
        "pending_inspections": pending_qc,
        "pending_putaways": pending_put,
        "open_picklists": open_picks,
        "pending_issues": pending_issues,
        "in_transit_dispatches": in_transit,
        "open_returns": open_returns,
        "stock_value": stock_value,
        "bin_utilisation_percent": utilisation,
        "recent": recent,
        "inward_trend": trend,
    }


async def _recent_activity(db: AsyncSession, warehouse_id: int | None, limit: int = 10,
                           *, allowed: set[int] | None = None) -> list[dict]:
    """The last few documents across the whole chain, newest first.

    `allowed` is the caller's warehouse set (None = unrestricted). Without it this
    listed the newest receipts, issues and dispatches in the company on a screen the
    reader could not open a single one of them from.
    """
    out: list[dict] = []

    async def collect(model, no_column, doc_type: str) -> None:
        stmt = select(model).order_by(model.id.desc()).limit(limit)
        if hasattr(model, "warehouse_id"):
            if warehouse_id:
                stmt = stmt.where(model.warehouse_id == warehouse_id)
            elif allowed is not None:
                stmt = stmt.where(
                    model.warehouse_id.in_(allowed) if allowed else false())
        for row in (await db.execute(stmt)).scalars().all():
            out.append({
                "id": row.id, "doc_no": getattr(row, no_column),
                "doc_type": doc_type, "status": row.status,
                "created_at": getattr(row, "created_at", None),
            })

    await collect(m.Receipt, "grn_no", "RECEIPT")
    await collect(m.MaterialIssue, "issue_no", "ISSUE")
    await collect(m.Dispatch, "dispatch_no", "DISPATCH")

    def _sort_key(row: dict) -> datetime:
        """Sort on a single, comparable notion of "when".

        MySQL DATETIME columns come back naive, but rows written in the same session
        that set them from utcnow() are still tz-aware in the identity map. Mixing the
        two in one sort raises TypeError and takes the whole dashboard down with it,
        so both are flattened to naive UTC here rather than trusted to match.
        """
        value = row["created_at"]
        if value is None:
            return datetime.min
        return value.replace(tzinfo=None) if value.tzinfo else value

    out.sort(key=_sort_key, reverse=True)
    return out[:limit]


async def _inward_trend(db: AsyncSession, warehouse_id: int | None, days: int = 14,
                        *, allowed: set[int] | None = None) -> list[dict]:
    since = ist_today() - timedelta(days=days)
    stmt = (select(m.Receipt.grn_date,
                   func.coalesce(func.sum(m.Receipt.total_received_qty), 0),
                   func.coalesce(func.sum(m.Receipt.total_accepted_qty), 0),
                   func.coalesce(func.sum(m.Receipt.total_rejected_qty), 0))
            .where(m.Receipt.grn_date >= since,
                   m.Receipt.status != ReceiptStatus.CANCELLED.value)
            .group_by(m.Receipt.grn_date).order_by(m.Receipt.grn_date))
    if warehouse_id:
        stmt = stmt.where(m.Receipt.warehouse_id == warehouse_id)
    elif allowed is not None:
        stmt = stmt.where(
            m.Receipt.warehouse_id.in_(allowed) if allowed else false())

    return [{"date": str(row[0]), "received": float(_d(row[1])),
             "accepted": float(_d(row[2])), "rejected": float(_d(row[3]))}
            for row in (await db.execute(stmt)).all()]


def _col(key: str, header: str, numeric: bool = False) -> dict:
    return {"key": key, "header": header, "numeric": numeric}


async def run_report(db: AsyncSession, key: str, *, warehouse_id: int | None = None,
                     date_from: date | None = None, date_to: date | None = None) -> dict:
    """Reports carry their own columns, so adding one is a backend change alone.

    The screens this replaced hardcoded seven column layouts in the frontend, and two
    of them still had headings for columns the query had stopped returning.
    """
    if key == "inward-register":
        stmt = select(m.Receipt).where(m.Receipt.status != ReceiptStatus.CANCELLED.value)
        if warehouse_id:
            stmt = stmt.where(m.Receipt.warehouse_id == warehouse_id)
        if date_from:
            stmt = stmt.where(m.Receipt.grn_date >= date_from)
        if date_to:
            stmt = stmt.where(m.Receipt.grn_date <= date_to)
        rows = (await db.execute(stmt.order_by(m.Receipt.grn_date.desc()))).scalars().all()
        return {
            "columns": [_col("grn_no", "GRN"), _col("grn_date", "Date"),
                        _col("vendor_name", "Vendor"), _col("po_no", "PO"),
                        _col("total_received_qty", "Received", True),
                        _col("total_accepted_qty", "Accepted", True),
                        _col("total_rejected_qty", "Rejected", True),
                        _col("status", "Status")],
            "rows": [{"grn_no": r.grn_no, "grn_date": str(r.grn_date),
                      "vendor_name": r.vendor_name, "po_no": r.po_no,
                      "total_received_qty": float(_d(r.total_received_qty)),
                      "total_accepted_qty": float(_d(r.total_accepted_qty)),
                      "total_rejected_qty": float(_d(r.total_rejected_qty)),
                      "status": r.status} for r in rows],
            "total": len(rows),
        }

    if key == "qc-summary":
        stmt = select(m.Inspection)
        if warehouse_id:
            stmt = stmt.where(m.Inspection.warehouse_id == warehouse_id)
        if date_from:
            stmt = stmt.where(m.Inspection.inspection_date >= date_from)
        if date_to:
            stmt = stmt.where(m.Inspection.inspection_date <= date_to)
        rows = (await db.execute(stmt.order_by(m.Inspection.id.desc()))).scalars().all()
        return {
            "columns": [_col("inspection_no", "Inspection"), _col("inspection_date", "Date"),
                        _col("grn_no", "GRN"), _col("vendor_name", "Vendor"),
                        _col("total_items", "Lines", True), _col("passed_items", "Passed", True),
                        _col("failed_items", "Failed", True), _col("status", "Status")],
            "rows": [{"inspection_no": r.inspection_no,
                      "inspection_date": str(r.inspection_date), "grn_no": r.grn_no,
                      "vendor_name": r.vendor_name, "total_items": r.total_items,
                      "passed_items": r.passed_items, "failed_items": r.failed_items,
                      "status": r.status} for r in rows],
            "total": len(rows),
        }

    if key == "putaway-ageing":
        stmt = select(m.PutawayTask).where(
            m.PutawayTask.is_active.is_(True),
            m.PutawayTask.status.in_([PutawayStatus.PENDING.value,
                                      PutawayStatus.IN_PROGRESS.value]))
        if warehouse_id:
            stmt = stmt.where(m.PutawayTask.warehouse_id == warehouse_id)
        tasks = (await db.execute(stmt.order_by(m.PutawayTask.created_at))).scalars().all()
        rows = []
        for task in tasks:
            decorated = await _decorate_putaway(db, task)
            created = decorated["created_at"]
            age = (utcnow() - created).days if created else 0
            rows.append({"putaway_no": decorated["putaway_no"], "grn_no": decorated["grn_no"],
                         "item_code": decorated["item_code"], "item_name": decorated["item_name"],
                         "qty": float(_d(decorated["qty"])), "age_days": age,
                         "status": decorated["status"]})
        return {
            "columns": [_col("putaway_no", "Task"), _col("grn_no", "GRN"),
                        _col("item_code", "Item"), _col("item_name", "Description"),
                        _col("qty", "Quantity", True), _col("age_days", "Age (days)", True),
                        _col("status", "Status")],
            "rows": rows, "total": len(rows),
        }

    if key == "issue-register":
        stmt = select(m.MaterialIssue)
        if warehouse_id:
            stmt = stmt.where(m.MaterialIssue.warehouse_id == warehouse_id)
        if date_from:
            stmt = stmt.where(m.MaterialIssue.issue_date >= date_from)
        if date_to:
            stmt = stmt.where(m.MaterialIssue.issue_date <= date_to)
        rows = (await db.execute(stmt.order_by(m.MaterialIssue.id.desc()))).scalars().all()
        return {
            "columns": [_col("issue_no", "Issue"), _col("issue_date", "Date"),
                        _col("issued_to_name", "Issued to"),
                        _col("department_name", "Department"),
                        _col("indent_no", "Indent"), _col("total_qty", "Quantity", True),
                        _col("total_value", "Value", True), _col("status", "Status")],
            "rows": [{"issue_no": r.issue_no, "issue_date": str(r.issue_date),
                      "issued_to_name": r.issued_to_name, "department_name": r.department_name,
                      "indent_no": r.indent_no, "total_qty": float(_d(r.total_qty)),
                      "total_value": float(_d(r.total_value)), "status": r.status}
                     for r in rows],
            "total": len(rows),
        }

    if key == "dispatch-register":
        stmt = select(m.Dispatch)
        if warehouse_id:
            stmt = stmt.where(m.Dispatch.warehouse_id == warehouse_id)
        if date_from:
            stmt = stmt.where(m.Dispatch.dispatch_date >= date_from)
        if date_to:
            stmt = stmt.where(m.Dispatch.dispatch_date <= date_to)
        rows = (await db.execute(stmt.order_by(m.Dispatch.id.desc()))).scalars().all()
        return {
            "columns": [_col("dispatch_no", "Dispatch"), _col("dispatch_date", "Date"),
                        _col("destination", "To"), _col("vehicle_number", "Vehicle"),
                        _col("total_packages", "Packages", True),
                        _col("total_qty", "Quantity", True),
                        _col("expected_delivery", "Expected"), _col("status", "Status")],
            "rows": [{"dispatch_no": r.dispatch_no, "dispatch_date": str(r.dispatch_date),
                      "destination": r.to_warehouse_name or r.customer_name or r.vendor_name,
                      "vehicle_number": r.vehicle_number,
                      "total_packages": r.total_packages,
                      "total_qty": float(_d(r.total_qty)),
                      "expected_delivery": str(r.expected_delivery) if r.expected_delivery else None,
                      "status": r.status} for r in rows],
            "total": len(rows),
        }

    if key == "bin-utilisation":
        from app.modules.inventory.models import Stock
        # Only real bins hold stock, so only real bins have a utilisation. A lane or a
        # rack appearing at 0% would read as an empty bin rather than as scaffolding.
        stmt = select(Bin).where(Bin.is_active.is_(True), Bin.bin_type.in_(m.BIN_TYPES))
        if warehouse_id:
            stmt = stmt.where(Bin.warehouse_id == warehouse_id)
        bins = (await db.execute(stmt.order_by(Bin.code))).scalars().all()

        # Ancestry for the Path column. One extra query for the whole tree beats walking
        # up from each bin, and the path is derived rather than stored so it cannot rot.
        ancestry = {
            r.id: (r.code, r.parent_id)
            for r in (await db.execute(select(Bin))).scalars().all()
        }

        def full_path(bin_id: int) -> str:
            parts, seen = [], set()
            current = bin_id
            while current in ancestry and current not in seen:
                seen.add(current)                 # a cycle in the data must not hang us
                code, parent = ancestry[current]
                parts.append(code)
                current = parent
            return "/".join(reversed(parts))

        rows = []
        for b in bins:
            held = _d(await db.scalar(
                select(func.coalesce(func.sum(Stock.total_qty), 0)).where(Stock.bin_id == b.id)))
            capacity = _d(b.capacity_qty)
            rows.append({
                "code": b.code, "name": b.name, "path": full_path(b.id),
                "capacity_qty": float(capacity), "occupied_qty": float(held),
                "utilisation": float(round(held * 100 / capacity, 2)) if capacity else 0.0,
                "is_pickable": "Yes" if b.is_pickable else "No",
            })
        return {
            "columns": [_col("code", "Bin"), _col("name", "Name"), _col("path", "Path"),
                        _col("capacity_qty", "Capacity", True),
                        _col("occupied_qty", "Occupied", True),
                        _col("utilisation", "Utilisation %", True),
                        _col("is_pickable", "Pickable")],
            "rows": rows, "total": len(rows),
        }

    if key == "batch-expiry":
        stmt = select(m.Batch).where(m.Batch.expiry_date.isnot(None))
        if date_to:
            stmt = stmt.where(m.Batch.expiry_date <= date_to)
        rows = (await db.execute(stmt.order_by(m.Batch.expiry_date))).scalars().all()
        today = ist_today()
        return {
            "columns": [_col("batch_no", "Batch"), _col("item_code", "Item"),
                        _col("item_name", "Description"), _col("vendor_name", "Vendor"),
                        _col("expiry_date", "Expires"), _col("days_left", "Days left", True),
                        _col("initial_qty", "Received", True), _col("status", "Status")],
            "rows": [{"batch_no": r.batch_no, "item_code": r.item_code,
                      "item_name": r.item_name, "vendor_name": r.vendor_name,
                      "expiry_date": str(r.expiry_date),
                      "days_left": (r.expiry_date - today).days,
                      "initial_qty": float(_d(r.initial_qty)), "status": r.status}
                     for r in rows],
            "total": len(rows),
        }

    raise NotFoundError(f"No report called {key}")


# ---------------------------------------------------------------------------
# Options (lookups the forms need)
# ---------------------------------------------------------------------------

LOOKUP_LIMIT = 200


async def item_options(db: AsyncSession, search: str | None = None) -> list[dict]:
    stmt = select(Item).where(Item.is_active.is_(True)) if hasattr(Item, "is_active") \
        else select(Item)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(Item.code.ilike(like), Item.name.ilike(like)))
    rows = (await db.execute(stmt.order_by(Item.code).limit(LOOKUP_LIMIT))).scalars().all()
    return [{
        "id": r.id,
        "code": r.code,
        "name": r.name,
        "uom_code": r.uom_code,
        "is_batch_tracked": bool(r.is_batch_tracked),
        "is_serial_tracked": bool(r.is_serial_tracked),
        # The GRN form reads this to decide whether to show the IMEI column, the
        # same way it reads is_serial_tracked for serials.
        "is_imei_tracked": bool(r.is_imei_tracked),
        "has_expiry": bool(r.has_expiry),
        "is_asset": bool(r.is_asset),
        "requires_qi": bool(r.requires_qi),
    } for r in rows]


async def vendor_options(db: AsyncSession, search: str | None = None) -> list[dict]:
    stmt = select(Vendor)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(Vendor.code.ilike(like), Vendor.name.ilike(like)))
    rows = (await db.execute(stmt.order_by(Vendor.name).limit(LOOKUP_LIMIT))).scalars().all()
    return [{"id": r.id, "code": r.code, "name": r.name} for r in rows]


async def warehouse_options(db: AsyncSession, *, mine_only: bool = False,
                            all_points: bool = False, user=None) -> list[dict]:
    """Stocking points for a picker. Scoped to this login unless asked otherwise.

    Scoping is the DEFAULT, not an opt-in. It used to be the reverse — `mine_only`
    had to be passed — and every screen that forgot it (the dashboard filter, Material
    Inward, GRN, Put-away, Material Issues, QC) offered all 1,500 points in the
    company. A lab technician holding one LIP picked from the whole network, and a
    storekeeper inwarded a delivery into an unrelated demo MDP: the stock posted
    correctly and then sat somewhere his own screens are scoped away from, so every
    inventory page read empty while the goods were plainly in the building.

    `all_points=True` is the deliberate exception for a DESTINATION picker — you
    dispatch TO a point you do not hold, and a transfer needs the whole network. Only
    the "to warehouse" fields pass it.

    `mine_only` is kept as an alias for the old callers; it means the same thing the
    default now does.
    """
    stmt = select(Warehouse).where(Warehouse.is_active.is_(True))
    if not all_points:
        allowed = await warehouse_ids_for_user(db, user) if user is not None else None
        if allowed is not None:
            stmt = stmt.where(Warehouse.id.in_(allowed or {0}))
    rows = (await db.execute(stmt.order_by(Warehouse.code))).scalars().all()
    # `warehouse_type` rides along so a form can tell an MDP or LIP from a main store
    # without a second round trip — the GRN screen hides purchase-order and vendor
    # fields, and trims its receipt types, at the bottom of the chain.
    return [{"id": r.id, "code": r.code, "name": r.name,
             "is_bin_managed": r.is_bin_managed,
             "warehouse_type": r.warehouse_type} for r in rows]


async def bin_options(db: AsyncSession, warehouse_id: int, search: str | None = None,
                      item_id: int | None = None, batch_id: int | None = None,
                      storage_type_id: str | None = None,
                      all_locations: bool = False,
                      exclude_bin_id: int | None = None) -> list[dict]:
    # A picker chooses somewhere to put stock, so offer bins and not the lanes and
    # racks they hang from, unless all_locations is True.
    stmt = select(Bin).where(Bin.warehouse_id == warehouse_id, Bin.is_active.is_(True))
    if not all_locations:
        stmt = stmt.where(Bin.bin_type.in_(m.BIN_TYPES))
    # A destination that is also the source is not a movement. Excluded here rather
    # than only in the form, so the offer and the rule the service enforces agree.
    if exclude_bin_id:
        stmt = stmt.where(Bin.id != exclude_bin_id)
    if storage_type_id:
        if storage_type_id.isdigit():
            stmt = stmt.where(Bin.storage_type_id == int(storage_type_id))
        else:
            stmt = stmt.where(Bin.bin_type == storage_type_id)
    if item_id or batch_id:
        from app.modules.inventory.models import Stock
        stmt = stmt.join(Stock, Stock.bin_id == Bin.id).where(
            Stock.warehouse_id == warehouse_id,
            Stock.available_qty > ZERO,
        )
        if item_id:
            stmt = stmt.where(Stock.item_id == item_id)
        if batch_id:
            stmt = stmt.where(Stock.batch_id == batch_id)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(Bin.code.ilike(like), Bin.name.ilike(like)))
    rows = (await db.execute(stmt.distinct().order_by(Bin.code).limit(LOOKUP_LIMIT))).scalars().all()
    return [{"id": r.id, "code": r.code, "name": r.name or r.code} for r in rows]


async def batch_options(
    db: AsyncSession,
    *,
    item_id: int,
    warehouse_id: int,
    bin_id: int | None = None,
) -> list[dict]:
    from app.modules.inventory.models import Stock

    stmt = (
        select(m.Batch)
        .join(Stock, Stock.batch_id == m.Batch.id)
        .where(
            m.Batch.item_id == item_id,
            Stock.warehouse_id == warehouse_id,
            Stock.available_qty > ZERO,
        )
        .distinct()
    )
    if bin_id:
        stmt = stmt.where(Stock.bin_id == bin_id)
    rows = (await db.execute(
        stmt.order_by(m.Batch.expiry_date.is_(None), m.Batch.expiry_date)
        .limit(LOOKUP_LIMIT)
    )).scalars().all()
    return [{"id": row.id, "code": row.batch_no, "name": row.batch_no} for row in rows]


async def po_options(db: AsyncSession, search: str | None = None, warehouse_id: int | None = None) -> list[dict]:
    # Three columns, not the whole row: see _po_number for why selecting the mapped
    # PurchaseOrder is a 1054 against the live schema.
    from app.modules.procurement.models import PurchaseOrder
    from app.shared.enums import POStatus
    stmt = select(PurchaseOrder.id, PurchaseOrder.po_no, PurchaseOrder.vendor_name)
    # Only orders the vendor has actually been told about. Listing every PO offered a
    # storekeeper drafts nobody has approved and orders already cancelled — and the
    # receipt would then post stock against a commitment that was never made. Mirrors
    # the GRN guard, which has always required an order to have been sent.
    stmt = stmt.where(PurchaseOrder.status.in_((
        POStatus.SENT_TO_VENDOR.value,
        POStatus.ACCEPTED_BY_SUPPLIER.value,
        POStatus.PARTIALLY_RECEIVED.value)))
    
    # Only orders that the supplier has explicitly accepted.
    from app.shared.enums import POVendorStatus
    from sqlalchemy import or_
    stmt = stmt.where(PurchaseOrder.vendor_status == POVendorStatus.ACCEPTED.value)

    # Narrow to the orders this warehouse could actually receive, when the warehouse
    # says which office or facility it belongs to. A warehouse that says neither is
    # not filtered at all — an empty dropdown is worse than a long one.
    if warehouse_id:
        from app.shared.models.warehouse import Warehouse
        wh = await db.get(Warehouse, warehouse_id)
        if wh is not None:
            conditions = []
            if wh.office_id:
                conditions.append(PurchaseOrder.office_id == wh.office_id)
            if wh.facility_id:
                conditions.append(PurchaseOrder.facility_id == wh.facility_id)
            conditions.append(PurchaseOrder.facility_id == warehouse_id)
            if conditions:
                stmt = stmt.where(or_(*conditions))

    if search:
        stmt = stmt.where(PurchaseOrder.po_no.ilike(f"%{search}%"))
    rows = (await db.execute(
        stmt.order_by(PurchaseOrder.id.desc()).limit(LOOKUP_LIMIT))).all()
    return [{"id": po_id, "code": po_no, "name": vendor_name or po_no}
            for po_id, po_no, vendor_name in rows]


async def po_lines(db: AsyncSession, po_id: int) -> dict:
    from app.modules.procurement.models import PurchaseOrder, POItem
    
    stmt = select(PurchaseOrder).where(PurchaseOrder.id == po_id)
    po = (await db.execute(stmt)).scalars().first()
    if not po:
        return {"lines": []}
        
    stmt_lines = select(POItem).where(POItem.po_id == po_id)
    rows = (await db.execute(stmt_lines.order_by(POItem.id))).scalars().all()
    
    lines = [
        {
            "po_item_id": row.id,
            "indent_id": getattr(row, "indent_id", None),
            "item_id": row.item_id,
            "item_code": row.item_code,
            "item_name": row.item_name,
            "uom_code": row.uom_code,
            "ordered_qty": row.quantity,
            "received_qty": row.received_quantity,
            "pending_qty": row.quantity - row.received_quantity,
            "rate": row.rate,
        }
        for row in rows
    ]
    
    return {
        "vendor_id": po.vendor_id,
        "vendor_name": po.vendor_name,
        "vendor_gstin": po.vendor_gstin,
        "project_id": po.project_id,
        "project_name": po.project_name,
        "lines": lines
    }


async def receipt_options(
    db: AsyncSession,
    search: str | None = None,
    receipt_type: str | None = None,
    *,
    warehouse_id: int | None = None,
    for_putaway: bool = False,
    user=None,
) -> list[dict]:
    stmt = select(m.Receipt).where(m.Receipt.status != ReceiptStatus.CANCELLED.value)
    # A lookup is not exempt from scoping. Unscoped, this listed every GRN in the
    # company, so a storekeeper at one MDP was offered receipts from points they have
    # never stood in and cannot put anything away at.
    if user is not None:
        stmt = stmt.where(await scope_condition(
            db, user,
            warehouse_col=m.Receipt.warehouse_id,
            warehouse_ids=await warehouse_ids_for_user(db, user),
            owner_col=m.Receipt.created_by_id,
            project_col=m.Receipt.project_id,
        ))
    if warehouse_id:
        stmt = stmt.where(m.Receipt.warehouse_id == warehouse_id)
    if receipt_type:
        stmt = stmt.where(m.Receipt.receipt_type.in_(_receipt_types_for(receipt_type)))
    if for_putaway:
        # Only what a putaway could actually be raised against — see
        # `_putaway_block_reason`, which is the same set of rules stated once more as
        # SQL. A bulk point posts its stock at receipt and has no bins to put it in,
        # so offering its GRNs here promises a step that does not exist.
        settled = (
            select(m.PutawayTask.grn_item_id)
            .where(m.PutawayTask.status.in_(_SETTLED_PUTAWAY_STATUSES))
        )
        waiting = (
            select(m.ReceiptItem.receipt_id)
            .where(
                m.ReceiptItem.qc_status == QcStatus.PASSED.value,
                m.ReceiptItem.accepted_qty > 0,
                m.ReceiptItem.id.notin_(settled),
            )
        )
        stmt = (
            stmt.join(Warehouse, Warehouse.id == m.Receipt.warehouse_id)
            .where(
                Warehouse.is_bin_managed.is_(True),
                m.Receipt.is_stock_posted.is_(False),
                m.Receipt.id.in_(waiting),
            )
        )
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(
            m.Receipt.grn_no.ilike(like),
            m.Receipt.gate_entry_no.ilike(like),
            m.Receipt.vendor_name.ilike(like),
        ))
    rows = (await db.execute(
        stmt.order_by(m.Receipt.id.desc()).limit(LOOKUP_LIMIT))).scalars().all()
    return [{
        "id": r.id,
        "code": (
            r.gate_entry_no
            if r.receipt_type == ReceiptType.GATE_ENTRY.value
            else r.grn_no
        ),
        # Who it came from, which is the thing that tells two GRNs apart. Falling back
        # to the number printed the number twice — "REC/.../00066 — REC/.../00066" —
        # on every receipt with no vendor behind it, which is every transfer and every
        # incoming consignment.
        "name": (r.vendor_name or r.transfer_no or r.po_no
                 or r.warehouse_name or r.grn_no),
    } for r in rows]


async def incoming_dispatch_options(
    db: AsyncSession,
    warehouse_id: int,
    search: str | None = None,
) -> list[dict]:
    """Consignments on their way to this point that nobody has inwarded yet.

    This is what an MDP or a LIP opens the inward screen for: not a purchase order,
    but the lorry the main store sent them.
    """
    inwarded = select(m.Receipt.transfer_id).where(
        m.Receipt.receipt_type == ReceiptType.DISPATCH.value,
        m.Receipt.status != ReceiptStatus.CANCELLED.value,
        m.Receipt.transfer_id.is_not(None),
    )
    stmt = select(m.Dispatch).where(
        m.Dispatch.to_warehouse_id == warehouse_id,
        m.Dispatch.status.in_(_INWARDABLE_DISPATCH_STATUSES),
        m.Dispatch.id.notin_(inwarded),
    )
    # A consignment that was acknowledged has already been credited to this point by
    # `acknowledge_dispatch`, so offering it here would only lead to a rejection.
    # A point that runs a receiving desk is the exception: acknowledgement there
    # credited nothing, so the acknowledged lorry is precisely what it came to inward.
    # The two halves of this `or_` are `_lands_on_internal_shelf` said in SQL — every
    # row here already matches on `to_warehouse_id`, so only the type is left to test,
    # and the two must never drift apart or a lorry is offered twice or not at all.
    if not await requires_inward(db, warehouse_id):
        stmt = stmt.where(or_(
            m.Dispatch.dispatch_type.in_(_LEAVES_THE_COMPANY),
            m.Dispatch.status != DispatchStatus.ACKNOWLEDGED.value,
        ))
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(
            m.Dispatch.dispatch_no.ilike(like),
            m.Dispatch.ref_no.ilike(like),
            m.Dispatch.warehouse_name.ilike(like),
            m.Dispatch.lr_no.ilike(like),
        ))
    rows = (await db.execute(
        stmt.order_by(m.Dispatch.id.desc()).limit(LOOKUP_LIMIT))).scalars().all()
    return [{
        "id": r.id,
        "code": r.dispatch_no,
        "name": " · ".join(filter(None, [r.warehouse_name, r.ref_no])) or r.dispatch_no,
    } for r in rows]


async def dispatch_receipt_source(
    db: AsyncSession, dispatch_id: int, warehouse_id: int,
) -> dict:
    """The consignment's lines, shaped for the inward form."""
    dispatch = await _dispatch_for_receipt(
        db,
        receipt_type=ReceiptType.DISPATCH,
        dispatch_id=dispatch_id,
        warehouse_id=warehouse_id,
    )
    wh = await _warehouse(db, warehouse_id)
    indent_id = next((l.indent_id for l in dispatch.items if l.indent_id), None)
    indent_no = next((l.indent_no for l in dispatch.items if l.indent_no), None)

    # The dispatch line only snapshots batch_no and has no expiry column at all, so
    # the storekeeper retyped both off the carton on every line. The dates live on
    # stk_batches; resolve the lines to their batch rows in two queries (a 40-line
    # consignment is not 40 round trips) and prefill what was actually sent.
    batch_ids = {l.batch_id for l in dispatch.items
                 if l.batch_id and l.batch_id != m.NO_BATCH}
    # A serialised line names units, not a batch — the serial row knows its batch.
    serials = [l.serial_no for l in dispatch.items if l.serial_no]
    serial_batch: dict[str, int] = {}
    if serials:
        for serial_no, batch_id in (await db.execute(
            select(m.SerialNumber.serial_number, m.SerialNumber.batch_id)
            .where(m.SerialNumber.serial_number.in_(serials))
        )).all():
            if batch_id and batch_id != m.NO_BATCH:
                serial_batch[serial_no] = batch_id
                batch_ids.add(batch_id)
    batches = {b.id: b for b in (await db.execute(
        select(m.Batch).where(m.Batch.id.in_(batch_ids))
    )).scalars().all()} if batch_ids else {}

    # The inward form only renders its serial and IMEI cells for a line that says it
    # is tracked, and a prefilled line said nothing — so the numbers the consignment
    # carries had nowhere to show and the storekeeper was asked for them again.
    tracked_item_ids = {line.item_id for line in dispatch.items}
    tracking = {
        row.id: row for row in (await db.execute(
            select(Item).where(Item.id.in_(tracked_item_ids))
        )).scalars().all()
    } if tracked_item_ids else {}

    items = _group_dispatch_lines(dispatch.items, serial_batch, batches, tracking)

    return {
        "dispatch_id": dispatch.id,
        "dispatch_no": dispatch.dispatch_no,
        "warehouse_id": wh.id,
        "warehouse_name": wh.name,
        "is_bin_managed": wh.is_bin_managed,
        "from_warehouse_id": dispatch.warehouse_id,
        "from_warehouse_name": dispatch.warehouse_name,
        "project_id": dispatch.project_id,
        "dispatch_date": dispatch.dispatch_date,
        "lr_no": dispatch.lr_no,
        "vehicle_number": dispatch.vehicle_number,
        "indent_id": indent_id,
        "indent_no": indent_no,
        "items": items,
    }


def _group_dispatch_lines(lines, serial_batch: dict[str, int], batches: dict,
                          tracking: dict) -> list[dict]:
    """The consignment's lines, one row per item rather than one per unit.

    A serialised item leaves the gate as one `out_dispatch_items` row PER UNIT — ten
    handsets are ten lines of qty 1 — and rendering those straight put ten rows of 1
    on the receiver's GRN, which he then inwarded as ten separate stock lines. The
    units are still named individually; they are collected onto the line they belong
    to instead of each becoming a line of its own.

    Batch is part of the key: two batches of the same item are two things to receive,
    with their own expiry, and must not be added together. So is the indent, because
    a consolidated consignment serving two requests owes each of them separately.

    Pure, and separate from the query above, so the grouping can be tested without a
    database — it is the part that was wrong.
    """
    items: list[dict] = []
    grouped: dict[tuple, dict] = {}
    for line in lines:
        batch_id = line.batch_id if (
            line.batch_id and line.batch_id != m.NO_BATCH
        ) else serial_batch.get(line.serial_no or "")
        batch = batches.get(batch_id) if batch_id else None
        key = (line.item_id, batch_id or 0, line.batch_no or "", line.indent_id or 0)
        existing = grouped.get(key)
        if existing is not None:
            for field in ("ordered_qty", "received_qty", "accepted_qty"):
                existing[field] = _d(existing[field]) + _d(line.quantity)
            if line.serial_no:
                existing["serial_numbers"] = (existing["serial_numbers"] or []) + [
                    line.serial_no]
            if line.imei_no:
                existing["imei_numbers"] = (existing["imei_numbers"] or []) + [
                    line.imei_no]
            continue
        row = {
            "item_id": line.item_id,
            # The snapshot the consignment carries. Without these the inward form had
            # an item id and nothing to show for it, so every line rendered as the
            # placeholder "PO line" with no code, name or unit.
            "item_code": line.item_code,
            "item_name": line.item_name,
            "uom_code": line.uom_code,
            "indent_id": line.indent_id,
            "indent_no": line.indent_no,
            # What was sent is what the receiver is asked to confirm or correct —
            # typing it back off the challan is how a shortage gets missed.
            "ordered_qty": _d(line.quantity),
            "received_qty": _d(line.quantity),
            "accepted_qty": _d(line.quantity),
            "rate": line.rate,
            # The line's own snapshot wins: a hand-corrected consignment keeps
            # showing what was actually sent. The batch lookup is now only a
            # fallback, for consignments dispatched before the dates were carried.
            "batch_no": line.batch_no or (batch.batch_no if batch else None),
            "mfg_date": line.mfg_date or (batch.mfg_date if batch else None),
            "expiry_date": line.expiry_date or (batch.expiry_date if batch else None),
            "serial_numbers": [line.serial_no] if line.serial_no else None,
            # Prefilled from the unit that was dispatched. The receiving storekeeper
            # was being asked to retype every IMEI off the handset — "enter exactly 1
            # IMEI numbers for ..." — against a GRN that already knew which unit
            # was in the box.
            "imei_numbers": [line.imei_no] if line.imei_no else None,
            "is_serial_tracked": bool(
                getattr(tracking.get(line.item_id), "is_serial_tracked", False)),
            "is_imei_tracked": bool(
                getattr(tracking.get(line.item_id), "is_imei_tracked", False)),
        }
        grouped[key] = row
        items.append(row)

    return items


async def indent_options(
    db: AsyncSession, search: str | None = None, warehouse_id: int | None = None,
) -> list[dict]:
    from app.modules.indents.models import Indent
    from app.modules.inventory.models import Reservation

    stmt = (
        select(Indent)
        .join(Reservation, Reservation.ref_id == Indent.id)
        .where(
            Reservation.ref_type == InventoryRefType.RESERVATION.value,
            Reservation.status == ReservationStatus.ACTIVE.value,
        )
        .distinct()
    )
    if warehouse_id is not None:
        stmt = stmt.where(Reservation.warehouse_id == warehouse_id)
    if search:
        stmt = stmt.where(Indent.indent_no.ilike(f"%{search}%"))
    rows = (await db.execute(stmt.order_by(Indent.id.desc()).limit(LOOKUP_LIMIT))).scalars().all()
    return [{"id": r.id, "code": r.indent_no,
             "name": getattr(r, "department_name", None) or r.indent_no} for r in rows]


async def indent_issue_source(
    db: AsyncSession, indent_id: int, warehouse_id: int,
) -> dict:
    """The approved reservation handoff used to seed a warehouse issue."""
    from app.modules.indents.models import Indent
    from app.modules.inventory.models import Reservation
    from app.platform.hcm.models import HcmEmployee

    indent = await _get(db, Indent, indent_id, "Indent")
    requested_by_id = getattr(indent, "requested_by_id", None)
    requested_by = await db.get(HcmEmployee, requested_by_id) if requested_by_id else None
    rows = (await db.execute(
        select(
            Reservation.ref_line_id,
            Reservation.item_id,
            Reservation.bin_id,
            Reservation.batch_id,
            Reservation.project_id,
            func.sum(Reservation.quantity),
        )
        .where(
            Reservation.ref_type == InventoryRefType.RESERVATION.value,
            Reservation.ref_id == indent_id,
            Reservation.warehouse_id == warehouse_id,
            Reservation.status == ReservationStatus.ACTIVE.value,
        )
        .group_by(
            Reservation.ref_line_id,
            Reservation.item_id,
            Reservation.bin_id,
            Reservation.batch_id,
            Reservation.project_id,
        )
        .order_by(Reservation.ref_line_id, Reservation.item_id)
    )).all()
    if not rows:
        raise ValidationError(
            f"{indent.indent_no} has no active reservation in this warehouse"
        )

    # Stock is one shared pool: inventory allocates by availability, not by project
    # (see inventory/availability.candidate_stock), so one indent legitimately draws
    # from rows received for other projects — or for none at all. The project on a
    # stock row is history, not a fence, so a mixed draw is reported, never blocked.
    # The consuming project is the indent's; the source project stays on each ledger
    # row written at posting.
    mixed_projects = any(
        (row.project_id or 0) != (getattr(indent, "project_id", None) or 0)
        for row in rows
    )

    item_ids = {row.item_id for row in rows}
    item_by_id = {
        item.id: item
        for item in (await db.execute(select(Item).where(Item.id.in_(item_ids)))).scalars().all()
    } if item_ids else {}

    return {
        "indent_id": indent.id,
        "indent_no": indent.indent_no,
        "warehouse_id": warehouse_id,
        "department_id": getattr(indent, "department_id", None),
        "project_id": getattr(indent, "project_id", None) or None,
        "mixed_projects": mixed_projects,
        "issued_to_id": requested_by_id,
        "issued_to_name": requested_by.full_name if requested_by else None,
        "vehicle_id": getattr(indent, "vehicle_id", None),
        "vehicle_number": (
            getattr(indent, "vehicle_number", None)
            or _vehicle_from_office_name(requested_by.office_name if requested_by else None)
        ),
        "destination_office_id": requested_by.office_id if requested_by else None,
        "destination_office_name": requested_by.office_name if requested_by else None,
        # Travels with the office the goods are headed to, so picking the indent
        # fills the SAC the same way it fills the destination — the raiser's office
        # code, never the storekeeper's own.
        "destination_office_sac": await _office_sac(
            db, requested_by.office_id if requested_by else None),
        "items": [
            {
                "indent_item_id": row.ref_line_id,
                "item_id": row.item_id,
                "item_code": item_by_id[row.item_id].code if row.item_id in item_by_id else None,
                "item_name": item_by_id[row.item_id].name if row.item_id in item_by_id else None,
                "is_serial_tracked": (
                    bool(item_by_id[row.item_id].is_serial_tracked)
                    if row.item_id in item_by_id else False
                ),
                "bin_id": row.bin_id or None,
                "batch_id": row.batch_id or None,
                "requested_qty": _d(row[5]),
                "issued_qty": _d(row[5]),
            }
            for row in rows
        ],
    }


async def picking_issue_source(db: AsyncSession, picking_id: int) -> dict:
    """Turn a completed physical pick into the material-issue draft that posts it."""
    from app.modules.indents.models import Indent
    from app.modules.inventory.models import Reservation
    from app.platform.hcm.models import HcmEmployee

    picking = await get_picking(db, picking_id)
    _guard(
        picking.status,
        {PickingStatus.PICKED.value, PickingStatus.COMPLETED.value},
        "create an issue from", "material fulfilment",
    )
    indent_id = picking.ref_id if picking.ref_type == "INDENT" else None
    indent = await db.get(Indent, indent_id) if indent_id else None
    requested_by_id = getattr(indent, "requested_by_id", None) if indent else None
    requested_by = await db.get(HcmEmployee, requested_by_id) if requested_by_id else None

    reservations = []
    if indent_id:
        reservations = list((await db.execute(
            select(Reservation).where(
                Reservation.ref_type == InventoryRefType.RESERVATION.value,
                Reservation.ref_id == indent_id,
                Reservation.warehouse_id == picking.warehouse_id,
                Reservation.status == ReservationStatus.ACTIVE.value,
            ).order_by(Reservation.id)
        )).scalars().all())

    # Same rule as indent_issue_source: a pick that spans projects is reported, not
    # refused. The pick already happened — the goods are off the shelf.
    indent_project = (getattr(indent, "project_id", None) if indent else None) or 0
    mixed_projects = any((row.project_id or 0) != indent_project for row in reservations)

    items = []
    item_ids = {line.item_id for line in picking.items}
    item_by_id = {
        item.id: item
        for item in (await db.execute(select(Item).where(Item.id.in_(item_ids)))).scalars().all()
    } if item_ids else {}
    for line in picking.items:
        qty = _d(line.picked_qty)
        if qty <= ZERO:
            continue
        reservation = next(
            (
                row for row in reservations
                if row.item_id == line.item_id
                and (not line.bin_id or row.bin_id == line.bin_id)
                and (not line.batch_id or row.batch_id == line.batch_id)
            ),
            None,
        )
        items.append({
            "indent_item_id": reservation.ref_line_id if reservation else None,
            "item_id": line.item_id,
            "item_code": item_by_id[line.item_id].code if line.item_id in item_by_id else None,
            "item_name": item_by_id[line.item_id].name if line.item_id in item_by_id else None,
            "is_serial_tracked": (
                bool(item_by_id[line.item_id].is_serial_tracked)
                if line.item_id in item_by_id else False
            ),
            "bin_id": line.bin_id,
            "batch_id": line.batch_id,
            "requested_qty": _d(line.required_qty),
            "issued_qty": qty,
        })
    if not items:
        raise ValidationError(f"{picking.pick_no} has no picked quantity to issue")

    return {
        "picking_id": picking.id,
        "warehouse_id": picking.warehouse_id,
        "indent_id": indent_id,
        "department_id": getattr(indent, "department_id", None) if indent else None,
        "project_id": indent_project or None,
        "mixed_projects": mixed_projects,
        # Same default as indent_issue_source: whoever raised the request.
        "issued_to_id": requested_by_id,
        "issued_to_name": requested_by.full_name if requested_by else None,
        "vehicle_id": getattr(indent, "vehicle_id", None) if indent else None,
        "vehicle_number": (
            (getattr(indent, "vehicle_number", None) if indent else None)
            or _vehicle_from_office_name(requested_by.office_name if requested_by else None)
        ),
        "items": items,
    }


async def inspectable_issue_options(db: AsyncSession,
                                    search: str | None = None) -> list[dict]:
    """Posted outward issues that still owe an outward QC.

    Deliberately NOT `issue_options`. That one lists what may be DISPATCHED, so it
    excludes exactly the issues this screen exists to inspect (`qc_status` PENDING or
    FAILED) — pointing the Outward QC lookup at it would have offered a list of issues
    the create guard then refuses one by one.

    The pair it does share with `create_outbound_inspection` is the guard itself: an
    issue already carrying a live inspection is off the list, because raising a second
    one against it is refused there.
    """
    inspected = set((await db.execute(
        select(m.OutboundInspection.issue_id).where(
            m.OutboundInspection.status.notin_([
                InspectionStatus.CANCELLED.value,
                InspectionStatus.REJECTED.value,
            ]),
            m.OutboundInspection.issue_id.isnot(None),
        )
    )).scalars().all())
    stmt = select(m.MaterialIssue).where(
        m.MaterialIssue.direction == IssueDirection.OUT.value,
        m.MaterialIssue.is_stock_posted.is_(True),
        m.MaterialIssue.qc_status.in_([QcStatus.PENDING.value, QcStatus.FAILED.value]),
    )
    if inspected:
        stmt = stmt.where(m.MaterialIssue.id.notin_(inspected))
    if search:
        stmt = stmt.where(m.MaterialIssue.issue_no.ilike(f"%{search}%"))
    rows = (await db.execute(
        stmt.order_by(m.MaterialIssue.id.desc()).limit(LOOKUP_LIMIT)
    )).scalars().all()
    return [
        {
            "id": row.id,
            "code": row.issue_no,
            "name": row.issued_to_name or row.department_name or row.issue_no,
        }
        for row in rows
    ]


async def issue_options(db: AsyncSession, search: str | None = None) -> list[dict]:
    """Posted outward issues that have not already become a dispatch."""
    used = set((await db.execute(
        select(m.Dispatch.ref_id).where(
            m.Dispatch.ref_type.in_(["ISSUE", WarehouseDocType.WH_ISSUE.value]),
            m.Dispatch.ref_id.isnot(None),
            m.Dispatch.status != DispatchStatus.CANCELLED.value,
        )
    )).scalars().all())
    stmt = select(m.MaterialIssue).where(
        m.MaterialIssue.direction == IssueDirection.OUT.value,
        m.MaterialIssue.is_stock_posted.is_(True),
        m.MaterialIssue.qc_status.notin_([QcStatus.PENDING.value, QcStatus.FAILED.value])
    )
    if used:
        stmt = stmt.where(m.MaterialIssue.id.notin_(used))
    if search:
        stmt = stmt.where(m.MaterialIssue.issue_no.ilike(f"%{search}%"))
    rows = (await db.execute(
        stmt.order_by(m.MaterialIssue.id.desc()).limit(LOOKUP_LIMIT)
    )).scalars().all()
    return [
        {
            "id": row.id,
            "code": row.issue_no,
            "name": row.issued_to_name or row.department_name or row.issue_no,
        }
        for row in rows
    ]


async def returnable_issue_options(
    db: AsyncSession,
    search: str | None = None,
) -> list[dict]:
    stmt = select(m.MaterialIssue).where(
        m.MaterialIssue.direction == IssueDirection.OUT.value,
        m.MaterialIssue.is_stock_posted.is_(True),
        m.MaterialIssue.status.in_(
            (
                IssueStatus.ISSUED.value,
                IssueStatus.DISPATCHED.value,
                IssueStatus.ACKNOWLEDGED.value,
                IssueStatus.PARTIALLY_RETURNED.value,
            )
        ),
    )
    if search:
        stmt = stmt.where(m.MaterialIssue.issue_no.ilike(f"%{search}%"))
    rows = (await db.execute(
        stmt.order_by(m.MaterialIssue.id.desc()).limit(LOOKUP_LIMIT)
    )).scalars().all()
    return [{
        "id": row.id,
        "code": row.issue_no,
        "name": row.issued_to_name or row.department_name or row.issue_no,
    } for row in rows]


async def issue_dispatch_source(db: AsyncSession, issue_id: int) -> dict:
    issue = await get_issue(db, issue_id)
    if issue.direction != IssueDirection.OUT.value or not issue.is_stock_posted:
        raise ValidationError("Only a posted outward issue can become a dispatch")
    if issue.qc_status in (QcStatus.PENDING.value, QcStatus.FAILED.value):
        raise ValidationError("QC Outward must be completed before dispatch.")
    existing = await db.scalar(
        select(m.Dispatch.id).where(
            m.Dispatch.ref_type.in_(["ISSUE", WarehouseDocType.WH_ISSUE.value]),
            m.Dispatch.ref_id == issue.id,
            m.Dispatch.status != DispatchStatus.CANCELLED.value,
        ).limit(1)
    )
    if existing is not None:
        raise ValidationError(
            f"{issue.issue_no} already has dispatch {existing}"
        )
    item_ids = {line.item_id for line in issue.items}
    item_by_id = {
        item.id: item
        for item in (await db.execute(select(Item).where(Item.id.in_(item_ids)))).scalars().all()
    } if item_ids else {}
    serials_by_item_batch: dict[tuple[int, int], list[str]] = {}
    serials_by_item: dict[int, list[str]] = {}
    serial_rows = (await db.execute(
        select(m.SerialNumber).where(
            m.SerialNumber.warehouse_id == issue.warehouse_id,
            m.SerialNumber.status == SerialStatus.ISSUED.value,
            m.SerialNumber.remarks.in_(_issue_serial_markers(issue.id)),
            m.SerialNumber.is_active.is_(True),
        ).order_by(m.SerialNumber.serial_number)
    )).scalars().all()
    # Keyed on the serial, so the consignment can print the IMEI beside the unit it
    # belongs to instead of the receiving point retyping it off the handset.
    imei_by_serial = {}
    for serial in serial_rows:
        if not serial.imei:
            continue
        if serial.serial_number: imei_by_serial[serial.serial_number] = serial.imei
        if serial.asset_code: imei_by_serial[serial.asset_code] = serial.imei
        if serial.consumable_code: imei_by_serial[serial.consumable_code] = serial.imei
    for serial in serial_rows:
        serials_by_item_batch.setdefault(
            (serial.item_id, serial.batch_id or m.NO_BATCH),
            [],
        ).append(serial.serial_number)
        serials_by_item.setdefault(serial.item_id, []).append(serial.serial_number)

    def _get_line_serials(line) -> list[str]:
        batch_key = line.batch_id or m.NO_BATCH
        found = serials_by_item_batch.get((line.item_id, batch_key))
        if not found and (not line.batch_id or line.batch_id == m.NO_BATCH):
            found = serials_by_item.get(line.item_id, [])
        return found or []

    # The point the indent was raised from, so the form can PREFILL "To warehouse"
    # rather than leaving it blank and hoping. The server derived it either way, but
    # nobody could see the decision until they had saved — and a consignment saved
    # with a blank destination is one the receiving point cannot raise a GRN against.
    requesting = await _requesting_point(db, issue)

    qc = await db.scalar(
        select(m.OutboundInspection).where(
            m.OutboundInspection.issue_id == issue.id,
            m.OutboundInspection.status == InspectionStatus.COMPLETED.value
        ).order_by(m.OutboundInspection.id.desc()).limit(1).options(
            selectinload(m.OutboundInspection.items)
        )
    )

    qc_accepted = {}
    qc_serials = {}
    if qc:
        for item in qc.items:
            qc_accepted[item.issue_item_id] = item.accepted_qty
            if item.serial_numbers:
                qc_serials[item.issue_item_id] = item.serial_numbers

    def _get_accepted_serials(line) -> list[str]:
        if line.id in qc_serials:
            s_data = qc_serials[line.id]
            if isinstance(s_data, dict):
                return s_data.get("accepted", [])
            elif isinstance(s_data, list):
                return s_data
            return []
        return _get_line_serials(line)

    return {
        "issue_id": issue.id,
        "issue_no": issue.issue_no,
        "warehouse_id": issue.warehouse_id,
        "project_id": issue.project_id,
        "destination_office_id": getattr(issue, "destination_office_id", None),
        "destination_office_name": getattr(issue, "destination_office_name", None),
        "destination_office_sac": getattr(issue, "destination_office_sac", None),
        # Shown read-only on the consignment form: see _consignment_vehicle.
        "vehicle_number": _consignment_vehicle(
            issue, getattr(issue, "destination_office_name", None)),
        "destination_warehouse_id": (
            requesting.id if requesting and requesting.id != issue.warehouse_id else None
        ),
        "destination_warehouse_name": (
            requesting.name if requesting and requesting.id != issue.warehouse_id else None
        ),
        # The issue was made AT the point that asked for it, so the goods are already
        # there: no consignment, no dispatch, no GRN. The screen says so instead of
        # showing an unexplained empty destination.
        "destination_is_origin": bool(requesting and requesting.id == issue.warehouse_id),
        "items": [
            {
                "indent_id": issue.indent_id,
                "item_id": line.item_id,
                "item_code": line.item_code,
                "item_name": line.item_name,
                "uom_code": line.uom_code,
                "batch_id": line.batch_id,
                "batch_no": line.batch_no,
                # Snapshotted on the issue line at creation, so the packer sees what
                # is actually in the carton rather than a blank the receiving point
                # has to guess at.
                "mfg_date": line.mfg_date,
                "expiry_date": line.expiry_date,
                "is_serial_tracked": (
                    bool(item_by_id[line.item_id].is_serial_tracked)
                    if line.item_id in item_by_id else False
                ) or bool(_get_accepted_serials(line)),
                "is_imei_tracked": (
                    bool(item_by_id[line.item_id].is_imei_tracked)
                    if line.item_id in item_by_id else False
                ) or any(s in imei_by_serial for s in _get_accepted_serials(line)),
                "serial_numbers": _get_accepted_serials(line),
                "imei_by_serial": {
                    serial: imei_by_serial[serial]
                    for serial in _get_accepted_serials(line)
                    if serial in imei_by_serial
                },
                "quantity": _d(qc_accepted.get(line.id, line.issued_qty)),
                "rate": line.rate,
                "remarks": line.remarks,
            }
            for line in issue.items
            if _d(qc_accepted.get(line.id, line.issued_qty)) > ZERO
        ],
    }


async def employee_options(db: AsyncSession, search: str | None = None) -> list[dict]:
    from app.platform.hcm.models import HcmEmployee
    stmt = select(HcmEmployee).where(HcmEmployee.is_active.is_(True))
    if search:
        like = f"%{search}%"
        # The column is `emp_code`, not `employee_code` — HCM's own naming, and
        # `hcm/mappers.py` is the only place that name is allowed to be translated.
        stmt = stmt.where(or_(HcmEmployee.full_name.ilike(like),
                              HcmEmployee.emp_code.ilike(like)))
    rows = (await db.execute(
        stmt.order_by(HcmEmployee.full_name).limit(LOOKUP_LIMIT))).scalars().all()
    return [{"id": r.id, "code": r.emp_code, "name": r.full_name} for r in rows]


async def project_options(db: AsyncSession, search: str | None = None) -> list[dict]:
    from app.shared.models.master import Project
    stmt = select(Project)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(Project.code.ilike(like), Project.name.ilike(like)))
    rows = (await db.execute(stmt.order_by(Project.name).limit(LOOKUP_LIMIT))).scalars().all()
    return [{"id": r.id, "code": r.code, "name": r.name} for r in rows]


async def department_options(db: AsyncSession) -> list[dict]:
    from app.platform.hcm.models import HcmDepartment
    rows = (await db.execute(
        select(HcmDepartment).order_by(HcmDepartment.name).limit(LOOKUP_LIMIT))).scalars().all()
    return [{"id": r.id, "code": getattr(r, "code", None), "name": r.name} for r in rows]


async def vehicle_options(db: AsyncSession, search: str | None = None) -> list[dict]:
    """Vehicles live in the transport tables the DB team owns (`trn_vehicles`).

    Queried by raw text rather than mapped: this module has no business declaring a
    model for another team's table just to fill a dropdown, and mapping it here would
    be a second mapper the day transport maps it properly.
    """
    from sqlalchemy import text

    sql = ("SELECT id, vehicle_number FROM trn_vehicles "
           "WHERE (:search IS NULL OR vehicle_number LIKE :like) "
           "ORDER BY vehicle_number LIMIT :limit")
    try:
        rows = (await db.execute(text(sql), {
            "search": search, "like": f"%{search or ''}%", "limit": LOOKUP_LIMIT})).all()
    except Exception:  # noqa: BLE001 - the table belongs to another team and may not exist yet
        logger.warning("trn_vehicles is not available; the vehicle dropdown will be empty")
        return []
    return [{"id": r[0], "code": r[1], "name": r[1]} for r in rows]


async def carrier_options(db: AsyncSession, search: str | None = None) -> list[dict]:
    """Carriers likewise live in `trn_carriers`."""
    from sqlalchemy import text

    sql = ("SELECT id, name FROM trn_carriers "
           "WHERE (:search IS NULL OR name LIKE :like) "
           "ORDER BY name LIMIT :limit")
    try:
        rows = (await db.execute(text(sql), {
            "search": search, "like": f"%{search or ''}%", "limit": LOOKUP_LIMIT})).all()
    except Exception:  # noqa: BLE001
        logger.warning("trn_carriers is not available; the carrier dropdown will be empty")
        return []
    return [{"id": r[0], "code": None, "name": r[1]} for r in rows]


# ---------------------------------------------------------------------------
# Deleting a draft
#
# Eight document types can be started and abandoned, and until now nothing could
# clear them: `cancel_*` leaves a CANCELLED row on the list forever, and most of the
# eight have no cancel at all. Half-typed GRNs and empty picklists piled up in front
# of the work that mattered.
#
# A draft is deleted, not cancelled, because it never happened: it holds no stock, no
# ledger row and no reservation, and no later document points back at it. Everything
# past DRAFT is history and stays — the guards below refuse anything that has moved
# stock, been submitted, or grown a child document. The audit row is written BEFORE
# the delete so the trail survives the row (rule 9).
# ---------------------------------------------------------------------------

class _Draft:
    """One deletable document type: where it lives, what counts as a draft, and what
    has to be checked before it can go."""

    __slots__ = ("model", "table", "no_col", "statuses", "label", "children")

    def __init__(self, model, table: str, no_col: str, statuses: set[str], label: str,
                 children: tuple = ()):
        self.model = model
        self.table = table
        self.no_col = no_col
        self.statuses = statuses
        self.label = label
        #: (model, column, human name) — a row here means something references this
        #: document and deleting it would orphan that thing.
        self.children = children


DRAFT_KINDS: dict[str, _Draft] = {
    "receipt": _Draft(
        m.Receipt, "inb_receipts", "grn_no",
        {ReceiptStatus.DRAFT.value, ReceiptStatus.GATE_ENTRY.value}, "receipt",
        children=((m.Inspection, "receipt_id", "quality inspection"),
                  (m.PutawayTask, "grn_id", "put-away task"),
                  (m.PurchaseReturn, "grn_id", "purchase return")),
    ),
    "inspection": _Draft(
        m.Inspection, "inb_inspections", "inspection_no",
        {InspectionStatus.DRAFT.value}, "inspection",
    ),
    "putaway": _Draft(
        m.PutawayTask, "whs_warehouse_items", "putaway_no",
        {PutawayStatus.DRAFT.value}, "put-away task",
    ),
    "picking": _Draft(
        m.Picking, "out_picking", "pick_no",
        {PickingStatus.DRAFT.value}, "picklist",
        children=((m.MaterialIssue, "picking_id", "material issue"),),
    ),
    "issue": _Draft(
        m.MaterialIssue, "out_issues", "issue_no",
        {IssueStatus.DRAFT.value}, "material issue",
    ),
    "dispatch": _Draft(
        m.Dispatch, "out_dispatches", "dispatch_no",
        {DispatchStatus.DRAFT.value}, "dispatch",
    ),
    "return": _Draft(
        m.PurchaseReturn, "pro_returns", "return_no",
        {ReturnStatus.DRAFT.value}, "purchase return",
    ),
    # No "movement" entry: a bin-to-bin movement posts its stock as it is created and
    # is COMPLETED the moment it exists, so there has never been a draft to discard —
    # and there is no header row to delete. Undoing one means moving the stock back.
}


async def _draft_in_scope(db: AsyncSession, row, user) -> bool:
    """Can this person see this document at all?

    Deletion reuses the list's own scope predicate rather than a rule of its own —
    a draft you cannot see on the list must not be one you can delete by guessing
    its id, and two separate rules would drift apart the first time one changed.
    """
    if user is None:
        return True
    model = type(row)
    cond = await scope_condition(
        db, user,
        warehouse_col=getattr(model, "warehouse_id", None),
        warehouse_ids=await warehouse_ids_for_user(db, user),
        owner_col=getattr(model, "created_by_id", None),
        project_col=getattr(model, "project_id", None),
    )
    return bool(await db.scalar(
        select(func.count()).select_from(model).where(model.id == row.id, cond)))


async def delete_draft(db: AsyncSession, kind: str, doc_id: int, user) -> None:
    """Deletes one abandoned draft. Refuses anything that is not one."""
    spec = DRAFT_KINDS.get(kind)
    if spec is None:
        raise ValidationError(f"{kind} is not a document that can be deleted.")

    row = await _get(db, spec.model, doc_id, spec.label.title())
    doc_no = getattr(row, spec.no_col, None) or f"#{doc_id}"

    if not await _draft_in_scope(db, row, user):
        raise NotFoundError(f"{spec.label.title()} {doc_id} not found")

    _guard(row.status, spec.statuses, "delete", spec.label)

    # A draft that somehow moved stock is not a draft. Belt and braces: the status
    # guard above should already have caught it, and if it did not, the row is real.
    if getattr(row, "is_stock_posted", False):
        raise ValidationError(
            f"{doc_no} has already been posted to stock and cannot be deleted.")

    for child_model, column, name in spec.children:
        used = await db.scalar(
            select(func.count()).select_from(child_model)
            .where(getattr(child_model, column) == row.id))
        if used:
            raise ValidationError(
                f"{doc_no} already has a {name} against it. Delete that first — "
                f"removing this would leave the {name} pointing at nothing.")

    # Written first: a deleted row cannot be audited afterwards, and the trail is
    # the only remaining record that this document ever existed.
    await write_audit(db, entity=spec.table, entity_id=row.id, entity_no=doc_no,
                      action=AuditAction.DEACTIVATE, actor=user,
                      before={"status": row.status, "deleted": True},
                      after=None)
    # Lines go with the parent: every one of these documents declares
    # `cascade="all, delete-orphan"` on its children.
    await db.delete(row)
    await db.commit()
    logger.info("deleted %s draft %s by employee %s", spec.label, doc_no,
                getattr(user, "id", None))


# ---------------------------------------------------------------------------
# Working a monthly cycle in the warehouse
#
# Approval consolidates a cycle and allocation batches it, but execution did not: a
# cycle of 900 monthly indents lands as 900 issue drafts and a storekeeper was opening
# each one to post it. These two functions close that gap.
#
# Same rule as everywhere else in this flow — nothing is merged. `issue_cycles` is a
# GROUP BY over the issues this login can already see, and `post_issues_batch` is a
# loop that calls the ordinary `post_issue`, so every issue keeps its own stock
# movement, its own ledger rows and its own audit trail. A batch is a way of clicking,
# not a document.
# ---------------------------------------------------------------------------

async def issue_cycles(db: AsyncSession, user) -> list[dict]:
    """Outstanding material issues, grouped by the monthly cycle they serve.

    Scoped exactly as `list_issues` scopes the screen behind it: the same warehouse
    set and the same rung, so a batch can never contain a row the storekeeper could
    not have opened one at a time.
    """
    from app.modules.indents.models import Indent
    from app.modules.indents.enums import IndentType
    from app.modules.indents.service import (
        consolidation_key, cycle_key, _month_label,
    )

    stmt = (
        select(m.MaterialIssue, Indent)
        .join(Indent, Indent.id == m.MaterialIssue.indent_id)
        .where(
            Indent.indent_type == IndentType.MONTHLY.value,
            m.MaterialIssue.direction == IssueDirection.OUT.value,
            m.MaterialIssue.status.in_([
                IssueStatus.DRAFT.value,
                IssueStatus.APPROVED.value,
            ]),
        )
    )
    if user is not None:
        stmt = stmt.where(await scope_condition(
            db, user,
            warehouse_col=m.MaterialIssue.warehouse_id,
            warehouse_ids=await warehouse_ids_for_user(db, user),
            owner_col=m.MaterialIssue.created_by_id,
            project_col=m.MaterialIssue.project_id,
        ))

    groups: dict[tuple, dict] = {}
    for issue, indent in (await db.execute(stmt)).all():
        # The consolidation document, not the month: two cycles for the same month are
        # two separate lots to pick, and merging them here would hand a storekeeper a
        # batch that no approval screen upstream ever showed as one thing.
        cycle = consolidation_key(indent.consolidation_id, indent)
        key = (cycle, issue.warehouse_id)
        row = groups.setdefault(key, {
            "cycle": cycle,
            "_cycle_month": cycle_key(indent),
            "_consolidation_id": indent.consolidation_id or 0,
            "cycle_label": _month_label(cycle_key(indent)),
            "warehouse_id": issue.warehouse_id,
            "warehouse_name": issue.warehouse_name,
            "issue_count": 0,
            "ready_count": 0,
            "draft_count": 0,
            "indent_count": 0,
            "total_qty": ZERO,
            "issue_ids": [],
            "ready_issue_ids": [],
            "indent_ids": set(),
        })
        row["issue_count"] += 1
        row["total_qty"] += _d(issue.total_qty)
        row["issue_ids"].append(issue.id)
        row["indent_ids"].add(indent.id)
        if issue.status == IssueStatus.APPROVED.value:
            row["ready_count"] += 1
            # Only the approved ones can actually be posted; the screen needs the
            # split so "Post 40 issues" never means "attempt 60 and fail on 20".
            row["ready_issue_ids"].append(issue.id)
        else:
            row["draft_count"] += 1

    out = []
    for row in groups.values():
        row["indent_count"] = len(row.pop("indent_ids"))
        row["total_qty"] = float(row["total_qty"])
        out.append(row)
    # Newest cycle first, and the fullest warehouse within it — the queue a person
    # opens the screen to clear. Sorted on the month and the document id rather than on
    # the key, which would order C9 after C10.
    out.sort(key=lambda r: (r.pop("_cycle_month"), r.pop("_consolidation_id"),
                            r["issue_count"]), reverse=True)
    return out


async def post_issues_batch(db: AsyncSession, issue_ids: list[int], user) -> dict:
    """Post several material issues in one call. One stock movement each, as always.

    Partial success is the expected outcome rather than an error: in a cycle of forty
    issues, one short of stock must not stop the other thirty-nine from going out. Each
    failure is named and returned so the storekeeper knows exactly what is left.
    """
    if not issue_ids:
        raise ValidationError("Pick at least one issue to post")

    posted, failed = [], []
    for issue_id in issue_ids:
        try:
            issue = await post_issue(db, issue_id, user)
            posted.append({"issue_id": issue.id, "issue_no": issue.issue_no,
                           "status": issue.status})
        except AppException as exc:
            # post_issue commits its own work, so a failure has written nothing. The
            # rollback clears the session for the next one.
            await db.rollback()
            failed.append({"issue_id": issue_id, "error": str(exc)})

    return {
        "posted": posted,
        "failed": failed,
        "posted_count": len(posted),
        "failed_count": len(failed),
    }


# ---------------------------------------------------------------------------
# The hand-back from the outward leg
# ---------------------------------------------------------------------------
# Logistics carries the consignment; the paperwork it settles is ours. Logistics sits
# BEFORE warehouse in the import chain (rule 5) and may not call into this module, so
# the direction is inverted: this module registers itself on `logistics.hooks` at
# import time and the transport service calls whatever it finds there.
#
# Both hooks run inside the transport service's transaction and neither commits. Both
# are also written never to RAISE on a state they cannot settle — the load leaving the
# yard is a physical fact, and refusing to record it because the consignment behind it
# is in an unexpected state would leave the two documents further apart, not closer.
# Anything skipped is logged loudly, which is the same rule the workflow fallbacks run
# on (rule 8).

async def _consignment_of(db: AsyncSession, tr) -> m.Dispatch | None:
    """The warehouse consignment a transport request is carrying, if it names one."""
    if not getattr(tr, "dispatch_id", None):
        return None
    return (await db.execute(
        select(m.Dispatch)
        .options(selectinload(m.Dispatch.items), selectinload(m.Dispatch.packages))
        .where(m.Dispatch.id == tr.dispatch_id)
    )).scalar_one_or_none()


async def transport_released(db: AsyncSession, tr, user) -> None:
    """The load left with logistics — gate the consignment out behind it.

    Without this the consignment sat at PACKED forever: `_delivery_rows` counts a line
    as dispatched only once its consignment is on the road, so the requester's own
    Acknowledgements screen showed nothing to confirm while the goods were already on
    a truck, and the indent stayed open with no way to close it.
    """
    dispatch = await _consignment_of(db, tr)
    if dispatch is None:
        return
    if dispatch.status not in (DispatchStatus.APPROVED.value,
                               DispatchStatus.PACKED.value):
        # Already gated out through the warehouse's own screen, or cancelled. Either
        # way there is nothing left for the release to say.
        return
    if await _dispatch_signature_outstanding(db, dispatch, user):
        # Logged, never refused. `transport_release_blocked` is where that signature is
        # demanded, and it runs while the load can still be held back; reaching this
        # line means it went anyway — a carrier scan or a delivery landing on a leg
        # nobody pressed the button on. Recording a departure that has physically
        # happened is the lesser wrong: leaving the consignment at PACKED behind a
        # shipment already in transit is what kept `dispatched_quantity` at zero and
        # the requester's acknowledgement out of reach.
        logger.warning(
            "%s gated %s out on a release that never got its dispatch signature",
            tr.tr_no, dispatch.dispatch_no)
    if (dispatch.ref_type or "").upper() in {"ISSUE", "WH_ISSUE"} and dispatch.ref_id:
        issue = await db.get(m.MaterialIssue, dispatch.ref_id)
        if issue is None or not issue.is_stock_posted:
            logger.warning(
                "%s released transport but the issue behind %s has not posted stock; "
                "not gated out", tr.tr_no, dispatch.dispatch_no)
            return

    await _apply_gate_out(db, dispatch, tr.gate_pass_no, user)
    logger.info("%s gated out %s on transport release", tr.tr_no, dispatch.dispatch_no)


async def transport_release_blocked(db: AsyncSession, tr, user) -> str | None:
    """May the load leave? Asked BEFORE logistics releases it.

    The one place a refusal still means something. This check used to sit in
    `transport_released`, which runs after the goods have gone: it could not stop the
    departure, only decline to record it, and a consignment left at PACKED behind a
    shipment already IN_TRANSIT is strictly worse than either outcome — `_delivery_rows`
    counts nothing as dispatched, the requester is never offered the acknowledgement,
    and the indent stays open on goods that are already on a truck.

    Silent where the project never configured a Dispatch chain, which is the same
    contract `_dispatch_signature_outstanding` has always had.
    """
    dispatch = await _consignment_of(db, tr)
    if dispatch is None:
        return None
    if dispatch.status in _ON_THE_ROAD:
        # Already gated out through the warehouse's own screen — the signature, if one
        # was owed, was settled there.
        return None
    if dispatch.status == DispatchStatus.CANCELLED.value:
        return f"{dispatch.dispatch_no} is cancelled — it cannot be dispatched"
    if dispatch.status == DispatchStatus.PENDING_APPROVAL.value:
        # Actively with an approver. Not conditional on a ladder lookup: the document
        # is already IN one.
        return (f"{dispatch.dispatch_no} is waiting on "
                f"{dispatch.current_approver_name or 'approval'} and cannot leave yet")
    if dispatch.status == DispatchStatus.REJECTED.value:
        return f"{dispatch.dispatch_no} was rejected — it cannot be dispatched"
    if not await _dispatch_signature_outstanding(db, dispatch, user):
        return None

    # A ladder EXISTING is not the same as anybody having to sign, and only the engine
    # can tell the two apart: every rung switched off, or a local post retired, and it
    # resolves to NO_APPROVAL. Refusing on the mere existence of a chain would block
    # releases nobody was ever waiting on. So ask it properly — the same call
    # `gate_out` makes through `_dispatch_approval_pending`, minus the commit.
    #
    # Safe to write here: an objection is raised by the caller and takes the whole
    # transport transaction down with it, so a chain started for a load that is then
    # refused is rolled back with everything else. Nothing is left half-submitted.
    instance = await _apply_dispatch_submit(db, dispatch, user)
    if instance.status == InstanceStatus.APPROVED.value:
        # Nobody had to sign. The consignment now reads APPROVED and `transport_released`
        # gates it out on the way past, which is exactly the old behaviour.
        return None
    # Worded as a requirement, not as an accomplished fact: the objection rolls this
    # submit back with the rest of the transaction, so the chain has NOT actually
    # started. Naming the approver is still the useful half.
    return (f"{dispatch.dispatch_no} cannot leave yet — this project asks "
            f"{dispatch.current_approver_name or 'an approver'} to release it first. "
            f"Send it for release on Consignments, then dispatch it again.")


async def _dispatch_signature_outstanding(db: AsyncSession, dispatch: m.Dispatch,
                                          user) -> bool:
    """Read-only twin of `_dispatch_approval_pending`, for the hook.

    Same question, none of the side effects: the original SUBMITS an unsubmitted
    consignment and raises when one is mid-approval, and neither belongs inside a hook
    running in somebody else's transaction — a commit there would split the transport
    release in half, and a raise would refuse to record a load that has physically
    gone. This only answers "may it leave", and the caller logs and walks away when it
    may not.

    Like the original, conditional on a DISPATCH ladder EXISTING for this scope. Where
    nobody configured one — every project today — a packed consignment gates straight
    out exactly as it did before.
    """
    if dispatch.status == DispatchStatus.APPROVED.value:
        return False

    project_id, _ = await wf_ladder.project_for(
        db, getattr(user, "active_position_id", None), user)
    if await wf_ladder.find_ladder(
            db, project_id, WarehouseDocType.DISPATCH.value) is None:
        return False

    instance = (await db.execute(
        select(WfInstance)
        .where(WfInstance.doc_type == WarehouseDocType.DISPATCH.value,
               WfInstance.doc_id == dispatch.id)
        .order_by(WfInstance.id.desc()).limit(1)
    )).scalars().first()
    return instance is None or instance.status != InstanceStatus.APPROVED.value


async def transport_acknowledged(db: AsyncSession, tr, user) -> None:
    """The receiving site signed for the leg — settle what the leg was carrying.

    One signature, one set of consequences: the consignment reads ACKNOWLEDGED, the
    material issue behind it is signed off, the arrival is credited to the receiving
    shelf and the indent closes once nothing is still owed on it. All of that already
    lives in `_apply_dispatch_acknowledgement`; this only decides that it applies.
    """
    dispatch = await _consignment_of(db, tr)
    if dispatch is None:
        return
    if dispatch.status not in (DispatchStatus.DISPATCHED.value,
                               DispatchStatus.IN_TRANSIT.value,
                               DispatchStatus.DELIVERED.value):
        return

    note = tr.ack_remarks or None
    if (tr.ack_condition or "GOOD") != "GOOD":
        # The claim itself stays on the shipment timeline where the Exceptions desk
        # works it. What the consignment records is that the site said so.
        note = f"{tr.ack_condition.title()} on arrival: {note or '—'}"
    await _apply_dispatch_acknowledgement(
        db, dispatch,
        s.AcknowledgeWrite(acknowledged_by_name=tr.acknowledged_by_name,
                           pod_url=tr.pod_url, remarks=note, lines=[]),
        user,
    )
    logger.info("%s acknowledged %s for the receiving site",
                tr.tr_no, dispatch.dispatch_no)


def _register_transport_hooks() -> None:
    """Wire this module onto the outward leg, once, at import."""
    from app.modules.logistics import hooks as lgs_hooks

    for registry, hook in ((lgs_hooks.BEFORE_RELEASE, transport_release_blocked),
                           (lgs_hooks.ON_RELEASE, transport_released),
                           (lgs_hooks.ON_ACKNOWLEDGE, transport_acknowledged)):
        if hook not in registry:
            registry.append(hook)


_register_transport_hooks()

# ---------------- Outbound Quality Inspection ----------------

async def get_outbound_inspection(db: AsyncSession, inspection_id: int) -> m.OutboundInspection:
    return await _load(db, m.OutboundInspection, inspection_id, "OutboundInspection", m.OutboundInspection.items)

def _outbound_inspection_totals(inspection: m.OutboundInspection) -> None:
    inspection.total_items = len(inspection.items)
    passed = 0
    failed = 0
    for line in inspection.items:
        if line.result == InspectionResult.PASSED.value:
            passed += 1
        elif line.result == InspectionResult.FAILED.value:
            failed += 1
        elif line.result == InspectionResult.PARTIAL.value:
            # A partial is one line that yielded both passed and failed units. Both
            # counters increment because the vendor needs a reason for the failed portion
            # just as much as the line must pass to bank what was accepted.
            passed += 1
            failed += 1
    inspection.passed_items = passed
    inspection.failed_items = failed

async def _apply_outbound_inspection_lines(db: AsyncSession, inspection: m.OutboundInspection,
                                           lines: list[s.OutboundInspectionItemWrite]) -> None:
    inspection.items.clear()
    await db.flush()

    issued_by_line: dict[int, Decimal] = {}
    issued_by_item: dict[int, Decimal] = {}
    line_id_by_item: dict[int, int] = {}
    if inspection.issue_id:
        for row_id, item_id, qty in (await db.execute(
            select(m.MaterialIssueLine.id, m.MaterialIssueLine.item_id, m.MaterialIssueLine.issued_qty)
            .where(m.MaterialIssueLine.issue_id == inspection.issue_id)
        )).all():
            issued_by_line[row_id] = _d(qty)
            issued_by_item[item_id] = issued_by_item.get(item_id, ZERO) + _d(qty)
            line_id_by_item.setdefault(item_id, row_id)

    for line in lines:
        item = await _item_snapshot(db, line.item_id)
        inspected = _d(line.inspected_qty)
        if inspected < ZERO:
            raise ValidationError(f"{item.code}: inspected quantity cannot be negative")
            
        if line.issue_item_id is None and inspection.issue_id:
            line.issue_item_id = line_id_by_item.get(line.item_id)
            if line.issue_item_id is None:
                raise ValidationError(f"{item.code} is not on this Material Issue")
        if line.issue_item_id is not None:
            if line.issue_item_id not in issued_by_line:
                repointed = line_id_by_item.get(line.item_id)
                if repointed is None:
                    raise ValidationError(f"{item.code} is not on this Material Issue")
                line.issue_item_id = repointed
            issued = issued_by_line[line.issue_item_id]
            if inspected > issued:
                raise ValidationError(
                    f"{item.code}: {inspected} inspected but only {issued} was "
                    f"issued. QC cannot pass more than was issued."
                )
        if _d(line.accepted_qty) > inspected:
            raise ValidationError(
                f"{item.code}: {line.accepted_qty} accepted out of {inspected} "
                f"inspected. Accepted cannot exceed inspected."
            )
        accepted = min(_d(line.accepted_qty), inspected)
        rejected = inspected - accepted
        result = (line.result.value if line.result != InspectionResult.PENDING
                  else _derive_result(inspected, accepted))
                  
        serials_data = line.serial_numbers or []
        if isinstance(serials_data, dict):
             serials = [value.strip() for value in serials_data.get("accepted", []) if value.strip()]
        elif isinstance(serials_data, list):
             serials = [value.strip() for value in serials_data if value.strip()]
        else:
             serials = []
        if len(serials) != len(set(serials)):
            raise ValidationError(f"{item.code}: accepted serial numbers must be unique")
            
        if item.is_serial_tracked and accepted != accepted.to_integral_value():
            raise ValidationError(f"{item.code}: accepted quantity must be a whole number for serialized items")
        if item.is_serial_tracked and len(serials) != int(accepted):
            raise ValidationError(f"{item.code}: select exactly {int(accepted)} accepted serial numbers")
            
        reason = line.rejection_reason or line.defect_type
        if rejected > ZERO and not (reason or "").strip():
            raise ValidationError(f"{item.code}: a failed line needs a defect type")

        inspection.items.append(m.OutboundInspectionItem(
            issue_item_id=line.issue_item_id,
            item_id=item.id, item_code=item.code, item_name=item.name,
            uom_code=item.uom_code, batch_no=line.batch_no,
            inspected_qty=inspected, accepted_qty=accepted, rejected_qty=rejected,
            parameters=[p.model_dump() for p in line.parameters] if line.parameters else None,
            result=result, defect_type=reason, remarks=line.remarks,
            serial_numbers={"accepted": serials} if serials else None,
        ))
    _outbound_inspection_totals(inspection)

async def create_outbound_inspection(db: AsyncSession, data: s.OutboundInspectionWrite, user) -> m.OutboundInspection:
    issue = await get_issue(db, data.issue_id) if data.issue_id else None
    wh = await db.get(Warehouse, data.warehouse_id) if data.warehouse_id else None

    if issue is not None:
        existing = await db.scalar(
            select(m.OutboundInspection).where(
                m.OutboundInspection.issue_id == issue.id,
                # REJECTED counts as gone, like CANCELLED: an approver who sent the
                # check back has ended it, and refusing a fresh one would leave the
                # issue stuck at PENDING QC with no way to inspect it again.
                m.OutboundInspection.status.notin_([
                    InspectionStatus.CANCELLED.value,
                    InspectionStatus.REJECTED.value,
                ]),
            ).limit(1)
        )
        if existing is not None:
            raise ValidationError(
                f"{issue.issue_no} is already inspected on {existing.inspection_no}. "
                f"Cancel that one to inspect it again."
            )
        if issue.qc_status not in (QcStatus.PENDING.value, QcStatus.FAILED.value):
            raise ValidationError(
                f"{issue.issue_no} QC status is {issue.qc_status}. Cannot inspect."
            )

    inspection = m.OutboundInspection(
        items=[],
        inspection_no=await next_number(db, WarehouseDocType.INSPECTION.value),
        inspection_date=data.inspection_date,
        issue_id=data.issue_id,
        issue_no=issue.issue_no if issue else None,
        warehouse_id=data.warehouse_id or (issue.warehouse_id if issue else None),
        warehouse_name=wh.name if wh else (issue.warehouse_name if issue else None),
        status=InspectionStatus.DRAFT.value,
        inspector_id=data.inspector_id or getattr(user, "id", None),
        inspector_name=_name(user) if not data.inspector_id else None,
        remarks=data.remarks,
    )
    db.add(inspection)
    await db.flush()

    await _apply_outbound_inspection_lines(db, inspection, data.items)
    await db.flush()

    await write_audit(db, entity="whs_inspections", entity_id=inspection.id,
                      entity_no=inspection.inspection_no, action=AuditAction.CREATE, actor=user,
                      after={"status": inspection.status, "lines": len(inspection.items)})
    await db.commit()
    return await get_outbound_inspection(db, inspection.id)

async def update_outbound_inspection(db: AsyncSession, inspection_id: int, data: s.OutboundInspectionWrite, user) -> m.OutboundInspection:
    inspection = await get_outbound_inspection(db, inspection_id)
    _guard(inspection.status,
           {InspectionStatus.DRAFT.value, InspectionStatus.IN_PROGRESS.value},
           "edit", "outbound inspection")

    before = {"status": inspection.status, "failed_items": inspection.failed_items}
    inspection.inspection_date = data.inspection_date
    inspection.inspector_id = data.inspector_id or inspection.inspector_id
    inspection.remarks = data.remarks
    inspection.status = InspectionStatus.IN_PROGRESS.value

    await _apply_outbound_inspection_lines(db, inspection, data.items)
    await db.flush()

    await write_audit(db, entity="whs_inspections", entity_id=inspection.id,
                      entity_no=inspection.inspection_no, action=AuditAction.UPDATE, actor=user,
                      before=before,
                      after={"status": inspection.status, "failed_items": inspection.failed_items})
    await db.commit()
    return await get_outbound_inspection(db, inspection_id)

def _outbound_inspection_context(inspection: m.OutboundInspection, user) -> dict:
    return {
        "doc_no": inspection.inspection_no,
        "doc_summary": f"Outward QC {inspection.inspection_no}",
        "warehouse_id": inspection.warehouse_id,
        "issue_no": inspection.issue_no,
        "failed_items": inspection.failed_items,
        "requester_position_id": getattr(user, "active_position_id", None),
    }


async def _apply_outbound_inspection_result(db: AsyncSession,
                                            inspection: m.OutboundInspection) -> str:
    """Complete the check and hand the verdict to the material issue.

    Split out of `complete_outbound_inspection` so approval can reach it too: where a
    ladder is configured the verdict is applied when the last approver signs, not when
    the inspector saves. Neither commits nor audits; the caller owns both.
    """
    inspection.status = InspectionStatus.COMPLETED.value

    issue = await get_issue(db, inspection.issue_id)
    if inspection.passed_items == len(inspection.items):
        issue.qc_status = QcStatus.PASSED.value
    elif inspection.failed_items == len(inspection.items):
        issue.qc_status = QcStatus.FAILED.value
    else:
        issue.qc_status = QcStatus.PARTIAL.value
    return issue.qc_status


async def _outbound_inspection_approval_pending(db: AsyncSession,
                                                inspection: m.OutboundInspection,
                                                user) -> bool:
    """Does this check owe a signature before it may release the issue?

    Deliberately conditional on a QC_OUTWARD ladder EXISTING for this project, the
    same contract `_dispatch_approval_pending` keeps. Where nobody has configured one
    - every project today - this returns False and the inspector's Complete finishes
    the check on the spot, exactly as before. Configuring a chain on Approvals Config
    is what turns the step on, which is the whole point of that screen.

    Returns True when the caller should stop and leave the document in approval.
    """
    project_id, _project_name = await wf_ladder.project_for(
        db, getattr(user, "active_position_id", None), user)
    if await wf_ladder.find_ladder(
            db, project_id, WarehouseDocType.QC_OUTWARD.value) is None:
        return False

    instance = (await db.execute(
        select(WfInstance)
        .where(WfInstance.doc_type == WarehouseDocType.QC_OUTWARD.value,
               WfInstance.doc_id == inspection.id)
        .order_by(WfInstance.id.desc()).limit(1)
    )).scalars().first()
    if instance is not None and instance.status == InstanceStatus.APPROVED.value:
        return False
    if instance is not None and instance.status == InstanceStatus.IN_PROGRESS.value:
        raise ValidationError(
            f"{inspection.inspection_no} is waiting on "
            f"{inspection.current_approver_name or 'approval'}"
        )

    # Never submitted. Start the chain rather than refusing: to the inspector,
    # Complete means "I am done with this check", and where the project asks for a
    # signature that means sending it, not an error pointing at another button. A
    # chain that resolves to NO_APPROVAL comes back approved immediately and the
    # verdict is applied by the caller.
    started = await engine.start(
        db, WarehouseDocType.QC_OUTWARD.value, inspection.id,
        _outbound_inspection_context(inspection, user), user)
    if started.status == InstanceStatus.APPROVED.value:
        inspection.current_approver_name = None
        return False
    inspection.status = InspectionStatus.PENDING_APPROVAL.value
    inspection.current_approver_name = _approver_label(
        await engine.current_approvers(
            db, WarehouseDocType.QC_OUTWARD.value, inspection.id))
    return True


async def complete_outbound_inspection(db: AsyncSession, inspection_id: int, user) -> m.OutboundInspection:
    inspection = await get_outbound_inspection(db, inspection_id)
    _guard(inspection.status,
           {InspectionStatus.DRAFT.value, InspectionStatus.IN_PROGRESS.value},
           "complete", "outbound inspection")

    if not inspection.items:
        raise ValidationError("Cannot complete an empty inspection")

    for line in inspection.items:
        if line.result == InspectionResult.PENDING.value:
            raise ValidationError(
                f"Line {line.item_code} is pending. "
                "Record a result for every item before completing the inspection."
            )

    before = inspection.status
    if await _outbound_inspection_approval_pending(db, inspection, user):
        # Now with its approvers. The issue keeps its PENDING qc_status until they sign.
        await write_audit(db, entity="whs_inspections", entity_id=inspection.id,
                          entity_no=inspection.inspection_no, action=AuditAction.UPDATE,
                          actor=user, before={"status": before},
                          after={"status": inspection.status,
                                 "current_approver_name": inspection.current_approver_name})
        await db.commit()
        return await get_outbound_inspection(db, inspection_id)

    qc_status = await _apply_outbound_inspection_result(db, inspection)

    await write_audit(db, entity="whs_inspections", entity_id=inspection.id,
                      entity_no=inspection.inspection_no, action=AuditAction.UPDATE, actor=user,
                      before={"status": before},
                      after={"status": inspection.status, "issue_qc_status": qc_status})
    await db.commit()
    return await get_outbound_inspection(db, inspection_id)


async def act_on_outbound_inspection(db: AsyncSession, inspection_id: int, action: str,
                                     comments: str, user) -> m.OutboundInspection:
    """Approve or reject an outward check that is waiting on a signature.

    The engine owns the chain; this owns the document status and the verdict it
    releases. A rejection stops the material issue moving on at all rather than
    passing it with a note - the consignment guard reads `qc_status`, and it cannot
    tell the difference between the two.
    """
    inspection = await get_outbound_inspection(db, inspection_id)
    _guard(inspection.status, {InspectionStatus.PENDING_APPROVAL.value},
           action.lower(), "outbound inspection")

    before = inspection.status
    instance = await engine.act(
        db, WarehouseDocType.QC_OUTWARD.value, inspection.id, action, user, comments,
        context=_outbound_inspection_context(inspection, user),
    )
    after: dict = {}
    if instance.status == InstanceStatus.APPROVED.value:
        after["issue_qc_status"] = await _apply_outbound_inspection_result(db, inspection)
        inspection.approved_by_name = _name(user)
        inspection.approved_at = utcnow()
        inspection.current_approver_name = None
    elif instance.status == InstanceStatus.REJECTED.value:
        inspection.status = InspectionStatus.REJECTED.value
        inspection.current_approver_name = None
    else:
        inspection.current_approver_name = _approver_label(
            await engine.current_approvers(
                db, WarehouseDocType.QC_OUTWARD.value, inspection.id))

    after["status"] = inspection.status
    await write_audit(db, entity="whs_inspections", entity_id=inspection.id,
                      entity_no=inspection.inspection_no, action=AuditAction.UPDATE,
                      actor=user, before={"status": before}, after=after)
    await db.commit()
    return await get_outbound_inspection(db, inspection_id)


async def list_outbound_inspections(db: AsyncSession, params: PageParams,
                                    status: str | None = None,
                                    warehouse_id: int | None = None,
                                    search: str | None = None, user=None) -> dict:
    stmt = select(m.OutboundInspection).where(m.OutboundInspection.status != InspectionStatus.CANCELLED.value)
    if user is not None:
        # The same rung every other warehouse list obeys - this one read the whole
        # network, so an Outward QC screen showed checks run at points the login has
        # never held. Falls back to the inspector's own rows for the reason
        # `list_inspections` does: their signature is on the document.
        stmt = stmt.where(await scope_condition(
            db, user,
            warehouse_col=m.OutboundInspection.warehouse_id,
            warehouse_ids=await warehouse_ids_for_user(db, user),
            owner_col=m.OutboundInspection.inspector_id,
        ))
    if status:
        stmt = stmt.where(m.OutboundInspection.status == status)
    if warehouse_id:
        stmt = stmt.where(m.OutboundInspection.warehouse_id == warehouse_id)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(
            or_(
                m.OutboundInspection.inspection_no.ilike(like),
                m.OutboundInspection.issue_no.ilike(like),
                m.OutboundInspection.warehouse_name.ilike(like),
            )
        )
    return await paginate(db, stmt.order_by(m.OutboundInspection.created_at.desc()), params)
