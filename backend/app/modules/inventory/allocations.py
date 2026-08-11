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

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
from app.modules.inventory import allocation, availability
from app.modules.inventory.models import (
    NO_PROJECT, Allocation, AllocationItem, Stock,
)
from app.platform.rules import evaluator as rules
from app.platform.settings.service import write_audit
from app.platform.workflow import engine
from app.platform.workflow.models import Instance
from app.shared.enums import (
    AllocationStatus, AuditAction, DocType, IndentStatus, InstanceStatus, RefType,
)
from app.shared.models.base import utcnow
from app.shared.models.master import Item
from app.shared.models.warehouse import Warehouse
from app.shared.numbering import next_number

ZERO = Decimal("0")
# The two events an allocation can be raised under. ALLOCATION is the inventory desk
# deciding for somebody else's stock; OWN_STOCK_ALLOCATION is the person who holds the
# point serving it himself. Same document, same screens — different approver.
ALLOCATION_DOC_TYPES = (
    DocType.ALLOCATION.value, DocType.OWN_STOCK_ALLOCATION.value,
)
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


async def ensure_no_active(db: AsyncSession, indent_id: int,
                           allow_approved: bool = False) -> None:
    """An indent may have only one live allocation at a time.

    `allow_approved` lifts the bar for the APPROVED ones only, and only when the
    caller has checked the indent still owes something the approved allocations do
    not cover. That is the cascade: an OE serves what they hold, their allocation is
    approved, and the DM above must still be able to allocate the remainder. An
    unapproved allocation always blocks — two proposals in flight for the same
    requirement is the duplicate the guard was written for.
    """
    statuses = (ACTIVE_ALLOCATION_STATUSES if not allow_approved
                else (AllocationStatus.DRAFT.value,
                      AllocationStatus.PENDING_APPROVAL.value))
    existing = (await db.execute(
        select(Allocation.allocation_no, Allocation.status)
        .where(
            Allocation.indent_id == indent_id,
            Allocation.status.in_(statuses),
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
                  warehouse_types: list[str] | None = None,
                  warehouse_ids: list[int] | None = None) -> list[dict]:
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
            warehouse_types, strategy or availability.PickStrategy.FIFO.value,
            warehouse_ids=warehouse_ids)

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


async def competing_claims(
    db: AsyncSession, item_id: int, exclude_indent_id: int,
    warehouse_ids: set[int] | None = None,
) -> dict:
    """WHO is holding that claim — the same number `competing_demand` returns, itemised.

    "12 claimed by other indents" on its own is a number an allocator cannot act on:
    the next question is always which indents, how much each, and whether those claims
    are signed or still waiting. Same filter as `competing_demand` (DRAFT and
    PENDING_APPROVAL against a different indent) so the total below the list is always
    the total on the line above it.

    `warehouse_ids` scopes the stock summary to the points this login may draw from —
    the claims themselves are not scoped, because a claim raised somewhere else is
    exactly what the allocator needs to know about.
    """
    from app.modules.indents.models import Indent

    rows = (await db.execute(
        select(
            Allocation.id, Allocation.allocation_no, Allocation.status,
            Allocation.indent_id, Allocation.indent_no, Allocation.allocated_by_name,
            Allocation.created_at,
            AllocationItem.requested_qty, AllocationItem.quantity,
            AllocationItem.warehouse_id, AllocationItem.warehouse_name,
            Indent.requested_by_name, Indent.office_name, Indent.priority,
        )
        .join(Allocation, Allocation.id == AllocationItem.allocation_id)
        .outerjoin(Indent, Indent.id == Allocation.indent_id)
        .where(AllocationItem.item_id == item_id,
               Allocation.indent_id != exclude_indent_id,
               Allocation.status.in_([AllocationStatus.DRAFT.value,
                                      AllocationStatus.PENDING_APPROVAL.value]))
        .order_by(Allocation.created_at.desc(), Allocation.id.desc())
    )).all()

    claims = [{
        "allocation_id": row.id,
        "allocation_no": row.allocation_no,
        "status": row.status,
        "indent_id": row.indent_id,
        "indent_no": row.indent_no,
        "requested_by_name": row.requested_by_name,
        "office_name": row.office_name,
        "priority": row.priority,
        "allocated_by_name": row.allocated_by_name,
        # What the claim is FOR and what it actually promises: an allocation that
        # asked for 10 and gave 4 is holding 10 off the shelf until it is signed.
        "claimed_qty": float(_d(row.requested_qty)),
        "giving_qty": float(_d(row.quantity)),
        "warehouse_id": row.warehouse_id,
        "warehouse_name": row.warehouse_name,
        "created_at": row.created_at,
    } for row in rows]

    item = await db.get(Item, item_id)
    stock_stmt = (
        select(func.coalesce(func.sum(Stock.total_qty), 0),
               func.coalesce(func.sum(Stock.available_qty), 0),
               func.coalesce(func.sum(Stock.reserved_qty), 0))
        .where(Stock.item_id == item_id)
    )
    if warehouse_ids is not None:
        stock_stmt = stock_stmt.where(Stock.warehouse_id.in_(warehouse_ids or {0}))
    total_qty, available_qty, reserved_qty = (await db.execute(stock_stmt)).one()

    return {
        "item_id": item_id,
        "item_code": item.code if item else None,
        "item_name": item.name if item else None,
        "uom_code": item.uom_code if item else None,
        "total_qty": float(_d(total_qty)),
        "available_qty": float(_d(available_qty)),
        "reserved_qty": float(_d(reserved_qty)),
        "claimed_total": float(sum(
            (_d(row.requested_qty) for row in rows), ZERO)),
        "indent_count": len({row.indent_id for row in rows}),
        "claims": claims,
    }


# ---------------- the decision ----------------

async def doc_type_for(db: AsyncSession, allocation_id: int) -> str:
    """Which approval event this allocation was raised under.

    Read back off the instance rather than stored on the row, because there is no
    column for it and the instance already knows. Newest first: a re-raise after a
    rejection is the one in play.
    """
    found = (await db.execute(
        select(Instance.doc_type)
        .where(Instance.doc_id == allocation_id,
               Instance.doc_type.in_(ALLOCATION_DOC_TYPES))
        .order_by(Instance.id.desc()).limit(1)
    )).scalar_one_or_none()
    return found or DocType.ALLOCATION.value


async def create(db: AsyncSession, indent_id: int, indent_no: str,
                 decisions: list[dict], user, ctx: dict | None = None,
                 on_approved=None, allow_additional: bool = False,
                 doc_type: str = DocType.ALLOCATION.value) -> Allocation:
    """Record what a person decided to give, and send it for approval.

    `decisions` is one entry per (indent line, warehouse) chosen: indent_item_id,
    item_id, quantity, warehouse_id, requested_qty, plus item snapshot fields. A
    quantity of zero is allowed and meaningful — "give nothing now" is a decision
    somebody made and should be able to defend.

    NOTHING IS RESERVED HERE.
    """
    if not decisions:
        raise ValidationError("An allocation needs at least one line")
    await ensure_no_active(db, indent_id, allow_approved=allow_additional)

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
        # Nothing used to stop a decision to give more than exists. Approval then
        # reserved what it could and reported the DECISION as given, so an indent for
        # 10 against 9 on hand closed claiming 10 were issued and the missing unit was
        # never ordered. Check against available stock at the chosen point — reserved
        # quantity belongs to somebody else's indent and is not ours to promise.
        if quantity > ZERO:
            on_shelf = _d(await db.scalar(
                select(func.coalesce(func.sum(Stock.available_qty), 0)).where(
                    Stock.item_id == d["item_id"],
                    Stock.warehouse_id == d["warehouse_id"],
                )
            ))
            if quantity > on_shelf:
                raise ValidationError(
                    f"{d.get('item_name') or d['item_id']}: cannot allocate "
                    f"{quantity} from {warehouse.name} — only {on_shelf} is available. "
                    "Allocate what is there; the rest goes to a material request."
                )
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
        db, doc_type=doc_type, doc_id=alloc.id,
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
        await _refresh_approver(db, alloc, doc_type)

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
            # What was actually reserved, not what was decided. These differ when the
            # shelf ran short mid-approval, and reporting the decision is how an
            # allocation of 10 against 9 on hand announced that 10 had been given.
            "given_qty": float(await allocation.reserved_for(
                db, RefType.RESERVATION.value, alloc.indent_id)),
            "decided_qty": float(sum(_d(line.quantity) for line in alloc.items)),
            "status": implied_indent_status,
        },
        doc_type=DocType.ALLOCATION.value,
        doc_id=alloc.id,
    )


async def _refresh_approver(db: AsyncSession, alloc: Allocation,
                            doc_type: str | None = None) -> None:
    doc_type = doc_type or await doc_type_for(db, alloc.id)
    approvers = await engine.current_approvers(db, doc_type, alloc.id)
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
                           indent_id: int | None = None, user=None) -> dict:
    stmt = select(Allocation)
    if user is not None:
        # Allocation Approvals used to return every allocation in the company: this
        # was the last unscoped reader in the module. Bounded by the stocking points
        # the login's rung reaches, plus the ones they raised themselves.
        from app.modules.inventory.service import warehouse_ids_for_user

        allowed = await warehouse_ids_for_user(db, user)
        if allowed is not None:
            stmt = stmt.where(or_(
                Allocation.allocated_by_id == user.id,
                Allocation.id.in_(
                    select(AllocationItem.allocation_id).where(
                        AllocationItem.warehouse_id.in_(allowed or {0}))
                ),
            ))
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
    # Whichever event it was raised under — the inventory desk's, or the point
    # owner's. The instance is the record of that; nothing else needs to know.
    doc_type = await doc_type_for(db, alloc.id)
    instance = await engine.act(
        db, doc_type, alloc.id, action, user, comments,
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
