"""Inventory business logic. The base module — imports nothing from app.modules.

Physical stock changes go ONLY through move_stock(); reservation columns go ONLY
through allocation.py. Nothing else assigns to stk_balance.
"""
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import func, select, or_, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
from app.modules.inventory import allocation, availability
from app.modules.inventory.models import (
    NO_BATCH, NO_BIN, NO_PROJECT, MaterialRequest, MaterialRequestItem, Stock,
    StockMovement, StockAdjustment, StockAdjustmentItem, StockTransferOrder,
    StockTransferOrderItem, CycleCount, CycleCountItem, Reservation,
)
from app.platform.hcm.models import HcmFacility
from app.platform.settings.service import write_audit
from app.platform.workflow import engine
from app.shared.enums import (
    AuditAction, DocType, IndentStatus, InstanceStatus, MRStatus, Priority, RefType,
    StockDirection,
)
from app.shared.models.base import utcnow
from app.shared.models.master import Item
from app.shared.models.warehouse import Warehouse
from app.shared.numbering import next_number


def _d(value) -> Decimal:
    return Decimal(str(value))


# ---------------- stock: the single mutation point ----------------

async def default_warehouse_for_facility(db: AsyncSession, facility_id: int) -> Warehouse:
    """The whs_warehouses row that stocks an HCM facility.

    Callers that only know a facility land here. One is created on first use if the
    facility has no warehouse yet, so a receipt is never blocked by missing master data.
    """
    warehouse = (await db.execute(
        select(Warehouse).where(Warehouse.facility_id == facility_id,
                                Warehouse.is_active.is_(True))
        .order_by(Warehouse.id).limit(1)
    )).scalar_one_or_none()
    if warehouse is not None:
        return warehouse

    facility = await db.get(HcmFacility, facility_id)
    warehouse = Warehouse(
        code=f"FAC-{facility_id}",
        name=facility.name if facility else f"Facility {facility_id}",
        facility_id=facility_id,
        facility_name=facility.name if facility else None,
    )
    db.add(warehouse)
    await db.flush()
    return warehouse


async def move_stock(db: AsyncSession, item_id: int, qty, direction: str,
                     ref_type: str, ref_id: int, ref_no: str, user,
                     warehouse_id: int | None = None, facility_id: int | None = None,
                     bin_id: int = NO_BIN, batch_id: int = NO_BATCH,
                     project_id: int = NO_PROJECT) -> Stock:
    """The ONLY function that changes stock. Always writes a stk_ledger row.

    Either warehouse_id or facility_id must be given; a facility resolves to its
    default warehouse, so callers that only know a facility keep working.
    """
    qty = _d(qty)
    if qty <= 0:
        raise ValidationError("Stock movement quantity must be positive")

    if warehouse_id is None:
        if facility_id is None:
            raise ValidationError("move_stock needs a warehouse_id or a facility_id")
        warehouse_id = (await default_warehouse_for_facility(db, facility_id)).id

    bin_id, batch_id, project_id = bin_id or NO_BIN, batch_id or NO_BATCH, \
        project_id or NO_PROJECT

    stock = (await db.execute(
        select(Stock).where(Stock.item_id == item_id,
                            Stock.warehouse_id == warehouse_id,
                            Stock.bin_id == bin_id,
                            Stock.batch_id == batch_id,
                            Stock.project_id == project_id)
        .with_for_update()
    )).scalar_one_or_none()

    if stock is None:
        item = await db.get(Item, item_id)
        warehouse = await db.get(Warehouse, warehouse_id)
        stock = Stock(warehouse_id=warehouse_id,
                      warehouse_name=warehouse.name if warehouse else None,
                      item_id=item_id,
                      item_code=item.code if item else None,
                      item_name=item.name if item else None,
                      uom_code=item.uom_code if item else None,
                      bin_id=bin_id, batch_id=batch_id, project_id=project_id,
                      available_qty=Decimal("0"), total_qty=Decimal("0"))
        db.add(stock)
        await db.flush()

    delta = qty if direction == StockDirection.IN.value else -qty
    new_balance = (stock.available_qty or Decimal("0")) + delta
    if new_balance < 0:
        raise ValidationError("Insufficient stock for this movement")
    stock.available_qty = new_balance
    # total = what is on hand, including what is spoken for but not yet issued.
    stock.total_qty = new_balance + (stock.reserved_qty or Decimal("0"))
    stock.last_movement_at = utcnow()

    db.add(StockMovement(
        warehouse_id=warehouse_id,
        warehouse_name=stock.warehouse_name,
        item_id=item_id, item_code=stock.item_code, item_name=stock.item_name,
        uom_code=stock.uom_code,
        bin_id=bin_id, batch_id=batch_id, project_id=project_id,
        direction=direction, quantity=qty, balance_after=new_balance,
        ref_type=ref_type, ref_id=ref_id, ref_no=ref_no,
        created_by_id=user.id, created_by_name=user.full_name,
    ))
    await db.flush()
    return stock


