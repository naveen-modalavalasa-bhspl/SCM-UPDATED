"""Foundation seed for the canonical scm_rebuild schema. Idempotent.

Seeds: permissions, 5 roles + role_permissions, the grouped menu (rbac_pages),
6 demo employees (hcm_employees) with local credentials (sys_local_credentials) and
role assignments. Enough to log in and load /api/auth/me.

Run:  python -m scripts.seed_foundation
Login with the employee code (e.g. 'admin') and password 'password123'.

NOTE: seeds demo rows into hcm_employees (normally sync-owned) because the app needs
identities to log in before a real HCM sync. Demo ids are 900001+ to avoid clashing
with real HCM ids.
"""
import asyncio

from sqlalchemy import select

from app.core.database import SessionLocal
from app.core.security import hash_password
from app.platform.hcm.models import HcmEmployee
from app.platform.rbac import permissions as P
from app.platform.rbac.models import Page, Permission, Role, RolePermission, UserRole
from app.platform.settings.models import UserCredential
from app.shared.enums import UserRole as RoleCode
from app.shared.models.base import utcnow

PASSWORD = "password123"

ROLE_PERMS = {
    RoleCode.ADMIN.value: P.ALL_CODES,
    RoleCode.REQUESTER.value: [P.INDENT_VIEW, P.INDENT_CREATE, P.INDENT_EDIT, P.INDENT_SUBMIT, P.STOCK_VIEW],
    RoleCode.APPROVER.value: [P.INDENT_VIEW, P.INDENT_APPROVE, P.INDENT_REJECT, P.PO_VIEW, P.PO_APPROVE, P.PO_REJECT, P.STOCK_VIEW],
    RoleCode.PROCUREMENT.value: [P.INDENT_VIEW, P.PO_VIEW, P.PO_CREATE, P.PO_EDIT, P.PO_SUBMIT, P.PO_SEND_VENDOR, P.MASTER_VENDOR_MANAGE, P.MASTER_ITEM_MANAGE, P.STOCK_VIEW],
    RoleCode.STORE.value: [P.GRN_VIEW, P.GRN_CREATE, P.GRN_QC, P.STOCK_VIEW, P.STOCK_ADJUST, P.ISSUE_VIEW, P.ISSUE_CREATE, P.ISSUE_ISSUE],
}

# username(emp_code), employee_id, full name, role
USERS = [
    ("admin", 900001, "System Admin", RoleCode.ADMIN.value),
    ("requester", 900002, "Ravi Requester", RoleCode.REQUESTER.value),
    ("approver", 900003, "Anita Approver", RoleCode.APPROVER.value),
    ("procurement", 900004, "Prakash Procure", RoleCode.PROCUREMENT.value),
    ("store", 900005, "Sunil Store", RoleCode.STORE.value),
    ("planthead", 900006, "Padma Planthead", RoleCode.APPROVER.value),
]

# (code, path, name, icon, required_permission, sort_order, parent_code)
PAGE_TREE = [
    ("home", "/", "Home", "home", None, 0, None),
    ("grp_indents", "/indents/dashboard", "Indents", "file-text", P.INDENT_VIEW, 10, None),
    ("ind_dashboard", "/indents/dashboard", "Dashboard", "layout-dashboard", P.INDENT_VIEW, 11, "grp_indents"),
    ("ind_list", "/indents", "List", "list", P.INDENT_VIEW, 12, "grp_indents"),
    ("ind_board", "/indents/board", "Board", "columns", P.INDENT_VIEW, 13, "grp_indents"),
    ("ind_ack", "/indents/acknowledgments", "Acknowledgments", "check-circle", P.INDENT_VIEW, 14, "grp_indents"),
    ("ind_reports", "/indents/reports", "Reports", "bar-chart", P.INDENT_VIEW, 15, "grp_indents"),
    ("ind_notifications", "/indents/notifications", "Notifications", "bell", P.INDENT_VIEW, 16, "grp_indents"),
    ("approvals", "/approvals", "Approvals", "check-circle", P.INDENT_VIEW, 20, None),
    ("grp_purchasing", "/pos", "Purchasing", "shopping-cart", P.PO_VIEW, 30, None),
    ("po_list", "/pos", "Purchase Orders", "shopping-cart", P.PO_VIEW, 31, "grp_purchasing"),
    ("grp_warehouse", "/stock", "Warehouse", "truck", P.STOCK_VIEW, 40, None),
    ("grn", "/grn", "Goods Receipt", "truck", P.GRN_VIEW, 41, "grp_warehouse"),
    ("stock", "/stock", "Stock", "package", P.STOCK_VIEW, 42, "grp_warehouse"),
    ("issues", "/issues", "Issues", "send", P.ISSUE_VIEW, 43, "grp_warehouse"),
    ("grp_settings", "/admin", "Settings", "settings", P.ADMIN_ROLES_MANAGE, 90, None),
    ("admin", "/admin", "HCM & Config", "settings", P.ADMIN_ROLES_MANAGE, 91, "grp_settings"),
]


