"""Serving an indent from the approver's own stock, at the moment of approval.

This lives in approvals, not inventory, because it needs BOTH: `ind_indent_items` to
know what was asked for, and inventory to decide what may be given. Inventory is the
base module and may not import indents (rule 5), so the orchestration has to sit on
this side of the chain.

NOTHING PHYSICALLY MOVES HERE. "Issue from my stock" records an INTENT: it raises an
allocation against the source point the approver chose. The allocation climbs its own
ladder, approval reserves the stock, and the goods only leave the shelf at the
warehouse material issue. Moving stock the moment the button was clicked handed
material out before anyone had signed for it, and left the warehouse with nothing to
pick against.

The remainder is what makes the cascade work: a line is served as far as the current
approver can serve it, `allocated_qty` records how much once the allocation is
approved, and the SAME indent travels on carrying `approved − allocated`.
"""
import logging
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.modules.indents.enums import IndentStatus
from app.modules.indents.models import Indent, IndentItem
from app.modules.inventory import allocations, locations
# Unsigned promises only. Every caller pairs this with `allocated_quantity`, which is
# already the APPROVED sum, so counting approved allocations as "live" here deducted
# them twice and reported lines as covered while stock was still owed.
from app.modules.inventory.allocations import (
    UNAPPROVED_ALLOCATION_STATUSES as LIVE_ALLOCATION_STATUSES,
)
from app.modules.inventory.models import NO_PROJECT, Allocation, AllocationItem, Stock
from app.platform.hcm.models import HcmPositionAssignment
from app.platform.settings.service import write_audit
from app.shared.enums import AuditAction, DocType, InstanceStatus
from app.shared.models.warehouse import Warehouse

logger = logging.getLogger(__name__)


def _d(value) -> Decimal:
    return Decimal(str(value or 0))


def remainder_of(line: IndentItem) -> Decimal:
    """What is still owed on this line: approved less what has already been served.

    Never negative — an over-issue is a data problem, not a reason to hand out more.
    """
    return max(_d(line.approved_quantity) - _d(line.allocated_quantity), Decimal("0"))


async def _stock_at(
    db: AsyncSession, item_id: int, warehouse_ids: set[int],
    indent_id: int | None = None,
) -> dict[int, Decimal]:
    """Free quantity per point, for one item: what is on the shelf, less what an
    un-approved allocation has already promised out of it.

    The subtraction is the point. Nothing is reserved until an allocation is approved,
    so an OE who has just given 100 of his 505 to one storekeeper still reads 505 on
    `available_qty` — and the next storekeeper's screen offered him the same units
    again. This indent's own pledges are excluded because the caller already takes
    them off line by line via `committed_by_line`; counting them here as well would
    deduct them twice.
    """
    if not warehouse_ids:
        return {}
    rows = (await db.execute(
        select(Stock.warehouse_id, Stock.available_qty).where(
            Stock.item_id == item_id,
            Stock.warehouse_id.in_(warehouse_ids),
        )
    )).all()
    totals: dict[int, Decimal] = {}
    for warehouse_id, available in rows:
        totals[warehouse_id] = totals.get(warehouse_id, Decimal("0")) + _d(available)

    pledged = await allocations.pledged_by_point(
        db, {item_id}, warehouse_ids, exclude_indent_id=indent_id)
    for (_item, warehouse_id), qty in pledged.items():
        if warehouse_id in totals:
            totals[warehouse_id] -= qty
    return {wid: qty for wid, qty in totals.items() if qty > 0}


async def committed_by_line(db: AsyncSession, indent_id: int) -> dict[int, Decimal]:
    """Per indent line, how much a LIVE allocation has already promised.

    `allocated_quantity` only moves when an allocation is APPROVED, so on its own it
    reads a line an approver just committed as still completely unserved: the queue
    kept listing it, the same stock could be promised twice, and the indent climbed to
    the DM for goods somebody downstream had already given. Draft and pending
    allocations count here — a promise waiting on a signature is still a promise.
    """
    rows = (await db.execute(
        select(AllocationItem.indent_item_id, func.sum(AllocationItem.quantity))
        .join(Allocation, Allocation.id == AllocationItem.allocation_id)
        .where(Allocation.indent_id == indent_id,
               Allocation.status.in_(LIVE_ALLOCATION_STATUSES))
        .group_by(AllocationItem.indent_item_id)
    )).all()
    return {line_id: _d(qty) for line_id, qty in rows}


async def _names_for(db: AsyncSession, warehouse_ids: set[int]) -> dict[int, str]:
    if not warehouse_ids:
        return {}
    rows = (await db.execute(
        select(Warehouse.id, Warehouse.name).where(Warehouse.id.in_(warehouse_ids))
    )).all()
    return {wid: name for wid, name in rows}


