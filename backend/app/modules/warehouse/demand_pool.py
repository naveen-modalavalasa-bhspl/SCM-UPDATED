"""Warehouse Demand Pool — read-only triage view over the outward chain.

Every outstanding indent quantity appears in exactly one stage of exactly one pool.
This module owns the WAREHOUSE half:

    TO_ISSUE → IN_ISSUE → ISSUED → OUTWARD_QC → CONSIGNMENT → IN_TRANSIT → DELIVERED
    (quantity exits when the requester acknowledges: received_quantity ≥ owed)

INVARIANT (failing-silently list — test in tests/test_demand_pool.py §9):
    owed(line) = Σ warehouse_stage_qty + Σ procurement_stage_qty + received_quantity

Import legality (rule 5 — chain: inventory → indents → procurement → … → warehouse):
    Warehouse sits last so this file may import everything.

Nothing here writes, reserves, approves or wakes any document.
"""
from __future__ import annotations

from decimal import Decimal

from sqlalchemy import and_, func, or_, select, true
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.pagination import PageParams
from app.modules.indents.models import Indent, IndentItem
from app.modules.indents.service import indent_access_condition
from app.modules.inventory.allocations import SETTLED_ALLOCATION_STATUSES
from app.modules.inventory.models import Allocation, AllocationItem
from app.modules.warehouse.enums import (
    DEAD_ISSUE_STATUSES,
    GONE_OUT_ISSUE_STATUSES,
    DispatchStatus,
    IssueStatus,
    QcStatus,
)
from app.modules.warehouse.models import Dispatch, DispatchItem, MaterialIssue, MaterialIssueLine


# ---------------------------------------------------------------------------
# Stage labels — served by GET /api/warehouse/demand-pool/stages
# ---------------------------------------------------------------------------

WAREHOUSE_STAGES: tuple[dict, ...] = (
    {
        "stage": "TO_ISSUE",
        "label": "To Issue",
        "tone": "neutral",
        "hint": "Allocation signed; material issue not yet drafted.",
        "deep_link": "/inventory/fulfilment",
    },
    {
        "stage": "IN_ISSUE",
        "label": "In Issue",
        "tone": "warning",
        "hint": "Material issue drafted or pending approval — stock not yet posted.",
        "deep_link": "/warehouse/material-issues",
    },
    {
        "stage": "ISSUED",
        "label": "Issued",
        "tone": "info",
        "hint": "Stock posted; no outbound consignment yet.",
        "deep_link": "/warehouse/material-issues",
    },
    {
        "stage": "OUTWARD_QC",
        "label": "Outward QC",
        "tone": "warning",
        "hint": "Open outbound inspection in progress.",
        "deep_link": "/warehouse/qc-outward",
    },
    {
        "stage": "CONSIGNMENT",
        "label": "Consignment",
        "tone": "info",
        "hint": "Consignment packed; not yet dispatched.",
        "deep_link": "/logistics/activity",
    },
    {
        "stage": "IN_TRANSIT",
        "label": "In Transit",
        "tone": "info",
        "hint": "Vehicle on the road.",
        "deep_link": "/logistics/activity",
    },
    {
        "stage": "DELIVERED",
        "label": "Delivered",
        "tone": "success",
        "hint": "Arrived at site; waiting for requester to acknowledge.",
        "deep_link": "/indents/acknowledgements",
    },
)

# Dispatch statuses that mean the goods are on the way or arrived
_DISPATCH_TRANSIT = (
    DispatchStatus.DISPATCHED.value,
    DispatchStatus.IN_TRANSIT.value,
)
_DISPATCH_DELIVERED = (
    DispatchStatus.DELIVERED.value,
    DispatchStatus.ACKNOWLEDGED.value,
)
_DISPATCH_PACKED = (DispatchStatus.PACKED.value,)


