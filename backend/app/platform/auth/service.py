"""Auth service (canonical schema). Login is by employee code or email; the secret
lives in sys_local_credentials keyed on employee_id. There is no username column.
"""
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import PermissionError_
from app.core.security import create_access_token, verify_password
from app.platform.hcm.models import HcmEmployee
from app.platform.rbac import service as rbac_service
from app.platform.settings.models import UserCredential
from app.shared.models.base import utcnow


async def authenticate(db: AsyncSession, username: str, password: str) -> tuple[HcmEmployee, str]:
    employee = (await db.execute(
        select(HcmEmployee).where(
            or_(HcmEmployee.emp_code == username, HcmEmployee.email == username)
        )
    )).scalars().first()
    if not employee or not employee.is_active:
        raise PermissionError_("Invalid credentials")

    cred = await db.get(UserCredential, employee.id)
    if not cred or not verify_password(password, cred.password_hash):
        raise PermissionError_("Invalid credentials")

    cred.last_login_at = utcnow()
    await db.commit()

    token = create_access_token(subject=employee.id)
    return employee, token


async def build_me(db: AsyncSession, user: HcmEmployee) -> dict:
    roles = await rbac_service.get_user_roles(db, user.id)
    permissions = await rbac_service.get_user_permissions(db, user)
    positions = await rbac_service.get_user_positions(db, user.id)
    menu = await rbac_service.get_user_menu(db, permissions)
    return {
        "employee": {"id": user.id, "name": user.full_name,
                     "code": user.emp_code, "email": user.email},
        "roles": [r.code for r in roles],
        "positions": positions,
        "permissions": sorted(permissions),
        "menu": menu,
    }
