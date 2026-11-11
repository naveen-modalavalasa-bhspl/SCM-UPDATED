"""Stock Corrections (2026-10-01) — edit what held stock IS, after a signature.

A storekeeper finds a batch number keyed wrong at receipt, an expiry off by a year, a
handset whose IMEI was scanned into the serial box. None of that is a quantity, so a
stock audit cannot fix it, and every later issue, FEFO pick, recall and warranty
claim reads those fields. So a correction is a DOCUMENT:

  raise (lines of {field: new value}, the old value read by the server)
    -> STOCK_EDIT ladder (Settings > Approvals Config, per project)
    -> on the final approval the batch / unit rows are rewritten.

Two targets, because they are two different facts:

  BATCH  `stk_batches` — batch no., mfg date, expiry. Changes every unit of the lot,
         and the `stk_balance` snapshots (`batch_no`, `expiry_date`) with it.
  UNIT   `whs_serial_numbers` — one physical unit's serial, IMEI, asset / consumable
         code and lot.

Nothing moves: quantities, reservations and `stk_ledger` are untouched (the ledger is
append-only history and keeps the identity each movement carried at the time).

Approval mirrors the stock audit: a configured ladder decides (NO_APPROVAL posts at
once); with none configured, one holder of `stock.edit.approve` who is not the raiser.
At approval every line is re-checked against the live row — a value that changed
since the request was raised is refused, never silently overwritten.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.platform.doc_numbering import scope as org_scope
from app.core.exceptions import NotFoundError, PermissionError_, ValidationError
from app.core.pagination import PageParams
from app.modules.inventory import service as inv_service
from app.modules.inventory.models import Stock
from app.modules.warehouse import models as m
from app.modules.warehouse.enums import (
    STOCK_EDIT_FIELDS, SerialStatus, StockEditStatus, StockEditTarget,
)
from app.platform.rbac import permissions as perms
from app.platform.rbac.service import get_user_permissions
from app.platform.settings.service import write_audit
from app.platform.workflow import engine
from app.shared.enums import ApprovalAction, AuditAction, DocType, InstanceStatus
from app.shared.models.base import utcnow
from app.shared.models.master import Item
from app.shared.numbering import next_number
from app.shared.scope import scope_condition

DOC = DocType.STOCK_EDIT.value
DATE_FIELDS = {"mfg_date", "expiry_date"}
#: A unit that has left the point is not "held stock" any more; its identity belongs
#: to whoever received it and is corrected there.
_GONE = (SerialStatus.ISSUED.value, SerialStatus.CONSUMED.value,
         SerialStatus.SCRAPPED.value)
_PLACEHOLDER = "~PENDING-"


# --------------------------------------------------------------------------- #
# What can be corrected
# --------------------------------------------------------------------------- #

async def _visible_warehouse(db: AsyncSession, warehouse_id: int, user) -> m.Warehouse:
    warehouse = await db.get(m.Warehouse, warehouse_id)
    if warehouse is None:
        raise NotFoundError(f"Warehouse {warehouse_id} not found")
    visible = await inv_service.warehouse_ids_for_user(db, user)
    if visible is not None and warehouse_id not in visible:
        raise PermissionError_(f"{warehouse.name} is outside the stock you can see")
    return warehouse


async def _pending_targets(db: AsyncSession, target: str, ids: list[int]) -> dict[int, str]:
    """{target id: edit no.} for every id already on a correction awaiting approval."""
    if not ids:
        return {}
    col = m.StockEditItem.batch_id if target == StockEditTarget.BATCH.value \
        else m.StockEditItem.serial_id
    rows = (await db.execute(
        select(col, m.StockEdit.edit_no)
        .join(m.StockEdit, m.StockEdit.id == m.StockEditItem.edit_id)
        .where(m.StockEdit.status == StockEditStatus.PENDING_APPROVAL.value,
               m.StockEditItem.target_type == target, col.in_(ids))
    )).all()
    return {r[0]: r[1] for r in rows}


async def list_items(db: AsyncSession, params: PageParams, warehouse_id: int, user, *,
                     search: str | None = None) -> dict:
    """One row per item the point holds — the editor's first screen. How many units
    and batches sit behind each, so the buttons can say what they open, and the
    item's tracking flags, so the unit editor shows only the identifiers it carries."""
    await _visible_warehouse(db, warehouse_id, user)
    conds = [Stock.warehouse_id == warehouse_id]
    if search and search.strip():
        like = f"%{search.strip()}%"
        conds.append(or_(Item.code.like(like), Item.name.like(like)))
    base = (
        select(Item.id, Item.code, Item.name, Item.uom_code, Item.is_serial_tracked,
               Item.is_imei_tracked, Item.is_asset, Item.is_batch_tracked, Item.has_expiry,
               func.sum(Stock.total_qty).label("qty"),
               func.count(func.distinct(func.nullif(Stock.batch_id, 0))).label("batches"))
        .join(Item, Item.id == Stock.item_id)
        .where(*conds)
        .group_by(Item.id, Item.code, Item.name, Item.uom_code, Item.is_serial_tracked,
                  Item.is_imei_tracked, Item.is_asset, Item.is_batch_tracked, Item.has_expiry)
        .having(func.sum(Stock.total_qty) > 0)
    )
    total = await db.scalar(select(func.count()).select_from(base.subquery()))
    rows = (await db.execute(
        base.order_by(Item.code).offset(params.offset).limit(params.size))).all()
    ids = [r[0] for r in rows]
    units: dict[int, int] = {}
    if ids:
        units = dict((await db.execute(
            select(m.SerialNumber.item_id, func.count())
            .where(m.SerialNumber.item_id.in_(ids),
                   m.SerialNumber.warehouse_id == warehouse_id,
                   m.SerialNumber.is_active.is_(True),
                   m.SerialNumber.status.notin_(_GONE),
                   ~m.SerialNumber.serial_number.startswith(_PLACEHOLDER))
            .group_by(m.SerialNumber.item_id))).all())
    items = [{
        "item_id": r[0], "item_code": r[1], "item_name": r[2], "uom_code": r[3],
        "is_serial_tracked": bool(r[4]), "is_imei_tracked": bool(r[5]),
        "is_asset": bool(r[6]), "is_batch_tracked": bool(r[7]), "has_expiry": bool(r[8]),
        "qty": float(r[9] or 0), "batch_count": int(r[10] or 0),
        "unit_count": int(units.get(r[0], 0)),
    } for r in rows]
    return {"items": items, "total": total or 0, "page": params.page, "size": params.size}


