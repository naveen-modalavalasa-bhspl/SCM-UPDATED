"""Every status this module writes, plus the permission codes it guards on.

Rule 3: never a raw status string. A status that is not in here does not exist.

The lower_snake values are not a style slip — `whs_warehouse_items.status` and
`whs_serial_numbers.status` are MySQL ENUM columns whose members the DB team
defined in lower case, so writing "COMPLETED" to them raises a truncation error.
The enums mirror the columns; the API normalises for display, not for storage.
"""
from enum import Enum


class ReceiptType(str, Enum):
    """`inb_receipts.receipt_type` — which document this row is at this point."""
    GATE_ENTRY = "GATE_ENTRY"
    PURCHASE = "PURCHASE"
    DIRECT = "DIRECT"
    TRANSFER = "TRANSFER"
    RETURN = "RETURN"
    # Goods arriving at a stocking point from another one — the consignment a
    # warehouse dispatched to an MDP or a LIP. The receiving point inwards it the
    # same way it inwards a purchase (GRN, QC, putaway), so stock only exists at
    # the destination once somebody there says it arrived.
    DISPATCH = "DISPATCH"


class ReceiptStatus(str, Enum):
    """`inb_receipts.status`."""
    DRAFT = "DRAFT"
    GATE_ENTRY = "GATE_ENTRY"
    SUBMITTED = "SUBMITTED"
    PENDING_QC = "PENDING_QC"
    QC_PASSED = "QC_PASSED"
    QC_FAILED = "QC_FAILED"
    PARTIALLY_RECEIVED = "PARTIALLY_RECEIVED"
    RECEIVED = "RECEIVED"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"


class QcStatus(str, Enum):
    """`inb_receipt_items.qc_status` — the line's own QC outcome."""
    PENDING = "PENDING"
    PASSED = "PASSED"
    FAILED = "FAILED"
    PARTIAL = "PARTIAL"


class InspectionType(str, Enum):
    """`inb_inspections.inspection_type`."""
    INCOMING = "INCOMING"
    OUTGOING = "OUTGOING"
    IN_PROCESS = "IN_PROCESS"


class InspectionStatus(str, Enum):
    """`inb_inspections.status`."""
    DRAFT = "DRAFT"
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"


class InspectionResult(str, Enum):
    """`inb_inspection_items.result`."""
    PENDING = "PENDING"
    PASSED = "PASSED"
    FAILED = "FAILED"
    PARTIAL = "PARTIAL"


class PutawayStatus(str, Enum):
    """`whs_warehouse_items.status` — a MySQL ENUM, lower case in the schema."""
    DRAFT = "draft"
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    SKIPPED = "skipped"


class PutawayType(str, Enum):
    """`whs_warehouse_items.putaway_type` — a MySQL ENUM, lower case."""
    SYSTEM_DIRECTED = "system_directed"
    MANUAL = "manual"


class PickingStatus(str, Enum):
    """`out_picking.status`."""
    DRAFT = "DRAFT"
    RELEASED = "RELEASED"
    IN_PROGRESS = "IN_PROGRESS"
    PICKED = "PICKED"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"


class PickLineStatus(str, Enum):
    """`out_picking_items.status`."""
    PENDING = "PENDING"
    PICKED = "PICKED"
    SHORT = "SHORT"
    CANCELLED = "CANCELLED"


class PickStrategy(str, Enum):
    """`out_picking.strategy` — which batch the picker is sent to first."""
    FEFO = "FEFO"
    FIFO = "FIFO"
    MANUAL = "MANUAL"


class IssueStatus(str, Enum):
    """`out_issues.status`."""
    DRAFT = "DRAFT"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    ISSUED = "ISSUED"
    DISPATCHED = "DISPATCHED"
    ACKNOWLEDGED = "ACKNOWLEDGED"
    PARTIALLY_RETURNED = "PARTIALLY_RETURNED"
    RETURNED = "RETURNED"
    CANCELLED = "CANCELLED"


# An issue in one of these is over: it holds no stock and blocks nothing, so the
# indent behind it is free to be issued again. Every other status is LIVE and is
# what the one-issue-per-indent rule counts.
DEAD_ISSUE_STATUSES = (IssueStatus.CANCELLED.value, IssueStatus.REJECTED.value)


class IssueType(str, Enum):
    """`out_issues.issue_type`."""
    DEPARTMENT = "DEPARTMENT"
    PROJECT = "PROJECT"
    VEHICLE = "VEHICLE"
    CONSUMPTION = "CONSUMPTION"
    SCRAP = "SCRAP"


class IssueDirection(str, Enum):
    """`out_issues.direction` — OUT is an issue, IN is a return of one."""
    OUT = "OUT"
    IN = "IN"


class DispatchStatus(str, Enum):
    """`out_dispatches.status`."""
    DRAFT = "DRAFT"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    PACKED = "PACKED"
    DISPATCHED = "DISPATCHED"
    IN_TRANSIT = "IN_TRANSIT"
    DELIVERED = "DELIVERED"
    ACKNOWLEDGED = "ACKNOWLEDGED"
    CANCELLED = "CANCELLED"


class DispatchType(str, Enum):
    """`out_dispatches.dispatch_type`."""
    TRANSFER = "TRANSFER"
    CUSTOMER = "CUSTOMER"
    VENDOR_RETURN = "VENDOR_RETURN"
    PROJECT = "PROJECT"


