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
# Read EVERY stage of an approval trail, including the stages above your own.
#
# Fail-closed on purpose: no INHERITS_GRANTS_FROM entry, so a deploy grants it to
# Admin and to nobody else, and an auditor gets it by a deliberate tick.
#
# It is deliberately NOT `report.view`, which was the first thing reached for here
# and is wrong: that code is held today by twenty-odd job profiles including Driver,
# QC Team and OE, so using it would have switched the scoping OFF for very nearly
# every login — which is precisely the defect it was added to fix. A permission that
# almost everybody holds cannot be the one that lifts a restriction.
APPROVAL_TRAIL_VIEW_ALL = "approval.trail.view_all"
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
# Signing a stock audit. Carved out of STOCK_ADJUST (2026-09-24), which guarded both
# raising and approving, so the second pair of eyes was only ever "somebody else with
# the same tick". Inherits its grants below, so nobody who approves today loses it.
STOCK_ADJUST_APPROVE = "stock.adjust.approve"
# Stock Corrections (2026-10-01): editing what a held unit or batch IS — batch no.,
# mfg / expiry, serial, IMEI, asset / consumable code. Raise and sign are separate
# codes for the same reason the audit's are: the second pair of eyes must be somebody
# else's. New capability, so fail-closed: Admin holds it until a job profile is ticked.
STOCK_EDIT_VIEW = "stock.edit.view"
STOCK_EDIT_CREATE = "stock.edit.create"
STOCK_EDIT_APPROVE = "stock.edit.approve"
STOCK_RESERVE = "stock.reserve"
# Project Lots (Stock Segregation tab, 2026-10-06): set a lot aside for one project.
# VIEW inherits stock.view; MANAGE (reserve / release) and OVERRIDE (lend a held lot
# to another project's urgent need) are new capabilities, fail-closed to Admin.
STOCK_PROJECT_HOLD_VIEW = "stock.project_hold.view"
STOCK_PROJECT_HOLD_MANAGE = "stock.project_hold.manage"
STOCK_PROJECT_HOLD_OVERRIDE = "stock.project_hold.override"
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
# Raising a Stock Transfer Request (STR) — asking another point to send stock here.
# Its own code so a storekeeper can be let raise transfers without raising indents.
STOCK_TRANSFER_REQUEST = "stock.transfer.request"
# Seeing Inventory > Stock Transfer's lists — requests, orders and their history.
# Its own code so the screen can be granted without all of Indents or all of stock.
STOCK_TRANSFER_VIEW = "stock.transfer.view"
# Stock Transfer's own grants over the legs it borrows from other modules — the STR's
# approval, serving it, the material issue, its outward QC and the receipt. Each is
# SCOPED: it passes only on an STR / STO document (`core.dependencies.
# require_permission_or`), never on an ordinary indent or warehouse issue, and each
# inherits from the code the leg used before, so nobody loses what they do today.
STOCK_TRANSFER_STR_APPROVE = "stock.transfer.str_approve"
STOCK_TRANSFER_SERVE = "stock.transfer.serve"
STOCK_TRANSFER_SERVE_APPROVE = "stock.transfer.serve_approve"
STOCK_TRANSFER_ISSUE = "stock.transfer.issue"
STOCK_TRANSFER_ISSUE_POST = "stock.transfer.issue_post"
STOCK_TRANSFER_QC = "stock.transfer.qc"
STOCK_TRANSFER_QC_APPROVE = "stock.transfer.qc_approve"
STOCK_TRANSFER_RECEIVE = "stock.transfer.receive"
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
# Breaking one approved issue into a child per warehouse floor, each capped at the
# stock that floor actually holds. The manager who may issue the whole thing is the
# one who may hand pieces of it out, so this inherits ISSUE_ISSUE rather than landing
# on nobody — see INHERITS_GRANTS_FROM.
ISSUE_SPLIT = "issue.split"

# --- Warehouse ---
# The warehouse module runs the physical dock-to-stock cycle: receipt -> inspection
# -> putaway, and picking -> issue -> dispatch -> return. GRN_* above stays for the
# older logistics GRN screens; these guard the warehouse endpoints.
RECEIPT_VIEW = "receipt.view"
RECEIPT_CREATE = "receipt.create"
RECEIPT_POST = "receipt.post"
INSPECTION_VIEW = "inspection.view"
INSPECTION_EXECUTE = "inspection.execute"
QC_OUTWARD_VIEW = "qc_outward.view"
QC_OUTWARD_CREATE = "qc_outward.create"
QC_OUTWARD_UPDATE = "qc_outward.update"
QC_OUTWARD_APPROVE = "qc_outward.approve"
QC_OUTWARD_EXPORT = "qc_outward.export"
PUTAWAY_VIEW = "putaway.view"
PUTAWAY_EXECUTE = "putaway.execute"
PICKING_VIEW = "picking.view"
PICKING_PICK = "picking.pick"
DISPATCH_VIEW = "dispatch.view"
DISPATCH_CREATE = "dispatch.create"
DISPATCH_APPROVE = "dispatch.approve"
DISPATCH_GATE_OUT = "dispatch.gate_out"
DISPATCH_ACKNOWLEDGE = "dispatch.acknowledge"
# RETURN_VIEW / RETURN_CREATE / RETURN_APPROVE are NOT declared here. A purchase
# return and a stock return share one set of codes, and they are declared once under
# `--- Returns ---` below. They used to be declared in both places with the same
# values, which read as two permissions and was one.
WAREHOUSE_REPORT_VIEW = "warehouse.report.view"
# Deleting an abandoned draft. Separate from create/execute on purpose: a storekeeper
# who raises documents is not automatically someone who may remove them, and the
# reverse is true for a supervisor tidying a queue.
RECEIPT_DELETE = "receipt.delete"
INSPECTION_DELETE = "inspection.delete"
QC_OUTWARD_DELETE = "qc_outward.delete"
PUTAWAY_DELETE = "putaway.delete"
PICKING_DELETE = "picking.delete"
ISSUE_DELETE = "issue.delete"
DISPATCH_DELETE = "dispatch.delete"
RETURN_DELETE = "return.delete"
MOVEMENT_DELETE = "movement.delete"
MOVEMENT_VIEW = "movement.view"
MOVEMENT_CREATE = "movement.create"
MOVEMENT_UPDATE = "movement.update"
MOVEMENT_APPROVE = "movement.approve"
MOVEMENT_INSPECT = "movement.inspect"
MOVEMENT_COMPLETE = "movement.complete"

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
MASTER_PAYMENT_TERM_MANAGE = "master.payment_term.manage"