async def list_units(db: AsyncSession, params: PageParams, warehouse_id: int, user, *,
                     search: str | None = None, item_id: int | None = None) -> dict:
    """Every physical unit still held at the point, one row each, with its batch.
    Ordered by id: `whs_serial_numbers` is the largest table in the schema and an
    indexed order is a scan, not a sort."""
    await _visible_warehouse(db, warehouse_id, user)
    conds = [m.SerialNumber.warehouse_id == warehouse_id,
             m.SerialNumber.is_active.is_(True),
             m.SerialNumber.status.notin_(_GONE),
             ~m.SerialNumber.serial_number.startswith(_PLACEHOLDER)]
    if item_id:
        conds.append(m.SerialNumber.item_id == item_id)
    if search and search.strip():
        like = f"%{search.strip()}%"
        conds.append(or_(
            m.SerialNumber.serial_number.like(like), m.SerialNumber.imei.like(like),
            m.SerialNumber.asset_code.like(like), m.SerialNumber.consumable_code.like(like),
            m.SerialNumber.lot_no.like(like), Item.code.like(like), Item.name.like(like),
            m.Batch.batch_no.like(like),
        ))
    base = (
        select(m.SerialNumber, Item.code, Item.name, m.Batch.batch_no,
               m.Batch.mfg_date, m.Batch.expiry_date)
        .join(Item, Item.id == m.SerialNumber.item_id)
        .outerjoin(m.Batch, m.Batch.id == m.SerialNumber.batch_id)
        .where(*conds)
    )
    total = await db.scalar(select(func.count()).select_from(base.subquery()))
    rows = (await db.execute(
        base.order_by(m.SerialNumber.id.desc()).offset(params.offset).limit(params.size)
    )).all()
    pending = await _pending_targets(db, StockEditTarget.UNIT.value, [r[0].id for r in rows])
    batch_ids = {r[0].batch_id for r in rows if r[0].batch_id}
    batch_qty: dict[int, float] = {}
    if batch_ids:
        batch_qty = {b: float(q or 0) for b, q in (await db.execute(
            select(Stock.batch_id, func.sum(Stock.total_qty))
            .where(Stock.warehouse_id == warehouse_id, Stock.batch_id.in_(batch_ids))
            .group_by(Stock.batch_id))).all()}
    items = [{
        "id": u.id, "item_id": u.item_id, "item_code": code, "item_name": name,
        "serial_number": u.serial_number, "imei": u.imei, "asset_code": u.asset_code,
        "consumable_code": u.consumable_code, "lot_no": u.lot_no, "status": u.status,
        "batch_id": u.batch_id, "batch_no": batch_no, "mfg_date": mfg,
        "expiry_date": expiry, "batch_qty": batch_qty.get(u.batch_id),
        "pending_edit_no": pending.get(u.id),
    } for u, code, name, batch_no, mfg, expiry in rows]
    return {"items": items, "total": total or 0, "page": params.page, "size": params.size}