async def _requester_point(db: AsyncSession, indent: Indent) -> int | None:
    """The LIP the raiser draws into — their own position's primary point."""
    position_id = (await db.execute(
        select(HcmPositionAssignment.position_id).where(
            HcmPositionAssignment.employee_id == indent.requested_by_id,
        ).limit(1)
    )).scalar_one_or_none()
    # Provisions the raiser's LIP from their position's office if nobody has tagged
    # one. Field staff are never tagged by hand — the office they sit at IS their
    # local inventory point — so this is what stops a new joiner's indent being
    # approved with nowhere to deliver.
    return await locations.ensure_point_for_position(db, position_id)


async def availability_for_indent(db: AsyncSession, indent_id: int, user) -> dict:
    """Per line: what is still owed, and what this approver can cover from their
    own points. This is what puts "you have 10 of these" on the approval screen."""
    indent = (await db.execute(
        select(Indent).where(Indent.id == indent_id)
    )).scalars().first()
    if indent is None:
        raise NotFoundError("Indent not found")

    # Every live post this person holds, not the hat they happen to be wearing: the
    # storekeepers carrying the stock hang off one of a DM's four posts, and scoping to
    # the selected one showed him nothing and read as missing stock.
    my_points = await locations.location_ids_for_user(db, user)
    target = await _requester_point(db, indent)
    # A point cannot serve itself. The raiser's own shelf is inside `my_points`
    # whenever they report under this approver — an OE holds every LIP below him,
    # and the LIP storekeeper who raised the indent is one of them — so without this
    # the screen offered the raiser's own units back to him as a source, and
    # `issue_from_my_stock` then refused the very row the screen had suggested.
    source_points = my_points - {target} if target is not None else my_points
    # Names, once, for every point in play. A picker that offers "#12" asks the
    # approver to know warehouse ids by heart.
    names = await _names_for(db, source_points | ({target} if target else set()))
    committed = await committed_by_line(db, indent_id)

    lines = (await db.execute(
        select(IndentItem).where(IndentItem.indent_id == indent_id)
        .order_by(IndentItem.line_no)
    )).scalars().all()

    out = []
    for line in lines:
        by_point = await _stock_at(db, line.item_id, source_points, indent_id=indent_id)
        owed = max(remainder_of(line) - committed.get(line.id, Decimal("0")),
                   Decimal("0"))
        on_hand = sum(by_point.values(), Decimal("0"))
        out.append({
            "line_id": line.id,
            "item_id": line.item_id,
            "item_code": line.item_code,
            "item_name": line.item_name,
            "uom_code": line.uom_code,
            "requested_quantity": float(_d(line.quantity)),
            "approved_quantity": float(_d(line.approved_quantity)),
            "allocated_quantity": float(_d(line.allocated_quantity)),
            # Already promised by an allocation that has not been signed off yet.
            "committed_quantity": float(committed.get(line.id, Decimal("0"))),
            "remainder": float(owed),
            "available_at_my_points": float(on_hand),
            # What an Issue now would actually move: you cannot give more than is
            # owed, nor more than you hold.
            "issuable_now": float(min(owed, on_hand)),
            # Fullest shelf first, the way the fulfilment queue already orders them.
            # Sorted by warehouse id, the default source was whichever point happened
            # to have the lowest id: an approver holding 505 across five points was
            # offered one holding 5, typed the 10 that was owed, and got "only 5.000 is
            # available" while the panel above said he held 505.
            "sources": [
                {"warehouse_id": wid, "warehouse_name": names.get(wid) or f"Point {wid}",
                 "available_quantity": float(qty)}
                for wid, qty in sorted(by_point.items(), key=lambda kv: (-kv[1], kv[0]))
            ],
        })

    return {
        "indent_id": indent.id,
        "indent_no": indent.indent_no,
        "target_warehouse_id": target,
        "target_warehouse_name": names.get(target) if target else None,
        "my_warehouse_ids": sorted(source_points),
        "items": out,
    }


async def _may_settle(db: AsyncSession, indent_id: int, user) -> bool:
    """Is this login the approver the indent is currently waiting on?

    The same three conditions `approvals.service._load_indent_task` enforces, asked
    instead of raised: issuing stock must keep working for anyone who holds
    INDENT_APPROVE, and only the current approver's issue also settles the ladder.
    """
    from app.platform.workflow.models import Instance, Pending

    indent = await db.get(Indent, indent_id)
    if indent is None or indent.status != IndentStatus.PENDING_APPROVAL.value:
        return False
    if indent.requested_by_id == user.id:
        return False
    instance = (await db.execute(select(Instance).where(
        Instance.doc_type == DocType.INDENT.value,
        Instance.doc_id == indent_id,
        Instance.status == InstanceStatus.IN_PROGRESS.value,
    ))).scalars().first()
    if instance is None:
        return False
    return bool(await db.scalar(select(func.count(Pending.id)).where(
        Pending.instance_id == instance.id,
        Pending.stage_sequence == instance.current_sequence,
        Pending.approver_id == user.id,
    )))


