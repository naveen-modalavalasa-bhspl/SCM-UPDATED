"""End-to-end document traceability: one number in, the whole chain out.

Type any document number — an indent, an allocation, a material request, a
requisition, an RFQ, a quotation, a purchase order, a GRN, an outward inspection, an
issue, a consignment or a transport request — and get every document connected to it,
in the order the work happened, with each one's status and its full approval history.

WHY IT LIVES IN `reports`: it reads every module's tables and nothing reads it back,
which is exactly what this package is for (rule 5). It is READ-ONLY by construction —
a union of SELECTs over documents that already exist, so it can never show an event
the documents do not carry, and nothing anywhere is written for its benefit. Same
contract `procurement.ledger` and `logistics.activity_ledger` already keep.

HOW THE CHAIN IS WALKED
-----------------------
Every document in this system points BACKWARD at the one before it — that is the
architecture's central rule, and it is what makes this possible without a graph table.
`NODES` below declares, per document type, its table, its number column, and which
columns are backward pointers to which other type.

From the document you searched for, the walk goes both ways:

  * UP    following that document's own backward pointers, and
  * DOWN  finding every document whose backward pointer names this one.

Both directions run breadth-first over a `seen` set, so a diamond — a PO that points
at an indent, a requisition AND a quotation, all of which trace back to the same
indent — is visited once rather than looping forever.

RBAC
----
Gated on `report.view`, like every other ledger here. That is deliberate and worth
saying out loud: this screen crosses every module by design, so gating it on any one
module's permission would be wrong in both directions — it would lock out somebody who
legitimately traces a consignment, and it would let a warehouse login read purchase
prices through the PO node. `report.view` is the permission that means "may read
across the company", and the chain is exactly that.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import String, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import Base
from app.platform.workflow.models import Action, Instance
from app.shared.enums import DocType


@dataclass(frozen=True)
class NodeSpec:
    """One kind of document on the trail."""
    key: str                      # stable id used by the screen
    label: str                    # what a person calls it
    table: str                    # the table it lives in
    no_col: str                   # its own document number
    #: DocType this is filed under in `wf_instances`, when it has an approval at all.
    #: None for documents nobody signs (a quotation is the vendor's paper).
    doc_type: str | None = None
    #: Backward pointers: {column on THIS table: key of the node it points at}.
    parents: dict[str, str] = field(default_factory=dict)
    date_col: str | None = None
    status_col: str | None = "status"
    #: Where the screen sends a reader who clicks the node.
    path: str | None = None


#: The trail, in the order the work happens. Declared as data rather than written as
#: joins because the shape is the business's, not SQL's — a new document type is one
#: entry here and needs no new query.
NODES: list[NodeSpec] = [
    NodeSpec("indent", "Indent", "ind_indents", "indent_no",
             DocType.INDENT.value, {}, "indent_date", path="/indents/{id}"),
    NodeSpec("consolidation_ind", "Indent Consolidation", "ind_consolidations",
             "consolidation_no", None, {"consolidation_id": "indent"}, "created_at"),
    NodeSpec("allocation", "Material Allocation", "inv_allocations", "allocation_no",
             DocType.ALLOCATION.value, {"indent_id": "indent"}, "created_at",
             path="/inventory/allocation-approvals/{id}"),
    NodeSpec("mr", "Material Request", "inv_material_requests", "mr_no",
             DocType.MR.value, {"indent_id": "indent"}, "created_at",
             path="/inventory/material-requests/{id}"),
    NodeSpec("requisition", "Requisition", "pro_requisitions", "req_no",
             DocType.REQUISITION.value, {"source_mr_id": "mr"}, "req_date",
             path="/procurement/requisitions/{id}"),
    NodeSpec("pro_consolidation", "Purchase Consolidation", "pro_consolidations",
             "cons_no", DocType.CONSOLIDATION.value, {}, "cons_date",
             path="/procurement/consolidations/{id}"),
    NodeSpec("rfq", "RFQ", "pro_rfqs", "rfq_no", DocType.RFQ.value,
             {"requisition_id": "requisition", "consolidation_id": "pro_consolidation"},
             "rfq_date", path="/procurement/rfqs/{id}"),
    NodeSpec("quotation", "Quotation", "pro_quotations", "quotation_no", None,
             {"rfq_id": "rfq"}, "quotation_date", path="/procurement/rfqs/{rfq_id}"),
    NodeSpec("po", "Purchase Order", "pro_purchase_orders", "po_no",
             DocType.PO.value,
             {"indent_id": "indent", "requisition_id": "requisition",
              "rfq_id": "rfq", "quotation_id": "quotation"},
             "po_date", path="/pos/{id}"),
    NodeSpec("grn", "Goods Receipt", "inb_receipts", "grn_no", DocType.GRN.value,
             {"po_id": "po"}, "created_at", path="/warehouse/grn/{id}"),
    NodeSpec("inspection", "Outward Inspection", "whs_inspections", "inspection_no",
             DocType.QC_OUTWARD.value, {"issue_id": "issue"}, "created_at",
             path="/warehouse/qc-outward/{id}"),
    NodeSpec("issue", "Material Issue", "out_issues", "issue_no",
             DocType.WH_ISSUE.value, {"indent_id": "indent"}, "created_at",
             path="/warehouse/material-issues/{id}"),
    NodeSpec("dispatch", "Consignment", "out_dispatches", "dispatch_no",
             DocType.DISPATCH.value, {}, "created_at",
             path="/logistics/consignments/{id}"),
    NodeSpec("transport", "Shipment", "lgs_transport_requests", "tr_no",
             DocType.TRANSPORT_REQUEST.value,
             {"dispatch_id": "dispatch", "issue_id": "issue", "indent_id": "indent"},
             "created_at", path="/logistics/shipments/{id}"),
]

BY_KEY = {node.key: node for node in NODES}
#: Reverse index: for each node, who points AT it. Built once so the downward walk is
#: a lookup rather than a scan of every spec on every hop.
CHILDREN: dict[str, list[tuple[NodeSpec, str]]] = {}
for _node in NODES:
    for _col, _parent_key in _node.parents.items():
        CHILDREN.setdefault(_parent_key, []).append((_node, _col))


def _table(node: NodeSpec):
    return Base.metadata.tables.get(node.table)


def _available() -> list[NodeSpec]:
    """Only nodes whose table actually exists in this deployment.

    A branch that has not shipped its table yet must not take out the whole search —
    the trail is meant to answer with what it can, never to 500 because one module is
    absent.
    """
    out = []
    for node in NODES:
        table = _table(node)
        # The number column has to exist too, not just the table. A spec that names a
        # column the live schema does not carry is a mistake in NODES — but it must
        # cost that one document type, never take the whole search down with a
        # KeyError. `ind_consolidations.consolidation_no` was exactly this.
        if table is not None and node.no_col in table.c:
            out.append(node)
    return out


def _cols(node: NodeSpec, table) -> dict[str, Any]:
    """The columns this node reads, skipping any the live table does not have."""
    out = {"id": table.c.id, "no": table.c[node.no_col]}
    if node.status_col and node.status_col in table.c:
        out["status"] = table.c[node.status_col]
    if node.date_col and node.date_col in table.c:
        out["date"] = table.c[node.date_col]
    return out


async def _row(db: AsyncSession, node: NodeSpec, doc_id: int) -> dict | None:
    table = _table(node)
    if table is None or node.no_col not in table.c:
        return None
    cols = _cols(node, table)
    found = (await db.execute(
        select(*cols.values()).where(table.c.id == doc_id).limit(1))).first()
    return _shape(node, cols, found) if found else None


def _shape(node: NodeSpec, cols: dict, row) -> dict:
    data = dict(zip(cols.keys(), row))
    doc_id = int(data["id"])
    path = node.path
    if path:
        # `{rfq_id}` on a quotation: it has no screen of its own, so it opens the RFQ
        # it answers — where the comparison sheet is what gives a quote meaning.
        path = path.replace("{id}", str(doc_id))
    return {
        "key": node.key,
        "label": node.label,
        "doc_type": node.doc_type,
        "id": doc_id,
        "doc_no": data.get("no"),
        "status": data.get("status"),
        "date": data.get("date"),
        "path": None if path and "{" in path else path,
        "approvals": [],
    }


async def search(db: AsyncSession, query: str, limit: int = 25) -> list[dict]:
    """Every document whose number matches, across every kind on the trail.

    A partial number is enough — a person reading a printed gate pass types the tail
    of it, not the whole thing.
    """
    term = (query or "").strip()
    if not term:
        return []
    like = f"%{term}%"
    out: list[dict] = []
    for node in _available():
        table = _table(node)
        cols = _cols(node, table)
        rows = (await db.execute(
            select(*cols.values())
            .where(cast(table.c[node.no_col], String(100)).ilike(like))
            .limit(limit)
        )).all()
        out.extend(_shape(node, cols, row) for row in rows)
        if len(out) >= limit:
            break
    # Exact matches first: somebody who typed a whole number wants that document, not
    # the twelve others that happen to contain it.
    out.sort(key=lambda d: (str(d["doc_no"] or "").upper() != term.upper(),
                            str(d["doc_no"] or "")))
    return out[:limit]


async def _approvals(db: AsyncSession, doc_type: str | None,
                     doc_id: int) -> list[dict]:
    """The full approval history of one document, straight off `wf_actions`.

    Read rather than reconstructed: `wf_actions` is append-only (rule 9), so this is
    the record itself. A document with no ladder configured simply has none, which is
    an answer and not a gap.
    """
    if not doc_type:
        return []
    rows = (await db.execute(
        select(Action, Instance)
        .join(Instance, Instance.id == Action.instance_id)
        .where(Instance.doc_type == doc_type, Instance.doc_id == doc_id)
        .order_by(Action.id)
    )).all()
    return [{
        "action": action.action,
        "stage": action.stage_name,
        "sequence": action.stage_sequence,
        "actor": action.actor_name,
        "actor_position": action.actor_position,
        "comments": action.comments,
        "at": action.acted_at.isoformat() if action.acted_at else None,
        "instance_status": instance.status,
    } for action, instance in rows]


async def trace(db: AsyncSession, node_key: str, doc_id: int,
                max_nodes: int = 60) -> dict:
    """The whole chain around one document, both directions, each with its history.

    Breadth-first over a `seen` set. A diamond is real here — a purchase order points
    at an indent, a requisition AND a quotation, and all three trace back to the same
    indent — so without `seen` this would revisit nodes forever.

    `max_nodes` is a stop, not a page: a consignment carrying forty indents would
    otherwise expand into hundreds of documents nobody asked about. The screen says
    when it was hit.
    """
    start = BY_KEY.get(node_key)
    if start is None:
        return {"nodes": [], "edges": [], "truncated": False}

    seen: set[tuple[str, int]] = set()
    nodes: list[dict] = []
    edges: list[dict] = []
    queue: list[tuple[str, int]] = [(node_key, doc_id)]
    truncated = False

    while queue:
        if len(nodes) >= max_nodes:
            truncated = True
            break
        key, current_id = queue.pop(0)
        if (key, current_id) in seen:
            continue
        seen.add((key, current_id))
        node = BY_KEY.get(key)
        if node is None:
            continue
        row = await _row(db, node, current_id)
        if row is None:
            continue
        row["approvals"] = await _approvals(db, node.doc_type, current_id)
        row["is_root"] = (key == node_key and current_id == doc_id)
        nodes.append(row)

        table = _table(node)

        # UP — this document's own backward pointers.
        for column, parent_key in node.parents.items():
            if column not in table.c:
                continue
            parent_id = (await db.execute(
                select(table.c[column]).where(table.c.id == current_id))).scalar()
            if parent_id:
                edges.append({"from": f"{parent_key}:{int(parent_id)}",
                              "to": f"{key}:{current_id}"})
                queue.append((parent_key, int(parent_id)))

        # DOWN — everything that points AT this document.
        for child, column in CHILDREN.get(key, []):
            child_table = _table(child)
            if child_table is None or column not in child_table.c:
                continue
            child_ids = (await db.execute(
                select(child_table.c.id)
                .where(child_table.c[column] == current_id)
                .limit(max_nodes)
            )).scalars().all()
            for child_id in child_ids:
                edges.append({"from": f"{key}:{current_id}",
                              "to": f"{child.key}:{int(child_id)}"})
                queue.append((child.key, int(child_id)))

    # In the order the work happens, so the chain reads top to bottom as a story
    # rather than in the order the walk happened to reach things.
    order = {node.key: index for index, node in enumerate(NODES)}
    nodes.sort(key=lambda n: (order.get(n["key"], 99), n["id"]))
    # De-duplicated: the same pair can be reached from both directions.
    unique_edges = [{"from": a, "to": b} for a, b in
                    sorted({(e["from"], e["to"]) for e in edges})]
    return {"nodes": nodes, "edges": unique_edges, "truncated": truncated}


def doc_kinds() -> list[dict]:
    """What the trail can find, served so the screen's filter cannot drift."""
    return [{"key": n.key, "label": n.label} for n in _available()]
