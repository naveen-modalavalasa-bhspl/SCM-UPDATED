"""One declarative spec per report ledger.

Everything the API does — list, filter, search, sort, filter-option dropdowns and
CSV export — is driven from these four specs, so adding a ledger is adding a
`LedgerSpec` and nothing else. No SQL lives in `router.py` and no column list lives
in the frontend.

A spec's `source()` returns a SELECT whose columns are already named the way the
report shows them. `service.py` wraps that in a subquery and filters the subquery,
which is why the warehouse ledger (a UNION of seven document tables) filters and
searches exactly like the three single-table ones.
"""
from dataclasses import dataclass, field
from typing import Callable

from sqlalchemy import Numeric, String, Select, cast, func, literal, null, select, union_all

from app.modules.indents.models import Indent
from app.modules.inventory.models import StockMovement
from app.modules.warehouse.models import (
    Dispatch, Inspection, MaterialIssue, Picking, PurchaseReturn, PutawayTask, Receipt,
)
from app.platform.rbac import permissions as perms
from app.platform.workflow.models import Action, Instance


@dataclass(frozen=True)
class Col:
    """A column as the report shows it. `kind` tells the frontend how to render."""
    key: str
    label: str
    kind: str = "text"  # text | number | qty | date | datetime | status | direction
    narrow: bool = False  # drop first when the table runs out of width


@dataclass(frozen=True)
class Filt:
    """A filter control. `select` gets its options from DISTINCT on the column."""
    key: str
    label: str
    kind: str = "select"  # select | text
    column: str | None = None  # defaults to key

    @property
    def col(self) -> str:
        return self.column or self.key


@dataclass(frozen=True)
class LedgerSpec:
    key: str
    label: str
    subtitle: str
    permission: str
    source: Callable[[], Select]
    columns: list[Col]
    filters: list[Filt]
    search: list[str]          # columns an ILIKE search sweeps
    date_col: str              # the column the from/to date range applies to
    order_col: str             # default sort, always descending
    key_cols: list[str] = field(default_factory=list)  # what makes a row unique

    @property
    def column_keys(self) -> list[str]:
        return [c.key for c in self.columns]


# --------------------------------------------------------------------------- #
# Indents — one row per request, with who raised it and where it got to.
# --------------------------------------------------------------------------- #

def _indents_source() -> Select:
    return select(
        Indent.id.label("id"),
        Indent.indent_no.label("doc_no"),
        Indent.indent_date.label("doc_date"),
        Indent.required_date.label("required_date"),
        Indent.status.label("status"),
        Indent.priority.label("priority"),
        Indent.requested_by_name.label("raised_by"),
        Indent.department_name.label("department"),
        Indent.project_name.label("project"),
        Indent.office_name.label("office"),
        Indent.total_items.label("total_items"),
        Indent.total_qty.label("total_qty"),
        Indent.current_approver_name.label("pending_with"),
        Indent.approved_at.label("approved_at"),
        Indent.remarks.label("remarks"),
        Indent.created_at.label("created_at"),
        Indent.updated_at.label("updated_at"),
    )


INDENTS = LedgerSpec(
    key="indents",
    label="Indents",
    subtitle="Every material request raised, who raised it and where it stands",
    permission=perms.INDENT_VIEW,
    source=_indents_source,
    columns=[
        Col("doc_no", "Indent No"),
        Col("doc_date", "Date", "date"),
        Col("status", "Status", "status"),
        Col("priority", "Priority", "status", narrow=True),
        Col("raised_by", "Raised by"),
        Col("department", "Department"),
        Col("project", "Project", narrow=True),
        Col("office", "Office", narrow=True),
        Col("total_items", "Items", "number", narrow=True),
        Col("total_qty", "Qty", "qty"),
        Col("pending_with", "Pending with"),
        Col("approved_at", "Approved at", "datetime", narrow=True),
        Col("created_at", "Created at", "datetime"),
    ],
    filters=[
        Filt("status", "Status"),
        Filt("priority", "Priority"),
        Filt("department", "Department"),
        Filt("project", "Project"),
        Filt("raised_by", "Raised by"),
        Filt("pending_with", "Pending with"),
    ],
    search=["doc_no", "raised_by", "department", "project", "remarks", "pending_with"],
    date_col="created_at",
    order_col="created_at",
    key_cols=["id"],
)


# --------------------------------------------------------------------------- #
# Approvals — the real audit trail: one row per decision anybody ever took.
# `wf_actions` is never deleted, so this is the answer to "who signed this off".
# --------------------------------------------------------------------------- #

def _approvals_source() -> Select:
    return (
        select(
            Action.id.label("id"),
            Action.acted_at.label("acted_at"),
            Instance.doc_type.label("doc_type"),
            Instance.doc_no.label("doc_no"),
            Instance.doc_id.label("doc_id"),
            Action.stage_sequence.label("stage_no"),
            Action.stage_name.label("stage"),
            Action.action.label("action"),
            Action.actor_id.label("actor_id"),
            Action.actor_name.label("actor"),
            Action.actor_position.label("actor_position"),
            Instance.started_by_name.label("raised_by"),
            Instance.status.label("instance_status"),
            Instance.started_at.label("submitted_at"),
            Instance.completed_at.label("completed_at"),
            Action.comments.label("comments"),
        )
        .join(Instance, Instance.id == Action.instance_id, isouter=True)
    )


