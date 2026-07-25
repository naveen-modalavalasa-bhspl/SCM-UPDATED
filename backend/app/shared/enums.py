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
    NEQ = "NEQ"      # added: rules engine needs exclusion ("category is not X")
    IN = "IN"
    NOT_IN = "NOT_IN"    # added
    BETWEEN = "BETWEEN"  # added: "field_value" is "lo,hi"


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


# ---- Masters & Admin (this build) ----

class WarehouseType(str, Enum):
    """whs_warehouses.warehouse_type. The live column defaults to MAIN."""
    MAIN = "MAIN"
    TRANSIT = "TRANSIT"
    QUARANTINE = "QUARANTINE"
    SCRAP = "SCRAP"


class BinType(str, Enum):
    """whs_bins.bin_type. Bins nest through parent_id, so ZONE/RACK/SHELF are the same
    table at different levels rather than three tables."""
    ZONE = "ZONE"
    RACK = "RACK"
    SHELF = "SHELF"
    STORAGE = "STORAGE"
    STAGING = "STAGING"


class GroupType(str, Enum):
    """How rbac_user_groups derives its members. LOCATION groups are the
    "sub-groups by place"; they hang off a parent group via parent_id.

    ROLE and HCM_ROLE are different things and both are needed. ROLE means an SCM
    permission role from rbac_roles (APPROVER, STORE) — what someone may do. HCM_ROLE
    means the org role mirrored from HCM ("Network Technicians") — what someone is.
    An employee typically holds several HCM positions and roles at once; that is
    normal and the resolver unions them.
    """
    ROLE = "ROLE"
    POSITION = "POSITION"
    HCM_ROLE = "HCM_ROLE"
    LOCATION = "LOCATION"


class RuleActionType(str, Enum):
    ROUTE_APPROVAL = "ROUTE_APPROVAL"          # delegates to platform/workflow/engine.py
    ROUTE_FULFILLMENT = "ROUTE_FULFILLMENT"
    SPLIT_FULFILLMENT = "SPLIT_FULFILLMENT"
    NOTIFY = "NOTIFY"
    SET_FIELD = "SET_FIELD"


class FulfillmentTarget(str, Enum):
    INVENTORY = "INVENTORY"
    WAREHOUSE = "WAREHOUSE"
    PROCUREMENT = "PROCUREMENT"


class RecipientType(str, Enum):
    ROLE = "ROLE"
    POSITION = "POSITION"
    GROUP = "GROUP"
    EMPLOYEE = "EMPLOYEE"


class NotificationChannel(str, Enum):
    IN_APP = "IN_APP"
    EMAIL = "EMAIL"


class AuditAction(str, Enum):
    CREATE = "CREATE"
    UPDATE = "UPDATE"
    DEACTIVATE = "DEACTIVATE"
    ACTIVATE = "ACTIVATE"
    LOGIN = "LOGIN"
    ACCESS_GRANTED = "ACCESS_GRANTED"
    ACCESS_REVOKED = "ACCESS_REVOKED"


class ResetPolicy(str, Enum):
    """When sys_doc_series.last_number returns to zero."""
    NEVER = "NEVER"
    YEARLY = "YEARLY"
    MONTHLY = "MONTHLY"
