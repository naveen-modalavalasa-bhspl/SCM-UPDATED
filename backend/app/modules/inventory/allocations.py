"""Allocation: inventory's decision on how much stock an approved indent actually gets.

This is a document, not a calculation. Sixty bags of cement with four projects wanting
it is a judgement — who gets what, from which warehouse, and what waits. The system
proposes what is available; a person decides what to give.

Nothing is reserved until the allocation is APPROVED. FEFO then picks the batch inside
the warehouse the allocator chose; it never changes the quantity they decided.

Kept out of service.py because that file already owns stock movement and material
requests, and this is a third responsibility with its own lifecycle.
"""
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
from app.modules.inventory import allocation, availability
from app.modules.inventory.models import (
    NO_PROJECT, Allocation, AllocationItem,
)
from app.platform.rules import evaluator as rules
from app.platform.settings.service import write_audit
from app.platform.workflow import engine
from app.shared.enums import (
    AllocationStatus, AuditAction, DocType, IndentStatus, InstanceStatus, RefType,
)
from app.shared.models.base import utcnow
from app.shared.models.master import Item
from app.shared.models.warehouse import Warehouse
from app.shared.numbering import next_number

ZERO = Decimal("0")
# An allocation still in play. APPROVED belongs here: an approved allocation is a
# live claim on stock, not a finished one — it stays live until the warehouse has
# issued against it. Leaving it out let IND/2026-27/00013 collect four APPROVED
# allocations, each one reserving the same stock for the same requirement again.
ACTIVE_ALLOCATION_STATUSES = (
    AllocationStatus.DRAFT.value,
    AllocationStatus.PENDING_APPROVAL.value,
    AllocationStatus.APPROVED.value,
)


def _d(value) -> Decimal:
    return Decimal(str(value or 0))


async def ensure_no_active(db: AsyncSession, indent_id: int) -> None:
    """An indent may have only one live allocation at a time."""
    existing = (await db.execute(
        select(Allocation.allocation_no, Allocation.status)
        .where(
            Allocation.indent_id == indent_id,
            Allocation.status.in_(ACTIVE_ALLOCATION_STATUSES),
        )
        .limit(1)
    )).first()
    if existing:
        state = (
            "is already awaiting approval"
            if existing.status != AllocationStatus.APPROVED.value
            else "is already approved and holding stock for this indent"
        )
        raise ValidationError(
            f"Allocation {existing.allocation_no} {state}. Cancel it before "
            f"allocating again."
        )


# ---------------- propose: read-only ----------------

async def propose(db: AsyncSession, indent_id: int, lines: list[dict],
                  warehouse_types: list[str] | None = None) -> list[dict]:
    """What each line wants, and what is actually on the shelf for it.

    Writes nothing, reserves nothing. This is the allocation screen's data.

    `competing_demand` is the point of the exercise: 60 bags on hand means nothing
    until you know three other indents are also waiting for cement.
    """
    out = []
    for line in lines:
        item = await db.get(Item, line["item_id"])
        strategy = availability.pick_strategy_for(item) if item else None
        rows = await availability.candidate_stock(
            db, line["item_id"], line.get("project_id") or NO_PROJECT,
            warehouse_types, strategy or availability.PickStrategy.FIFO.value)

        by_warehouse: dict[int, dict] = {}
        for stock in rows:
            entry = by_warehouse.setdefault(stock.warehouse_id, {
                "warehouse_id": stock.warehouse_id,
                "warehouse_name": stock.warehouse_name,
                "available_qty": ZERO,
            })
            entry["available_qty"] += stock.available_qty or ZERO

        out.append({
            **line,
            "available_total": sum(
                (w["available_qty"] for w in by_warehouse.values()), ZERO),
            "warehouses": list(by_warehouse.values()),
            "competing_demand": await competing_demand(db, line["item_id"], indent_id),
        })
    return out


async def competing_demand(db: AsyncSession, item_id: int,
                           exclude_indent_id: int) -> Decimal:
    """How much of this item other allocations are already holding a claim on."""
    stmt = (
        select(func.coalesce(func.sum(AllocationItem.requested_qty), 0))
        .join(Allocation, Allocation.id == AllocationItem.allocation_id)
        .where(AllocationItem.item_id == item_id,
               Allocation.indent_id != exclude_indent_id,
               Allocation.status.in_([AllocationStatus.DRAFT.value,
                                      AllocationStatus.PENDING_APPROVAL.value]))
    )
    return _d((await db.execute(stmt)).scalar())


# ---------------- the decision ----------------

