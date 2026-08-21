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
from app.platform.hcm import service as hcm_service
from app.platform.workflow import engine
from app.platform.workflow.models import Instance
from app.shared.enums import (
    AllocationStatus, ApprovalAction, AuditAction, DocType, IndentStatus,
    InstanceStatus, RefType, ReservationStatus, WarehouseType,
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
    AllocationStatus.AWAITING_PROCUREMENT.value,
)
# Signed off: the quantity is reserved and `ind_indent_items.allocated_qty` holds it.
# AWAITING_PROCUREMENT belongs here for exactly that reason — it differs from APPROVED
# only in having unfinished business with procurement, not in what it gave.
SETTLED_ALLOCATION_STATUSES = (
    AllocationStatus.APPROVED.value,
    AllocationStatus.AWAITING_PROCUREMENT.value,
)
# The live claims `ind_indent_items.allocated_qty` does NOT already hold. That column
# is recomputed as the sum of APPROVED allocation lines
# (`indents.service._recalculate_indent_allocation_state`), so any "what is still
# owed" arithmetic that writes `owed - allocated_quantity - committed` must count only
# the unsigned promises here, or every approved allocation is subtracted twice.
#
# It was: a line owing 16 with 6 approved reported 4 outstanding instead of 10, and
# the monthly demand screen offered 2 indents where 8 still wanted stock — the rest
# of the demand reached neither the storekeeper nor procurement.
UNAPPROVED_ALLOCATION_STATUSES = (
    AllocationStatus.DRAFT.value,
    AllocationStatus.PENDING_APPROVAL.value,
)


# The downstream handoff an approved allocation triggers, registered by the module
# that owns it. Inventory is the base module and may not import warehouse (rule 5), so
# `warehouse.service` registers `create_fulfilment_drafts_for_allocation` here at
# import and every doorway into approval can reach it — including `move_stock`, which
# has no business module in scope to pass it in. An explicit `on_approved` argument
# still wins; this is only the fallback for callers that cannot supply one.
ON_APPROVED_HOOK = None


def register_on_approved(hook) -> None:
    """Name the callback an allocation's approval hands off to."""
    global ON_APPROVED_HOOK
    ON_APPROVED_HOOK = hook


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


# The two warehouse types that are rungs on the distribution chain rather than the
# warehouse itself (`locations._TIER_BY_TYPE` draws the same line). Stock at these
# points is real and can be given, but it is not stock the warehouse holds.
_CHAIN_TYPES = frozenset({WarehouseType.LIP.value, WarehouseType.MDP.value})


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
                "warehouse_type": None,
                "available_qty": ZERO,
            })
            entry["available_qty"] += stock.available_qty or ZERO

        # The type of each point, so the screen can tell warehouse stock from stock
        # sitting out on the distribution chain. `candidate_stock` filters on this
        # column but returns `stk_balance` rows, which only carry the point's name.
        if by_warehouse:
            for warehouse_id, warehouse_type in (await db.execute(
                select(Warehouse.id, Warehouse.warehouse_type)
                .where(Warehouse.id.in_(by_warehouse))
            )).all():
                by_warehouse[warehouse_id]["warehouse_type"] = warehouse_type

        # Less what un-approved allocations against OTHER indents have already
        # promised out of each point — nothing is reserved until approval, so the
        # shelf otherwise reads full to everyone until the first signature lands.
        # This indent's own pledges stay in: the screen shows them separately as
        # already-allocated and would double-count them here.
        pledged = await pledged_by_point(
            db, {line["item_id"]}, set(by_warehouse), exclude_indent_id=indent_id)
        for (_item, warehouse_id), qty in pledged.items():
            entry = by_warehouse.get(warehouse_id)
            if entry is not None:
                entry["available_qty"] = max(entry["available_qty"] - qty, ZERO)

        out.append({
            **line,
            "available_total": sum(
                (w["available_qty"] for w in by_warehouse.values()), ZERO),
            # Everything that is NOT a rung on the distribution chain. LIP and MDP hold
            # real stock and an approver may still draw from them, but a line the
            # warehouse itself cannot serve is a line procurement should hear about —
            # and `available_total` counts LIP stock, so it never said so. This is what
            # the Raise MR button on the allocation screen reads.
            "main_available_qty": sum(
                (w["available_qty"] for w in by_warehouse.values()
                 if w["warehouse_type"] not in _CHAIN_TYPES), ZERO),
            "warehouses": list(by_warehouse.values()),
            "competing_demand": await competing_demand(db, line["item_id"], indent_id),
        })
    return out


