"""Project Lots — set stock aside for one project (Stock Segregation tab, 2026-10-06).

Stock bought for a project is received, inspected and put away into the shared pool
like everything else, and the pool is deliberately shared (`availability.
candidate_stock`). Sometimes that is wrong: the lot was bought for project 104 and
nobody else may have it. A HOLD says so.

How it stays out of everybody else's hands without every screen knowing about it:
the held quantity moves `available_qty -> reserved_qty` through
`inventory.allocation.hold` with an `inv_reservations` row (ref_type PROJECT_HOLD).
Every reader of `available_qty` — the fulfilment desk, the issue pickers, the "free"
figures — stops offering it with no change of its own. Named units are stamped
`Held for project <id> by hold <id>`, a claimed prefix, so every unit picker skips
them too.

Only the owning project reads it back:
  * the fulfilment desk (`allocations.propose / create / _free_by_point`) counts the
    project's held lots as free for that project's indents, and approval
    (`allocation.reserve`) MOVES the hold onto the indent's reservation, held lots first;
  * a material issue naming the project (`issue_stock_sources`, `_assert_issue_sources`,
    `post_issue`) treats them as its own, the same as an indent's reservation;
  * a held serial may be named only on an issue of that project.

An issue with no project cannot draw a held lot. Another project's urgent need is
served by LENDING the lot (release with a named project and a reason, behind its own
permission) — never silently.
"""
from decimal import Decimal

from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
from app.modules.inventory import allocation as stock_allocation
from app.modules.inventory.models import NO_BATCH, NO_BIN, ProjectHold, Stock
from app.modules.inventory.service import warehouse_ids_for_user
from app.modules.warehouse import models as m
from app.modules.warehouse import schemas as s
from app.modules.warehouse.enums import SerialStatus
from app.modules.warehouse.service import (
    PROJECT_HOLD_UNIT_PREFIX, _CLAIMED_REMARK_PREFIXES, _location_index,
    _set_unit_fields, project_hold_unit_marker,
)
from app.platform.settings.service import write_audit
from app.shared.enums import AuditAction, ProjectHoldStatus
from app.shared.models.base import utcnow
from app.shared.models.master import Item, Project
from app.shared.numbering import next_number
from app.shared.scope import scope_condition

ZERO = Decimal("0")


def _d(value) -> Decimal:
    return Decimal(str(value or 0))


def _name(user) -> str | None:
    return getattr(user, "full_name", None) or getattr(user, "name", None)


async def _warehouse_scope(db: AsyncSession, user, col):
    return await scope_condition(db, user, warehouse_col=col,
                                 warehouse_ids=await warehouse_ids_for_user(db, user))


# ---------------------------------------------------------------- reads

