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
import os
import re
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from uuid import uuid4

from sqlalchemy import String, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.exceptions import NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
from app.modules.inventory import allocation as stock_allocation
from app.modules.inventory.service import move_stock, move_stock_out
from app.modules.warehouse import models as m
from app.modules.warehouse import schemas as s
from app.modules.warehouse.enums import (
    DispatchEventType, DispatchStatus, DispatchType, InspectionResult, InspectionStatus,
    InspectionType, IssueDirection, IssueStatus, PackageStatus, PickLineStatus,
    PickingStatus, PutawayStatus, PutawayType, QcStatus, ReceiptStatus, ReceiptType,
    ReturnStatus, SerialStatus, WarehouseDocType,
)
from app.platform.settings.service import write_audit
from app.platform.workflow import engine
from app.shared.enums import (
    AuditAction, InstanceStatus, POStatus, ReservationStatus,
    RefType as InventoryRefType, StockDirection,
)
from app.shared.models.base import utcnow
from app.shared.models.master import Item, Vendor
from app.shared.models.warehouse import Bin, Warehouse
from app.shared.numbering import next_number

logger = logging.getLogger(__name__)

ZERO = Decimal("0")

# Where uploaded documents are stored. The location is deployment configuration, so it
# comes from the environment; the default sits beside the app so a fresh checkout works
# without one more required key. Nothing but this constant knows the path.
_UPLOAD_ROOT = Path(os.getenv("UPLOAD_DIR")
                    or Path(__file__).resolve().parents[3] / "var" / "uploads")
MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024


def _slug(value: str) -> str:
    """A folder name that cannot climb out of the store."""
    return re.sub(r"[^a-z0-9_-]+", "_", (value or "other").lower()) or "other"


def _d(value) -> Decimal:
    """Decimal or zero. MySQL DECIMALs arrive as strings and a bad one must not 500."""
    if value is None:
        return ZERO
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return ZERO


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


async def _bin_code(db: AsyncSession, bin_id: int | None) -> str | None:
    if not bin_id:
        return None
    row = await db.get(Bin, bin_id)
    return row.code if row else None


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

