"""Employee authentication and selected-position session context."""
from datetime import timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core import cache
from app.core.config import settings
from app.core.exceptions import (
    AuthenticationError,
    NotFoundError,
    PermissionError_,
    ValidationError,
)
from app.core.security import (
    create_access_token, hash_password_async, verify_password_async,
)
from app.platform.hcm import mappers
from app.platform.hcm.models import (
    HcmDepartment,
    HcmEmployee,
    HcmOffice,
    HcmPosition,
    HcmPositionAssignment,
    HcmPositionLevel,
    HcmSection,
)
from app.platform.rbac import service as rbac_service
from app.platform.settings import service as settings_service
from app.platform.settings.models import UserCredential
from app.shared.enums import AuditAction
from app.shared.models.base import utcnow

#: What every failed sign-in says, whatever actually went wrong behind it.
BAD_CREDENTIALS = (
    "The employee ID or password you entered is incorrect. Please try again."
)


#: What a locked account is told. Unlike BAD_CREDENTIALS this does confirm the account
#: exists — deliberately: by the time it is shown, whoever is typing has already made
#: `LOGIN_MAX_FAILED_ATTEMPTS` failed attempts against it, so it tells an attacker
#: nothing they did not already learn by causing the lockout, and it is the difference
#: between a locked-out storekeeper calling the help desk and one retyping their
#: password for ten minutes.
ACCOUNT_LOCKED = (
    "Too many failed sign-in attempts. This account is locked for {minutes} minutes."
)
#: What the address-level throttle says. No account is named, because at this point
#: none has been looked up.
TOO_MANY_ATTEMPTS = (
    "Too many sign-in attempts from this device. Wait a minute and try again."
)


async def _register_failure(db: AsyncSession, cred: UserCredential) -> None:
    """Count one bad password, and lock the account once there are too many.

    FIXED 2026-09-03. `failed_attempts` and `locked_until` have been columns on
    `sys_user_credentials` since the beginning and NOTHING ever incremented them —
    `change_password` cleared them, which was the only code that touched either. So
    the lockout existed on the screen, in the model and in the admin's mental model,
    and did not exist in fact: password guessing was unlimited against a 300 ms bcrypt
    on an unthrottled endpoint.

    Committed even though the caller is about to raise: a counter that is rolled back
    with the failed request counts nothing.
    """
    cred.failed_attempts = (cred.failed_attempts or 0) + 1
    if cred.failed_attempts >= settings.LOGIN_MAX_FAILED_ATTEMPTS:
        cred.locked_until = utcnow() + timedelta(minutes=settings.LOGIN_LOCKOUT_MINUTES)
        cred.failed_attempts = 0
    await db.commit()


async def authenticate(db: AsyncSession, username: str, password: str,
                       client_ip: str | None = None) -> tuple[HcmEmployee, str]:
    # Per-address throttle, ahead of everything including the employee lookup.
    #
    # Per-account lockout alone does not cover the attack that matters here: one
    # attempt each against a thousand employee ids trips no single account's counter,
    # and every one of those attempts costs a 300 ms bcrypt on the shared event loop.
    # An unmetered login endpoint in front of bcrypt is a denial-of-service button —
    # ~100 requests per second takes the whole application down without a single valid
    # credential. nginx's `limit_req` guards the same door from outside; this one also
    # holds when the API is reached directly.
    if client_ip and not await cache.allow(
            f"login:ip:{client_ip}", settings.LOGIN_RATE_PER_MINUTE):
        raise AuthenticationError(TOO_MANY_ATTEMPTS, code="RATE_LIMITED")

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
    # One sentence for every way a sign-in can fail — no such employee, a retired
    # one, no credential row, a wrong password. Saying which would tell somebody
    # probing the form that an account exists, which is exactly the half of the
    # answer they do not have.
    if not employee or not employee.is_active:
        raise AuthenticationError(BAD_CREDENTIALS, code="INVALID_CREDENTIALS")

    cred = await db.get(UserCredential, employee.id)
    # Checked BEFORE the hash: a locked account must not go on paying for a bcrypt per
    # attempt, or the lockout stops the guessing and not the load it causes.
    if cred is not None and cred.locked_until and cred.locked_until > utcnow():
        raise AuthenticationError(
            ACCOUNT_LOCKED.format(minutes=settings.LOGIN_LOCKOUT_MINUTES),
            code="ACCOUNT_LOCKED")

    if not cred or not await verify_password_async(password, cred.password_hash):
        if cred is not None:
            await _register_failure(db, cred)
        raise AuthenticationError(BAD_CREDENTIALS, code="INVALID_CREDENTIALS")

    cred.last_login_at = utcnow()
    # A sign-in that works is what clears the count — otherwise a user who fumbles
    # their password twice a day is locked out by the end of the week.
    cred.failed_attempts = 0
    cred.locked_until = None
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
    # The employee's own office SAC, read from the mirror. One extra keyed load on a
    # call that already does five queries; an unknown office simply reads as absent.
    office = await db.get(HcmOffice, user.office_id) if user.office_id else None
    return {
        "employee": {"id": user.id, "name": user.full_name,
                     "code": user.emp_code, "email": user.email,
                     "office_id": user.office_id, "office_name": user.office_name,
                     "office_sac": mappers.office_sac(office.raw) if office else None},
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
        # FIXED 2026-08-20 — the company name is served here rather than fetched from
        # /api/settings. That route is gated on `admin.settings.manage`, the permission
        # to EDIT the whole settings screen, so a buyer opening an RFQ, PO or
        # requisition form got a 403 for one string and the Company field rendered
        # "Not configured" and disabled itself — which reads exactly like the setting
        # was never saved. WITHOUT this a buyer can never fill Company on a document.
        #
        # Nothing is exposed that was not already public to a login: the company name
        # is printed on every purchase order, gate pass and print page these same
        # people raise. Carried on /me for the reason `warehouse_label` is — one
        # request, so every screen says the same word at the same moment.
        "company_name": await settings_service.get_setting(db, "company.name", "") or "",
    }


