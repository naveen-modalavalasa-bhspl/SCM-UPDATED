"""The consolidated buying sheet — doc B7.

Forty requisitions arrive in a month, most asking for the same forty items. Tendering
them one at a time buys the same bandage nine times at nine prices and gives the CPO
nothing to look at but a list. This module rolls a set of approved requisitions into
ONE document, item-wise, that the CPO and the SCM Head sign once and the RFQs are then
raised against.

Split out of `service.py` for the same reason `logistics/transport.py` is: that file
is already the PO/RFQ/quotation/vendor-portal surface, and this is a distinct document
with its own lifecycle. `service.py` re-exports the public names so the router keeps
one import site.

Aggregation rule: **one line per (item, uom)**, never per requisition. Two requisitions
asking for the same item in different units are genuinely different lines — 5 boxes and
5 pieces do not add up, and silently summing them is how a tender goes out for the
wrong quantity. Everything else about a line is the sum.
"""
import logging
from collections import OrderedDict, defaultdict
from datetime import date
from decimal import Decimal
import json

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
from app.shared.scope import scope_condition
from app.modules.procurement.models import (
    PurchaseConsolidation, PurchaseConsolidationItem, PurchaseConsolidationSource,
    Requisition, RequisitionItem, RFQ,
)
from app.platform.settings.service import get_setting, write_audit
from app.platform.workflow import engine
from app.shared.enums import (
    AuditAction, ConsolidationStatus, DocType, InstanceStatus, RequisitionStatus,
    RFQStatus,
)
from app.shared.models.base import utcnow
from app.shared.numbering import next_number
from app.platform.doc_numbering import scope as org_scope
from app.shared.masters import combinations

logger = logging.getLogger(__name__)

AUDIT_ENTITY = "pro_consolidations"
ZERO = Decimal("0")

#: A requisition may only be folded in once it has been signed off, and only if it is
#: not already on another sheet. Both checks matter: consolidating a draft tenders
#: demand nobody approved, and consolidating twice buys it twice.
CONSOLIDATABLE = (RequisitionStatus.APPROVED.value,)

#: Statuses a sheet can no longer be edited from.
LOCKED = (ConsolidationStatus.PENDING_APPROVAL.value,
          ConsolidationStatus.APPROVED.value,
          ConsolidationStatus.RFQ_RAISED.value,
          ConsolidationStatus.CLOSED.value,
          ConsolidationStatus.CANCELLED.value,
          ConsolidationStatus.REJECTED.value)


def _d(value) -> Decimal:
    return Decimal(str(value or 0))


# --------------------------------------------------------------------------- #
#  Reads
# --------------------------------------------------------------------------- #

async def get_consolidation(db: AsyncSession, cons_id: int,
                            user=None) -> PurchaseConsolidation:
    """FIXED 2026-08-20 — detail ignored the rung the register now obeys, so a sheet
    hidden from the list opened by id with every source requisition and its value on it.
    WITHOUT this the rung on `list_consolidations` is a display filter. 404, not 403 —
    an id that is not yours must not confirm it exists.

    Every reader of a sheet goes through here (`sources`, `history`, `approvals` all
    load it first), so one check covers the family.
    """
    stmt = select(PurchaseConsolidation).where(PurchaseConsolidation.id == cons_id)
    if user is not None:
        stmt = stmt.where(await scope_condition(
            db, user,
            owner_col=PurchaseConsolidation.created_by_id,
            position_col=PurchaseConsolidation.created_position_id,
            project_col=PurchaseConsolidation.project_id,
            warehouse_col=PurchaseConsolidation.warehouse_id,
        ))
    doc = (await db.execute(stmt)).scalar_one_or_none()
    if doc is None:
        raise NotFoundError(f"Consolidated sheet {cons_id} not found")

    existing_rfq = await db.scalar(
        select(RFQ.id)
        .where(RFQ.consolidation_id == doc.id,
               RFQ.status != RFQStatus.CANCELLED.value)
        .limit(1)
    )
    doc.has_rfq = bool(existing_rfq)
    return doc