async def list_batches(db: AsyncSession, params: PageParams, warehouse_id: int, user, *,
                       search: str | None = None, item_id: int | None = None) -> dict:
    """Every batch the point holds stock of, with how much."""
    await _visible_warehouse(db, warehouse_id, user)
    held = (
        select(Stock.batch_id, func.sum(Stock.total_qty).label("qty"))
        .where(Stock.warehouse_id == warehouse_id, Stock.batch_id != 0)
        .group_by(Stock.batch_id)
        .having(func.sum(Stock.total_qty) > 0)
        .subquery()
    )
    conds = []
    if item_id:
        conds.append(m.Batch.item_id == item_id)
    if search and search.strip():
        like = f"%{search.strip()}%"
        conds.append(or_(m.Batch.batch_no.like(like), Item.code.like(like),
                         Item.name.like(like)))
    base = (
        select(m.Batch, Item.code, Item.name, Item.uom_code, held.c.qty)
        .join(held, held.c.batch_id == m.Batch.id)
        .join(Item, Item.id == m.Batch.item_id)
        .where(*conds)
    )
    total = await db.scalar(select(func.count()).select_from(base.subquery()))
    rows = (await db.execute(
        base.order_by(m.Batch.id.desc()).offset(params.offset).limit(params.size)
    )).all()
    pending = await _pending_targets(db, StockEditTarget.BATCH.value, [r[0].id for r in rows])
    items = [{
        "id": b.id, "item_id": b.item_id, "item_code": code, "item_name": name,
        "uom_code": uom, "batch_no": b.batch_no, "mfg_date": b.mfg_date,
        "expiry_date": b.expiry_date, "qty": float(qty or 0), "grn_no": b.grn_no,
        "pending_edit_no": pending.get(b.id),
    } for b, code, name, uom, qty in rows]
    return {"items": items, "total": total or 0, "page": params.page, "size": params.size}


# --------------------------------------------------------------------------- #
# Validation, shared by raise and approve
# --------------------------------------------------------------------------- #

def _norm(field: str, value):
    """The value as stored: a date for a date field, a trimmed string or None."""
    if value is None:
        return None
    if field in DATE_FIELDS:
        if isinstance(value, date):
            return value
        text = str(value).strip()
        if not text:
            return None
        try:
            return date.fromisoformat(text[:10])
        except ValueError:
            raise ValidationError(f"{field.replace('_', ' ')} {text!r} is not a date")
    text = str(value).strip()
    return text or None


def _show(value) -> str | None:
    return value.isoformat() if isinstance(value, date) else value


