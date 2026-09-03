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

import re
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import String, cast, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import Base
from app.platform.workflow.ladder import MODULE_BY_DOC_TYPE
from app.platform.workflow.models import Action, Instance, Workflow
from app.shared.enums import DocType
from app.shared.models.master import Project


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

#: The compact code each document type wears as a badge on the tracking screens — the
#: short form a desk actually says (IND, ALL, MR). Declared on the data rather than
#: written as screen conditionals, so a new document type is one entry here and never
#: a new `if` in the frontend; a type missing from the map simply shows its NODES
#: label instead, and the screen loses nothing.
DOCTYPE_CODES: dict[str, str] = {
    DocType.INDENT.value: "IND",
    DocType.ALLOCATION.value: "ALL",
    DocType.MR.value: "MR",
    DocType.REQUISITION.value: "REQ",
    DocType.CONSOLIDATION.value: "CONS",
    DocType.RFQ.value: "RFQ",
    DocType.PO.value: "PO",
    DocType.GRN.value: "GRN",
    DocType.QC_OUTWARD.value: "QC",
    DocType.WH_ISSUE.value: "ISSUE",
    DocType.DISPATCH.value: "DISP",
    DocType.TRANSPORT_REQUEST.value: "SHIP",
}


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


async def rows_by_id(db: AsyncSession, node_key: str,
                     ids) -> dict[int, dict]:
    """Several documents of ONE kind, shaped the way the trail shapes them.

    The same read as `_row`, batched: the Attachments dashboard resolves a page of
    files to their parent documents, and one query per document type beats one per
    file. Public because it is the one way another screen should learn a document's
    number, status and screen path — `NODES` already declares all three, and a second
    copy of that map is how a chip and a button end up disagreeing.
    """
    node = BY_KEY.get(node_key)
    wanted = {int(i) for i in ids or [] if i is not None}
    if node is None or not wanted:
        return {}
    table = _table(node)
    if table is None or node.no_col not in table.c:
        return {}
    cols = _cols(node, table)
    rows = (await db.execute(
        select(*cols.values()).where(table.c.id.in_(wanted)))).all()
    shaped = [_shape(node, cols, row) for row in rows]
    return {row["id"]: row for row in shaped}


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


# --------------------------------------------------------------------------- #
# The approval ladder a document ran under.
#
# `wf_instances` carries the id of the workflow version the document was resolved
# against, frozen at submit time (rule 8: editing a ladder never moves a document
# already in approval). So what this reports is the ladder that actually governed the
# sign-off, not whatever an admin has since saved on Approvals Config. Read-only like
# everything else here — SELECTs over rows that already exist, nothing written for the
# screen's benefit.
# --------------------------------------------------------------------------- #

def ladder_payload(doc_type: str, workflow: Workflow,
                   project_name: str | None) -> dict:
    """What the tracking screens say about one document's ladder.

    Every value is read off the workflow row the instance points at — the screen
    formats what arrives, it never guesses a version or a project from the doc type.
    `project` is the ladder's own project scope (the snapshot on `wf_workflows`);
    `module` falls back to the doc-type map for chains saved before the column was
    written.
    """
    return {
        "doctype": doc_type,
        "doctype_code": DOCTYPE_CODES.get(doc_type),
        "approval_ladder_version": workflow.version,
        "approval_ladder_label": f"Approval Ladder v{workflow.version}",
        "ladder_name": workflow.name,
        "ladder_code": workflow.code,
        "project": project_name,
        "project_id": workflow.project_id,
        "module": workflow.module or MODULE_BY_DOC_TYPE.get(doc_type),
    }


async def approval_meta(db: AsyncSession, refs) -> dict[tuple[str, int], dict]:
    """The ladder each ``(doc_type, doc_id)`` runs on, in as few queries as it can.

    One query per document type present in the batch, instances joined to their
    workflow; the newest instance wins, because a return-for-correction resubmit opens
    a new run on the same document and the newest run is the one that says where the
    document stands. A workflow scoped to no project (the company-wide default) has no
    project to name; one carrying a project id with an empty name snapshot gets the
    name read off `mst_projects` — one extra query for every missing name in the
    batch, not one per row.
    """
    by_type: dict[str, set[int]] = {}
    for doc_type, doc_id in refs or []:
        if doc_type and doc_id is not None:
            by_type.setdefault(doc_type, set()).add(int(doc_id))
    found: dict[tuple[str, int], dict] = {}
    if not by_type:
        return found

    needs_project: dict[tuple[str, int], int] = {}
    for doc_type, ids in by_type.items():
        rows = (await db.execute(
            select(Instance, Workflow)
            .join(Workflow, Workflow.id == Instance.workflow_id)
            .where(Instance.doc_type == doc_type, Instance.doc_id.in_(list(ids)))
            .order_by(Instance.id.desc())
        )).all()
        for instance, workflow in rows:
            key = (doc_type, int(instance.doc_id))
            if key in found:
                continue
            if not workflow.project_name and workflow.project_id:
                needs_project[key] = int(workflow.project_id)
            found[key] = ladder_payload(doc_type, workflow, workflow.project_name)

    if needs_project:
        names = dict((await db.execute(
            select(Project.id, Project.name)
            .where(Project.id.in_(sorted(set(needs_project.values()))))
        )).all())
        for key, project_id in needs_project.items():
            found[key]["project"] = names.get(project_id)
    return found