async def list_lots(db: AsyncSession, params: PageParams, user, *,
                    warehouse_id: int | None = None, item_id: int | None = None,
                    search: str | None = None, held: str | None = None) -> dict:
    """Every lot on the shelf — item x location x batch — with what is held on it.

    `held`: "held" narrows to lots carrying an active hold, "free" to lots with
    something still free to hold."""
    active = (
        select(ProjectHold.stock_id.label("stock_id"),
               func.sum(ProjectHold.quantity).label("held_qty"))
        .where(ProjectHold.status == ProjectHoldStatus.ACTIVE.value)
        .group_by(ProjectHold.stock_id).subquery()
    )
    stmt = (
        select(Stock, func.coalesce(active.c.held_qty, 0).label("held_qty"))
        .outerjoin(active, active.c.stock_id == Stock.id)
        .where(Stock.total_qty > 0, await _warehouse_scope(db, user, Stock.warehouse_id))
    )
    if warehouse_id:
        stmt = stmt.where(Stock.warehouse_id == warehouse_id)
    if item_id:
        stmt = stmt.where(Stock.item_id == item_id)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(Stock.item_code.ilike(like), Stock.item_name.ilike(like),
                              Stock.batch_no.ilike(like), Stock.bin_code.ilike(like),
                              Stock.project_name.ilike(like),
                              exists().where(_lot_of_stock(), m.PutawayTask.lot_no.ilike(like))))
    if held == "held":
        stmt = stmt.where(active.c.held_qty > 0)
    elif held == "free":
        stmt = stmt.where(Stock.available_qty > 0)

    # Ordered by the primary key (see CLAUDE.md: stk_balance carries a JSON column).
    page = await paginate(db, stmt.order_by(Stock.id.desc()), params)
    rows = page["items"]
    # paginate() scalars() the first column; read the held figure separately.
    stock_ids = [row.id for row in rows]
    holds_by_stock: dict[int, list[dict]] = {}
    if stock_ids:
        for ph in (await db.execute(
            select(ProjectHold).where(ProjectHold.stock_id.in_(stock_ids),
                                      ProjectHold.status == ProjectHoldStatus.ACTIVE.value)
            .order_by(ProjectHold.id)
        )).scalars():
            holds_by_stock.setdefault(ph.stock_id, []).append({
                "id": ph.id, "hold_no": ph.hold_no, "project_id": ph.project_id,
                "project_name": ph.project_name, "quantity": _d(ph.quantity),
                "serial_count": len(ph.serial_numbers or []),
            })
    tracked = {}
    if rows:
        tracked = {i.id: (bool(i.is_serial_tracked) or bool(i.is_imei_tracked))
                   for i in (await db.execute(
                       select(Item).where(Item.id.in_({r.item_id for r in rows}))
                   )).scalars()}
    lots = await _lot_numbers(db, rows)
    # Where each lot sits, walked up the location tree: one read per warehouse on the
    # page, derived on the way out (a stored path goes stale on a re-parent).
    trees = {wh: await _location_index(db, wh) for wh in {r.warehouse_id for r in rows}}

    def location_path(r) -> str:
        node = trees.get(r.warehouse_id, {}).get(r.bin_id) if r.bin_id else None
        tail = node["path"] if node else "bulk"
        return f"{r.warehouse_name or 'Warehouse'} / {tail}"

    # How each lot is bagged (2026-10-08) — one read for the page.
    from app.modules.warehouse.packing import pack_summary
    packed = {row["stock_id"]: row for row in await pack_summary(db, [
        {"item_id": r.item_id, "warehouse_id": r.warehouse_id, "bin_id": r.bin_id or 0,
         "batch_id": r.batch_id or 0, "project_id": r.project_id or 0,
         "total_qty": r.total_qty, "uom_code": r.uom_code, "stock_id": r.id}
        for r in rows])} if rows else {}

    page["items"] = [{
        "project_id": r.project_id or None,
        "pack_text": (packed.get(r.id) or {}).get("pack_text"),
        "packs": (packed.get(r.id) or {}).get("packs") or [],
        "loose_qty": (packed.get(r.id) or {}).get("loose_qty"),
        "pack_unreconciled": bool((packed.get(r.id) or {}).get("unreconciled")),
        "pack_below_min": int((packed.get(r.id) or {}).get("below_min") or 0),
        "pack_part_packs": int((packed.get(r.id) or {}).get("part_packs") or 0),
        "location_path": location_path(r),
        "stock_id": r.id, "item_id": r.item_id, "item_code": r.item_code,
        "lot_nos": lots.get((r.item_id, r.warehouse_id, r.bin_id or 0, r.batch_id or 0), []),
        "item_name": r.item_name, "uom_code": r.uom_code,
        "warehouse_id": r.warehouse_id, "warehouse_name": r.warehouse_name,
        "bin_id": r.bin_id or None, "bin_code": r.bin_code,
        "batch_id": r.batch_id or None, "batch_no": r.batch_no,
        "expiry_date": r.expiry_date,
        "received_for_project": r.project_name,
        "total_qty": _d(r.total_qty), "available_qty": _d(r.available_qty),
        "reserved_qty": _d(r.reserved_qty),
        "held_qty": sum((h["quantity"] for h in holds_by_stock.get(r.id, [])), ZERO),
        "holds": holds_by_stock.get(r.id, []),
        "is_unit_tracked": tracked.get(r.item_id, False),
    } for r in rows]
    return page


def _lot_of_stock():
    """A put-away task that landed goods on THIS balance row (item, point, bin, batch).

    The lot number is stamped on the task at confirm (`_next_lot_no`) and names where
    the stock came to rest; a balance row is fed by every task that landed there, so a
    row can carry several lots."""
    return and_(m.PutawayTask.item_id == Stock.item_id,
                m.PutawayTask.warehouse_id == Stock.warehouse_id,
                func.coalesce(m.PutawayTask.actual_bin_id, 0) == Stock.bin_id,
                func.coalesce(m.PutawayTask.batch_id, 0) == Stock.batch_id,
                m.PutawayTask.lot_no.is_not(None))


async def _lot_numbers(db: AsyncSession, rows) -> dict[tuple, list[str]]:
    """Lot numbers per balance row on the page, in one query."""
    if not rows:
        return {}
    out: dict[tuple, list[str]] = {}
    for item_id, warehouse_id, bin_id, batch_id, lot_no in (await db.execute(
        select(m.PutawayTask.item_id, m.PutawayTask.warehouse_id,
               m.PutawayTask.actual_bin_id, m.PutawayTask.batch_id, m.PutawayTask.lot_no)
        .where(m.PutawayTask.item_id.in_({r.item_id for r in rows}),
               m.PutawayTask.warehouse_id.in_({r.warehouse_id for r in rows}),
               m.PutawayTask.lot_no.is_not(None))
        .order_by(m.PutawayTask.id)
    )).all():
        key = (int(item_id), int(warehouse_id), int(bin_id or 0), int(batch_id or 0))
        if lot_no not in out.setdefault(key, []):
            out[key].append(lot_no)
    return out


