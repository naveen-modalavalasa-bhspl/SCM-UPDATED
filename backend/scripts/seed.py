"""Idempotent seed. Safe to run repeatedly:  python -m scripts.seed

Seeds: all permissions, 5 roles, menu pages, a position tree, 4 departments,
one stock facility, 8 UOMs, 20 items, 5 vendors, 6 users (one per role), and one
active approval workflow per doc type (INDENT/PO/GRN/ISSUE) incl. an amount-
conditional Plant Head stage on PO.

NOTE: it also inserts mock hcm_* rows (employees, positions, assignments,
departments, facility, office). Normally only app/platform/hcm/sync.py writes hcm_*,
but HCM's facilities/position-assignments feeds are empty, so the demo needs
bootstrap identity/org data. Real HCM data comes in via the sync job.
"""
import asyncio

from sqlalchemy import select

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
from app.shared.models.master import Item, ItemCategory, Uom, Vendor

PASSWORD = "Bavya@123"

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
    RoleCode.STORE.value: [P.GRN_VIEW, P.GRN_CREATE, P.GRN_QC, P.STOCK_VIEW,
                           P.STOCK_ADJUST, P.ISSUE_VIEW, P.ISSUE_CREATE, P.ISSUE_ISSUE,
                           P.MASTER_LOCATION_MANAGE],
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

    ("grp_indents", "/indents/dashboard", "Material Requests", "file-text", P.INDENT_VIEW, 10, None),
    ("ind_dashboard", "/indents/dashboard", "Overview", "layout-dashboard", P.INDENT_VIEW, 11, "grp_indents"),
    ("ind_list", "/indents", "All Requests", "list", P.INDENT_VIEW, 12, "grp_indents"),
    ("ind_board", "/indents/board", "Status Board", "columns", P.INDENT_VIEW, 13, "grp_indents"),
    ("ind_ack", "/indents/acknowledgments", "Acknowledgments", "check-circle", P.INDENT_VIEW, 14, "grp_indents"),
    ("ind_reports", "/indents/reports", "Activity Ledger", "bar-chart", P.INDENT_VIEW, 15, "grp_indents"),
    ("ind_notifications", "/indents/notifications", "Notifications", "bell", P.INDENT_VIEW, 16, "grp_indents"),

    ("approvals", "/approvals", "Approvals", "check-circle", P.INDENT_VIEW, 20, None),

    ("grp_purchasing", "/pos", "Purchasing", "shopping-cart", P.PO_VIEW, 30, None),
    ("po_list", "/pos", "Purchase Orders", "shopping-cart", P.PO_VIEW, 31, "grp_purchasing"),

    # The warehouse module routes its own sub-pages, so the menu points at its three
    # entry screens. These live here rather than being hardcoded in AppLayout: the
    # left rail is built from rbac_pages, and a hardcoded branch would be invisible
    # to page-access control and would drift the moment somebody renames a screen.
    ("grp_warehouse", "/warehouse", "Warehouse", "truck", P.STOCK_VIEW, 40, None),
    ("wh_dashboard", "/warehouse", "Dashboard", "layout-dashboard",
     P.STOCK_VIEW, 41, "grp_warehouse"),
    ("wh_transactions", "/warehouse/transactions", "Transactions", "boxes",
     P.STOCK_VIEW, 42, "grp_warehouse"),
    ("wh_masters", "/warehouse/masters", "Warehouse Masters", "settings",
     P.MASTER_LOCATION_MANAGE, 43, "grp_warehouse"),

    ("grp_inventory", "/inventory", "Inventory", "package", P.STOCK_VIEW, 45, None),
    ("inv_overview", "/inventory", "Overview", "layout-dashboard",
     P.STOCK_VIEW, 46, "grp_inventory"),
    ("inv_transactions", "/inventory/transactions", "Stock & Transfers", "arrow-left-right",
     P.STOCK_VIEW, 47, "grp_inventory"),

    ("grp_settings", "/admin", "Settings", "settings", P.ADMIN_ROLES_MANAGE, 90, None),
    ("admin", "/admin", "HCM & Config", "settings", P.ADMIN_ROLES_MANAGE, 91, "grp_settings"),
    ("masters", "/masters", "Masters", "database", P.MASTER_ITEM_MANAGE, 92, "grp_settings"),
    ("admin_users", "/admin/users", "Users & Access", "users",
     P.ADMIN_USERS_MANAGE, 93, "grp_settings"),
    ("admin_groups", "/admin/groups", "User Groups", "users",
     P.ADMIN_GROUPS_MANAGE, 94, "grp_settings"),
    ("admin_rules", "/admin/rules", "Rules Engine", "git-branch",
     P.ADMIN_RULES_MANAGE, 95, "grp_settings"),
    ("admin_numbering", "/admin/numbering", "Document Numbering", "hash",
     P.ADMIN_NUMBERING_MANAGE, 96, "grp_settings"),
    ("admin_notifications", "/admin/notifications", "Notifications", "bell",
     P.ADMIN_NOTIFICATIONS_MANAGE, 97, "grp_settings"),
    ("admin_audit", "/admin/audit", "Audit Log", "scroll-text",
     P.ADMIN_AUDIT_VIEW, 98, "grp_settings"),
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