async def transfer_stock(db: AsyncSession, item_id: int, qty, user,
                         from_warehouse_id: int, to_warehouse_id: int,
                         from_project_id: int = NO_PROJECT,
                         to_project_id: int = NO_PROJECT,
                         ref_no: str | None = None) -> None:
    """Move quantity between warehouses or projects as two balanced ledger rows.

    This is how stock changes project: two rows, and mst_items is never touched.
    """
    if (from_warehouse_id, from_project_id) == (to_warehouse_id, to_project_id):
        raise ValidationError("Transfer source and destination are the same")
    if await db.get(Warehouse, from_warehouse_id) is None \
            or await db.get(Warehouse, to_warehouse_id) is None:
        raise NotFoundError("Transfer warehouse not found")

    # OUT first: if the source is short, it raises before anything is credited.
    await move_stock(db, item_id=item_id, qty=qty,
                     direction=StockDirection.OUT.value, ref_type=RefType.TRANSFER.value,
                     ref_id=to_warehouse_id, ref_no=ref_no, user=user,
                     warehouse_id=from_warehouse_id, project_id=from_project_id)
    await move_stock(db, item_id=item_id, qty=qty,
                     direction=StockDirection.IN.value, ref_type=RefType.TRANSFER.value,
                     ref_id=from_warehouse_id, ref_no=ref_no, user=user,
                     warehouse_id=to_warehouse_id, project_id=to_project_id)


async def list_stock(db: AsyncSession, params: PageParams, item_id: int | None = None,
                     warehouse_id: int | None = None, project_id: int | None = None,
                     bin_id: int | None = None, search: str | None = None,
                     category_id: int | None = None, batch_no: str | None = None,
                     include_zero: bool = False, expiring_in_days: int | None = None,
                     below_reorder: bool = False) -> dict:
    """The stock balance grid.

    Every filter the screen offers is applied here. They used to live in the frontend
    query object and were dropped before the request went out, so typing in the search
    box changed nothing — the list has to be filtered where the rows are.
    """
    stmt = select(Stock)
    if item_id is not None:
        stmt = stmt.where(Stock.item_id == item_id)
    if warehouse_id is not None:
        stmt = stmt.where(Stock.warehouse_id == warehouse_id)
    if project_id is not None:
        stmt = stmt.where(Stock.project_id == project_id)
    if bin_id is not None:
        stmt = stmt.where(Stock.bin_id == bin_id)
    if batch_no:
        stmt = stmt.where(Stock.batch_no.like(f"%{batch_no}%"))
    if not include_zero:
        stmt = stmt.where(Stock.total_qty > 0)
    if expiring_in_days is not None:
        cutoff = utcnow().date() + timedelta(days=expiring_in_days)
        stmt = stmt.where(Stock.expiry_date.isnot(None), Stock.expiry_date <= cutoff)
    if search:
        # One box covers what a store user actually types: item code or name, the batch,
        # the bin, a serial off a label, or a scanned item barcode.
        like = f"%{search}%"
        barcoded = select(Item.id).where(
            or_(Item.barcode_value == search, Item.code == search))
        stmt = stmt.where(or_(
            Stock.item_code.like(like), Stock.item_name.like(like),
            Stock.batch_no.like(like), Stock.bin_code.like(like),
            Stock.serial_number.like(like), Stock.asset_code.like(like),
            Stock.item_id.in_(barcoded),
        ))
    if category_id is not None:
        stmt = stmt.where(Stock.item_id.in_(
            select(Item.id).where(Item.category_id == category_id)))
    if below_reorder:
        stmt = stmt.where(Stock.item_id.in_(
            select(Item.id).where(Item.reorder_level > 0)))

    page = await paginate(db, stmt.order_by(Stock.item_name), params)

    # category and reorder level live on mst_items, not stk_balance. One lookup per
    # page fills them; costing comes off the balance row's own valuation columns.
    ids = {row.item_id for row in page["items"]}
    if ids:
        cols = (await db.execute(
            select(Item.id, Item.category_name, Item.reorder_level, Item.barcode_value)
            .where(Item.id.in_(ids))
        )).all()
        by_id = {c.id: c for c in cols}
        for row in page["items"]:
            item = by_id.get(row.item_id)
            row.category_name = item.category_name if item else None
            row.reorder_level = float(item.reorder_level or 0) if item else 0.0
            row.barcode_value = item.barcode_value if item else None
    if below_reorder:
        page["items"] = [r for r in page["items"]
                         if float(r.available_qty or 0) < r.reorder_level]
        page["total"] = len(page["items"])
    return page


async def list_movements(db: AsyncSession, params: PageParams,
                         item_id: int | None = None, warehouse_id: int | None = None,
                         direction: str | None = None, ref_type: str | None = None,
                         search: str | None = None, date_from: date | None = None,
                         date_to: date | None = None) -> dict:
    """The stock ledger. Same story as list_stock — the filters have to run here."""
    stmt = select(StockMovement)
    if item_id is not None:
        stmt = stmt.where(StockMovement.item_id == item_id)
    if warehouse_id is not None:
        stmt = stmt.where(StockMovement.warehouse_id == warehouse_id)
    if direction:
        stmt = stmt.where(StockMovement.direction == direction)
    if ref_type:
        stmt = stmt.where(StockMovement.ref_type == ref_type)
    if date_from is not None:
        stmt = stmt.where(StockMovement.txn_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(StockMovement.txn_date < date_to + timedelta(days=1))
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(
            StockMovement.item_code.like(like), StockMovement.item_name.like(like),
            StockMovement.ref_no.like(like), StockMovement.batch_no.like(like),
        ))
    return await paginate(db, stmt.order_by(StockMovement.created_at.desc()), params)