# DRAFT and PENDING_APPROVAL only. An APPROVED allocation has ALREADY moved its
# quantity out of available_qty into reserved_qty (see `allocation.reserve`), so
# counting it here would subtract the same units twice.
UNRESERVED_ALLOCATION_STATUSES = (
    AllocationStatus.DRAFT.value,
    AllocationStatus.PENDING_APPROVAL.value,
)


async def pledged_by_point(
    db: AsyncSession, item_ids: set[int], warehouse_ids: set[int],
    exclude_indent_id: int | None = None,
    exclude_allocation_id: int | None = None,
) -> dict[tuple[int, int], Decimal]:
    """Per (item, point), how much an un-approved allocation has already promised.

    Nothing is reserved until an allocation is APPROVED, so between the decision and
    the signature `stk_balance.available_qty` still counts those units as free. An OE
    who gave 100 of his 505 to one storekeeper was shown 505 again by the next one,
    promised the same units twice, and only found out when the second allocation
    failed to reserve. This is the gap, stated once and subtracted everywhere free
    stock is quoted — the balance itself is never written to (rule 7).

    `exclude_indent_id` leaves out this indent's own pledges, for callers that already
    account for them line by line and would otherwise deduct them a second time.
    """
    if not item_ids or not warehouse_ids:
        return {}
    conditions = [
        AllocationItem.item_id.in_(item_ids),
        AllocationItem.warehouse_id.in_(warehouse_ids),
        Allocation.status.in_(UNRESERVED_ALLOCATION_STATUSES),
    ]
    if exclude_indent_id is not None:
        conditions.append(Allocation.indent_id != exclude_indent_id)
    if exclude_allocation_id is not None:
        # For a caller asking "what would be free if this allocation were not here" —
        # the approval screen, quoting the room its own line has to grow into.
        conditions.append(Allocation.id != exclude_allocation_id)
    rows = (await db.execute(
        select(AllocationItem.item_id, AllocationItem.warehouse_id,
               func.coalesce(func.sum(AllocationItem.quantity), 0))
        .join(Allocation, Allocation.id == AllocationItem.allocation_id)
        .where(*conditions)
        .group_by(AllocationItem.item_id, AllocationItem.warehouse_id)
    )).all()
    return {(item_id, warehouse_id): _d(qty)
            for item_id, warehouse_id, qty in rows}


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


# ---------------- what an approver may still give ----------------

async def _free_by_point(db: AsyncSession, lines, exclude_allocation_id: int,
                         lock: bool = False) -> dict[tuple[int, int], Decimal]:
    """Free quantity per (item, point) for a set of allocation lines, in two queries.

    One grouped read of the shelf and one of the outstanding pledges — not a query per
    line, because a monthly cycle carries thousands of them. `lock` takes the balance
    rows FOR UPDATE so an approval that is about to reserve cannot be overtaken between
    the check and the reservation.
    """
    pairs = {(line.item_id, line.warehouse_id) for line in lines
             if line.warehouse_id and _d(line.quantity) >= ZERO}
    if not pairs:
        return {}
    item_ids = {item_id for item_id, _ in pairs}
    warehouse_ids = {warehouse_id for _, warehouse_id in pairs}

    stmt = (
        select(Stock.item_id, Stock.warehouse_id,
               func.coalesce(func.sum(Stock.available_qty), 0))
        .where(Stock.item_id.in_(item_ids), Stock.warehouse_id.in_(warehouse_ids))
        .group_by(Stock.item_id, Stock.warehouse_id)
    )
    if lock:
        # Lock the balance rows themselves, not the aggregate: MySQL cannot lock a
        # GROUP BY result, so take the rows first and then add them up.
        await db.execute(
            select(Stock.id)
            .where(Stock.item_id.in_(item_ids), Stock.warehouse_id.in_(warehouse_ids))
            .with_for_update()
        )
    on_shelf = {(item_id, warehouse_id): _d(qty)
                for item_id, warehouse_id, qty in (await db.execute(stmt)).all()}
    pledged = await pledged_by_point(
        db, item_ids, warehouse_ids, exclude_allocation_id=exclude_allocation_id)
    return {pair: max(on_shelf.get(pair, ZERO) - pledged.get(pair, ZERO), ZERO)
            for pair in pairs}


