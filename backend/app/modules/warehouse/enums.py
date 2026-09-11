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
    """`inb_receipt_items.qc_status` and `out_issues.qc_status` — the QC outcome."""
    PENDING = "PENDING"
    PASSED = "PASSED"
    FAILED = "FAILED"
    PARTIAL = "PARTIAL"
    NOT_REQUIRED = "NOT_REQUIRED"


class InspectionType(str, Enum):
    """`inb_inspections.inspection_type`."""
    INCOMING = "INCOMING"
    OUTGOING = "OUTGOING"
    IN_PROCESS = "IN_PROCESS"


class InspectionStatus(str, Enum):
    """`inb_inspections.status` and `whs_inspections.status`."""
    DRAFT = "DRAFT"
    IN_PROGRESS = "IN_PROGRESS"
    # Outward QC only, and only where a QC_OUTWARD ladder is configured: the result is
    # recorded and waiting on a signature before it may release the material issue.
    # Inbound inspections never reach this rung.
    PENDING_APPROVAL = "PENDING_APPROVAL"
    COMPLETED = "COMPLETED"
    REJECTED = "REJECTED"
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
    INDENT_BASED = "INDENT_BASED"
    DIRECT = "DIRECT"


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


class TrackingType(str, Enum):
    """What one physical unit of an item is IDENTIFIED by, on any screen that lists
    identifiers.

    Not a column: it is read off the item master (`is_serial_tracked`,
    `is_imei_tracked`, `is_asset`) together with whether the point actually holds
    coded units. It exists because the issue screen used to list serials, IMEIs,
    asset codes and consumable codes in one undifferentiated column, and a
    storekeeper holding a handset could not tell which of its two numbers the line
    was asking him to scan.

    Distinct from `service._unit_mode`, and deliberately so. `_unit_mode` answers
    "which column does the backend VALIDATE against" and has three members, because
    an asset code and a consumable code are the same column to a matcher. This
    answers "what is the storekeeper looking at", which is the question a badge on a
    screen is for, and there an asset tag and a consumable lot code are not the same
    thing at all.
    """
    SERIAL = "SERIAL"
    IMEI = "IMEI"
    ASSET = "ASSET"
    CONSUMABLE = "CONSUMABLE"
    NONE = "NONE"


# The wording of a tracking type, SERVED (`GET /api/warehouse/tracking-types`) rather
# than mapped in a screen — same rule as `ACTIVITY_META` in logistics. `label` names
# the badge, `unit` names one of them in a sentence ("3 of 5 asset tags"), and `hint`
# is what the storekeeper is being asked to read off the goods.
TRACKING_META: dict[str, dict[str, str]] = {
    TrackingType.SERIAL.value: {
        "label": "Serial no",
        "unit": "serial",
        "hint": "Scan the serial number printed on the unit or its carton.",
    },
    TrackingType.IMEI.value: {
        "label": "IMEI",
        "unit": "IMEI",
        "hint": "Scan the 15-digit IMEI on the handset or its box label.",
    },
    TrackingType.ASSET.value: {
        "label": "Asset tag",
        "unit": "asset tag",
        "hint": "Scan the asset tag stamped on the unit at putaway.",
    },
    TrackingType.CONSUMABLE.value: {
        "label": "Consumable lot",
        "unit": "lot code",
        "hint": "Scan the consumable code stamped on the pack at putaway.",
    },
    TrackingType.NONE.value: {
        "label": "Not tracked",
        "unit": "unit",
        "hint": "This item is counted, not identified — there is nothing to scan.",
    },
}


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
    # The multi-line ORDER, as against the single bin-to-bin movement above. Its own
    # doc type since 2026-08-21 for two reasons: they were sharing one `sys_doc_series`
    # (so an order and a movement drew from the same running number), and an order is
    # the thing an approval ladder can be configured against — a movement is what the
    # order produces once it is signed.
    STOCK_MOVEMENT_ORDER = "STOCK_MOVEMENT_ORDER"
    # The outward check on a posted issue. Same string as
    # `shared.enums.DocType.QC_OUTWARD`, which is what puts it on Approvals
    # Config; INSPECTION stays the NUMBERING series for both directions.
    QC_OUTWARD = "QC_OUTWARD"
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
# RE-EXPORTED, never re-declared. `app/platform/rbac/permissions.py` is the single
# source of truth (rule 6), and this module used to keep its own copy of the same 25
# strings "so routers reference a constant". That worked right up until one of them
# drifted: `return.view`, `return.create` and `return.approve` ended up declared in
# three places, and the only reason nothing broke is that all three copies happened
# to agree.
#
# Importing them means the router keeps its existing `from ...warehouse.enums import
# RECEIPT_VIEW` lines unchanged, and a code that is renamed in the catalogue is
# renamed here too — or fails loudly at import, which is the point.
# ---------------------------------------------------------------------------
from app.platform.rbac.permissions import (  # noqa: F401  (re-exported)
    DISPATCH_ACKNOWLEDGE,
    DISPATCH_APPROVE,
    DISPATCH_CREATE,
    DISPATCH_DELETE,
    DISPATCH_GATE_OUT,
    DISPATCH_VIEW,
    INSPECTION_DELETE,
    INSPECTION_EXECUTE,
    INSPECTION_VIEW,
    ISSUE_CREATE,
    ISSUE_DELETE,
    ISSUE_FORWARD,
    ISSUE_VIEW,
    MASTER_LOCATION_MANAGE,
    MOVEMENT_APPROVE,
    MOVEMENT_CREATE,
    MOVEMENT_DELETE,
    MOVEMENT_UPDATE,
    MOVEMENT_VIEW,
    PICKING_DELETE,
    PICKING_PICK,
    PICKING_VIEW,
    PUTAWAY_DELETE,
    PUTAWAY_EXECUTE,
    PUTAWAY_VIEW,
    QC_OUTWARD_VIEW,
    QC_OUTWARD_CREATE,
    QC_OUTWARD_UPDATE,
    QC_OUTWARD_APPROVE,
    QC_OUTWARD_EXPORT,
    QC_OUTWARD_DELETE,
    RECEIPT_CREATE,
    RECEIPT_DELETE,
    RECEIPT_POST,
    RECEIPT_VIEW,
    RETURN_APPROVE,
    RETURN_CREATE,
    RETURN_DELETE,
    RETURN_VIEW,
    STOCK_TRANSFER,
    STOCK_VIEW,
    WAREHOUSE_REPORT_VIEW,
)

# The one name that differs: this module has always called `issue.issue` ISSUE_POST,
# and the catalogue calls it ISSUE_ISSUE. Aliased rather than renamed so no router
# line changes and no permission code moves.
from app.platform.rbac.permissions import ISSUE_ISSUE as ISSUE_POST  # noqa: F401
