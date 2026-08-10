"""One declarative spec per report ledger.

Everything the API does — list, filter, search, sort, filter-option dropdowns and
CSV export — is driven from these specs, so adding a ledger is adding a
`LedgerSpec` and nothing else. No SQL lives in `router.py` and no column list lives
in the frontend.

A spec's `source()` returns a SELECT whose columns are already named the way the
report shows them. `service.py` wraps that in a subquery and filters the subquery,
which is why the warehouse ledger (a UNION of seven document tables) filters and
searches exactly like the single-table ones.
"""
from dataclasses import dataclass, field
from typing import Callable

from sqlalchemy import (
    Numeric, String, Select, case, cast, func, literal, literal_column, null,
    select, union_all,
)
from sqlalchemy.orm import aliased

from app.modules.indents.models import Indent
from app.modules.inventory.models import Stock, StockMovement
from app.modules.reports.enums import AgeBucket, Breach, ExpiryBucket, LedgerKey
from app.modules.warehouse.enums import IssueDirection, IssueStatus
from app.modules.warehouse.models import (
    Dispatch, Inspection, MaterialIssue, MaterialIssueLine, Picking, PurchaseReturn,
    PutawayTask, Receipt,
)
from app.platform.rbac import permissions as perms
from app.platform.workflow.models import Action, Instance, Pending


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

    # --- Data scope -------------------------------------------------------- #
    # Which column of THIS ledger the login's rung is applied to. A ledger is a
    # read-only view over documents someone else owns, so it has to answer the same
    # "whose rows?" question the source screens do — without these it answered
    # "everybody's", and a lab technician granted the Indent Ledger read every indent
    # in the company. `service._scope_conditions` turns these into a WHERE.
    #
    # At most one is normally set. A ledger with none is unscoped ON PURPOSE and must
    # say why in a comment beside the spec.
    scope_indent_col: str | None = None      # holds ind_indents.id
    scope_warehouse_name_col: str | None = None  # holds a warehouse NAME
    scope_actor_col: str | None = None       # holds the acting employee's id

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
        # The monthly cycle, derived rather than stored — exactly the key
        # `indents.service.cycle_key` builds in Python, so a ledger row and an
        # approval batch can never disagree about which month an indent belongs to.
        func.coalesce(func.date_format(Indent.indent_date, "%Y-%m"),
                      "UNDATED").label("cycle"),
        Indent.indent_type.label("indent_type"),
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
        Col("indent_type", "Type", "status", narrow=True),
        Col("cycle", "Cycle", narrow=True),
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
        Filt("indent_type", "Type"),
        # The month a monthly indent belongs to. Without it there was no way to ask
        # "how did the August cycle go", which is the question the whole monthly flow
        # exists to answer.
        Filt("cycle", "Cycle"),
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
    scope_indent_col="id",
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
    scope_actor_col="actor_id",
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
    scope_warehouse_name_col="warehouse",
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
    scope_warehouse_name_col="warehouse",
)


# --------------------------------------------------------------------------- #
# Stock — what is physically on hand right now, with the ageing and valuation
# figures the inventory screens already show. The bucket cut points are the ones
# in `inventory.service.get_stock_ageing`, so the report and the screen can never
# disagree. The screen computes them in Python over a loaded list; here they are
# computed by the database, because a report has to be exportable in one query.
# --------------------------------------------------------------------------- #