async def line_availability(db: AsyncSession, allocation_id: int) -> list[dict]:
    """Per line: what is on the shelf now, what others have promised, what is left.

    The approval screen quoted the quantity inventory decided and nothing else, so an
    approver signing an hour-old proposal had no way to see the shelf had moved under
    it. Read-only.
    """
    alloc = await get(db, allocation_id)
    lines = (await db.execute(
        select(AllocationItem).where(AllocationItem.allocation_id == alloc.id)
        .order_by(AllocationItem.id)
    )).scalars().all()
    free_map = await _free_by_point(db, lines, exclude_allocation_id=alloc.id)

    # FIXED 2026-08-21 — a line that names NO warehouse used to report a hard zero, so
    # the screen said "Free now 0 · Shortage 20" with 30 units standing in the main
    # warehouse, and `max_allowed` came out 0 — the approver could not type a quantity
    # at all. The document was unapprovable and looked like the stock had never arrived.
    #
    # `warehouse_id` is NULL on every line inventory decided to give nothing for, which
    # is exactly the line an approver revisits once the goods are bought. Keying the
    # shelf read on that column asked "how much is at NULL", and the answer is always
    # none.
    #
    # WITHOUT this the whole reopen path is decorative: `reopen_for_available_stock`
    # hands the allocation back to its approver and the approver arrives at a screen
    # still insisting there is nothing to give.
    #
    # An unplaced line is answered across the WAREHOUSE tier — LIP and MDP hold real
    # stock but it is theirs to issue, the same rule `main_available_qty` and the
    # reopen apply. Pledges are netted off the same set, so two approvers cannot both
    # be told the same units are free.
    unplaced = [line for line in lines if not line.warehouse_id]
    tier_free: dict[int, Decimal] = {}
    if unplaced:
        item_ids = {line.item_id for line in unplaced}
        tier_free = await warehouse_available(db, item_ids)
        # The points that shelf figure was summed over, named explicitly:
        # `pledged_by_point` returns {} for an empty warehouse set, so passing None
        # here would skip the netting in silence and quote gross stock as free.
        tier_points = set((await db.execute(
            select(Warehouse.id).where(
                Warehouse.warehouse_type.notin_(list(_CHAIN_TYPES)))
        )).scalars().all())
        pledged_any = await pledged_by_point(
            db, item_ids, tier_points, exclude_allocation_id=alloc.id)
        for (item_id, _warehouse_id), qty in pledged_any.items():
            if item_id in tier_free:
                tier_free[item_id] = max(tier_free[item_id] - qty, ZERO)

    out = []
    for line in lines:
        pair = (line.item_id, line.warehouse_id)
        if line.warehouse_id:
            free = free_map.get(pair, ZERO)
            on_shelf = _d(await db.scalar(
                select(func.coalesce(func.sum(Stock.available_qty), 0)).where(
                    Stock.item_id == line.item_id,
                    Stock.warehouse_id == line.warehouse_id,
                )
            ))
        else:
            # No point chosen yet: answer for the tier, not for NULL.
            free = tier_free.get(line.item_id, ZERO)
            on_shelf = free
        # An APPROVED allocation already holds its quantity in reserved_qty, so the
        # shelf no longer counts it and it is not free to be given again.
        already_held = (_d(line.quantity)
                        if alloc.status == AllocationStatus.APPROVED.value else ZERO)
        out.append({
            "id": line.id,
            "item_id": line.item_id,
            "item_code": line.item_code,
            "item_name": line.item_name,
            "uom_code": line.uom_code,
            "warehouse_id": line.warehouse_id,
            "warehouse_name": line.warehouse_name,
            "requested_qty": float(_d(line.requested_qty)),
            "quantity": float(_d(line.quantity)),
            "on_shelf": float(on_shelf),
            "pledged_elsewhere": float(max(on_shelf - free, ZERO)),
            "free": float(free + already_held),
            # Never more than was asked for: an approver revises downward, or back up
            # to the request — raising it above is a new requirement, not an approval.
            "max_allowed": float(min(_d(line.requested_qty), free + already_held)),
        })
    return out