async def _wrong_hat_message(db: AsyncSession, indent_id: int, user) -> str | None:
    """Refuse BEFORE anything is written when the wrong post is being worn.

    Issuing is two acts in one call: the allocation is created and committed, and then
    the ladder is settled so the remainder travels on. The second half runs through
    `act_on_indent` -> `get_indent(user)`, which applies the profile's scope rung — and
    that rung is keyed to the ACTIVE position (`shared/scope.py`), exactly as the
    ladder's own `allowed_position_ids` is.

    So a District Manager holding both DM-104-PADERU and DM-104-VIZIANAGARAM, acting on
    a Vizianagaram indent while wearing the Paderu hat, got the allocation written and
    then a 404 on the settle: `IND/2026-27/00639` ended up with 5.612 promised out of
    stock and its ladder still parked on the District Manager, so the remainder never
    reached the level above. Half an act is worse than none.

    Only asked of the person the stage is actually waiting on — the same gate
    `_may_settle` applies. An inventory desk serving somebody else's document never
    settles the ladder, so it has no hat to be wrong about and is untouched.

    The set is the engine's own, so this refuses EXACTLY what the approval queue now
    hides: a login with one post, or none, is never in it and reaches this screen
    unchanged.
    """
    from app.platform.workflow import engine
    from app.platform.workflow.models import Instance

    if not await _may_settle(db, indent_id, user):
        return None
    instance = (await db.execute(select(Instance).where(
        Instance.doc_type == DocType.INDENT.value,
        Instance.doc_id == indent_id,
        Instance.status == InstanceStatus.IN_PROGRESS.value,
    ))).scalars().first()
    if instance is None:
        return None
    other_hats = await engine.instances_for_other_hats(
        db, user, [DocType.INDENT.value])
    if instance.id not in other_hats:
        return None

    post = next(
        (link.get("position_name")
         for link in (getattr(instance, "resolved_chain", None) or [])
         if isinstance(link, dict)
         and link.get("sequence") == getattr(instance, "current_sequence", None)),
        None,
    )
    return (
        "This indent is waiting on "
        + (post or "another of your positions")
        + ". Switch to that position before serving it from stock — issuing under this "
          "one would raise the allocation and then be unable to pass the remainder on."
    )


