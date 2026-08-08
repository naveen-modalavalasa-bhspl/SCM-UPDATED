"""Idempotent seed for a LOCAL development database:  python -m scripts.seed

Seeds: all permissions, 5 roles, menu pages, a position tree, 4 departments,
one stock facility, 8 UOMs, 20 items, 5 vendors, 6 users (one per role), and one
active approval workflow per doc type (INDENT/PO/GRN/ISSUE) incl. an amount-
conditional Plant Head stage on PO.

NOT SAFE FOR A SHARED OR PRODUCTION DATABASE, and it now refuses to run against one.
Two things bit us on 2026-07-29:

  * It writes demo users, demo credentials and mock `hcm_*` rows over real data.
  * `seed_pages` used to DELETE every `rbac_pages` row missing from its own
    PAGE_TREE. Run from a branch behind the database and it silently removed the
    newer screens — that is how Settings lost Company Settings, Approval Workflows,
    Approvals Config and Approval & Automation, along with 16 others.

So: the seed only runs against a loopback database unless `--allow-remote` is passed,
and it never deletes a page unless `--prune` is passed. To add or repair menu rows on
a live server use `scripts.provision_pages`, which upserts and never deletes.

NOTE: it also inserts mock hcm_* rows (employees, positions, assignments,
departments, facility, office). Normally only app/platform/hcm/sync.py writes hcm_*,
but HCM's facilities/position-assignments feeds are empty, so the demo needs
bootstrap identity/org data. Real HCM data comes in via the sync job.
"""
import asyncio
import secrets
import sys

from sqlalchemy import select
from sqlalchemy.engine import make_url

from app.core.database import Base, SessionLocal, engine, settings
from app.core.security import hash_password
from app.platform.hcm.models import (
    HcmDepartment, HcmEmployee, HcmFacility, HcmOffice, HcmPosition,
    HcmPositionAssignment, HcmPositionLevel,
)
from app.platform.rbac import permissions as P
from app.platform.rbac.models import (
    Page, Permission, Role, RolePermission, UserRole,
)
from app.platform.settings.models import UserCredential
from app.platform.workflow.models import Stage, StageCondition, Workflow
from app.shared.enums import ApprovalMode, ApproverType, ConditionOperator, DocType, UserRole as RoleCode
from app.shared.models.base import utcnow
from app.shared.models.master import HsnCode, Item, ItemCategory, Uom, Vendor

# fixed hcm ids for the demo bootstrap
POS_PLANT_HEAD, POS_PROC_HEAD, POS_STORE_MGR, POS_DEPT_HEAD = 9001, 9002, 9003, 9004
DEPT_MECH, DEPT_ELEC, DEPT_CIVIL, DEPT_STORES = 501, 502, 503, 504
OFFICE_ID, FACILITY_ID = 701, 801

ROLE_PERMS = {
    RoleCode.ADMIN.value: P.ALL_CODES,
    RoleCode.REQUESTER.value: [P.INDENT_VIEW, P.INDENT_CREATE, P.INDENT_EDIT,
                               P.INDENT_SUBMIT, P.STOCK_VIEW],
    RoleCode.APPROVER.value: [P.INDENT_VIEW, P.INDENT_APPROVE, P.INDENT_REJECT,
                              P.PO_VIEW, P.PO_APPROVE, P.PO_REJECT, P.STOCK_VIEW],
    RoleCode.PROCUREMENT.value: [P.INDENT_VIEW, P.PO_VIEW, P.PO_CREATE, P.PO_EDIT,
                                 P.PO_SUBMIT, P.PO_SEND_VENDOR, P.MASTER_VENDOR_MANAGE,
                                 P.MASTER_ITEM_MANAGE, P.MASTER_CATEGORY_MANAGE,
                                 P.MASTER_UOM_MANAGE, P.MASTER_PROJECT_MANAGE,
                                 P.STOCK_VIEW],
    # Store keeps the warehouse/bin master: they are the people who know the physical
    # layout, and the Warehouse module needs somebody able to create bins on day one.
    # Store runs the floor, so it gets the whole warehouse cycle. The two decisions
    # that cost money — approving a dispatch and approving a purchase return — stay
    # off this list; those belong to a role that sits above the store.
    RoleCode.STORE.value: [P.GRN_VIEW, P.GRN_CREATE, P.GRN_QC, P.STOCK_VIEW,
                           P.STOCK_VIEW_ALL,
                           P.STOCK_ADJUST, P.STOCK_RESERVE, P.STOCK_TRANSFER,
                           P.ISSUE_VIEW, P.ISSUE_CREATE, P.ISSUE_ISSUE,
                           P.MASTER_LOCATION_MANAGE,
                           P.RECEIPT_VIEW, P.RECEIPT_CREATE, P.RECEIPT_POST,
                           P.INSPECTION_VIEW, P.INSPECTION_EXECUTE,
                           P.PUTAWAY_VIEW, P.PUTAWAY_EXECUTE,
                           P.PICKING_VIEW, P.PICKING_PICK,
                           P.DISPATCH_VIEW, P.DISPATCH_CREATE, P.DISPATCH_GATE_OUT,
                           P.DISPATCH_ACKNOWLEDGE,
                           P.RETURN_VIEW, P.RETURN_CREATE,
                           P.WAREHOUSE_REPORT_VIEW],
}

