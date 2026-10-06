"""Keeps rbac_pages in step with the screens that actually exist.

Adding a screen used to mean editing `scripts/seed.py` PAGE_TREE and reseeding —
and seed PRUNES, so on the live database that deletes real rows. In practice
nobody reseeds, so new screens either never appear in the menu or get bolted on
with a hand-written INSERT.

This module syncs instead of seeding:

  * a page in the catalogue but not in the database is INSERTED, with its own
    `page.<code>.view` permission granted to Admin and nobody else
  * a page in both has its title/parent/order refreshed
  * a page in the database but NOT in the catalogue is LEFT ALONE

That last rule is the important one. It is the difference between a sync and a
seed: this can add and update, it can never delete. A screen someone added
directly, or one from a branch not merged yet, survives untouched.

New pages are Admin-only on purpose — the same fail-closed rule that governs a
job profile HCM invents tomorrow. A new screen must never widen access for
everyone in its module the moment it is deployed; an admin ticks it on when it is
ready to be used.

Runs on startup, so deploying a new screen is enough to register it.
"""
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.platform.rbac import permissions as perms
from app.platform.rbac.models import Page, Permission, Role, RolePermission

ADMIN_ROLE_CODE = "ADMIN"


@dataclass(frozen=True)
class PageDef:
    code: str
    path: str
    name: str
    parent: str | None = None
    icon: str | None = None
    module: str | None = None
    sort_order: float = 0
    show_on_mobile: bool = True
    # A page with no permission is visible to everyone — only Home should be that.
    always_on: bool = False


