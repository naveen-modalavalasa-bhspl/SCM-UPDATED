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
from app.modules.indents.enums import IndentStatus, IndentType
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
    approved_quantities: dict[int, float] | None = None,
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
            # An STR's remainder travels on to the next level, so what this point cannot
            # give is not a shortage: stated as owed it would raise a material request
            # for goods the levels above have not been asked about yet.
            "requested_qty": float(qty if indent.indent_type == IndentType.STR.value else owed),
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
                    # The approver's own numbers when the caller carries them (the STR
                    # source panel signs the quantities on screen); otherwise the
                    # quantities already decided, untouched.
                    approved_quantity=float(
                        approved_quantities[line.id]
                        if approved_quantities and line.id in approved_quantities
                        else _d(line.approved_quantity)),
                )
                for line in remaining if not line.is_excluded
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


# ---------------- Stock Transfer Request: the source point (2026-11-04) ----------------
#
# An STR names the point the stock should come FROM. Every approver on its ladder is
# shown whether that point is in THEIR scope (a point they hold, or one reporting under
# them — `locations.location_ids_for_user`, the same set "Serve from own stock" draws
# on), and the screen offers the matching act:
#
#   in scope      -> approve and allocate from the source, here, now;
#   out of scope  -> forward to the next level, or pull the request onto one of their
#                    own points (recorded), then allocate there or forward it.
#
# SERVED IN FULL ENDS IT (2026-11-05). An approver who allocates everything ends the
# ladder there; only what is still owed goes up. Allocating reserves the stock, but its
# issue is only drafted when the approval ends (`indents._fulfilment_drafts`), and a
# rejection or a return gives the stock back (`indents._withdraw_str_allocations`).
#
# NO NEXT LEVEL. "Last" means no rung above in the FROZEN ladder, never that HCM has no
# parent. At the last level, a source outside scope with something still owed cannot be
# approved (`assert_str_approvable`): the approver changes the source, returns or
# rejects, and an admin adds the missing rung on Settings > Approvals Config. Nothing
# here moves stock — allocating is the same intent `issue_from_my_stock` records,
# reserved when the allocation is signed.

NO_NEXT_LEVEL_MESSAGE = (
    "No next approval level is configured, and the source point is outside your scope. "
    "Change the source to one of your points, return or reject the request, or ask your "
    "admin to add the next level on Settings > Approvals Config."
)


def _is_last_level(instance) -> bool | None:
    """True when no rung of the frozen ladder sits above the current one. None when
    the instance was not resolved as a ladder (nothing to count)."""
    chain = getattr(instance, "resolved_chain", None)
    if not isinstance(chain, list) or not chain:
        return None
    current = int(getattr(instance, "current_sequence", 0) or 0)
    return not any(isinstance(link, dict) and int(link.get("sequence", 0) or 0) > current
                   for link in chain)


def _ladder_levels(instance) -> list[dict]:
    """The frozen ladder as the screen draws it: who has signed, who is signing, who is
    still to come. Empty for an instance not resolved as a ladder."""
    chain = getattr(instance, "resolved_chain", None)
    if not isinstance(chain, list):
        return []
    current = int(getattr(instance, "current_sequence", 0) or 0)
    levels = []
    for link in chain:
        if not isinstance(link, dict):
            continue
        sequence = int(link.get("sequence", 0) or 0)
        levels.append({
            "sequence": sequence,
            "role_name": link.get("role_name"),
            "position_name": link.get("position_name"),
            "state": ("DONE" if sequence < current
                      else "CURRENT" if sequence == current else "NEXT"),
        })
    return sorted(levels, key=lambda level: level["sequence"])


def _served(line: IndentItem, committed: dict[int, Decimal]) -> Decimal:
    """How much of a line an allocation already covers, signed or not."""
    return _d(line.allocated_quantity) + committed.get(line.id, Decimal("0"))


def _assert_keeps_what_is_served(line: IndentItem, approved: Decimal,
                                 committed: dict[int, Decimal]) -> None:
    served = _served(line, committed)
    if approved < served:
        raise ValidationError(
            f"{line.item_name or line.item_code}: {served.normalize():f} is already "
            "allocated, so it cannot be approved below that.")