# --- Accounts (vendor payments against PO milestones). New capability, fail-closed:
# Admin holds them until a job profile is ticked.
ACCOUNTS_VIEW = "accounts.view"
ACCOUNTS_PAY = "accounts.pay"
ACCOUNTS_APPROVE = "accounts.approve"

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
# Settings > Monthly Indent: the cycle, the reminders and who may submit. Carved out
# of admin.settings.manage so a planning desk can run the month without being able
# to change everything else in Settings (see INHERITS_GRANTS_FROM).
MONTHLY_INDENT_MANAGE = "monthly_indent.manage"

# --- Procurement: requisitions, RFQs, quotations ---
# The buying chain, split by decision rather than by screen. Raising a requisition is
# asking; approving one commits a budget; sending an RFQ publishes what the company
# is about to buy and to whom; awarding one picks the winner. Four different people in
# most organisations, so four codes. PO_* above stays exactly as it is.
REQUISITION_VIEW = "requisition.view"
REQUISITION_CREATE = "requisition.create"
REQUISITION_APPROVE = "requisition.approve"
RFQ_VIEW = "rfq.view"
RFQ_CREATE = "rfq.create"
RFQ_APPROVE = "rfq.approve"
# Reading the comparison sheet is not the same as picking off it — the sheet carries
# every vendor's price, which is exactly what must not leak back to the vendors.
RFQ_COMPARE = "rfq.compare"
RFQ_AWARD = "rfq.award"
# Issuing a supplier a login, and resetting it. The one code here that creates an
# identity outside the company, so it is never bundled with the RFQ codes. Carriers
# ride on the same code: a transport provider IS a vendor row (vendor_type TRANSPORT)
# and signs in through the same portal, so minting one is the same act.
VENDOR_PORTAL_MANAGE = "vendor.portal.manage"

# --- Mail (Settings > Mail) ---
# Two codes, not one. Reading what the company has sent and SENDING as the company
# are different rights: the Sent log is a record anyone running the desk may need,
# while every message put out under `scm@` carries the company's name to an outsider.
MAIL_VIEW = "mail.view"
MAIL_SEND = "mail.send"
# Rolling many requisitions into one buying sheet. Separate from REQUISITION_* because
# the person who raises a requisition is not the person who decides what the month's
# consolidated demand looks like — that sheet is what the CPO and SCM Head sign.
CONSOLIDATION_VIEW = "consolidation.view"
CONSOLIDATION_CREATE = "consolidation.create"
CONSOLIDATION_APPROVE = "consolidation.approve"

# --- Logistics (transport) ---
# The outward transport leg, which until now had no permissions of its own: the
# logistics package guarded its GRN and issue screens with warehouse codes and there
# was nothing to grant a Logistics Team login.
TRANSPORT_VIEW = "transport.view"
TRANSPORT_CREATE = "transport.create"
TRANSPORT_APPROVE = "transport.approve"
# Picking the provider and fixing the freight. Split from CREATE for the same reason
# RFQ_AWARD is split from RFQ_CREATE — raising the request commits nobody to spend.
TRANSPORT_AWARD = "transport.award"
# Recording where the consignment is: LR/docket, in-transit scans, delivery.
TRANSPORT_TRACK = "transport.track"
# Signing for the consignment at the receiving end (doc A6). Its own code because the
# holder is the indent team or the site, not the logistics desk: "it arrived" must be
# sayable by someone who cannot also say "it was dispatched".
TRANSPORT_ACKNOWLEDGE = "transport.acknowledge"
# Raising and closing a damage/shortage against the provider. Its own code because
# it is a claim against a supplier, not a status update.
TRANSPORT_EXCEPTION = "transport.exception"
TRANSPORT_DELETE = "transport.delete"
# The logistics-vendor register: who the Dispatch dropdown offers, and their portal
# login. MANAGE mints an identity outside the company, exactly like
# VENDOR_PORTAL_MANAGE does for a supplier — but scoped, because the endpoints behind
# it refuse any vendor row that is not a carrier. Granting the logistics desk the
# ability to stand up a courier must not hand them a material supplier's password.
LOGISTICS_PARTNER_VIEW = "logistics.partner.view"
LOGISTICS_PARTNER_MANAGE = "logistics.partner.manage"

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