# ---------------- Material Request ----------------

async def get_mr(db: AsyncSession, mr_id: int) -> MaterialRequest:
    mr = (await db.execute(
        select(MaterialRequest).where(MaterialRequest.id == mr_id)
    )).scalar_one_or_none()
    if not mr:
        raise NotFoundError(f"Material request {mr_id} not found")
    return mr


async def list_mrs(db: AsyncSession, params: PageParams, status: str | None = None,
                   indent_id: int | None = None) -> dict:
    stmt = select(MaterialRequest)
    if status:
        stmt = stmt.where(MaterialRequest.status == status)
    if indent_id is not None:
        stmt = stmt.where(MaterialRequest.indent_id == indent_id)
    return await paginate(db, stmt.order_by(MaterialRequest.created_at.desc()), params)


async def create_mr_from_shortfall(db: AsyncSession, indent_id: int | None,
                                   indent_no: str | None, shortfalls: list[dict],
                                   user, ctx: dict | None = None) -> MaterialRequest:
    """One MR carrying every line an indent could not fill from stock.

    One document, not one per line: procurement buys against a request, and five
    separate MRs for one indent would be five RFQs for the same delivery.
    """
    if not shortfalls:
        raise ValidationError("A material request needs at least one short line")

    ctx = ctx or {}
    mr = MaterialRequest(
        mr_no=await next_number(db, "mr"),
        mr_date=utcnow().date(),
        indent_id=indent_id, indent_no=indent_no,
        requested_by_id=getattr(user, "id", None),
        requested_by_name=getattr(user, "full_name", None),
        department_id=ctx.get("department_id"),
        department_name=ctx.get("department_name"),
        facility_id=ctx.get("facility_id"),
        project_id=ctx.get("project_id"),
        project_name=ctx.get("project_name"),
        status=MRStatus.DRAFT.value,
        priority=ctx.get("priority") or Priority.NORMAL.value,
        required_by=ctx.get("required_by"),
        remarks=f"Raised automatically for {indent_no}" if indent_no else None,
    )
    db.add(mr)
    await db.flush()

    for line_no, line in enumerate(shortfalls, start=1):
        db.add(MaterialRequestItem(
            mr_id=mr.id, line_no=line_no, item_id=line["item_id"],
            item_code=line.get("item_code"), item_name=line.get("item_name"),
            uom_code=line.get("uom_code"), quantity=_d(line["quantity"]),
            project_id=line.get("project_id") or NO_PROJECT,
            indent_item_id=line.get("indent_item_id"),
        ))

    # Straight into approval: nobody types an auto-raised MR, so leaving it in DRAFT
    # would strand it waiting for a human to press submit.
    await engine.start(
        db, doc_type=DocType.MR.value, doc_id=mr.id,
        context={
            "doc_no": mr.mr_no,
            "doc_summary": f"Material request {mr.mr_no}",
            "department_id": mr.department_id,
            "requester_position_id": ctx.get("requester_position_id"),
            "total_quantity": float(sum(_d(s["quantity"]) for s in shortfalls)),
        },
        user=user,
    )
    mr.status = MRStatus.PENDING_APPROVAL.value
    await _refresh_mr_approver(db, mr)
    await write_audit(
        db, entity="inv_material_requests", entity_id=mr.id, entity_no=mr.mr_no,
        action=AuditAction.CREATE, actor=user,
        after={"status": mr.status, "indent_no": indent_no, "lines": len(shortfalls)},
        summary=f"Material request raised for {indent_no or 'manual entry'}",
    )
    await db.flush()
    return mr


async def _refresh_mr_approver(db: AsyncSession, mr: MaterialRequest) -> None:
    approvers = await engine.current_approvers(db, DocType.MR.value, mr.id)
    mr.current_approver_name = ", ".join(a.full_name for a in approvers) or None


async def act_on_mr(db: AsyncSession, mr_id: int, action: str, user,
                    comments: str = "") -> MaterialRequest:
    """APPROVE / REJECT. Engine owns the chain; this module owns the status."""
    mr = await get_mr(db, mr_id)
    if mr.status != MRStatus.PENDING_APPROVAL.value:
        raise ValidationError(
            f"Material request is not awaiting approval (status {mr.status})")

    before = mr.status
    instance = await engine.act(
        db, DocType.MR.value, mr.id, action, user, comments,
        context={"doc_no": mr.mr_no, "department_id": mr.department_id},
    )

    if instance.status == InstanceStatus.APPROVED.value:
        mr.status = MRStatus.APPROVED.value
        mr.approved_at = utcnow()
        mr.current_approver_name = None
    elif instance.status == InstanceStatus.REJECTED.value:
        mr.status = MRStatus.REJECTED.value
        mr.current_approver_name = None
    else:
        await _refresh_mr_approver(db, mr)

    await write_audit(
        db, entity="inv_material_requests", entity_id=mr.id, entity_no=mr.mr_no,
        action=AuditAction.UPDATE, actor=user,
        before={"status": before}, after={"status": mr.status},
        summary=f"{action.title()} material request",
    )
    await db.commit()
    await db.refresh(mr)
    return mr