APPROVALS = LedgerSpec(
    key="approvals",
    label="Approvals",
    subtitle="Every approve, reject, return and delegate — the decision audit trail",
    permission=perms.INDENT_VIEW,
    source=_approvals_source,
    columns=[
        Col("acted_at", "Acted at", "datetime"),
        Col("doc_type", "Doc type", "status"),
        Col("doc_no", "Document"),
        Col("action", "Action", "status"),
        Col("actor", "Actor"),
        Col("actor_position", "Position", narrow=True),
        Col("stage_no", "Stage", "number", narrow=True),
        Col("stage", "Stage name", narrow=True),
        Col("raised_by", "Raised by"),
        Col("instance_status", "Doc state", "status", narrow=True),
        Col("submitted_at", "Submitted at", "datetime", narrow=True),
        Col("comments", "Comments"),
    ],
    filters=[
        Filt("doc_type", "Document type"),
        Filt("action", "Action"),
        Filt("actor", "Actor"),
        Filt("actor_position", "Position"),
        Filt("instance_status", "Document state"),
        Filt("raised_by", "Raised by"),
    ],
    search=["doc_no", "actor", "actor_position", "raised_by", "stage", "comments"],
    date_col="acted_at",
    order_col="acted_at",
    key_cols=["id"],
)


# --------------------------------------------------------------------------- #
# Inventory — stk_ledger verbatim. Append-only, so a quantity that moved without a
# row here did not move through the system.
# --------------------------------------------------------------------------- #

def _inventory_source() -> Select:
    return select(
        StockMovement.id.label("id"),
        StockMovement.txn_date.label("txn_date"),
        StockMovement.item_code.label("item_code"),
        StockMovement.item_name.label("item_name"),
        StockMovement.warehouse_name.label("warehouse"),
        StockMovement.bin_code.label("bin_code"),
        StockMovement.batch_no.label("batch_no"),
        StockMovement.direction.label("direction"),
        StockMovement.quantity.label("quantity"),
        StockMovement.uom_code.label("uom"),
        StockMovement.balance_after.label("balance_after"),
        StockMovement.ref_type.label("ref_type"),
        StockMovement.ref_no.label("ref_no"),
        StockMovement.created_by_name.label("done_by"),
        StockMovement.remarks.label("remarks"),
        StockMovement.created_at.label("created_at"),
    )


INVENTORY = LedgerSpec(
    key="inventory",
    label="Inventory",
    subtitle="Stock ledger — every quantity in and out, with the document behind it",
    permission=perms.STOCK_VIEW,
    source=_inventory_source,
    columns=[
        Col("txn_date", "Txn date", "datetime"),
        Col("item_code", "Item code"),
        Col("item_name", "Item"),
        Col("warehouse", "Warehouse"),
        Col("bin_code", "Bin", narrow=True),
        Col("batch_no", "Batch", narrow=True),
        Col("direction", "In/Out", "direction"),
        Col("quantity", "Qty", "qty"),
        Col("uom", "UoM", narrow=True),
        Col("balance_after", "Balance after", "qty", narrow=True),
        Col("ref_type", "Ref type", "status"),
        Col("ref_no", "Ref no"),
        Col("done_by", "Done by"),
        Col("remarks", "Remarks", narrow=True),
    ],
    filters=[
        Filt("direction", "In / Out"),
        Filt("ref_type", "Reference type"),
        Filt("warehouse", "Warehouse"),
        Filt("done_by", "Done by"),
        Filt("item_code", "Item code", kind="text"),
        Filt("batch_no", "Batch", kind="text"),
    ],
    search=["item_code", "item_name", "ref_no", "done_by", "batch_no", "bin_code",
            "remarks"],
    date_col="txn_date",
    order_col="txn_date",
    key_cols=["id"],
)


# --------------------------------------------------------------------------- #
# Warehouse — the dock-to-stock cycle is seven tables, and an auditor wants them on
# one timeline. Each SELECT below normalises one document type onto the same nine
# columns; UNION ALL puts them in one stream. Receipts go first on purpose: MySQL
# takes the result column types from the first branch of a union, and receipts have
# a real (non-NULL) value in every column.
# --------------------------------------------------------------------------- #

_TXT = String(200)
_NO = String(50)
_QTY = Numeric(16, 3)


def _wh_branch(doc_type: str, *, id_col, doc_no, doc_date, status, warehouse, party,
               qty, ref_no, actor, created_at) -> Select:
    return select(
        id_col.label("id"),
        literal(doc_type).label("doc_type"),
        cast(doc_no, _NO).label("doc_no"),
        doc_date.label("doc_date"),
        cast(status, _NO).label("status"),
        cast(warehouse, _TXT).label("warehouse"),
        cast(party, _TXT).label("party"),
        cast(qty, _QTY).label("qty"),
        cast(ref_no, _NO).label("ref_no"),
        cast(actor, _TXT).label("actor"),
        created_at.label("created_at"),
    )