async def list_consolidations(db: AsyncSession, params: PageParams,
                              status: str | None = None,
                              project_id: int | None = None,
                              pending_for_me: bool = False,
                              user=None) -> dict:
    """FIXED 2026-08-20 — was unscoped. A consolidation sheet gathers many requisitions
    and carries the estimated spend for all of them, so with no rung the register put
    every project's buying plan and its value in front of anyone holding
    `consolidation.view`. WITHOUT this the project and office rungs on Job Profiles had
    no effect on the one screen that aggregates everything.

    The table carries `created_by_id`, `created_position_id`, `project_id` and
    `warehouse_id`, so every rung has a real column to land on.
    """
    stmt = select(PurchaseConsolidation)
    if user is not None:
        stmt = stmt.where(await scope_condition(
            db, user,
            owner_col=PurchaseConsolidation.created_by_id,
            position_col=PurchaseConsolidation.created_position_id,
            project_col=PurchaseConsolidation.project_id,
            warehouse_col=PurchaseConsolidation.warehouse_id,
        ))
    if status:
        wanted = [s.strip().upper() for s in status.split(",") if s.strip()]
        stmt = stmt.where(PurchaseConsolidation.status.in_(wanted))
    if project_id:
        stmt = stmt.where(PurchaseConsolidation.project_id == project_id)
    if pending_for_me and user is not None:
        # What is waiting on THIS login, off `wf_pending` rather than off the status:
        # PENDING_APPROVAL says somebody has to sign, and only the engine says who.
        # `[0]` for the empty case — "no rows", not "every row".
        ids = [row["doc_id"] for row in await engine.pending_for_user(
            db, user, doc_types=[DocType.CONSOLIDATION.value])]
        stmt = stmt.where(PurchaseConsolidation.id.in_(ids or [0]))
    page = await paginate(
        db, stmt.order_by(PurchaseConsolidation.id.desc()), params)
    # `current_approver_name` is never written on a consolidation — only cleared — so
    # the register's approver column read blank on every sheet. This is the live one.
    rows = page.get("items") or []
    if rows:
        waiting = await engine.pending_approver_names(
            db, DocType.CONSOLIDATION.value, [row.id for row in rows])
        for row in rows:
            row.pending_with = waiting.get(row.id, [])
    return page


async def sources_of(db: AsyncSession, cons_id: int,
                     user=None) -> list[PurchaseConsolidationSource]:
    # FIXED — the sheet's own rung, applied by loading it first. Without this the
    # source requisitions of a sheet the login may not see were readable by id.
    await get_consolidation(db, cons_id, user=user)
    return list((await db.execute(
        select(PurchaseConsolidationSource)
        .where(PurchaseConsolidationSource.consolidation_id == cons_id)
        .order_by(PurchaseConsolidationSource.requisition_no)
    )).scalars().all())


async def _already_consolidated(db: AsyncSession,
                                requisition_ids: list[int]) -> dict[int, str]:
    """Which of these are already on a sheet, and which sheet.

    Cancelled and rejected sheets do not count — their requisitions are free again,
    which is the whole point of being able to reject a sheet.
    """
    if not requisition_ids:
        return {}
    rows = (await db.execute(
        select(PurchaseConsolidationSource.requisition_id, PurchaseConsolidation.cons_no)
        .join(PurchaseConsolidation,
              PurchaseConsolidation.id == PurchaseConsolidationSource.consolidation_id)
        .where(PurchaseConsolidationSource.requisition_id.in_(requisition_ids),
               PurchaseConsolidation.status.notin_([
                   ConsolidationStatus.CANCELLED.value,
                   ConsolidationStatus.REJECTED.value]))
    )).all()
    return {row[0]: row[1] for row in rows}


async def candidate_ids(db: AsyncSession, project_id: int | None = None) -> list[int]:
    """Every requisition `candidates` would offer, as bare ids.

    NEW 2026-08-21, for "select all". The screen pages twenty at a time, so a select-all
    built from what is loaded could only ever tick the visible twenty — and on a month
    with 100+ requisitions that is the opposite of what the button says it does. This
    answers for the WHOLE filtered set, so ticking it means what a reader thinks it
    means.

    Ids only, deliberately: the rows themselves are already on screen and shipping a
    thousand full requisitions to select them would be slower than the paging it
    replaces. Identical filters to `candidates` — same helper would be better still,
    but the two differ only in what they SELECT, and keeping the WHERE in one place is
    handled by both reading the same constants.
    """
    taken = select(PurchaseConsolidationSource.requisition_id).join(
        PurchaseConsolidation,
        PurchaseConsolidation.id == PurchaseConsolidationSource.consolidation_id
    ).where(PurchaseConsolidation.status.notin_([
        ConsolidationStatus.CANCELLED.value,
        ConsolidationStatus.REJECTED.value]))
    stmt = (select(Requisition.id)
            .where(Requisition.status.in_(CONSOLIDATABLE),
                   Requisition.id.notin_(taken))
            .order_by(Requisition.created_at.desc()))
    if project_id:
        stmt = stmt.where(Requisition.project_id == project_id)
    return list((await db.execute(stmt)).scalars().all())