# ---------------- releasing what an indent holds ----------------
#
# There is deliberately no allocate_for_indent() here any more. Deciding how much
# stock an indent gets is a human judgement, not a function -- see allocations.py
# and docs/superpowers/specs/2026-07-26-allocation-is-a-decision-CHANGE.md.

async def release_for_indent(db: AsyncSession, indent_id: int) -> Decimal:
    """Hand back everything an indent was holding — it was rejected or cancelled."""
    return await allocation.release(db, RefType.RESERVATION.value, indent_id)


# ---------------- Stock Adjustments ----------------

async def create_stock_adjustment(db: AsyncSession, data, user) -> StockAdjustment:
    """Create a stock adjustment. Large adjustments (qty > 100 or value > 5000) require approval."""
    warehouse = await db.get(Warehouse, data.warehouse_id)
    if not warehouse:
        raise NotFoundError(f"Warehouse {data.warehouse_id} not found")

    adj_no = await next_number(db, "adj")
    adjustment = StockAdjustment(
        adjustment_no=adj_no,
        warehouse_id=data.warehouse_id,
        warehouse_name=warehouse.name,
        reason=data.reason,
        status="PENDING_APPROVAL",
        remarks=data.remarks,
        created_by_id=getattr(user, "id", None),
        created_by_name=getattr(user, "full_name", None),
    )
    db.add(adjustment)
    await db.flush()

    total_qty, total_val = Decimal("0"), Decimal("0")
    # Collected as we go: adjustment.items is a lazy relationship, and touching it
    # before the row is reloaded raises MissingGreenlet under async.
    adj_items: list[StockAdjustmentItem] = []
    for item_data in data.items:
        item = await db.get(Item, item_data.item_id)
        qty = _d(item_data.quantity)
        cost = _d(item_data.unit_cost or 0)
        total_qty += qty
        total_val += (qty * cost)

        adj_items.append(StockAdjustmentItem(
            adjustment_id=adjustment.id,
            item_id=item_data.item_id,
            item_code=item.code if item else None,
            item_name=item.name if item else None,
            uom_code=item.uom_code if item else None,
            bin_id=item_data.bin_id or NO_BIN,
            batch_id=item_data.batch_id or NO_BATCH,
            project_id=item_data.project_id or NO_PROJECT,
            direction=item_data.direction,
            quantity=qty,
            unit_cost=cost,
            remarks=item_data.remarks,
        ))
    db.add_all(adj_items)

    # Auto-approve if small adjustment (qty <= 100 and value <= 5000)
    if total_qty <= Decimal("100") and total_val <= Decimal("5000"):
        adjustment.status = "APPROVED"
        adjustment.approved_by_id = getattr(user, "id", None)
        adjustment.approved_by_name = getattr(user, "full_name", None)
        adjustment.approved_at = utcnow()
        await db.flush()
        # Post movement
        for adj_item in adj_items:
            await move_stock(
                db, item_id=adj_item.item_id, qty=adj_item.quantity,
                direction=adj_item.direction, ref_type="ADJUSTMENT",
                ref_id=adjustment.id, ref_no=adjustment.adjustment_no, user=user,
                warehouse_id=adjustment.warehouse_id, bin_id=adj_item.bin_id,
                batch_id=adj_item.batch_id, project_id=adj_item.project_id,
            )

    await db.commit()
    # Name the relationship: a bare refresh expires it, so the first caller to read
    # .items (the response model, for one) would lazy-load outside the greenlet.
    await db.refresh(adjustment, ["items"])
    return adjustment


async def act_on_adjustment(db: AsyncSession, adjustment_id: int, action: str, user) -> StockAdjustment:
    adjustment = (await db.execute(
        select(StockAdjustment).where(StockAdjustment.id == adjustment_id)
    )).scalar_one_or_none()
    if not adjustment:
        raise NotFoundError(f"Stock adjustment {adjustment_id} not found")
    if adjustment.status != "PENDING_APPROVAL":
        raise ValidationError(f"Adjustment is in status {adjustment.status}, cannot change")

    if action.upper() == "APPROVE":
        adjustment.status = "APPROVED"
        adjustment.approved_by_id = getattr(user, "id", None)
        adjustment.approved_by_name = getattr(user, "full_name", None)
        adjustment.approved_at = utcnow()

        for adj_item in adjustment.items:
            await move_stock(
                db, item_id=adj_item.item_id, qty=adj_item.quantity,
                direction=adj_item.direction, ref_type="ADJUSTMENT",
                ref_id=adjustment.id, ref_no=adjustment.adjustment_no, user=user,
                warehouse_id=adjustment.warehouse_id, bin_id=adj_item.bin_id,
                batch_id=adj_item.batch_id, project_id=adj_item.project_id,
            )
    elif action.upper() == "REJECT":
        adjustment.status = "REJECTED"
    else:
        raise ValidationError(f"Invalid action {action}")

    await db.commit()
    await db.refresh(adjustment)
    return adjustment


