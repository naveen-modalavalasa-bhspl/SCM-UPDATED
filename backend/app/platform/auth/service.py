"""Employee authentication and selected-position session context."""
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AuthenticationError, PermissionError_
from app.core.security import create_access_token, verify_password
from app.platform.hcm.models import HcmEmployee
from app.platform.rbac import service as rbac_service
from app.platform.settings.models import UserCredential
from app.shared.models.base import utcnow

async def authenticate(db: AsyncSession, username: str, password: str) -> tuple[HcmEmployee, str]:
    employee_id = int(username) if username.strip().isdigit() else None
    employee = (await db.execute(
        select(HcmEmployee).where(
            or_(
                HcmEmployee.id == employee_id if employee_id is not None else False,
                HcmEmployee.emp_code == username,
                HcmEmployee.email == username,
            )
        )
    )).scalars().first()
    if not employee or not employee.is_active:
        raise AuthenticationError("Invalid credentials")

    cred = await db.get(UserCredential, employee.id)
    if not cred or not verify_password(password, cred.password_hash):
        raise AuthenticationError("Invalid credentials")

    cred.last_login_at = utcnow()
    await db.commit()

    position = await rbac_service.get_default_position(db, employee.id)
    token = create_access_token(
        subject=employee.id,
        extra={"position_id": position["id"] if position else None},
    )
    return employee, token


async def build_me(db: AsyncSession, user: HcmEmployee) -> dict:
    position_id = getattr(user, "active_position_id", None)
    roles = await rbac_service.get_user_roles(db, user.id, position_id)
    permissions = await rbac_service.get_user_permissions(db, user, position_id)
    positions = await rbac_service.get_user_positions(db, user.id)
    warehouse_label = await rbac_service.warehouse_menu_label(db, user, position_id)
    menu = await rbac_service.get_user_menu(db, permissions, warehouse_label)
    active_position = next((p for p in positions if p["id"] == position_id), None)
    return {
        "employee": {"id": user.id, "name": user.full_name,
                     "code": user.emp_code, "email": user.email,
                     "office_id": user.office_id, "office_name": user.office_name},
        "roles": [r.code for r in roles],
        "positions": positions,
        "active_position": active_position,
        "permissions": sorted(permissions),
        "menu": menu,
        "warehouse_label": warehouse_label,
        # Every page path that exists, granted or not. The client needs both halves
        # to tell "this URL is not a page at all" (/indents/42, a detail screen with
        # no rbac_pages row — always allowed) from "this URL is a page you were not
        # given" (/indents/reports — bounce to Home). With only `menu`, the client
        # cannot distinguish the two and either blocks detail screens or nothing.
        "page_paths": await rbac_service.all_page_paths(db),
    }


async def switch_position(db: AsyncSession, user: HcmEmployee, position_id: int) -> str:
    position = await rbac_service.get_assigned_position(db, user.id, position_id)
    if position is None:
        raise PermissionError_("That position is not assigned to you")
    return create_access_token(subject=user.id, extra={"position_id": position_id})