# Every return, not only the ones raised from a shelf this login owns (2026-09-19).
#
# The register (`returns.list_returns`) narrows to the raiser's own stocking-point
# subtree, which is right for a storekeeper and wrong for every desk ABOVE one: the
# SCM Head holds one nominal point out of nine hundred, so All Returns showed him
# nothing while his decision desk was full — he could sign a document he could not
# find. The desks already bypass that narrowing (`_queue_page`), so this widens the
# REGISTER to the set those screens were always serving, and nothing beyond it.
RETURN_VIEW_ALL = "return.view_all"

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
    Perm(APPROVAL_TRAIL_VIEW_ALL, "approvals", "approval_trail", "view_all",
         "Read every stage of an approval trail, including stages above your own"),
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
    Perm(STOCK_ADJUST_APPROVE, "inventory", "stock", "adjust_approve",
         "Approve or reject a stock audit / adjustment"),
    Perm(STOCK_EDIT_VIEW, "inventory", "stock_edit", "view",
         "View stock corrections (batch / expiry / serial / IMEI edits)"),
    Perm(STOCK_EDIT_CREATE, "inventory", "stock_edit", "create",
         "Raise a stock correction for approval"),
    Perm(STOCK_EDIT_APPROVE, "inventory", "stock_edit", "approve",
         "Approve or reject a stock correction"),
    Perm(STOCK_RESERVE, "inventory", "stock", "reserve", "Reserve stock for a document"),
    Perm(STOCK_PROJECT_HOLD_VIEW, "inventory", "project_hold", "view",
         "View project lots and the holds on them"),
    Perm(STOCK_PROJECT_HOLD_MANAGE, "inventory", "project_hold", "manage",
         "Reserve a lot for a project, and release it"),
    Perm(STOCK_PROJECT_HOLD_OVERRIDE, "inventory", "project_hold", "override",
         "Lend a project's held lot to another project's urgent need"),
    Perm(STOCK_VALUATION_VIEW, "inventory", "stock_valuation", "view",
         "View stock valuation and cost"),
    Perm(STOCK_TRANSFER, "inventory", "stock", "transfer",
         "Raise a stock transfer order (STO) directly, without a request"),
    Perm(STOCK_TRANSFER_VIEW, "inventory", "stock", "transfer_view",
         "See stock transfer requests, orders and their history"),
    Perm(STOCK_TRANSFER_STR_APPROVE, "inventory", "stock", "transfer_str_approve",
         "Approve, reject or return a stock transfer request (STR)"),
    Perm(STOCK_TRANSFER_SERVE, "inventory", "stock", "transfer_serve",
         "Serve a stock transfer request — decide which point gives what"),
    Perm(STOCK_TRANSFER_SERVE_APPROVE, "inventory", "stock", "transfer_serve_approve",
         "Approve or reject how a stock transfer request is served"),
    Perm(STOCK_TRANSFER_ISSUE, "inventory", "stock", "transfer_issue",
         "Work a stock transfer's material issue — picks, batches, bays, submit"),
    Perm(STOCK_TRANSFER_ISSUE_POST, "inventory", "stock", "transfer_issue_post",
         "Approve and post a stock transfer's material issue (stock leaves the point)"),
    Perm(STOCK_TRANSFER_QC, "inventory", "stock", "transfer_qc",
         "Run the outward QC of a stock transfer"),
    Perm(STOCK_TRANSFER_QC_APPROVE, "inventory", "stock", "transfer_qc_approve",
         "Complete, approve or reject the outward QC of a stock transfer"),
    Perm(STOCK_TRANSFER_RECEIVE, "inventory", "stock", "transfer_receive",
         "Acknowledge a stock transfer on arrival (credits your point)"),
    Perm(STOCK_VIEW_SUBTREE, "inventory", "stock", "view_subtree",
         "View stock at every point reporting under you, not just your own"),
    Perm(STOCK_POINTS_MANAGE, "inventory", "stock", "points_manage",
         "Tag positions to stocking points (MDP / LIP)"),
    Perm(STOCK_TRANSFER_APPROVE, "inventory", "stock", "transfer_approve",
         "Approve a stock transfer order (STO)"),
    Perm(STOCK_TRANSFER_REQUEST, "inventory", "stock", "transfer_request",
         "Raise a stock transfer request (STR)"),
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
    Perm(ISSUE_SPLIT, "warehouse", "issue", "split",
         "Split an issue across the floors that hold the stock"),
    Perm(ISSUE_FORWARD, "warehouse", "issue", "forward",
         "Forward an arrived consignment on to a point below"),
    Perm(RECEIPT_VIEW, "warehouse", "receipt", "view", "View goods receipts"),
    Perm(RECEIPT_CREATE, "warehouse", "receipt", "create", "Create goods receipts"),
    Perm(RECEIPT_POST, "warehouse", "receipt", "post", "Post a goods receipt"),
    Perm(INSPECTION_VIEW, "warehouse", "inspection", "view", "View quality inspections"),
    Perm(INSPECTION_EXECUTE, "warehouse", "inspection", "execute",
         "Record a quality inspection result"),
    Perm(QC_OUTWARD_VIEW, "warehouse", "qc_outward", "view", "View Outward QC"),
    Perm(QC_OUTWARD_CREATE, "warehouse", "qc_outward", "create", "Create Outward QC"),
    Perm(QC_OUTWARD_UPDATE, "warehouse", "qc_outward", "update", "Update Outward QC draft"),
    Perm(QC_OUTWARD_APPROVE, "warehouse", "qc_outward", "approve", "Approve/Complete Outward QC"),
    Perm(QC_OUTWARD_EXPORT, "warehouse", "qc_outward", "export", "Export Outward QC"),
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
    # No RETURN_VIEW / RETURN_CREATE / RETURN_APPROVE row here — see the Returns
    # block below. Listing them twice meant `sync_permission_labels` built its
    # catalogue dict with the later entry silently winning, so these three were dead
    # rows that still had to be read to know they did nothing.
    Perm(WAREHOUSE_REPORT_VIEW, "warehouse", "report", "view", "View warehouse reports"),
    Perm(RECEIPT_DELETE, "warehouse", "receipt", "delete", "Delete a draft receipt"),
    Perm(INSPECTION_DELETE, "warehouse", "inspection", "delete",
         "Delete a draft inspection"),
    Perm(QC_OUTWARD_DELETE, "warehouse", "qc_outward", "delete", "Delete a draft Outward QC"),
    Perm(PUTAWAY_DELETE, "warehouse", "putaway", "delete", "Delete a draft put-away"),
    Perm(PICKING_DELETE, "warehouse", "picking", "delete", "Delete a draft picklist"),
    Perm(ISSUE_DELETE, "warehouse", "issue", "delete", "Delete a draft issue"),
    Perm(DISPATCH_DELETE, "warehouse", "dispatch", "delete", "Delete a draft dispatch"),
    # `returns`, not `warehouse`: it is the fourth code of the same resource, and the
    # other three are filed under Returns. Splitting one resource across two modules
    # opened two half-groups on the Job Profiles screen. A relabel touches no grant.
    Perm(RETURN_DELETE, "returns", "return", "delete", "Delete a draft return"),
    Perm(MOVEMENT_DELETE, "warehouse", "movement", "delete",
         "Delete a draft stock movement"),
    Perm(MOVEMENT_VIEW, "warehouse", "movement", "view", "View stock movements"),
    Perm(MOVEMENT_CREATE, "warehouse", "movement", "create", "Create stock movements"),
    Perm(MOVEMENT_UPDATE, "warehouse", "movement", "update", "Update stock movements"),
    Perm(MOVEMENT_APPROVE, "warehouse", "movement", "approve", "Approve stock movements"),
    Perm(MOVEMENT_INSPECT, "warehouse", "movement", "inspect",
         "Complete stock movement inspections"),
    Perm(MOVEMENT_COMPLETE, "warehouse", "movement", "complete",
         "Complete approved stock movements"),
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
    Perm(MASTER_PAYMENT_TERM_MANAGE, "masters", "payment_term", "manage",
         "Manage payment terms (advance / delivery / installation / warranty split)"),
    Perm(ACCOUNTS_VIEW, "accounts", "payment", "view",
         "View what is due and paid against purchase orders"),
    Perm(ACCOUNTS_PAY, "accounts", "payment", "create",
         "Record a vendor payment against a PO milestone"),
    Perm(ACCOUNTS_APPROVE, "accounts", "payment", "approve",
         "Approve or reject a recorded vendor payment"),
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
    Perm(MONTHLY_INDENT_MANAGE, "admin", "monthly_indent", "manage",
         "Configure the monthly indent cycle, its reminders and who may submit"),
    Perm(REQUISITION_VIEW, "procurement", "requisition", "view",
         "View purchase requisitions"),
    Perm(REQUISITION_CREATE, "procurement", "requisition", "create",
         "Raise and submit purchase requisitions"),
    Perm(REQUISITION_APPROVE, "procurement", "requisition", "approve",
         "Approve or reject purchase requisitions"),
    Perm(RFQ_VIEW, "procurement", "rfq", "view", "View RFQs"),
    Perm(RFQ_CREATE, "procurement", "rfq", "create", "Raise and send out RFQs"),
    Perm(RFQ_APPROVE, "procurement", "rfq", "approve",
         "Approve an RFQ so it reaches its vendors"),
    Perm(RFQ_COMPARE, "procurement", "rfq", "compare",
         "See the quotation comparison sheet"),
    Perm(RFQ_AWARD, "procurement", "rfq", "award", "Award an RFQ to a vendor"),
    Perm(VENDOR_PORTAL_MANAGE, "procurement", "vendor", "portal_manage",
         "Issue and reset supplier & carrier portal logins"),
    Perm(MAIL_VIEW, "admin", "mail", "view",
         "Read the company mailbox and the sent log"),
    Perm(MAIL_SEND, "admin", "mail", "send",
         "Send mail from the company address"),
    Perm(CONSOLIDATION_VIEW, "procurement", "consolidation", "view",
         "View consolidated purchase sheets"),
    Perm(CONSOLIDATION_CREATE, "procurement", "consolidation", "create",
         "Roll requisitions into a consolidated purchase sheet"),
    Perm(CONSOLIDATION_APPROVE, "procurement", "consolidation", "approve",
         "Approve or reject a consolidated purchase sheet"),
    Perm(TRANSPORT_VIEW, "logistics", "transport", "view", "View shipments"),
    Perm(TRANSPORT_CREATE, "logistics", "transport", "create",
         "Raise and submit shipments"),
    Perm(TRANSPORT_APPROVE, "logistics", "transport", "approve",
         "Approve or reject a shipment"),
    Perm(TRANSPORT_AWARD, "logistics", "transport", "award",
         "Choose the transport provider and fix the freight"),
    Perm(TRANSPORT_TRACK, "logistics", "transport", "track",
         "Record LR/docket, in-transit events and delivery"),
    Perm(TRANSPORT_ACKNOWLEDGE, "logistics", "transport", "acknowledge",
         "Acknowledge a delivered consignment at the receiving site"),
    Perm(TRANSPORT_EXCEPTION, "logistics", "transport", "exception",
         "Raise and close damage or shortage claims against a carrier"),
    Perm(TRANSPORT_DELETE, "logistics", "transport", "delete",
         "Delete a draft shipment"),
    Perm(LOGISTICS_PARTNER_VIEW, "logistics", "partner", "view",
         "View the logistics vendor register"),
    Perm(LOGISTICS_PARTNER_MANAGE, "logistics", "partner", "manage",
         "Add logistics vendors and issue their portal logins"),
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
    Perm(RETURN_VIEW_ALL, "returns", "return", "view_all",
         "See every return, not only those from your own stocking points"),
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
    # Carved out of TRACK, which used to cover the whole tail of the flow. Everyone
    # who could mark a consignment delivered yesterday must still be able to close it
    # out today — fail-closed is right for a new capability and wrong for a split.
    TRANSPORT_ACKNOWLEDGE: TRANSPORT_TRACK,
    # Stock Movements ran on `stock.view` / `stock.transfer` — two codes shared with
    # Inventory, so unticking Movements on a job profile took a transfer away with it.
    # Carved out on 2026-08-20; everybody who could work the screen yesterday keeps it.
    MOVEMENT_VIEW: STOCK_VIEW,
    STOCK_PROJECT_HOLD_VIEW: STOCK_VIEW,
    MOVEMENT_CREATE: STOCK_TRANSFER,
    MONTHLY_INDENT_MANAGE: ADMIN_SETTINGS_MANAGE,
    # Everyone who could raise a transfer yesterday can request one today.
    STOCK_TRANSFER_REQUEST: STOCK_TRANSFER,
    # The lists were read under `stock.view`; whoever read them keeps them.
    STOCK_TRANSFER_VIEW: STOCK_VIEW,
    STOCK_TRANSFER_STR_APPROVE: INDENT_APPROVE,
    STOCK_TRANSFER_SERVE: ALLOCATION_CREATE,
    STOCK_TRANSFER_SERVE_APPROVE: ALLOCATION_APPROVE,
    STOCK_TRANSFER_ISSUE: ISSUE_CREATE,
    STOCK_TRANSFER_ISSUE_POST: ISSUE_ISSUE,
    STOCK_TRANSFER_QC: QC_OUTWARD_CREATE,
    STOCK_TRANSFER_QC_APPROVE: QC_OUTWARD_APPROVE,
    STOCK_TRANSFER_RECEIVE: INDENT_ACKNOWLEDGE,
    MOVEMENT_INSPECT: MOVEMENT_CREATE,
    MOVEMENT_COMPLETE: MOVEMENT_CREATE,
    # Splitting is a way of DOING the issue, not a new authority over it: whoever
    # could post the whole issue yesterday can hand its pieces to the floors today.
    # Fail-closed would leave the button on nobody's profile and the feature unused.
    ISSUE_SPLIT: ISSUE_ISSUE,
    # Settings > Monthly Indent ran on admin.settings.manage; whoever configured the
    # month yesterday still can today, and from now on it can be granted on its own.
    MONTHLY_INDENT_MANAGE: ADMIN_SETTINGS_MANAGE,
    STOCK_ADJUST_APPROVE: STOCK_ADJUST,
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
    ("ind_dashboard", "indents", "Indents · Dashboard"),
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
    # Rode on `indent.approve` because it was never catalogued: unticking the screen
    # revoked the approve BUTTON on every indent screen, and ticking it handed the
    # button back. Same split as the rest.
    ("approval_overview", "approvals", "Approvals · Dashboard"),
    ("approval_consolidation", "approvals", "Approvals · Consolidation"),
    ("approval_waiting", "approvals", "Approvals · Waiting for Me"),
    ("approval_decisions", "approvals", "Approvals · My Decisions"),
    # `approval_team` is gone with the Team Queue screen. Dropped from the catalogue
    # only — `seed_permissions` never prunes, so the existing
    # `page.approval_team.view` row and every grant on it stay untouched.
    ("grp_purchasing", "procurement", "Purchasing"),
    ("po_list", "procurement", "Purchase Orders"),
    # The four buying-chain screens, catalogued late (2026-08-23). `sync_pages` had
    # been inventing their `page.*.view` rows, which works — the tick-box on Job
    # Profiles does gate them — but an auto-created row is not in ALL_PERMISSIONS, so
    # `sync_permission_labels` can never relabel it and the RBAC screen listed four
    # rows described as "See the RFQs page" with no module beside them. Listing them
    # changes no grant: the rows already exist, and `seed_permissions` never prunes or
    # re-grants. It only makes them describable — and makes the Overview below able to
    # inherit from one of them.
    ("pro_requisitions", "procurement", "Procurement · Requisitions"),
    ("pro_consolidations", "procurement", "Procurement · Consolidation"),
    ("pro_rfqs", "procurement", "Procurement · RFQs"),
    ("pro_quotations", "procurement", "Procurement · Quotations"),
    # The comparison studio (2026-09-26): every quotation to one RFQ side by side,
    # and the award. It took over the sheet that used to live inside the RFQ page.
    ("pro_price_compare", "procurement", "Procurement · Compare Quotations"),
    # The module's front door: the buying chain as one board — what is waiting on me,
    # what each rung is holding, and the demand pool underneath it. Every tile on it is
    # gated separately on the document family it counts, so the screen's own code is
    # only "may open the board".
    ("pro_overview", "procurement", "Procurement · Dashboard"),
    ("pro_demand_pool", "procurement", "Procurement · Demand Pool"),
    # Settings > Mail. Fail-closed to Admin on purpose: it reads a shared mailbox and
    # can send under the company's address, and neither is something to hand out by
    # inheritance. No INHERITS_GRANTS_FROM entry for exactly that reason.
    ("settings_mail", "admin", "Settings · Mail"),
    # The document trail. Catalogued so it can inherit below rather than landing
    # Admin-only: it reads the same documents the other ledgers already show this
    # login, assembled into a chain.
    ("rep_traceability", "reports", "Reports · Document Trail"),
    # Catalogued so they inherit below instead of landing Admin-only: both show the
    # same documents the other ledgers already list for this login.
    ("rep_attachments", "reports", "Reports · Attachments"),
    ("rep_live_tracking", "reports", "Reports · Live Tracking"),
    ("grp_warehouse", "warehouse", "Warehouse"),
    ("wh_dashboard", "warehouse", "Warehouse · Dashboard"),
    ("wh_demand_pool", "warehouse", "Warehouse · Demand Pool"),
    ("wh_inward", "warehouse", "Warehouse » Material Inward"),
    ("wh_grn", "warehouse", "Warehouse » Goods Receipt"),
    ("wh_qc", "warehouse", "Warehouse » Quality Inspection"),
    ("wh_qc_outward", "warehouse", "Warehouse » Outward QC"),
    ("wh_putaway", "warehouse", "Warehouse » Put-away"),
    # Added late (migration d2e3f4a5b6c7 put them on the menu after this catalogue
    # was written), so both fell back to `stock.view` — a code twelve roles hold and
    # nine other pages share. Unticking them on Job Profiles did nothing.
    ("wh_segregation", "warehouse", "Warehouse · Stock Segregation"),
    ("wh_stock_movements", "warehouse", "Warehouse · Stock Movements"),
    ("wh_issues", "warehouse", "Warehouse · Material Issues"),
    # The two screens the catalogue never listed, so the Job Profiles tick for each
    # was somebody else's ACTION: Material Returns rode on `issue.view` (shared with
    # Material Issues until that got its own code) and Acknowledge Delivery rode on
    # `dispatch.acknowledge`, so unticking the screen took the button away with it.
    # Both are live routes (`/warehouse/material-returns`, `/warehouse/acknowledge-
    # delivery`); they are gated below by INHERITS_GRANTS_FROM so nobody loses them.
    ("wh_material_returns", "warehouse", "Warehouse · Material Returns"),
    ("wh_ack", "warehouse", "Warehouse · Acknowledge Delivery"),
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
    ("inv_overview", "inventory", "Inventory · Dashboard"),
    ("inv_balance", "inventory", "Inventory · Stock Balance"),
    ("inv_ledger", "inventory", "Inventory · Stock Ledger"),
    ("inv_replenishment", "inventory", "Inventory · Replenishment"),
    ("inv_transfers", "inventory", "Inventory · Stock Transfer"),
    # Retired 2026-08-21, replaced by the Fulfilment Desk below. Catalogued still,
    # because `seed_permissions` never prunes: the rows and every grant on them are in
    # the database, and the new screen's own code inherits from the first of them.
    ("inv_fulfillment", "inventory", "Inventory · Fulfilment Queue"),
    ("inv_allocation_approvals", "inventory", "Inventory · Allocation Approvals"),
    # The two above as one screen: decide what to give and sign it in the same place.
    ("inv_fulfilment_desk", "inventory", "Inventory · Fulfilment Desk"),
    # The buying trail. Catalogued rather than left for `sync_pages` to invent, so it
    # can inherit below instead of landing Admin-only.
    ("pro_ledger", "procurement", "Procurement · Ledger"),
    ("inv_mr", "inventory", "Inventory · Material Requests"),
    ("inv_adjustments", "inventory", "Inventory · Stock Audit"),
    ("inv_stock_edits", "inventory", "Inventory · Stock Corrections"),
    ("inv_labels", "inventory", "Inventory · Labels & Printing"),
    # Rode on `stock.points.manage`, which is the action that RE-TAGS a stocking point.
    ("inv_stocking_points", "inventory", "Inventory · Stocking Points"),
    # Logistics — the outward leg, in the order the material moves. Catalogued rather
    # than left to `sync_pages` to invent: an auto-created page permission is never
    # revisited by `sync_permission_labels` (it is not in ALL_PERMISSIONS), so it can
    # neither be relabelled nor inherit grants from the screen it was carved out of.
    # Every code here already existed as an auto-created row except the last two;
    # listing them changes no module, resource or action, only who may refresh them.
    ("grp_logistics", "logistics", "Logistics"),
    ("logistics_overview", "logistics", "Logistics · Dashboard"),
    ("logistics_consignments", "logistics", "Logistics · Consignments"),
    ("logistics_dispatch", "logistics", "Logistics · Dispatch"),
    ("logistics_load_planner", "logistics", "Logistics · Smart Load Planner"),
    ("logistics_transport", "logistics", "Logistics · Shipments"),
    ("logistics_providers", "logistics", "Logistics · Provider Selection"),
    ("logistics_activity", "logistics", "Logistics · Activity Ledger"),
    # Retired screens. The codes stay catalogued because the permission rows and every
    # grant on them are still in the database — `seed_permissions` never prunes — and
    # because the ledger's own grant is inherited from Tracking's below.
    ("logistics_tracking", "logistics", "Logistics · Shipment Tracking"),
    ("logistics_acknowledgements", "logistics", "Logistics · Acknowledgements"),
    ("logistics_exceptions", "logistics", "Logistics · Exceptions"),
    # Accounts (2026-10-06): what is due and paid against PO payment milestones.
    ("grp_accounts", "accounts", "Accounts"),
    ("acc_payments", "accounts", "Accounts · Vendor Payments"),
    ("masters", "masters", "Masters"),
    # The same masters, on the module that owns them (2026-09-18). `/masters` keeps
    # its own code above and stays whole — these are a second door, catalogued here
    # rather than left for `sync_pages` to invent, so each can be labelled by
    # `sync_permission_labels` and can inherit its grants below instead of landing
    # Admin-only. One code per module is the whole point: `page.masters.view` is a
    # single tick that hands out every master in the company.
    ("inv_masters", "inventory", "Inventory · Masters"),
    ("pro_masters", "procurement", "Procurement · Masters"),
    ("ind_masters", "indents", "Indents · Masters"),
    ("admin_org_masters", "admin", "Settings · Organisation Masters"),
    ("grp_reports", "reports", "Reports"),
    ("rep_indents", "reports", "Reports · Indent Ledger"),
    ("rep_approvals", "reports", "Reports · Approval Ledger"),
    ("rep_inventory", "reports", "Reports · Stock Ledger"),
    ("rep_warehouse", "reports", "Reports · Warehouse Ledger"),
    # Three ledgers that had no rail row at all — the spec existed and the screen
    # rendered, but only for somebody who typed the URL. Catalogued so each inherits
    # from the permission that reads the underlying document, below.
    ("rep_procurement", "reports", "Reports · Procurement Ledger"),
    ("rep_transport", "reports", "Reports · Logistics Ledger"),
    ("rep_returns", "reports", "Reports · Returns Ledger"),
    ("grp_rbac", "rbac", "RBAC"),
    ("rbac_access", "rbac", "RBAC · Roles & Access"),
    ("rbac_groups", "rbac", "RBAC · User Groups"),
    ("grp_settings", "admin", "Settings"),
    ("admin", "admin", "Settings · HCM & Config"),
    ("admin_settings", "admin", "Settings · Company Settings"),
    ("admin_policies", "admin", "Settings · Approval & Automation"),
    ("admin_workflows", "admin", "Settings · Approval Workflows"),
    ("admin_approvals_config", "admin", "Settings · Approvals Config"),
    # The one approval-configuration screen (Settings > Approval Flow). It has been a
    # live rbac_pages row for a while but was never catalogued here, so it had no
    # `page.*.view` of its own and fell back to `admin.workflow.manage` — the ACTION
    # that lets you rewrite every chain in the company. Unticking the screen on a job
    # profile therefore took the ability to configure approvals away with it, and vice
    # versa. Its own code separates "may open this screen" from "may change a chain".
    ("admin_approval_flow", "admin", "Settings · Approval Flow"),
    ("admin_monthly_indent", "admin", "Settings · Monthly Indent"),
    ("admin_rules", "admin", "Settings · Rules Engine"),
    ("admin_numbering", "admin", "Settings · Document Numbering"),
    ("admin_notifications", "admin", "Settings · Notifications"),
    ("admin_audit", "admin", "Settings · Audit Log"),
    ("admin_fallback", "admin", "Settings · Fallback Log"),
    ("admin_app_logs", "admin", "Settings · App Logs"),
    # Filed under Settings, not Logistics: the screen mints a login for somebody
    # outside the company. A dispatcher who needs the carrier NAMES already has them
    # from `transport.view` (the Dispatch dropdown reads /api/transport/carriers), so
    # leaving this one Admin-only takes no button away from the logistics desk.
    ("settings_logistics_vendors", "logistics", "Settings · Logistics Vendors"),
    # The material twin of the row above, filed under Procurement. Catalogued here so
    # it can inherit below rather than landing Admin-only: every route behind it is
    # already gated on `vendor.portal.manage`, so a desk that holds that code and
    # cannot see the screen has a permission it can do nothing with.
    ("pro_suppliers", "procurement", "Procurement » Suppliers"),
    # App Integrations — the outbound half of the API console. Catalogued so it can
    # inherit the console's own grant below rather than landing Admin-only.
    ("admin_app_links", "integrations", "Settings · App Integrations"),
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