# username -> (employee_id, full name, role code, department_id, position_id)
USERS = [
    ("admin", 1, "System Admin", RoleCode.ADMIN.value, DEPT_STORES, None),
    ("requester", 2, "Ravi Requester", RoleCode.REQUESTER.value, DEPT_MECH, None),
    ("approver", 3, "Anita Approver", RoleCode.APPROVER.value, DEPT_MECH, POS_DEPT_HEAD),
    ("procurement", 4, "Prakash Procure", RoleCode.PROCUREMENT.value, DEPT_STORES, POS_PROC_HEAD),
    ("store", 5, "Sunil Store", RoleCode.STORE.value, DEPT_STORES, POS_STORE_MGR),
    ("planthead", 6, "Padma Planthead", RoleCode.APPROVER.value, DEPT_STORES, POS_PLANT_HEAD),
]

# Grouped menu (plain-language section names for non-technical users).
# (code, path, name, icon, required_permission, sort_order, parent_code)
PAGE_TREE = [
    ("home", "/", "Home", "home", None, 0, None),

    ("grp_indents", "/indents/dashboard", "Indents", "file-text", P.INDENT_VIEW, 10, None),
    ("ind_dashboard", "/indents/dashboard", "Overview", "layout-dashboard", P.INDENT_VIEW, 11, "grp_indents"),
    ("ind_list", "/indents", "All Requests", "list", P.INDENT_VIEW, 12, "grp_indents"),
    # Parked (rbac_pages.is_active = 0); route and BoardPage still exist. Leaving the
    # row here would put it back on the menu at the next seed.
    # ("ind_board", "/indents/board", "Status Board", "columns", P.INDENT_VIEW, 13, "grp_indents"),
    ("ind_deliveries", "/indents/deliveries", "My Deliveries", "package-check", P.INDENT_VIEW, 13, "grp_indents"),
    # Parked (rbac_pages.is_active = 0); route and the page still exist. Leaving the
    # row here would put it back on the menu at the next seed.
    # ("ind_ack", "/indents/acknowledgments", "Acknowledgments", "check-circle", P.INDENT_VIEW, 14, "grp_indents"),
    ("ind_reports", "/indents/reports", "Activity Ledger", "bar-chart", P.INDENT_VIEW, 15, "grp_indents"),
    ("ind_notifications", "/indents/notifications", "Notifications", "bell", P.INDENT_VIEW, 16, "grp_indents"),

    ("approvals", "/approvals", "Approvals", "check-circle", P.INDENT_VIEW, 20, None),
    ("approval_waiting", "/approvals", "Waiting for Me", "check-circle", P.INDENT_VIEW, 21, "approvals"),
    ("approval_decisions", "/approvals/decisions", "My Decisions", "history", P.INDENT_VIEW, 22, "approvals"),
    ("approval_team", "/approvals/team-queue", "Team Queue", "users", P.INDENT_VIEW, 23, "approvals"),
    # Delegations is gone: the approvals module does not expose it, and the route now
    # redirects to the inbox. Existing wf_delegations rows are left as history.

    ("grp_purchasing", "/pos", "Purchasing", "shopping-cart", P.PO_VIEW, 30, None),
    ("po_list", "/pos", "Purchase Orders", "shopping-cart", P.PO_VIEW, 31, "grp_purchasing"),

    # Every working screen is its own menu entry. A single "Transactions" entry that
    # hid six screens behind in-page tabs meant nobody could reach a screen from the
    # rail, bookmark it, or be denied access to it individually. These live here and
    # not in AppLayout because the rail is built from rbac_pages — a hardcoded branch
    # is invisible to page-access control.
    # Ordered the way the floor works: goods in (inward -> receipt -> QC -> put-away),
    # then goods out (picklist -> issue -> dispatch), then returns.
    ("grp_warehouse", "/warehouse", "Warehouse", "truck", P.STOCK_VIEW, 40, None),
    ("wh_dashboard", "/warehouse", "Dashboard", "layout-dashboard",
     P.STOCK_VIEW, 41, "grp_warehouse"),
    ("wh_inward", "/warehouse/material-inward", "Material Inward", "truck",
     P.RECEIPT_VIEW, 42, "grp_warehouse"),
    ("wh_grn", "/warehouse/grn", "Goods Receipt", "file-text",
     P.RECEIPT_VIEW, 43, "grp_warehouse"),
    ("wh_qc", "/warehouse/quality-inspection", "Quality Inspection", "check-circle",
     P.INSPECTION_VIEW, 44, "grp_warehouse"),
    ("wh_putaway", "/warehouse/putaway", "Put-away", "package",
     P.PUTAWAY_VIEW, 45, "grp_warehouse"),
    ("wh_picklist", "/warehouse/picklist", "Picklists", "list-checks",
     P.PICKING_VIEW, 46, "grp_warehouse"),
    ("wh_issues", "/warehouse/material-issues", "Material Issues", "send",
     P.ISSUE_VIEW, 47, "grp_warehouse"),
    ("wh_consignments", "/warehouse/dispatch/consignments", "Consignments", "boxes",
     P.DISPATCH_VIEW, 48, "grp_warehouse"),
    ("wh_dispatch", "/warehouse/dispatch", "Dispatch", "truck",
     P.DISPATCH_VIEW, 49, "grp_warehouse"),
    ("wh_returns", "/warehouse/purchase-returns", "Purchase Returns", "rotate-ccw",
     P.RETURN_VIEW, 50, "grp_warehouse"),
    ("wh_notifications", "/warehouse/notifications", "Notifications", "bell",
     P.STOCK_VIEW, 51, "grp_warehouse"),
    ("wh_reports", "/warehouse/reports", "Reports", "bar-chart",
     P.WAREHOUSE_REPORT_VIEW, 52, "grp_warehouse"),
    ("wh_masters", "/warehouse/masters", "Warehouse Masters", "settings",
     P.MASTER_LOCATION_MANAGE, 53, "grp_warehouse"),

    ("grp_inventory", "/inventory", "Inventory", "package",
     P.STOCK_VIEW, 50, None),
    ("inv_overview", "/inventory", "Overview", "layout-dashboard",
     P.STOCK_VIEW, 51, "grp_inventory"),
    ("inv_balance", "/inventory/stock-balance", "Stock Balance", "boxes",
     P.STOCK_VIEW, 52, "grp_inventory"),
    ("inv_ledger", "/inventory/ledger", "Stock Ledger", "history",
     P.STOCK_VIEW, 53, "grp_inventory"),
    ("inv_replenishment", "/inventory/replenishment", "Replenishment", "refresh-cw",
     P.STOCK_VIEW, 54, "grp_inventory"),
    ("inv_transfers", "/inventory/transfers", "Transfers", "arrow-left-right",
     P.STOCK_ADJUST, 55, "grp_inventory"),
    ("inv_fulfillment", "/inventory/fulfillment", "Fulfilment Queue", "check-circle",
     P.STOCK_RESERVE, 56, "grp_inventory"),
    ("inv_allocation_approvals", "/inventory/allocation-approvals",
     "Allocation Approvals", "badge-check",
     P.ALLOCATION_APPROVE, 57, "grp_inventory"),
    ("inv_stocking_points", "/inventory/stocking-points", "Stocking Points", "map-pin",
     P.STOCK_POINTS_MANAGE, 58, "grp_inventory"),
    # Parked, not deleted: Demand by Item, Adjustments and Valuation & Ageing are
    # off the menu (rbac_pages.is_active = 0) until they are implemented properly.
    # seed_pages sets is_active = True for everything in PAGE_TREE, so leaving the
    # rows here would put the screens back on the rail at the next seed. The routes
    # and page code are still in the frontend — restore a row here to bring one back.
    # ("inv_demand", "/inventory/demand", "Demand by Item", "boxes",
    #  P.ALLOCATION_VIEW, 58, "grp_inventory"),
    ("inv_mr", "/inventory/material-requests", "Material Requests", "file-text",
     P.MR_VIEW, 59, "grp_inventory"),
    # ("inv_adjustments", "/inventory/adjustments", "Adjustments", "sliders",
    #  P.STOCK_ADJUST, 60, "grp_inventory"),
    # ("inv_valuation", "/inventory/valuation", "Valuation & Ageing", "indian-rupee",
    #  P.STOCK_VALUATION_VIEW, 63, "grp_inventory"),
    ("inv_labels", "/inventory/labels", "Labels & Printing", "printer",
     P.STOCK_VIEW, 64, "grp_inventory"),

    ("masters", "/masters", "Masters", "database", P.MASTER_ITEM_MANAGE, 60, None),

    # Reports: read-only ledgers over the other modules. One screen serves all four,
    # so the child rows differ only by the :ledger segment in the path.
    ("grp_reports", "/reports/indents", "Reports", "bar-chart", P.REPORT_VIEW, 70, None),
    ("rep_indents", "/reports/indents", "Indent Ledger", "file-text",
     P.REPORT_VIEW, 71, "grp_reports"),
    ("rep_approvals", "/reports/approvals", "Approval Ledger", "check-circle",
     P.REPORT_VIEW, 72, "grp_reports"),
    ("rep_inventory", "/reports/inventory", "Stock Ledger", "boxes",
     P.REPORT_VIEW, 73, "grp_reports"),
    ("rep_warehouse", "/reports/warehouse", "Warehouse Ledger", "truck",
     P.REPORT_VIEW, 74, "grp_reports"),

    ("grp_rbac", "/rbac/access", "RBAC", "shield", P.ADMIN_ROLES_MANAGE, 80, None),
    ("rbac_access", "/rbac/access", "Roles & Access", "shield",
     P.ADMIN_ROLES_MANAGE, 81, "grp_rbac"),
    ("rbac_groups", "/rbac/groups", "User Groups", "users",
     P.ADMIN_GROUPS_MANAGE, 82, "grp_rbac"),

    ("grp_settings", "/admin", "Settings", "settings", P.ADMIN_ROLES_MANAGE, 90, None),
    ("admin", "/admin", "HCM & Config", "settings", P.ADMIN_ROLES_MANAGE, 91, "grp_settings"),
    ("admin_settings", "/admin/settings", "Company Settings", "settings",
     P.ADMIN_SETTINGS_MANAGE, 92, "grp_settings"),
    ("admin_rules", "/admin/rules", "Rules Engine", "git-branch",
     P.ADMIN_RULES_MANAGE, 96, "grp_settings"),
    ("admin_workflows", "/admin/workflows", "Approval Workflows", "route",
     P.ADMIN_WORKFLOW_MANAGE, 94, "grp_settings"),
    # The per-project approval ladder: which position LEVELS approve, for one project
    # and one document type. See platform/workflow/ladder.py.
    ("admin_approvals_config", "/admin/approvals-config", "Approvals Config",
     "list-ordered", P.ADMIN_WORKFLOW_MANAGE, 95, "grp_settings"),
    ("admin_policies", "/admin/policies", "Approval & Automation", "sparkles",
     P.ADMIN_WORKFLOW_MANAGE, 93, "grp_settings"),
    ("admin_numbering", "/admin/numbering", "Document Numbering", "hash",
     P.ADMIN_NUMBERING_MANAGE, 97, "grp_settings"),
    ("admin_notifications", "/admin/notifications", "Notifications", "bell",
     P.ADMIN_NOTIFICATIONS_MANAGE, 98, "grp_settings"),
    ("admin_audit", "/admin/audit", "Audit Log", "scroll-text",
     P.ADMIN_AUDIT_VIEW, 99, "grp_settings"),
    ("admin_fallback", "/admin/fallback-log", "Fallback Log", "shield",
     P.ADMIN_AUDIT_VIEW, 100, "grp_settings"),
    ("admin_app_logs", "/admin/app-logs", "App Logs", "bug",
     P.ADMIN_AUDIT_VIEW, 101, "grp_settings"),
]


