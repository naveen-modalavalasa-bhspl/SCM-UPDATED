"""Foundation seed for the canonical scm_rebuild schema. Idempotent.

Seeds: permissions, 5 roles + role_permissions, the grouped menu (rbac_pages),
6 demo employees (hcm_employees) with local credentials (sys_local_credentials) and
role assignments. Enough to log in and load /api/auth/me.

Run:  ALLOW_DEMO_DATA=true python -m scripts.seed_foundation

NOTE: seeds demo rows into hcm_employees (normally sync-owned) because the app needs
identities to log in before a real HCM sync. Demo ids are 900001+ to avoid clashing
with real HCM ids.
"""
import asyncio
import secrets

from sqlalchemy import select

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.security import hash_password
from app.platform.hcm.models import HcmEmployee
from app.platform.rbac import permissions as P
from app.platform.rbac.models import Page, Permission, Role, RolePermission, UserRole
from app.platform.settings.models import UserCredential
from app.shared.enums import UserRole as RoleCode
from app.shared.models.base import utcnow

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

# The menu has ONE source of truth: scripts/seed.py PAGE_TREE (per CLAUDE.md, that is
# where a module dev adds a screen). Keeping a second copy here silently deleted every
# page the copy had not caught up with — Inventory and the warehouse sub-pages vanished
# from the rail the moment this script ran.
from scripts.seed import PAGE_TREE  # noqa: E402


async def _get(db, model, **filt):
    return (await db.execute(select(model).filter_by(**filt))).scalar_one_or_none()


async def seed():
    if not settings.ALLOW_DEMO_DATA:
        raise SystemExit(
            "Demo seed blocked. Set ALLOW_DEMO_DATA=true only in a development environment."
        )
    created_passwords = {}
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
        valid_page_codes = {code for code, *_rest in PAGE_TREE}
        stale_pages = (await db.execute(
            select(Page).where(Page.code.notin_(valid_page_codes))
        )).scalars().all()
        for page in stale_pages:
            await db.delete(page)
        await db.flush()

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
                temporary_password = secrets.token_urlsafe(12)
                created_passwords[emp_code] = temporary_password
                db.add(UserCredential(
                    employee_id=emp_id,
                    password_hash=hash_password(temporary_password),
                    must_change=True,
                ))
            if not await _get(db, UserRole, employee_id=emp_id, role_id=role_by_code[role_code]):
                db.add(UserRole(employee_id=emp_id, role_id=role_by_code[role_code]))

        await db.commit()

    print("\n  Foundation seeded into scm_rebuild. New accounts use unique one-time passwords.\n")
    print("  %-14s %-14s %-28s %s" % (
        "LOGIN", "ROLE", "TEMP PASSWORD", "NAME",
    ))
    print("  " + "-" * 78)
    for emp_code, _id, name, role in USERS:
        password = created_passwords.get(emp_code, "(existing credential unchanged)")
        print("  %-14s %-14s %-28s %s" % (emp_code, role, password, name))
    print()


if __name__ == "__main__":
    asyncio.run(seed())
