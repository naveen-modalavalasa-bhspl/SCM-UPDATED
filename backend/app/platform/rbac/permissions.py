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
# Confirming the goods physically arrived. Held by requesters, not approvers — the
# service also checks the actor raised the indent, because this is the one step nobody
# else can perform on their behalf.
INDENT_ACKNOWLEDGE = "indent.acknowledge"
# Seeing requests you neither raised nor approved, because you have to FILL them.
# Inventory and the warehouse work the fulfilment queue; nobody else has a reason to
# read another department's indent. Split out of stock.view/mr.view, which every one
# of the 25 roles holds — gating the queue on those showed all 2,801 logins every
# approved indent in the company.
INDENT_VIEW_FULFILMENT = "indent.view.fulfilment"

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
# Stock is normally scoped to the login's own office. Inventory runs the whole
# network — they choose which warehouse fills an indent — so they see every one.
STOCK_VIEW_ALL = "stock.view.all"
STOCK_ADJUST = "stock.adjust"
STOCK_RESERVE = "stock.reserve"
# Valuation exposes purchase cost, so it is separate from plain stock visibility.
STOCK_VALUATION_VIEW = "stock.valuation.view"
STOCK_TRANSFER = "stock.transfer"
STOCK_VIEW_SUBTREE = "stock.view.subtree"
# Configuring the MDP/LIP chain is inventory's own business. It used to borrow
# admin.settings.manage, which quietly handed whoever could see the Stocking Points
# screen the whole admin settings permission — and that one unscopes every stock
# list. A module's configuration screen gets a module permission.
STOCK_POINTS_MANAGE = "stock.points.manage"
# Under `stock`, not a resource of its own: a one-permission resource would open a
# lone group in Job Profiles beside the real ones, which reads as a mistake.
STOCK_TRANSFER_APPROVE = "stock.transfer.approve"
ALLOCATION_VIEW = "allocation.view"
ALLOCATION_CREATE = "allocation.create"
ALLOCATION_APPROVE = "allocation.approve"
ALLOCATION_REJECT = "allocation.reject"
# The two buttons that actually move an allocation, named after what they say on
# screen so an admin unticking one knows which button goes away.
#
# They sit BESIDE allocation.create / allocation.approve rather than replacing them:
# those two still guard reading and building the decision, these guard committing it.
# Both are required on the endpoint, so unticking the button permission stops the
# request as well as hiding the control (rule 6 — hiding a button is not security).
#
# Neither one decides WHO may sign: the ladder does, and the Approve and reserve
# button is only offered to the position the workflow is actually waiting on. This is
# the second gate, not a replacement for the first.
ALLOCATION_SUBMIT = "allocation.submit"
ALLOCATION_APPROVE_RESERVE = "allocation.approve_reserve"
MR_VIEW = "mr.view"
MR_CREATE = "mr.create"
MR_APPROVE = "mr.approve"
MR_REJECT = "mr.reject"

# --- Issues ---
ISSUE_VIEW = "issue.view"
ISSUE_CREATE = "issue.create"
ISSUE_ISSUE = "issue.issue"
# Passing an arrived consignment on to a point below (WH -> MDP -> LIP). Separate from
# ISSUE_CREATE because the people who forward are not the people who decide what leaves
# a main warehouse.
ISSUE_FORWARD = "issue.forward"