async def seed_pages(db):
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

    # prune pages no longer in the tree (e.g. the old flat menu)
    valid = {c for c, *_ in PAGE_TREE}
    stale = (await db.execute(select(Page).where(Page.code.notin_(valid)))).scalars().all()
    for p in stale:
        await db.delete(p)
    await db.flush()


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
        await get_or_create(db, UserCredential, defaults={
            "password_hash": hash_password(PASSWORD),
            "must_change": False}, employee_id=emp_id)
        await get_or_create(db, UserRole, employee_id=emp_id, role_id=roles[role_code].id)
        if position_id:
            await get_or_create(db, HcmPositionAssignment, defaults={
                "employee_id": emp_id, "position_id": position_id,
                "department_id": dept_id, "is_active": True, "synced_at": utcnow()},
                id=position_id)  # 1:1 with the position for the demo
        created.append((username, role_code, name))
    return created


async def seed_masters(db):
    uoms = [("NOS", "Numbers"), ("KG", "Kilogram"), ("LTR", "Litre"), ("MTR", "Metre"),
            ("TON", "Tonne"), ("BOX", "Box"), ("SET", "Set"), ("PKT", "Packet")]
    uom_rows = {}
    for code, name in uoms:
        row, _ = await get_or_create(db, Uom, defaults={"name": name, "is_active": True}, code=code)
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


async def seed():
    if settings.DATABASE_URL.startswith("sqlite"):
        async with engine.begin() as conn:      # dev convenience; prod uses Alembic
            await conn.run_sync(Base.metadata.create_all)

    async with SessionLocal() as db:
        await seed_permissions(db)
        roles = await seed_roles(db)
        await seed_pages(db)
        await seed_org(db)
        users = await seed_users(db, roles)
        await seed_masters(db)
        await seed_workflows(db, roles)
        await db.commit()

    print("\n  Seed complete. Logins (password for all: %s):\n" % PASSWORD)
    print("  %-14s %-14s %s" % ("USERNAME", "ROLE", "NAME"))
    print("  " + "-" * 46)
    for username, role_code, name in users:
        print("  %-14s %-14s %s" % (username, role_code, name))
    print()


if __name__ == "__main__":
    asyncio.run(seed())


# --------------------------------------------------------------------------- #
#  Lookup masters added by the Brands / Classes / Attributes / Price Lists work.
#  Safe to run against a populated database: every row is get_or_create by code.
# --------------------------------------------------------------------------- #
async def seed_lookup_masters(db):
    from app.shared.enums import AttributeDataType, AttributeTarget
    from app.shared.models.master import (
        Attribute, AttributeMapping, Brand, Feature, ItemClass, Packaging,
    )

    brands = [("3M", "3M", "3M India Ltd"), ("PHIL", "Philips", "Philips India"),
              ("SIEM", "Siemens", "Siemens Healthineers"),
              ("GE", "GE Healthcare", "GE Healthcare India"),
              ("GEN", "Generic", None)]
    for code, name, manufacturer in brands:
        await get_or_create(db, Brand, defaults={
            "name": name, "manufacturer": manufacturer, "is_active": True}, code=code)

    # is_capitalised marks assets, which are not consumed when issued.
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

    uom_nos = (await db.execute(select(Uom).where(Uom.code == "NOS"))).scalar_one_or_none()
    packs = [("EACH", "Each", 1), ("BOX10", "Box of 10", 10),
             ("BOX12", "Box of 12", 12), ("CARTON50", "Carton of 50", 50)]
    for code, name, qty in packs:
        await get_or_create(db, Packaging, defaults={
            "name": name, "qty_per_pack": qty,
            "uom_id": uom_nos.id if uom_nos else None,
            "uom_code": uom_nos.code if uom_nos else None,
            "is_active": True}, code=code)

    attributes = [
        ("VOLTAGE", "Voltage", AttributeDataType.NUMBER.value, "volts", None),
        ("WATTAGE", "Wattage", AttributeDataType.NUMBER.value, "watts", None),
        ("LENGTH", "Length", AttributeDataType.NUMBER.value, "mm", None),
        ("MATERIAL", "Material", AttributeDataType.LIST.value, None,
         ["Steel", "Plastic", "Copper", "Aluminium"]),
        ("COLOUR", "Colour", AttributeDataType.LIST.value, None,
         ["Black", "White", "Red", "Blue"]),
        ("STERILE", "Sterile", AttributeDataType.BOOLEAN.value, None, None),
    ]
    attr_rows = {}
    for code, name, data_type, unit, allowed in attributes:
        row, _ = await get_or_create(db, Attribute, defaults={
            "name": name, "data_type": data_type, "unit": unit,
            "allowed_values": allowed, "is_active": True}, code=code)
        attr_rows[code] = row

    # Which attributes an electrical item should carry. The per-item VALUES go into
    # mst_item_specs.specifications; this only says which fields to ask for.
    electrical = (await db.execute(
        select(ItemCategory).where(ItemCategory.code == "ELEC"))).scalar_one_or_none()
    if electrical is not None:
        for order, code in enumerate(("VOLTAGE", "WATTAGE", "MATERIAL")):
            attribute = attr_rows[code]
            await get_or_create(db, AttributeMapping, defaults={
                "attribute_code": attribute.code, "attribute_name": attribute.name,
                "target_name": electrical.name, "is_required": code == "VOLTAGE",
                "sort_order": order, "is_active": True},
                attribute_id=attribute.id,
                target_type=AttributeTarget.CATEGORY.value, target_id=electrical.id)
