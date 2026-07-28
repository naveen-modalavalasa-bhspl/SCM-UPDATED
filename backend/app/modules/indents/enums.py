"""Enums used by the indents module.

Canonical database values live in ``app.shared.enums``.  Re-exporting them here
keeps the module boundary explicit and prevents services and routers from using
raw status/action strings.
"""
from enum import Enum

from app.shared.enums import (
    AllocationStatus, ApprovalAction, AuditAction, DocType, IndentItemStatus,
    IndentStatus, InstanceStatus, Priority, RuleActionType,
)


class IndentActivityType(str, Enum):
    RAISED = "RAISED"
    SUBMITTED = "SUBMITTED"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    RETURNED = "RETURNED"
    ACKNOWLEDGED = "ACKNOWLEDGED"


class MaterialDirection(str, Enum):
    INWARD = "INWARD"
    OUTWARD = "OUTWARD"


__all__ = [
    "AllocationStatus",
    "ApprovalAction",
    "AuditAction",
    "DocType",
    "IndentActivityType",
    "IndentItemStatus",
    "IndentStatus",
    "InstanceStatus",
    "MaterialDirection",
    "Priority",
    "RuleActionType",
]