class PackageStatus(str, Enum):
    """`out_dispatch_packages.status`."""
    PACKED = "PACKED"
    LOADED = "LOADED"
    DELIVERED = "DELIVERED"
    DAMAGED = "DAMAGED"


class DispatchEventType(str, Enum):
    """`out_dispatch_events.event_type`."""
    PICKED_UP = "PICKED_UP"
    IN_TRANSIT = "IN_TRANSIT"
    TEMPERATURE_CHECK = "TEMPERATURE_CHECK"
    DELAYED = "DELAYED"
    DELIVERED = "DELIVERED"
    GATE_OUT = "GATE_OUT"


class ReturnStatus(str, Enum):
    """`pro_returns.status`."""
    DRAFT = "DRAFT"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    DISPATCHED = "DISPATCHED"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"


class SerialStatus(str, Enum):
    """`whs_serial_numbers.status` — a MySQL ENUM, lower case in the schema."""
    AVAILABLE = "available"
    ISSUED = "issued"
    CONSUMED = "consumed"
    RETURNED = "returned"
    MAINTENANCE = "maintenance"
    SCRAPPED = "scrapped"


class BatchStatus(str, Enum):
    """`stk_batches.status`."""
    ACTIVE = "ACTIVE"
    QUARANTINED = "QUARANTINED"
    EXPIRED = "EXPIRED"
    RECALLED = "RECALLED"
    CONSUMED = "CONSUMED"


class WarehouseDocType(str, Enum):
    """`doc_type` for the workflow engine and `sys_doc_series`.

    Kept separate from `app.shared.enums.DocType`, which is the lead's file: the
    engine takes the string, so a module can name its own document types without
    anything shared having to change.
    """
    RECEIPT = "RECEIPT"
    GATE_ENTRY = "GATE_ENTRY"
    INSPECTION = "INSPECTION"
    PUTAWAY = "PUTAWAY"
    PICKING = "PICKING"
    WH_ISSUE = "WH_ISSUE"
    DISPATCH = "DISPATCH"
    PURCHASE_RETURN = "PURCHASE_RETURN"
    STOCK_MOVEMENT = "STOCK_MOVEMENT"
    # Not a document — a series, so a lot number is numbered like everything else.
    LOT = "lot"


class RefType(str, Enum):
    """What a picklist or dispatch was raised against."""
    INDENT = "INDENT"
    ISSUE = "ISSUE"
    DISPATCH = "DISPATCH"
    PO = "PO"


# ---------------------------------------------------------------------------
# Permission codes.
#
# These are NOT the source of truth. `app/platform/rbac/permissions.py` is, and it
# is the lead's file — a code only exists once it has a `Perm(...)` row there, which
# is what `scripts/seed.py` inserts into `rbac_permissions`.
#
# They are named here so routers reference a constant instead of scattering string
# literals, and so there is one list to hand the lead. Until the matching rows are
# added and the seed is re-run, `require_permission` denies every user on the
# endpoints guarded by a code marked NEW below. That is the correct failure: an
# ungranted permission must close the door, not leave it open.
#
# Already in permissions.py, used as-is:
ISSUE_VIEW = "issue.view"
ISSUE_CREATE = "issue.create"
ISSUE_POST = "issue.issue"
# Passing an arrived consignment on to a point below (WH -> MDP -> LIP).
ISSUE_FORWARD = "issue.forward"
STOCK_VIEW = "stock.view"
STOCK_TRANSFER = "stock.transfer"
MASTER_LOCATION_MANAGE = "master.location.manage"

# Still to be added by the lead:
RECEIPT_VIEW = "receipt.view"                    # NEW
RECEIPT_CREATE = "receipt.create"                # NEW
RECEIPT_POST = "receipt.post"                    # NEW
INSPECTION_VIEW = "inspection.view"              # NEW
INSPECTION_EXECUTE = "inspection.execute"        # NEW
PUTAWAY_VIEW = "putaway.view"                    # NEW
PUTAWAY_EXECUTE = "putaway.execute"              # NEW
PICKING_VIEW = "picking.view"                    # NEW
PICKING_PICK = "picking.pick"                    # NEW
DISPATCH_VIEW = "dispatch.view"                  # NEW
DISPATCH_CREATE = "dispatch.create"              # NEW
DISPATCH_APPROVE = "dispatch.approve"            # NEW
DISPATCH_GATE_OUT = "dispatch.gate_out"          # NEW
DISPATCH_ACKNOWLEDGE = "dispatch.acknowledge"    # NEW
RETURN_VIEW = "return.view"                      # NEW
RETURN_CREATE = "return.create"                  # NEW
RETURN_APPROVE = "return.approve"                # NEW
WAREHOUSE_REPORT_VIEW = "warehouse.report.view"  # NEW

# Deleting an abandoned draft — one code per document type, so tidying picklists is
# not the same grant as tidying GRNs.
RECEIPT_DELETE = "receipt.delete"
INSPECTION_DELETE = "inspection.delete"
PUTAWAY_DELETE = "putaway.delete"
PICKING_DELETE = "picking.delete"
ISSUE_DELETE = "issue.delete"
DISPATCH_DELETE = "dispatch.delete"
RETURN_DELETE = "return.delete"
MOVEMENT_DELETE = "movement.delete"
