"""A local `admin` account that HCM knows nothing about. Idempotent.

Run:  .venv/Scripts/python -m scripts.create_admin_login

Identity in this system is `hcm_employees` — there is no users table — so an
administrator has to exist as an employee row. HCM has no such person and never will,
so the row is minted in a reserved id range ABOVE anything the feed issues (the live
feed tops out around 16k). `scripts.hcm_clean_slate` leaves that range alone, so a
re-prune of the mirror does not take the admin with it.

Holds no position: the ADMIN role is granted directly on `rbac_user_roles`, and the
role is topped up to every permission that exists, so "all access" stays true as new
permission codes are added.
"""
import asyncio

from sqlalchemy import delete, insert, select
from sqlalchemy.dialects.mysql import insert as mysql_insert

from app.core.database import SessionLocal
from app.core.security import hash_password
from app.platform.hcm.models import HcmEmployee
from app.platform.rbac.models import Permission, Role, RolePermission, UserRole
from app.platform.settings.models import UserCredential
from app.shared.models.base import utcnow

ADMIN_ID = 900001          # above the HCM id space on purpose — see the module docstring
ADMIN_CODE = "admin"
ADMIN_PASSWORD = "Bavya@123"


async def main() -> None:
    async with SessionLocal() as db:
        role = (await db.execute(
            select(Role).where(Role.code == "ADMIN")
        )).scalars().first()
        if role is None:
            raise RuntimeError("No ADMIN role in rbac_roles")

        employee = await db.get(HcmEmployee, ADMIN_ID)
        if employee is None:
            employee = HcmEmployee(id=ADMIN_ID, raw={}, synced_at=utcnow())
            db.add(employee)
        employee.emp_code = ADMIN_CODE
        employee.full_name = "Administrator"
        employee.email = None
        employee.is_active = True

        # Every permission, not the 142 the role happened to be seeded with.
        held = set((await db.execute(
            select(RolePermission.permission_id).where(RolePermission.role_id == role.id)
        )).scalars().all())
        missing = [p for p in (await db.execute(
            select(Permission.id)
        )).scalars().all() if p not in held]
        if missing:
            await db.execute(insert(RolePermission), [
                {"role_id": role.id, "permission_id": p} for p in missing
            ])

        await db.execute(
            delete(UserRole).where(UserRole.employee_id == ADMIN_ID)
        )
        await db.execute(mysql_insert(UserRole).values(
            employee_id=ADMIN_ID, role_id=role.id,
        ))

        await db.execute(
            delete(UserCredential).where(UserCredential.employee_id == ADMIN_ID)
        )
        db.add(UserCredential(employee_id=ADMIN_ID,
                              password_hash=hash_password(ADMIN_PASSWORD),
                              must_change=False))
        await db.commit()

        print(f"admin ready: login '{ADMIN_CODE}' / '{ADMIN_PASSWORD}' "
              f"(employee {ADMIN_ID}), role {role.code} with "
              f"{len(held) + len(missing)} permissions (+{len(missing)} added)")


if __name__ == "__main__":
    asyncio.run(main())