async def _load_target(db: AsyncSession, target: str, target_id: int, warehouse_id: int):
    """The batch or unit row, refused unless it is held at this point."""
    if target == StockEditTarget.UNIT.value:
        unit = await db.get(m.SerialNumber, target_id, with_for_update=True)
        if unit is None or unit.warehouse_id != warehouse_id or not unit.is_active \
                or unit.status in _GONE:
            raise ValidationError(f"Unit {target_id} is not held at this warehouse")
        return unit
    batch = await db.get(m.Batch, target_id, with_for_update=True)
    held = await db.scalar(
        select(func.coalesce(func.sum(Stock.total_qty), 0))
        .where(Stock.warehouse_id == warehouse_id, Stock.batch_id == target_id))
    if batch is None or not held or held <= 0:
        raise ValidationError(f"Batch {target_id} is not held at this warehouse")
    return batch


async def _check_values(db: AsyncSession, target: str, row, new: dict) -> None:
    """The rules a corrected value must meet, read against the row as it would be."""
    after = {f: new.get(f, getattr(row, f)) for f in STOCK_EDIT_FIELDS[target]}
    label = getattr(row, "serial_number", None) or getattr(row, "batch_no", None)
    if target == StockEditTarget.BATCH.value:
        if "batch_no" in new and not after["batch_no"]:
            raise ValidationError(f"Batch {label}: the batch number cannot be blank")
        if after["mfg_date"] and after["expiry_date"] \
                and after["mfg_date"] > after["expiry_date"]:
            raise ValidationError(f"Batch {label}: manufactured after it expires")
        if after["mfg_date"] and after["mfg_date"] > date.today():
            raise ValidationError(f"Batch {label}: manufacturing date is in the future")
        if "batch_no" in new:
            clash = await db.scalar(select(m.Batch.id).where(
                m.Batch.item_id == row.item_id, m.Batch.batch_no == after["batch_no"],
                m.Batch.id != row.id).limit(1))
            if clash:
                raise ValidationError(
                    f"Batch {after['batch_no']} already exists for this item")
        return
    if "serial_number" in new:
        if not after["serial_number"]:
            raise ValidationError(f"Unit {label}: the serial number cannot be blank")
        # The column is UNIQUE across the table, so the check is too.
        clash = await db.scalar(select(m.SerialNumber.id).where(
            m.SerialNumber.serial_number == after["serial_number"],
            m.SerialNumber.id != row.id).limit(1))
        if clash:
            raise ValidationError(f"Serial {after['serial_number']} is already on another unit")
    if new.get("imei"):
        # No format rule: the live column holds SIM codes as well as handset IMEIs.
        imei = after["imei"]
        clash = await db.scalar(select(m.SerialNumber.id).where(
            m.SerialNumber.imei == imei, m.SerialNumber.is_active.is_(True),
            m.SerialNumber.id != row.id).limit(1))
        if clash:
            raise ValidationError(f"IMEI {imei} is already on another unit")
    for code_field in ("asset_code", "consumable_code"):
        if new.get(code_field):
            col = getattr(m.SerialNumber, code_field)
            clash = await db.scalar(select(m.SerialNumber.id).where(
                col == after[code_field], m.SerialNumber.id != row.id).limit(1))
            if clash:
                raise ValidationError(
                    f"{code_field.replace('_', ' ').title()} {after[code_field]} "
                    "is already on another unit")


# --------------------------------------------------------------------------- #
# Raise, decide, apply
# --------------------------------------------------------------------------- #

async def _ladder(db: AsyncSession, user):
    """The configured STOCK_EDIT chain for this raiser's project, or None."""
    from app.platform.workflow import ladder as wf_ladder

    position_id = getattr(user, "active_position_id", None)
    project_id, _name = await wf_ladder.project_for(db, position_id, user)
    raiser_role_id = await wf_ladder.role_of_position(db, position_id)
    return await wf_ladder.find_ladder(db, project_id, DOC, raiser_role_id)


def _mark_approved(edit: m.StockEdit, user) -> None:
    edit.status = StockEditStatus.APPROVED.value
    edit.approved_by_id = getattr(user, "id", None)
    edit.approved_by_name = getattr(user, "full_name", None)
    edit.approved_at = utcnow()
    edit.current_approver_name = None