async def revise(db: AsyncSession, alloc: Allocation,
                 revisions: list[dict]) -> list[dict]:
    """Apply the approver's own quantities before the signature lands.

    Only the quantity moves. The line already names its item and its point, and
    changing either would make it a different decision that nobody proposed.
    Returns the changes made, for the audit row the caller writes.
    """
    if not revisions:
        return []
    by_id = {int(r["id"]): _d(r["quantity"]) for r in revisions}
    lines = (await db.execute(
        select(AllocationItem).where(AllocationItem.allocation_id == alloc.id,
                                     AllocationItem.id.in_(by_id))
    )).scalars().all()
    missing = by_id.keys() - {line.id for line in lines}
    if missing:
        raise ValidationError(
            f"Line {sorted(missing)[0]} does not belong to {alloc.allocation_no}")

    for line in lines:
        wanted = by_id[line.id]
        if wanted > _d(line.requested_qty):
            raise ValidationError(
                f"{line.item_name or line.item_id}: cannot give {wanted} — only "
                f"{_d(line.requested_qty)} was requested.")
        if wanted > ZERO and not line.warehouse_id:
            raise ValidationError(
                f"{line.item_name or line.item_id}: no warehouse on this line, so "
                "there is nowhere to give it from.")

    free_map = await _free_by_point(db, lines, exclude_allocation_id=alloc.id, lock=True)
    changed = []
    for line in lines:
        wanted, before = by_id[line.id], _d(line.quantity)
        if wanted == before:
            continue
        free = free_map.get((line.item_id, line.warehouse_id), ZERO)
        if wanted > free:
            raise ValidationError(
                f"{line.item_name or line.item_id}: only {free} is free at "
                f"{line.warehouse_name or 'that point'} — {wanted} cannot be given.")
        line.quantity = wanted
        changed.append({"line_id": line.id, "item_code": line.item_code,
                        "from": float(before), "to": float(wanted)})
    await db.flush()
    return changed