async def list_holds(db: AsyncSession, params: PageParams, user, *,
                     status: str | None = None, project_id: int | None = None,
                     warehouse_id: int | None = None, search: str | None = None) -> dict:
    stmt = select(ProjectHold).where(
        await _warehouse_scope(db, user, ProjectHold.warehouse_id))
    if status:
        stmt = stmt.where(ProjectHold.status == status)
    if project_id:
        stmt = stmt.where(ProjectHold.project_id == project_id)
    if warehouse_id:
        stmt = stmt.where(ProjectHold.warehouse_id == warehouse_id)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(ProjectHold.hold_no.ilike(like),
                              ProjectHold.item_code.ilike(like),
                              ProjectHold.item_name.ilike(like),
                              ProjectHold.batch_no.ilike(like),
                              ProjectHold.project_name.ilike(like)))
    page = await paginate(db, stmt.order_by(ProjectHold.id.desc()), params)
    rows = page["items"]
    if rows:
        tracked = {i.id: (bool(i.is_serial_tracked) or bool(i.is_imei_tracked))
                   for i in (await db.execute(
                       select(Item).where(Item.id.in_({r.item_id for r in rows}))
                   )).scalars()}
        for row in rows:
            setattr(row, "is_unit_tracked", tracked.get(row.item_id, False))
    return page


async def _get(db: AsyncSession, hold_id: int, user) -> ProjectHold:
    ph = (await db.execute(
        select(ProjectHold).where(ProjectHold.id == hold_id,
                                  await _warehouse_scope(db, user, ProjectHold.warehouse_id))
        .with_for_update()
    )).scalar_one_or_none()
    if ph is None:
        raise NotFoundError(f"Project hold {hold_id} not found")
    return ph


# ---------------------------------------------------------------- units

def _named(values: list[str]):
    return or_(m.SerialNumber.serial_number.in_(values), m.SerialNumber.imei.in_(values),
               m.SerialNumber.asset_code.in_(values),
               m.SerialNumber.consumable_code.in_(values))


async def _units_on_lot(db: AsyncSession, stock: Stock, values: list[str],
                        *, marker: str | None) -> list[m.SerialNumber]:
    """The named units, each checked to be on THIS lot and free (or held by `marker`)."""
    values = list(dict.fromkeys(v.strip() for v in values if v and v.strip()))
    if not values:
        return []
    rows = (await db.execute(
        select(m.SerialNumber).where(
            m.SerialNumber.item_id == stock.item_id,
            m.SerialNumber.warehouse_id == stock.warehouse_id,
            m.SerialNumber.is_active.is_(True),
            _named(values),
        ).with_for_update()
    )).scalars().all()
    found = {}
    for row in rows:
        for key in (row.serial_number, row.imei, row.asset_code, row.consumable_code):
            if key:
                found.setdefault(key, row)
    out = []
    for value in values:
        row = found.get(value)
        if row is None:
            raise ValidationError(f"{value} is not a unit of {stock.item_code} here")
        if (row.bin_id or NO_BIN) != (stock.bin_id or NO_BIN) or \
                (row.batch_id or NO_BATCH) != (stock.batch_id or NO_BATCH):
            raise ValidationError(f"{value} is not in this lot's batch and location")
        if marker is not None:
            if row.remarks != marker:
                raise ValidationError(f"{value} is not held by this hold")
        else:
            if row.status != SerialStatus.AVAILABLE.value:
                raise ValidationError(f"{value} is {row.status}, not available")
            if row.remarks and row.remarks.startswith(_CLAIMED_REMARK_PREFIXES):
                raise ValidationError(f"{value} is already held by a document or project")
        out.append(row)
    return out


# ---------------------------------------------------------------- writes