# The catalogue. A developer adding a screen adds one line here and deploys; the
# row, its permission and the Admin grant appear on the next start.
#
# Only pages this file knows about are managed. Everything already in rbac_pages
# stays exactly as it is, which is why this list does not have to be exhaustive.
PAGES: list[PageDef] = [
    # Sorts AFTER the existing RBAC screens (81, 82) on purpose. The left rail sends
    # a module to its FIRST child, so a new page that sorts first silently becomes
    # the module's front door — and on a backend that predates its endpoint, opening
    # the whole module then 404s. New screens go at the end of their group.
    PageDef("rbac_job_profiles", "/rbac/job-profiles", "Job Profiles",
            parent="grp_rbac", module="rbac", icon="briefcase", sort_order=83),
    # The ONE approval-configuration screen. Catalogued so it gets a
    # `page.admin_approval_flow.view` of its own instead of borrowing
    # `admin.workflow.manage` — see permissions.INHERITS_GRANTS_FROM, which hands the
    # new code to everyone who can reach the screen today.
    PageDef("admin_approval_flow", "/admin/approval-flow", "Approval Flow",
            parent="grp_settings", module="admin", icon="git-branch",
            sort_order=91),
    # The asset / consumable code formula. Last in Settings for the reason above.
    PageDef("admin_code_formats", "/admin/code-formats", "Code Formats",
            parent="grp_settings", module="admin", icon="braces", sort_order=102),
    PageDef("admin_monthly_indent", "/admin/monthly-indent", "Monthly Indent",
            parent="grp_settings", module="admin", icon="bell", sort_order=103),
    # The API console. Under Settings, last, for the same reason as Code Formats —
    # a new screen must never become a module's front door.
    PageDef("admin_integrations", "/admin/integrations", "Integrations",
            parent="grp_settings", module="integrations", icon="plug",
            sort_order=104),
    # The other half of the same question, right beside it: the console lists who
    # calls US, this lists what WE call — HCM, mail, the database — with each
    # credential masked and each link's own log readable for the first time. A failed
    # HCM sync wrote `sys_hcm_sync_log` and surfaced nowhere once the run was over.
    #
    # Gated on `integration.view` like the console (see INHERITS_GRANTS_FROM below), so
    # whoever can read the API console reads this and nothing new is granted.
    PageDef("admin_app_links", "/admin/app-links", "App Integrations",
            parent="grp_settings", module="integrations", icon="plug",
            sort_order=105),
    # The approvals landing page. sort_order 20 puts it FIRST in its group, which
    # makes it the module's front door — deliberate here, and safe, because it calls
    # no endpoint that did not already exist (/pending/summary, /reports/summary,
    # /allocation-cycles). The warning at the top of this list is about NEW endpoints.
    PageDef("approval_overview", "/approvals/overview", "Dashboard",
            parent="approvals", module="approvals", icon="layout-dashboard",
            sort_order=20),
    # Returns — a module of its own, so the group row comes first and the screens
    # hang off it. sort_order 60 puts it after Warehouse and before Reports.
    PageDef("grp_returns", "/returns", "Returns", module="returns",
            icon="corner-up-left", sort_order=60),
    PageDef("returns_overview", "/returns/dashboard", "Dashboard",
            parent="grp_returns", module="returns", icon="layout-dashboard",
            sort_order=1),
    PageDef("returns_register", "/returns", "All Returns",
            parent="grp_returns", module="returns", icon="list", sort_order=2),
    PageDef("returns_mine", "/returns/mine", "My Returns",
            parent="grp_returns", module="returns", icon="rotate-ccw", sort_order=3),
    PageDef("returns_approvals", "/returns/approvals", "Approvals",
            parent="grp_returns", module="returns", icon="check-circle", sort_order=4),
    # The two desks. Separate rows because they are separate backlogs held by
    # different people, even though one component serves both.
    PageDef("returns_decisions", "/returns/decisions", "Decision Desk",
            parent="grp_returns", module="returns", icon="scale", sort_order=5),
    PageDef("returns_sign_off", "/returns/sign-off", "Sign-off",
            parent="grp_returns", module="returns", icon="pen-line", sort_order=6),
    PageDef("returns_purchase", "/returns/purchase", "Purchase Returns",
            parent="grp_returns", module="returns", icon="package-x", sort_order=7),
    PageDef("returns_receiving_config", "/returns/settings/receiving",
            "Receiving Points", parent="grp_returns", module="returns",
            icon="map-pin", sort_order=8),
    # Accounts (2026-10-06) — a module of its own: what each PO owes its vendor by
    # payment milestone, and the payments recorded against them.
    PageDef("grp_accounts", "/accounts", "Accounts", module="accounts",
            icon="indian-rupee", sort_order=65),
    PageDef("acc_payments", "/accounts/payments", "Vendor Payments",
            parent="grp_accounts", module="accounts", icon="receipt",
            sort_order=1),
    # The module row itself, listed only to rename it: the menu said "Purchasing"
    # while the permission catalogue, the backend package and the table prefix all
    # said procurement, and the RBAC screen needed a hard-coded alias to reconcile
    # them. The CODE stays `grp_purchasing` — a code is an identity and `sync_pages`
    # can rename a page but never move one. `always_on` keeps `required_permission`
    # untouched (it is `po.view` on the live row) instead of minting an unused
    # `page.grp_purchasing.view` beside it.
    PageDef("grp_purchasing", "/pos", "Procurement", icon="shopping-cart",
            module="procurement", sort_order=30, always_on=True),
    # Procurement's buying chain, under the group that already carries the PO screens.
    # `grp_purchasing`, not `grp_procurement` — the menu row predates the module name
    # and `sync_pages` can add a page but never move one, so the code follows the row.
    # Sorted the way the work actually happens (2026-08-20, business request):
    # Requisitions -> Consolidation -> RFQs -> Quotations -> Purchase Orders. Reading
    # the rail top to bottom now walks the buying chain forwards; before it opened on
    # the Purchase Order, which is the LAST document in that chain, so a buyer met the
    # answer before the question.
    #
    # These sort BELOW po_list's existing 31 rather than renumbering po_list, which is
    # a seed.py row this file does not manage. Requisitions becomes the module's front
    # door, which is the intent — the left rail opens a module on its FIRST child.
    # The module's front door (2026-08-23): the buying chain on one board — what is
    # waiting on ME, what each rung is holding, and the demand pool underneath. It
    # sorts at 24, BELOW Requisitions' 25, because the left rail opens a module on its
    # first child and a board is the right thing to open on: a buyer arriving at
    # Procurement wants to know what needs a decision before they want a register.
    #
    # Every strip on it is a separate request on the view code of the documents it
    # counts (`requisition.view`, `consolidation.view`, `rfq.view`, `rfq.compare`,
    # `po.view`), so the page's own permission means only "may open the board" — a
    # login that holds one of the five sees one strip, not an error.
    PageDef("pro_overview", "/procurement/overview", "Dashboard",
            parent="grp_purchasing", module="procurement", icon="layout-dashboard",
            sort_order=24),
    PageDef("pro_demand_pool", "/procurement/demand-pool", "Demand Pool",
            parent="grp_purchasing", module="procurement", icon="pie-chart",
            sort_order=25),
    PageDef("pro_requisitions", "/procurement/requisitions", "Requisitions",
            parent="grp_purchasing", module="procurement", icon="file-text",
            sort_order=25),
    PageDef("pro_rfqs", "/procurement/rfqs", "RFQs",
            parent="grp_purchasing", module="procurement", icon="gavel",
            sort_order=27),
    PageDef("pro_quotations", "/procurement/quotations", "Quotations",
            parent="grp_purchasing", module="procurement", icon="handshake",
            sort_order=28),
    # Price Compare (2026-09-26): the war room. One RFQ picked at the top, every
    # quotation to it side by side underneath, and the award — which used to live
    # inside the RFQ page and moved here so the tender room never carries prices.
    # sort_order 29 sorts it after Quotations (28) and before the PO list (31): the
    # rail reads Requisitions -> Consolidation -> RFQs -> Quotations -> Price
    # Compare -> Purchase Orders, which is the order the work happens in.
    PageDef("pro_price_compare", "/procurement/compare", "Compare Quotations",
            parent="grp_purchasing", module="procurement", icon="git-compare-arrows",
            sort_order=29),
    # The supplier register: who sells us material, and whether they can actually sign
    # in to answer an RFQ. Under PURCHASING rather than Settings, unlike its carrier
    # twin — a buyer who finds no vendor on the RFQ picker is one click from the list
    # that feeds it, and the routes are guarded by `vendor.portal.manage` either way,
    # so the menu position widens nothing.
    #
    # sort_order 33 keeps it LAST among the purchasing children (the ledger is 32).
    # The left rail opens a module on its FIRST child, and a register of vendors must
    # never become the front door of Procurement.
    PageDef("pro_suppliers", "/procurement/suppliers", "Suppliers",
            parent="grp_purchasing", module="procurement", icon="store",
            sort_order=33),
    # Document traceability: one number in, the whole chain out. Under Reports
    # because it crosses every module and writes nothing — the same reason the
    # package it lives in sits outside the import chain. LAST in the group, so it
    # never becomes the module's front door (the rail opens a module on its first
    # child, and this screen is useless without a number typed into it).
    PageDef("rep_traceability", "/reports/traceability", "Document Trail",
            parent="grp_reports", module="reports", icon="git-branch",
            sort_order=79),
    # Reports > Attachments: the files filed against every document the other ledgers
    # already list for this login, as one register. Same view permission as those
    # ledgers, and `reports/attachments.py` scopes the rows to the login on top of it.
    PageDef("rep_attachments", "/reports/attachments", "Attachments",
            parent="grp_reports", module="reports", icon="file-stack",
            sort_order=75),
    # Reports > Live Tracking: the indent Journey and the Document Trail chain, polled,
    # so an approval pressed in another building reaches the reader without a refresh.
    # Beside the Document Trail rather than replacing it — the Trail answers "find any
    # document by number", this one follows ONE indent as it moves.
    PageDef("rep_live_tracking", "/reports/live-tracking", "Live Tracking",
            parent="grp_reports", module="reports", icon="radio",
            sort_order=76),
    # The company mailbox: Inbox, Sent and Compose. Under Settings because it is one
    # shared account for the whole deployment, not a per-user inbox — and because the
    # same mailbox is what sends every password-reset link. Admin-only until granted:
    # its permission has no INHERITS_GRANTS_FROM entry, so nobody receives it by
    # accident on deploy.
    PageDef("settings_mail", "/settings/mail", "Mail", parent="grp_settings",
            module="admin", icon="send", sort_order=105),
    # Who outside the company can sign in. Under Settings, not Procurement: it mints
    # an identity, which is an administrator's act rather than a buyer's. Carriers
    # ride on this screen too — a transport provider is a vendor row, so it is the
    # same account and the same button.
    PageDef("admin_supplier_accounts", "/admin/supplier-accounts",
            "Supplier & Carrier Logins", parent="grp_settings",
            module="procurement", icon="key", sort_order=104),
    # The consolidated buying sheet — between the requisitions it gathers and the RFQ
    # it feeds, which is where it sits in the flow.
    PageDef("pro_consolidations", "/procurement/consolidations", "Consolidation",
            parent="grp_purchasing", module="procurement", icon="layers",
            sort_order=26),
    # The buying trail: every requisition, RFQ, quotation and order in one register.
    # LAST in the group (sort_order 32, after po_list's 31) — a ledger is where you go
    # to look something up, never the module's front door, and the left rail opens a
    # module on its FIRST child.
    PageDef("pro_ledger", "/procurement/ledger", "Procurement Ledger",
            parent="grp_purchasing", module="procurement", icon="list",
            sort_order=32),

    # Renames the live Transfers row. The screen is a read-only STO/SMO register now,
    # and "Transfers" read like somewhere you could raise one. `always_on` so the
    # refresh leaves `required_permission` exactly as the row already carries it —
    # this is a rename and nothing else. sort_order matches the live row (55), because
    # sync_pages refreshes that field and a different number would move the screen.
    PageDef("inv_transfers", "/inventory/transfers", "Stock Transfer",
            parent="grp_inventory", module="inventory", icon="arrow-left-right",
            sort_order=55, always_on=True),
    # The Fulfilment Desk — the Fulfilment Queue and Allocation Approvals as ONE
    # screen (2026-08-21). They were two halves of a single decision: the queue listed
    # what an indent was still owed, you typed what to give, and the document then went
    # to a second screen to be signed. Where the project's ladder says NO_APPROVAL that
    # second screen was a page with one button on it; where a real ladder is configured
    # the approver had to leave the numbers behind to find it. One screen carries both
    # — a Queue tab and an Approvals tab over the same rows — so the ladder decides how
    # many presses it takes and the screen never has to.
    #
    # sort_order 56 is the live `inv_fulfillment` row's own number, so the desk lands
    # exactly where the queue used to sit in the rail rather than becoming the module's
    # front door (see the note on `rbac_job_profiles`).
    PageDef("inv_fulfilment_desk", "/inventory/fulfilment", "Fulfilment Desk",
            parent="grp_inventory", module="inventory", icon="check-circle",
            sort_order=56),
    # Stock Audit (2026-09-24): the physical count against system stock, and the
    # correction that follows. The live row is parked (is_active = 0) and sync never
    # flips that, so migration `a4c6e8f0b2d3` switches it back on.
    PageDef("inv_adjustments", "/inventory/adjustments", "Stock Audit",
            parent="grp_inventory", module="inventory", icon="sliders",
            sort_order=60),
    # Edit a held unit's / batch's identity, signed on the STOCK_EDIT ladder.
    PageDef("inv_stock_edits", "/inventory/stock-edits", "Stock Corrections",
            parent="grp_inventory", module="inventory", icon="pen-line",
            sort_order=61),

    # ------------------------------------------------------------------ #
    #  Masters, on the module that owns them
    # ------------------------------------------------------------------ #
    # `/masters` is NOT retired and is not listed here — it stays whole, and these are
    # a second door on the same rows. What they add is RBAC reach: one page code per
    # module, so a buyer can be given the vendor and HSN masters without also being
    # handed the item catalogue, which one `page.masters.view` could never express.
    #
    # Every screen renders the masters module's own tab components with their own
    # `<Can>` gating and calls the same `/api/masters/*` routes behind the same
    # `master.*.manage` permissions, so nothing here widens what anybody may WRITE.
    #
    # All four sort LAST in their group. The left rail opens a module on its first
    # child, and a master is never what somebody came to that module to do.
    PageDef("inv_masters", "/inventory/masters", "Masters",
            parent="grp_inventory", module="inventory", icon="database",
            sort_order=65),
    PageDef("pro_masters", "/procurement/masters", "Masters",
            parent="grp_purchasing", module="procurement", icon="database",
            sort_order=34),
    PageDef("ind_masters", "/indents/masters", "Masters",
            parent="grp_indents", module="indents", icon="database",
            sort_order=17),
    # Projects, facilities and departments — HCM mirrors, read-only (rule 10). Under
    # Settings rather than a module, because filing them beside masters somebody can
    # edit would imply these are editable too.
    PageDef("admin_org_masters", "/admin/org-masters", "Organisation Masters",
            parent="grp_settings", module="admin", icon="building-2",
            sort_order=106),

    # ------------------------------------------------------------------ #
    #  Logistics — the outward transport leg
    # ------------------------------------------------------------------ #
    # A module row of its own. sort_order 55 puts it after Warehouse (which the live
    # rows have in the 40s) and before Returns at 60, which is the order the material
    # actually moves in: warehouse packs it, logistics ships it, returns bring it back.
    PageDef("grp_logistics", "/logistics", "Logistics", module="logistics",
            icon="truck", sort_order=55),
    # The order is the order the material moves, and the module's front door is its
    # FIRST child: Consignments. That is where a logistics day starts — the warehouse
    # has packed something and it is sitting on the floor waiting for a truck. Opening
    # on Shipments asked the desk to read the answer before the question.
    #
    # Consignments and Dispatch are the SAME screens (and the same documents, and the
    # same flow) the warehouse serves; these are separate rbac_pages rows pointing at
    # the same paths under /logistics. The warehouse rows keep their own codes, paths
    # and permissions and are not touched.
    # NEW 2026-08-23. The module's front page, and its FIRST child. It keeps its OWN
    # url: `/logistics` is the module door and redirects to Shipments, where a
    # logistics day is worked, so the Dashboard tab has to point at the Dashboard
    # screen rather than follow that door.
    #
    # It reads `/api/transport/summary` and writes nothing, so it is guarded by the
    # transport code the Shipments register already needs — no new permission, and
    # `page.logistics_overview.view` inherits from `page.logistics_transport.view` (see
    # permissions.INHERITS_GRANTS_FROM) so the desk that works Shipments gets it without
    # anybody re-granting.
    PageDef("logistics_overview", "/logistics/overview", "Dashboard",
            parent="grp_logistics", module="logistics", icon="layout-dashboard",
            sort_order=0),
    PageDef("logistics_consignments", "/logistics/consignments", "Consignments",
            parent="grp_logistics", module="logistics", icon="boxes", sort_order=1),
    PageDef("logistics_dispatch", "/logistics/dispatch", "Dispatch",
            parent="grp_logistics", module="logistics", icon="send", sort_order=2),
    PageDef("logistics_load_planner", "/logistics/load-planner", "Smart Load Planner",
            parent="grp_logistics", module="logistics", icon="map-pin", sort_order=3),
    # "Shipments", not "Transport Requests": the row is not a request for long. The
    # screen carries the leg from DRAFT through IN_TRANSIT, DELIVERED and CLOSED, and
    # lists the lane, the load, the LR/docket and the freight — a register of what is
    # moving, which is the word the documents already use (`lgs_shipment_events`).
    # `sync_pages` refreshes path and name on an existing row, so a deployed database
    # picks both up on the next start; the code stays `logistics_transport` so every
    # `page.logistics_transport.view` grant already issued keeps working.
    PageDef("logistics_transport", "/logistics/shipments", "Shipments",
            parent="grp_logistics", module="logistics", icon="route", sort_order=4),
    # Provider Selection is the RFQ desk: Dispatch asks several partners to price the
    # SAME consignment, and this is where those prices come back, sit side by side and
    # one of them is awarded. No screen of its own — a tender is not a document, it is
    # the question "who is taking this", and that question already had a page.
    PageDef("logistics_providers", "/logistics/providers", "Provider Selection",
            parent="grp_logistics", module="logistics", icon="users", sort_order=5),
    # What happened, to which shipment, in the order it happened — one register in
    # place of the three tabs that each drew a slice of it. Shipment Tracking answered
    # "where is it now", Exceptions answered "what went wrong", and neither said who
    # awarded the job, at what price, or when the carrier agreed to it; a desk chasing
    # a consignment read half the story on one tab and half on another. The ledger is
    # derived from the documents (`transport.activity_ledger`), so it can only ever
    # show events that were actually recorded.
    PageDef("logistics_activity", "/logistics/activity", "Activity Ledger",
            parent="grp_logistics", module="logistics", icon="history", sort_order=6),
    # Shipment Tracking, Acknowledgements and Exceptions are NOT listed here any more,
    # and that is deliberate rather than an omission.
    #
    # Tracking and Exceptions were replaced by the Activity Ledger above, which carries
    # both of their contents and the rest of the trail besides. Signing for what arrived
    # is the INDENT RAISER's act — they asked for the material, so they are the only
    # person who can say what turned up — and that screen lives under Indents.
    #
    # Dropping the rows from this catalogue keeps a NEW database clean. It cannot clear
    # an existing one: `sync_pages` inserts and refreshes but never deletes, and never
    # forces `is_active` either way, precisely so an admin who retired a screen does not
    # get it back on the next restart. On a database that already has these rows the
    # Alembic migration parks them; until then, the paths redirect to the ledger rather
    # than dead-ending.
    # The register behind the Dispatch dropdown: the third-party providers (Amazon,
    # Flipkart, Alibaba, Misaba, a truck operator) and their portal logins. It now sits
    # in the LOGISTICS tabs, beside the Dispatch screen whose dropdown it fills — a
    # dispatcher who finds no provider in that list is one click from the register that
    # feeds it, instead of being sent to Settings and back.
    #
    # The page CODE is deliberately unchanged. `page.settings_logistics_vendors.view` is
    # what carries the Admin-only grant, and issuing a login outside the company is
    # still an administrator's act whichever menu it hangs from — renaming the code
    # would mint a fresh permission and silently drop whoever already holds this one.
    # `sync_pages` refreshes path, parent and order for a code it already knows, so
    # moving the row is these three fields and nothing else.
    #
    # sort_order 8 keeps it LAST among the logistics children. The left rail sends a
    # module to its first child, so a low order here would make the vendor register the
    # front door of Logistics for anyone holding it, which is exactly what putting it
    # under Settings was avoiding.
    # handshake, not truck: grp_logistics itself is the truck, and a child wearing the
    # parent's glyph is the one pair the rail always shows side by side. This row is
    # about the PARTNER, not the vehicle.
    PageDef("settings_logistics_vendors", "/logistics/vendors",
            "Logistics Vendors", parent="grp_logistics", module="logistics",
            icon="handshake", sort_order=8),

    # ------------------------------------------------------------------ #
    #  Warehouse — Outward QC
    # ------------------------------------------------------------------ #
    # The outward counterpart of Quality Inspection: a posted outward issue holding an
    # item flagged `requires_qi` raises an inspection, and the consignment cannot be
    # raised until it passes. The screen was dropped from the module on 2026-08-13 and
    # comes back with endpoints and permissions of its own (`qc_outward.*`).
    #
    # Catalogued here as well as in migration `96dd19ed80c2`, which is what puts the
    # row on a database that already exists. This entry is what puts it on a NEW one —
    # `scripts/seed.py` PAGE_TREE cannot be run against anything live.
    #
    # sort_order 51 sits it just after Quality Inspection and well clear of 1, so it
    # can never become the front door the left rail opens Warehouse on.
    PageDef("wh_qc_outward", "/warehouse/qc-outward", "Outward QC",
            parent="grp_warehouse", module="warehouse",
            icon="clipboard-check", sort_order=51),
    PageDef("wh_demand_pool", "/warehouse/demand-pool", "Demand Pool",
            parent="grp_warehouse", module="warehouse", icon="pie-chart",
            sort_order=41),

    # ------------------------------------------------------------------ #
    #  Reports — ledgers that already existed with no way in
    # ------------------------------------------------------------------ #
    # `reports/ledgers.py` carries thirteen specs; the rail carried four. The rest
    # rendered perfectly for anybody who typed the URL and were invisible to
    # everybody else. `grp_reports` and its first four children predate this
    # catalogue and are left exactly as they are; these three only add to the group.
    #
    # Stock, Assets, Consumption, Indent Tracker, Approval SLA and Acknowledgements
    # are deliberately NOT rows here. Each is a different cut of the SAME documents
    # the ledger above it already lists, so each is a sub-tab inside rep_inventory /
    # rep_indents / rep_approvals — one screen, several cuts — rather than six more
    # rail entries on a menu that is already long. Adding them here would give the
    # same data two front doors and the menu a thirteenth row.
    #
    # These three are different: each draws on a document class the Reports rail does
    # not otherwise show at all, which is also why each inherits its grant from the
    # permission that reads that document rather than from `report.view`
    # (permissions.INHERITS_GRANTS_FROM), and why `reports.service.readable_spec`
    # refuses the rows to a login without it. The menu and the endpoint agree.
    #
    # 76-78 sits them after Live Tracking and nowhere near 71, so none of them can
    # become the front door the left rail opens Reports on.
    PageDef("rep_procurement", "/reports/procurement", "Procurement Ledger",
            parent="grp_reports", module="reports", icon="shopping-cart",
            sort_order=77),
    PageDef("rep_transport", "/reports/transport", "Logistics Ledger",
            parent="grp_reports", module="reports", icon="truck", sort_order=78),
    PageDef("rep_returns", "/reports/returns", "Returns Ledger",
            parent="grp_reports", module="reports", icon="rotate-ccw",
            sort_order=79),
]