# --- Warehouse ---
# The warehouse module runs the physical dock-to-stock cycle: receipt -> inspection
# -> putaway, and picking -> issue -> dispatch -> return. GRN_* above stays for the
# older logistics GRN screens; these guard the warehouse endpoints.
RECEIPT_VIEW = "receipt.view"
RECEIPT_CREATE = "receipt.create"
RECEIPT_POST = "receipt.post"
INSPECTION_VIEW = "inspection.view"
INSPECTION_EXECUTE = "inspection.execute"
PUTAWAY_VIEW = "putaway.view"
PUTAWAY_EXECUTE = "putaway.execute"
PICKING_VIEW = "picking.view"
PICKING_PICK = "picking.pick"
DISPATCH_VIEW = "dispatch.view"
DISPATCH_CREATE = "dispatch.create"
DISPATCH_APPROVE = "dispatch.approve"
DISPATCH_GATE_OUT = "dispatch.gate_out"
DISPATCH_ACKNOWLEDGE = "dispatch.acknowledge"
RETURN_VIEW = "return.view"
RETURN_CREATE = "return.create"
RETURN_APPROVE = "return.approve"
WAREHOUSE_REPORT_VIEW = "warehouse.report.view"
# Deleting an abandoned draft. Separate from create/execute on purpose: a storekeeper
# who raises documents is not automatically someone who may remove them, and the
# reverse is true for a supervisor tidying a queue.
RECEIPT_DELETE = "receipt.delete"
INSPECTION_DELETE = "inspection.delete"
PUTAWAY_DELETE = "putaway.delete"
PICKING_DELETE = "picking.delete"
ISSUE_DELETE = "issue.delete"
DISPATCH_DELETE = "dispatch.delete"
RETURN_DELETE = "return.delete"
MOVEMENT_DELETE = "movement.delete"

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

# --- Reports (cross-module read-only ledgers) ---
REPORT_VIEW = "report.view"
REPORT_EXPORT = "report.export"

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
# Separate from admin.settings.manage on purpose: the asset/consumable code formula
# decides what every future unit is labelled with, so it is granted deliberately
# rather than riding along with "can edit the company address".
ADMIN_CODE_FORMATS_MANAGE = "admin.code_formats.manage"

# --- Returns ---
# A return borrows no permission from stock. It reads like a transfer and it ends in
# one, but the people are different: a LIP storekeeper raises returns and must never
# be able to transfer stock sideways, and the decision desk that says where returned
# material goes is not the desk that approves an outward move.
RETURN_VIEW = "return.view"
RETURN_CREATE = "return.create"
RETURN_APPROVE = "return.approve"
# Where the material goes — scrap, vendor, restock, disposal. Its own code because it
# is a commercial call (a scrapped batch is written off), not a movement sign-off.
RETURN_DECIDE = "return.decide"
# The floor agreeing the decision is workable, or sending it back for a fresh one.
RETURN_ENDORSE = "return.endorse"
# Which posts receive returns. Configuration, so it sits with the other config codes
# rather than with the document ones.
RETURN_CONFIG_MANAGE = "return.config.manage"

# --- Integrations (the API console) ---
# Not admin.settings.manage: that code also unscopes stock lists and covers the
# company address. Minting a key that lets an outside system read the database is its
# own decision, and seeing which systems are connected is not the same as issuing one.
INTEGRATION_VIEW = "integration.view"
INTEGRATION_MANAGE = "integration.manage"
# The one that hands out credentials. Separate from MANAGE so composing an endpoint
# and issuing a key can be held by different people.
INTEGRATION_KEYS_MANAGE = "integration.keys.manage"


