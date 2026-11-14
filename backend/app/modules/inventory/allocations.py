"""Allocation: inventory's decision on how much stock an approved indent actually gets.

This is a document, not a calculation. Sixty bags of cement with four projects wanting
it is a judgement — who gets what, from which warehouse, and what waits. The system
proposes what is available; a person decides what to give.

Nothing is reserved until the allocation is APPROVED. FEFO then picks the batch inside
the warehouse the allocator chose; it never changes the quantity they decided.

Kept out of service.py because that file already owns stock movement and material
requests, and this is a third responsibility with its own lifecycle.

------------------------------------------------------------------------------
AN APPROVED ALLOCATION IS TERMINAL  (2026-08-21 — read this before changing it)
------------------------------------------------------------------------------
A signed allocation is APPROVED and never changes again. It is not reopened, not
topped up, and not re-approved. An indent that is only partly served collects a
SECOND allocation later, a third after that — one document per round of serving,
each with its own ladder, its own reservations and its own issue draft.

What replaced what: `AWAITING_PROCUREMENT` used to park the document until the goods
arrived, and something then had to WAKE it. That made every route by which stock can
reach a shelf — putaway, GRN, transfer in, return to stock, adjustment — responsible
for remembering to wake it, and every doorway that forgot was a live defect. Six of
them, one per doorway, plus the guards the wake-up path skipped on the way back in.
The status value survives in the enum and in the tuples below only so an unmigrated
database still reads its old rows as signed; `a1c2e3f4b5d6` renames the rest.

The invariant that makes it work: WHAT AN INDENT IS STILL OWED IS READ, NEVER STORED.
It is `approved - allocated - on order`, computed by
`indents.list_indents(has_remainder=True)` and by `fulfilment_batches` for a monthly
cycle. Arriving stock changes that answer simply by existing, so the indent returns to
the Fulfilment Desk on its own with nothing having been notified.

IF YOU CHANGE THIS, these break:
  * `indents.list_indents(has_remainder=True)` — the Fulfilment Desk's queue. It is
    the ONLY thing bringing a part-served indent back. Narrow it and an indent
    silently stops being servable; nothing else will notice.
  * `indents._SETTLED_MR_STATUSES` — the "on order" half of that arithmetic. A status
    wrongly counted as on-order hides the line forever (that was the DRAFT bug); one
    wrongly counted as settled offers quantity procurement is already buying.
  * `SETTLED_ALLOCATION_STATUSES` — read by `_recalculate_indent_allocation_state` to
    total `ind_indent_items.allocated_qty`. Drop a status from it and an indent reads
    as unserved over stock it is holding.
  * `apply_to_stock` nets what a line has ALREADY reserved before reserving again,
    counting CONSUMED as well as ACTIVE. Several approved allocations now exist per
    indent line, so without that netting each one re-reserves the whole quantity.
  * `create_mr_from_shortfall` deduplicates per indent LINE. Per indent was enough
    when a shortage was raised once; rounds of serving mean a later shortage on the
    same indent is a DIFFERENT shortage and needs its own request.
Do not reintroduce a "wake the document" path. If an allocation needs to come back,
the answer is a new allocation off the desk, not a second life for a signed one.
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
from app.shared.masters import combinations
from app.shared.enums import (
    AllocationStatus, ApprovalAction, AuditAction, DocType, IndentStatus,
    InstanceStatus, MRStatus, RefType, ReservationStatus, WarehouseType,
)
from app.shared.models.base import utcnow
from app.shared.models.master import Item
from app.shared.models.warehouse import Warehouse
from app.shared.numbering import next_number
from app.shared.time import today as ist_today

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
#
# AWAITING_PROCUREMENT is LEGACY as of 2026-08-21 and is never written any more — an
# allocation whose shortfall went to procurement is simply APPROVED, and what is still
# owed is recomputed from the shelf and the open material requests instead of being
# held on the document (see `_settle_approved`). `a1c2e3f4b5d6` flips the rows that
# already carried it. Both tuples keep the value so a straggler on a database that has
# not been migrated still reads as signed rather than as a live unapproved promise.
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


def combo_key(line) -> tuple[int, int, int] | None:
    """A line's brand / variant / model, or None where it names none (2026-10-23).
    A line giving stock with NO brand recorded is (0, 0, 0): untagged rows only."""
    get = (line.get if isinstance(line, dict) else (lambda k, d=None: getattr(line, k, d)))
    brand = int(get("brand_id") or 0)
    if not brand:
        return (0, 0, 0) if get("no_brand") else None
    return (brand, int(get("variant_id") or 0), int(get("model_id") or 0))


def combo_dict(line) -> dict | None:
    """The same, in the shape `allocation.reserve` takes."""
    key = combo_key(line)
    return (None if key is None
            else {"brand_id": key[0], "variant_id": key[1], "model_id": key[2],
                  "no_brand": not key[0]})


def free_for(on_shelf: dict, pledged: dict, item_id: int, warehouse_id: int,
             combo: tuple | None) -> Decimal:
    """Free at a point, out of shelf and pledges keyed (item, point, b, v, m).

    A line naming no combination may take any of the item. A line naming one is
    capped twice: by that combination's own free stock, and by the item's free stock
    there — another allocation's line may name no combination and draw from any, so
    the combination's own figure alone could promise units the point does not have.
    """
    def total(source):
        return sum((qty for (i, w, *_), qty in source.items()
                    if i == item_id and w == warehouse_id), ZERO)
    whole = total(on_shelf) - total(pledged)
    if combo is None:
        return max(whole, ZERO)
    key = (item_id, warehouse_id, *combo)
    own = on_shelf.get(key, ZERO) - pledged.get(key, ZERO)
    return max(min(own, whole), ZERO)


async def shelf_by_combination(db: AsyncSession, item_ids: set[int],
                               warehouse_ids: set[int], *,
                               lock: bool = False) -> dict[tuple, Decimal]:
    """Available, unexpired stock per (item, point, brand, variant, model)."""
    if not item_ids or not warehouse_ids:
        return {}
    today = ist_today()
    where = (Stock.item_id.in_(item_ids), Stock.warehouse_id.in_(warehouse_ids),
             or_(Stock.expiry_date.is_(None), Stock.expiry_date >= today))
    if lock:
        # Lock the balance rows themselves, not the aggregate: MySQL cannot lock a
        # GROUP BY result, so take the rows first and then add them up.
        await db.execute(select(Stock.id).where(*where).with_for_update())
    rows = (await db.execute(
        select(Stock.item_id, Stock.warehouse_id, Stock.brand_id, Stock.variant_id,
               Stock.model_id, func.coalesce(func.sum(Stock.available_qty), 0))
        .where(*where)
        .group_by(Stock.item_id, Stock.warehouse_id, Stock.brand_id, Stock.variant_id,
                  Stock.model_id))).all()
    return {(i, w, int(b or 0), int(v or 0), int(m or 0)): _d(q)
            for i, w, b, v, m, q in rows}


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
# The same line drawn the other way round, as an INCLUSIVE list, because
# `availability.available_for` filters by the types it is given rather than the types
# it is denied. Derived from the enum so a warehouse type added tomorrow lands on the
# warehouse tier automatically — which is the rule `WarehouseType` already states.
_WAREHOUSE_TIER_TYPES = [t.value for t in WarehouseType if t.value not in _CHAIN_TYPES]


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
        # The same shelf per brand / variant / model (2026-10-23) — what the desk's
        # in-stock dropdown offers, and what a line naming one may draw.
        shelf: dict[tuple, Decimal] = {}
        for stock in rows:
            entry = by_warehouse.setdefault(stock.warehouse_id, {
                "warehouse_id": stock.warehouse_id,
                "warehouse_name": stock.warehouse_name,
                "warehouse_type": None,
                "available_qty": ZERO,
            })
            entry["available_qty"] += stock.available_qty or ZERO
            key = (line["item_id"], stock.warehouse_id, int(stock.brand_id or 0),
                   int(stock.variant_id or 0), int(stock.model_id or 0))
            shelf[key] = shelf.get(key, ZERO) + (stock.available_qty or ZERO)

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
            db, {line["item_id"]}, set(by_warehouse), exclude_indent_id=indent_id,
            by_combination=True)
        wanted = combo_key(line)
        for warehouse_id, entry in by_warehouse.items():
            entry["available_qty"] = free_for(
                shelf, pledged, line["item_id"], warehouse_id, wanted)
            entry["combinations"] = [
                {"brand_id": b, "variant_id": v, "model_id": m,
                 "available_qty": float(free_for(shelf, pledged, line["item_id"],
                                                 warehouse_id, (b, v, m)))}
                for (_i, w, b, v, m) in sorted(shelf)
                if w == warehouse_id
                and free_for(shelf, pledged, line["item_id"], warehouse_id, (b, v, m)) > 0
            ]
            await combinations.fill_names(db, entry["combinations"])
            # Stock booked in before brands were recorded is offered as its own choice,
            # "No brand" (2026-10-24) — never hidden, and never passed off as a brand.
            for combo in entry["combinations"]:
                if not combo["brand_id"]:
                    combo.update(no_brand=True, brand_name="No brand")

        # Lots set aside for THIS line's project are free to it, and to nobody else.
        # Added after the netting: a pledge is against the shared pool, never a hold.
        held = await allocation.held_for(
            db, line.get("project_id"), {line["item_id"]}, warehouse_ids)
        for (_item, warehouse_id), qty in held.items():
            entry = by_warehouse.get(warehouse_id)
            if entry is None:
                warehouse = await db.get(Warehouse, warehouse_id)
                if warehouse is None or (warehouse_types
                                         and warehouse.warehouse_type not in warehouse_types):
                    continue
                entry = by_warehouse.setdefault(warehouse_id, {
                    "warehouse_id": warehouse_id, "warehouse_name": warehouse.name,
                    "warehouse_type": warehouse.warehouse_type, "available_qty": ZERO,
                })
            entry["available_qty"] += qty
            entry["project_held_qty"] = qty

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
    by_combination: bool = False,
) -> dict[tuple, Decimal]:
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
    if by_combination:
        # Keyed (item, point, brand, variant, model) — what `free_for` reads.
        keys = (AllocationItem.item_id, AllocationItem.warehouse_id,
                AllocationItem.brand_id, AllocationItem.variant_id,
                AllocationItem.model_id)
        rows = (await db.execute(
            select(*keys, func.coalesce(func.sum(AllocationItem.quantity), 0))
            .join(Allocation, Allocation.id == AllocationItem.allocation_id)
            .where(*conditions).group_by(*keys))).all()
        return {(i, w, int(b or 0), int(v or 0), int(m or 0)): _d(q)
                for i, w, b, v, m, q in rows}
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
    today = ist_today()
    stock_stmt = (
        select(func.coalesce(func.sum(Stock.total_qty), 0),
               func.coalesce(func.sum(Stock.available_qty), 0),
               func.coalesce(func.sum(Stock.reserved_qty), 0))
        .where(Stock.item_id == item_id,
               or_(Stock.expiry_date.is_(None), Stock.expiry_date >= today))
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

def free_key(line) -> tuple:
    """How `_free_by_point` keys a line: (item, point, combination or None)."""
    return (line.item_id, line.warehouse_id, combo_key(line))


async def _free_by_point(db: AsyncSession, lines, exclude_allocation_id: int,
                         lock: bool = False) -> dict[tuple, Decimal]:
    """Free quantity per line key — (item, point, combination) — in two queries.

    One grouped read of the shelf and one of the outstanding pledges — not a query per
    line, because a monthly cycle carries thousands of them. `lock` takes the balance
    rows FOR UPDATE so an approval that is about to reserve cannot be overtaken between
    the check and the reservation.
    """
    keys = {free_key(line) for line in lines
            if line.warehouse_id and _d(line.quantity) >= ZERO}
    if not keys:
        return {}
    item_ids = {item_id for item_id, _, _ in keys}
    warehouse_ids = {warehouse_id for _, warehouse_id, _ in keys}

    on_shelf = await shelf_by_combination(db, item_ids, warehouse_ids, lock=lock)
    pledged = await pledged_by_point(
        db, item_ids, warehouse_ids, exclude_allocation_id=exclude_allocation_id,
        by_combination=True)
    free = {key: free_for(on_shelf, pledged, key[0], key[1], key[2]) for key in keys}
    # Each line's own project's held lots. One allocation serves one indent, so its
    # lines share a project; grouped anyway rather than assumed.
    by_project: dict[int, set[int]] = {}
    for line in lines:
        if line.warehouse_id and getattr(line, "project_id", None):
            by_project.setdefault(int(line.project_id), set()).add(int(line.item_id))
    for project_id, project_items in by_project.items():
        for (item_id, warehouse_id), qty in (await allocation.held_for(
                db, project_id, project_items, warehouse_ids)).items():
            for key in keys:
                if key[0] == item_id and key[1] == warehouse_id:
                    free[key] += qty
    return free


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
    # WITHOUT this a line the desk decided to give nothing for can never be topped up:
    # the approver opens it once the goods arrive and the screen still insists there is
    # nothing to give.
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

    # One indent line served from two points is two rows, and the desk writes the
    # whole request on the FIRST of them (10 + 0), so a per-row cap of
    # min(requested, free) read the second row as "requested 0" and capped it at 0
    # while 41 sat free there. The request is the indent LINE's, shared by its rows.
    asked = _requested_by_indent_line(lines)

    out = []
    for line in lines:
        if line.warehouse_id:
            free = free_map.get(free_key(line), ZERO)
            today = ist_today()
            shelf = select(func.coalesce(func.sum(Stock.available_qty), 0)).where(
                Stock.item_id == line.item_id,
                Stock.warehouse_id == line.warehouse_id,
                or_(Stock.expiry_date.is_(None), Stock.expiry_date >= today),
            )
            if combo_key(line) is not None:
                shelf = shelf.where(Stock.brand_id == line.brand_id,
                                    Stock.variant_id == (line.variant_id or 0),
                                    Stock.model_id == (line.model_id or 0))
            on_shelf = _d(await db.scalar(shelf))
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
            **combinations.carry(line),
            "no_brand": bool(line.no_brand),
            "substituted_from": line.substituted_from,
            "substitution_reason": line.substitution_reason,
            "warehouse_id": line.warehouse_id,
            "warehouse_name": line.warehouse_name,
            "requested_qty": float(_d(line.requested_qty)),
            "line_requested_qty": float(asked[_indent_line_key(line)]),
            "quantity": float(_d(line.quantity)),
            "on_shelf": float(on_shelf),
            "pledged_elsewhere": float(max(on_shelf - free, ZERO)),
            "free": float(free + already_held),
            # Never more than was asked for: an approver revises downward, or back up
            # to the request — raising it above is a new requirement, not an approval.
            # The indent LINE's request; the screen nets off the line's other rows.
            "max_allowed": float(min(asked[_indent_line_key(line)], free + already_held)),
        })
    return out


def _indent_line_key(line) -> tuple:
    """Rows of one allocation that serve the same indent line share one request."""
    return ("line", line.indent_item_id) if line.indent_item_id else ("row", line.id)


def _requested_by_indent_line(lines) -> dict[tuple, Decimal]:
    """What each indent line asked for, summed over its rows — the desk DISTRIBUTES
    the request (10 on the first point, 0 on the second), never repeats it."""
    asked: dict[tuple, Decimal] = {}
    for line in lines:
        key = _indent_line_key(line)
        asked[key] = asked.get(key, ZERO) + _d(line.requested_qty)
    return asked


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
    # Every row, not only the revised ones: the cap is per indent LINE, and a line
    # served from two points is two rows sharing one request.
    every = (await db.execute(
        select(AllocationItem).where(AllocationItem.allocation_id == alloc.id)
    )).scalars().all()
    lines = [line for line in every if line.id in by_id]
    missing = by_id.keys() - {line.id for line in lines}
    if missing:
        raise ValidationError(
            f"Line {sorted(missing)[0]} does not belong to {alloc.allocation_no}")

    asked = _requested_by_indent_line(every)
    giving: dict[tuple, Decimal] = {}
    for row in every:
        key = _indent_line_key(row)
        giving[key] = giving.get(key, ZERO) + by_id.get(row.id, _d(row.quantity))
    for line in lines:
        key = _indent_line_key(line)
        if giving[key] > asked[key]:
            raise ValidationError(
                f"{line.item_name or line.item_id}: cannot give {giving[key]} in all — "
                f"only {asked[key]} was requested.")
    for line in lines:
        wanted = by_id[line.id]
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
        free = free_map.get(free_key(line), ZERO)
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
        (line, free_map.get(free_key(line), ZERO))
        for line in lines
        if _d(line.quantity) > free_map.get(free_key(line), ZERO)
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
        # The project goes into the number (2026-08-21). `ctx` already carries the
        # INDENT's project — inventory cannot read `ind_indents` itself (rule 5), so the
        # caller in indents hands it down, which is the same value the material request
        # a shortfall raises is filed under.
        allocation_no=await next_number(db, "allocation",
                                        project=(ctx or {}).get("project_name")),
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
            # Per brand / variant / model (2026-10-23): a decision naming one is
            # checked against that combination's own shelf as well as the item's.
            shelf = await shelf_by_combination(db, {d["item_id"]}, {d["warehouse_id"]})
            combo = combo_key(d)
            on_shelf = (sum(shelf.values(), ZERO) if combo is None
                        else shelf.get((d["item_id"], d["warehouse_id"], *combo), ZERO))
            # Less whatever an un-approved allocation has already promised out of this
            # point. Reservation only happens at approval, so without this the shelf
            # reads full to every approver until the first signature lands, and the
            # same 100 units get committed to three indents.
            pledged = await pledged_by_point(
                db, {d["item_id"]}, {d["warehouse_id"]}, by_combination=True)
            free = free_for(shelf, pledged, d["item_id"], d["warehouse_id"], combo)
            free += (await allocation.held_for(
                db, d.get("project_id"), {d["item_id"]}, {d["warehouse_id"]}
            )).get((d["item_id"], d["warehouse_id"]), ZERO)
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
            **combinations.carry(d),
            substituted_from=d.get("substituted_from"),
            substitution_reason=(d.get("substitution_reason") or "").strip()[:300] or None,
            no_brand=bool(d.get("no_brand")),
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
        # The same guard `act` takes before a signature settles anything, and for the
        # same reason — but it matters MORE here. The per-line check in the loop above
        # reads the shelf WITHOUT a row lock, which is fine while a human still has to
        # sign afterwards: the locked check runs at that signature. On a ladder set to
        # NO_APPROVAL there is no second moment, so this branch settles straight off an
        # unlocked read and two desks pressing at the same instant could both be told
        # the same units were free. `_assert_still_available` re-reads under the locks
        # the reservation itself takes, so they queue instead of both winning.
        await _assert_still_available(db, alloc)
        await _settle_approved(db, alloc, user, ctx, on_approved)
    else:
        alloc.status = AllocationStatus.PENDING_APPROVAL.value
        await _refresh_approver(db, alloc, doc_type)

    await write_audit(
        db, entity="inv_allocations", entity_id=alloc.id,
        entity_no=alloc.allocation_no, action=AuditAction.CREATE, actor=user,
        after={"status": alloc.status, "indent_no": indent_no,
               "lines": len(decisions),
               "brand_changes": [
                   f"{d.get('item_name') or d['item_id']}: {d['substituted_from']} -> "
                   + (" · ".join(p for p in (d.get("brand_name"), d.get("variant_name"),
                                              d.get("model_name")) if p) or "No brand")
                   + (f" ({d['substitution_reason']})" if d.get("substitution_reason") else "")
                   for d in decisions if d.get("substituted_from")]},
        summary=f"Stock allocation proposed for {indent_no}"
                + (" — brand changed on "
                   f"{sum(1 for d in decisions if d.get('substituted_from'))} line(s)"
                   if any(d.get("substituted_from") for d in decisions) else ""),
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
    implied_indent_status, _went_to_procurement = await apply_to_stock(
        db, alloc, user, ctx)
    # ONE terminal status, 2026-08-21. A signed allocation is APPROVED whether or not
    # the shelf covered all of it.
    #
    # AWAITING_PROCUREMENT used to park the document until the goods arrived, and the
    # document then had to be woken again — which meant every way stock can reach a
    # shelf was a doorway that had to remember to wake it, every reopen had to re-run
    # the ladder, and a reopened line had to be re-prefilled and re-guarded. Six
    # separate live defects came out of that one design, each one a doorway somebody
    # missed. What is still owed does not need to be held on a document: it is
    # `approved - allocated - on order`, and `indents.list_indents(has_remainder=True)`
    # already computes exactly that from the indent lines. So the remainder is READ,
    # never parked, and the indent comes back to the fulfilment desk on its own the
    # moment the shelf can serve it.
    alloc.status = AllocationStatus.APPROVED.value
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
    # Name AND rung, from the engine's one builder — see `current_approver_label`.
    alloc.current_approver_name = await engine.current_approver_label(
        db, doc_type, alloc.id)


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
                           indent_id: int | None = None, user=None,
                           only_indent_ids=None) -> dict:
    stmt = select(Allocation)
    # A subquery of indent ids to keep to — indents narrows a Stock Transfer-only
    # login to the allocations serving STRs (inventory cannot import indents).
    if only_indent_ids is not None:
        stmt = stmt.where(Allocation.indent_id.in_(only_indent_ids))
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
    today = ist_today()
    rows = (await db.execute(
        select(Stock.item_id, func.coalesce(func.sum(Stock.available_qty), 0))
        .join(Warehouse, Warehouse.id == Stock.warehouse_id)
        .where(Stock.item_id.in_(item_ids),
               Warehouse.warehouse_type.notin_(list(_CHAIN_TYPES)),
               or_(Stock.expiry_date.is_(None), Stock.expiry_date >= today))
        .group_by(Stock.item_id)
    )).all()
    return {item_id: _d(qty) for item_id, qty in rows}


# The reopen machinery is GONE, 2026-08-21.
#
# `reopen_for_available_stock`, `reopen_for_receipt`, `_prefill_from_shelf` and
# `_reopen_ctx` existed to wake an allocation parked on AWAITING_PROCUREMENT and put it
# back in front of its approver with the arrived quantity filled in. Every one of them
# was a source of live defects: the wake-up had to be wired into each doorway stock can
# reach a shelf through, the prefill promised tier-wide stock out of a single point,
# nothing netted what other parked allocations had already been promised, and the
# self-approving reopen settled without either of the shelf guards `create` and `act`
# carry.
#
# None of it is needed once a signed allocation is terminal. The remainder an indent is
# still owed is READ — `approved - allocated - on order`, computed by
# `indents.list_indents(has_remainder=True)` — so the indent surfaces on the fulfilment
# desk again by itself as soon as the shelf can serve it, and the desk raises a fresh
# allocation for what it can now give. No second document, no ladder to re-run, no
# quantity to re-guess.

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


async def withdraw_for_indent(db: AsyncSession, indent_id: int, user, reason: str) -> int:
    """Cancel what a request allocated while it was still in approval, and hand the
    stock back. For a request turned down or returned part-way up its ladder: nothing
    has left the shelf (an STR's issue is only drafted once its last level approves),
    so its holds and promises must not outlive the decision. A pending allocation's own
    approval task goes with it. Does not commit. Returns how many were withdrawn."""
    rows = (await db.execute(select(Allocation).where(
        Allocation.indent_id == indent_id,
        Allocation.status.in_(ACTIVE_ALLOCATION_STATUSES),
    ))).scalars().all()
    for alloc in rows:
        before = alloc.status
        if before == AllocationStatus.PENDING_APPROVAL.value:
            await engine.abandon(db, await doc_type_for(db, alloc.id), alloc.id, user, reason)
        alloc.status = AllocationStatus.CANCELLED.value
        alloc.current_approver_name = None
        await write_audit(
            db, entity="inv_allocations", entity_id=alloc.id,
            entity_no=alloc.allocation_no, action=AuditAction.UPDATE, actor=user,
            before={"status": before}, after={"status": alloc.status},
            summary=f"Stock allocation withdrawn — {reason}",
        )
    await allocation.release(db, RefType.RESERVATION.value, indent_id)
    return len(rows)


async def apply_to_stock(db: AsyncSession, alloc: Allocation, user,
                         ctx: dict | None = None) -> str:
    """Turn an approved decision into reservations, then one MR for the remainder.

    Returns (indent status this implies, whether a material request was raised). The
    second half no longer decides the ALLOCATION's status — a signed allocation is
    APPROVED either way since 2026-08-21 — but the caller cannot see the shortfalls
    from outside and the rules engine still reports on them, so it is still answered.

    Runs only on approval.
    """
    # Import here rather than at module load: service imports nothing from this file,
    # but this file needs its MR helper, and a top-level import would close the loop.
    from app.modules.inventory import service

    shortfalls, requested_total, given_total = [], ZERO, ZERO
    # What each indent line had ALREADY put aside, read ONCE before this allocation
    # reserves anything (2026-10-23). Read per row inside the loop, the second row of
    # one indent line — another point, or another brand / variant / model — counted
    # the first row's fresh reservation as "already held" and reserved that much less.
    prior: dict[int, Decimal] = {}

    for line in alloc.items:
        requested_total += _d(line.requested_qty)
        given_total += _d(line.quantity)

        # What this line has ALREADY put aside. A requirement can collect more than one
        # approved allocation — the cascade hands the remainder up the chain — so
        # reserving `quantity` outright would hold the same goods twice and starve
        # every other indent of stock nobody is using.
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
        if line.indent_item_id not in prior:
            prior[line.indent_item_id] = _d(await allocation.reserved_quantity(
                db, RefType.RESERVATION.value, alloc.indent_id,
                ref_line_id=line.indent_item_id, item_id=line.item_id,
                statuses=(ReservationStatus.ACTIVE.value,
                          ReservationStatus.CONSUMED.value),
            ))
        held = min(prior[line.indent_item_id], _d(line.quantity))
        prior[line.indent_item_id] -= held
        to_reserve = _d(line.quantity) - held
        # FIXED 2026-08-21 — `reserve` is deliberately partial-tolerant (an indent for
        # 100 against 60 on hand reserves 60 and returns the rest as a shortfall) and
        # this threw its answer away. A line promising more than its own point actually
        # holds therefore reserved less than it claimed, `line.quantity` still read the
        # full number, and `_recalculate_indent_allocation_state` counted the full
        # number as allocated — so the indent closed as ALLOCATED over stock nobody was
        # holding, and the gap became nobody's shortfall because the arithmetic below
        # measures `requested - decided`, not `requested - reserved`.
        #
        # `act` and `create` both check the shelf per point before they get here, so
        # this should be unreachable on those paths; it is the safety net for every
        # other doorway into approval, and it is what makes the two numbers agree.
        unreserved = ZERO
        if to_reserve > ZERO:
            _got, unreserved = await allocation.reserve(
                db, line.item_id, to_reserve, RefType.RESERVATION.value,
                alloc.indent_id, alloc.indent_no, user,
                project_id=line.project_id or NO_PROJECT,
                warehouse_ids=[line.warehouse_id] if line.warehouse_id else None,
                ref_line_id=line.indent_item_id,
                item=await db.get(Item, line.item_id),
                combination=combo_dict(line),
            )
            if unreserved > ZERO:
                # The decision has to tell the truth about what it actually holds, or
                # every reader downstream — the indent's allocated_qty, the fulfilment
                # draft, the remainder — inherits the lie.
                line.quantity = _d(line.quantity) - unreserved
                given_total -= unreserved

        # If stock was allocated for this line, credit any previous shortfall MR
        if _d(line.quantity) > ZERO and line.indent_item_id:
            from app.modules.inventory.models import MaterialRequestItem, MaterialRequest
            open_mr_items = (await db.execute(
                select(MaterialRequestItem)
                .join(MaterialRequest, MaterialRequest.id == MaterialRequestItem.mr_id)
                .where(
                    MaterialRequest.indent_id == alloc.indent_id,
                    MaterialRequestItem.indent_item_id == line.indent_item_id,
                    MaterialRequest.status.notin_((
                        MRStatus.REJECTED.value, MRStatus.CANCELLED.value, MRStatus.RECEIVED.value,
                    )),
                )
            )).scalars().all()
            for mr_it in open_mr_items:
                mr_it.received_quantity = min(
                    _d(mr_it.quantity),
                    _d(mr_it.received_quantity or 0) + _d(line.quantity),
                )
                parent_mr = await db.get(MaterialRequest, mr_it.mr_id)
                if parent_mr:
                    await db.refresh(parent_mr, ["items"])
                    if all(_d(mi.received_quantity or 0) >= _d(mi.quantity) for mi in parent_mr.items):
                        parent_mr.status = MRStatus.RECEIVED.value

        short = _d(line.requested_qty) - _d(line.quantity)
        if short > ZERO:
            # Only what the warehouse genuinely cannot supply becomes procurement
            # demand. A storekeeper who deliberately issues less than was asked for
            # — because the request was generous, or the rest is not needed yet —
            # used to raise a material request for the difference anyway, so
            # procurement chased stock that was sitting on the shelf. Availability is
            # read after this line's own reservation, so it is what is genuinely
            # spare.
            #
            # FIXED 2026-08-21 — WAREHOUSE TIER ONLY. This asked `available_for` with no
            # warehouse filter, so stock standing at a LIP or an MDP counted as spare
            # and suppressed the material request. That stock is real but it is not the
            # warehouse's to issue — every other read in this file draws the same line
            # (`warehouse_available`, `line_availability`, `main_available_qty`) — so a
            # shortage the warehouse genuinely could not cover was answered with "there
            # is plenty" and nobody bought it. The indent then sat on
            # AWAITING_ALLOCATION with nothing on order and no one buying.
            spare = _d(await availability.available_for(
                db, line.item_id, project_id=line.project_id or NO_PROJECT,
                warehouse_types=_WAREHOUSE_TIER_TYPES))
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
                # SCM_0155: the indent's own date and urgency, handed down by the
                # caller (inventory may not read `ind_indents`, rule 5). The MR list's
                # "Needed by" read blank on every request raised this way.
                "required_by": ctx.get("required_by"),
                "priority": ctx.get("priority"),
                "requester_position_id": getattr(user, "active_position_id", None),
            })

    # FIXED 2026-08-21 — this read `given_total` alone, so "gave nothing because there
    # is nothing to give" and "gave nothing because the approver never typed a number"
    # produced the identical status. The second case parks the indent on
    # PENDING_PROCUREMENT with NO material request behind it: nothing is on order, so
    # no purchase will ever cover it, and the indent sits waiting for goods that were
    # already on the shelf when it was signed.
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
    return IndentStatus.PARTIALLY_ALLOCATED.value, bool(shortfalls)
