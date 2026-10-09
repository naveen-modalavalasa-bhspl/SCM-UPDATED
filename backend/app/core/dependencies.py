"""Auth dependencies. get_current_user + require_permission.

Identity comes from HCM (hcm_employees), there is no local users table.
Model imports are function-local so this module imports cleanly before the
models package exists (skeleton stage) and to avoid import cycles.
"""
from fastapi import Depends, Request
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.exceptions import AuthenticationError, PermissionError_
from app.core.security import decode_token

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


async def get_current_user(
    request: Request,
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
):
    """Returns the authenticated HcmEmployee, or 401."""
    from app.platform.hcm.models import HcmEmployee

    payload = decode_token(token)
    # A vendor-portal token is signed with the same key, so it decodes cleanly here.
    # Without this line its `sub` would be read as an employee id and — where a vendor
    # id happens to match an employee id — hand an outsider that employee's session.
    # Refused before the lookup, not after: there is no internal endpoint a vendor
    # token is ever allowed to reach.
    if payload.get("typ") == "vendor":
        raise AuthenticationError("This token is not valid for the internal API")
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
    request.state.actor_id = user.id
    request.state.actor_name = user.full_name
    return user


async def get_current_vendor(
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
):
    """Returns the authenticated vendor-portal account, or 401.

    The mirror image of `get_current_user`: that one refuses a `typ: "vendor"` token,
    this one accepts nothing else. A vendor holds no RBAC role and no position, so
    there is no `require_permission` counterpart — what a vendor may see is decided
    by filtering every query on the vendor id this returns.
    """
    from app.modules.procurement.models import VendorUser

    payload = decode_token(token)
    if payload.get("typ") != "vendor":
        raise AuthenticationError("Not a supplier-portal token")
    account = (await db.execute(
        select(VendorUser).where(VendorUser.vendor_id == int(payload["sub"]))
    )).scalars().first()
    if account is None or not account.is_active:
        raise AuthenticationError("This supplier account is no longer active")
    return account


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


def require_permission_or(primary: str, alternate: str | tuple[str, ...], in_reach):
    """Endpoint guard: the `primary` code, OR the narrower `alternate` for a document
    `in_reach` allows.

    `primary` is checked first and on its own, so everybody who holds it today passes
    exactly as `require_permission(primary)` let them — nothing about their access
    changes. `alternate` is a scoped grant (a Stock Transfer code over the warehouse's
    QC, say): it only passes when `in_reach(db, request, user)` says this request's
    document is one it covers. `in_reach` lives in the owning module's service, and
    returns True for a route with no document in its path (a list, a create), where the
    service itself narrows what the alternate may see or write.
    `alternate` may be a tuple when more than one scoped grant opens the same read.
    """
    alternates = (alternate,) if isinstance(alternate, str) else tuple(alternate)

    async def checker(
        request: Request,
        user=Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ):
        from app.platform.rbac.service import get_user_permissions

        perms = await get_user_permissions(
            db, user, getattr(user, "active_position_id", None),
        )
        if primary in perms:
            return user
        if any(code in perms for code in alternates) and await in_reach(db, request, user):
            # Said on the request's own session, so the service can narrow what a
            # scoped grant sees (a list, a create) — see `via_scoped_grant`.
            db.info.setdefault(_SCOPED_GRANTS, set()).add(primary)
            return user
        raise PermissionError_(f"Missing permission: {primary}")

    return checker


_SCOPED_GRANTS = "scoped_grants"


def via_scoped_grant(db: AsyncSession, primary: str) -> bool:
    """Did THIS request pass `primary`'s guard only through its scoped alternate?

    Read off the session the guard wrote to, so a service called directly — a test, a
    script, another service — is never narrowed: only a request that came in through
    `require_permission_or` without holding `primary` is."""
    return primary in db.info.get(_SCOPED_GRANTS, ())