ALL_PERMISSIONS: list[Perm] = [
    Perm(INDENT_VIEW, "indents", "indent", "view", "View indents"),
    Perm(INDENT_CREATE, "indents", "indent", "create", "Create indents"),
    Perm(INDENT_EDIT, "indents", "indent", "edit", "Edit indents"),
    Perm(INDENT_DELETE, "indents", "indent", "delete", "Delete indents"),
    Perm(INDENT_SUBMIT, "indents", "indent", "submit", "Submit indents for approval"),
    Perm(INDENT_APPROVE, "indents", "indent", "approve", "Approve indents"),
    Perm(INDENT_REJECT, "indents", "indent", "reject", "Reject indents"),
    Perm(INDENT_ACKNOWLEDGE, "indents", "indent", "acknowledge",
         "Acknowledge receipt of indent goods"),
    Perm(INDENT_VIEW_FULFILMENT, "indents", "indent", "view_fulfilment",
         "View approved indents awaiting fulfilment, raised by anyone"),
    Perm(PO_VIEW, "procurement", "po", "view", "View purchase orders"),
    Perm(PO_CREATE, "procurement", "po", "create", "Create purchase orders"),
    Perm(PO_EDIT, "procurement", "po", "edit", "Edit purchase orders"),
    Perm(PO_SUBMIT, "procurement", "po", "submit", "Submit POs for approval"),
    Perm(PO_APPROVE, "procurement", "po", "approve", "Approve purchase orders"),
    Perm(PO_REJECT, "procurement", "po", "reject", "Reject purchase orders"),
    Perm(PO_SEND_VENDOR, "procurement", "po", "send_vendor", "Send PO to vendor"),
    # module is "warehouse", not "logistics": the endpoints still live in
    # modules/logistics, but its GRN and issue screens are gone — no route in App.tsx,
    # no rbac_pages row — and the surviving screens are /warehouse/grn and
    # /warehouse/material-issues. This column decides which module the RBAC screens
    # file a button under, so it has to name where the screen is, not which module
    # first served the endpoint.
    Perm(GRN_VIEW, "warehouse", "grn", "view", "View GRNs"),
    Perm(GRN_CREATE, "warehouse", "grn", "create", "Create GRNs"),
    Perm(GRN_QC, "warehouse", "grn", "qc", "QC pass/fail a GRN"),
    # module is "inventory": stk_* moved there when Inventory became the base module.
    Perm(STOCK_VIEW, "inventory", "stock", "view", "View stock"),
    Perm(STOCK_VIEW_ALL, "inventory", "stock", "view_all",
         "View stock in every warehouse, not just your own office"),
    Perm(STOCK_ADJUST, "inventory", "stock", "adjust", "Adjust stock"),
    Perm(STOCK_RESERVE, "inventory", "stock", "reserve", "Reserve stock for a document"),
    Perm(STOCK_VALUATION_VIEW, "inventory", "stock_valuation", "view",
         "View stock valuation and cost"),
    Perm(STOCK_TRANSFER, "inventory", "stock", "transfer",
         "Transfer stock between warehouses"),
    Perm(STOCK_VIEW_SUBTREE, "inventory", "stock", "view_subtree",
         "View stock at every point reporting under you, not just your own"),
    Perm(STOCK_POINTS_MANAGE, "inventory", "stock", "points_manage",
         "Tag positions to stocking points (MDP / LIP)"),
    Perm(STOCK_TRANSFER_APPROVE, "inventory", "stock", "transfer_approve",
         "Approve a stock transfer that crosses a project boundary"),
    Perm(ALLOCATION_VIEW, "inventory", "allocation", "view", "View stock allocations"),
    Perm(ALLOCATION_CREATE, "inventory", "allocation", "create",
         "Decide how much stock an indent gets"),
    Perm(ALLOCATION_APPROVE, "inventory", "allocation", "approve",
         "Approve a stock allocation"),
    Perm(ALLOCATION_REJECT, "inventory", "allocation", "reject",
         "Reject a stock allocation"),
    Perm(ALLOCATION_SUBMIT, "inventory", "allocation", "submit",
         'Use the "Submit for approval" button on the Fulfilment Queue'),
    Perm(ALLOCATION_APPROVE_RESERVE, "inventory", "allocation", "approve_reserve",
         'Use the "Approve and reserve" button on Allocation Approvals'),
    Perm(MR_VIEW, "inventory", "material_request", "view", "View material requests"),
    Perm(MR_CREATE, "inventory", "material_request", "create", "Create material requests"),
    Perm(MR_APPROVE, "inventory", "material_request", "approve",
         "Approve material requests"),
    Perm(MR_REJECT, "inventory", "material_request", "reject", "Reject material requests"),
    # See the GRN block above: the screen is /warehouse/material-issues.
    Perm(ISSUE_VIEW, "warehouse", "issue", "view", "View issues"),
    Perm(ISSUE_CREATE, "warehouse", "issue", "create", "Create issues"),
    Perm(ISSUE_ISSUE, "warehouse", "issue", "issue", "Issue stock to a department"),
    Perm(ISSUE_FORWARD, "warehouse", "issue", "forward",
         "Forward an arrived consignment on to a point below"),
    Perm(RECEIPT_VIEW, "warehouse", "receipt", "view", "View goods receipts"),
    Perm(RECEIPT_CREATE, "warehouse", "receipt", "create", "Create goods receipts"),
    Perm(RECEIPT_POST, "warehouse", "receipt", "post", "Post a goods receipt"),
    Perm(INSPECTION_VIEW, "warehouse", "inspection", "view", "View quality inspections"),
    Perm(INSPECTION_EXECUTE, "warehouse", "inspection", "execute",
         "Record a quality inspection result"),
    Perm(PUTAWAY_VIEW, "warehouse", "putaway", "view", "View put-away tasks"),
    Perm(PUTAWAY_EXECUTE, "warehouse", "putaway", "execute", "Put stock away into bins"),
    Perm(PICKING_VIEW, "warehouse", "picking", "view", "View material fulfilments"),
    Perm(PICKING_PICK, "warehouse", "picking", "pick", "Pick stock for material fulfilment"),
    Perm(DISPATCH_VIEW, "warehouse", "dispatch", "view", "View dispatches"),
    Perm(DISPATCH_CREATE, "warehouse", "dispatch", "create", "Create dispatches"),
    Perm(DISPATCH_APPROVE, "warehouse", "dispatch", "approve", "Approve a dispatch"),
    Perm(DISPATCH_GATE_OUT, "warehouse", "dispatch", "gate_out",
         "Gate a dispatch out of the plant"),
    Perm(DISPATCH_ACKNOWLEDGE, "warehouse", "dispatch", "acknowledge",
         "Acknowledge delivery of a dispatch"),
    Perm(RETURN_VIEW, "warehouse", "return", "view", "View purchase returns"),
    Perm(RETURN_CREATE, "warehouse", "return", "create", "Create purchase returns"),
    Perm(RETURN_APPROVE, "warehouse", "return", "approve", "Approve a purchase return"),
    Perm(WAREHOUSE_REPORT_VIEW, "warehouse", "report", "view", "View warehouse reports"),
    Perm(RECEIPT_DELETE, "warehouse", "receipt", "delete", "Delete a draft receipt"),
    Perm(INSPECTION_DELETE, "warehouse", "inspection", "delete",
         "Delete a draft inspection"),
    Perm(PUTAWAY_DELETE, "warehouse", "putaway", "delete", "Delete a draft put-away"),
    Perm(PICKING_DELETE, "warehouse", "picking", "delete", "Delete a draft picklist"),
    Perm(ISSUE_DELETE, "warehouse", "issue", "delete", "Delete a draft issue"),
    Perm(DISPATCH_DELETE, "warehouse", "dispatch", "delete", "Delete a draft dispatch"),
    Perm(RETURN_DELETE, "warehouse", "return", "delete", "Delete a draft return"),
    Perm(MOVEMENT_DELETE, "warehouse", "movement", "delete",
         "Delete a draft stock movement"),
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
    Perm(ADMIN_CODE_FORMATS_MANAGE, "admin", "code_formats", "manage",
         "Set the asset & consumable code formula"),
    Perm(RETURN_VIEW, "returns", "return", "view", "View returns"),
    Perm(RETURN_CREATE, "returns", "return", "create",
         "Raise and submit a return"),
    Perm(RETURN_APPROVE, "returns", "return", "approve",
         "Approve or reject a return"),
    Perm(RETURN_DECIDE, "returns", "return", "decide",
         "Decide where returned material goes"),
    Perm(RETURN_ENDORSE, "returns", "return", "endorse",
         "Endorse or object to a return decision"),
    Perm(RETURN_CONFIG_MANAGE, "returns", "return", "config_manage",
         "Set which posts receive returns"),
    Perm(INTEGRATION_VIEW, "integrations", "integration", "view",
         "See connected applications and their endpoints"),
    Perm(INTEGRATION_MANAGE, "integrations", "integration", "manage",
         "Register applications and compose their API endpoints"),
    Perm(INTEGRATION_KEYS_MANAGE, "integrations", "integration", "keys_manage",
         "Issue and revoke API keys"),
    Perm(REPORT_VIEW, "reports", "report", "view",
         "View the cross-module report ledgers"),
    Perm(REPORT_EXPORT, "reports", "report", "export",
         "Export a report ledger to Excel or CSV"),
]

