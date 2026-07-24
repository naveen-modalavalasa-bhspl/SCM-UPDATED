"""ALL status/enum values in the entire system. Never type a raw status string.

Values marked (added) are not in guide Part 6 but are required by the higher-
precedence addendum (Part D workflow engine) or by doc 03. See root CLAUDE.md
"Deviations" for the rationale.
"""
from enum import Enum


class IndentStatus(str, Enum):
    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    PENDING_APPROVAL = "PENDING_APPROVAL"   # added: engine uses it (addendum Part D)
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    PARTIALLY_ORDERED = "PARTIALLY_ORDERED"
    ORDERED = "ORDERED"
    CLOSED = "CLOSED"


class POStatus(str, Enum):
    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    PENDING_APPROVAL = "PENDING_APPROVAL"   # added
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    SENT_TO_VENDOR = "SENT_TO_VENDOR"
    PARTIALLY_RECEIVED = "PARTIALLY_RECEIVED"
    RECEIVED = "RECEIVED"
    CLOSED = "CLOSED"
    CANCELLED = "CANCELLED"


class GRNStatus(str, Enum):
    DRAFT = "DRAFT"
    RECEIVED = "RECEIVED"
    QC_PASSED = "QC_PASSED"
    QC_FAILED = "QC_FAILED"
    CLOSED = "CLOSED"


class IssueStatus(str, Enum):
    DRAFT = "DRAFT"
    ISSUED = "ISSUED"
    CANCELLED = "CANCELLED"


class ApprovalAction(str, Enum):
    SUBMITTED = "SUBMITTED"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    RETURNED = "RETURNED"        # added: wf_actions (addendum Part D)
    DELEGATED = "DELEGATED"      # added


class StockDirection(str, Enum):
    IN = "IN"
    OUT = "OUT"


class UserRole(str, Enum):
    """Seed role CODES. Roles are data in rbac_roles; there is no user.role column."""
    ADMIN = "ADMIN"
    REQUESTER = "REQUESTER"
    APPROVER = "APPROVER"
    PROCUREMENT = "PROCUREMENT"
    STORE = "STORE"


# ---- Workflow engine enums (addendum Part D; values defined there, enumerated here) ----

class DocType(str, Enum):
    INDENT = "INDENT"
    PO = "PO"
    GRN = "GRN"
    ISSUE = "ISSUE"


class InstanceStatus(str, Enum):
    IN_PROGRESS = "IN_PROGRESS"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    CANCELLED = "CANCELLED"


class ApproverType(str, Enum):
    POSITION = "POSITION"
    ROLE = "ROLE"
    SPECIFIC_USER = "SPECIFIC_USER"
    DEPT_HEAD = "DEPT_HEAD"
    REPORTING_MANAGER = "REPORTING_MANAGER"


class ApprovalMode(str, Enum):
    ANY_ONE = "ANY_ONE"
    ALL = "ALL"
    MAJORITY = "MAJORITY"


class ConditionOperator(str, Enum):
    GT = "GT"
    GTE = "GTE"
    LT = "LT"
    LTE = "LTE"
    EQ = "EQ"
    IN = "IN"


class ConditionLogic(str, Enum):
    AND = "AND"
    OR = "OR"


class RefType(str, Enum):
    GRN = "GRN"
    ISSUE = "ISSUE"
    ADJUSTMENT = "ADJUSTMENT"
    TRANSFER = "TRANSFER"


class Priority(str, Enum):
    NORMAL = "NORMAL"
    URGENT = "URGENT"