async def get_or_create(db, model, defaults=None, **filters):
    row = (await db.execute(select(model).filter_by(**filters))).scalar_one_or_none()
    if row:
        return row, False
    row = model(**filters, **(defaults or {}))
    db.add(row)
    await db.flush()
    return row, True


async def seed_permissions(db):
    for p in P.ALL_PERMISSIONS:
        await get_or_create(db, Permission, defaults={
            "module": p.module, "resource": p.resource, "action": p.action,
            "description": p.description}, code=p.code)


async def seed_roles(db):
    roles = {}
    for code, perm_codes in ROLE_PERMS.items():
        role, _ = await get_or_create(db, Role, defaults={
            "name": code.title(), "is_system": code == RoleCode.ADMIN.value,
            "is_active": True}, code=code)
        roles[code] = role
        for pc in perm_codes:
            perm = (await db.execute(select(Permission).where(Permission.code == pc))).scalar_one()
            await get_or_create(db, RolePermission, role_id=role.id, permission_id=perm.id)
    return roles


async def seed_pages(db, *, prune: bool = False):
    """Upsert every page in PAGE_TREE. Deletes nothing unless `prune` is asked for.

    Pruning is opt-in because the delete is only correct when PAGE_TREE is newer than
    the database. When it is older — anyone running the seed from a branch behind main —
    the same delete removes live screens, which is exactly what happened on 2026-07-29.
    """
    # upsert every page (update fields if it already exists), then wire parents
    code_to_id = {}
    for code, path, name, icon, perm, order, _parent in PAGE_TREE:
        page, _ = await get_or_create(db, Page, defaults={"path": path, "name": name},
                                      code=code)
        page.path = path
        page.name = name
        page.icon = icon
        # The column is `required_permission`. Assigning `required_permission_code`
        # here silently set a plain Python attribute, so no page ever got its
        # permission and every menu entry was visible to everyone.
        page.required_permission = perm
        page.sort_order = order
        page.is_active = True
        await db.flush()
        code_to_id[code] = page.id

    for code, _p, _n, _i, _pm, _o, parent in PAGE_TREE:
        page = await db.get(Page, code_to_id[code])
        page.parent_id = code_to_id[parent] if parent else None
    await db.flush()

    # Prune pages no longer in the tree (e.g. the old flat menu). Opt-in: see above.
    valid = {c for c, *_ in PAGE_TREE}
    stale = (await db.execute(select(Page).where(Page.code.notin_(valid)))).scalars().all()
    if not stale:
        return
    if not prune:
        print("  %d page(s) in the database are not in PAGE_TREE and were LEFT ALONE: %s"
              % (len(stale), ", ".join(sorted(p.code for p in stale))))
        print("  If they really are dead, re-run with --prune. If they are newer than "
              "this branch, pull first — do not prune.")
        return
    for p in stale:
        await db.delete(p)
    await db.flush()
    print("  pruned %d page(s): %s"
          % (len(stale), ", ".join(sorted(p.code for p in stale))))