async def list_adjustments(db: AsyncSession, params: PageParams, warehouse_id: int | None = None,
                           status: str | None = None) -> dict:
    stmt = select(StockAdjustment)
    if warehouse_id:
        stmt = stmt.where(StockAdjustment.warehouse_id == warehouse_id)
    if status:
        stmt = stmt.where(StockAdjustment.status == status)
    return await paginate(db, stmt.order_by(StockAdjustment.created_at.desc()), params)


async def get_adjustment(db: AsyncSession, adjustment_id: int) -> StockAdjustment:
    adj = (await db.execute(
        select(StockAdjustment).where(StockAdjustment.id == adjustment_id)
    )).scalar_one_or_none()
    if not adj:
        raise NotFoundError(f"Stock adjustment {adjustment_id} not found")
    return adj


# ---------------- Stock Replenishment ----------------

async def get_stock_replenishment(db: AsyncSession, warehouse_id: int | None = None,
                                  category_id: int | None = None,
                                  criticality: str | None = None) -> list[dict]:
    """Items where total available quantity is below reorder level."""
    stmt = select(Item).where(Item.is_active.is_(True), Item.reorder_level.isnot(None), Item.reorder_level > 0)
    if category_id:
        stmt = stmt.where(Item.category_id == category_id)

    items = list((await db.execute(stmt)).scalars().all())
    results = []

    for item in items:
        stock_stmt = select(func.coalesce(func.sum(Stock.available_qty), 0)).where(Stock.item_id == item.id)
        if warehouse_id:
            stock_stmt = stock_stmt.where(Stock.warehouse_id == warehouse_id)

        avail_qty = float((await db.execute(stock_stmt)).scalar() or 0)
        reorder_lvl = float(item.reorder_level or 0)

        if avail_qty < reorder_lvl:
            min_order = float(item.min_order_qty or 1)
            reorder_qty = float(item.reorder_qty or (reorder_lvl * 2 - avail_qty))
            suggested = max(reorder_qty, min_order)

            wh_name = None
            if warehouse_id:
                wh = await db.get(Warehouse, warehouse_id)
                wh_name = wh.name if wh else None

            results.append({
                "item_id": item.id,
                "item_code": item.code,
                "item_name": item.name,
                "uom_code": item.uom_code,
                "category_name": str(item.category_id) if item.category_id else None,
                "warehouse_id": warehouse_id,
                "warehouse_name": wh_name,
                "available_qty": avail_qty,
                "reorder_level": reorder_lvl,
                "min_order_qty": min_order,
                "suggested_order_qty": suggested,
                "lead_time_days": getattr(item, "lead_time_days", 7),
                "last_purchase_price": float(item.last_purchase_price or item.std_cost or 0),
                "criticality": criticality or "HIGH",
            })

    return results


# ---------------- Reservations ----------------

async def list_reservations(db: AsyncSession, params: PageParams, item_id: int | None = None,
                            warehouse_id: int | None = None, status: str | None = None,
                            ref_type: str | None = None, ref_id: int | None = None) -> dict:
    stmt = select(Reservation)
    if item_id:
        stmt = stmt.where(Reservation.item_id == item_id)
    if warehouse_id:
        stmt = stmt.where(Reservation.warehouse_id == warehouse_id)
    if status:
        stmt = stmt.where(Reservation.status == status)
    if ref_type:
        stmt = stmt.where(Reservation.ref_type == ref_type)
    if ref_id:
        stmt = stmt.where(Reservation.ref_id == ref_id)

    return await paginate(db, stmt.order_by(Reservation.created_at.desc()), params)


async def release_reservation_by_id(db: AsyncSession, reservation_id: int) -> dict:
    res = await db.get(Reservation, reservation_id, with_for_update=True)
    if not res:
        raise NotFoundError(f"Reservation {reservation_id} not found")
    if res.status != "ACTIVE":
        raise ValidationError(f"Reservation is in status {res.status}, cannot release")

    stock = await db.get(Stock, res.stock_id, with_for_update=True)
    if stock:
        stock.reserved_qty = (stock.reserved_qty or Decimal("0")) - res.quantity
        stock.available_qty = (stock.available_qty or Decimal("0")) + res.quantity

    res.status = "RELEASED"
    res.released_at = utcnow()
    await db.commit()

    return {
        "reservation_id": res.id,
        "released_qty": float(res.quantity),
        "status": res.status,
    }


# ---------------- Live Availability ----------------

async def get_item_availability(db: AsyncSession, item_id: int, project_id: int | None = NO_PROJECT,
                                warehouse_id: int | None = None) -> dict:
    item = await db.get(Item, item_id)
    if not item:
        raise NotFoundError(f"Item {item_id} not found")

    stmt = select(Stock).where(Stock.item_id == item_id)
    if project_id is not None:
        stmt = stmt.where(Stock.project_id == project_id)
    if warehouse_id is not None:
        stmt = stmt.where(Stock.warehouse_id == warehouse_id)

    stocks = list((await db.execute(stmt)).scalars().all())

    strategy = availability.pick_strategy_for(item)
    sorted_stocks = sorted(stocks, key=availability.sort_key(strategy))

    total_avail = sum((s.available_qty or Decimal("0") for s in stocks), Decimal("0"))
    total_res = sum((s.reserved_qty or Decimal("0") for s in stocks), Decimal("0"))
    total_transit = sum((s.transit_qty or Decimal("0") for s in stocks), Decimal("0"))

    batches = [
        {
            "stock_id": s.id,
            "warehouse_id": s.warehouse_id,
            "warehouse_name": s.warehouse_name,
            "bin_id": s.bin_id,
            "bin_code": s.bin_code,
            "batch_id": s.batch_id,
            "batch_no": s.batch_no,
            "expiry_date": s.expiry_date,
            "project_id": s.project_id,
            "available_qty": float(s.available_qty or 0),
            "reserved_qty": float(s.reserved_qty or 0),
        }
        for s in sorted_stocks
    ]

    return {
        "item_id": item.id,
        "item_code": item.code,
        "item_name": item.name,
        "uom_code": item.uom_code,
        "total_available_qty": float(total_avail),
        "total_reserved_qty": float(total_res),
        "total_transit_qty": float(total_transit),
        "pick_strategy": strategy,
        "batches": batches,
    }