async def sync_permission_labels(db: AsyncSession) -> list[str]:
    """Insert catalogue permissions that are missing, and refresh the labels of the rest.

    Inserting is safe and it is the only way a new permission ever becomes grantable:
    the seed is the only thing that ever wrote rbac_permissions, and the seed must not
    run against a live database. Without this, an endpoint added with a new permission
    code checks a permission that exists nowhere, so it 403s for everybody forever and
    no admin can even see it on the Job Profiles screen to tick it on.

    A new permission is granted to Admin and to nobody else, the same fail-closed rule
    `sync_pages` applies to a new screen: inserting the row alone left even the
    administrator 403ing on the endpoint that had just shipped, which is not
    "fail-closed", it is "unreachable". Only on first insert — re-granting on every
    start would undo an admin who deliberately took it off Admin.

    Then, the labels.

    `seed_permissions` inserts through `get_or_create`, whose defaults only apply on
    INSERT. So a permission's module/description is frozen at whatever it was the day
    the row was first created, and every later correction in `permissions.py` is
    silently ignored on any database that already has the row — which is all of them.

    That is how `stock.view` and `stock.adjust` stayed tagged `logistics` long after
    the catalogue moved them to `inventory`, and why the RBAC screens file their
    buttons under a module the screen left. The grouping was never the bug; the label
    was, and nothing was refreshing it.

    `code` is the identity and is never touched, and no grant on an EXISTING permission
    is read or written, so a relabel cannot widen or narrow anyone's access.
    """
    catalogue = {p.code: p for p in perms.ALL_PERMISSIONS}
    rows = (await db.execute(select(Permission))).scalars().all()
    admin_role = (await db.execute(
        select(Role).where(Role.code == ADMIN_ROLE_CODE)
    )).scalars().first()
    changed = []

    by_code = {row.code: row for row in rows}
    for code in sorted(catalogue.keys() - set(by_code)):
        spec = catalogue[code]
        permission = Permission(code=spec.code, module=spec.module,
                                resource=spec.resource, action=spec.action,
                                description=spec.description)
        db.add(permission)
        changed.append(f"{code}: added")
        await db.flush()

        # Admin, plus — for a permission carved out of one already in use — everyone
        # who holds the source (perms.INHERITS_GRANTS_FROM). Fail-closed is right for
        # a new capability and wrong for a split: the split would revoke a button the
        # holder has been pressing since before the deploy.
        role_ids = {admin_role.id} if admin_role is not None else set()
        source = by_code.get(perms.INHERITS_GRANTS_FROM.get(code, ""))
        if source is not None:
            inherited = (await db.execute(
                select(RolePermission.role_id)
                .where(RolePermission.permission_id == source.id)
            )).scalars().all()
            role_ids.update(inherited)
            changed.append(f"{code}: inherited {len(inherited)} grants "
                           f"from {source.code}")
        for role_id in sorted(role_ids):
            db.add(RolePermission(role_id=role_id, permission_id=permission.id))

    for row in rows:
        spec = catalogue.get(row.code)
        if spec is None:
            continue  # not ours: left alone, same rule as an unknown page
        if row.description != spec.description:
            # Wording only — never a grant. The Job Profiles screen prints this, so a
            # corrected sentence in the catalogue must reach every database.
            row.description = spec.description
            changed.append(f"{row.code}: relabelled")
        if (row.module, row.resource, row.action) == (
                spec.module, spec.resource, spec.action):
            continue
        changed.append(f"{row.code}: {row.module} -> {spec.module}")
        row.module, row.resource, row.action = spec.module, spec.resource, spec.action
    if changed:
        await db.commit()
    return changed