def _position_row(row) -> dict:
    """One (assignment, position, …labels) row flattened for the profile screen.

    The assignment's department/office win over the position's: an assignment is the
    specific posting, the position is the template it was cut from.
    """
    assignment, pos = row[0], row[1]
    return {
        "id": pos.id, "name": pos.name, "code": pos.code,
        "is_primary": assignment.is_primary, "is_active": assignment.is_active,
        "department_id": assignment.department_id or pos.department_id,
        "department_name": row.department_name,
        "office_id": assignment.office_id or pos.office_id,
        "office_name": row.office_name,
        "level_id": pos.level_id, "level_name": row.level_name,
        "role_id": pos.role_id, "role_name": pos.role_name,
        "job_name": pos.job_name,
        "project_id": pos.project_id, "project_name": pos.project_name,
        "parent_position_id": pos.parent_position_id,
        "parent_position_name": row.parent_name,
        "valid_from": assignment.valid_from, "valid_to": assignment.valid_to,
    }


async def set_own_email(db: AsyncSession, user: HcmEmployee, email: str) -> dict:
    """The caller records the address their password-reset link should go to.

    NEW 2026-08-26, and the reason "forgot password" never sent anything: the flow
    finds an account by `hcm_employees.email` (mail/service.request_reset), and HCM
    serves no email at ALL — not on the employees list, not on the detail record, not
    under any key. All 1,933 mirrored employees therefore held NULL, every reset
    request matched nobody, and the route's deliberate unconditional 204 made that
    indistinguishable from a mail that was sent and lost.

    A DELIBERATE, NARROW EXCEPTION to rule 10 (`hcm_*` is written only by sync), taken
    rather than adding a table because the mirror is already built to allow exactly
    this: `mappers.map_employee` OMITS the `email` key when the feed does not carry one
    — see its docstring — and `sync._upsert` writes only the keys it is handed, so an
    address stored here SURVIVES every sync instead of being blanked. If HCM ever does
    start serving emails, its value wins on the next sync, which is the right
    precedence.

    Self only. There is no id parameter and no permission code, for the same reason
    `/profile` and `change-password` have none: the token names the one row this can
    touch. Nobody can set anybody else's address, so nobody can redirect anybody
    else's reset link — which is the whole security question here.
    """
    address = (email or "").strip().lower()
    if not address:
        raise ValidationError("Enter the email address your reset link should go to")

    clash = (await db.execute(
        select(HcmEmployee).where(func.lower(HcmEmployee.email) == address,
                                  HcmEmployee.id != user.id)
    )).scalars().first()
    if clash is not None:
        # `request_reset` takes the FIRST match, so two people sharing an address means
        # one of them silently gets the other's reset mail forever.
        raise ValidationError(
            "That address already belongs to another employee. A reset link can only "
            "be delivered to one account.")

    employee = await db.get(HcmEmployee, user.id)
    if employee is None:
        raise NotFoundError(f"Employee {user.id} not found")
    employee.email = address
    await db.commit()
    return await build_profile(db, employee)