async def seed_org(db):
    for lvl, name in [(1, "Level-1"), (2, "Level-2"), (3, "Level-3")]:
        await get_or_create(db, HcmPositionLevel, defaults={
            "name": name, "level_order": lvl, "synced_at": utcnow()}, id=lvl)
    positions = [
        (POS_PLANT_HEAD, "Plant Head", 1, None),
        (POS_PROC_HEAD, "Procurement Head", 2, POS_PLANT_HEAD),
        (POS_STORE_MGR, "Store Manager", 2, POS_PLANT_HEAD),
        (POS_DEPT_HEAD, "Dept Head - Mechanical", 2, POS_PLANT_HEAD),
    ]
    for pid, name, level, parent in positions:
        await get_or_create(db, HcmPosition, defaults={
            "name": name, "level_id": level, "parent_position_id": parent,
            "is_active": True, "synced_at": utcnow()}, id=pid)

    await get_or_create(db, HcmOffice, defaults={
        "name": "Main Plant", "office_type": "HEAD OFFICE", "is_active": True,
        "synced_at": utcnow()}, id=OFFICE_ID)
    await get_or_create(db, HcmFacility, defaults={
        "name": "Main Store", "office_id": OFFICE_ID, "is_stock_location": True,
        "is_active": True, "synced_at": utcnow()}, id=FACILITY_ID)

    depts = [(DEPT_MECH, "Mechanical", 3), (DEPT_ELEC, "Electrical", None),
             (DEPT_CIVIL, "Civil", None), (DEPT_STORES, "Stores", 5)]
    for did, name, head in depts:
        await get_or_create(db, HcmDepartment, defaults={
            "name": name, "office_id": OFFICE_ID, "head_employee_id": head,
            "is_active": True, "synced_at": utcnow()}, id=did)