def _stock_source() -> Select:
    # Against the database's own clock, not Python's: a report run tomorrow must
    # bucket by tomorrow, and a cached NOW() from process start would not.
    # `last_movement_at` is NULL for a balance that has never moved — coalescing to
    # now makes that read as zero days old, which is what the ageing screen does.
    days_in_stock = func.datediff(
        func.now(), func.coalesce(Stock.last_movement_at, func.now()))
    days_to_expiry = func.datediff(Stock.expiry_date, func.curdate())
    return select(
        Stock.id.label("id"),
        Stock.item_code.label("item_code"),
        Stock.item_name.label("item_name"),
        Stock.warehouse_name.label("warehouse"),
        Stock.bin_code.label("bin_code"),
        Stock.batch_no.label("batch_no"),
        Stock.project_name.label("project"),
        Stock.uom_code.label("uom"),
        Stock.total_qty.label("total_qty"),
        Stock.available_qty.label("available_qty"),
        Stock.reserved_qty.label("reserved_qty"),
        Stock.transit_qty.label("transit_qty"),
        Stock.valuation_rate.label("rate"),
        Stock.stock_value.label("stock_value"),
        days_in_stock.label("days_in_stock"),
        case(
            (days_in_stock <= 30, AgeBucket.D0_30.value),
            (days_in_stock <= 60, AgeBucket.D31_60.value),
            (days_in_stock <= 90, AgeBucket.D61_90.value),
            else_=AgeBucket.D90_PLUS.value,
        ).label("age_bucket"),
        Stock.expiry_date.label("expiry_date"),
        days_to_expiry.label("days_to_expiry"),
        # The NULL branch has to come first and be explicit. DATEDIFF(NULL, x) is
        # NULL, and `NULL <= 30` is NULL rather than false, so every comparison below
        # would fall through and label an item with no expiry date as "90+".
        case(
            (Stock.expiry_date.is_(None), cast(null(), String(20))),
            (days_to_expiry < 0, ExpiryBucket.EXPIRED.value),
            (days_to_expiry <= 30, ExpiryBucket.D0_30.value),
            (days_to_expiry <= 60, ExpiryBucket.D31_60.value),
            (days_to_expiry <= 90, ExpiryBucket.D61_90.value),
            else_=ExpiryBucket.D90_PLUS.value,
        ).label("expiry_bucket"),
        Stock.last_movement_at.label("last_movement_at"),
        Stock.updated_at.label("updated_at"),
    )


STOCK = LedgerSpec(
    key=LedgerKey.STOCK.value,
    label="Stock",
    subtitle="Balance on hand with ageing and valuation — one row per item, "
             "warehouse, bin and batch",
    permission=perms.STOCK_VIEW,
    source=_stock_source,
    columns=[
        Col("item_code", "Item code"),
        Col("item_name", "Item"),
        Col("warehouse", "Warehouse"),
        Col("bin_code", "Bin", narrow=True),
        Col("batch_no", "Batch", narrow=True),
        Col("project", "Project", narrow=True),
        Col("total_qty", "Total", "qty"),
        Col("available_qty", "Available", "qty"),
        Col("reserved_qty", "Reserved", "qty"),
        Col("transit_qty", "In transit", "qty", narrow=True),
        Col("uom", "UoM", narrow=True),
        Col("rate", "Rate", "number", narrow=True),
        Col("stock_value", "Value", "number"),
        Col("days_in_stock", "Days in stock", "number", narrow=True),
        Col("age_bucket", "Age", "status", narrow=True),
        Col("expiry_date", "Expiry", "date", narrow=True),
        Col("days_to_expiry", "Days to expiry", "number", narrow=True),
        Col("expiry_bucket", "Expiry band", "status", narrow=True),
        Col("last_movement_at", "Last movement", "datetime"),
    ],
    filters=[
        Filt("warehouse", "Warehouse"),
        Filt("age_bucket", "Age band"),
        Filt("expiry_bucket", "Expiry band"),
        Filt("project", "Project"),
        Filt("item_code", "Item code", kind="text"),
        Filt("batch_no", "Batch", kind="text"),
    ],
    search=["item_code", "item_name", "warehouse", "bin_code", "batch_no", "project"],
    date_col="updated_at",
    order_col="updated_at",
    key_cols=["id"],
    scope_warehouse_name_col="warehouse",
)


# --------------------------------------------------------------------------- #
# Acknowledgements — material that left the warehouse and has not been signed for.
# This is a chase list, so it holds only the outstanding ones: the moment somebody
# acknowledges, the row leaves the report. A return (direction IN) is excluded —
# it exists to reverse an issue, and nobody acknowledges receipt of a return.
# --------------------------------------------------------------------------- #

def _acknowledgements_source() -> Select:
    days_pending = func.datediff(func.curdate(), MaterialIssue.issue_date)
    return (
        select(
            MaterialIssue.id.label("id"),
            MaterialIssue.issue_no.label("doc_no"),
            MaterialIssue.issue_date.label("doc_date"),
            MaterialIssue.status.label("status"),
            MaterialIssue.indent_no.label("indent_no"),
            Indent.requested_by_name.label("raised_by"),
            Indent.office_name.label("office"),
            Indent.project_name.label("project"),
            Indent.department_name.label("department"),
            MaterialIssue.warehouse_name.label("warehouse"),
            MaterialIssue.issued_to_name.label("issued_to"),
            MaterialIssue.total_items.label("total_items"),
            MaterialIssue.total_qty.label("total_qty"),
            days_pending.label("days_pending"),
            MaterialIssue.issued_by_name.label("issued_by"),
            MaterialIssue.created_at.label("created_at"),
        )
        # Outer join: an issue raised straight against a department carries no
        # indent, and it still needs acknowledging.
        .join(Indent, Indent.id == MaterialIssue.indent_id, isouter=True)
        .where(
            MaterialIssue.acknowledged_at.is_(None),
            MaterialIssue.direction == IssueDirection.OUT.value,
            MaterialIssue.status.in_(
                [IssueStatus.ISSUED.value, IssueStatus.DISPATCHED.value]),
        )
    )