async def _apply(db: AsyncSession, edit: m.StockEdit, user) -> None:
    """Write every line. Each `from` must still be the live value — a row somebody
    changed after the request was raised is refused rather than overwritten."""
    for line in edit.items:
        target_id = line.batch_id if line.target_type == StockEditTarget.BATCH.value \
            else line.serial_id
        row = await _load_target(db, line.target_type, target_id, edit.warehouse_id)
        new = {}
        for field, change in (line.changes or {}).items():
            live = _show(getattr(row, field))
            if live != change.get("from"):
                raise ValidationError(
                    f"{line.label}: {field.replace('_', ' ')} is now {live!r}, not "
                    f"{change.get('from')!r} as when {edit.edit_no} was raised. "
                    "Reject this correction and raise a fresh one.")
            new[field] = _norm(field, change.get("to"))
        await _check_values(db, line.target_type, row, new)
        for field, value in new.items():
            setattr(row, field, value)
        if line.target_type == StockEditTarget.BATCH.value and \
                ({"batch_no", "expiry_date"} & new.keys()):
            # The balance rows carry the batch's number and expiry as snapshots, and
            # FEFO and every stock screen read them there.
            for stock in (await db.execute(
                    select(Stock).where(Stock.batch_id == row.id))).scalars():
                stock.batch_no = row.batch_no
                stock.expiry_date = row.expiry_date
    await db.flush()


async def create_edit(db: AsyncSession, data, user) -> m.StockEdit:
    warehouse = await _visible_warehouse(db, data.warehouse_id, user)
    if not (data.reason or "").strip():
        raise ValidationError("Say why these values are being corrected")
    if not data.lines:
        raise ValidationError("Change at least one value before submitting")

    seen: set[tuple[str, int]] = set()
    built: list[m.StockEditItem] = []
    for line in data.lines:
        target = line.target_type
        if target not in STOCK_EDIT_FIELDS:
            raise ValidationError(f"Unknown target {target!r}")
        if (target, line.target_id) in seen:
            raise ValidationError("The same batch or unit is on this correction twice")
        seen.add((target, line.target_id))
        bad = set(line.changes) - set(STOCK_EDIT_FIELDS[target])
        if bad:
            raise ValidationError(f"{', '.join(sorted(bad))} cannot be corrected here")
        row = await _load_target(db, target, line.target_id, data.warehouse_id)
        new = {f: _norm(f, v) for f, v in line.changes.items()}
        new = {f: v for f, v in new.items() if v != getattr(row, f)}
        if not new:
            continue
        await _check_values(db, target, row, new)
        item = await db.get(Item, row.item_id)
        label = (f"Batch {row.batch_no}" if target == StockEditTarget.BATCH.value
                 else f"Unit {row.serial_number}")
        built.append(m.StockEditItem(
            target_type=target,
            batch_id=row.id if target == StockEditTarget.BATCH.value else None,
            serial_id=row.id if target == StockEditTarget.UNIT.value else None,
            item_id=row.item_id, item_code=getattr(item, "code", None),
            item_name=getattr(item, "name", None), label=label[:200],
            changes={f: {"from": _show(getattr(row, f)), "to": _show(v)}
                     for f, v in new.items()},
        ))
    if not built:
        raise ValidationError("Nothing differs from what is recorded — no correction to raise")
    for kind in (StockEditTarget.BATCH.value, StockEditTarget.UNIT.value):
        ids = [b.batch_id or b.serial_id for b in built if b.target_type == kind]
        clash = await _pending_targets(db, kind, ids)
        if clash:
            raise ValidationError(
                f"{len(clash)} of these is already on {', '.join(sorted(set(clash.values())))}, "
                "awaiting approval. Let that one be decided first.")

    # Whose paper it is on (2026-11-11): selected, opening on the default organisation.
    scope = await org_scope.resolve_free(db, data)
    edit = m.StockEdit(
        edit_no=await next_number(db, "stock_edit",
                                  **(org_scope.args_of(scope) if scope else {})),
        warehouse_id=warehouse.id, warehouse_name=warehouse.name,
        status=StockEditStatus.PENDING_APPROVAL.value,
        reason=data.reason.strip()[:500], remarks=data.remarks,
        created_by_id=getattr(user, "id", None),
        created_by_name=getattr(user, "full_name", None),
        items=built,
    )
    if scope:
        org_scope.stamp_with_project(edit, scope)
    db.add(edit)
    await db.flush()

    outcome = "for approval"
    if await _ladder(db, user) is not None:
        instance = await engine.start(db, DOC, edit.id, {
            "doc_no": edit.edit_no,
            "doc_summary": f"Stock correction {edit.edit_no} at {warehouse.name} "
                           f"({len(built)} line{'s' if len(built) != 1 else ''})",
            "requester_position_id": getattr(user, "active_position_id", None),
            "warehouse_id": edit.warehouse_id,
        }, user)
        if instance.status == InstanceStatus.APPROVED.value:
            _mark_approved(edit, user)
            await _apply(db, edit, user)
            outcome = "and approved by its chain"
        else:
            edit.current_approver_name = await engine.current_approver_label(db, DOC, edit.id)

    await write_audit(
        db, entity="whs_stock_edits", entity_id=edit.id, entity_no=edit.edit_no,
        action=AuditAction.CREATE, actor=user,
        after={"status": edit.status, "warehouse_id": edit.warehouse_id,
               "lines": [{"label": b.label, "changes": b.changes} for b in built]},
        summary=f"Stock correction {edit.edit_no} raised {outcome}",
    )
    await db.commit()
    return await get_edit(db, edit.id, user)