async def candidates(db: AsyncSession, params: PageParams,
                     project_id: int | None = None) -> dict:
    """Approved requisitions that are not on a sheet yet — what the buyer picks from.

    Filtered in the query rather than in Python: the register is thousands of rows on
    a live database and loading them all to drop the consolidated ones puts the whole
    history through the app for a screen that shows twenty.
    """
    taken = select(PurchaseConsolidationSource.requisition_id).join(
        PurchaseConsolidation, PurchaseConsolidation.id == PurchaseConsolidationSource.consolidation_id
    ).where(PurchaseConsolidation.status.notin_([
        ConsolidationStatus.CANCELLED.value,
        ConsolidationStatus.REJECTED.value]))
    stmt = (select(Requisition)
            .where(Requisition.status.in_(CONSOLIDATABLE),
                   Requisition.id.notin_(taken))
            .order_by(Requisition.created_at.desc()))
    if project_id:
        stmt = stmt.where(Requisition.project_id == project_id)
    return await paginate(db, stmt, params)


# --------------------------------------------------------------------------- #
#  Building the sheet
# --------------------------------------------------------------------------- #

async def _load_requisitions(db: AsyncSession,
                             requisition_ids: list[int]) -> list[Requisition]:
    if not requisition_ids:
        raise ValidationError("Choose at least one requisition to consolidate")
    rows = (await db.execute(
        select(Requisition).where(Requisition.id.in_(requisition_ids))
    )).scalars().all()

    found = {r.id for r in rows}
    missing = [i for i in requisition_ids if i not in found]
    if missing:
        raise NotFoundError(
            f"Requisition(s) not found: {', '.join(str(i) for i in missing)}")

    unapproved = [r.req_no for r in rows if r.status not in CONSOLIDATABLE]
    if unapproved:
        raise ValidationError(
            f"Only approved requisitions can be consolidated. "
            f"Not approved: {', '.join(unapproved)}.")

    clashes = await _already_consolidated(db, list(found))
    if clashes:
        by_no = {r.id: r.req_no for r in rows}
        detail = ", ".join(f"{by_no[req_id]} is on {sheet}"
                           for req_id, sheet in sorted(clashes.items()))
        raise ValidationError(
            f"Already consolidated — {detail}. Remove it from that sheet first.")
    return list(rows)


async def _aggregate(db: AsyncSession, requisitions: list[Requisition]) -> list[dict]:
    """Requisition lines, summed per (item, uom).

    An OrderedDict rather than a plain one so the sheet comes out in the order the
    items were first asked for, which is stable across re-runs and reads as a history
    rather than as a hash order.
    """
    req_ids = [r.id for r in requisitions]
    by_id = {r.id: r for r in requisitions}
    lines = (await db.execute(
        select(RequisitionItem)
        .where(RequisitionItem.requisition_id.in_(req_ids))
        .order_by(RequisitionItem.requisition_id, RequisitionItem.line_no)
    )).scalars().all()
    if not lines:
        raise ValidationError(
            "The chosen requisitions have no lines — there is nothing to consolidate")

    merged: OrderedDict[tuple, dict] = OrderedDict()
    for line in lines:
        # Merged per item AND combination (2026-10-23): two brands of one item are two
        # rows on the sheet, bought separately.
        combo = combinations.carry(line)
        key = (line.item_id, (line.uom_code or "").upper(), combo["brand_id"],
               combo["variant_id"], combo["model_id"])
        bucket = merged.get(key)
        if bucket is None:
            bucket = merged[key] = {
                "item_id": line.item_id, "item_code": line.item_code,
                "item_name": line.item_name, "uom_code": line.uom_code,
                "quantity": ZERO, "estimated_amount": ZERO,
                "required_date": line.required_date, "sources": [],
                **combo,
            }
        bucket["quantity"] += _d(line.quantity)
        bucket["estimated_amount"] += _d(line.estimated_amount)
        # The earliest date anybody needs it by. A sheet bought to the latest date
        # would deliver late to whoever asked first.
        if line.required_date and (bucket["required_date"] is None
                                   or line.required_date < bucket["required_date"]):
            bucket["required_date"] = line.required_date
        requisition = by_id.get(line.requisition_id)
        bucket["sources"].append(
            f"{requisition.req_no if requisition else line.requisition_id}"
            f" x {_d(line.quantity):g}")
    return list(merged.values())


