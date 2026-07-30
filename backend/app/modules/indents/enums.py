"""Enums used by the indents module.

Canonical database values live in ``app.shared.enums``.  Re-exporting them here
keeps the module boundary explicit and prevents services and routers from using
raw status/action strings.
"""
from enum import Enum

from app.shared.enums import (
    AllocationStatus, ApprovalAction, AuditAction, DocType, IndentItemStatus,
    IndentStatus, InstanceStatus, MRStatus, Priority, RuleActionType,
)


class IndentActivityType(str, Enum):
    REQUEST_CREATED = "REQUEST_CREATED"
    REQUEST_SUBMITTED = "REQUEST_SUBMITTED"
    APPROVAL_COMPLETED = "APPROVAL_COMPLETED"
    REQUEST_REJECTED = "REQUEST_REJECTED"
    REQUEST_RETURNED = "REQUEST_RETURNED"
    APPROVAL_ROUTED_AUTOMATICALLY = "APPROVAL_ROUTED_AUTOMATICALLY"
    STOCK_ALLOCATED = "STOCK_ALLOCATED"
    PROCUREMENT_REQUEST_CREATED = "PROCUREMENT_REQUEST_CREATED"
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
    "DocType",
    "IndentActivityType",
    "IndentItemStatus",
    "IndentStatus",
    "InstanceStatus",
    "MaterialDirection",
    "MRStatus",
    "Priority",
    "RuleActionType",
]