async def _can_act(db: AsyncSession, edit: m.StockEdit, user) -> bool:
    if user is None or edit.status != StockEditStatus.PENDING_APPROVAL.value:
        return False
    instance = await inv_service.engine_instance_for(db, DOC, edit.id)
    if instance is not None and instance.status == InstanceStatus.IN_PROGRESS.value:
        return await engine.can_act_now(db, DOC, edit.id, user)
    from app.platform.workflow.engine import is_workflow_admin
    if await is_workflow_admin(db, user):
        return True
    if getattr(user, "id", None) == edit.created_by_id:
        return False
    granted = await get_user_permissions(db, user, getattr(user, "active_position_id", None))
    return perms.STOCK_EDIT_APPROVE in granted


async def act_on_edit(db: AsyncSession, edit_id: int, action: str, user,
                      remarks: str | None = None) -> m.StockEdit:
    action = (action or "").upper()
    if action not in ("APPROVE", "REJECT"):
        raise ValidationError(f"Invalid action {action}")
    edit = (await db.execute(
        select(m.StockEdit).options(selectinload(m.StockEdit.items))
        .where(m.StockEdit.id == edit_id).with_for_update()
    )).scalar_one_or_none()
    if edit is None:
        raise NotFoundError(f"Stock correction {edit_id} not found")
    if edit.status != StockEditStatus.PENDING_APPROVAL.value:
        raise ValidationError(f"{edit.edit_no} is {edit.status}, it cannot change")
    if action == "REJECT" and not (remarks or "").strip():
        raise ValidationError("Say why the correction is rejected")

    before = {"status": edit.status}
    instance = await inv_service.engine_instance_for(db, DOC, edit.id)
    if instance is not None and instance.status == InstanceStatus.IN_PROGRESS.value:
        instance = await engine.act(
            db, DOC, edit.id,
            ApprovalAction.APPROVED.value if action == "APPROVE"
            else ApprovalAction.REJECTED.value,
            user, remarks or "", {"doc_no": edit.edit_no})
        if instance.status == InstanceStatus.APPROVED.value:
            _mark_approved(edit, user)
            await _apply(db, edit, user)
        elif instance.status == InstanceStatus.REJECTED.value:
            edit.status = StockEditStatus.REJECTED.value
            edit.current_approver_name = None
        else:
            edit.current_approver_name = await engine.current_approver_label(db, DOC, edit.id)
    else:
        from app.platform.workflow.engine import is_workflow_admin
        is_admin = await is_workflow_admin(db, user)
        if getattr(user, "id", None) == edit.created_by_id:
            raise PermissionError_(
                "You raised this correction, so you cannot approve or reject it. "
                "Ask another holder of stock-correction approval to action it.")
        granted = await get_user_permissions(
            db, user, getattr(user, "active_position_id", None))
        if not is_admin and perms.STOCK_EDIT_APPROVE not in granted:
            raise PermissionError_("You cannot approve stock corrections")
        if action == "APPROVE":
            _mark_approved(edit, user)
            await _apply(db, edit, user)
        else:
            edit.status = StockEditStatus.REJECTED.value

    if edit.status == StockEditStatus.REJECTED.value and remarks:
        who = getattr(user, "full_name", None) or "approver"
        note = f"[Rejected by {who}] {remarks}"
        edit.remarks = f"{edit.remarks}\n{note}" if edit.remarks else note

    await write_audit(
        db, entity="whs_stock_edits", entity_id=edit.id, entity_no=edit.edit_no,
        action=AuditAction.UPDATE, actor=user, before=before,
        after={"status": edit.status},
        summary=f"Stock correction {edit.edit_no} {edit.status.lower()}",
    )
    await db.commit()
    return await get_edit(db, edit.id, user)