def _apply_aggregate(doc: PurchaseConsolidation, rows: list[dict]) -> None:
    doc.items.clear()
    for index, row in enumerate(rows, start=1):
        quantity = row["quantity"]
        amount = row["estimated_amount"]
        doc.items.append(PurchaseConsolidationItem(
            line_no=index,
            **combinations.carry(row),
            item_id=row["item_id"], item_code=row["item_code"],
            item_name=row["item_name"], uom_code=row["uom_code"],
            quantity=quantity,
            # Defaults to everything asked for. Trimming is a deliberate act on the
            # sheet, not something aggregation does behind the buyer's back.
            approved_qty=quantity,
            # Back-derived so the sheet shows a rate even though the requisitions only
            # carried amounts. Zero quantity would divide by zero, so it stays zero.
            estimated_rate=(amount / quantity) if quantity > ZERO else ZERO,
            estimated_amount=amount,
            required_date=row["required_date"],
            sources="; ".join(row["sources"]),
            source_count=len(row["sources"]),
        ))
    doc.total_items = len(doc.items)
    doc.estimated_value = sum((_d(i.estimated_amount) for i in doc.items), ZERO)


async def _link_sources(db: AsyncSession, doc: PurchaseConsolidation,
                        requisitions: list[Requisition]) -> None:
    """Membership rows, rebuilt from scratch each time the sheet is rebuilt."""
    for row in await sources_of(db, doc.id):
        await db.delete(row)
    counts = dict((await db.execute(
        select(RequisitionItem.requisition_id, func.count(RequisitionItem.id))
        .where(RequisitionItem.requisition_id.in_([r.id for r in requisitions]))
        .group_by(RequisitionItem.requisition_id)
    )).all())
    for requisition in requisitions:
        db.add(PurchaseConsolidationSource(
            consolidation_id=doc.id, requisition_id=requisition.id,
            requisition_no=requisition.req_no,
            project_name=requisition.project_name,
            item_count=counts.get(requisition.id, 0),
            estimated_value=_d(requisition.estimated_value),
        ))
    doc.source_count = len(requisitions)


def _assert_one_organisation(requisitions: list[Requisition]) -> int | None:
    """One sheet is one company's paper: taking the first requisition's would quietly put
    the others on the wrong one. An older requisition with none does not clash."""
    named = {row.organization_id: row.organization_name
             for row in requisitions if row.organization_id}
    if len(named) > 1:
        raise ValidationError(
            "These requisitions belong to different organisations ("
            + ", ".join(sorted(str(name) for name in named.values()))
            + "). Consolidate each organisation on its own sheet.")
    return next(iter(named), None)


async def _sheet_scope(db: AsyncSession, requisitions: list[Requisition], data) -> dict:
    """Copied from the requisitions, or selected on the sheet when they are older than
    organisations. A department the requisitions do not all share is left off."""
    organization_id = _assert_one_organisation(requisitions)
    if not organization_id:
        return await org_scope.resolve(db, data.organization_id, data.org_department_id,
                                       fiscal_year=data.fiscal_year)
    departments = {row.org_department_id for row in requisitions if row.organization_id}
    department_id = next(iter(departments)) if len(departments) == 1 else None
    return await org_scope.resolve(db, organization_id,
                                   data.org_department_id or department_id,
                                   keep=next(row for row in requisitions
                                             if row.organization_id),
                                   fiscal_year=data.fiscal_year)