# ---------------- Ageing & Valuation ----------------

async def get_stock_ageing(db: AsyncSession, warehouse_id: int | None = None) -> dict:
    stmt = select(Stock).where(Stock.available_qty > 0)
    if warehouse_id:
        stmt = stmt.where(Stock.warehouse_id == warehouse_id)

    stocks = list((await db.execute(stmt)).scalars().all())
    now_dt = utcnow()
    today_d = now_dt.date()

    rows = []
    b0_30, b31_60, b61_90, b90_plus = Decimal("0"), Decimal("0"), Decimal("0"), Decimal("0")

    for s in stocks:
        last_mvmt = s.last_movement_at or now_dt
        days_in_stock = (now_dt - last_mvmt).days

        if days_in_stock <= 30:
            age_b = "0-30"
            b0_30 += (s.available_qty or Decimal("0"))
        elif days_in_stock <= 60:
            age_b = "31-60"
            b31_60 += (s.available_qty or Decimal("0"))
        elif days_in_stock <= 90:
            age_b = "61-90"
            b61_90 += (s.available_qty or Decimal("0"))
        else:
            age_b = "90+"
            b90_plus += (s.available_qty or Decimal("0"))

        days_to_exp = None
        exp_b = None
        if s.expiry_date:
            days_to_exp = (s.expiry_date - today_d).days
            if days_to_exp < 0:
                exp_b = "EXPIRED"
            elif days_to_exp <= 30:
                exp_b = "0-30"
            elif days_to_exp <= 60:
                exp_b = "31-60"
            elif days_to_exp <= 90:
                exp_b = "61-90"
            else:
                exp_b = "90+"

        rows.append({
            "stock_id": s.id,
            "item_id": s.item_id,
            "item_code": s.item_code,
            "item_name": s.item_name,
            "warehouse_id": s.warehouse_id,
            "warehouse_name": s.warehouse_name,
            "batch_no": s.batch_no,
            "expiry_date": s.expiry_date,
            "quantity": float(s.available_qty or 0),
            "days_in_stock": days_in_stock,
            "age_bucket": age_b,
            "days_to_expiry": days_to_exp,
            "expiry_bucket": exp_b,
        })

    return {
        "items": rows,
        "bucket_0_30_qty": float(b0_30),
        "bucket_31_60_qty": float(b31_60),
        "bucket_61_90_qty": float(b61_90),
        "bucket_90_plus_qty": float(b90_plus),
    }


async def get_stock_valuation(db: AsyncSession, warehouse_id: int | None = None) -> dict:
    """Moving average cost per item per warehouse based on items/stock."""
    stmt = select(Stock).where(Stock.total_qty > 0)
    if warehouse_id:
        stmt = stmt.where(Stock.warehouse_id == warehouse_id)

    stocks = list((await db.execute(stmt)).scalars().all())
    val_rows = []
    total_portfolio_val = Decimal("0")

    for s in stocks:
        item = await db.get(Item, s.item_id)
        # purchase_price is the only cost mst_items carries. The names tried before
        # (last_purchase_price / std_cost) are not columns, so every item fell through
        # to the literal 10.0 and the whole valuation was fiction.
        cost = _d(getattr(item, "purchase_price", 0) or 0)
        stock_val = (s.total_qty or Decimal("0")) * cost
        total_portfolio_val += stock_val

        val_rows.append({
            "item_id": s.item_id,
            "item_code": s.item_code,
            "item_name": s.item_name,
            "uom_code": s.uom_code,
            "warehouse_id": s.warehouse_id,
            "warehouse_name": s.warehouse_name,
            "total_qty": float(s.total_qty or 0),
            "moving_avg_cost": float(cost),
            "total_stock_value": float(stock_val),
        })

    return {
        "items": val_rows,
        "total_portfolio_value": float(total_portfolio_val),
    }


async def get_near_expiry_alerts(db: AsyncSession, days: int = 90) -> list[dict]:
    cutoff = utcnow().date() + timedelta(days=days)
    stmt = select(Stock).where(Stock.expiry_date.isnot(None), Stock.expiry_date <= cutoff, Stock.available_qty > 0)
    stocks = list((await db.execute(stmt.order_by(Stock.expiry_date.asc()))).scalars().all())

    today_d = utcnow().date()
    alerts = []
    for s in stocks:
        days_rem = (s.expiry_date - today_d).days
        alerts.append({
            "stock_id": s.id,
            "item_id": s.item_id,
            "item_code": s.item_code,
            "item_name": s.item_name,
            "warehouse_id": s.warehouse_id,
            "warehouse_name": s.warehouse_name,
            "batch_no": s.batch_no,
            "expiry_date": s.expiry_date,
            "days_to_expiry": days_rem,
            "quantity": float(s.available_qty or 0),
        })
    return alerts