async def seed_users(db, roles):
    created = []
    for username, emp_id, name, role_code, dept_id, position_id in USERS:
        await get_or_create(db, HcmEmployee, defaults={
            "full_name": name, "emp_code": f"HR-EMP-{emp_id:05d}",
            "email": f"{username}@bhspl.in", "department_id": dept_id,
            "office_id": OFFICE_ID,
            "is_active": True, "synced_at": utcnow()}, id=emp_id)
        credential = await db.get(UserCredential, emp_id)
        temporary_password = None
        if credential is None:
            temporary_password = secrets.token_urlsafe(12)
            db.add(UserCredential(
                employee_id=emp_id,
                password_hash=hash_password(temporary_password),
                must_change=True,
            ))
        await get_or_create(db, UserRole, employee_id=emp_id, role_id=roles[role_code].id)
        if position_id:
            await get_or_create(db, HcmPositionAssignment, defaults={
                "employee_id": emp_id, "position_id": position_id,
                "department_id": dept_id, "is_active": True, "synced_at": utcnow()},
                id=position_id)  # 1:1 with the position for the demo
        created.append((username, role_code, name, temporary_password))
    return created


async def seed_masters(db):
    # uom_class is required: an unclassified unit disappears from every
    # class-filtered dropdown, and the item form filters by class.
    uoms = [("NOS", "Numbers", "COUNT"), ("SET", "Set", "COUNT"),
            ("KG", "Kilogram", "WEIGHT"), ("TON", "Tonne", "WEIGHT"),
            ("LTR", "Litre", "VOLUME"), ("MTR", "Metre", "LENGTH"),
            ("CEL", "Celsius", "TEMPERATURE"),
            ("BOX", "Box", "PACKAGING"), ("PKT", "Packet", "PACKAGING"),
            ("TRAY", "Tray", "PACKAGING"), ("CONT", "Container", "PACKAGING")]
    uom_rows = {}
    for code, name, uom_class in uoms:
        row, _ = await get_or_create(db, Uom, defaults={
            "name": name, "uom_class": uom_class, "is_active": True}, code=code)
        row.code = code
        row.name = name
        row.uom_class = uom_class
        row.is_active = True
        uom_rows[code] = row

    cats = [("FAST", "Fasteners"), ("ELEC", "Electrical"), ("CONS", "Consumables"),
            ("TOOL", "Tools")]
    cat_rows = {}
    for code, name in cats:
        row, _ = await get_or_create(db, ItemCategory, defaults={"name": name, "is_active": True}, code=code)
        cat_rows[code] = row

    catalog = [
        ("Hex Bolt M8", "FAST", "NOS"), ("Hex Nut M8", "FAST", "NOS"),
        ("Washer M8", "FAST", "NOS"), ("Anchor Bolt", "FAST", "NOS"),
        ("Copper Wire 2.5mm", "ELEC", "MTR"), ("MCB 16A", "ELEC", "NOS"),
        ("LED Tube 20W", "ELEC", "NOS"), ("Switch Socket", "ELEC", "NOS"),
        ("Cable Tie", "ELEC", "PKT"), ("Cotton Waste", "CONS", "KG"),
        ("Grease", "CONS", "KG"), ("Lubricant Oil", "CONS", "LTR"),
        ("Welding Rod", "CONS", "BOX"), ("Cleaning Cloth", "CONS", "PKT"),
        ("Safety Gloves", "CONS", "SET"), ("Spanner Set", "TOOL", "SET"),
        ("Screwdriver Set", "TOOL", "SET"), ("Drill Bit 10mm", "TOOL", "NOS"),
        ("Measuring Tape", "TOOL", "NOS"), ("Hammer 1kg", "TOOL", "NOS"),
    ]
    for i, (name, cat, uom) in enumerate(catalog, start=1):
        await get_or_create(db, Item, defaults={
            "name": name, "category_id": cat_rows[cat].id, "category_name": cat_rows[cat].name,
            "uom_id": uom_rows[uom].id, "uom_code": uom,
            "is_active": True}, code=f"IT-{i:04d}")

    for i in range(1, 6):
        await get_or_create(db, Vendor, defaults={
            "name": f"Vendor {i} Supplies Pvt Ltd", "contact_person": f"Contact {i}",
            "phone": f"90000000{i:02d}", "email": f"vendor{i}@example.com",
            "city": "Vijayawada", "state": "Andhra Pradesh",
            "gstin": f"37ABCDE{i:04d}Z1", "is_active": True}, code=f"VEN-{i:03d}")

    return uom_rows