async def create_consolidation(db: AsyncSession, data, user) -> PurchaseConsolidation:
    requisitions = await _load_requisitions(db, data.requisition_ids)
    rows = await _aggregate(db, requisitions)
    scope = await _sheet_scope(db, requisitions, data)

    doc = PurchaseConsolidation(
        cons_no="",  # Drawn below from the document itself, so the two cannot disagree.
        cons_date=data.cons_date or date.today(),
        title=data.title, period_label=data.period_label,
        project_id=data.project_id or requisitions[0].project_id,
        project_name=data.project_name or requisitions[0].project_name,
        warehouse_id=data.warehouse_id or requisitions[0].warehouse_id,
        warehouse_name=data.warehouse_name or requisitions[0].warehouse_name,
        status=ConsolidationStatus.DRAFT.value,
        remarks=data.remarks,
        created_by_id=getattr(user, "id", None),
        created_by_name=getattr(user, "full_name", None),
        created_position_id=getattr(user, "active_position_id", None),
    )
    org_scope.stamp(doc, scope)
    org_scope.assert_complete(doc)
    doc.cons_no = await next_number(db, DocType.CONSOLIDATION.value.lower(),
                                    **org_scope.number_args(doc))
    _apply_aggregate(doc, rows)
    db.add(doc)
    await db.flush()
    await _link_sources(db, doc, requisitions)

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id,
                      entity_no=doc.cons_no, action=AuditAction.CREATE, actor=user,
                      after={"requisitions": len(requisitions),
                             "items": doc.total_items},
                      summary=f"Consolidated {len(requisitions)} requisition(s) "
                               f"into {doc.cons_no}")
    await db.commit()
    await db.refresh(doc)
    return await _attach_caps(db, doc)


async def rebuild_consolidation(db: AsyncSession, cons_id: int, data,
                                user) -> PurchaseConsolidation:
    """Change which requisitions are on the sheet, and re-aggregate.

    A whole rebuild rather than an incremental add/remove: the lines are a pure
    function of the membership, so recomputing them is both simpler and the only way
    the totals cannot drift from the sources.
    """
    doc = await get_consolidation(db, cons_id)
    if doc.status in LOCKED:
        raise ValidationError(
            f"{doc.cons_no} is {doc.status.lower().replace('_', ' ')} "
            "and can no longer be rebuilt")

    # Its own current members are not a clash with itself.
    for row in await sources_of(db, doc.id):
        await db.delete(row)
    await db.flush()

    requisitions = await _load_requisitions(db, data.requisition_ids)
    # The sheet keeps the organisation it has: a rebuild changes what is on it, not whose.
    if doc.organization_id and _assert_one_organisation(requisitions) not in (
            None, doc.organization_id):
        raise ValidationError(
            f"{doc.cons_no} belongs to {doc.organization_name}; these requisitions "
            "belong to another organisation.")
    rows = await _aggregate(db, requisitions)
    _apply_aggregate(doc, rows)
    await _link_sources(db, doc, requisitions)

    for field in ("title", "period_label", "project_id", "project_name",
                  "warehouse_id", "warehouse_name", "remarks", "cons_date"):
        value = getattr(data, field, None)
        if value is not None:
            setattr(doc, field, value)

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id,
                      entity_no=doc.cons_no, action=AuditAction.UPDATE, actor=user,
                      after={"requisitions": len(requisitions),
                             "items": doc.total_items},
                       summary=f"Rebuilt {doc.cons_no} from "
                               f"{len(requisitions)} requisition(s)")
    await db.commit()
    await db.refresh(doc)
    return await _attach_caps(db, doc)