def _d(v) -> Decimal:
    return Decimal(str(v or 0))


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
    """Item-wise warehouse demand pool.

    Returns the spec §7 JSON shape — groups[], group_count, indent_count,
    stage_totals, page, size, total.

    Only quantities that have a SIGNED allocation (SETTLED_ALLOCATION_STATUSES)
    and have not yet been fully acknowledged appear here.  Everything still in
    an unsigned allocation (DRAFT/PENDING_APPROVAL) belongs to the procurement
    pool's TO_SOURCE bucket until the signature lands.
    """
    # ── scope ──────────────────────────────────────────────────────────────
    indent_scope = (
        await indent_access_condition(db, user)
        if user is not None else true()
    )

    # ── 1. Open indent lines that have a signed allocation ─────────────────
    owed_expr = func.coalesce(IndentItem.approved_quantity, IndentItem.quantity)
    received_expr = func.coalesce(IndentItem.received_quantity, 0)

    base_stmt = (
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
            func.coalesce(IndentItem.allocated_quantity, 0).label("allocated_qty"),
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
            owed_expr > received_expr,
            # Only lines with at least one signed allocation enter the warehouse pool.
            # We check via a subquery so we don't explode the grouping.
            IndentItem.id.in_(
                select(AllocationItem.indent_item_id)
                .join(Allocation, Allocation.id == AllocationItem.allocation_id)
                .where(Allocation.status.in_(SETTLED_ALLOCATION_STATUSES))
                .distinct()
            ),
        )
    )
    if project_id:
        base_stmt = base_stmt.where(Indent.project_id == project_id)
    if warehouse_id:
        base_stmt = base_stmt.where(Indent.warehouse_id == warehouse_id)
    if search:
        pat = f"%{search}%"
        base_stmt = base_stmt.where(or_(
            IndentItem.item_code.ilike(pat),
            IndentItem.item_name.ilike(pat),
            Indent.indent_no.ilike(pat),
        ))
    if item_id:
        base_stmt = base_stmt.where(IndentItem.item_id == item_id)

    base_stmt = base_stmt.group_by(
        IndentItem.id, IndentItem.indent_id, Indent.indent_no,
        IndentItem.item_id, owed_expr, received_expr,
        IndentItem.quantity, IndentItem.approved_quantity,
        IndentItem.allocated_quantity,
        Indent.required_date, Indent.priority,
        Indent.requested_by_name, Indent.department_name, Indent.project_name,
    )

    lines_rows = (await db.execute(base_stmt)).all()
    if not lines_rows:
        return _empty(params)

    line_ids = [r.indent_item_id for r in lines_rows]

    # ── 2. Live issue lines per indent_item (all non-dead statuses) ─────────
    issue_stmt = (
        select(
            MaterialIssueLine.indent_item_id.label("indent_item_id"),
            MaterialIssue.id.label("issue_id"),
            MaterialIssue.issue_no.label("issue_no"),
            MaterialIssue.status.label("issue_status"),
            MaterialIssue.is_stock_posted.label("is_stock_posted"),
            MaterialIssue.qc_status.label("qc_status"),
            MaterialIssue.indent_id.label("issue_indent_id"),
            func.sum(MaterialIssueLine.issued_qty).label("issued_qty"),
            func.sum(MaterialIssueLine.requested_qty).label("requested_qty"),
        )
        .join(MaterialIssue, MaterialIssue.id == MaterialIssueLine.issue_id)
        .where(
            MaterialIssueLine.indent_item_id.in_(line_ids),
            MaterialIssue.direction == "OUT",
            MaterialIssue.status.notin_(DEAD_ISSUE_STATUSES),
        )
        .group_by(
            MaterialIssueLine.indent_item_id,
            MaterialIssue.id, MaterialIssue.issue_no, MaterialIssue.status,
            MaterialIssue.is_stock_posted, MaterialIssue.qc_status,
            MaterialIssue.indent_id,
        )
    )
    issue_rows = (await db.execute(issue_stmt)).all()

    # {indent_item_id: [{issue_id, issue_no, status, is_stock_posted, qc_status, qty}]}
    issues_by_line: dict[int, list[dict]] = {}
    issue_ids_of_interest: set[int] = set()
    for r in issue_rows:
        issues_by_line.setdefault(r.indent_item_id, []).append({
            "issue_id": r.issue_id,
            "issue_no": r.issue_no,
            "status": r.issue_status,
            "is_stock_posted": r.is_stock_posted,
            "qc_status": r.qc_status,
            "qty": _d(r.issued_qty or r.requested_qty),
        })
        if r.is_stock_posted:
            issue_ids_of_interest.add(r.issue_id)

    # ── 3. Consignments / dispatches linked to those issues ─────────────────
    # out_dispatches.ref_type = 'WH_ISSUE' / 'MATERIAL_ISSUE'; ref_id = issue.id
    dispatch_by_issue: dict[int, dict] = {}
    if issue_ids_of_interest:
        disp_stmt = (
            select(
                Dispatch.ref_id.label("issue_id"),
                Dispatch.id.label("dispatch_id"),
                Dispatch.dispatch_no.label("dispatch_no"),
                Dispatch.status.label("dispatch_status"),
            )
            .where(
                Dispatch.ref_type.in_(["WH_ISSUE", "MATERIAL_ISSUE"]),
                Dispatch.ref_id.in_(list(issue_ids_of_interest)),
                Dispatch.status.notin_([
                    DispatchStatus.CANCELLED.value,
                    DispatchStatus.REJECTED.value,
                ]),
            )
        )
        for r in (await db.execute(disp_stmt)).all():
            # Keep the furthest-along dispatch per issue
            existing = dispatch_by_issue.get(r.issue_id)
            if existing is None or _dispatch_rank(r.dispatch_status) > _dispatch_rank(existing["status"]):
                dispatch_by_issue[r.issue_id] = {
                    "dispatch_id": r.dispatch_id,
                    "dispatch_no": r.dispatch_no,
                    "status": r.dispatch_status,
                }

    # ── 4. Build per-line stage ─────────────────────────────────────────────
    line_data: list[dict] = []
    for r in lines_rows:
        iid = r.indent_item_id
        owed = _d(r.owed_qty)
        received = _d(r.received_qty)
        outstanding = max(_d(0), owed - received)
        if outstanding <= 0:
            continue

        issue_list = issues_by_line.get(iid, [])

        # Stage bucket: furthest-along wins per unit
        stages: dict[str, Decimal] = {}
        docs: list[dict] = []

        for iss in issue_list:
            qty = iss["qty"]
            issue_stage = _classify_issue(iss, dispatch_by_issue)
            stages[issue_stage] = stages.get(issue_stage, _d(0)) + qty
            docs.append({
                "kind": "ISSUE",
                "id": iss["issue_id"],
                "no": iss["issue_no"],
                "status": iss["status"],
                "qty": float(qty),
                "stage": issue_stage,
            })

        # TO_ISSUE: allocated quantity not yet covered by any live issue
        live_issue_total = sum(stages.values(), _d(0))
        allocated = _d(r.allocated_qty)
        to_issue = max(_d(0), min(allocated, outstanding) - live_issue_total)
        if to_issue > 0:
            stages["TO_ISSUE"] = to_issue

        if not stages:
            continue

        dominant = max(stages, key=lambda k: stages[k])
        line_data.append({
            "indent_id": r.indent_id,
            "indent_no": r.indent_no,
            "indent_item_id": iid,
            "item_id": r.item_id,
            "item_code": r.item_code,
            "item_name": r.item_name,
            "uom_code": r.uom_code,
            "requested_qty": float(_d(r.requested_qty)),
            "owed_qty": float(outstanding),
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

    # ── filter by stage ────────────────────────────────────────────────────
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

    # ── Stage totals ───────────────────────────────────────────────────────
    stage_totals: dict[str, float] = {}
    indent_count_total = len({l["indent_id"] for l in line_data})
    for g in groups_all:
        for st, qty in g["stage_summary"].items():
            stage_totals[st] = stage_totals.get(st, 0.0) + qty
        g["stage_summary"] = dict(g["stage_summary"])

    # ── Paginate ───────────────────────────────────────────────────────────
    total = len(groups_all)
    groups_page = groups_all[params.offset: params.offset + params.size]

    return {
        "groups": groups_page,
        "group_count": total,
        "indent_count": indent_count_total,
        "stage_totals": stage_totals,
        "page": params.page,
        "size": params.size,
        "total": total,
    }


def _classify_issue(iss: dict, dispatch_by_issue: dict[int, dict]) -> str:
    """Return the furthest-along warehouse stage for one issue row."""
    status = iss["status"]

    # Fully dispatched / acknowledged → DELIVERED (awaiting requester ACK)
    if status in GONE_OUT_ISSUE_STATUSES:
        dispatch = dispatch_by_issue.get(iss["issue_id"])
        if dispatch and dispatch["status"] in _DISPATCH_DELIVERED:
            return "DELIVERED"
        if dispatch and dispatch["status"] in _DISPATCH_TRANSIT:
            return "IN_TRANSIT"
        if dispatch and dispatch["status"] in _DISPATCH_PACKED:
            return "CONSIGNMENT"
        return "ISSUED"

    # Stock posted but still in an open issue
    if iss["is_stock_posted"]:
        dispatch = dispatch_by_issue.get(iss["issue_id"])
        if dispatch:
            ds = dispatch["status"]
            if ds in _DISPATCH_DELIVERED:
                return "DELIVERED"
            if ds in _DISPATCH_TRANSIT:
                return "IN_TRANSIT"
            if ds in _DISPATCH_PACKED:
                return "CONSIGNMENT"
        # Check outward QC
        if iss["qc_status"] in (QcStatus.PENDING.value, QcStatus.PARTIAL.value):
            return "OUTWARD_QC"
        return "ISSUED"

    # Not yet posted → IN_ISSUE
    return "IN_ISSUE"


def _dispatch_rank(status: str) -> int:
    """Higher = further along. Used to keep the furthest dispatch per issue."""
    order = {
        DispatchStatus.DRAFT.value: 0,
        DispatchStatus.PENDING_APPROVAL.value: 1,
        DispatchStatus.APPROVED.value: 2,
        DispatchStatus.PACKED.value: 3,
        DispatchStatus.DISPATCHED.value: 4,
        DispatchStatus.IN_TRANSIT.value: 4,
        DispatchStatus.DELIVERED.value: 5,
        DispatchStatus.ACKNOWLEDGED.value: 6,
    }
    return order.get(status, 0)


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
