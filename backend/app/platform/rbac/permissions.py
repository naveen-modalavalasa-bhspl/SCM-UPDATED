"""The master list of SCM permission codes. Convention: <resource>.<action>.

These are the ONLY permission codes that exist — a permission exists because code
checks it here. The seed script inserts these into rbac_permissions; admins assign
them to roles but never invent new ones.
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class Perm:
    code: str
    module: str
    resource: str
    action: str
    description: str


# --- Indents ---
INDENT_VIEW = "indent.view"
INDENT_CREATE = "indent.create"
INDENT_EDIT = "indent.edit"
INDENT_DELETE = "indent.delete"
INDENT_SUBMIT = "indent.submit"
INDENT_APPROVE = "indent.approve"
INDENT_REJECT = "indent.reject"

# --- Purchase Orders ---
PO_VIEW = "po.view"
PO_CREATE = "po.create"
PO_EDIT = "po.edit"
PO_SUBMIT = "po.submit"
PO_APPROVE = "po.approve"
PO_REJECT = "po.reject"
PO_SEND_VENDOR = "po.send_vendor"

# --- GRN ---
GRN_VIEW = "grn.view"
GRN_CREATE = "grn.create"
GRN_QC = "grn.qc"

# --- Stock ---
STOCK_VIEW = "stock.view"
STOCK_ADJUST = "stock.adjust"
STOCK_RESERVE = "stock.reserve"
STOCK_TRANSFER = "stock.transfer"
ALLOCATION_VIEW = "allocation.view"
ALLOCATION_CREATE = "allocation.create"
ALLOCATION_APPROVE = "allocation.approve"
ALLOCATION_REJECT = "allocation.reject"
MR_VIEW = "mr.view"
MR_CREATE = "mr.create"
MR_APPROVE = "mr.approve"
MR_REJECT = "mr.reject"

# --- Issues ---
ISSUE_VIEW = "issue.view"
ISSUE_CREATE = "issue.create"
ISSUE_ISSUE = "issue.issue"

# --- Masters ---
MASTER_ITEM_MANAGE = "master.item.manage"
MASTER_VENDOR_MANAGE = "master.vendor.manage"
MASTER_CATEGORY_MANAGE = "master.category.manage"
MASTER_UOM_MANAGE = "master.uom.manage"
MASTER_LOCATION_MANAGE = "master.location.manage"
MASTER_PROJECT_MANAGE = "master.project.manage"
MASTER_BRAND_MANAGE = "master.brand.manage"
MASTER_CLASS_MANAGE = "master.class.manage"
MASTER_PACKAGING_MANAGE = "master.packaging.manage"
MASTER_FEATURE_MANAGE = "master.feature.manage"
MASTER_ATTRIBUTE_MANAGE = "master.attribute.manage"
MASTER_PRICE_MANAGE = "master.price.manage"
MASTER_BOM_MANAGE = "master.bom.manage"
MASTER_SPEC_MANAGE = "master.spec.manage"
MASTER_HSN_MANAGE = "master.hsn.manage"

# --- Admin ---
ADMIN_ROLES_MANAGE = "admin.roles.manage"
ADMIN_WORKFLOW_MANAGE = "admin.workflow.manage"
ADMIN_USERS_MANAGE = "admin.users.manage"
ADMIN_GROUPS_MANAGE = "admin.groups.manage"
ADMIN_RULES_MANAGE = "admin.rules.manage"
ADMIN_NUMBERING_MANAGE = "admin.numbering.manage"
ADMIN_AUDIT_VIEW = "admin.audit.view"
ADMIN_NOTIFICATIONS_MANAGE = "admin.notifications.manage"
ADMIN_SETTINGS_MANAGE = "admin.settings.manage"


ALL_PERMISSIONS: list[Perm] = [
    Perm(INDENT_VIEW, "indents", "indent", "view", "View indents"),
    Perm(INDENT_CREATE, "indents", "indent", "create", "Create indents"),
    Perm(INDENT_EDIT, "indents", "indent", "edit", "Edit indents"),
    Perm(INDENT_DELETE, "indents", "indent", "delete", "Delete indents"),
    Perm(INDENT_SUBMIT, "indents", "indent", "submit", "Submit indents for approval"),
    Perm(INDENT_APPROVE, "indents", "indent", "approve", "Approve indents"),
    Perm(INDENT_REJECT, "indents", "indent", "reject", "Reject indents"),
    Perm(PO_VIEW, "procurement", "po", "view", "View purchase orders"),
    Perm(PO_CREATE, "procurement", "po", "create", "Create purchase orders"),
    Perm(PO_EDIT, "procurement", "po", "edit", "Edit purchase orders"),
    Perm(PO_SUBMIT, "procurement", "po", "submit", "Submit POs for approval"),
    Perm(PO_APPROVE, "procurement", "po", "approve", "Approve purchase orders"),
    Perm(PO_REJECT, "procurement", "po", "reject", "Reject purchase orders"),
    Perm(PO_SEND_VENDOR, "procurement", "po", "send_vendor", "Send PO to vendor"),
    Perm(GRN_VIEW, "logistics", "grn", "view", "View GRNs"),
    Perm(GRN_CREATE, "logistics", "grn", "create", "Create GRNs"),
    Perm(GRN_QC, "logistics", "grn", "qc", "QC pass/fail a GRN"),
    # module is "inventory": stk_* moved there when Inventory became the base module.
    Perm(STOCK_VIEW, "inventory", "stock", "view", "View stock"),
    Perm(STOCK_ADJUST, "inventory", "stock", "adjust", "Adjust stock"),
    Perm(STOCK_RESERVE, "inventory", "stock", "reserve", "Reserve stock for a document"),
    Perm(STOCK_TRANSFER, "inventory", "stock", "transfer",
         "Transfer stock between warehouses"),
    Perm(ALLOCATION_VIEW, "inventory", "allocation", "view", "View stock allocations"),
    Perm(ALLOCATION_CREATE, "inventory", "allocation", "create",
         "Decide how much stock an indent gets"),
    Perm(ALLOCATION_APPROVE, "inventory", "allocation", "approve",
         "Approve a stock allocation"),
    Perm(ALLOCATION_REJECT, "inventory", "allocation", "reject",
         "Reject a stock allocation"),
    Perm(MR_VIEW, "inventory", "material_request", "view", "View material requests"),
    Perm(MR_CREATE, "inventory", "material_request", "create", "Create material requests"),
    Perm(MR_APPROVE, "inventory", "material_request", "approve",
         "Approve material requests"),
    Perm(MR_REJECT, "inventory", "material_request", "reject", "Reject material requests"),
    Perm(ISSUE_VIEW, "logistics", "issue", "view", "View issues"),
    Perm(ISSUE_CREATE, "logistics", "issue", "create", "Create issues"),
    Perm(ISSUE_ISSUE, "logistics", "issue", "issue", "Issue stock to a department"),
    Perm(MASTER_ITEM_MANAGE, "masters", "item", "manage", "Manage items"),
    Perm(MASTER_VENDOR_MANAGE, "masters", "vendor", "manage", "Manage vendors"),
    Perm(MASTER_CATEGORY_MANAGE, "masters", "category", "manage", "Manage item categories"),
    Perm(MASTER_UOM_MANAGE, "masters", "uom", "manage", "Manage units of measure"),
    Perm(MASTER_LOCATION_MANAGE, "masters", "location", "manage",
         "Manage warehouses & bins"),
    Perm(MASTER_PROJECT_MANAGE, "masters", "project", "manage", "Manage projects"),
    Perm(MASTER_BRAND_MANAGE, "masters", "brand", "manage", "Manage brands"),
    Perm(MASTER_CLASS_MANAGE, "masters", "class", "manage", "Manage item classes"),
    Perm(MASTER_PACKAGING_MANAGE, "masters", "packaging", "manage", "Manage packaging"),
    Perm(MASTER_FEATURE_MANAGE, "masters", "feature", "manage", "Manage features"),
    Perm(MASTER_ATTRIBUTE_MANAGE, "masters", "attribute", "manage",
         "Manage attributes & attribute mapping"),
    Perm(MASTER_PRICE_MANAGE, "masters", "price", "manage", "Manage price lists"),
    Perm(MASTER_BOM_MANAGE, "masters", "bom", "manage", "Manage bills of material"),
    Perm(MASTER_SPEC_MANAGE, "masters", "spec", "manage", "Manage item specifications"),
    Perm(MASTER_HSN_MANAGE, "masters", "hsn", "manage", "Manage HSN codes and tax rates"),
    Perm(ADMIN_ROLES_MANAGE, "admin", "roles", "manage", "Manage roles & permissions"),
    Perm(ADMIN_WORKFLOW_MANAGE, "admin", "workflow", "manage", "Manage approval workflows"),
    Perm(ADMIN_USERS_MANAGE, "admin", "users", "manage", "Manage users & HCM sync"),
    Perm(ADMIN_GROUPS_MANAGE, "admin", "groups", "manage", "Manage user groups"),
    Perm(ADMIN_RULES_MANAGE, "admin", "rules", "manage", "Manage the rules engine"),
    Perm(ADMIN_NUMBERING_MANAGE, "admin", "numbering", "manage",
         "Manage document numbering series"),
    Perm(ADMIN_AUDIT_VIEW, "admin", "audit", "view", "View the audit log"),
    Perm(ADMIN_NOTIFICATIONS_MANAGE, "admin", "notifications", "manage",
         "Manage notification settings"),
    Perm(ADMIN_SETTINGS_MANAGE, "admin", "settings", "manage",
         "Manage system settings"),
]

ALL_CODES: list[str] = [p.code for p in ALL_PERMISSIONS]