async def list_warehouses(db: AsyncSession, params: PageParams, *, search: str | None = None,
                          is_active: bool | None = None) -> dict:
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

    row = Bin(**data.model_dump())
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
                               lines: list[s.ReceiptItemWrite]) -> None:
    """Replaces the receipt's lines, deriving what must be derived.

    Accepted is capped at received and rejected is the remainder, so the three
    quantities cannot contradict each other whatever the client sent. `short_qty` is
    only meaningful against an order, so it stays zero on a free line.

    Serial-tracked items are strict at GRN: one received unit must have one serial
    number before the line can be saved. QC and putaway then work from that unit list.
    """
    receipt.items.clear()
    await db.flush()

    seen_serials_by_item: dict[int, set[str]] = {}

    for index, line in enumerate(lines, start=1):
        item = await _item_snapshot(db, line.item_id)
        received = _d(line.received_qty)
        if received < ZERO:
            raise ValidationError(f"Line {index}: received quantity cannot be negative")
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
        if item.is_serial_tracked and len(serials) != int(received):
            raise ValidationError(
                f"Line {index}: enter exactly {int(received)} serial numbers for {item.code}"
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
            existing_serial = await db.scalar(select(m.SerialNumber.serial_number).where(
                m.SerialNumber.item_id == item.id,
                func.lower(m.SerialNumber.serial_number).in_(normalized_serials),
                m.SerialNumber.is_active.is_(True),
            ))
            if existing_serial:
                raise ValidationError(
                    f"Line {index}: serial {existing_serial} is already recorded for {item.code}"
                )
            seen_for_item.update(normalized_serials)

        accepted = received if line.accepted_qty is None else min(_d(line.accepted_qty), received)
        rejected = received - accepted
        ordered = _d(line.ordered_qty)
        short = max(ordered - received, ZERO) if ordered > ZERO else ZERO
        rate = _d(line.rate)

        if rejected > ZERO and not (line.rejection_reason or "").strip():
            raise ValidationError(
                f"Line {index}: {rejected} rejected — say why before saving.")

        receipt.items.append(m.ReceiptItem(
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
            qc_status=QcStatus.PENDING.value,
            rejection_reason=line.rejection_reason,
            remarks=line.remarks,
            serial_numbers=serials or None,
        ))
    _receipt_totals(receipt)


async def list_receipts(db: AsyncSession, params: PageParams, *, receipt_type: str | None = None,
                        status: str | None = None, warehouse_id: int | None = None,
                        search: str | None = None, date_from: date | None = None,
                        date_to: date | None = None, gate_register: bool = False) -> dict:
    stmt = select(m.Receipt)
    if gate_register:
        # The gate register is a log of vehicles that arrived, not a queue of open ones.
        # Converting a gate entry rewrites `receipt_type` to PURCHASE on the same row, so
        # filtering on the type emptied the screen the moment the entry was worked on.
        # The gate entry number is the thing that never changes: it is stamped once at
        # the gate and carried onto the GRN.
        stmt = stmt.where(m.Receipt.gate_entry_no.is_not(None))
    elif receipt_type:
        # Older imports called ordinary purchase receipts "direct". Keep them visible
        # as GRNs while the data-hardening migration normalises existing rows.
        if receipt_type == "GRN":
            receipt_types = (
                ReceiptType.PURCHASE.value,
                ReceiptType.DIRECT.value,
                ReceiptType.RETURN.value,
                ReceiptType.TRANSFER.value,
                "direct",
            )
        else:
            receipt_types = (
                (ReceiptType.PURCHASE.value, "direct")
                if receipt_type == ReceiptType.PURCHASE.value
                else (receipt_type,)
            )
        stmt = stmt.where(m.Receipt.receipt_type.in_(receipt_types))
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


async def get_receipt(db: AsyncSession, receipt_id: int) -> m.Receipt:
    receipt = await _load(db, m.Receipt, receipt_id, "Receipt", m.Receipt.items)
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

    vendor = await db.get(Vendor, data.vendor_id) if data.vendor_id else None
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
        transfer_id=transfer.id if transfer else None,
        transfer_no=transfer.sto_no if transfer else None,
        vendor_id=data.vendor_id,
        vendor_name=vendor.name if vendor else None,
        vendor_gstin=vendor.gstin if vendor else None,
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

    await _apply_receipt_lines(db, receipt, data.items)
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
    vendor = await db.get(Vendor, data.vendor_id) if data.vendor_id else None
    if data.project_id:
        from app.shared.models.master import Project
        project = await db.get(Project, data.project_id)
    else:
        project = None

    receipt.grn_date = data.grn_date
    receipt.po_id = data.po_id
    receipt.po_no = await _receipt_po_number(db, data)
    receipt.transfer_id = transfer.id if transfer else None
    receipt.transfer_no = transfer.sto_no if transfer else None
    receipt.vendor_id = data.vendor_id
    receipt.vendor_name = vendor.name if vendor else None
    receipt.vendor_gstin = vendor.gstin if vendor else None
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

    await _apply_receipt_lines(db, receipt, data.items)
    await db.flush()

    await write_audit(db, entity="inb_receipts", entity_id=receipt.id, entity_no=receipt.grn_no,
                      action=AuditAction.UPDATE, actor=user, before=before,
                      after={"status": receipt.status,
                             "total_received_qty": str(receipt.total_received_qty)})
    await db.commit()
    return await get_receipt(db, receipt_id)


async def submit_receipt(db: AsyncSession, receipt_id: int, user) -> m.Receipt:
    """Freeze the GRN and branch each line by the item's QC requirement."""
    receipt = await get_receipt(db, receipt_id)
    _guard(receipt.status, {ReceiptStatus.DRAFT.value, ReceiptStatus.GATE_ENTRY.value},
           "submit", "receipt")
    if not receipt.items:
        raise ValidationError("A receipt with no lines has nothing to inspect")

    qc_lines: list[m.ReceiptItem] = []
    direct_lines: list[m.ReceiptItem] = []
    for line in receipt.items:
        item = await _item_snapshot(db, line.item_id)
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
        await _sync_transfer_receipt_status(db, receipt.transfer_id)

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
    return await get_receipt(db, receipt_id)


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
    await _sync_transfer_receipt_status(db, receipt.transfer_id)

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
    receipt.grn_date = date.today()
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
    """
    rows: list[m.SerialNumber] = []
    for serial in serial_numbers if serial_numbers is not None else (line.serial_numbers or []):
        clash = await db.scalar(select(m.SerialNumber).where(
            m.SerialNumber.item_id == line.item_id,
            m.SerialNumber.serial_number == serial,
            m.SerialNumber.is_active.is_(True)))
        if clash:
            if clash.warehouse_id != receipt.warehouse_id:
                raise ValidationError(
                    f"Serial {serial} is already recorded against this item "
                    f"(warehouse {clash.warehouse_id}).")
            rows.append(clash)
            continue
        row = m.SerialNumber(
            item_id=line.item_id, serial_number=serial,
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
        ref_type=WarehouseDocType.RECEIPT.value,
        ref_id=receipt.id,
        ref_no=receipt.grn_no,
        user=user,
        warehouse_id=receipt.warehouse_id,
        bin_id=m.NO_BIN,
        batch_id=line.batch_id or m.NO_BATCH,
        project_id=receipt.project_id or 0,
    )
    if batch is not None:
        stock.batch_no = batch.batch_no
        stock.expiry_date = batch.expiry_date
    await _register_serials(db, receipt, line)


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
        inspection_date=date.today(),
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
                           warehouse_id: int | None = None, search: str | None = None) -> dict:
    stmt = select(m.Inspection)
    if inspection_type:
        stmt = stmt.where(m.Inspection.inspection_type == inspection_type)
    if status:
        stmt = stmt.where(m.Inspection.status == status)
    if warehouse_id:
        stmt = stmt.where(m.Inspection.warehouse_id == warehouse_id)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(
            m.Inspection.inspection_no.ilike(like), m.Inspection.grn_no.ilike(like),
            m.Inspection.vendor_name.ilike(like)))
    return await paginate(db, stmt.order_by(m.Inspection.id.desc()), params)


async def get_inspection(db: AsyncSession, inspection_id: int) -> m.Inspection:
    return await _load(db, m.Inspection, inspection_id, "Inspection", m.Inspection.items)


async def _apply_inspection_lines(db: AsyncSession, inspection: m.Inspection,
                                  lines: list[s.InspectionItemWrite]) -> None:
    inspection.items.clear()
    await db.flush()

    for line in lines:
        item = await _item_snapshot(db, line.item_id)
        inspected = _d(line.inspected_qty)
        accepted = min(_d(line.accepted_qty), inspected)
        rejected = inspected - accepted
        result = (line.result.value if line.result != InspectionResult.PENDING
                  else _derive_result(inspected, accepted))
        serials = [value.strip() for value in (line.serial_numbers or []) if value.strip()]
        if len(serials) != len(set(serials)):
            raise ValidationError(f"{item.code}: accepted serial numbers must be unique")
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
            # Only meaningful when the GRN read the serials in the first place. It often
            # does not — they are optional until putaway — and then the inspection's own
            # list is the first record of them, not a selection from an earlier one.
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

        for line in released_lines:
            await _prepare_receipt_line(db, receipt, line, user)
        wh = await _warehouse(db, receipt.warehouse_id)
        if not wh.is_bin_managed and accepted > ZERO:
            receipt.status = ReceiptStatus.COMPLETED.value
            receipt.is_stock_posted = True
            receipt.posted_at = utcnow()
            await _sync_po_receipt_status(db, receipt.po_id)
            await _sync_transfer_receipt_status(db, receipt.transfer_id)
            await _sync_transfer_receipt_status(db, receipt.transfer_id)

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
                        warehouse_id: int | None = None) -> dict:
    stmt = select(m.PutawayTask).where(m.PutawayTask.is_active.is_(True))
    if status:
        stmt = stmt.where(m.PutawayTask.status == status)
    if warehouse_id:
        stmt = stmt.where(m.PutawayTask.warehouse_id == warehouse_id)

    page = await paginate(db, stmt.order_by(m.PutawayTask.id.desc()), params)
    page["items"] = [await _decorate_putaway(db, t) for t in page["items"]]
    return page


async def get_putaway(db: AsyncSession, task_id: int) -> dict:
    task = await _get(db, m.PutawayTask, task_id, "Putaway task")
    return await _decorate_putaway(db, task)


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
    stock = await move_stock(db, item_id=task.item_id, qty=qty, direction=StockDirection.IN.value,
                             ref_type=WarehouseDocType.RECEIPT.value,
                             ref_id=receipt.id if receipt else task.id,
                             ref_no=receipt.grn_no if receipt else ref_no,
                             user=user, warehouse_id=task.warehouse_id,
                             bin_id=target.id, batch_id=task.batch_id or m.NO_BATCH,
                             project_id=project_id)
    batch = await db.get(m.Batch, task.batch_id) if task.batch_id else None
    if batch is not None:
        stock.batch_no = batch.batch_no
        stock.expiry_date = batch.expiry_date
    stock.bin_code = target.code

    # The lot is stamped here and only here: it names the storage path, so it cannot
    # be known before a bin is chosen. A split putaway leaves the remainder without
    # one until it is itself confirmed into a bin, which may be a different one.
    task.lot_no = await _next_lot_no(db, await db.get(Warehouse, task.warehouse_id), target)

    await _place_serials(db, task, target, serials, receipt, receipt_item)

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
) -> None:
    """Puts the line's serials in the bin and gives each its asset/consumable code.

    The code is generated here rather than in masters (CLAUDE.md, masters overhaul):
    a unit only becomes an asset once it is physically somewhere.
    """
    if not serial_numbers:
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
    is_asset = bool(getattr(item, "is_asset", False)) if item else False

    for serial in serials:
        serial.batch_id = task.batch_id or receipt_item.batch_id or serial.batch_id
        serial.warehouse_id = task.warehouse_id
        serial.bin_id = target.id
        serial.status = SerialStatus.AVAILABLE.value
        serial.lot_no = task.lot_no
        code = f"{(item.code if item else 'ITM')}-{serial.id:06d}"
        if is_asset:
            serial.asset_code = serial.asset_code or code
        else:
            serial.consumable_code = serial.consumable_code or code
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

async def stock_availability(
    db: AsyncSession,
    *,
    warehouse_id: int,
    source_bin_id: int,
    item_id: int,
    batch_id: int | None = None,
) -> dict:
    from app.modules.inventory.models import Stock

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
        ref_type=WarehouseDocType.STOCK_MOVEMENT.value,
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
        ref_type=WarehouseDocType.STOCK_MOVEMENT.value,
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


async def list_stock_movements(db: AsyncSession, params: PageParams) -> dict:
    from app.modules.inventory.models import StockMovement

    stmt = select(StockMovement).where(
        StockMovement.ref_type == WarehouseDocType.STOCK_MOVEMENT.value,
        StockMovement.direction == StockDirection.OUT.value,
    )
    page = await paginate(db, stmt.order_by(StockMovement.id.desc()), params)
    rows: list[dict] = []
    for outward in page["items"]:
        inward = await db.scalar(select(StockMovement).where(
            StockMovement.ref_type == WarehouseDocType.STOCK_MOVEMENT.value,
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
                        warehouse_id: int | None = None) -> dict:
    stmt = select(m.Picking)
    if status:
        stmt = stmt.where(m.Picking.status == status)
    if warehouse_id:
        stmt = stmt.where(m.Picking.warehouse_id == warehouse_id)
    return await paginate(db, stmt.order_by(m.Picking.id.desc()), params)


async def get_picking(db: AsyncSession, picking_id: int) -> m.Picking:
    return await _load(db, m.Picking, picking_id, "Material fulfilment", m.Picking.items)


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
        picking.items.append(m.PickingItem(
            line_no=index, item_id=item.id, item_code=item.code, item_name=item.name,
            uom_code=item.uom_code,
            # The sentinel, not NULL. out_picking_items.bin_id and .batch_id are
            # NOT NULL DEFAULT 0 in the live schema even though the model says
            # nullable, so an unbinned/unbatched line has to be written as 0 the way
            # every other whs_ table already does.
            bin_id=line.bin_id or m.NO_BIN,
            bin_code=await _bin_code(db, line.bin_id),
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


async def create_fulfilment_drafts_for_allocation(db: AsyncSession, alloc, user) -> list[m.Picking]:
    """Create one warehouse fulfilment draft per warehouse in an approved allocation.

    Allocation lines are combined by item within a warehouse. The underlying picking
    tables and API names remain unchanged for compatibility; this is the automatic
    Inventory -> Warehouse handoff exposed to users as Material Fulfilment.
    """
    by_warehouse: dict[int, dict[int, Decimal]] = {}
    for line in alloc.items:
        qty = _d(line.quantity)
        if qty <= ZERO or not line.warehouse_id:
            continue
        by_item = by_warehouse.setdefault(line.warehouse_id, {})
        by_item[line.item_id] = by_item.get(line.item_id, ZERO) + qty

    drafts: list[m.Picking] = []
    for warehouse_id, quantities in by_warehouse.items():
        data = s.PickingWrite(
            pick_date=date.today(),
            warehouse_id=warehouse_id,
            ref_type="INDENT",
            ref_id=alloc.indent_id,
            items=[
                s.PickingItemWrite(item_id=item_id, required_qty=qty)
                for item_id, qty in quantities.items()
            ],
        )
        drafts.append(await _build_picking(db, data, user))
    return drafts


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


async def complete_picking(db: AsyncSession, picking_id: int, user) -> m.Picking:
    picking = await get_picking(db, picking_id)
    _guard(picking.status, {PickingStatus.IN_PROGRESS.value, PickingStatus.RELEASED.value},
           "complete", "material fulfilment")
    if picking.picked_lines == 0:
        raise ValidationError("Nothing has been picked yet")

    picking.status = (PickingStatus.COMPLETED if picking.picked_lines >= picking.total_lines
                      else PickingStatus.PICKED).value
    picking.completed_at = utcnow()

    await write_audit(db, entity="out_picking", entity_id=picking.id, entity_no=picking.pick_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"status": PickingStatus.IN_PROGRESS.value},
                      after={"status": picking.status,
                             "picked_lines": picking.picked_lines,
                             "total_lines": picking.total_lines})
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


async def _issue_snapshot_values(
    db: AsyncSession,
    *,
    department_id: int | None,
    project_id: int | None,
    vehicle_id: int | None,
    issued_to_id: int | None,
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
        "vehicle_number": vehicle["name"] if vehicle else None,
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
        if not item.is_serial_tracked:
            if serials:
                raise ValidationError(f"{item.code} is not serial tracked")
            setattr(line, "serial_numbers", [])
            continue
        issued = _d(line.issued_qty)
        if issued != issued.to_integral_value() or len(serials) != int(issued):
            raise ValidationError(
                f"{item.code}: select {int(issued)} serial numbers for the issued quantity"
            )
        expected_status = (
            SerialStatus.AVAILABLE.value
            if issue.direction == IssueDirection.OUT.value
            else SerialStatus.ISSUED.value
        )
        rows = (await db.execute(
            select(m.SerialNumber).where(
                m.SerialNumber.item_id == line.item_id,
                m.SerialNumber.serial_number.in_(serials),
                m.SerialNumber.warehouse_id == issue.warehouse_id,
                m.SerialNumber.status == expected_status,
                m.SerialNumber.is_active.is_(True),
            ).with_for_update()
        )).scalars().all()
        if len(rows) != len(serials):
            raise ValidationError(
                f"{item.code}: one or more selected serials are unavailable"
            )
        by_serial = {row.serial_number: row for row in rows}
        for serial in serials:
            row = by_serial[serial]
            if line.bin_id and row.bin_id != line.bin_id:
                raise ValidationError(f"{serial} is not in the selected source bin")
            if line.batch_id and row.batch_id != line.batch_id:
                raise ValidationError(f"{serial} is not in the selected batch")
            if row.remarks and row.remarks.startswith("Reserved for issue ") \
                    and row.remarks != marker:
                raise ValidationError(f"{serial} is reserved by another issue")
            row.remarks = marker
        setattr(line, "serial_numbers", serials)


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
    for row in rows:
        by_item.setdefault(row.item_id, []).append(row.serial_number)
    item_ids = {line.item_id for line in issue.items}
    serial_by_item: dict[int, bool] = {}
    if item_ids:
        item_rows = (await db.execute(
            select(Item.id, Item.is_serial_tracked).where(Item.id.in_(item_ids))
        )).all()
        serial_by_item = {
            item_id: bool(is_serial_tracked)
            for item_id, is_serial_tracked in item_rows
        }
    for line in issue.items:
        setattr(line, "serial_numbers", by_item.get(line.item_id, []))
        setattr(line, "is_serial_tracked", serial_by_item.get(line.item_id, False))
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
            expiry_date=batch.expiry_date if batch else None,
            requested_qty=requested, issued_qty=issued, returned_qty=ZERO,
            rate=rate or None, amount=(issued * rate) if rate else None,
            remarks=line.remarks,
        ))
    _issue_totals(issue)


async def list_issues(db: AsyncSession, params: PageParams, *, direction: str | None = None,
                      status: str | None = None, warehouse_id: int | None = None,
                      search: str | None = None) -> dict:
    stmt = select(m.MaterialIssue)
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


async def get_issue(db: AsyncSession, issue_id: int) -> m.MaterialIssue:
    issue = await _load(db, m.MaterialIssue, issue_id, "Issue", m.MaterialIssue.items)
    issue = await _decorate_issue_serials(db, issue)
    return await _decorate_issue_destination(db, issue)


async def _decorate_issue_destination(
    db: AsyncSession,
    issue: m.MaterialIssue,
) -> m.MaterialIssue:
    from app.platform.hcm.models import HcmEmployee

    employee = await db.get(HcmEmployee, issue.issued_to_id) if issue.issued_to_id else None
    setattr(issue, "destination_office_id", employee.office_id if employee else None)
    setattr(issue, "destination_office_name", employee.office_name if employee else None)
    return issue


async def _issue_destination(
    db: AsyncSession,
    issue: m.MaterialIssue | None,
) -> tuple[int | None, str | None]:
    from app.platform.hcm.models import HcmEmployee

    if not issue or not issue.issued_to_id:
        return None, None
    employee = await db.get(HcmEmployee, issue.issued_to_id)
    return (
        employee.office_id if employee else None,
        employee.office_name if employee else None,
    )


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
    return dispatch


async def _decorate_dispatch_page_destinations(db: AsyncSession, page: dict) -> dict:
    for dispatch in page.get("items", []):
        await _decorate_dispatch_destination(db, dispatch)
    return page


async def create_issue(db: AsyncSession, data: s.IssueWrite, user) -> m.MaterialIssue:
    wh = await _warehouse(db, data.warehouse_id)
    if not data.items:
        raise ValidationError("An issue with no lines has nothing to issue")

    original = await get_issue(db, data.original_issue_id) if data.original_issue_id else None
    if data.direction == IssueDirection.IN and original is None:
        raise ValidationError("A return has to point at the issue it reverses")
    if original and (
        original.direction != IssueDirection.OUT.value or not original.is_stock_posted
    ):
        raise ValidationError("Materials can only return against a posted outward issue")
    from app.modules.indents.models import Indent
    indent = await db.get(Indent, data.indent_id) if data.indent_id else None
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
    instance = await engine.start(
        db, WarehouseDocType.WH_ISSUE.value, issue.id, context, user
    )
    if instance.status == InstanceStatus.APPROVED.value:
        issue.status = IssueStatus.APPROVED.value
        issue.approved_by_name = _name(user)
        issue.approved_at = utcnow()
        issue.current_approver_name = None
    else:
        approvers = await engine.current_approvers(
            db, WarehouseDocType.WH_ISSUE.value, issue.id
        )
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
    instance = await engine.act(
        db,
        WarehouseDocType.WH_ISSUE.value,
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
            await engine.current_approvers(
                db, WarehouseDocType.WH_ISSUE.value, issue.id
            )
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


async def post_issue(db: AsyncSession, issue_id: int, user) -> m.MaterialIssue:
    """Takes the stock off the shelf. The only step here that moves anything."""
    issue = await get_issue(db, issue_id)
    _guard(issue.status, {IssueStatus.APPROVED.value}, "issue stock against", "issue")
    if issue.is_stock_posted:
        raise ValidationError(f"{issue.issue_no} has already been posted")

    outward = issue.direction == IssueDirection.OUT.value
    direction = StockDirection.OUT.value if outward else StockDirection.IN.value

    for line in issue.items:
        qty = _d(line.issued_qty)
        if qty <= ZERO:
            continue

        # An approved allocation reserves concrete stock rows. Consume and issue those
        # exact rows so the hold disappears with the goods, including its bin, batch
        # and project dimensions. Legacy/manual issues with no reservation retain the
        # explicit line location path below.
        if outward and issue.indent_id:
            held = await stock_allocation.reserved_quantity(
                db,
                InventoryRefType.RESERVATION.value,
                issue.indent_id,
                ref_line_id=line.indent_item_id,
                item_id=line.item_id,
            )
            if held > ZERO:
                held_here = await stock_allocation.reserved_quantity(
                    db,
                    InventoryRefType.RESERVATION.value,
                    issue.indent_id,
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
                    issue.indent_id,
                    quantity=qty,
                    ref_line_id=line.indent_item_id,
                    item_id=line.item_id,
                    warehouse_id=issue.warehouse_id,
                )
                for stock in slices:
                    await move_stock(
                        db, item_id=line.item_id, qty=stock.quantity,
                        direction=StockDirection.OUT.value,
                        ref_type=WarehouseDocType.WH_ISSUE.value,
                        ref_id=issue.id, ref_no=issue.issue_no, user=user,
                        warehouse_id=stock.warehouse_id,
                        bin_id=stock.bin_id, batch_id=stock.batch_id,
                        project_id=stock.project_id,
                    )
                continue

        if outward:
            await move_stock_out(
                db, item_id=line.item_id, qty=qty,
                ref_type=WarehouseDocType.WH_ISSUE.value,
                ref_id=issue.id, ref_no=issue.issue_no, user=user,
                warehouse_id=issue.warehouse_id,
                bin_id=line.bin_id, batch_id=line.batch_id,
                project_id=issue.project_id or 0,
            )
        else:
            await move_stock(
                db, item_id=line.item_id, qty=qty, direction=direction,
                ref_type=WarehouseDocType.WH_ISSUE.value,
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

    await write_audit(db, entity="out_issues", entity_id=issue.id, entity_no=issue.issue_no,
                      action=AuditAction.UPDATE, actor=user,
                      before={"is_stock_posted": False},
                      after={"is_stock_posted": True, "status": issue.status,
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


async def _mark_serials(db: AsyncSession, issue: m.MaterialIssue, outward: bool) -> None:
    """Flips the status of the serials leaving or coming back with an issue."""
    new_status = (SerialStatus.ISSUED if outward else SerialStatus.RETURNED).value
    from_status = (SerialStatus.AVAILABLE if outward else SerialStatus.ISSUED).value
    marker = _issue_serial_marker(issue.id)

    for line in issue.items:
        item = await _item_snapshot(db, line.item_id)
        if not item.is_serial_tracked:
            continue
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
        if len(rows) != wanted:
            raise ValidationError(
                f"{line.item_code or line.item_id}: {wanted} serials are required, "
                f"but {len(rows)} are reserved for this issue"
            )
        for row in rows:
            row.status = new_status
            row.remarks = (
                f"Issued by issue {issue.id}"
                if outward
                else f"Returned by issue {issue.id}"
            )
    await db.flush()


async def acknowledge_issue(db: AsyncSession, issue_id: int, remarks: str | None,
                            user) -> m.MaterialIssue:
    issue = await get_issue(db, issue_id)
    # DISPATCHED is the same open state as ISSUED — gate-out only records that the
    # goods left the gate, the receiver still has to acknowledge them.
    _guard(issue.status, {IssueStatus.ISSUED.value, IssueStatus.DISPATCHED.value},
           "acknowledge", "issue")
    before_status = issue.status
    issue.status = IssueStatus.ACKNOWLEDGED.value
    issue.acknowledged_by_name = _name(user)
    issue.acknowledged_at = utcnow()
    if remarks:
        issue.remarks = f"{issue.remarks or ''}\nReceiver: {remarks}".strip()

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
    issue.remarks = f"{issue.remarks or ''}\nCancelled: {reason or '—'}".strip()

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
    return {row.serial_number.lower(): row for row in rows}


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
    issued_by_key = _issue_qty_by_item_batch(issue)
    issued_serials = await _issued_serial_index(db, issue)

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

            if item.is_serial_tracked:
                if qty != qty.to_integral_value():
                    raise ValidationError(f"{package_no}: {item.code} serial quantity must be whole")
                if len(serials) != int(qty):
                    raise ValidationError(
                        f"{package_no}: select exactly {int(qty)} serials for {item.code}"
                    )
            elif serials:
                raise ValidationError(f"{package_no}: {item.code} is not serial tracked")

            key = (item.id, batch_id)
            packed_by_key[key] = packed_by_key.get(key, ZERO) + qty
            if packed_by_key[key] > issued_by_key.get(key, ZERO):
                raise ValidationError(
                    f"{item.code}: packed quantity {packed_by_key[key]} exceeds "
                    f"{issued_by_key.get(key, ZERO)} issued for this batch"
                )

            batch = await db.get(m.Batch, batch_id) if batch_id != m.NO_BATCH else None
            rate = _d(item_data.rate)
            if item.is_serial_tracked:
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
                        serial_no=serial,
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
                    serial_no=None,
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
                          warehouse_id: int | None = None, search: str | None = None) -> dict:
    stmt = select(m.Dispatch)
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
                            warehouse_id: int | None = None, search: str | None = None) -> dict:
    stmt = select(m.Dispatch).where(
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


async def get_dispatch(db: AsyncSession, dispatch_id: int) -> m.Dispatch:
    dispatch = await _load(db, m.Dispatch, dispatch_id, "Dispatch",
                           m.Dispatch.items, m.Dispatch.packages, m.Dispatch.events)
    return await _decorate_dispatch_destination(db, dispatch)


async def create_consignment(db: AsyncSession, data: s.ConsignmentWrite, user) -> m.Dispatch:
    issue = await get_issue(db, data.issue_id)
    if issue.direction != IssueDirection.OUT.value or not issue.is_stock_posted:
        raise ValidationError("Only a posted outward material issue can become a consignment")
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
    if data.dispatch_type == DispatchType.TRANSFER and to_wh is None:
        raise ValidationError("A stock transfer consignment needs a destination warehouse")
    if to_wh is not None and to_wh.id == wh.id:
        raise ValidationError("A transfer cannot have the same origin and destination")
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
        delivery_address=data.delivery_address or destination_office_name,
        contact_person=data.contact_person,
        contact_phone=data.contact_phone,
        ref_type=WarehouseDocType.WH_ISSUE.value,
        ref_id=issue.id,
        ref_no=issue.issue_no,
        transport_mode=data.transport_mode,
        carrier_id=data.carrier_id,
        vehicle_id=data.vehicle_id,
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
    if data.dispatch_type == DispatchType.TRANSFER and to_wh is None:
        raise ValidationError("A stock transfer consignment needs a destination warehouse")
    if to_wh is not None and to_wh.id == wh.id:
        raise ValidationError("A transfer cannot have the same origin and destination")
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
    dispatch.delivery_address = data.delivery_address or destination_office_name
    dispatch.contact_person = data.contact_person
    dispatch.contact_phone = data.contact_phone
    dispatch.ref_type = WarehouseDocType.WH_ISSUE.value
    dispatch.ref_id = issue.id
    dispatch.ref_no = issue.issue_no
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
    if data.dispatch_type == DispatchType.TRANSFER and to_wh is None:
        raise ValidationError("A stock transfer needs a destination warehouse")
    if to_wh is not None and to_wh.id == wh.id:
        raise ValidationError("A transfer cannot have the same origin and destination")

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


async def submit_dispatch(db: AsyncSession, dispatch_id: int, user) -> m.Dispatch:
    dispatch = await get_dispatch(db, dispatch_id)
    _guard(dispatch.status, {DispatchStatus.DRAFT.value}, "submit", "dispatch")

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
            await move_stock_out(
                db, item_id=line.item_id, qty=qty,
                ref_type=WarehouseDocType.DISPATCH.value, ref_id=dispatch.id,
                ref_no=dispatch.dispatch_no, user=user,
                warehouse_id=dispatch.warehouse_id,
                batch_id=line.batch_id,
                project_id=dispatch.project_id or 0,
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

    await write_audit(db, entity="out_dispatches", entity_id=dispatch.id,
                      entity_no=dispatch.dispatch_no, action=AuditAction.UPDATE, actor=user,
                      before={"status": DispatchStatus.PACKED.value},
                      after={"status": dispatch.status,
                             "gate_pass_no": dispatch.gate_pass_no})
    await db.commit()
    return await get_dispatch(db, dispatch_id)


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

    # A transfer is one physical journey: gate-out removed it from the source, and
    # acknowledgement is the destination receipt. Credit only what actually arrived;
    # shortages remain visible on the dispatch instead of becoming phantom stock.
    if dispatch.dispatch_type == DispatchType.TRANSFER.value:
        if not dispatch.to_warehouse_id:
            raise ValidationError("A transfer dispatch has no destination warehouse")
        for line in dispatch.items:
            delivered = _d(line.delivered_qty)
            if delivered <= ZERO:
                continue
            await move_stock(
                db, item_id=line.item_id, qty=delivered,
                direction=StockDirection.IN.value,
                ref_type=WarehouseDocType.DISPATCH.value, ref_id=dispatch.id,
                ref_no=dispatch.dispatch_no, user=user,
                warehouse_id=dispatch.to_warehouse_id,
                bin_id=m.NO_BIN, batch_id=line.batch_id or m.NO_BATCH,
                project_id=dispatch.project_id or 0,
            )

    dispatch.acknowledged_by_name = data.acknowledged_by_name or _name(user)
    dispatch.acknowledged_at = utcnow()
    dispatch.delivered_at = dispatch.delivered_at or utcnow()
    dispatch.pod_url = data.pod_url or dispatch.pod_url
    dispatch.status = DispatchStatus.ACKNOWLEDGED.value
    if data.remarks:
        dispatch.remarks = f"{dispatch.remarks or ''}\nReceiver: {data.remarks}".strip()

    for package in dispatch.packages:
        package.status = PackageStatus.DELIVERED.value

    await write_audit(db, entity="out_dispatches", entity_id=dispatch.id,
                      entity_no=dispatch.dispatch_no, action=AuditAction.UPDATE, actor=user,
                      before={"status": DispatchStatus.IN_TRANSIT.value},
                      after={"status": dispatch.status, "short_qty": str(short)})
    await db.commit()
    return await get_dispatch(db, dispatch_id)


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
                       warehouse_id: int | None = None, search: str | None = None) -> dict:
    stmt = select(m.PurchaseReturn)
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


async def get_return(db: AsyncSession, return_id: int) -> m.PurchaseReturn:
    return await _load(db, m.PurchaseReturn, return_id, "Return", m.PurchaseReturn.items)


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
            ref_type=WarehouseDocType.PURCHASE_RETURN.value, ref_id=doc.id,
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
                       search: str | None = None) -> dict:
    stmt = select(m.SerialNumber).where(m.SerialNumber.is_active.is_(True))
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
            m.SerialNumber.asset_code.ilike(like),
            m.SerialNumber.consumable_code.ilike(like)))

    page = await paginate(db, stmt.order_by(m.SerialNumber.id.desc()), params)
    page["items"] = [await _decorate_serial(db, row) for row in page["items"]]
    return page


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
        "batch_id": row.batch_id, "batch_no": batch.batch_no if batch else None,
        "warehouse_id": row.warehouse_id, "warehouse_name": wh.name if wh else None,
        "bin_id": row.bin_id, "bin_code": await _bin_code(db, row.bin_id),
        "asset_code": row.asset_code, "consumable_code": row.consumable_code,
        "status": row.status, "remarks": row.remarks, "is_active": row.is_active,
    }


async def list_batches(db: AsyncSession, params: PageParams, *, item_id: int | None = None,
                       expiring_days: int | None = None, search: str | None = None) -> dict:
    stmt = select(m.Batch)
    if item_id:
        stmt = stmt.where(m.Batch.item_id == item_id)
    if expiring_days is not None:
        cutoff = date.today() + timedelta(days=expiring_days)
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


async def scan(db: AsyncSession, code: str) -> s.ScanResult:
    """Works out what a scanned code is.

    One endpoint rather than one per kind, because a scanner cannot tell the operator
    which screen to be on first. Order matters: document numbers are checked before
    bins so a code that could be either resolves to the document someone scanned it
    from.
    """
    value = (code or "").strip()
    if not value:
        raise ValidationError("Nothing was scanned")

    # A package label is `DISPATCH_NO|PACKAGE_NO`.
    head = value.split("|")[0]

    dispatch = await db.scalar(select(m.Dispatch).where(m.Dispatch.dispatch_no == head))
    if dispatch:
        return s.ScanResult(kind="DISPATCH", id=dispatch.id, doc_no=dispatch.dispatch_no,
                            deep_link=f"/warehouse/transactions/dispatch/{dispatch.id}")

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

async def list_attachments(db: AsyncSession, entity_type: str,
                           entity_id: int) -> list[m.Attachment]:
    return (await db.execute(
        select(m.Attachment)
        .where(m.Attachment.entity_type == entity_type, m.Attachment.entity_id == entity_id)
        .order_by(m.Attachment.id.desc())
    )).scalars().all()


async def add_attachment(db: AsyncSession, *, entity_type: str, entity_id: int,
                         upload, doc_category: str | None, user) -> m.Attachment:
    """Writes the bytes, then the row.

    The row used to be written on its own, with a `file_path` pointing at an
    `/uploads/...` URL nothing served: every upload reported success and every link was
    dead. The file is stored under a generated name so two invoices called `scan.pdf`
    cannot overwrite each other, and `file_path` is kept relative to the store so the
    directory can move without rewriting the table.
    """
    payload = await upload.read()
    if not payload:
        raise ValidationError("That file is empty — nothing was uploaded.")
    if len(payload) > MAX_ATTACHMENT_BYTES:
        raise ValidationError(
            f"A document must be {MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB or smaller.")

    # Only the last segment: a browser may send a full path, and a crafted one must not
    # be able to write outside the store.
    file_name = Path(upload.filename or "file").name
    folder = _UPLOAD_ROOT / _slug(entity_type) / str(entity_id)
    folder.mkdir(parents=True, exist_ok=True)
    stored = folder / f"{uuid4().hex}{Path(file_name).suffix.lower()}"
    stored.write_bytes(payload)

    row = m.Attachment(
        entity_type=entity_type, entity_id=entity_id,
        file_name=file_name,
        file_path=stored.relative_to(_UPLOAD_ROOT).as_posix(),
        file_size=len(payload),
        mime_type=upload.content_type, doc_category=doc_category,
        uploaded_by_id=getattr(user, "id", None), uploaded_by_name=_name(user),
    )
    db.add(row)
    await db.flush()
    await write_audit(db, entity="sys_attachments", entity_id=row.id, entity_no=file_name,
                      action=AuditAction.CREATE, actor=user,
                      after={"entity_type": entity_type, "entity_id": entity_id})
    await db.commit()
    await db.refresh(row)
    return row


async def attachment_file(db: AsyncSession, attachment_id: int) -> tuple[Path, str, str]:
    """The path, download name and type of a stored document."""
    row = await _get(db, m.Attachment, attachment_id, "Attachment")
    path = _UPLOAD_ROOT / (row.file_path or "").lstrip("/")
    if not path.is_file():
        raise NotFoundError(
            f"{row.file_name} is recorded but its file is not on the server. "
            "Upload it again.")
    return path, row.file_name, row.mime_type or "application/octet-stream"


async def delete_attachment(db: AsyncSession, attachment_id: int, user) -> None:
    row = await _get(db, m.Attachment, attachment_id, "Attachment")
    await write_audit(db, entity="sys_attachments", entity_id=row.id, entity_no=row.file_name,
                      action=AuditAction.DEACTIVATE, actor=user, before={"file": row.file_name})
    stored = _UPLOAD_ROOT / (row.file_path or "").lstrip("/")
    await db.delete(row)
    await db.commit()
    # After the commit: a file left behind is tidy-up, a row pointing at a deleted file
    # is a broken document.
    stored.unlink(missing_ok=True)


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
# Dashboard and reports
# ---------------------------------------------------------------------------

async def dashboard(db: AsyncSession, warehouse_id: int | None = None) -> dict:
    """Queue depths in one call.

    The screen this feeds used to fire eight list requests and count the rows it got
    back, which meant every number was the size of the first page rather than the size
    of the queue.
    """
    from app.modules.inventory.models import Stock

    def scoped(stmt, column):
        return stmt.where(column == warehouse_id) if warehouse_id else stmt

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
        m.Inspection.status.in_([InspectionStatus.DRAFT.value,
                                 InspectionStatus.IN_PROGRESS.value]))
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

    value_stmt = select(func.coalesce(func.sum(Stock.total_qty * Stock.valuation_rate), 0)) \
        if hasattr(Stock, "valuation_rate") else select(func.coalesce(func.sum(Stock.total_qty), 0))
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

    recent = await _recent_activity(db, warehouse_id)
    trend = await _inward_trend(db, warehouse_id)

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


async def _recent_activity(db: AsyncSession, warehouse_id: int | None, limit: int = 10) -> list[dict]:
    """The last few documents across the whole chain, newest first."""
    out: list[dict] = []

    async def collect(model, no_column, doc_type: str) -> None:
        stmt = select(model).order_by(model.id.desc()).limit(limit)
        if warehouse_id and hasattr(model, "warehouse_id"):
            stmt = stmt.where(model.warehouse_id == warehouse_id)
        for row in (await db.execute(stmt)).scalars().all():
            out.append({
                "id": row.id, "doc_no": getattr(row, no_column),
                "doc_type": doc_type, "status": row.status,
                "created_at": getattr(row, "created_at", None),
            })

    await collect(m.Receipt, "grn_no", "RECEIPT")
    await collect(m.MaterialIssue, "issue_no", "ISSUE")
    await collect(m.Dispatch, "dispatch_no", "DISPATCH")

    out.sort(key=lambda r: r["created_at"] or datetime.min, reverse=True)
    return out[:limit]


async def _inward_trend(db: AsyncSession, warehouse_id: int | None, days: int = 14) -> list[dict]:
    since = date.today() - timedelta(days=days)
    stmt = (select(m.Receipt.grn_date,
                   func.coalesce(func.sum(m.Receipt.total_received_qty), 0),
                   func.coalesce(func.sum(m.Receipt.total_accepted_qty), 0),
                   func.coalesce(func.sum(m.Receipt.total_rejected_qty), 0))
            .where(m.Receipt.grn_date >= since,
                   m.Receipt.status != ReceiptStatus.CANCELLED.value)
            .group_by(m.Receipt.grn_date).order_by(m.Receipt.grn_date))
    if warehouse_id:
        stmt = stmt.where(m.Receipt.warehouse_id == warehouse_id)

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
        today = date.today()
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


async def warehouse_options(db: AsyncSession) -> list[dict]:
    rows = (await db.execute(
        select(Warehouse).where(Warehouse.is_active.is_(True)).order_by(Warehouse.code)
    )).scalars().all()
    return [{"id": r.id, "code": r.code, "name": r.name} for r in rows]


async def bin_options(db: AsyncSession, warehouse_id: int, search: str | None = None,
                      item_id: int | None = None, batch_id: int | None = None) -> list[dict]:
    # A picker chooses somewhere to put stock, so offer bins and not the lanes and
    # racks they hang from.
    stmt = select(Bin).where(Bin.warehouse_id == warehouse_id, Bin.is_active.is_(True),
                             Bin.bin_type.in_(m.BIN_TYPES))
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


async def po_options(db: AsyncSession, search: str | None = None) -> list[dict]:
    # Three columns, not the whole row: see _po_number for why selecting the mapped
    # PurchaseOrder is a 1054 against the live schema.
    from app.modules.procurement.models import PurchaseOrder
    stmt = select(PurchaseOrder.id, PurchaseOrder.po_no, PurchaseOrder.vendor_name)
    if search:
        stmt = stmt.where(PurchaseOrder.po_no.ilike(f"%{search}%"))
    rows = (await db.execute(
        stmt.order_by(PurchaseOrder.id.desc()).limit(LOOKUP_LIMIT))).all()
    return [{"id": po_id, "code": po_no, "name": vendor_name or po_no}
            for po_id, po_no, vendor_name in rows]


async def receipt_options(
    db: AsyncSession,
    search: str | None = None,
    receipt_type: str | None = None,
) -> list[dict]:
    stmt = select(m.Receipt).where(m.Receipt.status != ReceiptStatus.CANCELLED.value)
    if receipt_type:
        stmt = stmt.where(m.Receipt.receipt_type == receipt_type)
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
        "name": r.vendor_name or r.grn_no,
    } for r in rows]


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

    projects = {row.project_id for row in rows}
    if len(projects) > 1:
        raise ValidationError(
            f"{indent.indent_no} reserves more than one project in this warehouse; "
            "raise a separate issue for each project."
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
        "project_id": getattr(indent, "project_id", None) or next(iter(projects), 0) or None,
        "issued_to_id": requested_by_id,
        "destination_office_id": requested_by.office_id if requested_by else None,
        "destination_office_name": requested_by.office_name if requested_by else None,
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

    picking = await get_picking(db, picking_id)
    _guard(
        picking.status,
        {PickingStatus.PICKED.value, PickingStatus.COMPLETED.value},
        "create an issue from", "material fulfilment",
    )
    indent_id = picking.ref_id if picking.ref_type == "INDENT" else None
    indent = await db.get(Indent, indent_id) if indent_id else None

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

    projects = {row.project_id for row in reservations}
    if len(projects) > 1:
        raise ValidationError(
            f"{picking.pick_no} contains stock for more than one project"
        )

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
        "project_id": next(iter(projects), 0) or None,
        "items": items,
    }


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
    serial_rows = (await db.execute(
        select(m.SerialNumber).where(
            m.SerialNumber.warehouse_id == issue.warehouse_id,
            m.SerialNumber.status == SerialStatus.ISSUED.value,
            m.SerialNumber.remarks.in_(_issue_serial_markers(issue.id)),
            m.SerialNumber.is_active.is_(True),
        ).order_by(m.SerialNumber.serial_number)
    )).scalars().all()
    for serial in serial_rows:
        serials_by_item_batch.setdefault(
            (serial.item_id, serial.batch_id or m.NO_BATCH),
            [],
        ).append(serial.serial_number)
    return {
        "issue_id": issue.id,
        "issue_no": issue.issue_no,
        "warehouse_id": issue.warehouse_id,
        "project_id": issue.project_id,
        "destination_office_id": getattr(issue, "destination_office_id", None),
        "destination_office_name": getattr(issue, "destination_office_name", None),
        "items": [
            {
                "indent_id": issue.indent_id,
                "item_id": line.item_id,
                "item_code": line.item_code,
                "item_name": line.item_name,
                "uom_code": line.uom_code,
                "batch_id": line.batch_id,
                "batch_no": line.batch_no,
                "is_serial_tracked": (
                    bool(item_by_id[line.item_id].is_serial_tracked)
                    if line.item_id in item_by_id else False
                ),
                "serial_numbers": serials_by_item_batch.get(
                    (line.item_id, line.batch_id or m.NO_BATCH),
                    [],
                ),
                "quantity": _d(line.issued_qty),
                "rate": line.rate,
                "remarks": line.remarks,
            }
            for line in issue.items
            if _d(line.issued_qty) > ZERO
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