ACKNOWLEDGEMENTS = LedgerSpec(
    key=LedgerKey.ACKNOWLEDGEMENTS.value,
    label="Acknowledgement pending",
    subtitle="Material issued or dispatched that nobody has signed for yet",
    permission=perms.INDENT_VIEW,
    source=_acknowledgements_source,
    columns=[
        Col("doc_no", "Issue No"),
        Col("doc_date", "Issued on", "date"),
        Col("status", "Status", "status"),
        Col("days_pending", "Days pending", "number", narrow=True),
        Col("indent_no", "Indent No"),
        Col("raised_by", "Raised by"),
        Col("issued_to", "Issued to"),
        Col("department", "Department"),
        Col("project", "Project", narrow=True),
        Col("office", "Office", narrow=True),
        Col("warehouse", "Warehouse"),
        Col("total_items", "Items", "number", narrow=True),
        Col("total_qty", "Qty", "qty"),
        Col("issued_by", "Issued by"),
    ],
    filters=[
        Filt("status", "Status"),
        Filt("warehouse", "Warehouse"),
        Filt("department", "Department"),
        Filt("project", "Project"),
        Filt("raised_by", "Raised by"),
        Filt("issued_to", "Issued to"),
    ],
    search=["doc_no", "indent_no", "raised_by", "issued_to", "department", "warehouse"],
    date_col="doc_date",
    order_col="doc_date",
    key_cols=["id"],
    scope_indent_col="id",
)


# --------------------------------------------------------------------------- #
# Indent tracker — the monthly view the indent team keeps by hand today.
#
# The process document groups this by REGION. There is no region column anywhere
# on `ind_indents`, and adding one is a schema change, so this groups by the
# dimensions that do exist — office, project and department. Swap in region here
# once the column lands; nothing else in this file has to change.
# --------------------------------------------------------------------------- #

def _indent_tracker_source() -> Select:
    return select(
        Indent.id.label("id"),
        func.date_format(Indent.indent_date, "%Y-%m").label("month"),
        Indent.indent_no.label("doc_no"),
        Indent.indent_date.label("doc_date"),
        Indent.required_date.label("required_date"),
        Indent.status.label("status"),
        Indent.priority.label("priority"),
        Indent.requested_by_name.label("raised_by"),
        Indent.office_name.label("office"),
        Indent.project_name.label("project"),
        Indent.department_name.label("department"),
        Indent.total_items.label("total_items"),
        Indent.total_qty.label("total_qty"),
        Indent.current_approver_name.label("pending_with"),
        Indent.approved_at.label("approved_at"),
        func.datediff(func.curdate(), Indent.indent_date).label("days_open"),
        Indent.created_at.label("created_at"),
    )


INDENT_TRACKER = LedgerSpec(
    key=LedgerKey.INDENT_TRACKER.value,
    label="Monthly indent tracker",
    subtitle="Every indent by month, office, project and department, and where it "
             "got to",
    permission=perms.INDENT_VIEW,
    source=_indent_tracker_source,
    columns=[
        Col("month", "Month", "status", narrow=True),
        Col("doc_no", "Indent No"),
        Col("doc_date", "Raised on", "date"),
        Col("required_date", "Required by", "date", narrow=True),
        Col("status", "Status", "status"),
        Col("priority", "Priority", "status", narrow=True),
        Col("raised_by", "Raised by"),
        Col("office", "Office"),
        Col("project", "Project"),
        Col("department", "Department"),
        Col("total_items", "Items", "number", narrow=True),
        Col("total_qty", "Qty", "qty"),
        Col("pending_with", "Pending with"),
        Col("days_open", "Days open", "number", narrow=True),
        Col("approved_at", "Approved at", "datetime", narrow=True),
    ],
    filters=[
        Filt("month", "Month"),
        Filt("status", "Status"),
        Filt("office", "Office"),
        Filt("project", "Project"),
        Filt("department", "Department"),
        Filt("priority", "Priority"),
    ],
    search=["doc_no", "raised_by", "office", "project", "department", "pending_with"],
    date_col="doc_date",
    order_col="doc_date",
    key_cols=["id"],
    scope_indent_col="id",
)