async def _line_caps(db: AsyncSession,
                   doc: PurchaseConsolidation) -> dict[int, dict]:
    """Per-line buying ceiling: requested + replenishment top-up.

    A sheet is built from requisitions raised against a shipment address — a
    warehouse, an MDP or a LIP point — and the buyer may raise the tendered
    quantity above what was asked ONLY by the replenishment shortfall of that
    location: ``max_qty - available`` per (warehouse, item), summed over the
    distinct shipment warehouses that asked for the line.

    No replenishment rule for an item at a location contributes nothing, so a
    line with no rule anywhere keeps a cap of exactly what was requested
    (decrease-only, as before). The top-up is clamped at zero: stock above max
    is not a negative allowance.
    """
    caps: dict[int, dict] = {}
    for line in doc.items:
        caps[line.id] = {"cap": _d(line.quantity), "allowance": ZERO,
                         "warehouses": []}
    sources = await sources_of(db, doc.id)
    req_ids = [row.requisition_id for row in sources]
    if not req_ids or not doc.items:
        return caps

    requisitions = (await db.execute(
        select(Requisition).where(Requisition.id.in_(req_ids))
    )).scalars().all()
    wh_of = {r.id: r.warehouse_id for r in requisitions}
    wh_names = {r.id: r.warehouse_name for r in requisitions}

    req_lines = (await db.execute(
        select(RequisitionItem.requisition_id, RequisitionItem.item_id,
               RequisitionItem.uom_code)
        .where(RequisitionItem.requisition_id.in_(req_ids))
    )).all()
    # Which shipment warehouses asked for each (item, uom) bucket — the same key
    # `_aggregate` merges on.
    wh_by_key: dict[tuple, set] = defaultdict(set)
    for req_id, item_id, uom in req_lines:
        wh = wh_of.get(req_id)
        if wh is None:
            continue
        wh_by_key[(item_id, (uom or "").upper())].add(wh)

    try:
        raw = await get_setting(db, "inventory.replenishment_rules")
        rules_map = json.loads(raw) if raw else {}
    except Exception:  # noqa: BLE001 — a cap must never fail the read
        logger.exception("Replenishment rules unreadable for %s",
                         getattr(doc, "cons_no", doc.id))
        return caps

    pairs = {(wh, line.item_id)
             for line in doc.items
             for wh in wh_by_key.get(
                 (line.item_id, (line.uom_code or "").upper()), set())
             if f"{wh}:{line.item_id}" in rules_map}
    available: dict[tuple, Decimal] = {}
    if pairs:
        # Lazy import: procurement sits after inventory in the chain (rule 5)
        # and inventory imports nothing from app.modules, so no cycle — but a
        # top-level import would still hard-link the modules.
        from app.modules.inventory.models import Stock
        rows = (await db.execute(
            select(Stock.warehouse_id, Stock.item_id,
                   func.coalesce(func.sum(Stock.available_qty), 0))
            .where(func.concat(Stock.warehouse_id, ":", Stock.item_id).in_(
                [f"{wh}:{item}" for wh, item in pairs]))
            .group_by(Stock.warehouse_id, Stock.item_id)
        )).all()
        available = {(w, i): _d(qty) for w, i, qty in rows}

    for line in doc.items:
        key = (line.item_id, (line.uom_code or "").upper())
        allowance = ZERO
        names: list[str] = []
        for wh in sorted(wh_by_key.get(key, set())):
            rule = rules_map.get(f"{wh}:{line.item_id}")
            if not rule:
                continue
            try:
                top_up = _d(rule.get("max_qty")) - available.get(
                    (wh, line.item_id), ZERO)
            except Exception:  # noqa: BLE001 — one bad rule, not the sheet
                continue
            if top_up > ZERO:
                allowance += top_up
            # Named even when the top-up is zero, so the screen can say the
            # rule exists but the shelf is already at max.
            for req_id in req_ids:
                if wh_of.get(req_id) == wh and wh_names.get(req_id):
                    if wh_names[req_id] not in names:
                        names.append(wh_names[req_id])
                    break
        caps[line.id] = {"cap": _d(line.quantity) + allowance,
                         "allowance": allowance, "warehouses": names}
    return caps


async def _attach_caps(db: AsyncSession,
                       doc: PurchaseConsolidation) -> PurchaseConsolidation:
    """Serve the ceiling the save enforces, so the screen and the guard cannot
    drift apart. Transient attributes for `ConsolidationItemOut` — never stored.
    """
    try:
        caps = await _line_caps(db, doc)
    except Exception:  # noqa: BLE001 — see `_line_caps`
        return doc
    for line in doc.items:
        cap = caps.get(line.id)
        if cap is None:
            continue
        line.max_allowed_qty = cap["cap"]
        line.replenishment_qty = cap["allowance"]
        line.replenishment_at = ", ".join(cap["warehouses"])
    return doc