async def create_hold(db: AsyncSession, data: s.ProjectHoldCreate, user) -> ProjectHold:
    stock = (await db.execute(
        select(Stock).where(Stock.id == data.stock_id,
                            await _warehouse_scope(db, user, Stock.warehouse_id))
    )).scalar_one_or_none()
    if stock is None:
        raise NotFoundError(f"Lot {data.stock_id} not found")
    project = await db.get(Project, data.project_id)
    if project is None or not project.is_active:
        raise ValidationError("Pick an active project to hold this lot for")
    qty = _d(data.quantity)
    units = await _units_on_lot(db, stock, data.serial_numbers or [], marker=None)
    if units and len(units) != qty:
        raise ValidationError(
            f"{len(units)} units named for a hold of {qty} — name one unit per unit "
            "held, or none to hold the quantity only")

    ph = ProjectHold(
        hold_no=await next_number(db, "project_hold", project=project.name),
        stock_id=stock.id, item_id=stock.item_id, item_code=stock.item_code,
        item_name=stock.item_name, warehouse_id=stock.warehouse_id,
        warehouse_name=stock.warehouse_name, bin_id=stock.bin_id or NO_BIN,
        bin_code=stock.bin_code, batch_id=stock.batch_id or NO_BATCH,
        batch_no=stock.batch_no, project_id=project.id, project_name=project.name,
        held_qty=qty, quantity=qty,
        serial_numbers=[u.serial_number for u in units] or None,
        reason=data.reason, status=ProjectHoldStatus.ACTIVE.value,
        created_by_id=getattr(user, "id", None), created_by_name=_name(user),
    )
    db.add(ph)
    await db.flush()
    await stock_allocation.hold(db, stock.id, qty, ph.id, ph.hold_no, user)
    if units:
        await _set_unit_fields(db, [u.id for u in units],
                               remarks=project_hold_unit_marker(project.id, ph.id))
    await write_audit(db, entity="stk_project_holds", entity_id=ph.id,
                      entity_no=ph.hold_no, action=AuditAction.CREATE, actor=user,
                      after={"project": project.name, "item": stock.item_code,
                             "batch": stock.batch_no, "bin": stock.bin_code,
                             "quantity": str(qty), "units": len(units),
                             "reason": data.reason})
    await db.commit()
    await db.refresh(ph)
    return ph


async def release_hold(db: AsyncSession, hold_id: int, data: s.ProjectHoldRelease,
                       user, *, lend: bool = False) -> dict:
    """Release some or all of a hold by MOVING it to another location — a Stock
    Movement Order, through that order's own ladder, inspection and completion
    (`service.raise_hold_release_order`). The hold is reduced when the order
    completes; until then it shows the release in flight, and a rejected order leaves
    it as it was. `lend` names the project whose urgent need it serves, behind its own
    permission at the router."""
    from app.modules.warehouse.service import raise_hold_release_order

    ph = await _get(db, hold_id, user)
    if ph.status != ProjectHoldStatus.ACTIVE.value:
        raise ValidationError(f"{ph.hold_no} is {ph.status}; nothing is held")
    if ph.release_order_id:
        raise ValidationError(
            f"{ph.hold_no} is already being released by {ph.release_order_no}. "
            "Complete or reject that movement order first.")
    qty = _d(data.quantity) if data.quantity is not None else _d(ph.quantity)
    if qty <= ZERO or qty > _d(ph.quantity):
        raise ValidationError(f"Release between 0 and {_d(ph.quantity)}")
    if lend:
        if not data.for_project_id:
            raise ValidationError("Name the project this lot is being lent to")
        lent_to = await db.get(Project, data.for_project_id)
        if lent_to is None:
            raise ValidationError("That project does not exist")
        if lent_to.id == ph.project_id:
            raise ValidationError("A lot cannot be lent to the project holding it")
        ph.pending_lend_project_id = lent_to.id
        ph.pending_lend_project_name = lent_to.name
    ph.pending_release_reason = data.reason
    order = await raise_hold_release_order(
        db, ph, quantity=qty, serial_numbers=data.serial_numbers,
        destination_bin_id=data.destination_bin_id, reason=data.reason, user=user)
    await db.refresh(ph)
    return {"hold": ph, "order_no": order.get("order_no") or order.get("sto_no"),
            "order_status": order.get("status")}


async def clear_spent_unit_stamps(db: AsyncSession, project_id: int | None,
                                  item_ids) -> None:
    """Units still stamped by a hold that has since been USED or RELEASED are free
    again. A hold drawn down by its project's allocation cannot reach the serial table
    (inventory sits below warehouse), so the stamp is cleared here, after posting."""
    item_ids = {int(i) for i in (item_ids or []) if i}
    if not project_id or not item_ids:
        return
    rows = (await db.execute(
        select(m.SerialNumber.id, m.SerialNumber.remarks).where(
            m.SerialNumber.item_id.in_(item_ids),
            m.SerialNumber.remarks.like(f"{PROJECT_HOLD_UNIT_PREFIX}{project_id} %"))
    )).all()
    if not rows:
        return
    hold_ids = {}
    for unit_id, remarks in rows:
        try:
            hold_ids.setdefault(int(remarks.rsplit(" ", 1)[-1]), []).append(unit_id)
        except ValueError:
            continue
    live = set((await db.execute(
        select(ProjectHold.id).where(ProjectHold.id.in_(hold_ids),
                                     ProjectHold.status == ProjectHoldStatus.ACTIVE.value)
    )).scalars().all())
    spent = [u for hid, units in hold_ids.items() if hid not in live for u in units]
    if spent:
        await _set_unit_fields(db, spent, remarks=None)
