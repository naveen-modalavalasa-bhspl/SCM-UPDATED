from fastapi import APIRouter, Depends, Request
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user
from app.core.throttle import caller_address
from app.platform.auth import bavya_sso, service
from app.platform.auth.schemas import (
    MeOut,
    PasswordChangeIn,
    PositionSwitchIn,
    ProfileEmailIn,
    ProfileOut,
    TokenOut,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login", response_model=TokenOut)
async def login(request: Request, form: OAuth2PasswordRequestForm = Depends(),
                db: AsyncSession = Depends(get_db)):
    _, token = await service.authenticate(db, form.username, form.password,
                                          client_ip=caller_address(request))
    return TokenOut(access_token=token)


@router.post("/bavya-sso", response_model=TokenOut, include_in_schema=False)
async def bavya_sso_sign_in(request: Request, db: AsyncSession = Depends(get_db)):
    """Sign in with a one-time pass from bhsdb.in, body {"ticket": "..."}.

    Answers exactly what /login answers. 401 for a bad, expired or reused pass, 403 when
    the pass names no active, unlocked account, 404 while BAVYA_SSO_PUBLIC_KEY is unset.
    Deliberately not rate-limited. The edge `limit_req` that guards /login
    (frontend/nginx.conf) keys on an address that, behind the host proxy, is the same
    for every caller, so joining it would let a morning login rush lock the Director
    out. The in-app per-address throttle /login has is not needed either: nothing here
    is a bcrypt, and nothing touches the database until the pass's signature has
    checked out. See `bavya_sso.py`.
    """
    token = await bavya_sso.sign_in(db, await bavya_sso.read_ticket(request))
    return TokenOut(access_token=token)


@router.get("/me", response_model=MeOut)
async def me(db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    return await service.build_me(db, user)


@router.get("/profile", response_model=ProfileOut)
async def profile(db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    # No require_permission: the subject is the caller, so there is nothing to gate.
    return await service.build_profile(db, user)


@router.put("/profile/email", response_model=ProfileOut)
async def set_profile_email(body: ProfileEmailIn, db: AsyncSession = Depends(get_db),
                            user=Depends(get_current_user)):
    """Record where this employee's password-reset link should go.

    No permission code, exactly like `/profile` and `change-password`: the subject is
    the token holder and there is no id to pass, so one employee can never set — or
    redirect — another's address. HCM serves no email for anybody, which is why
    "forgot password" silently matched nobody until this existed.
    """
    return await service.set_own_email(db, user, body.email)


@router.post("/switch-position", response_model=TokenOut)
async def switch_position(body: PositionSwitchIn, db: AsyncSession = Depends(get_db),
                          user=Depends(get_current_user)):
    return TokenOut(access_token=await service.switch_position(db, user, body.position_id))


@router.post("/change-password", status_code=204)
async def change_password(body: PasswordChangeIn, db: AsyncSession = Depends(get_db),
                          user=Depends(get_current_user)):
    # No require_permission, same as /profile: the token names the only account this
    # can touch, so there is nothing here for a permission code to scope.
    await service.change_password(db, user, body.current_password, body.new_password)