async def create(db: AsyncSession, indent_id: int, indent_no: str,
                 decisions: list[dict], user, ctx: dict | None = None,
                 on_approved=None) -> Allocation:
    """Record what a person decided to give, and send it for approval.

    `decisions` is one entry per (indent line, warehouse) chosen: indent_item_id,
    item_id, quantity, warehouse_id, requested_qty, plus item snapshot fields. A
    quantity of zero is allowed and meaningful — "give nothing now" is a decision
    somebody made and should be able to defend.

    NOTHING IS RESERVED HERE.
    """
    if not decisions:
        raise ValidationError("An allocation needs at least one line")
    await ensure_no_active(db, indent_id)

    ctx = ctx or {}
    alloc = Allocation(
        allocation_no=await next_number(db, "allocation"),
        indent_id=indent_id, indent_no=indent_no,
        status=AllocationStatus.DRAFT.value,
        allocated_by_id=getattr(user, "id", None),
        allocated_by_name=getattr(user, "full_name", None),
        department_id=ctx.get("department_id"),
        remarks=ctx.get("remarks"),
    )
    db.add(alloc)
    await db.flush()

    for d in decisions:
        quantity = _d(d.get("quantity"))
        warehouse = (await db.get(Warehouse, d["warehouse_id"])
                     if d.get("warehouse_id") else None)
        if d.get("warehouse_id") and warehouse is None:
            raise ValidationError(f"Warehouse {d['warehouse_id']} not found")
        if quantity > ZERO and warehouse is None:
            raise ValidationError("A positive allocation quantity needs a warehouse")
        db.add(AllocationItem(
            allocation_id=alloc.id,
            indent_item_id=d["indent_item_id"], item_id=d["item_id"],
            item_code=d.get("item_code"), item_name=d.get("item_name"),
            uom_code=d.get("uom_code"),
            requested_qty=_d(d.get("requested_qty")),
            quantity=quantity,
            warehouse_id=d.get("warehouse_id"),
            warehouse_name=warehouse.name if warehouse else None,
            project_id=d.get("project_id") or NO_PROJECT,
            remarks=d.get("remarks"),
        ))
    await db.flush()

    instance = await engine.start(
        db, doc_type=DocType.ALLOCATION.value, doc_id=alloc.id,
        context={
            "doc_no": alloc.allocation_no,
            "doc_summary": f"Stock allocation for {indent_no}",
            "department_id": alloc.department_id,
            "requester_position_id": ctx.get("requester_position_id"),
            # The indent's project, not the allocator's: inventory allocates for every
            # project, and its own people are rarely tagged to the one being served.
            "project_id": ctx.get("project_id"),
        },
        user=user,
    )
    # The ladder can finish at submit — the raiser is the top of it, or the only rung
    # resolves to him and the policy lets him approve. Setting PENDING_APPROVAL anyway
    # left the document and its workflow disagreeing: Allocation Approvals showed
    # nothing (there is no pending row), the Fulfilment Queue hid the indent (it sees
    # PENDING_APPROVAL), and nothing was ever reserved. The engine owns the approval,
    # the module owns the status — so the status follows what the engine actually did.
    if instance.status == InstanceStatus.APPROVED.value:
        # The lines were only just added; loading them lazily inside apply_to_stock
        # would be a blocking IO call on the async session.
        await db.refresh(alloc, ["items"])
        await _settle_approved(db, alloc, user, ctx, on_approved)
    else:
        alloc.status = AllocationStatus.PENDING_APPROVAL.value
        await _refresh_approver(db, alloc)

    await write_audit(
        db, entity="inv_allocations", entity_id=alloc.id,
        entity_no=alloc.allocation_no, action=AuditAction.CREATE, actor=user,
        after={"status": alloc.status, "indent_no": indent_no,
               "lines": len(decisions)},
        summary=f"Stock allocation proposed for {indent_no}",
    )
    await db.commit()
    await db.refresh(alloc)
    return alloc


async def _settle_approved(db: AsyncSession, alloc: Allocation, user,
                           ctx: dict | None, on_approved=None) -> None:
    """Everything approval means: status, reservations, the downstream handoff.

    Shared by create() and act() on purpose. The engine can approve at either moment —
    at submit when the ladder resolves to nobody but the raiser, or later when a real
    approver acts — and the document must end up in exactly the same state both times.
    """
    alloc.status = AllocationStatus.APPROVED.value
    alloc.approved_at = utcnow()
    alloc.current_approver_name = None
    implied_indent_status = await apply_to_stock(db, alloc, user, ctx)
    if on_approved is not None:
        # The owning business module supplies its downstream handoff. Keeping the
        # callback inside this transaction means approval, reservations and the
        # generated warehouse drafts succeed or roll back together.
        await on_approved(db, alloc, user)
    await rules.safe_fire(
        db,
        "ALLOCATION_APPROVED",
        {
            "allocation_id": alloc.id,
            "indent_id": alloc.indent_id,
            "given_qty": float(sum(_d(line.quantity) for line in alloc.items)),
            "status": implied_indent_status,
        },
        doc_type=DocType.ALLOCATION.value,
        doc_id=alloc.id,
    )


async def _refresh_approver(db: AsyncSession, alloc: Allocation) -> None:
    approvers = await engine.current_approvers(db, DocType.ALLOCATION.value, alloc.id)
    alloc.current_approver_name = ", ".join(a.full_name for a in approvers) or None