# --------------------------------------------------------------------------- #
# Reads
# --------------------------------------------------------------------------- #

async def list_edits(db: AsyncSession, params: PageParams, user, *,
                     status: str | None = None, warehouse_id: int | None = None,
                     search: str | None = None, date_from: date | None = None,
                     date_to: date | None = None) -> dict:
    stmt = select(m.StockEdit)
    if status:
        stmt = stmt.where(m.StockEdit.status == status)
    if warehouse_id:
        stmt = stmt.where(m.StockEdit.warehouse_id == warehouse_id)
    if search and search.strip():
        like = f"%{search.strip()}%"
        stmt = stmt.where(or_(
            m.StockEdit.edit_no.like(like), m.StockEdit.created_by_name.like(like),
            m.StockEdit.id.in_(select(m.StockEditItem.edit_id).where(or_(
                m.StockEditItem.item_code.like(like), m.StockEditItem.item_name.like(like),
                m.StockEditItem.label.like(like)))),
        ))
    if date_from:
        stmt = stmt.where(m.StockEdit.created_at >= datetime.combine(date_from, datetime.min.time()))
    if date_to:
        stmt = stmt.where(m.StockEdit.created_at < datetime.combine(
            date_to + timedelta(days=1), datetime.min.time()))
    stmt = stmt.where(await scope_condition(
        db, user, owner_col=m.StockEdit.created_by_id,
        warehouse_col=m.StockEdit.warehouse_id,
        warehouse_ids=await inv_service.warehouse_ids_for_user(db, user)))
    total = await db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = (await db.execute(
        stmt.order_by(m.StockEdit.id.desc()).offset(params.offset).limit(params.size)
    )).scalars().all()
    return {"items": rows, "total": total or 0, "page": params.page, "size": params.size}


async def get_edit(db: AsyncSession, edit_id: int, user) -> m.StockEdit:
    edit = (await db.execute(
        select(m.StockEdit).options(selectinload(m.StockEdit.items))
        .where(m.StockEdit.id == edit_id)
    )).scalar_one_or_none()
    if edit is None:
        raise NotFoundError(f"Stock correction {edit_id} not found")
    visible = await inv_service.warehouse_ids_for_user(db, user)
    on_ladder = await inv_service.engine_instance_for(db, DOC, edit.id) is not None \
        and await engine.can_act_now(db, DOC, edit.id, user)
    if visible is not None and edit.warehouse_id not in visible \
            and edit.created_by_id != getattr(user, "id", None) and not on_ladder:
        raise PermissionError_(f"{edit.warehouse_name} is outside the stock you can see")
    edit.can_act = await _can_act(db, edit, user)
    return edit


async def approver_in_reach(db: AsyncSession, request, user) -> bool:
    """An approver may open a correction without the view code: `get_edit` still
    checks the warehouse, the raiser and the ladder before returning it."""
    return True
