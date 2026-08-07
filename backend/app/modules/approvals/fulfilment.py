"""Serving an indent from the approver's own stock, at the moment of approval.

This lives in approvals, not inventory, because it needs BOTH: `ind_indent_items` to
know what was asked for, and inventory to move the goods. Inventory is the base module
and may not import indents (rule 5), so the orchestration has to sit on this side of
the chain. The physical move still goes through `inventory.service.move_stock()` —
rule 7 holds, nothing here writes `stk_balance`.

The remainder is what makes the cascade work: a line is served as far as the current
approver can serve it, `allocated_qty` records how much, and the SAME indent travels
on carrying `approved − allocated`. No child documents.
"""
import logging
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.modules.indents.models import Indent, IndentItem
from app.modules.inventory import locations
from app.modules.inventory import service as inventory_service
from app.modules.inventory.models import NO_PROJECT, Stock
from app.platform.hcm.models import HcmPositionAssignment
from app.platform.settings.service import write_audit
from app.shared.enums import AuditAction, RefType

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
) -> dict[int, Decimal]:
    """Available (not reserved) quantity per point, for one item."""
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
    return {wid: qty for wid, qty in totals.items() if qty > 0}


async def _requester_point(db: AsyncSession, indent: Indent) -> int | None:
    """The LIP the raiser draws into — their own position's primary point."""
    position_id = (await db.execute(
        select(HcmPositionAssignment.position_id).where(
            HcmPositionAssignment.employee_id == indent.requested_by_id,
        ).limit(1)
    )).scalar_one_or_none()
    return await locations.primary_location_for(db, position_id)


async def availability_for_indent(db: AsyncSession, indent_id: int, user) -> dict:
    """Per line: what is still owed, and what this approver can cover from their
    own points. This is what puts "you have 10 of these" on the approval screen."""
    indent = (await db.execute(
        select(Indent).where(Indent.id == indent_id)
    )).scalars().first()
    if indent is None:
        raise NotFoundError("Indent not found")

    position_id = getattr(user, "active_position_id", None)
    my_points = await locations.location_ids_for_subtree(db, position_id)
    target = await _requester_point(db, indent)

    lines = (await db.execute(
        select(IndentItem).where(IndentItem.indent_id == indent_id)
        .order_by(IndentItem.line_no)
    )).scalars().all()

    out = []
    for line in lines:
        by_point = await _stock_at(db, line.item_id, my_points)
        owed = remainder_of(line)
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
            "remainder": float(owed),
            "available_at_my_points": float(on_hand),
            # What an Issue now would actually move: you cannot give more than is
            # owed, nor more than you hold.
            "issuable_now": float(min(owed, on_hand)),
            "sources": [
                {"warehouse_id": wid, "available_quantity": float(qty)}
                for wid, qty in sorted(by_point.items())
            ],
        })

    return {
        "indent_id": indent.id,
        "indent_no": indent.indent_no,
        "target_warehouse_id": target,
        "my_warehouse_ids": sorted(my_points),
        "items": out,
    }


async def issue_from_my_stock(
    db: AsyncSession, indent_id: int, requests: list, user, reason: str = "",
    forward_remainder: bool = False,
) -> dict:
    """Serve what this approver can, from their own point, right now.

    One line at a time, each an ISSUE (a tier drop), so it never needs the workflow
    engine: giving stock down your own chain is the holder's call. What is left stays
    on the line as remainder and travels up with the indent.
    """
    indent = (await db.execute(
        select(Indent).where(Indent.id == indent_id)
    )).scalars().first()
    if indent is None:
        raise NotFoundError("Indent not found")

    target = await _requester_point(db, indent)
    if target is None:
        raise ValidationError(
            "The requester's position is not tagged to a stocking point, so there is "
            "nowhere to issue into. Tag it under Inventory > Stocking Points.",
        )

    position_id = getattr(user, "active_position_id", None)
    my_points = await locations.location_ids_for_subtree(db, position_id)

    issued = []
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
        owed = remainder_of(line)
        if qty <= 0:
            raise ValidationError("Issue quantity must be positive")
        if qty > owed:
            raise ValidationError(
                f"{line.item_name or line.item_code}: only {owed} still owed on this line",
            )

        # Out of the approver's point, into the requester's. Two calls, because
        # move_stock is per location and the ledger must show both sides.
        await inventory_service.move_stock(
            db, item_id=line.item_id, qty=qty, direction="OUT",
            ref_type=RefType.ISSUE.value, ref_id=indent.id, ref_no=indent.indent_no,
            user=user, warehouse_id=source, project_id=NO_PROJECT,
        )
        await inventory_service.move_stock(
            db, item_id=line.item_id, qty=qty, direction="IN",
            ref_type=RefType.ISSUE.value, ref_id=indent.id, ref_no=indent.indent_no,
            user=user, warehouse_id=target, project_id=NO_PROJECT,
        )

        before = float(_d(line.allocated_quantity))
        line.allocated_quantity = _d(line.allocated_quantity) + qty
        issued.append({
            "line_id": line.id,
            "item_name": line.item_name or line.item_code,
            "quantity": float(qty),
            "from_warehouse_id": source,
            "to_warehouse_id": target,
            "remainder": float(remainder_of(line)),
        })

        await write_audit(
            db, entity="ind_indent_items", entity_id=indent.id,
            entity_no=indent.indent_no, action=AuditAction.UPDATE, actor=user,
            before={f"line_{line.id}_allocated_qty": before},
            after={f"line_{line.id}_allocated_qty": float(_d(line.allocated_quantity))},
            summary=(f"Issued {qty} from point {source} to {target}"
                     + (f" — {reason}" if reason else "")),
        )

    await db.commit()

    remaining = (await db.execute(
        select(IndentItem).where(IndentItem.indent_id == indent_id)
    )).scalars().all()
    outstanding = sum((remainder_of(line) for line in remaining), Decimal("0"))

    # Hand the rest upward. The approved quantities are passed through untouched —
    # this approver already decided them, and issuing is not a second decision — so
    # the next rung inherits exactly the remainder. The engine owns the advance
    # (rule 8); nothing here moves the document itself.
    forwarded = False
    if forward_remainder and outstanding > 0:
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
            (f"Issued from own stock. {outstanding} still owed."
             + (f" {reason}" if reason else "")),
            user,
        )
        forwarded = True

    return {
        "indent_id": indent_id,
        "issued": issued,
        "outstanding_quantity": float(outstanding),
        # Nothing left owed anywhere: the indent has no reason to climb further.
        "fully_served": outstanding == 0,
        "forwarded": forwarded,
    }