# --------------------------------------------------------------------------- #
# Approval SLA — how long each rung actually sat on somebody's desk.
#
# A stage starts when the previous decision was taken, so the clock for stage N is
# the gap between action N-1 and action N; stage 1 runs from submission. That is a
# correlated MAX over the same instance rather than a window function, because the
# live server's MySQL version is not something this file should assume.
#
# `wf_pending` rows are removed once acted on, so `due_at` — and therefore the
# breach flag — survives only for stages still open. NULL there means "no due date
# on record", never "on time".
# --------------------------------------------------------------------------- #

def _approval_sla_source() -> Select:
    prior = aliased(Action)
    stage_started = func.coalesce(
        select(func.max(prior.acted_at))
        .where(prior.instance_id == Action.instance_id, prior.id < Action.id)
        .scalar_subquery(),
        Instance.started_at,
    )
    due_at = (
        select(func.min(Pending.due_at))
        .where(Pending.instance_id == Action.instance_id,
               Pending.stage_sequence == Action.stage_sequence)
        .scalar_subquery()
    )
    return (
        select(
            Action.id.label("id"),
            Instance.doc_type.label("doc_type"),
            Instance.doc_no.label("doc_no"),
            Action.stage_sequence.label("stage_no"),
            Action.stage_name.label("stage"),
            Action.action.label("action"),
            Action.actor_name.label("approver"),
            Action.actor_position.label("position"),
            Instance.started_by_name.label("raised_by"),
            Instance.started_at.label("submitted_at"),
            stage_started.label("stage_started_at"),
            Action.acted_at.label("acted_at"),
            func.timestampdiff(
                literal_column("HOUR"), stage_started, Action.acted_at,
            ).label("hours_taken"),
            due_at.label("due_at"),
            case(
                (due_at.is_(None), cast(null(), String(10))),
                (Action.acted_at > due_at, Breach.YES.value),
                else_=Breach.NO.value,
            ).label("breached"),
            Instance.status.label("instance_status"),
            Action.comments.label("comments"),
        )
        .join(Instance, Instance.id == Action.instance_id, isouter=True)
    )


APPROVAL_SLA = LedgerSpec(
    key=LedgerKey.APPROVAL_SLA.value,
    label="Approval SLA",
    subtitle="Hours each approval stage actually took, and whether it ran past due",
    permission=perms.INDENT_VIEW,
    source=_approval_sla_source,
    columns=[
        Col("acted_at", "Decided at", "datetime"),
        Col("doc_type", "Doc type", "status", narrow=True),
        Col("doc_no", "Document"),
        Col("stage_no", "Stage", "number", narrow=True),
        Col("stage", "Stage name"),
        Col("approver", "Approver"),
        Col("position", "Position", narrow=True),
        Col("action", "Action", "status", narrow=True),
        Col("hours_taken", "Hours taken", "number"),
        Col("breached", "Past due", "status", narrow=True),
        Col("raised_by", "Raised by"),
        Col("submitted_at", "Submitted at", "datetime", narrow=True),
        Col("stage_started_at", "Stage started", "datetime", narrow=True),
        Col("due_at", "Due at", "datetime", narrow=True),
        Col("instance_status", "Doc state", "status", narrow=True),
        Col("comments", "Comments"),
    ],
    filters=[
        Filt("doc_type", "Document type"),
        Filt("action", "Action"),
        Filt("approver", "Approver"),
        Filt("position", "Position"),
        Filt("breached", "Past due"),
        Filt("stage", "Stage name"),
    ],
    search=["doc_no", "approver", "position", "raised_by", "stage", "comments"],
    date_col="acted_at",
    order_col="acted_at",
    key_cols=["id"],
    scope_indent_col="id",
)