async def _assert_still_available(db: AsyncSession, alloc: Allocation) -> None:
    """The shelf has not moved out from under this decision since it was proposed.

    `allocation.reserve` is deliberately partial-tolerant — an indent for 100 against
    60 reserves 60 — which is right when inventory is deciding, and wrong at the
    moment of signature: it would report the decision as given and quietly hold less.
    Checked under the same row locks the reservation takes, so two approvers signing
    the same stock at the same instant queue instead of both winning.
    """
    lines = [line for line in alloc.items if _d(line.quantity) > ZERO]
    if not lines:
        return
    free_map = await _free_by_point(db, lines, exclude_allocation_id=alloc.id, lock=True)
    short = [
        (line, free_map.get((line.item_id, line.warehouse_id), ZERO))
        for line in lines
        if _d(line.quantity) > free_map.get((line.item_id, line.warehouse_id), ZERO)
    ]
    if short:
        line, free = short[0]
        raise ValidationError(
            f"{line.item_name or line.item_id}: only {free} is free at "
            f"{line.warehouse_name or 'that point'} now, but this allocation promises "
            f"{_d(line.quantity)}. Revise the quantity, or reject it and allocate again."
        )


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
            # Less whatever an un-approved allocation has already promised out of this
            # point. Reservation only happens at approval, so without this the shelf
            # reads full to every approver until the first signature lands, and the
            # same 100 units get committed to three indents.
            pledged = await pledged_by_point(
                db, {d["item_id"]}, {d["warehouse_id"]})
            free = on_shelf - pledged.get((d["item_id"], d["warehouse_id"]), ZERO)
            if quantity > free:
                raise ValidationError(
                    f"{d.get('item_name') or d['item_id']}: cannot allocate "
                    f"{quantity} from {warehouse.name} — only {free} is free "
                    f"({on_shelf} on the shelf, {on_shelf - free} already promised to "
                    "allocations awaiting approval). Allocate what is there; the rest "
                    "goes to a material request."
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
    alloc.approved_at = utcnow()
    alloc.current_approver_name = None
    implied_indent_status, went_to_procurement = await apply_to_stock(
        db, alloc, user, ctx)
    # Signed either way. APPROVED means finished; AWAITING_PROCUREMENT means the part
    # the shelf could not cover is being bought, and this same document reopens when it
    # arrives (`reopen_for_receipt`). Keeping it open is what stops a second allocation
    # being raised against a requirement that already has one.
    alloc.status = (AllocationStatus.AWAITING_PROCUREMENT.value if went_to_procurement
                    else AllocationStatus.APPROVED.value)
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


async def get(db: AsyncSession, allocation_id: int, user=None) -> Allocation:
    """FIXED 2026-08-20 — `list_allocations` is bounded by the stocking points the
    login's rung reaches and this took no `user` at all, so an allocation hidden from
    Allocation Approvals opened fine by id. An allocation names an indent, its items and
    the quantities somebody committed off a shelf. WITHOUT this the list's rung is a
    display filter rather than a permission.

    Same bound as the list: the points the login reaches, or one they raised themselves.
    404, not 403 — an id that is not yours must not confirm it exists.
    """
    stmt = select(Allocation).where(Allocation.id == allocation_id)
    if user is not None:
        from app.modules.inventory.service import warehouse_ids_for_user

        allowed = await warehouse_ids_for_user(db, user)
        if allowed is not None:
            stmt = stmt.where(or_(
                Allocation.allocated_by_id == user.id,
                Allocation.id.in_(
                    select(AllocationItem.allocation_id).where(
                        AllocationItem.warehouse_id.in_(allowed or {0}))),
            ))
    alloc = (await db.execute(stmt)).scalar_one_or_none()
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

        # NOTE (2026-08-20): `allocated_by_id` is the PERSON, so a two-hat login sees
        # allocations they raised under the other hat. `inv_allocations` carries no
        # position column, so this cannot be hat-scoped without a migration — same
        # situation as returns. The WAREHOUSE half below is position-derived and is the
        # branch that actually bounds the list.
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
    page = await paginate(db, stmt.order_by(Allocation.created_at.desc()), params)
    await _attach_totals(db, page["items"])
    return page


async def _attach_totals(db: AsyncSession, rows) -> None:
    """Line totals for a page of allocations, in one query.

    The approvals screen needs "40 of 60 given" on every row and used to fetch each
    allocation in full to get it — one HTTP round trip per row, forty per page. The
    numbers are a GROUP BY; the schema reads them straight off the row.
    """
    ids = [row.id for row in rows]
    if not ids:
        return
    totals = {
        allocation_id: (given, requested)
        for allocation_id, given, requested in (await db.execute(
            select(AllocationItem.allocation_id,
                   func.coalesce(func.sum(AllocationItem.quantity), 0),
                   func.coalesce(func.sum(AllocationItem.requested_qty), 0))
            .where(AllocationItem.allocation_id.in_(ids))
            .group_by(AllocationItem.allocation_id)
        )).all()
    }
    for row in rows:
        given, requested = totals.get(row.id, (ZERO, ZERO))
        row.total_qty = float(_d(given))
        row.requested_total = float(_d(requested))


async def warehouse_available(db: AsyncSession, item_ids: set[int]) -> dict[int, Decimal]:
    """Free stock at the WAREHOUSE tier only, per item.

    LIP and MDP hold real stock, but it is theirs — a unit sitting at a LIP is not
    something the warehouse can issue, and counting it would wake an indent the
    warehouse still cannot serve. Same rule `main_available_qty` applies on the
    allocation screen, so the reopen below and the Give figure the approver then sees
    are computed off the same stock.
    """
    if not item_ids:
        return {}
    rows = (await db.execute(
        select(Stock.item_id, func.coalesce(func.sum(Stock.available_qty), 0))
        .join(Warehouse, Warehouse.id == Stock.warehouse_id)
        .where(Stock.item_id.in_(item_ids),
               Warehouse.warehouse_type.notin_(list(_CHAIN_TYPES)))
        .group_by(Stock.item_id)
    )).all()
    return {item_id: _d(qty) for item_id, qty in rows}


async def reopen_for_available_stock(db: AsyncSession, item_ids: set[int],
                                     on_approved=None) -> list[int]:
    """Wake every allocation parked on procurement whose goods are now on the shelf.

    FIXED 2026-08-21 — the only path back from AWAITING_PROCUREMENT was
    `reopen_for_receipt`, keyed on the indent whose shortfall raised the material
    request. That covers exactly one case: goods bought against THIS indent, through an
    MR that carries its id. It misses every other way the stock actually turns up —
    a manually raised MR, a purchase made for a different indent that happens to cover
    this one, a transfer in, a return to stock. IND/2026-27/00089 sat on
    PENDING_PROCUREMENT with its 30 monitors already in the bin for exactly this reason.
    WITHOUT this an allocation can be stranded by stock the warehouse is holding.

    Availability decides, not lineage: any stock of the item, however it arrived, is
    stock the approver can give. Warehouse tier only — see `warehouse_available`.

    Idempotent by construction: an allocation already reopened is PENDING_APPROVAL, not
    AWAITING_PROCUREMENT, so a second receipt of the same item does not touch it.
    """
    if not item_ids:
        return []
    on_approved = on_approved or ON_APPROVED_HOOK
    parked = (await db.execute(
        select(Allocation)
        .where(
            Allocation.status == AllocationStatus.AWAITING_PROCUREMENT.value,
            Allocation.id.in_(
                select(AllocationItem.allocation_id)
                .where(AllocationItem.item_id.in_(item_ids))
            ),
        )
    )).scalars().all()
    if not parked:
        return []

    on_shelf = await warehouse_available(db, item_ids)
    indent_ids = []
    for alloc in parked:
        wanted = (await db.execute(
            select(AllocationItem.item_id)
            .where(AllocationItem.allocation_id == alloc.id,
                   AllocationItem.item_id.in_(item_ids))
        )).scalars().all()
        # One line's goods arriving is enough: the approver opens the document and tops
        # up what they can. Waiting for every short line would strand a two-line
        # allocation on the slower half of it.
        if any(on_shelf.get(item_id, ZERO) > ZERO for item_id in wanted):
            indent_ids.append(alloc.indent_id)

    reopened: list[int] = []
    for indent_id in dict.fromkeys(indent_ids):
        reopened.extend(await reopen_for_receipt(db, indent_id, on_approved))
    return reopened


async def _prefill_from_shelf(db: AsyncSession, alloc: Allocation) -> None:
    """Fill a reopened allocation's Give with what the warehouse can now serve.

    FIXED 2026-08-21 — a reopened allocation came back with Give still 0, the number
    it was parked with. The whole reason the document is in front of the approver again
    is that the goods arrived, so asking them to retype the quantity the system already
    knows is how ALL/2026-27/00075 got signed for nothing with 30 monitors on the shelf.

    Never MORE than was asked for, and never less than what is already there: this is a
    starting point the approver can revise down, not a decision made for them. A line
    that already carries a quantity is left alone — a part-served line was decided by a
    person and must not be quietly rewritten.

    Warehouse tier only, same rule as `reopen_for_available_stock` and
    `main_available_qty`: stock at a LIP is not the warehouse's to give.
    """
    await db.refresh(alloc, ["items"])
    short = [line for line in alloc.items
             if _d(line.quantity) <= ZERO and _d(line.requested_qty) > ZERO]
    if not short:
        return
    free = await warehouse_available(db, {line.item_id for line in short})
    # Which point to name. `warehouse_available` sums the tier, so the line is pinned to
    # the point actually holding the stock — an allocation line with a quantity and no
    # warehouse cannot be reserved against anything.
    points = {}
    for item_id in {line.item_id for line in short}:
        row = (await db.execute(
            select(Stock.warehouse_id, Stock.warehouse_name)
            .join(Warehouse, Warehouse.id == Stock.warehouse_id)
            .where(Stock.item_id == item_id,
                   Stock.available_qty > 0,
                   Warehouse.warehouse_type.notin_(list(_CHAIN_TYPES)))
            .order_by(Stock.available_qty.desc())
            .limit(1)
        )).first()
        if row:
            points[item_id] = row
    for line in short:
        can_give = min(_d(line.requested_qty), free.get(line.item_id, ZERO))
        point = points.get(line.item_id)
        if can_give <= ZERO or point is None:
            continue
        line.quantity = can_give
        line.warehouse_id, line.warehouse_name = point[0], point[1]


async def reopen_for_receipt(db: AsyncSession, indent_id: int,
                             on_approved=None) -> list[int]:
    """Put an allocation waiting on procurement back in front of its approver.

    Called when the goods bought for its shortfall reach stock. The SAME document is
    reused — status back to PENDING_APPROVAL, so the review screen opens it editable
    and the approver tops up the Give from what has arrived. That is the whole point:
    no second allocation for one requirement, and no second row in the fulfilment
    queue for an indent somebody already decided on.

    The ladder decides again, through the engine: `engine.start` reopens the document's
    existing instance in place (`_open_instance`), keeping every `wf_actions` row where
    it is (rule 9) and resolving the chain from the CONFIGURED ladder — so whoever
    Approvals Config names today gets the pending row, and the approvals inbox shows it
    like any other waiting document. Without that the reopened allocation would be
    editable but sit in nobody's queue.

    Raised in the name of whoever decided the allocation, not the storekeeper who
    happened to book the delivery: the ladder climbs the RAISER's reporting line, and
    keying it to the receiving clerk would route this indent's decision through a
    stranger. `_settle_approved` then reserves only the DIFFERENCE when it is signed.

    Returns the allocation ids reopened.
    """
    rows = (await db.execute(
        select(Allocation).where(
            Allocation.indent_id == indent_id,
            Allocation.status == AllocationStatus.AWAITING_PROCUREMENT.value,
        )
    )).scalars().all()
    reopened: list[int] = []
    for alloc in rows:
        raiser = (await hcm_service.get_employee(db, alloc.allocated_by_id)
                  if alloc.allocated_by_id else None)
        if raiser is None:
            # No raiser to climb from — leave it signed rather than parking it in a
            # state nobody can act on.
            continue
        alloc.status = AllocationStatus.PENDING_APPROVAL.value
        alloc.approved_at = None
        await _prefill_from_shelf(db, alloc)
        await db.flush()
        doc_type = await doc_type_for(db, alloc.id)
        instance = await engine.start(
            db, doc_type=doc_type, doc_id=alloc.id,
            context={
                "doc_no": alloc.allocation_no,
                "doc_summary": f"Stock arrived for {alloc.indent_no} — top up the "
                               f"allocation",
                "department_id": alloc.department_id,
            },
            user=raiser,
        )
        # FIXED 2026-08-21 — the return of `engine.start` was thrown away here and the
        # status hardcoded to PENDING_APPROVAL above. The ladder can finish AT SUBMIT:
        # an OWN_STOCK_ALLOCATION raised by the top of its own ladder, or any ladder set
        # to NO_APPROVAL, comes back already APPROVED. `create()` has checked for that
        # since it was written (see the same branch there); this second doorway into the
        # same state never got it, so a reopened allocation whose raiser self-approves
        # ended up with the workflow saying APPROVED and the document saying
        # PENDING_APPROVAL — nothing reserved, no fulfilment draft, and nobody on the
        # pending list, so the review screen offered neither a Give box nor a button.
        # ALL/2026-27/00079 is the live proof: instance APPROVED at 12:19:12, allocation
        # still PENDING_APPROVAL, 198 mice on the shelf and no way to issue them.
        #
        # This branch only fires for a ladder that self-approves. Where a real approver
        # is named the engine returns IN_PROGRESS, `_refresh_approver` puts their name on
        # the document, and the signature settles it through `act()` exactly as before —
        # that path is untouched.
        if instance.status == InstanceStatus.APPROVED.value:
            await db.refresh(alloc, ["items"])
            await _settle_approved(db, alloc, raiser, _reopen_ctx(alloc), on_approved)
        else:
            await _refresh_approver(db, alloc, doc_type)
        reopened.append(alloc.id)
    return reopened


def _reopen_ctx(alloc: Allocation) -> dict:
    """The project a reopened allocation is serving, for the MR a residual shortfall
    may still raise.

    Read off the allocation's own lines rather than the indent: inventory is the base
    module and cannot read `ind_indents` (rule 5). The name is not stored on a line, so
    only the id travels — `apply_to_stock` writes it onto the request and the name is
    resolved by whoever displays it.
    """
    project_id = next((line.project_id for line in alloc.items
                       if line.project_id and line.project_id != NO_PROJECT), None)
    return {"project_id": project_id, "project_name": None}


async def act(db: AsyncSession, allocation_id: int, action: str, user,
              comments: str = "", ctx: dict | None = None,
              on_approved=None, revisions: list[dict] | None = None) -> Allocation:
    """Approve or reject the decision. Approval is what finally moves stock.

    `ctx` carries what only the indent knows — its project — down to the material
    request approval raises. Inventory cannot read ind_indents itself (it is the base
    module), so the caller in indents hands it over.

    `revisions` lets the approver change how much a line gives before signing it. They
    are applied and audited whether or not the signature completes the ladder, because
    the next approver must see the number this one actually agreed to.
    """
    ctx = ctx or {}
    alloc = await get(db, allocation_id)
    if alloc.status != AllocationStatus.PENDING_APPROVAL.value:
        raise ValidationError(
            f"Allocation is not awaiting approval (status {alloc.status})")

    before = alloc.status
    await db.refresh(alloc, ["items"])
    changed = await revise(db, alloc, revisions or []) if revisions else []
    if action == ApprovalAction.APPROVED.value:
        # Before the engine writes anything: a refusal here must leave the ladder
        # exactly where it was, not consume the approver's turn.
        await _assert_still_available(db, alloc)
    if changed:
        await write_audit(
            db, entity="inv_allocations", entity_id=alloc.id,
            entity_no=alloc.allocation_no, action=AuditAction.UPDATE, actor=user,
            after={"revisions": changed},
            summary=f"Quantities revised at approval by {getattr(user, 'full_name', '')}".strip(),
        )
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

    Returns (indent status this implies, whether a material request was raised). The
    second half decides whether the allocation is FINISHED or merely waiting on
    procurement — the caller cannot see the shortfalls from outside.

    Runs only on approval.
    """
    # Import here rather than at module load: service imports nothing from this file,
    # but this file needs its MR helper, and a top-level import would close the loop.
    from app.modules.inventory import service

    shortfalls, requested_total, given_total = [], ZERO, ZERO

    for line in alloc.items:
        requested_total += _d(line.requested_qty)
        given_total += _d(line.quantity)

        # What this line has ALREADY put aside. An allocation that went to procurement
        # is signed and reopened later for the same lines, so approving it a second
        # time must reserve the DIFFERENCE — reserving `quantity` again would hold the
        # goods twice and starve every other indent of stock nobody is using.
        #
        # FIXED 2026-08-21 — CONSUMED counts here, not just ACTIVE. A reservation is
        # consumed when the goods actually LEAVE, so after the first signature is
        # issued the line's hold reads zero and the whole quantity was reserved a
        # SECOND time on reopen. Live proof on item 69: reservation 47 for 2 CONSUMED
        # by WHI/2026-27/00045, then reservation 51 for the same 2 ACTIVE again — 198
        # on the shelf, 196 free, and the next allocation for that very indent was
        # refused for stock that had already been delivered to it.
        #
        # RELEASED stays out: that stock went back on the shelf and is genuinely
        # reservable again.
        held = await allocation.reserved_quantity(
            db, RefType.RESERVATION.value, alloc.indent_id,
            ref_line_id=line.indent_item_id, item_id=line.item_id,
            statuses=(ReservationStatus.ACTIVE.value,
                      ReservationStatus.CONSUMED.value),
        )
        to_reserve = _d(line.quantity) - _d(held)
        if to_reserve > ZERO:
            await allocation.reserve(
                db, line.item_id, to_reserve, RefType.RESERVATION.value,
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

    # FIXED 2026-08-21 — this read `given_total` alone, so "gave nothing because there
    # is nothing to give" and "gave nothing because the approver never typed a number"
    # produced the identical status. The second case parks the indent on
    # PENDING_PROCUREMENT with NO material request behind it: nothing is on order, so
    # no receipt will ever fire `reopen_for_available_stock`, and the document sits
    # waiting for goods that were already on the shelf when it was signed.
    #
    # PENDING_PROCUREMENT is a claim that somebody is buying this. It is only true when
    # a shortfall was actually raised, so it is `shortfalls` that decides it — not the
    # quantity, which says nothing about whether the stock exists.
    if given_total <= ZERO:
        return ((IndentStatus.PENDING_PROCUREMENT.value if shortfalls
                 # Nothing given and nothing ordered: the goods are there and the
                 # approver simply did not take them. The indent stays exactly where it
                 # was — allocatable — rather than being parked behind a purchase that
                 # is not happening.
                 else IndentStatus.AWAITING_ALLOCATION.value),
                bool(shortfalls))
    if given_total >= requested_total:
        return IndentStatus.ALLOCATED.value, bool(shortfalls)
    return IndentStatus.PARTIALLY_FULFILLED.value, bool(shortfalls)