async def set_line_quantities(db: AsyncSession, cons_id: int, data,
                              user) -> PurchaseConsolidation:
    """Trim what will actually be tendered — or top it up to the replenishment
    ceiling. Below the requested quantity is always allowed; above it only up to
    `quantity + (max - available)` at the shipment warehouses that asked for the
    line, and with no rule there the ceiling stays at what was requested.
    """
    doc = await get_consolidation(db, cons_id)
    if doc.status in LOCKED:
        raise ValidationError(f"{doc.cons_no} can no longer be edited")

    by_id = {line.id: line for line in doc.items}
    caps = await _line_caps(db, doc)
    for change in data.lines:
        line = by_id.get(change.line_id)
        if line is None:
            raise NotFoundError(f"Line {change.line_id} is not on {doc.cons_no}")
        wanted = _d(change.approved_qty)
        if wanted < ZERO:
            raise ValidationError("A quantity cannot be negative")
        cap = caps.get(change.line_id, {}).get("cap", _d(line.quantity))
        allowance = caps.get(change.line_id, {}).get("allowance", ZERO)
        if wanted > cap:
            if allowance > ZERO:
                at = ", ".join(caps[change.line_id]["warehouses"]) or "its shipment point"
                raise ValidationError(
                    f"{line.item_name}: {wanted:g} is more than the "
                    f"{_d(line.quantity):g} the requisitions asked for plus the "
                    f"{allowance:g} replenishment top-up at {at} "
                    f"(max {cap:g}). Raise a new requisition instead.")
            raise ValidationError(
                f"{line.item_name}: {wanted:g} is more than the {_d(line.quantity):g} "
                "the requisitions asked for. Raise a new requisition instead.")
        line.approved_qty = wanted
        line.estimated_amount = wanted * _d(line.estimated_rate)
        if change.remarks is not None:
            line.remarks = change.remarks

    doc.estimated_value = sum((_d(i.estimated_amount) for i in doc.items), ZERO)
    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id,
                      entity_no=doc.cons_no, action=AuditAction.UPDATE, actor=user,
                      summary=f"Adjusted {len(data.lines)} line(s) on {doc.cons_no}")
    await db.commit()
    await db.refresh(doc)
    return await _attach_caps(db, doc)


async def delete_consolidation(db: AsyncSession, cons_id: int, user) -> dict:
    doc = await get_consolidation(db, cons_id)
    if doc.status != ConsolidationStatus.DRAFT.value:
        raise ValidationError("Only a draft sheet can be deleted. Cancel it instead.")
    cons_no = doc.cons_no
    for row in await sources_of(db, doc.id):
        await db.delete(row)
    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id, entity_no=cons_no,
                      action=AuditAction.DEACTIVATE, actor=user,
                      summary=f"Deleted draft consolidation {cons_no}")
    await db.delete(doc)
    await db.commit()
    return {"success": True, "cons_no": cons_no}


# --------------------------------------------------------------------------- #
#  Approval
# --------------------------------------------------------------------------- #

def _context(doc: PurchaseConsolidation) -> dict:
    return {
        "doc_no": doc.cons_no,
        "doc_summary": (f"Consolidated purchase sheet {doc.cons_no} — "
                        f"{doc.total_items} item(s), {doc.source_count} requisition(s)"),
        "project_id": doc.project_id or None,
        "requester_position_id": doc.created_position_id,
        "total_amount": float(doc.estimated_value or 0),
        "total_items": doc.total_items,
    }


async def _mark_sources(db: AsyncSession, doc: PurchaseConsolidation, status: str) -> None:
    """Move every requisition on the sheet to `status`.

    CONSOLIDATED once the sheet is signed, so nobody can pick the same requisition up
    again individually; back to APPROVED if the sheet is rejected or cancelled, so the
    demand is not stranded in a state no screen works.
    """
    ids = [row.requisition_id for row in await sources_of(db, doc.id)]
    if not ids:
        return
    for requisition in (await db.execute(
        select(Requisition).where(Requisition.id.in_(ids))
    )).scalars().all():
        requisition.status = status