# Screens that have been REPLACED and must stop appearing in the menu.
#
# `sync_pages` deliberately never deletes and never forces `is_active` back on, so a
# retired screen stays retired. Retiring is the other half of that contract and needs
# saying out loud somewhere: these three all wrote to `wf_workflows` beside Approval
# Flow, with different rules about what a save retires, and one of them
# (`admin_approvals_config`) deactivated every rank-scoped chain for the document it
# saved. One screen, one writer.
#
# The rows and their permissions are LEFT IN PLACE, only parked — every grant on them
# survives, so restoring a screen is flipping `is_active` back, not a migration.
RETIRED_PAGES: list[str] = [
    "admin_approvals_config",
    "admin_workflows",
    # FIXED 2026-08-20 — Consignments and Dispatch belong to LOGISTICS, and after the
    # indent/approvals/logistics integration they are reached at /logistics/consignments
    # and /logistics/dispatch. The warehouse rows were still on the rail pointing at
    # /warehouse/dispatch/* — a second front door to a decision that is made in one
    # place, and the one nearly every consignment was actually leaving through: a
    # warehouse gate-out sets DISPATCHED without ever raising a transport request, so
    # the load goes with no carrier, no freight, no LR and nothing in the activity
    # ledger. WITHOUT retiring them the split is advertised and bypassed at once.
    #
    # Retired, not deleted: `retire_pages` only sets is_active = 0, so the grants on the
    # rows survive and an admin can put them back if the split is ever reversed. The old
    # paths redirect (modules/warehouse/index.tsx), so a bookmark still lands on the
    # live screen.
    "wh_consignments",
    "wh_dispatch",
    # FIXED 2026-08-21 — the Fulfilment Queue and Allocation Approvals are one screen
    # now (`inv_fulfilment_desk`). Two rows for two halves of one decision is how a
    # desk ended up typing a quantity on one screen and hunting for the button on
    # another. Both paths redirect (modules/inventory/index.tsx), and retiring only
    # parks the rows — every grant on them survives, and
    # `page.inv_fulfilment_desk.view` inherits from `page.inv_fulfillment.view` so the
    # desk that worked the queue yesterday opens the new screen today.
    "inv_fulfillment",
    "inv_allocation_approvals",
    # RETIRED 2026-08-23 — Settings carried three rows for configuring approvals.
    # `admin_approvals_config` was parked already; these two are the rest of the same
    # duplication. Approval Flow (`admin_approval_flow`) is THE approval-configuration
    # screen and is catalogued as such, so a second and third door onto the same
    # decision is how two admins end up configuring a ladder in two places and neither
    # of them being the one the engine reads.
    #
    # Parked, never deleted, exactly like every row above: `retire_pages` only sets
    # is_active = 0, so every grant survives and an admin can switch them back on. The
    # ROUTES stay registered too — a bookmark still opens the screen, and nothing that
    # already reads these tables changes behaviour.
    "admin_rules",
    "admin_policies",
]