async def assert_str_approvable(db: AsyncSession, indent: Indent, instance,
                                approved_by_line: dict[int, Decimal], user) -> None:
    """What an STR's approver may not sign: less than is already allocated, or a remainder
    with nowhere to go. Asked before anything is written. Every line at zero is the
    rejection path and is not asked, since rejecting gives the allocations back."""
    if indent.indent_type != IndentType.STR.value:
        return
    if not any(qty > 0 for qty in approved_by_line.values()):
        return
    # An STR raised before SCM_0182 may name its own delivery point as the source.
    # Approving it would draft an issue that leaves and lands on the same shelf.
    from app.modules.indents import service as indent_service
    if indent.source_warehouse_id and hasattr(indent, "position_id") and (
            indent.source_warehouse_id
            == await indent_service.str_destination_point(db, indent)):
        raise ValidationError(
            f"{indent.source_warehouse_name or 'The source'} is also where this stock is "
            "going. Change the source to a point that holds it, or return the request.")
    committed = await committed_by_line(db, indent.id)
    owed = Decimal("0")
    for line in indent.items:
        if line.id not in approved_by_line:
            continue
        approved = approved_by_line[line.id]
        _assert_keeps_what_is_served(line, approved, committed)
        owed += approved - _served(line, committed)
    if owed <= 0 or _is_last_level(instance) is not True:
        return
    scope = await locations.location_ids_for_user(db, user)
    if indent.source_warehouse_id not in scope:
        raise ValidationError(NO_NEXT_LEVEL_MESSAGE)


async def _str_task(db: AsyncSession, indent_id: int, user):
    """The STR this login is approving right now, with its live instance."""
    from app.modules.indents.enums import IndentType
    from . import service as approvals_service

    indent, instance, _previous = await approvals_service._load_indent_task(
        db, indent_id, user)
    if indent.indent_type != IndentType.STR.value:
        raise ValidationError("Only a stock transfer request has a source point")
    return indent, instance


