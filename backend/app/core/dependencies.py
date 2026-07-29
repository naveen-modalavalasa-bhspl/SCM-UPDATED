"""Auth dependencies. get_current_user + require_permission.

Identity comes from HCM (hcm_employees), there is no local users table.
Model imports are function-local so this module imports cleanly before the
models package exists (skeleton stage) and to avoid import cycles.
"""
from fastapi import Depends
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.exceptions import AuthenticationError, PermissionError_
from app.core.security import decode_token

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
):
    """Returns the authenticated HcmEmployee, or 401."""
    from app.platform.hcm.models import HcmEmployee

    payload = decode_token(token)
    result = await db.execute(
        select(HcmEmployee).where(HcmEmployee.id == int(payload["sub"]))
    )
    user = result.scalar_one_or_none()
    if not user or not user.is_active:
        raise AuthenticationError("Invalid user")
    from app.platform.rbac.service import get_assigned_position, get_default_position

    position_id = payload.get("position_id")
    position = (
        await get_assigned_position(db, user.id, int(position_id))
        if position_id is not None else await get_default_position(db, user.id)
    )
    if position_id is not None and position is None:
        raise AuthenticationError("Selected position is no longer assigned")
    user.active_position_id = position["id"] if position else None
    return user


def require_permission(code: str):
    """Endpoint guard: 403 unless the user holds the permission code."""
    async def checker(
        user=Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ):
        from app.platform.rbac.service import get_user_permissions

        perms = await get_user_permissions(
            db, user, getattr(user, "active_position_id", None),
        )
        if code not in perms:
            raise PermissionError_(f"Missing permission: {code}")
        return user

    return checker