async def build_profile(db: AsyncSession, user: HcmEmployee) -> dict:
    """Everything SCM holds about the caller — their own row, nobody else's.

    No permission code guards this: the subject is always `get_current_user`, so the
    only thing it can ever disclose is the reader to themselves.
    """
    position_id = getattr(user, "active_position_id", None)
    roles = await rbac_service.get_user_roles(db, user.id, position_id)
    permissions = await rbac_service.get_user_permissions(db, user, position_id)
    warehouse_label = await rbac_service.warehouse_menu_label(db, user, position_id)

    office = await db.get(HcmOffice, user.office_id) if user.office_id else None
    section = await db.get(HcmSection, user.section_id) if user.section_id else None
    cred = await db.get(UserCredential, user.id)

    parent = aliased(HcmPosition)
    rows = (await db.execute(
        select(HcmPositionAssignment, HcmPosition, HcmPositionLevel.name.label("level_name"),
               HcmDepartment.name.label("department_name"),
               HcmOffice.name.label("office_name"), parent.name.label("parent_name"))
        .join(HcmPosition, HcmPosition.id == HcmPositionAssignment.position_id)
        .outerjoin(HcmPositionLevel, HcmPositionLevel.id == HcmPosition.level_id)
        .outerjoin(HcmDepartment, HcmDepartment.id == func.coalesce(
            HcmPositionAssignment.department_id, HcmPosition.department_id))
        .outerjoin(HcmOffice, HcmOffice.id == func.coalesce(
            HcmPositionAssignment.office_id, HcmPosition.office_id))
        .outerjoin(parent, parent.id == HcmPosition.parent_position_id)
        .where(HcmPositionAssignment.employee_id == user.id)
        .order_by(HcmPositionAssignment.is_primary.desc(), HcmPosition.name)
    )).all()

    return {
        "id": user.id, "name": user.full_name, "code": user.emp_code,
        "email": user.email, "mobile": user.mobile, "is_active": user.is_active,
        "department_id": user.department_id, "department_name": user.department_name,
        "section_id": user.section_id,
        "section_name": section.name if section else None,
        "office": {"id": office.id, "name": office.name, "code": office.code,
                   "office_type": office.office_type, "address": office.address,
                   "city": office.city, "state": office.state} if office else None,
        "project_id": user.project_id, "project_name": user.project_name,
        "synced_at": user.synced_at,
        "positions": [_position_row(row) for row in rows],
        "active_position_id": position_id,
        "roles": [{"code": r.code, "name": getattr(r, "name", None)} for r in roles],
        "permissions": sorted(permissions),
        "warehouse_label": warehouse_label,
        "account": {
            "last_login_at": cred.last_login_at if cred else None,
            "must_change_password": bool(cred.must_change) if cred else False,
            # A lock that expired is not a lock; only say so while it still bites.
            "is_locked": bool(
                cred and cred.locked_until and cred.locked_until > utcnow()
            ),
            "created_at": cred.created_at if cred else None,
        },
    }


async def switch_position(db: AsyncSession, user: HcmEmployee, position_id: int) -> str:
    position = await rbac_service.get_assigned_position(db, user.id, position_id)
    if position is None:
        raise PermissionError_("That position is not assigned to you")
    return create_access_token(subject=user.id, extra={"position_id": position_id})


MIN_PASSWORD_LENGTH = 8


async def change_password(db: AsyncSession, user: HcmEmployee,
                          current: str, new: str) -> None:
    """Replace the caller's own local login secret.

    No permission code guards this and none should: the subject is always
    `get_current_user`, so the only account it can ever reach is the reader's own.
    An employee with no `sys_local_credentials` row signs in some other way and has
    nothing here to change — that reads as a bad current password, not as an
    invitation to mint one.
    """
    cred = await db.get(UserCredential, user.id)
    if cred is None or not await verify_password_async(current, cred.password_hash):
        raise AuthenticationError("Current password is incorrect")
    if len(new) < MIN_PASSWORD_LENGTH:
        raise ValidationError(
            f"Use at least {MIN_PASSWORD_LENGTH} characters for the new password")
    if await verify_password_async(new, cred.password_hash):
        raise ValidationError("The new password must differ from the current one")

    cred.password_hash = await hash_password_async(new)
    cred.must_change = False
    # A password the owner just proved they know clears the failed-attempt lock;
    # leaving it set would lock them out of the credential they had just replaced.
    cred.failed_attempts = 0
    cred.locked_until = None
    # The hash never enters the audit row — only the fact that it moved.
    await settings_service.write_audit(
        db, entity="sys_local_credentials", action=AuditAction.UPDATE,
        entity_id=user.id, actor=user, entity_no=user.emp_code or str(user.id),
        before={"password": "set"}, after={"password": "changed"},
    )
    await db.commit()