async def str_source_review(db: AsyncSession, indent_id: int, user) -> dict:
    """What the STR approval screen says about the source, and what it can offer."""
    from app.modules.indents import service as indent_service

    indent, instance = await _str_task(db, indent_id, user)
    source_id = indent.source_warehouse_id
    destination_id = await indent_service.str_destination_point(db, indent)
    scope = await locations.location_ids_for_user(db, user)
    in_scope = bool(source_id) and source_id in scope

    committed = await committed_by_line(db, indent_id)
    lines = [line for line in (await db.execute(
        select(IndentItem).where(IndentItem.indent_id == indent_id)
        .order_by(IndentItem.line_no)
    )).scalars().all() if not getattr(line, "is_excluded", False)]
    owed_by_line = {
        line.id: max(remainder_of(line) - committed.get(line.id, Decimal("0")), Decimal("0"))
        for line in lines
    }

    # The approver's own points that could take the request over: in scope, not the
    # delivery point, holding something free for at least one line.
    candidates = scope - ({destination_id} if destination_id else set())
    free: dict[int, dict[int, Decimal]] = {}   # point -> line -> free
    source_free: dict[int, Decimal] = {}
    for line in lines:
        if owed_by_line[line.id] <= 0:
            continue
        points = candidates | ({source_id} if source_id else set())
        by_point = await _stock_at(db, line.item_id, points, indent_id=indent_id)
        for wid, qty in by_point.items():
            if wid in candidates:
                free.setdefault(wid, {})[line.id] = qty
        if source_id:
            source_free[line.id] = by_point.get(source_id, Decimal("0"))

    owing = [line for line in lines if owed_by_line[line.id] > 0]
    wanted = set(free) | {w for w in (source_id, destination_id) if w}
    names = await _names_for(db, wanted)
    types = dict((await db.execute(
        select(Warehouse.id, Warehouse.warehouse_type).where(Warehouse.id.in_(wanted or {0}))
    )).all())
    holders = await locations.point_holder_names(
        db, {w for w in (source_id, destination_id) if w})

    def _point(wid):
        if not wid:
            return None
        tier = locations.tier_of(types.get(wid))
        return {"warehouse_id": wid,
                "warehouse_name": names.get(wid)
                or (indent.source_warehouse_name if wid == source_id else None),
                "tier_label": locations.tier_label(tier),
                "held_by": holders.get(wid, [])}

    options = []
    for wid, per_line in free.items():
        if wid == source_id:
            continue
        covers_full = sum(1 for line in owing
                          if per_line.get(line.id, Decimal("0")) >= owed_by_line[line.id])
        covers_any = sum(1 for line in owing if per_line.get(line.id, Decimal("0")) > 0)
        options.append({
            **_point(wid),
            "covers_full": covers_full, "covers_any": covers_any,
            "lines": [{"line_id": line.id,
                       "free_quantity": float(per_line.get(line.id, Decimal("0")))}
                      for line in owing],
        })
    options.sort(key=lambda o: (-o["covers_full"], -o["covers_any"],
                                (o["warehouse_name"] or "").lower()))

    from app.modules.indents.models import StrSourceChange
    changes = (await db.execute(
        select(StrSourceChange).where(StrSourceChange.indent_id == indent.id)
        .order_by(StrSourceChange.id))).scalars().all()

    # What the levels below have already allocated, in the words of the document.
    allocated_rows = (await db.execute(
        select(AllocationItem, Allocation)
        .join(Allocation, Allocation.id == AllocationItem.allocation_id)
        .where(Allocation.indent_id == indent.id,
               Allocation.status.in_(allocations.ACTIVE_ALLOCATION_STATUSES),
               AllocationItem.quantity > 0)
        .order_by(Allocation.id, AllocationItem.id)
    )).all()
    allocated_names = await _names_for(
        db, {row.warehouse_id for row, _ in allocated_rows if row.warehouse_id})

    levels = _ladder_levels(instance)
    return {
        "indent_id": indent.id,
        "indent_no": indent.indent_no,
        "levels": levels,
        "next_level": next((lv for lv in levels if lv["state"] == "NEXT"), None),
        "fully_served": bool(allocated_rows) and not owing,
        "allocated": [{
            "allocation_no": alloc.allocation_no,
            "signed": alloc.status in allocations.SETTLED_ALLOCATION_STATUSES,
            "allocated_by_name": alloc.allocated_by_name,
            "item_name": row.item_name or row.item_code,
            "uom_code": row.uom_code,
            "quantity": float(_d(row.quantity)),
            "warehouse_name": allocated_names.get(row.warehouse_id),
        } for row, alloc in allocated_rows],
        "changes": [{
            "id": c.id, "from_warehouse_id": c.from_warehouse_id,
            "from_warehouse_name": c.from_warehouse_name,
            "to_warehouse_id": c.to_warehouse_id, "to_warehouse_name": c.to_warehouse_name,
            "stage_name": c.stage_name, "reason": c.reason,
            "changed_by_name": c.changed_by_name, "position_name": c.position_name,
            "created_at": c.created_at.isoformat() if c.created_at else None,
        } for c in changes],
        "source": _point(source_id),
        "destination": _point(destination_id),
        "in_scope": in_scope,
        "is_last_level": _is_last_level(instance),
        "stage_name": instance.current_stage_name,
        "lines_owing": len(owing),
        "source_lines": [{"line_id": line.id,
                          "owed_quantity": float(owed_by_line[line.id]),
                          "free_quantity": float(source_free.get(line.id, Decimal("0")))}
                         for line in owing],
        "my_points": options,
    }


class _Req:
    """The shape `issue_from_my_stock` reads off each request."""

    def __init__(self, line_id: int, warehouse_id: int, quantity: Decimal):
        self.line_id, self.warehouse_id, self.quantity = line_id, warehouse_id, quantity