async def attach_approval(db: AsyncSession, rows: list[dict]) -> list[dict]:
    """Stamp each shaped row with the ladder it ran under and where to open it.

    `approval` is None when the document was never submitted — a draft has run no
    ladder, which is an answer and not a gap, and the screen says so rather than
    inventing one. `navigation_route` is the same path the trail's open button already
    uses (resolved by NODES), so the chip and the button can never disagree about
    where a click lands.
    """
    metas = await approval_meta(
        db, [(row.get("doc_type"), row.get("id")) for row in rows])
    for row in rows:
        meta = metas.get((row.get("doc_type"), row.get("id")))
        row["doctype_code"] = DOCTYPE_CODES.get(row.get("doc_type"))
        row["approval"] = ({**meta, "navigation_route": row.get("path")}
                           if meta else None)
    return rows


#: A serial as a person says it, behind whatever prefix the number wears.
#:
#: An indent number is ``BHS/104/2026-27/IND0001`` or ``IND/2026-27/00001``; the part
#: anybody reads out is the serial at the end, and ``1``, ``01``, ``0001`` and
#: ``IND0024`` all mean the same document. The pattern anchors the serial to the END of
#: the number and requires a NON-DIGIT (or the string start) before the leading zeros,
#: so searching 24 finds IND0024 and never IND0124.
#:
#: `regexp_match` (MySQL 8 REGEXP) rather than REGEXP_REPLACE + CAST: it is already
#: what `inventory.locations` matches warehouse codes with, so nothing new is asked of
#: the server.
def _serial_pattern(serial: int) -> str:
    return rf"(^|[^0-9])0*{serial}$"


async def _search_by_serial(db: AsyncSession, node: NodeSpec, term: str,
                            limit: int) -> list[dict]:
    """One document kind, found by the serial number a person actually says.

    An empty term lists the register newest-first, which is the landing view of the
    tracking screens: a reader arrives at every indent and picks one. A term with no
    digits in it matches nothing — this mode reads numbers, and saying so beats
    returning the whole register as though it had understood.
    """
    table = _table(node)
    if table is None or node.no_col not in table.c:
        return []
    cols = _cols(node, table)
    stmt = select(*cols.values())
    if term:
        digits = re.search(r"(\d+)\s*$", term) or re.search(r"(\d+)", term)
        if digits is None:
            return []
        stmt = stmt.where(
            table.c[node.no_col].regexp_match(_serial_pattern(int(digits.group(1)))))
    rows = (await db.execute(stmt.order_by(table.c.id.desc()).limit(limit))).all()
    return [_shape(node, cols, row) for row in rows]


async def search(db: AsyncSession, query: str, limit: int = 25,
                 kind: str | None = None) -> list[dict]:
    """Every document whose number matches, across every kind on the trail.

    A partial number is enough — a person reading a printed gate pass types the tail
    of it, not the whole thing.

    `kind` narrows to ONE document type and reads the term as a serial number instead
    (see `_search_by_serial`). That is what the Live Tracking board asks for: it
    tracks indents, so sweeping POs, allocations, MRs and GRNs for the same digits
    would flood a screen that can only open an indent. Without `kind` the behaviour is
    exactly what the Document Trail has always had — partial match, every kind, exact
    hits first — so the two screens share one endpoint without sharing one answer.

    `limit` is clamped here rather than at the route (rule 2 — a router carries no
    `if`), and the ceiling follows the mode: 50 for a trail lookup, where somebody
    typed a number and wants the document, and 500 for the register listing, which is
    a screen of rows. A caller's `limit` only ever narrows that.
    """
    term = (query or "").strip()
    limit = min(max(limit, 1), 500 if kind else 50)
    if kind:
        node = BY_KEY.get(kind)
        return [] if node is None else await _search_by_serial(db, node, term, limit)
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