def _warehouse_source() -> Select:
    receipts = _wh_branch(
        "RECEIPT", id_col=Receipt.id, doc_no=Receipt.grn_no, doc_date=Receipt.grn_date,
        status=Receipt.status, warehouse=Receipt.warehouse_name,
        party=Receipt.vendor_name, qty=Receipt.total_received_qty,
        ref_no=func.coalesce(Receipt.po_no, Receipt.invoice_no),
        actor=func.coalesce(Receipt.received_by_name, Receipt.created_by_name),
        created_at=Receipt.created_at,
    )
    inspections = _wh_branch(
        "INSPECTION", id_col=Inspection.id, doc_no=Inspection.inspection_no,
        doc_date=Inspection.inspection_date, status=Inspection.status,
        warehouse=Inspection.warehouse_name, party=Inspection.vendor_name,
        qty=Inspection.total_items, ref_no=Inspection.grn_no,
        actor=Inspection.inspector_name, created_at=Inspection.created_at,
    )
    putaway = _wh_branch(
        "PUTAWAY", id_col=PutawayTask.id, doc_no=PutawayTask.putaway_no,
        doc_date=func.date(PutawayTask.created_at), status=PutawayTask.status,
        warehouse=null(), party=PutawayTask.lot_no, qty=PutawayTask.qty,
        ref_no=null(), actor=null(), created_at=PutawayTask.created_at,
    )
    picking = _wh_branch(
        "PICKING", id_col=Picking.id, doc_no=Picking.pick_no, doc_date=Picking.pick_date,
        status=Picking.status, warehouse=Picking.warehouse_name, party=Picking.strategy,
        qty=Picking.total_lines, ref_no=Picking.ref_no,
        actor=Picking.assigned_to_name, created_at=Picking.created_at,
    )
    issues = _wh_branch(
        "ISSUE", id_col=MaterialIssue.id, doc_no=MaterialIssue.issue_no,
        doc_date=MaterialIssue.issue_date, status=MaterialIssue.status,
        warehouse=MaterialIssue.warehouse_name,
        party=func.coalesce(MaterialIssue.department_name, MaterialIssue.issued_to_name),
        qty=MaterialIssue.total_qty, ref_no=MaterialIssue.indent_no,
        actor=func.coalesce(MaterialIssue.issued_by_name, MaterialIssue.created_by_name),
        created_at=MaterialIssue.created_at,
    )
    dispatches = _wh_branch(
        "DISPATCH", id_col=Dispatch.id, doc_no=Dispatch.dispatch_no,
        doc_date=Dispatch.dispatch_date, status=Dispatch.status,
        warehouse=Dispatch.warehouse_name,
        party=func.coalesce(Dispatch.to_warehouse_name, Dispatch.customer_name,
                            Dispatch.vendor_name),
        qty=Dispatch.total_qty, ref_no=func.coalesce(Dispatch.ref_no,
                                                    Dispatch.gate_pass_no),
        actor=Dispatch.created_by_name, created_at=Dispatch.created_at,
    )
    returns = _wh_branch(
        "PURCHASE_RETURN", id_col=PurchaseReturn.id, doc_no=PurchaseReturn.return_no,
        doc_date=PurchaseReturn.return_date, status=PurchaseReturn.status,
        warehouse=PurchaseReturn.warehouse_name, party=PurchaseReturn.vendor_name,
        qty=PurchaseReturn.total_qty,
        ref_no=func.coalesce(PurchaseReturn.grn_no, PurchaseReturn.po_no),
        actor=PurchaseReturn.created_by_name, created_at=PurchaseReturn.created_at,
    )
    return select(
        union_all(receipts, inspections, putaway, picking, issues, dispatches,
                  returns).subquery()
    )


WAREHOUSE = LedgerSpec(
    key="warehouse",
    label="Warehouse",
    subtitle="Receipts, QC, put-away, picking, issues, dispatch and returns on one "
             "timeline",
    permission=perms.STOCK_VIEW,
    source=_warehouse_source,
    columns=[
        Col("created_at", "Recorded at", "datetime"),
        Col("doc_type", "Stage", "status"),
        Col("doc_no", "Document"),
        Col("doc_date", "Doc date", "date"),
        Col("status", "Status", "status"),
        Col("warehouse", "Warehouse"),
        Col("party", "Party / to"),
        Col("qty", "Qty", "qty"),
        Col("ref_no", "Reference", narrow=True),
        Col("actor", "Handled by"),
    ],
    filters=[
        Filt("doc_type", "Stage"),
        Filt("status", "Status"),
        Filt("warehouse", "Warehouse"),
        Filt("actor", "Handled by"),
        Filt("doc_no", "Document no", kind="text"),
    ],
    search=["doc_no", "ref_no", "party", "actor", "warehouse", "status"],
    date_col="created_at",
    order_col="created_at",
    key_cols=["doc_type", "id"],
)


LEDGERS: dict[str, LedgerSpec] = {
    spec.key: spec for spec in (INDENTS, APPROVALS, INVENTORY, WAREHOUSE)
}
