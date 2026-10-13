"""Procurement Demand Pool — read-only triage view over the buying chain.

Every outstanding indent quantity appears in exactly one stage of exactly one pool.
This module owns the PROCUREMENT half:

    TO_SOURCE → MR → REQUISITION → CONSOLIDATION → RFQ → PO
    (when goods reach stock the quantity leaves this pool entirely)

INVARIANT (failing-silently list — test in tests/test_demand_pool.py §9):
    owed(line) = Σ procurement_stage_qty + Σ warehouse_stage_qty + received_quantity
    A quantity in two stages double-counts demand → somebody buys twice.
    A quantity in none silently vanishes from both pools.

Import legality (rule 5 — chain: inventory → indents → procurement → … → warehouse):
    This module sits in `procurement`, so it may import `indents`, `inventory`
    and its own models.  It must NOT import `warehouse`.

Nothing here writes, reserves, approves or wakes any document.
"""
from __future__ import annotations

from decimal import Decimal

from sqlalchemy import and_, case, func, or_, select, true
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.pagination import PageParams
from app.modules.indents.models import Indent, IndentItem
from app.modules.inventory.allocations import UNAPPROVED_ALLOCATION_STATUSES
from app.modules.inventory.models import (
    Allocation, AllocationItem, MaterialRequest, MaterialRequestItem,
)
from app.modules.procurement.models import (
    POItem, PurchaseOrder, Requisition, RequisitionItem,
)
# Status tuples imported, NEVER re-declared (spec §3).
from app.modules.procurement.stats import PO_OPEN, REQ_SANCTIONED
from app.modules.indents.service import indent_access_condition


# ---------------------------------------------------------------------------
# Stage labels — served by GET /api/procurement/demand-pool/stages
# ---------------------------------------------------------------------------

PROCUREMENT_STAGES: tuple[dict, ...] = (
    {
        "stage": "TO_SOURCE",
        "label": "To Source",
        "tone": "neutral",
        "hint": "Quantity approved and outstanding — no buying document raised yet.",
        "deep_link": "/inventory/fulfilment",
    },
    {
        "stage": "MR",
        "label": "Material Request",
        "tone": "warning",
        "hint": "A material request is raised; procurement has not yet started buying.",
        "deep_link": "/inventory/material-requests",
    },
    {
        "stage": "REQUISITION",
        "label": "Requisition",
        "tone": "info",
        "hint": "Approved requisition raised; not yet on a tender.",
        "deep_link": "/procurement/requisitions",
    },
    {
        "stage": "CONSOLIDATION",
        "label": "Consolidation",
        "tone": "info",
        "hint": "Consolidated into a buying sheet, pending RFQ.",
        "deep_link": "/procurement/consolidations",
    },
    {
        "stage": "RFQ",
        "label": "RFQ",
        "tone": "info",
        "hint": "Tender out to vendors — awaiting quotes or award.",
        "deep_link": "/procurement/rfqs",
    },
    {
        "stage": "PO",
        "label": "Purchase Order",
        "tone": "success",
        "hint": "Order placed; goods not yet received at the warehouse.",
        "deep_link": "/procurement/purchase-orders",
    },
)


def _d(v) -> Decimal:
    return Decimal(str(v or 0))


# ---------------------------------------------------------------------------
# Per-line stage netting (pure function — unit-testable without a database)
# ---------------------------------------------------------------------------

def _net_stages(
    *,
    owed: Decimal,
    received: Decimal,
    po_qty: Decimal,
    req_qty_by_status: dict[str, Decimal],   # {req_status: total_qty} for this line
    mr_net_qty: Decimal,
    served_from_stock: Decimal = Decimal("0"),
) -> dict[str, Decimal]:
    """Return {stage: qty} for one indent item line, netting latest stages first.

    The "largest bucket" rule from spec §5: assign the furthest-along stage
    first and work backwards.  Every number is >= 0 and sums ≤ (owed − received).
    """
    outstanding = max(_d(0), owed - received)
    # 0. What the WAREHOUSE is serving from stock is not procurement's demand: an
    #    allocation (signed or awaiting approval) whose goods sit in a material-issue
    #    draft, an issue or a consignment. It lives in the warehouse pool; counting it
    #    here as well put the same quantity in both pools and read as "To Source" —
    #    the double-count the module invariant forbids, and how somebody buys twice.
    outstanding = max(_d(0), outstanding - max(_d(0), served_from_stock))
    if outstanding <= 0:
        return {}

    stages: dict[str, Decimal] = {}

    # 1. PO — what is still outstanding on open orders
    po = min(po_qty, outstanding)
    if po > 0:
        stages["PO"] = po
        outstanding -= po

    # 2. RFQ / CONSOLIDATION / REQUISITION — remaining requisition demand, bucketed
    #    by how far each requisition got.  Ordered furthest-first.
    for req_status, bucket in [
        ("RFQ_RAISED",    "RFQ"),
        ("CONSOLIDATED",  "CONSOLIDATION"),
        ("APPROVED",      "REQUISITION"),
    ]:
        qty = min(req_qty_by_status.get(req_status, _d(0)), outstanding)
        if qty > 0:
            stages[bucket] = qty
            outstanding -= qty

    # 3. MR — live material-request remainder, net of any requisition already raised
    mr = min(mr_net_qty, outstanding)
    if mr > 0:
        stages["MR"] = mr
        outstanding -= mr

    # 4. TO_SOURCE — whatever is left
    if outstanding > 0:
        stages["TO_SOURCE"] = outstanding

    return stages