# --------------------------------------------------------------------------- #
# Consumption — what was actually drawn down, per item, per month, per consumer.
#
# READ THIS BEFORE TRUSTING THE NUMBER. "Consumption" in the process document means
# what the field actually USED, and nothing in this system records that: there is no
# field usage return, so the honest measure available today is what physically left
# the warehouse and was not sent back. That is what this ledger reports.
#
# So `net_qty` is issued minus returned on posted issues only (`is_stock_posted`) —
# an issue still sitting in approval has consumed nothing. It over-reports where
# stock is sitting unused at an MDP or in a vehicle, and it cannot see wastage or
# expiry at the field at all. When field usage reporting exists, this spec is where
# it plugs in; until then the column is named `net_qty`, not `consumed_qty`, on
# purpose.
# --------------------------------------------------------------------------- #

def _consumption_source() -> Select:
    net_qty = MaterialIssueLine.issued_qty - func.coalesce(
        MaterialIssueLine.returned_qty, 0)
    return (
        select(
            MaterialIssueLine.id.label("id"),
            func.date_format(MaterialIssue.issue_date, "%Y-%m").label("month"),
            MaterialIssueLine.item_code.label("item_code"),
            MaterialIssueLine.item_name.label("item_name"),
            MaterialIssueLine.uom_code.label("uom"),
            MaterialIssueLine.issued_qty.label("issued_qty"),
            MaterialIssueLine.returned_qty.label("returned_qty"),
            net_qty.label("net_qty"),
            MaterialIssueLine.rate.label("rate"),
            MaterialIssueLine.amount.label("amount"),
            MaterialIssue.issue_type.label("issue_type"),
            MaterialIssue.department_name.label("department"),
            MaterialIssue.project_name.label("project"),
            MaterialIssue.vehicle_number.label("vehicle"),
            MaterialIssue.issued_to_name.label("issued_to"),
            MaterialIssue.warehouse_name.label("warehouse"),
            MaterialIssue.issue_no.label("doc_no"),
            MaterialIssue.issue_date.label("doc_date"),
            MaterialIssue.indent_no.label("indent_no"),
            MaterialIssueLine.batch_no.label("batch_no"),
            MaterialIssueLine.expiry_date.label("expiry_date"),
            MaterialIssue.status.label("status"),
        )
        .join(MaterialIssue, MaterialIssue.id == MaterialIssueLine.issue_id)
        .where(
            MaterialIssue.direction == IssueDirection.OUT.value,
            # The flag the issue itself sets when stock actually moved. Filtering on
            # status instead would count an approved-but-unposted issue as consumed.
            MaterialIssue.is_stock_posted.is_(True),
        )
    )


CONSUMPTION = LedgerSpec(
    key=LedgerKey.CONSUMPTION.value,
    label="Consumption",
    subtitle="Issued minus returned, per item and month — what left the warehouse "
             "and stayed out",
    permission=perms.STOCK_VIEW,
    source=_consumption_source,
    columns=[
        Col("month", "Month", "status", narrow=True),
        Col("item_code", "Item code"),
        Col("item_name", "Item"),
        Col("net_qty", "Net qty", "qty"),
        Col("uom", "UoM", narrow=True),
        Col("issued_qty", "Issued", "qty", narrow=True),
        Col("returned_qty", "Returned", "qty", narrow=True),
        Col("rate", "Rate", "number", narrow=True),
        Col("amount", "Value", "number"),
        Col("issue_type", "Type", "status", narrow=True),
        Col("department", "Department"),
        Col("project", "Project"),
        Col("vehicle", "Vehicle", narrow=True),
        Col("issued_to", "Issued to"),
        Col("warehouse", "Warehouse"),
        Col("doc_no", "Issue No"),
        Col("doc_date", "Issued on", "date"),
        Col("indent_no", "Indent No", narrow=True),
        Col("batch_no", "Batch", narrow=True),
        Col("expiry_date", "Expiry", "date", narrow=True),
    ],
    filters=[
        Filt("month", "Month"),
        Filt("issue_type", "Type"),
        Filt("department", "Department"),
        Filt("project", "Project"),
        Filt("warehouse", "Warehouse"),
        Filt("item_code", "Item code", kind="text"),
    ],
    search=["item_code", "item_name", "doc_no", "indent_no", "department", "project",
            "issued_to", "vehicle"],
    date_col="doc_date",
    order_col="doc_date",
    key_cols=["id"],
    scope_warehouse_name_col="warehouse",
)


LEDGERS: dict[str, LedgerSpec] = {
    spec.key: spec for spec in (
        INDENTS, APPROVALS, INVENTORY, WAREHOUSE,
        STOCK, ACKNOWLEDGEMENTS, INDENT_TRACKER, APPROVAL_SLA, CONSUMPTION,
    )
}