# Page-view splits, declared here rather than in the dict above only because
# `page_view_code` is defined after it. Same rule and the same one-shot behaviour.
INHERITS_GRANTS_FROM.update({
    # Acknowledgements is the tail of the tracking board, not a new screen: it lists
    # the shipments Tracking already carried as far as DELIVERED, and asks the site to
    # sign. Everyone who could watch a consignment arrive keeps it, which matches
    # TRANSPORT_ACKNOWLEDGE inheriting TRANSPORT_TRACK — the button and the screen it
    # sits on must land with the same people or one of them is dead.
    page_view_code("logistics_acknowledgements"): page_view_code("logistics_tracking"),
    # The Activity Ledger replaces the Shipment Tracking board and the Exceptions desk,
    # so it lands with the people who worked them rather than fail-closed to Admin: it
    # shows the same events, off the same documents, and taking the board away without
    # handing over the screen that replaced it would leave that desk with nothing.
    page_view_code("logistics_activity"): page_view_code("logistics_tracking"),
    # The module's new front page (2026-08-23). It reads the SAME summary endpoint
    # the Shipments register lives on and writes nothing, so anybody who can work
    # Shipments can read the overview of them — minting it fail-closed to Admin
    # would put a landing page on the rail that the whole logistics desk gets a
    # locked door from.
    page_view_code("logistics_overview"): page_view_code("logistics_transport"),
    page_view_code("logistics_load_planner"): page_view_code("logistics_dispatch"),
    # Not a split but a late catalogue entry, which needs the same treatment: the
    # screen has been reachable on these two codes for months, and minting its page
    # permission fail-closed would silently retire a screen people work every day.
    page_view_code("wh_material_returns"): ISSUE_VIEW,
    page_view_code("wh_ack"): DISPATCH_ACKNOWLEDGE,
    # The three screens that had no page permission of their own until 2026-08-19 and
    # were therefore gated on a business ACTION. Minting them fail-closed would retire
    # three screens people work every day, so each inherits from exactly the code that
    # used to gate it — everybody who can open the screen today still can, and from
    # now on the screen and the action can be granted apart.
    page_view_code("admin_approval_flow"): ADMIN_WORKFLOW_MANAGE,
    page_view_code("admin_monthly_indent"): ADMIN_SETTINGS_MANAGE,
    page_view_code("approval_consolidation"): INDENT_APPROVE,
    # The Overview reads nothing the inbox does not already show this person — it is
    # the same approval-scoped queries, summarised — so anybody who can open the inbox
    # can open it. Fail-closed would retire a landing page nobody granted yet.
    page_view_code("approval_overview"): page_view_code("approval_waiting"),
    page_view_code("inv_stocking_points"): STOCK_POINTS_MANAGE,
    # Stock Audit comes back on the rail (2026-09-24). The screen was always gated on
    # `stock.adjust`, so it lands with exactly the people who could open it by URL.
    page_view_code("inv_adjustments"): STOCK_ADJUST,
    # The supplier register (2026-08-24). Not fail-closed: every route behind it is
    # already gated on `vendor.portal.manage`, the code that has governed minting a
    # vendor login since the portal landed, so whoever holds it today opens the screen
    # today. Granting the page to somebody WITHOUT that code would show them a list
    # whose every button 403s, which is the failure this whole screen exists to end.
    page_view_code("pro_suppliers"): VENDOR_PORTAL_MANAGE,
    page_view_code("pro_demand_pool"): REQUISITION_VIEW,
    page_view_code("wh_demand_pool"): ISSUE_VIEW,   # the endpoint is gated on issue.view
    # Price Compare (2026-09-26) took over the comparison sheet and the award from the
    # RFQ detail. It lands with the desk that worked that sheet — the wider of the two
    # pages that used to carry it — so nobody loses the screen the day it moves; the
    # DATA inside stays gated by `rfq.compare` exactly as before.
    page_view_code("pro_price_compare"): page_view_code("pro_rfqs"),
    # Same screen, same audience: App Integrations reads the configuration and logs
    # behind the console anybody holding `integration.view` already opens, and every
    # route on it is gated by that code. Fail-closed would put a Settings row on the
    # rail that the one desk meant to use it gets a locked door from.
    page_view_code("admin_app_links"): INTEGRATION_VIEW,
    # The four inbound warehouse screens, same story: catalogued late (2026-08-20), so
    # each inherits the action code that has been gating it since the module landed.
    page_view_code("wh_inward"): RECEIPT_VIEW,
    page_view_code("wh_grn"): RECEIPT_VIEW,
    page_view_code("wh_qc"): INSPECTION_VIEW,
    page_view_code("wh_putaway"): PUTAWAY_VIEW,
    # Outward QC is a genuinely NEW screen on a genuinely new code, so this one is
    # fail-closed on purpose: nobody holds `qc_outward.view` until an admin grants it.
    page_view_code("wh_qc_outward"): QC_OUTWARD_VIEW,
    # The Fulfilment Desk replaces the Fulfilment Queue and Allocation Approvals, so it
    # lands with the people who worked them rather than fail-closed to Admin — the same
    # reasoning as the Activity Ledger above. It inherits from the QUEUE, not from
    # Allocation Approvals: the queue is the wider grant (every desk that allocates has
    # it, only some of them approve), and the buttons on the new screen are still gated
    # one by one on `allocation.create` / `allocation.approve_reserve`, so inheriting
    # the screen hands nobody an approval they did not already hold.
    page_view_code("inv_fulfilment_desk"): page_view_code("inv_fulfillment"),
    # A read-only register over documents `po.view` already covers, so it lands with the
    # buyers who can see purchase orders today rather than fail-closed to Admin. The
    # endpoint behind it is gated on PO_VIEW for the same reason: the register's most
    # sensitive column is what an order came to.
    page_view_code("pro_ledger"): PO_VIEW,
    # The Overview lands with whoever can already open the register that is the
    # module's front door today, rather than fail-closed to Admin: it is the same
    # documents, summarised, and a landing page nobody has been granted is a module
    # that opens on an error. It does NOT inherit from `po.view` — the board's most
    # sensitive numbers (month spend, open commitment) come from the PO tile, and that
    # tile is gated on `po.view` separately, so a requisition clerk sees the board with
    # the order strip simply absent.
    page_view_code("pro_overview"): page_view_code("pro_requisitions"),
    # Lands with everyone who can already read the ledgers. The trail shows no
    # document a reader could not open one at a time from Reports today — it only
    # saves them doing it by hand — and its endpoints are gated on `report.view`
    # independently.
    # The per-module Masters screens. They inherit from `page.masters.view` — the
    # all-in-one screen — because they show a SUBSET of what that screen already
    # shows to the same people: whoever can open Masters today opens these on the day
    # they deploy, and nobody else. Fail-closed is right for a new capability and
    # wrong here, where the capability is not new, only re-filed.
    #
    # The WRITE side is untouched either way: every tab is still gated by its own
    # `master.*.manage` code, in the component and on the endpoint.
    page_view_code("inv_masters"): page_view_code("masters"),
    page_view_code("pro_masters"): page_view_code("masters"),
    page_view_code("ind_masters"): page_view_code("masters"),
    page_view_code("admin_org_masters"): page_view_code("masters"),
    # The desks already show these people every pending return in the company,
    # whatever point it came from, so handing them the register changes what they can
    # SEE nowhere — only where they can see it. Inherited from `return.decide` because
    # the decision desk is the role the gap was reported on and the one that cannot do
    # its job without it; a storekeeper holding only `return.view` keeps the subtree
    # scoping they have today.
    RETURN_VIEW_ALL: RETURN_DECIDE,
    page_view_code("rep_traceability"): REPORT_VIEW,
    # Same reasoning as the Document Trail beside them. The Attachments register shows
    # files hanging off documents the other ledgers already show this login (and its
    # endpoint scopes the rows again on top of `report.view`); Live Tracking is those
    # ledgers' own reads, polled. Neither should fail closed to Admin.
    page_view_code("rep_attachments"): REPORT_VIEW,
    page_view_code("rep_live_tracking"): REPORT_VIEW,
    # NOT from REPORT_VIEW, unlike the three above. Each of these ledgers draws on a
    # document class the Reports rail does not otherwise expose, and the service
    # refuses the rows to a login without that permission
    # (`reports.service.readable_spec`). Inheriting the wider code would put a rail
    # row in front of people whose first press is a 403 — the menu has to agree with
    # what the endpoint will do.
    page_view_code("rep_procurement"): PO_VIEW,
    page_view_code("rep_transport"): TRANSPORT_VIEW,
    page_view_code("rep_returns"): RETURN_VIEW,
})