async def seed_hsn_codes(db):
    """Seed a practical starter HSN list.

    The live item import already had HSN snapshots on most rows. Those codes are
    included here so a reseed creates master rows the imported items can point at;
    rates stay at zero until finance verifies the current GST notification.
    """
    hsn_codes = [
        ("00000000", "Pending HSN classification - verify before purchase"),
        ("28539010", "Purified or distilled water"),
        ("30049099", "Medicaments, other"),
        ("30059010", "Absorbent cotton and medical dressings"),
        ("38089490", "Disinfectants"),
        ("38221990", "Diagnostic or laboratory reagents"),
        ("70179010", "Laboratory glassware"),
        ("84185000", "Refrigerating or freezing equipment"),
        ("84211990", "Centrifuges and filtering machinery"),
        ("84433210", "Printers"),
        ("85176290", "Network routers and communication equipment"),
        ("85235200", "Smart cards and SIM cards"),
        ("85444299", "Insulated electric cables with connectors"),
        ("90118000", "Microscopes"),
        ("90183200", "Tubular metal needles"),
        ("90183990", "Medical tubes and similar instruments"),
        ("90189099", "Other medical instruments"),
        ("90278090", "Other instruments for physical or chemical analysis"),
        ("91069000", "Time-recording and timing apparatus"),
        ("96082000", "Felt-tipped and porous-tipped pens and markers"),
    ]
    for code, description in hsn_codes:
        row, _ = await get_or_create(db, HsnCode, defaults={
            "description": description, "cgst_rate": 0, "sgst_rate": 0,
            "igst_rate": 0, "cess_rate": 0, "is_active": True}, code=code)
        row.description = row.description or description
        row.is_active = True


async def _ensure_workflow(db, code, name, doc_type, stages):
    wf = (await db.execute(select(Workflow).where(Workflow.code == code))).scalar_one_or_none()
    if wf:
        return wf
    wf = Workflow(
        code=code, name=name, doc_type=doc_type, is_active=True,
        effective_from=utcnow().date(),
    )
    db.add(wf)
    await db.flush()
    for s in stages:
        stage = Stage(workflow_id=wf.id, sequence=s["seq"], name=s["name"],
                      approver_type=s["approver_type"], approval_mode=s.get("mode", ApprovalMode.ANY_ONE.value),
                      position_id=s.get("position_id"), role_id=s.get("role_id"),
                      employee_id=s.get("employee_id"), sla_hours=s.get("sla_hours"))
        db.add(stage)
        await db.flush()
        for field, op, value in s.get("conditions", []):
            db.add(StageCondition(
                stage_id=stage.id, field_name=field, operator=op,
                field_value=str(value),
            ))
    return wf