async def str_allocate(db: AsyncSession, indent_id: int, body, user) -> dict:
    """Approve this rung AND allocate from a point in the approver's scope — the STR's
    own source, or one of their points they pull it onto (recorded, with a reason).

    Each line takes what the point has free, up to what this approver signs on it;
    whatever the point cannot give stays owed and travels on, exactly as "Serve from
    own stock" leaves a remainder."""
    from app.modules.indents import service as indent_service

    indent, instance = await _str_task(db, indent_id, user)
    scope = await locations.location_ids_for_user(db, user)
    target = int(body.source_warehouse_id or indent.source_warehouse_id or 0)
    if not target:
        raise ValidationError("This request has no source point — choose one of yours")
    if target not in scope:
        raise ValidationError(
            "That point is not in your scope. Forward the request to the next level, "
            "or choose one of your own points")
    moving = target != indent.source_warehouse_id
    reason = (body.reason or "").strip()
    if moving and not reason:
        raise ValidationError("Say why you are changing the source point")
    # Never the point the stock is going into, and a warehouse is served by a
    # warehouse (SCM_0182) — the same rule the STR itself is saved under.
    await indent_service.assert_str_source_fits(
        db, await db.get(Warehouse, target),
        await indent_service.str_destination_point(db, indent))

    signed = {q.line_id: Decimal(str(q.approved_quantity)) for q in body.items}
    committed = await committed_by_line(db, indent_id)
    lines = (await db.execute(
        select(IndentItem).where(IndentItem.indent_id == indent_id)
    )).scalars().all()

    requests = []
    for line in lines:
        if line.id not in signed:
            continue
        _assert_keeps_what_is_served(line, signed[line.id], committed)
        owed = (min(signed[line.id] - _d(line.allocated_quantity), remainder_of(line))
                - committed.get(line.id, Decimal("0")))
        if owed <= 0:
            continue
        here = (await _stock_at(db, line.item_id, {target}, indent_id=indent_id)).get(
            target, Decimal("0"))
        qty = min(owed, here)
        if qty > 0:
            requests.append(_Req(line.id, target, qty))
    point_name = (await _names_for(db, {target})).get(target) or f"Point {target}"
    if not requests:
        raise ValidationError(
            f"{point_name} has none of these items free. Forward the request to the "
            f"next level, or choose another of your points.")

    previous = indent.source_warehouse_name
    if moving:
        await indent_service.change_str_source(
            db, indent, target, user, reason=reason,
            stage_name=instance.current_stage_name)
    note = (f"Allocated from {point_name}"
            + (f" (source moved from {previous or 'none'})" if moving else "")
            + (f" — {reason}" if reason else ""))
    return await issue_from_my_stock(
        db, indent_id, requests, user, reason=note, forward_remainder=True,
        approved_quantities={k: float(v) for k, v in signed.items()},
    )


async def str_forward(db: AsyncSession, indent_id: int, body, user):
    """Move an STR's source to one of the approver's points and forward it without
    allocating: the level above decides what happens at the new source. The move is
    recorded with its reason, exactly as moving and allocating is."""
    from app.modules.indents import service as indent_service
    from . import service as approvals_service

    indent, instance = await _str_task(db, indent_id, user)
    if _is_last_level(instance) is True:
        raise ValidationError(
            "No next approval level is configured, so this request cannot be forwarded. "
            "Allocate it from your point, or ask your admin to add the next level on "
            "Settings > Approvals Config.")
    target = body.source_warehouse_id
    if not target or target not in await locations.location_ids_for_user(db, user):
        raise ValidationError("Choose one of your own points as the new source")
    await indent_service.assert_str_source_fits(
        db, await db.get(Warehouse, target),
        await indent_service.str_destination_point(db, indent))
    reason = (body.reason or "").strip()
    if not reason:
        raise ValidationError("Say why you are changing the source point")
    await indent_service.change_str_source(
        db, indent, target, user, reason=reason, stage_name=instance.current_stage_name)
    return await approvals_service.approve_indent(
        db, indent_id, body.items,
        f"Source moved to {indent.source_warehouse_name} and forwarded — {reason}", user,
    )
