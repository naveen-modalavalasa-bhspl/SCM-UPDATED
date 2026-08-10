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
    # Set by inventory allocation once an approved indent has been checked against
    # stock (flow doc §3 steps 3-5).
    # Approval no longer allocates. It parks the indent here, in front of the person
    # who decides how much to give and from where.
    AWAITING_ALLOCATION = "AWAITING_ALLOCATION"
    ALLOCATED = "ALLOCATED"                       # every line reserved from stock
    PARTIALLY_FULFILLED = "PARTIALLY_FULFILLED"   # some reserved, rest went to an MR
    PENDING_PROCUREMENT = "PENDING_PROCUREMENT"   # nothing given, all of it to an MR
    PARTIALLY_ORDERED = "PARTIALLY_ORDERED"
    ORDERED = "ORDERED"
    CLOSED = "CLOSED"
    # An approver handed the request back for a fix without ending the approval:
    # the wf_instance stays IN_PROGRESS and resumes at the same rung on resubmit
    # (workflow.engine.return_for_correction / resubmit_correction). Not DRAFT —
    # a draft has no live approval behind it.
    RETURNED_FOR_CORRECTION = "RETURNED_FOR_CORRECTION"


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
    # Written when the document itself was withdrawn, so the approval behind it is
    # closed without anybody having decided anything. Not a decision — see
    # workflow.engine.abandon().
    CANCELLED = "CANCELLED"
    # Written when configuration failed to produce an approver and the hardcoded
    # reporting-manager ladder took over. Never an action a person performs.
    FALLBACK = "FALLBACK"


class StockDirection(str, Enum):
    IN = "IN"
    OUT = "OUT"


class AdjustmentReason(str, Enum):
    DAMAGE = "DAMAGE"
    SHORTAGE = "SHORTAGE"
    EXCESS = "EXCESS"
    CYCLE_COUNT = "CYCLE_COUNT"
    EXPIRY = "EXPIRY"
    QUALITY_REJECTION = "QUALITY_REJECTION"
    OPENING_BALANCE = "OPENING_BALANCE"
    OTHER = "OTHER"


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
    ALLOCATION = "ALLOCATION"   # inventory's decision on how much stock to give
    # The same decision, made by the person who HOLDS the stock rather than by the
    # inventory desk: an OE serving an indent out of his own MDP or a LIP under him.
    # A separate event because the approver is a different person for a different
    # reason — nobody above him owns that shelf, so climbing to a manager asks the
    # wrong question. Configured on its own row in Approvals Config.
    OWN_STOCK_ALLOCATION = "OWN_STOCK_ALLOCATION"
    # The physical issue out of a point you hold, to a point under you. Same document
    # as WH_ISSUE; different approver, for the same reason as OWN_STOCK_ALLOCATION —
    # the shelf is yours, so the sign-off is yours. Keeps the ordinary warehouse issue
    # ladder untouched.
    OWN_STOCK_ISSUE = "OWN_STOCK_ISSUE"
    # Stock that never belonged to this point: it arrived here on a consignment for an
    # indent whose delivery point sits below, and is only being passed along (WH -> MDP
    # -> LIP). The five people who signed the indent already sanctioned these goods, so
    # asking the MDP to justify forwarding them re-approves a settled decision. Its own
    # doc type rather than reusing OWN_STOCK_ISSUE, because that one means "I chose to
    # give MY stock" — switching its ladder off to quieten forwarding would silently
    # remove the sign-off from a real decision.
    FORWARD_ISSUE = "FORWARD_ISSUE"
    MR = "MR"          # material request — the indent -> procurement bridge
    PO = "PO"
    GRN = "GRN"
    ISSUE = "ISSUE"
    WH_ISSUE = "WH_ISSUE"
    DISPATCH = "DISPATCH"
    PURCHASE_RETURN = "PURCHASE_RETURN"
    # Stock moving sideways between two stocking points. Only ever put through the
    # engine when the two points sit in different projects — a same-project transfer
    # is the holder's own call and never starts a workflow at all.
    STOCK_TRANSFER = "STOCK_TRANSFER"


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
    RESERVATION = "RESERVATION"


class Priority(str, Enum):
    NORMAL = "NORMAL"
    URGENT = "URGENT"


# ---- Masters & Admin (this build) ----

class WarehouseType(str, Enum):
    """whs_warehouses.warehouse_type. The live column defaults to MAIN.

    LIP (Local Inventory Point) and MDP (Material Distribution Point) from flow doc §1
    are stocking points like any other — they hold real stock and can fulfil an indent.
    They differ only in who they serve, so they are a type here rather than a table.
    """
    MAIN = "MAIN"
    LIP = "LIP"
    MDP = "MDP"
    TRANSIT = "TRANSIT"
    QUARANTINE = "QUARANTINE"
    SCRAP = "SCRAP"


class BinType(str, Enum):
    """`whs_warehouse_locations.storage_type`. Locations nest through
    `parent_location_id`, so the whole Block → Floor → Lane → Rack → Shelf → Bin
    hierarchy of flow doc §1 is one table at different levels rather than six tables,
    and there is no separate bins table.

    Only BIN and COLD_STORAGE_BIN hold stock (`shared/models/warehouse.BIN_TYPES`);
    the rest are the structure you walk past to reach one. BLOCK, LANE, REFRIGERATOR
    and COLD_STORAGE_BIN are here because the live data uses them — a type the
    database contains but the enum rejects makes those rows uneditable.
    """
    BLOCK = "BLOCK"
    FLOOR = "FLOOR"
    LINE = "LINE"
    LANE = "LANE"
    ZONE = "ZONE"
    RACK = "RACK"
    SHELF = "SHELF"
    BIN = "BIN"
    LOT = "LOT"
    COLD_ROOM = "COLD_ROOM"
    COLD_STORAGE_BIN = "COLD_STORAGE_BIN"
    REFRIGERATOR = "REFRIGERATOR"
    STORAGE = "STORAGE"
    STAGING = "STAGING"