async def seed_workflows(db, roles):
    await _ensure_workflow(db, "WF-INDENT", "Indent Approval", DocType.INDENT.value, [
        {"seq": 1, "name": "Reporting Manager",
         "approver_type": ApproverType.REPORTING_MANAGER.value, "sla_hours": 24},
    ])
    await _ensure_workflow(db, "WF-PO", "PO Approval", DocType.PO.value, [
        {"seq": 1, "name": "Procurement Head", "approver_type": ApproverType.POSITION.value,
         "position_id": POS_PROC_HEAD, "sla_hours": 24},
        {"seq": 2, "name": "Plant Head", "approver_type": ApproverType.POSITION.value,
         "position_id": POS_PLANT_HEAD, "mode": ApprovalMode.ANY_ONE.value, "sla_hours": 48,
         "conditions": [("total_amount", ConditionOperator.GT.value, 500000)]},
    ])
    await _ensure_workflow(db, "WF-GRN", "GRN Approval", DocType.GRN.value, [
        {"seq": 1, "name": "Store Manager", "approver_type": ApproverType.POSITION.value,
         "position_id": POS_STORE_MGR, "sla_hours": 24},
    ])
    await _ensure_workflow(db, "WF-ISSUE", "Issue Approval", DocType.ISSUE.value, [
        {"seq": 1, "name": "Store Manager", "approver_type": ApproverType.POSITION.value,
         "position_id": POS_STORE_MGR, "sla_hours": 24},
    ])


# A database reached over the network is somebody else's. Loopback is the only place
# where "wipe it and put the demo back" is a reasonable default. Deliberately a shape
# check, not a list of our servers: no host belongs in source (project rule 13), and a
# blocklist would miss the next one.
LOOPBACK_HOSTS = {"", "localhost", "127.0.0.1", "::1"}


def _refuse_remote(allow_remote: bool) -> None:
    url = make_url(settings.DATABASE_URL)
    host = (url.host or "").lower()
    if host in LOOPBACK_HOSTS or allow_remote:
        return
    raise SystemExit(
        f"\nRefusing to seed: {url.database!r} on {host} is not a local database.\n\n"
        "This script writes demo users, demo passwords and mock hcm_* rows, and it is\n"
        "meant for a development machine. On 2026-07-29 a run against the shared server\n"
        "deleted 20 live menu pages.\n\n"
        "  To add or repair menu rows on a real server:\n"
        "      python -m scripts.provision_pages\n"
        "  To add the warehouse permissions and menu:\n"
        "      python -m scripts.provision_warehouse\n\n"
        "  If you genuinely mean to seed this database, say so explicitly:\n"
        "      python -m scripts.seed --allow-remote\n")


async def seed(*, allow_remote: bool = False, prune: bool = False):
    if not settings.ALLOW_DEMO_DATA:
        raise SystemExit(
            "Demo seed blocked. Set ALLOW_DEMO_DATA=true only in a development environment."
        )
    _refuse_remote(allow_remote)

    if settings.DATABASE_URL.startswith("sqlite"):
        async with engine.begin() as conn:      # dev convenience; prod uses Alembic
            await conn.run_sync(Base.metadata.create_all)

    async with SessionLocal() as db:
        await seed_permissions(db)
        roles = await seed_roles(db)
        await seed_pages(db, prune=prune)
        await seed_org(db)
        users = await seed_users(db, roles)
        uom_rows = await seed_masters(db)
        await seed_hsn_codes(db)
        await seed_lookup_masters(db, uom_rows)
        await seed_workflows(db, roles)
        await db.commit()

    print("\n  Seed complete. New accounts use unique one-time passwords.\n")
    print("  %-14s %-14s %-28s %s" % (
        "USERNAME", "ROLE", "TEMP PASSWORD", "NAME",
    ))
    print("  " + "-" * 78)
    for username, role_code, name, temporary_password in users:
        password = temporary_password or "(existing credential unchanged)"
        print("  %-14s %-14s %-28s %s" % (
            username, role_code, password, name,
        ))
    print()