# ---------------- STO (Stock Transfer Order) ----------------

async def create_sto(db: AsyncSession, data, user) -> StockTransferOrder:
    from_wh = await db.get(Warehouse, data.from_warehouse_id)
    to_wh = await db.get(Warehouse, data.to_warehouse_id)
    if not from_wh or not to_wh:
        raise NotFoundError("Source or destination warehouse not found")

    sto_no = await next_number(db, "sto")
    sto = StockTransferOrder(
        sto_no=sto_no,
        from_warehouse_id=data.from_warehouse_id,
        from_warehouse_name=from_wh.name,
        to_warehouse_id=data.to_warehouse_id,
        to_warehouse_name=to_wh.name,
        from_project_id=data.from_project_id or NO_PROJECT,
        to_project_id=data.to_project_id or NO_PROJECT,
        status="PENDING_APPROVAL",
        requested_by_id=getattr(user, "id", None),
        requested_by_name=getattr(user, "full_name", None),
        remarks=data.remarks,
    )
    db.add(sto)
    await db.flush()

    for item_data in data.items:
        item = await db.get(Item, item_data.item_id)
        db.add(StockTransferOrderItem(
            sto_id=sto.id,
            item_id=item_data.item_id,
            item_code=item.code if item else None,
            item_name=item.name if item else None,
            uom_code=item.uom_code if item else None,
            requested_qty=_d(item_data.requested_qty),
            remarks=item_data.remarks,
        ))

    await db.commit()
    await db.refresh(sto)
    return sto


async def get_sto(db: AsyncSession, sto_id: int) -> StockTransferOrder:
    sto = (await db.execute(
        select(StockTransferOrder).where(StockTransferOrder.id == sto_id)
    )).scalar_one_or_none()
    if not sto:
        raise NotFoundError(f"STO {sto_id} not found")
    return sto


async def list_stos(db: AsyncSession, params: PageParams, status: str | None = None) -> dict:
    stmt = select(StockTransferOrder)
    if status:
        stmt = stmt.where(StockTransferOrder.status == status)
    return await paginate(db, stmt.order_by(StockTransferOrder.created_at.desc()), params)


async def approve_sto(db: AsyncSession, sto_id: int, user) -> StockTransferOrder:
    sto = await get_sto(db, sto_id)
    if sto.status != "PENDING_APPROVAL":
        raise ValidationError(f"STO is in status {sto.status}, cannot approve")

    sto.status = "APPROVED"
    sto.approved_by_name = getattr(user, "full_name", None)
    sto.approved_at = utcnow()
    await db.commit()
    await db.refresh(sto)
    return sto


async def dispatch_sto(db: AsyncSession, sto_id: int, user) -> StockTransferOrder:
    sto = await get_sto(db, sto_id)
    if sto.status != "APPROVED":
        raise ValidationError(f"STO is in status {sto.status}, cannot dispatch")

    sto.status = "DISPATCHED"
    sto.dispatched_at = utcnow()
    for sto_item in sto.items:
        sto_item.dispatched_qty = sto_item.requested_qty

    await db.commit()
    await db.refresh(sto)
    return sto


async def receive_sto(db: AsyncSession, sto_id: int, user) -> StockTransferOrder:
    """Receiving STO physically moves stock via move_stock()."""
    sto = await get_sto(db, sto_id)
    if sto.status != "DISPATCHED":
        raise ValidationError(f"STO is in status {sto.status}, cannot receive")

    for sto_item in sto.items:
        qty = sto_item.dispatched_qty or sto_item.requested_qty
        sto_item.received_qty = qty
        # OUT from source, IN to destination
        await move_stock(
            db, item_id=sto_item.item_id, qty=qty, direction=StockDirection.OUT.value,
            ref_type="STO", ref_id=sto.id, ref_no=sto.sto_no, user=user,
            warehouse_id=sto.from_warehouse_id, project_id=sto.from_project_id,
        )
        await move_stock(
            db, item_id=sto_item.item_id, qty=qty, direction=StockDirection.IN.value,
            ref_type="STO", ref_id=sto.id, ref_no=sto.sto_no, user=user,
            warehouse_id=sto.to_warehouse_id, project_id=sto.to_project_id,
        )

    sto.status = "RECEIVED"
    sto.received_at = utcnow()
    await db.commit()
    await db.refresh(sto)
    return sto


# ---------------- Cycle Count ----------------