# ---- Inventory: reservations and material requests ----

class ReservationStatus(str, Enum):
    """inv_reservations.status. Released and consumed rows are kept, never deleted —
    "who held this stock in March" must stay answerable."""
    ACTIVE = "ACTIVE"
    RELEASED = "RELEASED"
    CONSUMED = "CONSUMED"


class AllocationStatus(str, Enum):
    """inv_allocations.status. The decision is a document so that "who chose to give
    40 rather than 60, and when" stays answerable."""
    DRAFT = "DRAFT"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    APPROVED = "APPROVED"          # only now is stock actually reserved
    REJECTED = "REJECTED"
    CANCELLED = "CANCELLED"


class MRStatus(str, Enum):
    """inv_material_requests.status. The bridge from a short indent to procurement."""
    DRAFT = "DRAFT"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    ORDERED = "ORDERED"
    CANCELLED = "CANCELLED"


class PickStrategy(str, Enum):
    """FEFO for anything carrying a batch or an expiry date — picking the nearest
    expiry first is the entire point of tracking expiry. FIFO for everything else."""
    FEFO = "FEFO"
    FIFO = "FIFO"


class IndentItemStatus(str, Enum):
    """ind_indent_items.status. Set by allocation, per line, after approval."""
    PENDING = "PENDING"
    ALLOCATED = "ALLOCATED"
    SHORT = "SHORT"
    ISSUED = "ISSUED"


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


class UomClass(str, Enum):
    """mst_uom.uom_class. What a unit measures.

    Required on every UOM, because a conversion between units of different classes is
    meaningless: litres never become kilograms. It is also what lets the item form
    offer only the units that fit the measurement being taken.

    PACKAGING is the odd one out — a box is not an SI dimension — but a packaging
    chain counts trays and boxes the same way a recipe counts litres, and giving them
    a class of their own keeps them out of the physical unit lists.
    """
    COUNT = "COUNT"
    LENGTH = "LENGTH"
    AREA = "AREA"
    VOLUME = "VOLUME"
    WEIGHT = "WEIGHT"
    TEMPERATURE = "TEMPERATURE"
    TIME = "TIME"
    PRESSURE = "PRESSURE"
    ENERGY = "ENERGY"
    PACKAGING = "PACKAGING"


class AttributeDataType(str, Enum):
    """What kind of value an attribute holds. Drives the input the UI shows and how
    the value is validated before it is stored."""
    TEXT = "TEXT"
    NUMBER = "NUMBER"
    BOOLEAN = "BOOLEAN"
    DATE = "DATE"
    LIST = "LIST"        # one of mst_attributes.allowed_values


class AttributeTarget(str, Enum):
    """What an attribute mapping attaches to. A mapping says "items of this kind need
    this attribute"; the per-item VALUE lives in mst_item_specs.specifications.

    Superseded by CategoryTagType: tagging is now always to a category, and one
    table covers attributes, specs and features. Kept only because the live
    mst_attribute_mappings table still carries the column.
    """
    CATEGORY = "CATEGORY"
    ITEM_CLASS = "ITEM_CLASS"


class CategoryTagType(str, Enum):
    """What a category tag attaches to that category.

    Three kinds of thing hang off a category and all three answer the same two
    questions — which one, and is it required — so they share one table rather than
    three near-identical ones.

    ATTRIBUTE is a selectable trait: colour, size, grade. It has a value list.
    SPEC is a measurement: voltage 240 V, pressure 10 bar. It carries a UOM.
    FEATURE is a yes/no trait: fragile, hazardous. It has no value at all.
    """
    ATTRIBUTE = "ATTRIBUTE"
    SPEC = "SPEC"
    FEATURE = "FEATURE"


class PriceType(str, Enum):
    PURCHASE = "PURCHASE"
    SALE = "SALE"
    TRANSFER = "TRANSFER"


class BomType(str, Enum):
    """mst_boms.bom_type. The live column defaults to GENERAL."""
    GENERAL = "GENERAL"
    KIT = "KIT"
    ASSEMBLY = "ASSEMBLY"
    VEHICLE = "VEHICLE"


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


class ScopeRung(str, Enum):
    """How far a job profile can see. Rows, not pages.

    Splitting profiles fixes WHICH SCREENS someone gets; it does nothing about
    WHOSE ROWS. District Manager Anantapur and District Manager Kurnool are one
    profile doing one job — they must not read each other's documents.

    The ladder is HCM's own, read off hcm_positions.raw["office_level"]:
    FACILITATE -> BRANCH OFFICE -> DISTRICT/REGIONAL OFFICE -> HEAD OFFICE.
    """
    SELF = "SELF"            # only documents the login raised
    OFFICE = "OFFICE"        # own hcm office
    SUBTREE = "SUBTREE"      # own position and everything reporting under it
    PROJECT = "PROJECT"      # own hcm_employees.project_id
    ALL = "ALL"              # the whole network