async def get(db: AsyncSession, allocation_id: int) -> Allocation:
    alloc = (await db.execute(
        select(Allocation).where(Allocation.id == allocation_id)
    )).scalar_one_or_none()
    if not alloc:
        raise NotFoundError(f"Allocation {allocation_id} not found")
    return alloc


async def list_allocations(db: AsyncSession, params: PageParams,
                           status: str | None = None,
                           indent_id: int | None = None) -> dict:
    stmt = select(Allocation)
    if status:
        stmt = stmt.where(Allocation.status == status)
    if indent_id is not None:
        stmt = stmt.where(Allocation.indent_id == indent_id)
    return await paginate(db, stmt.order_by(Allocation.created_at.desc()), params)


async def act(db: AsyncSession, allocation_id: int, action: str, user,
              comments: str = "", ctx: dict | None = None,
              on_approved=None) -> Allocation:
    """Approve or reject the decision. Approval is what finally moves stock.

    `ctx` carries what only the indent knows — its project — down to the material
    request approval raises. Inventory cannot read ind_indents itself (it is the base
    module), so the caller in indents hands it over.
    """
    ctx = ctx or {}
    alloc = await get(db, allocation_id)
    if alloc.status != AllocationStatus.PENDING_APPROVAL.value:
        raise ValidationError(
            f"Allocation is not awaiting approval (status {alloc.status})")

    before = alloc.status
    instance = await engine.act(
        db, DocType.ALLOCATION.value, alloc.id, action, user, comments,
        context={"doc_no": alloc.allocation_no, "department_id": alloc.department_id},
    )

    if instance.status == InstanceStatus.APPROVED.value:
        await _settle_approved(db, alloc, user, ctx, on_approved)
    elif instance.status == InstanceStatus.REJECTED.value:
        alloc.status = AllocationStatus.REJECTED.value
        alloc.current_approver_name = None
    else:
        await _refresh_approver(db, alloc)

    await write_audit(
        db, entity="inv_allocations", entity_id=alloc.id,
        entity_no=alloc.allocation_no, action=AuditAction.UPDATE, actor=user,
        before={"status": before}, after={"status": alloc.status},
        summary=f"{action.title()} stock allocation",
    )
    await db.commit()
    await db.refresh(alloc)
    return alloc


async def apply_to_stock(db: AsyncSession, alloc: Allocation, user,
                         ctx: dict | None = None) -> str:
    """Turn an approved decision into reservations, then one MR for the remainder.

    Returns the indent status this implies. Runs only on approval.
    """
    # Import here rather than at module load: service imports nothing from this file,
    # but this file needs its MR helper, and a top-level import would close the loop.
    from app.modules.inventory import service

    shortfalls, requested_total, given_total = [], ZERO, ZERO

    for line in alloc.items:
        requested_total += _d(line.requested_qty)
        given_total += _d(line.quantity)

        if _d(line.quantity) > ZERO:
            await allocation.reserve(
                db, line.item_id, line.quantity, RefType.RESERVATION.value,
                alloc.indent_id, alloc.indent_no, user,
                project_id=line.project_id or NO_PROJECT,
                warehouse_ids=[line.warehouse_id] if line.warehouse_id else None,
                ref_line_id=line.indent_item_id,
                item=await db.get(Item, line.item_id),
            )

        short = _d(line.requested_qty) - _d(line.quantity)
        if short > ZERO:
            # Only what the warehouse genuinely cannot supply becomes procurement
            # demand. A storekeeper who deliberately issues less than was asked for
            # — because the request was generous, or the rest is not needed yet —
            # used to raise a material request for the difference anyway, so
            # procurement chased stock that was sitting on the shelf. Availability is
            # read after this line's own reservation, so it is what is genuinely
            # spare.
            spare = _d(await availability.available_for(
                db, line.item_id, project_id=line.project_id or NO_PROJECT))
            unavailable = short - spare
            if unavailable > ZERO:
                shortfalls.append({
                    "item_id": line.item_id, "item_code": line.item_code,
                    "item_name": line.item_name, "uom_code": line.uom_code,
                    "quantity": unavailable, "project_id": line.project_id,
                    "indent_item_id": line.indent_item_id,
                })

    if shortfalls:
        ctx = ctx or {}
        await service.create_mr_from_shortfall(
            db, alloc.indent_id, alloc.indent_no, shortfalls, user,
            {
                "department_id": alloc.department_id,
                # From the indent, handed down by the caller: the MR belongs to the
                # project that asked for the material, not to whoever approved.
                "project_id": ctx.get("project_id"),
                "project_name": ctx.get("project_name"),
                "requester_position_id": getattr(user, "active_position_id", None),
            })

    if given_total <= ZERO:
        return IndentStatus.PENDING_PROCUREMENT.value
    if given_total >= requested_total:
        return IndentStatus.ALLOCATED.value
    return IndentStatus.PARTIALLY_FULFILLED.value
