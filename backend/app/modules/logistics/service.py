"""Logistics business logic: GRN, QC, stock and issues.

May import procurement (backward in the chain). Stock is mutated ONLY through
move_stock(); no code anywhere assigns stk_stock.quantity directly.
"""
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
from app.modules.logistics.models import (
    GRN, GRNItem, Issue, IssueItem, Stock, StockMovement,
)
from app.modules.logistics.schemas import GRNCreate, IssueCreate
from app.modules.procurement import service as po_service
from app.modules.procurement.models import POItem
from app.shared.enums import GRNStatus, IssueStatus, POStatus, RefType, StockDirection
from app.shared.models.base import utcnow
from app.shared.models.master import Item
from app.shared.numbering import next_number


def _d(value) -> Decimal:
    return Decimal(str(value))


# ---------------- stock: the single mutation point ----------------

async def move_stock(db: AsyncSession, facility_id: int, item_id: int, qty,
                     direction: str, ref_type: str, ref_id: int, ref_no: str, user) -> Stock:
    """The ONLY function that changes stock. Always writes a stk_movements row."""
    qty = _d(qty)
    if qty <= 0:
        raise ValidationError("Stock movement quantity must be positive")

    stock = (await db.execute(
        select(Stock).where(Stock.facility_id == facility_id, Stock.item_id == item_id)
        .with_for_update()
    )).scalar_one_or_none()
    if stock is None:
        item = await db.get(Item, item_id)
        stock = Stock(facility_id=facility_id, item_id=item_id,
                      item_code=item.code if item else None,
                      item_name=item.name if item else None, quantity=Decimal("0"))
        db.add(stock)
        await db.flush()

    delta = qty if direction == StockDirection.IN.value else -qty
    new_balance = (stock.quantity or Decimal("0")) + delta
    if new_balance < 0:
        raise ValidationError("Insufficient stock for this movement")
    stock.quantity = new_balance

    db.add(StockMovement(
        facility_id=facility_id, item_id=item_id, direction=direction, quantity=qty,
        balance_after=new_balance, ref_type=ref_type, ref_id=ref_id, ref_no=ref_no,
        created_by_id=user.id, created_by_name=user.full_name,
    ))
    await db.flush()
    return stock


async def list_stock(db: AsyncSession, params: PageParams, item_id: int | None = None,
                     facility_id: int | None = None) -> dict:
    stmt = select(Stock)
    if item_id is not None:
        stmt = stmt.where(Stock.item_id == item_id)
    if facility_id is not None:
        stmt = stmt.where(Stock.facility_id == facility_id)
    return await paginate(db, stmt.order_by(Stock.item_name), params)


async def list_movements(db: AsyncSession, params: PageParams, item_id: int | None = None) -> dict:
    stmt = select(StockMovement)
    if item_id is not None:
        stmt = stmt.where(StockMovement.item_id == item_id)
    return await paginate(db, stmt.order_by(StockMovement.created_at.desc()), params)


# ---------------- GRN ----------------

async def get_grn(db: AsyncSession, grn_id: int) -> GRN:
    grn = (await db.execute(select(GRN).where(GRN.id == grn_id))).scalar_one_or_none()
    if not grn:
        raise NotFoundError(f"GRN {grn_id} not found")
    return grn


async def list_grn(db: AsyncSession, params: PageParams, status: str | None = None,
                   po_id: int | None = None) -> dict:
    stmt = select(GRN)
    if status:
        stmt = stmt.where(GRN.status == status)
    if po_id is not None:
        stmt = stmt.where(GRN.po_id == po_id)
    return await paginate(db, stmt.order_by(GRN.created_at.desc()), params)