async def _get(db, model, **filt):
    return (await db.execute(select(model).filter_by(**filt))).scalar_one_or_none()


async def seed():
    async with SessionLocal() as db:
        # permissions
        perm_by_code = {}
        for p in P.ALL_PERMISSIONS:
            row = await _get(db, Permission, code=p.code)
            if not row:
                row = Permission(code=p.code, module=p.module, resource=p.resource,
                                 action=p.action, description=p.description)
                db.add(row)
                await db.flush()
            perm_by_code[p.code] = row.id

        # roles + role_permissions
        role_by_code = {}
        for code, perm_codes in ROLE_PERMS.items():
            role = await _get(db, Role, code=code)
            if not role:
                role = Role(code=code, name=code.title(),
                            is_system=(code == RoleCode.ADMIN.value), is_active=True)
                db.add(role)
                await db.flush()
            role_by_code[code] = role.id
            for pc in perm_codes:
                pid = perm_by_code[pc]
                if not await _get(db, RolePermission, role_id=role.id, permission_id=pid):
                    db.add(RolePermission(role_id=role.id, permission_id=pid))

        # pages
        code_to_id = {}
        for code, path, name, icon, perm, order, _parent in PAGE_TREE:
            page = await _get(db, Page, code=code)
            if not page:
                page = Page(code=code, path=path, name=name)
                db.add(page)
            page.path, page.name, page.icon = path, name, icon
            page.required_permission, page.sort_order = perm, order
            page.show_on_mobile, page.is_active = True, True
            await db.flush()
            code_to_id[code] = page.id
        for code, *_rest, parent in PAGE_TREE:
            page = await db.get(Page, code_to_id[code])
            page.parent_id = code_to_id[parent] if parent else None

        # employees + credentials + roles
        for emp_code, emp_id, name, role_code in USERS:
            emp = await db.get(HcmEmployee, emp_id)
            if not emp:
                emp = HcmEmployee(id=emp_id, emp_code=emp_code, full_name=name,
                                  email=f"{emp_code}@bhspl.in", is_active=True, synced_at=utcnow())
                db.add(emp)
            else:
                emp.emp_code, emp.full_name, emp.is_active = emp_code, name, True
            await db.flush()
            cred = await db.get(UserCredential, emp_id)
            if not cred:
                db.add(UserCredential(employee_id=emp_id, password_hash=hash_password(PASSWORD)))
            if not await _get(db, UserRole, employee_id=emp_id, role_id=role_by_code[role_code]):
                db.add(UserRole(employee_id=emp_id, role_id=role_by_code[role_code]))

        await db.commit()

    print(f"\n  Foundation seeded into scm_rebuild. Password for all: {PASSWORD}\n")
    print("  %-14s %-14s %s" % ("LOGIN (emp_code)", "ROLE", "NAME"))
    print("  " + "-" * 48)
    for emp_code, _id, name, role in USERS:
        print("  %-14s %-14s %s" % (emp_code, role, name))
    print()


if __name__ == "__main__":
    asyncio.run(seed())
