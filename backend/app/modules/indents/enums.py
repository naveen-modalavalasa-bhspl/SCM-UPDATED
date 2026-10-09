"""Enums used by the indents module.

Canonical database values live in ``app.shared.enums``.  Re-exporting them here
keeps the module boundary explicit and prevents services and routers from using
raw status/action strings.
"""
from enum import Enum

from app.shared.enums import (
    AllocationStatus, ApprovalAction, AuditAction, DocType, IndentItemStatus,
    IndentStatus as SharedIndentStatus, InstanceStatus, MRStatus, Priority,
    RuleActionType,
)


IndentStatus = Enum(
    "IndentStatus",
    {
        **{status.name: status.value for status in SharedIndentStatus},
        "RETURNED_FOR_CORRECTION": "RETURNED_FOR_CORRECTION",
    },
    type=str,
)


class IndentType(str, Enum):
    """What kind of request this is — a classification, not a lifecycle state.

    Module-owned for the same reason as IndentActivityType below: `shared/enums.py`
    holds the statuses every module must agree on, and nothing outside indents
    branches on this.

    REGULAR is what the database defaults `ind_indents.indent_type` to, so it is the
    value every indent raised before this field was exposed already carries — it is
    the ad-hoc, one-off request. MONTHLY is the recurring counterpart. Both are
    first-class members; REGULAR stays so existing documents keep loading, filtering
    and reporting unchanged.
    """

    REGULAR = "REGULAR"
    MONTHLY = "MONTHLY"
    # A Stock Transfer Request: a point asking for stock to be moved to it. Same
    # document and legs as an indent; approved on its own ladder
    # (DocType.STOCK_TRANSFER_REQUEST) and listed on Inventory > Stock Transfer
    # rather than among the indents.
    STR = "STR"


class ConsolidationStatus(str, Enum):
    """Whether a monthly consolidation still accepts members.

    Module-owned for the same reason as `IndentType`: nothing outside indents
    branches on it — the other modules only ever read the document it labels.

    OPEN accepts every monthly indent that finishes approval in the same month.
    SEALED is set the moment the storekeeper submits the allocation batch: from then
    on the membership is frozen, so the counts on the queue row, the cycle screen and
    the approval screen can never drift apart again. A monthly indent approved after
    the seal opens a NEW consolidation for the same month rather than joining work
    that has already been decided.
    """

    OPEN = "OPEN"
    SEALED = "SEALED"


class IndentActivityType(str, Enum):
    REQUEST_CREATED = "REQUEST_CREATED"
    REQUEST_SUBMITTED = "REQUEST_SUBMITTED"
    APPROVAL_COMPLETED = "APPROVAL_COMPLETED"
    REQUEST_REJECTED = "REQUEST_REJECTED"
    REQUEST_RETURNED = "REQUEST_RETURNED"
    APPROVAL_ROUTED_AUTOMATICALLY = "APPROVAL_ROUTED_AUTOMATICALLY"
    STOCK_ALLOCATED = "STOCK_ALLOCATED"
    PROCUREMENT_REQUEST_CREATED = "PROCUREMENT_REQUEST_CREATED"
    # The outward leg. A request does not end at allocation: the warehouse issues it,
    # the consignment leaves the gate and the receiving site signs for it, and until
    # those three are on the ledger it cannot say whether anything was ever handed
    # over. Each is read off the document that already records it (`out_issues`,
    # `out_dispatches`), never written for the ledger's benefit.
    MATERIAL_ISSUED = "MATERIAL_ISSUED"
    MATERIAL_DISPATCHED = "MATERIAL_DISPATCHED"
    RECEIPT_ACKNOWLEDGED = "RECEIPT_ACKNOWLEDGED"
    BOOKMARK_ADDED = "BOOKMARK_ADDED"
    BOOKMARK_REMOVED = "BOOKMARK_REMOVED"


class AcknowledgmentStatus(str, Enum):
    """Display/query values for fulfillment acknowledgments, not indent lifecycle states."""

    FULFILLED = "FULFILLED"
    PARTIALLY_FULFILLED = "PARTIALLY_FULFILLED"


class MaterialDirection(str, Enum):
    INWARD = "INWARD"
    OUTWARD = "OUTWARD"


__all__ = [
    "AcknowledgmentStatus",
    "AllocationStatus",
    "ApprovalAction",
    "AuditAction",
    "ConsolidationStatus",
    "DocType",
    "IndentActivityType",
    "IndentItemStatus",
    "IndentStatus",
    "IndentType",
    "InstanceStatus",
    "MaterialDirection",
    "MRStatus",
    "Priority",
    "RuleActionType",
]