async def create_cycle_count(db: AsyncSession, data, user) -> CycleCount:
    wh = await db.get(Warehouse, data.warehouse_id)
    if not wh:
        raise NotFoundError(f"Warehouse {data.warehouse_id} not found")

    count_no = await next_number(db, "cc")
    cc = CycleCount(
        count_no=count_no,
        warehouse_id=data.warehouse_id,
        warehouse_name=wh.name,
        count_date=data.count_date,
        status="PLANNED",
        planned_by_name=getattr(user, "full_name", None),
        remarks=data.remarks,
    )
    db.add(cc)
    await db.flush()

    # Populate snapshot quantities from Stock
    stock_stmt = select(Stock).where(Stock.warehouse_id == data.warehouse_id)
    if data.item_ids:
        stock_stmt = stock_stmt.where(Stock.item_id.in_(data.item_ids))
    stocks = list((await db.execute(stock_stmt)).scalars().all())

    for s in stocks:
        db.add(CycleCountItem(
            cycle_count_id=cc.id,
            item_id=s.item_id,
            item_code=s.item_code,
            item_name=s.item_name,
            uom_code=s.uom_code,
            bin_id=s.bin_id,
            batch_id=s.batch_id,
            snapshot_qty=s.available_qty or Decimal("0"),
        ))

    await db.commit()
    await db.refresh(cc)
    return cc


async def get_cycle_count(db: AsyncSession, cc_id: int) -> CycleCount:
    cc = (await db.execute(
        select(CycleCount).where(CycleCount.id == cc_id)
    )).scalar_one_or_none()
    if not cc:
        raise NotFoundError(f"Cycle count {cc_id} not found")
    return cc


async def list_cycle_counts(db: AsyncSession, params: PageParams, warehouse_id: int | None = None,
                           status: str | None = None) -> dict:
    stmt = select(CycleCount)
    if warehouse_id:
        stmt = stmt.where(CycleCount.warehouse_id == warehouse_id)
    if status:
        stmt = stmt.where(CycleCount.status == status)
    return await paginate(db, stmt.order_by(CycleCount.created_at.desc()), params)


async def update_cycle_count(db: AsyncSession, cc_id: int, data, user) -> CycleCount:
    cc = await get_cycle_count(db, cc_id)
    if cc.status not in ("PLANNED", "IN_PROGRESS"):
        raise ValidationError(f"Cycle count is in status {cc.status}, cannot update")

    cc.status = "IN_PROGRESS"
    if data.remarks:
        cc.remarks = data.remarks

    item_map = {item.id: item for item in cc.items}
    for item_upd in data.items:
        cc_item = item_map.get(item_upd.id)
        if cc_item:
            cc_item.counted_qty = _d(item_upd.counted_qty)
            cc_item.variance_qty = cc_item.counted_qty - (cc_item.snapshot_qty or Decimal("0"))
            if item_upd.remarks:
                cc_item.remarks = item_upd.remarks

    await db.commit()
    await db.refresh(cc)
    return cc


async def post_cycle_count(db: AsyncSession, cc_id: int, user) -> CycleCount:
    """Post cycle count variances as stock adjustments via move_stock()."""
    cc = await get_cycle_count(db, cc_id)
    if cc.status != "IN_PROGRESS":
        raise ValidationError(f"Cycle count is in status {cc.status}, must be IN_PROGRESS to post")

    for item in cc.items:
        if item.counted_qty is None:
            continue
        variance = item.variance_qty or Decimal("0")
        if variance == Decimal("0"):
            continue

        direction = StockDirection.IN.value if variance > 0 else StockDirection.OUT.value
        qty = abs(variance)

        await move_stock(
            db, item_id=item.item_id, qty=qty, direction=direction,
            ref_type="CYCLE_COUNT", ref_id=cc.id, ref_no=cc.count_no, user=user,
            warehouse_id=cc.warehouse_id, bin_id=item.bin_id, batch_id=item.batch_id,
        )

    cc.status = "COMPLETED"
    cc.posted_by_name = getattr(user, "full_name", None)
    cc.posted_at = utcnow()
    await db.commit()
    await db.refresh(cc)
    return cc


# ---------------- Overview KPIs ----------------

async def get_overview_kpis(db: AsyncSession) -> dict:
    val = await get_stock_valuation(db)
    tot_val = val["total_portfolio_value"]

    reorder = await get_stock_replenishment(db)
    items_below_reorder = len(reorder)

    exp30 = len(await get_near_expiry_alerts(db, 30))
    exp60 = len(await get_near_expiry_alerts(db, 60))
    exp90 = len(await get_near_expiry_alerts(db, 90))

    tot_avail = float((await db.execute(select(func.coalesce(func.sum(Stock.available_qty), 0)))).scalar() or 0)
    tot_res = float((await db.execute(select(func.coalesce(func.sum(Stock.reserved_qty), 0)))).scalar() or 0)

    # Dead stock: available > 0 and last_movement_at < today - 60 days
    cutoff_date = utcnow() - timedelta(days=60)
    dead_stmt = select(func.count(Stock.id)).where(Stock.available_qty > 0, or_(Stock.last_movement_at.is_(None), Stock.last_movement_at < cutoff_date))
    dead_count = int((await db.execute(dead_stmt)).scalar() or 0)

    return {
        "total_stock_value": tot_val,
        "items_below_reorder": items_below_reorder,
        "near_expiry_30_days": exp30,
        "near_expiry_60_days": exp60,
        "near_expiry_90_days": exp90,
        "total_reserved_qty": tot_res,
        "total_available_qty": tot_avail,
        "dead_stock_count": dead_count,
    }