ALL_CODES: list[str] = [p.code for p in ALL_PERMISSIONS]


# --------------------------------------------------------------------------- #
#  Permissions that SPLIT an existing one
# --------------------------------------------------------------------------- #
# A brand-new capability is granted to Admin and nobody else — the fail-closed rule in
# page_registry. But a permission carved out of one that is already live is not a new
# capability: everybody holding the old one could already press the button, and
# shipping it fail-closed would silently take that away from every job profile until
# an admin noticed.
#
# So on FIRST INSERT only, the new code is granted to every role that already holds
# its source. Behaviour on the day of deploy is identical; from then on the two are
# independent and unticking the new one removes the button. Re-running changes
# nothing — the row exists, so the copy never happens twice.
INHERITS_GRANTS_FROM: dict[str, str] = {
    ALLOCATION_SUBMIT: ALLOCATION_CREATE,
    ALLOCATION_APPROVE_RESERVE: ALLOCATION_APPROVE,
}


# --------------------------------------------------------------------------- #
#  Per-page view permissions
# --------------------------------------------------------------------------- #
# One permission per page, so pages stop being granted in clumps. Before this,
# `indent.view` was the required_permission of TEN pages — the six Indents screens
# AND the four Approvals screens — so ticking Indents silently handed a storekeeper
# the approval queue. `stock.view` did the same across nine pages spanning BOTH
# Warehouse and Inventory.
#
# These guard page VISIBILITY only. The action permissions above still guard the
# endpoints (rule 6 is unchanged): seeing the Approvals page is not permission to
# approve, `indent.approve` still is.
#
# `home` is deliberately absent — it has no required_permission and is the one screen
# everyone keeps, so a profile with nothing ticked lands on Home and nowhere else.
PAGE_VIEW_CODES: list[tuple[str, str, str]] = [
    # (page code, module, page name)
    ("grp_indents", "indents", "Indents"),
    ("ind_dashboard", "indents", "Indents · Overview"),
    ("ind_list", "indents", "Indents · All Requests"),
    # Code kept as `ind_deliveries` on purpose: it is the identity every existing
    # rbac_page_permissions grant hangs off. Only the screen's name and path moved
    # to Acknowledgements (see scripts/seed.py PAGE_TREE and the Alembic rename).
    ("ind_deliveries", "indents", "Indents · Acknowledgements"),
    # `ind_ack` is gone: it duplicated the row above. Dropped from the catalogue only —
    # `seed_permissions` never prunes, so the existing `page.ind_ack.view` row and every
    # grant on it stay in the database untouched, and the Alembic rename parks the page
    # itself with is_active = 0 so it cannot reach a menu.
    ("ind_reports", "indents", "Indents · Activity Ledger"),
    ("ind_notifications", "indents", "Indents · Notifications"),
    ("approvals", "approvals", "Approvals"),
    ("approval_waiting", "approvals", "Approvals · Waiting for Me"),
    ("approval_decisions", "approvals", "Approvals · My Decisions"),
    ("approval_team", "approvals", "Approvals · Team Queue"),
    ("grp_purchasing", "procurement", "Purchasing"),
    ("po_list", "procurement", "Purchase Orders"),
    ("grp_warehouse", "warehouse", "Warehouse"),
    ("wh_dashboard", "warehouse", "Warehouse · Dashboard"),
    ("wh_inward", "warehouse", "Warehouse · Material Inward"),
    ("wh_grn", "warehouse", "Warehouse · Goods Receipt"),
    ("wh_qc", "warehouse", "Warehouse · Quality Inspection"),
    ("wh_putaway", "warehouse", "Warehouse · Put-away"),
    # Added late (migration d2e3f4a5b6c7 put them on the menu after this catalogue
    # was written), so both fell back to `stock.view` — a code twelve roles hold and
    # nine other pages share. Unticking them on Job Profiles did nothing.
    ("wh_segregation", "warehouse", "Warehouse · Stock Segregation"),
    ("wh_stock_movements", "warehouse", "Warehouse · Stock Movements"),
    ("wh_issues", "warehouse", "Warehouse · Material Issues"),
    ("wh_picklist", "warehouse", "Warehouse · Picklists"),
    ("wh_consignments", "warehouse", "Warehouse · Consignments"),
    ("wh_dispatch", "warehouse", "Warehouse · Dispatch"),
    # `wh_returns` (Purchase Returns) is gone: the screen was dropped from the module
    # on 2026-08-13 and `d2e3f4a5b6c7` deletes its rbac_pages row, so a view code for
    # it could only ever gate a page that no longer exists.
    ("wh_notifications", "warehouse", "Warehouse · Notifications"),
    ("wh_reports", "warehouse", "Warehouse · Reports"),
    ("wh_masters", "warehouse", "Warehouse · Masters"),
    ("grp_inventory", "inventory", "Inventory"),
    ("inv_overview", "inventory", "Inventory · Overview"),
    ("inv_balance", "inventory", "Inventory · Stock Balance"),
    ("inv_ledger", "inventory", "Inventory · Stock Ledger"),
    ("inv_replenishment", "inventory", "Inventory · Replenishment"),
    ("inv_transfers", "inventory", "Inventory · Transfers"),
    ("inv_fulfillment", "inventory", "Inventory · Fulfilment Queue"),
    ("inv_allocation_approvals", "inventory", "Inventory · Allocation Approvals"),
    ("inv_mr", "inventory", "Inventory · Material Requests"),
    ("inv_labels", "inventory", "Inventory · Labels & Printing"),
    ("masters", "masters", "Masters"),
    ("grp_reports", "reports", "Reports"),
    ("rep_indents", "reports", "Reports · Indent Ledger"),
    ("rep_approvals", "reports", "Reports · Approval Ledger"),
    ("rep_inventory", "reports", "Reports · Stock Ledger"),
    ("rep_warehouse", "reports", "Reports · Warehouse Ledger"),
    ("grp_rbac", "rbac", "RBAC"),
    ("rbac_access", "rbac", "RBAC · Roles & Access"),
    ("rbac_groups", "rbac", "RBAC · User Groups"),
    ("grp_settings", "admin", "Settings"),
    ("admin", "admin", "Settings · HCM & Config"),
    ("admin_settings", "admin", "Settings · Company Settings"),
    ("admin_policies", "admin", "Settings · Approval & Automation"),
    ("admin_workflows", "admin", "Settings · Approval Workflows"),
    ("admin_approvals_config", "admin", "Settings · Approvals Config"),
    ("admin_rules", "admin", "Settings · Rules Engine"),
    ("admin_numbering", "admin", "Settings · Document Numbering"),
    ("admin_notifications", "admin", "Settings · Notifications"),
    ("admin_audit", "admin", "Settings · Audit Log"),
    ("admin_fallback", "admin", "Settings · Fallback Log"),
    ("admin_app_logs", "admin", "Settings · App Logs"),
]


def page_view_code(page_code: str) -> str:
    """The permission that makes one page visible. `page.<page code>.view`."""
    return f"page.{page_code}.view"


# The resource every "see this screen" permission carries. Named because two places
# generate these rows and a third has to exclude them from the Actions list — a
# literal "page" in all three is one typo away from screens leaking back in.
PAGE_RESOURCE = "page"

PAGE_VIEW_PERMISSIONS: list[Perm] = [
    Perm(page_view_code(code), module, PAGE_RESOURCE, "view", f"See the {name} page")
    for code, module, name in PAGE_VIEW_CODES
]

ALL_PERMISSIONS.extend(PAGE_VIEW_PERMISSIONS)
ALL_CODES.extend(p.code for p in PAGE_VIEW_PERMISSIONS)
