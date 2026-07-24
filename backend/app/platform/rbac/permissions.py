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

# --- Issues ---
ISSUE_VIEW = "issue.view"
ISSUE_CREATE = "issue.create"
ISSUE_ISSUE = "issue.issue"

# --- Masters ---
MASTER_ITEM_MANAGE = "master.item.manage"
MASTER_VENDOR_MANAGE = "master.vendor.manage"

# --- Admin ---
ADMIN_ROLES_MANAGE = "admin.roles.manage"
ADMIN_WORKFLOW_MANAGE = "admin.workflow.manage"
ADMIN_USERS_MANAGE = "admin.users.manage"


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
    Perm(STOCK_VIEW, "logistics", "stock", "view", "View stock"),
    Perm(STOCK_ADJUST, "logistics", "stock", "adjust", "Adjust stock"),
    Perm(ISSUE_VIEW, "logistics", "issue", "view", "View issues"),
    Perm(ISSUE_CREATE, "logistics", "issue", "create", "Create issues"),
    Perm(ISSUE_ISSUE, "logistics", "issue", "issue", "Issue stock to a department"),
    Perm(MASTER_ITEM_MANAGE, "masters", "item", "manage", "Manage items"),
    Perm(MASTER_VENDOR_MANAGE, "masters", "vendor", "manage", "Manage vendors"),
    Perm(ADMIN_ROLES_MANAGE, "admin", "roles", "manage", "Manage roles & permissions"),
    Perm(ADMIN_WORKFLOW_MANAGE, "admin", "workflow", "manage", "Manage approval workflows"),
    Perm(ADMIN_USERS_MANAGE, "admin", "users", "manage", "Manage users & HCM sync"),
]

ALL_CODES: list[str] = [p.code for p in ALL_PERMISSIONS]