async def retire_pages(db: AsyncSession) -> list[str]:
    """Park the replaced screens. Idempotent — a second run retires nothing."""
    rows = (await db.execute(
        select(Page).where(Page.code.in_(RETIRED_PAGES), Page.is_active.is_(True))
    )).scalars().all()
    for page in rows:
        page.is_active = False
    if rows:
        await db.commit()
    return [page.code for page in rows]


async def sync_pages(db: AsyncSession) -> dict:
    """Insert missing pages, refresh known ones, delete nothing."""
    retired = await retire_pages(db)
    existing = {
        page.code: page
        for page in (await db.execute(select(Page))).scalars().all()
    }
    permission_by_code = {
        p.code: p for p in (await db.execute(select(Permission))).scalars().all()
    }
    admin_role = (await db.execute(
        select(Role).where(Role.code == ADMIN_ROLE_CODE)
    )).scalars().first()

    added, updated = [], []
    for spec in PAGES:
        parent = existing.get(spec.parent) if spec.parent else None
        if spec.parent and parent is None:
            # Parent not deployed yet: skip rather than orphan the child into the
            # top-level rail, which get_user_menu would then have to prune anyway.
            continue

        required = None if spec.always_on else perms.page_view_code(spec.code)
        minted = False
        if required and required not in permission_by_code:
            minted = True
            permission = Permission(
                code=required, module=spec.module or "admin",
                resource=perms.PAGE_RESOURCE, action="view",
                description=f"See the {spec.name} page",
            )
            db.add(permission)
            await db.flush()
            permission_by_code[required] = permission

        page = existing.get(spec.code)
        if page is None:
            page = Page(
                code=spec.code, path=spec.path, name=spec.name,
                icon=spec.icon, module=spec.module,
                parent_id=parent.id if parent else None,
                sort_order=spec.sort_order, required_permission=required,
                show_on_mobile=spec.show_on_mobile, is_active=True,
            )
            db.add(page)
            await db.flush()
            existing[spec.code] = page
            added.append(spec.code)
        else:
            # Refresh presentation only. is_active is NOT forced back on: an admin
            # who retired a screen should not have it reappear on every restart.
            #
            # sort_order is refreshed too: it decides which child a module opens on,
            # so a wrong one is a broken module, not a cosmetic detail — and it has
            # to be correctable by deploying rather than by hand-editing the row.
            # `icon` is refreshed too (2026-08-23). It was the one presentation field
            # this loop set on INSERT and never again, so eighteen catalogued pages
            # that shipped without one — every procurement, returns and logistics
            # screen — kept a NULL forever, and `MenuIcon` drew its default box for
            # all of them. A rail where six screens share one glyph is a rail nobody
            # can scan, and it could only be fixed by hand-editing rows.
            changed = (
                page.path != spec.path or page.name != spec.name
                or page.icon != spec.icon
                or page.sort_order != spec.sort_order
                or page.parent_id != (parent.id if parent else None)
            )
            page.path = spec.path
            page.name = spec.name
            page.icon = spec.icon
            page.module = spec.module
            page.sort_order = spec.sort_order
            page.parent_id = parent.id if parent else None
            if changed:
                updated.append(spec.code)

        # Fail closed: Admin only, and only on first registration. Re-granting on
        # every start would undo an admin who deliberately took it off Admin.
        #
        # "First registration" is the PERMISSION's as well as the page's. A page the
        # seed's PAGE_TREE already inserted (rbac_job_profiles, admin_code_formats) is
        # not `added` here, but its `page.<code>.view` is minted here — and the moment
        # it exists `get_user_menu` gates on it, so without this grant the page
        # vanished for Admin too on every freshly bootstrapped database.
        if required and admin_role is not None and (spec.code in added or minted):
            permission = permission_by_code[required]
            held = (await db.execute(select(RolePermission).where(
                RolePermission.role_id == admin_role.id,
                RolePermission.permission_id == permission.id,
            ))).scalars().first()
            if held is None:
                db.add(RolePermission(role_id=admin_role.id,
                                      permission_id=permission.id))

    await db.commit()
    return {"added": added, "updated": updated, "retired": retired}