async def submit_consolidation(db: AsyncSession, cons_id: int,
                               user) -> PurchaseConsolidation:
    doc = await get_consolidation(db, cons_id)
    if doc.status != ConsolidationStatus.DRAFT.value:
        raise ValidationError(f"{doc.cons_no} has already been submitted")
    if not doc.items:
        raise ValidationError("There is nothing on this sheet to approve")
    if all(_d(line.approved_qty) <= ZERO for line in doc.items):
        raise ValidationError(
            "Every line has been trimmed to zero — there is nothing left to buy")

    doc.created_position_id = (doc.created_position_id
                               or getattr(user, "active_position_id", None))
    instance = await engine.start(db, DocType.CONSOLIDATION.value, doc.id,
                                  _context(doc), user)
    doc.status = ConsolidationStatus.PENDING_APPROVAL.value
    # Nothing configured means an already-approved instance comes back; reading it is
    # what stops the sheet standing still with nobody holding it (rule 8).
    if instance.status == InstanceStatus.APPROVED.value:
        doc.status = ConsolidationStatus.APPROVED.value
        doc.approved_at = utcnow()
        doc.approved_by_name = getattr(user, "full_name", None)
        await _mark_sources(db, doc, RequisitionStatus.CONSOLIDATED.value)

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id,
                      entity_no=doc.cons_no, action=AuditAction.UPDATE, actor=user,
                      before={"status": ConsolidationStatus.DRAFT.value},
                      after={"status": doc.status},
                      summary=f"Submitted {doc.cons_no} for approval")
    await db.commit()
    await db.refresh(doc)
    return doc


async def act_on_consolidation(db: AsyncSession, cons_id: int, action: str,
                               comments: str, user) -> PurchaseConsolidation:
    doc = await get_consolidation(db, cons_id)
    if doc.status != ConsolidationStatus.PENDING_APPROVAL.value:
        raise ValidationError(f"{doc.cons_no} is not awaiting approval")
    action = (action or "").upper()
    if action == "REJECTED" and not (comments or "").strip():
        raise ValidationError("Tell the buyer why this sheet was rejected")

    before = doc.status
    instance = await engine.act(db, DocType.CONSOLIDATION.value, doc.id, action,
                                user, comments, context=_context(doc))
    if instance.status == InstanceStatus.APPROVED.value:
        doc.status = ConsolidationStatus.APPROVED.value
        doc.approved_at = utcnow()
        doc.approved_by_name = getattr(user, "full_name", None)
        doc.current_approver_name = None
        await _mark_sources(db, doc, RequisitionStatus.CONSOLIDATED.value)
    elif instance.status == InstanceStatus.REJECTED.value:
        doc.status = ConsolidationStatus.REJECTED.value
        doc.current_approver_name = None
        # The demand did not go away because the sheet was refused.
        await _mark_sources(db, doc, RequisitionStatus.APPROVED.value)

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id,
                      entity_no=doc.cons_no, action=AuditAction.UPDATE, actor=user,
                      before={"status": before}, after={"status": doc.status},
                      summary=f"{action.title()} {doc.cons_no}")
    await db.commit()
    await db.refresh(doc)
    return doc


async def cancel_consolidation(db: AsyncSession, cons_id: int, user,
                               reason: str = "") -> PurchaseConsolidation:
    doc = await get_consolidation(db, cons_id)
    if doc.status in (ConsolidationStatus.CANCELLED.value,
                      ConsolidationStatus.CLOSED.value):
        raise ValidationError(f"{doc.cons_no} is already {doc.status.lower()}")
    before = doc.status
    if before == ConsolidationStatus.PENDING_APPROVAL.value:
        await engine.abandon(db, DocType.CONSOLIDATION.value, doc.id, user, reason)
    doc.status = ConsolidationStatus.CANCELLED.value
    await _mark_sources(db, doc, RequisitionStatus.APPROVED.value)

    await write_audit(db, entity=AUDIT_ENTITY, entity_id=doc.id,
                      entity_no=doc.cons_no, action=AuditAction.UPDATE, actor=user,
                      before={"status": before}, after={"status": doc.status},
                      summary=f"Cancelled {doc.cons_no}: {reason or 'no reason given'}")
    await db.commit()
    await db.refresh(doc)
    return doc


async def history(db: AsyncSession, cons_id: int, user=None) -> list:
    doc = await get_consolidation(db, cons_id, user=user)
    return await engine.history(db, DocType.CONSOLIDATION.value, doc.id)