async def issue_from_my_stock(
    db: AsyncSession, indent_id: int, requests: list, user, reason: str = "",
    forward_remainder: bool = False,
) -> dict:
    """Record what this approver intends to give, from their own point.

    Raises ONE allocation covering every line, against the source points chosen. The
    allocation is the intent; its approval reserves; the warehouse material issue
    moves. What is left over stays on the line as remainder and travels up with the
    indent.
    """
    indent = (await db.execute(
        select(Indent).where(Indent.id == indent_id)
    )).scalars().first()
    if indent is None:
        raise NotFoundError("Indent not found")

    # Before a single row is written: see _wrong_hat_message.
    wrong_hat = await _wrong_hat_message(db, indent_id, user)
    if wrong_hat:
        raise ValidationError(wrong_hat)

    target = await _requester_point(db, indent)
    if target is None:
        raise ValidationError(
            "The requester's position is not tagged to a stocking point, so there is "
            "nowhere to issue into. Tag it under Inventory > Stocking Points.",
        )

    my_points = await locations.location_ids_for_user(db, user)

    decisions, issued = [], []
    committed = await committed_by_line(db, indent_id)
    planned: dict[int, Decimal] = {}
    for request in requests:
        line = (await db.execute(
            select(IndentItem).where(
                IndentItem.id == request.line_id,
                IndentItem.indent_id == indent_id,
            )
        )).scalars().first()
        if line is None:
            raise NotFoundError(f"Line {request.line_id} is not on this indent")

        source = request.warehouse_id
        if source not in my_points:
            raise ValidationError(
                "You can only issue from a point you hold or one reporting under you",
            )
        if source == target:
            raise ValidationError(
                "Source and destination are the same point — nothing to issue",
            )

        qty = _d(request.quantity)
        # What is left after anything a live allocation has already promised, so two
        # approvers cannot each commit the same quantity against the same line.
        owed = max(remainder_of(line) - committed.get(line.id, Decimal("0")),
                   Decimal("0")) - planned.get(line.id, Decimal("0"))
        if qty <= 0:
            raise ValidationError("Issue quantity must be positive")
        if qty > owed:
            raise ValidationError(
                f"{line.item_name or line.item_code}: only {owed} still owed on this line",
            )

        # The decision, not the movement. One allocation line per (indent line,
        # source point); inventory reserves it when the ladder approves.
        decisions.append({
            "indent_item_id": line.id,
            "item_id": line.item_id,
            "item_code": line.item_code,
            "item_name": line.item_name,
            "uom_code": line.uom_code,
            "requested_qty": float(owed),
            "quantity": float(qty),
            "warehouse_id": source,
            "project_id": indent.project_id or NO_PROJECT,
        })
        planned[line.id] = planned.get(line.id, Decimal("0")) + qty
        issued.append({
            "line_id": line.id,
            "item_name": line.item_name or line.item_code,
            "quantity": float(qty),
            "from_warehouse_id": source,
            "to_warehouse_id": target,
            # `owed` already excludes everything committed and everything planned
            # earlier in this same submission, so only this line's own quantity comes
            # off it here.
            "remainder": float(max(owed - qty, Decimal("0"))),
        })

    # Imported at the call, not at module load: indents imports approvals' schemas for
    # its own approval payloads, and a top-level import would close the loop.
    from app.modules.indents import service as indent_service

    alloc = await indent_service.create_allocation_for_indent(
        db, indent, decisions, user,
        remarks=(f"Issued from own stock into point {target}."
                 + (f" {reason}" if reason else "")).strip(),
    )

    await write_audit(
        db, entity="ind_indents", entity_id=indent.id, entity_no=indent.indent_no,
        action=AuditAction.UPDATE, actor=user,
        after={"allocation_no": alloc.allocation_no, "lines": len(decisions),
               "target_warehouse_id": target},
        summary=(f"Allocation {alloc.allocation_no} raised from own stock"
                 + (f" — {reason}" if reason else "")),
    )
    await db.commit()

    remaining = (await db.execute(
        select(IndentItem).where(IndentItem.indent_id == indent_id)
    )).scalars().all()
    # What is still owed once every live allocation is honoured — the one just raised
    # included. Counting only `allocated_quantity` would report the full quantity as
    # outstanding, because nothing is allocated until an allocation is approved, and
    # send the indent climbing for goods somebody has already committed.
    settled = await committed_by_line(db, indent_id)
    outstanding = sum(
        (max(remainder_of(line) - settled.get(line.id, Decimal("0")), Decimal("0"))
         for line in remaining),
        Decimal("0"),
    )

    # Nothing left owed, or the rest handed upward — either way the decision is made
    # here and `approve_indent` records it. It ends the ladder by itself when nothing
    # is owed (`_nothing_owed` -> `final`), so a fully-served indent stops at this rung
    # instead of climbing for goods that are already committed, and the approve button
    # goes away because the indent is no longer awaiting approval.
    #
    # The approved quantities are passed through untouched — this approver already
    # decided them, and issuing is not a second decision. The engine owns the advance
    # (rule 8); nothing here moves the document itself.
    forwarded = False
    closed = False
    settle = outstanding == 0 or (forward_remainder and outstanding > 0)
    # Only the person the stage is actually waiting on may settle it. Issuing stock is
    # gated on INDENT_APPROVE, which is not the same thing as being THIS indent's
    # current approver — an inventory desk serving someone else's document must leave
    # the ladder exactly where it was rather than signing it off by side effect.
    if settle and await _may_settle(db, indent_id, user):
        from . import service as approvals_service
        from .schemas import ApprovalQuantityIn

        await approvals_service.approve_indent(
            db, indent_id,
            [
                ApprovalQuantityIn(
                    line_id=line.id,
                    approved_quantity=float(_d(line.approved_quantity)),
                )
                for line in remaining
            ],
            (f"Allocated {alloc.allocation_no} from own stock. "
             + ("Served in full." if outstanding == 0
                else f"{outstanding} still owed.")
             + (f" {reason}" if reason else "")),
            user,
        )
        forwarded = outstanding > 0
        # The ladder ended here either way. Both arms of `settle` call approve_indent,
        # so "send the rest on" takes the document out of this approver's queue just as
        # surely as serving it in full does — reporting closed only for the full-serve
        # case left the screen refetching an indent that had already moved to
        # AWAITING_ALLOCATION, which answers 422 and paints a red error over an act
        # that succeeded. Whether anything is still owed is `fully_served`, separately.
        closed = True

    return {
        "indent_id": indent_id,
        "allocation_id": alloc.id,
        "allocation_no": alloc.allocation_no,
        "allocation_status": alloc.status,
        "issued": issued,
        "outstanding_quantity": float(outstanding),
        # Nothing left owed anywhere: the indent has no reason to climb further.
        "fully_served": outstanding == 0,
        "forwarded": forwarded,
        # The ladder was ended here. False when the issuer was not the current
        # approver — the document is untouched and still waiting on whoever it was
        # waiting on, exactly as before.
        "closed": closed,
    }