# --------------------------------------------------------------------------- #
#  Lookup masters added by the Brands / Classes / Attributes / Price Lists work.
#  Safe to run against a populated database: every row is get_or_create by code.
# --------------------------------------------------------------------------- #
async def seed_lookup_masters(db, uom_rows=None):
    from app.shared.enums import AttributeDataType, CategoryTagType
    from app.shared.models.master import (
        Attribute, Brand, BrandManufacturer, CategoryTag, Feature, ItemClass,
        Manufacturer, Packaging, Spec,
    )
    if uom_rows is None:
        rows = (await db.execute(select(Uom))).scalars().all()
        uom_rows = {row.code: row for row in rows}

    brands = [("3M", "3M", "3M India Ltd"), ("PHIL", "Philips", "Philips India"),
              ("SIEM", "Siemens", "Siemens Healthineers"),
              ("GE", "GE Healthcare", "GE Healthcare India"),
              ("GEN", "Generic", None)]
    for code, name, manufacturer in brands:
        brand, _ = await get_or_create(db, Brand, defaults={
            "name": name, "manufacturer": manufacturer, "is_active": True}, code=code)
        if manufacturer is None:
            continue
        # The brand's manufacturers are real rows now, not a free-text column: the
        # item form reads them to narrow its manufacturer dropdown, and an item
        # cannot be saved against a pair that has no row here.
        maker, _ = await get_or_create(db, Manufacturer, defaults={
            "name": manufacturer, "is_active": True}, code=code)
        await get_or_create(db, BrandManufacturer, defaults={
            "brand_code": brand.code, "brand_name": brand.name,
            "manufacturer_code": maker.code, "manufacturer_name": maker.name,
            "is_active": True}, brand_id=brand.id, manufacturer_id=maker.id)

    # is_capitalised is no longer read by the API — asset-ness is a per-item choice —
    # but the column is NOT NULL in the live table, so it still has to be given.
    classes = [("CONSUMABLE", "Consumable", False), ("CAPITAL", "Capital Asset", True),
               ("SPARE", "Spare Part", False), ("SERVICE", "Service", False),
               ("STATIONERY", "Stationery", False)]
    for code, name, capitalised in classes:
        await get_or_create(db, ItemClass, defaults={
            "name": name, "is_capitalised": capitalised, "is_active": True}, code=code)

    features = [("FRAGILE", "Fragile", True), ("HAZARD", "Hazardous", True),
                ("COLDCHAIN", "Cold chain", True), ("EXPIRY", "Has expiry", True),
                ("SERIALISED", "Serialised", False)]
    for code, name, handling in features:
        await get_or_create(db, Feature, defaults={
            "name": name, "affects_handling": handling, "is_active": True}, code=code)

    # Container TYPES only. How much of what one holds belongs to the item's own
    # chain in mst_item_packaging: a tray of milk and a tray of vials differ.
    packs = [("EACH", "Each"), ("TRAY", "Tray"), ("BOX", "Box"),
             ("CARTON", "Carton"), ("PALLET", "Pallet"), ("CONTAINER", "Container")]
    for code, name in packs:
        await get_or_create(db, Packaging, defaults={
            "name": name, "is_active": True}, code=code)

    # An attribute is a selectable trait. A measurement with a unit is a Spec.
    attributes = [
        ("MATERIAL", "Material", AttributeDataType.LIST.value,
         ["Steel", "Plastic", "Copper", "Aluminium"]),
        ("COLOUR", "Colour", AttributeDataType.LIST.value,
         ["Black", "White", "Red", "Blue"]),
        ("GRADE", "Grade", AttributeDataType.LIST.value, ["A", "B", "C"]),
        ("STERILE", "Sterile", AttributeDataType.BOOLEAN.value, None),
    ]
    attr_rows = {}
    for code, name, data_type, allowed in attributes:
        row, _ = await get_or_create(db, Attribute, defaults={
            "name": name, "data_type": data_type,
            "allowed_values": allowed, "is_active": True}, code=code)
        attr_rows[code] = row

    # A spec always measures something, which is why it carries a real UOM row
    # rather than the free text an attribute's unit used to be.
    specs = [("OP_VOLTAGE", "Operating voltage", "NOS"),
             ("WEIGHT", "Weight", "KG"),
             ("LENGTH", "Length", "MTR"),
             ("CAPACITY", "Capacity", "LTR"),
             ("STORAGE_TEMP", "Storage temperature", "CEL")]
    spec_rows = {}
    for code, name, uom_code in specs:
        uom = uom_rows.get(uom_code)
        row, _ = await get_or_create(db, Spec, defaults={
            "name": name, "uom_id": uom.id if uom else None,
            "uom_code": uom.code if uom else None, "is_active": True}, code=code)
        spec_rows[code] = row

    # What an electrical item is expected to carry. One table for all three kinds:
    # the per-item VALUES go into mst_item_specs.specifications, this only says
    # which fields to ask for and which of them are compulsory.
    electrical = (await db.execute(
        select(ItemCategory).where(ItemCategory.code == "ELEC"))).scalar_one_or_none()
    if electrical is not None:
        tags = [(CategoryTagType.ATTRIBUTE.value, attr_rows["MATERIAL"], False),
                (CategoryTagType.ATTRIBUTE.value, attr_rows["COLOUR"], False),
                (CategoryTagType.SPEC.value, spec_rows["OP_VOLTAGE"], True),
                (CategoryTagType.SPEC.value, spec_rows["WEIGHT"], False),
                (CategoryTagType.FEATURE.value,
                 (await db.execute(select(Feature).where(
                     Feature.code == "FRAGILE"))).scalar_one(), False)]
        for tag_type, target, required in tags:
            await get_or_create(db, CategoryTag, defaults={
                "category_name": electrical.name, "tag_code": target.code,
                "tag_name": target.name,
                "tag_uom_code": getattr(target, "uom_code", None),
                "is_required": required, "is_active": True},
                category_id=electrical.id, tag_type=tag_type, tag_id=target.id)


if __name__ == "__main__":
    asyncio.run(seed(allow_remote="--allow-remote" in sys.argv,
                     prune="--prune" in sys.argv))