async def create_grn_from_po(db: AsyncSession, po_id: int, data: GRNCreate, user) -> GRN:
    po = await po_service.get_po(db, po_id)
    if po.status not in (POStatus.SENT_TO_VENDOR.value, POStatus.PARTIALLY_RECEIVED.value):
        raise ValidationError("PO is not open for receipt")
    if not data.lines:
        raise ValidationError("GRN must have at least one line")

    grn = GRN(
        grn_no=await next_number(db, "grn"),
        grn_date=utcnow().date(),
        po_id=po.id, po_no=po.po_no,
        vendor_id=po.vendor_id, vendor_name=po.vendor_name,
        facility_id=po.facility_id, facility_name=po.facility_name,
        invoice_no=data.invoice_no, invoice_date=data.invoice_date,
        vehicle_no=data.vehicle_no, transporter=data.transporter,
        received_by_id=user.id, received_by_name=user.full_name,
        status=GRNStatus.RECEIVED.value, total_items=len(data.lines), remarks=data.remarks,
    )
    db.add(grn)
    await db.flush()

    items_map = {i.id: i for i in (await db.execute(
        select(Item).where(Item.id.in_([l.item_id for l in data.lines]))
    )).scalars().all()}

    for line in data.lines:
        item = items_map.get(line.item_id)
        po_item = await db.get(POItem, line.po_item_id) if line.po_item_id else None
        db.add(GRNItem(
            grn_id=grn.id, po_item_id=line.po_item_id, item_id=line.item_id,
            item_code=item.code if item else None, item_name=item.name if item else None,
            uom_code=item.uom_code if item else None,
            ordered_quantity=(po_item.quantity if po_item else 0),
            received_quantity=_d(line.received_quantity),
            accepted_quantity=_d(line.accepted_quantity),
            rejected_quantity=_d(line.rejected_quantity),
            batch_no=line.batch_no,
        ))
        if po_item:
            po_item.received_quantity = (po_item.received_quantity or 0) + _d(line.received_quantity)

    # fully received across all lines?  -> RECEIVED, else PARTIALLY_RECEIVED
    po_items = (await db.execute(select(POItem).where(POItem.po_id == po.id))).scalars().all()
    all_received = all((pi.received_quantity or 0) >= pi.quantity for pi in po_items)
    po.status = POStatus.RECEIVED.value if all_received else POStatus.PARTIALLY_RECEIVED.value

    await db.commit()
    await db.refresh(grn)
    return grn


async def qc_pass(db: AsyncSession, grn_id: int, user) -> GRN:
    """QC pass moves accepted quantities INTO stock at the GRN's facility."""
    grn = await get_grn(db, grn_id)
    if grn.status != GRNStatus.RECEIVED.value:
        raise ValidationError(f"Cannot QC a GRN in {grn.status} status")

    grn.status = GRNStatus.QC_PASSED.value
    for line in grn.items:
        if line.accepted_quantity and line.accepted_quantity > 0:
            await move_stock(
                db, facility_id=grn.facility_id, item_id=line.item_id,
                qty=line.accepted_quantity, direction=StockDirection.IN.value,
                ref_type=RefType.GRN.value, ref_id=grn.id, ref_no=grn.grn_no, user=user,
            )
    await db.commit()
    await db.refresh(grn)
    return grn


async def qc_fail(db: AsyncSession, grn_id: int, user) -> GRN:
    grn = await get_grn(db, grn_id)
    if grn.status != GRNStatus.RECEIVED.value:
        raise ValidationError(f"Cannot QC a GRN in {grn.status} status")
    grn.status = GRNStatus.QC_FAILED.value
    await db.commit()
    await db.refresh(grn)
    return grn


# ---------------- Issues ----------------

async def get_issue(db: AsyncSession, issue_id: int) -> Issue:
    issue = (await db.execute(select(Issue).where(Issue.id == issue_id))).scalar_one_or_none()
    if not issue:
        raise NotFoundError(f"Issue {issue_id} not found")
    return issue


async def list_issues(db: AsyncSession, params: PageParams) -> dict:
    return await paginate(db, select(Issue).order_by(Issue.created_at.desc()), params)


async def create_issue(db: AsyncSession, data: IssueCreate, user) -> Issue:
    if not data.lines:
        raise ValidationError("Issue must have at least one line")
    items_map = {i.id: i for i in (await db.execute(
        select(Item).where(Item.id.in_([l.item_id for l in data.lines]))
    )).scalars().all()}
    issue = Issue(
        issue_no=await next_number(db, "issue"),
        issue_date=utcnow().date(),
        indent_id=data.indent_id, facility_id=data.facility_id,
        department_id=data.department_id, issued_by_id=user.id,
        issued_by_name=user.full_name, status=IssueStatus.DRAFT.value, remarks=data.remarks,
    )
    db.add(issue)
    await db.flush()
    for line in data.lines:
        item = items_map.get(line.item_id)
        db.add(IssueItem(
            issue_id=issue.id, item_id=line.item_id,
            item_code=item.code if item else None, item_name=item.name if item else None,
            uom_code=item.uom_code if item else None, quantity=_d(line.quantity),
            batch_no=line.batch_no,
        ))
    await db.commit()
    await db.refresh(issue)
    return issue


async def issue_stock(db: AsyncSession, issue_id: int, user) -> Issue:
    """Issue OUT: decrements stock at the issuing facility."""
    issue = await get_issue(db, issue_id)
    if issue.status != IssueStatus.DRAFT.value:
        raise ValidationError(f"Cannot issue an issue in {issue.status} status")
    for line in issue.items:
        await move_stock(
            db, facility_id=issue.facility_id, item_id=line.item_id, qty=line.quantity,
            direction=StockDirection.OUT.value, ref_type=RefType.ISSUE.value,
            ref_id=issue.id, ref_no=issue.issue_no, user=user,
        )
    issue.status = IssueStatus.ISSUED.value
    await db.commit()
    await db.refresh(issue)
    return issue