# ---------------------------------------------------------------------------
# Main grouped query
# ---------------------------------------------------------------------------

async def demand_pool(
    db: AsyncSession,
    params: PageParams,
    *,
    search: str | None = None,
    item_id: int | None = None,
    warehouse_id: int | None = None,
    project_id: int | None = None,
    stage: str | None = None,
    user=None,
) -> dict:
    """Item-wise procurement demand pool.

    Returns the spec §7 JSON shape — groups[], group_count, indent_count,
    stage_totals, page, size, total.

    Scoped through the INDENT (indent_visibility), not the requisition, so
    a login whose position cannot see a requisition still sees the indent
    they raised and the stage its quantity is sitting at.

    Pagination is over ITEM GROUPS, after grouping — BUG-PRO-075 pattern.
    """
    # ── scope ──────────────────────────────────────────────────────────────
    indent_scope = (
        await indent_access_condition(db, user)
        if user is not None else true()
    )

    # ── base: open indent lines (owed > received, not excluded) ────────────
    owed_expr = func.coalesce(IndentItem.approved_quantity, IndentItem.quantity)
    received_expr = func.coalesce(IndentItem.received_quantity, 0)

    base = (
        select(
            IndentItem.id.label("indent_item_id"),
            IndentItem.indent_id.label("indent_id"),
            Indent.indent_no.label("indent_no"),
            IndentItem.item_id.label("item_id"),
            func.max(IndentItem.item_code).label("item_code"),
            func.max(IndentItem.item_name).label("item_name"),
            func.max(IndentItem.uom_code).label("uom_code"),
            owed_expr.label("owed_qty"),
            received_expr.label("received_qty"),
            IndentItem.quantity.label("requested_qty"),
            IndentItem.approved_quantity.label("approved_qty"),
            IndentItem.allocated_quantity.label("allocated_qty"),
            Indent.required_date.label("required_date"),
            Indent.priority.label("priority"),
            Indent.requested_by_name.label("requested_by_name"),
            Indent.department_name.label("department_name"),
            Indent.project_name.label("project_name"),
        )
        .join(Indent, Indent.id == IndentItem.indent_id)
        .where(
            indent_scope,
            IndentItem.is_excluded.is_(False),
            owed_expr > received_expr,          # outstanding lines only
        )
    )
    if project_id:
        base = base.where(Indent.project_id == project_id)
    if warehouse_id:
        base = base.where(Indent.warehouse_id == warehouse_id)
    if search:
        pat = f"%{search}%"
        base = base.where(or_(
            IndentItem.item_code.ilike(pat),
            IndentItem.item_name.ilike(pat),
            Indent.indent_no.ilike(pat),
        ))
    if item_id:
        base = base.where(IndentItem.item_id == item_id)

    base = base.group_by(
        IndentItem.id, IndentItem.indent_id, Indent.indent_no,
        IndentItem.item_id, owed_expr, received_expr,
        IndentItem.quantity, IndentItem.approved_quantity, IndentItem.allocated_quantity,
        Indent.required_date, Indent.priority,
        Indent.requested_by_name, Indent.department_name, Indent.project_name,
    )

    lines_rows = (await db.execute(base)).all()
    if not lines_rows:
        return _empty(params)

    line_ids = [r.indent_item_id for r in lines_rows]
    indent_ids = list({r.indent_id for r in lines_rows})

    # ── PO quantities outstanding per indent_item ──────────────────────────
    po_stmt = (
        select(
            POItem.indent_item_id.label("indent_item_id"),
            PurchaseOrder.id.label("po_id"),
            PurchaseOrder.po_no.label("po_no"),
            PurchaseOrder.status.label("po_status"),
            func.sum(POItem.quantity - POItem.received_quantity).label("po_qty"),
        )
        .join(PurchaseOrder, PurchaseOrder.id == POItem.po_id)
        .where(
            POItem.indent_item_id.in_(line_ids),
            PurchaseOrder.status.in_(PO_OPEN),
            POItem.quantity > POItem.received_quantity,
        )
        .group_by(POItem.indent_item_id, PurchaseOrder.id, PurchaseOrder.po_no,
                  PurchaseOrder.status)
    )
    po_by_line: dict[int, Decimal] = {}
    po_docs_by_line: dict[int, list[dict]] = {}
    for r in (await db.execute(po_stmt)).all():
        po_by_line[r.indent_item_id] = po_by_line.get(r.indent_item_id, _d(0)) + _d(r.po_qty)
        po_docs_by_line.setdefault(r.indent_item_id, []).append({
            "kind": "PO", "id": r.po_id, "no": r.po_no, "status": r.po_status,
            "qty": float(_d(r.po_qty)),
        })

    # ── Allocations still awaiting approval (the desk's, not procurement's) ──
    committed_by_line: dict[int, Decimal] = {
        r.indent_item_id: _d(r.qty) for r in (await db.execute(
            select(AllocationItem.indent_item_id.label("indent_item_id"),
                   func.sum(AllocationItem.quantity).label("qty"))
            .join(Allocation, Allocation.id == AllocationItem.allocation_id)
            .where(AllocationItem.indent_item_id.in_(line_ids),
                   Allocation.status.in_(UNAPPROVED_ALLOCATION_STATUSES))
            .group_by(AllocationItem.indent_item_id)
        )).all()
    }

    # ── Requisition quantities per indent_item × status ────────────────────
    req_stmt = (
        select(
            RequisitionItem.indent_item_id.label("indent_item_id"),
            Requisition.id.label("requisition_id"),
            Requisition.status.label("req_status"),
            Requisition.req_no.label("req_no"),
            RequisitionItem.requisition_id.label("req_id"),
            func.sum(
                RequisitionItem.quantity - func.coalesce(RequisitionItem.ordered_qty, 0)
            ).label("rem_qty"),
        )
        .join(Requisition, Requisition.id == RequisitionItem.requisition_id)
        .where(
            RequisitionItem.indent_item_id.in_(line_ids),
            Requisition.status.in_(REQ_SANCTIONED),
            RequisitionItem.quantity > func.coalesce(RequisitionItem.ordered_qty, 0),
        )
        .group_by(
            RequisitionItem.indent_item_id,
            Requisition.id,
            Requisition.status,
            Requisition.req_no,
            RequisitionItem.requisition_id,
        )
    )
    req_rows = (await db.execute(req_stmt)).all()

    # {indent_item_id: {req_status: qty}}
    req_by_line: dict[int, dict[str, Decimal]] = {}
    # {indent_item_id: total_requisition_qty_for_netting}
    req_total_by_line: dict[int, Decimal] = {}
    # {indent_item_id: {req_id: {status, qty, req_no}}} for docs[]
    req_docs_by_line: dict[int, list[dict]] = {}

    for r in req_rows:
        iid = r.indent_item_id
        req_by_line.setdefault(iid, {})
        req_by_line[iid][r.req_status] = req_by_line[iid].get(r.req_status, _d(0)) + _d(r.rem_qty)
        req_total_by_line[iid] = req_total_by_line.get(iid, _d(0)) + _d(r.rem_qty)
        req_docs_by_line.setdefault(iid, [])
        req_docs_by_line[iid].append({
            "kind": _req_status_to_stage(r.req_status),
            "id": r.requisition_id,
            "no": r.req_no,
            "status": r.req_status,
            "qty": float(_d(r.rem_qty)),
        })

    # ── MR quantities per indent_item (live, not settled) ─────────────────
    from app.modules.indents.service import _SETTLED_MR_STATUSES  # noqa — private but same module family
    mr_stmt = (
        select(
            MaterialRequestItem.indent_item_id.label("indent_item_id"),
            MaterialRequest.id.label("mr_id"),
            MaterialRequest.mr_no.label("mr_no"),
            MaterialRequest.status.label("mr_status"),
            func.sum(
                MaterialRequestItem.quantity - func.coalesce(MaterialRequestItem.ordered_quantity, 0)
            ).label("mr_rem"),
        )
        .join(MaterialRequest, MaterialRequest.id == MaterialRequestItem.mr_id)
        .where(
            MaterialRequestItem.indent_item_id.in_(line_ids),
            MaterialRequest.status.notin_(_SETTLED_MR_STATUSES),
            MaterialRequestItem.quantity > func.coalesce(MaterialRequestItem.ordered_quantity, 0),
        )
        .group_by(
            MaterialRequestItem.indent_item_id,
            MaterialRequest.id, MaterialRequest.mr_no, MaterialRequest.status,
        )
    )
    mr_rows = (await db.execute(mr_stmt)).all()

    mr_by_line: dict[int, Decimal] = {}
    mr_docs_by_line: dict[int, list[dict]] = {}
    for r in mr_rows:
        iid = r.indent_item_id
        mr_by_line[iid] = mr_by_line.get(iid, _d(0)) + _d(r.mr_rem)
        mr_docs_by_line.setdefault(iid, [])
        mr_docs_by_line[iid].append({
            "kind": "MR",
            "id": r.mr_id,
            "no": r.mr_no,
            "status": r.mr_status,
            "qty": float(_d(r.mr_rem)),
        })

    # ── Build per-line stage breakdown ────────────────────────────────────
    line_data: list[dict] = []
    for r in lines_rows:
        iid = r.indent_item_id
        owed = _d(r.owed_qty)
        received = _d(r.received_qty)

        # MR netting: qty already in a requisition must not count as MR too
        mr_gross = mr_by_line.get(iid, _d(0))
        req_total = req_total_by_line.get(iid, _d(0))
        mr_net = max(_d(0), mr_gross - req_total)

        stages = _net_stages(
            owed=owed,
            received=received,
            po_qty=po_by_line.get(iid, _d(0)),
            req_qty_by_status=req_by_line.get(iid, {}),
            mr_net_qty=mr_net,
            # Allocated and not yet received, plus allocations awaiting approval: the
            # warehouse pool's share. Every unit reaches an indent through a warehouse
            # issue, so `received` is already inside `allocated`.
            served_from_stock=max(_d(0), _d(r.allocated_qty) - received)
            + committed_by_line.get(iid, _d(0)),
        )

        if not stages:
            continue  # fully received line slipped through — skip

        dominant = max(stages, key=lambda k: stages[k])
        docs: list[dict] = []
        docs.extend(mr_docs_by_line.get(iid, []))
        docs.extend(req_docs_by_line.get(iid, []))
        docs.extend(po_docs_by_line.get(iid, []))

        line_data.append({
            "indent_id": r.indent_id,
            "indent_no": r.indent_no,
            "indent_item_id": iid,
            "item_id": r.item_id,
            "item_code": r.item_code,
            "item_name": r.item_name,
            "uom_code": r.uom_code,
            "requested_qty": float(_d(r.requested_qty)),
            "owed_qty": float(owed),
            "stage": dominant,
            "stages": {k: float(v) for k, v in stages.items()},
            "required_date": r.required_date,
            "priority": r.priority,
            "requested_by_name": r.requested_by_name,
            "department_name": r.department_name,
            "project_name": r.project_name,
            "docs": docs,
        })

    if not line_data:
        return _empty(params)

    # ── filter by stage (when a KPI tile clicks through) ──────────────────
    if stage:
        line_data = [l for l in line_data if stage in l["stages"]]

    # ── Group by item ──────────────────────────────────────────────────────
    from collections import defaultdict
    groups_map: dict[int, dict] = {}
    for line in line_data:
        iid = line["item_id"]
        if iid not in groups_map:
            groups_map[iid] = {
                "item_id": iid,
                "item_code": line["item_code"],
                "item_name": line["item_name"],
                "uom_code": line["uom_code"],
                "total_qty": 0.0,
                "indent_count": 0,
                "stage_summary": defaultdict(float),
                "earliest_required": None,
                "sources": [],
            }
        g = groups_map[iid]
        g["total_qty"] += line["owed_qty"]
        g["indent_count"] += 1
        for st, qty in line["stages"].items():
            g["stage_summary"][st] += qty
        req_date = line["required_date"]
        if req_date and (g["earliest_required"] is None or req_date < g["earliest_required"]):
            g["earliest_required"] = req_date
        g["sources"].append(line)

    groups_all = sorted(groups_map.values(), key=lambda g: g["item_id"])

    # ── Stage totals (whole pool, before pagination) ───────────────────────
    stage_totals: dict[str, float] = {}
    indent_count_total = len({l["indent_id"] for l in line_data})
    for g in groups_all:
        for st, qty in g["stage_summary"].items():
            stage_totals[st] = stage_totals.get(st, 0.0) + qty
        g["stage_summary"] = dict(g["stage_summary"])

    # ── Paginate over groups ───────────────────────────────────────────────
    total = len(groups_all)
    offset = params.offset
    groups_page = groups_all[offset: offset + params.size]

    return {
        "groups": groups_page,
        "group_count": total,
        "indent_count": indent_count_total,
        "stage_totals": stage_totals,
        "page": params.page,
        "size": params.size,
        "total": total,
    }


def _req_status_to_stage(status: str) -> str:
    if status == "RFQ_RAISED":
        return "RFQ"
    if status == "CONSOLIDATED":
        return "CONSOLIDATION"
    return "REQUISITION"


def _empty(params: PageParams) -> dict:
    return {
        "groups": [],
        "group_count": 0,
        "indent_count": 0,
        "stage_totals": {},
        "page": params.page,
        "size": params.size,
        "total": 0,
    }
