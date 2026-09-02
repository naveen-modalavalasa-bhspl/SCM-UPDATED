"""User administration.

There is no users table. Identity is hcm_employees, a read-only mirror, so "creating
a user" means granting an existing employee access to SCM: write a credential row and
assign roles. Nothing here writes back to HCM (rule 10).
"""
import secrets

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
from app.core.security import hash_password
from app.platform.hcm.models import HcmEmployee, HcmPosition, HcmPositionAssignment
from app.platform.rbac.models import Role, UserRole
from app.platform.rbac.profiles import PROFILE_PREFIX
from app.platform.rbac.service import HCM_ROLE_DESCRIPTION_PREFIX
from app.platform.settings.models import UserCredential, UserSession
from app.platform.settings.service import write_audit
from app.shared.enums import AuditAction
from app.shared.models.base import utcnow

TEMP_PASSWORD_BYTES = 9   # ~12 url-safe characters


async def _roles_by_employee(db: AsyncSession, employee_ids: list[int]) -> dict[int, list[dict]]:
    """HCM position roles first, with temporary SCM roles appended."""
    if not employee_ids:
        return {}
    hcm_rows = (await db.execute(
        select(HcmPositionAssignment.employee_id, HcmPosition.role_id,
               HcmPosition.role_name)
        .join(HcmPosition, HcmPosition.id == HcmPositionAssignment.position_id)
        .where(
            HcmPositionAssignment.employee_id.in_(employee_ids),
            HcmPositionAssignment.is_active.is_(True),
            HcmPosition.is_active.is_(True),
            HcmPosition.role_id.isnot(None),
        )
        .order_by(HcmPositionAssignment.is_primary.desc(), HcmPosition.role_name)
    )).all()
    scm_rows = (await db.execute(
        select(UserRole.employee_id, Role.id, Role.code, Role.name)
        .join(Role, Role.id == UserRole.role_id)
        .where(
            UserRole.employee_id.in_(employee_ids),
            or_(Role.description.is_(None),
                ~Role.description.startswith(HCM_ROLE_DESCRIPTION_PREFIX)),
        )
    )).all()
    out: dict[int, list[dict]] = {}
    seen: set[tuple[int, str, int]] = set()
    for employee_id, role_id, name in hcm_rows:
        key = (employee_id, "HCM", role_id)
        if key not in seen:
            out.setdefault(employee_id, []).append({
                "id": role_id, "code": name, "name": name,
                "source": "HCM", "assignable": False,
            })
            seen.add(key)
    for employee_id, role_id, code, name in scm_rows:
        out.setdefault(employee_id, []).append({
            "id": role_id, "code": code, "name": name,
            "source": "SCM", "assignable": True,
        })
    return out


async def _positions_by_employee(db: AsyncSession,
                                 employee_ids: list[int]) -> dict[int, list[dict]]:
    if not employee_ids:
        return {}
    rows = (await db.execute(
        select(HcmPositionAssignment.employee_id, HcmPositionAssignment.position_id,
               HcmPositionAssignment.position_name)
        .where(HcmPositionAssignment.employee_id.in_(employee_ids),
               HcmPositionAssignment.is_active.is_(True))
    )).all()
    out: dict[int, list[dict]] = {}
    for employee_id, position_id, position_name in rows:
        out.setdefault(employee_id, []).append({"id": position_id, "name": position_name})
    return out


async def list_users(db: AsyncSession, params: PageParams, search: str | None = None,
                     with_access: bool | None = None) -> dict:
    """Browse employees and show which of them can sign in.

    with_access=True lists SCM users; False lists employees who could be granted
    access; None lists everyone. The credential table is outer-joined rather than
    queried per row, because there are ~2,800 employees.
    """
    stmt = select(HcmEmployee).where(HcmEmployee.is_active.is_(True))
    if search:
        stmt = stmt.where(or_(HcmEmployee.full_name.ilike(f"%{search}%"),
                              HcmEmployee.emp_code.ilike(f"%{search}%"),
                              HcmEmployee.email.ilike(f"%{search}%")))
    if with_access is True:
        stmt = stmt.where(HcmEmployee.id.in_(select(UserCredential.employee_id)))
    elif with_access is False:
        stmt = stmt.where(HcmEmployee.id.notin_(select(UserCredential.employee_id)))

    page = await paginate(db, stmt.order_by(HcmEmployee.full_name), params)
    employees = page["items"]
    ids = [e.id for e in employees]

    credentials = {
        row.employee_id: row for row in (await db.execute(
            select(UserCredential).where(UserCredential.employee_id.in_(ids))
        )).scalars().all()
    } if ids else {}
    roles = await _roles_by_employee(db, ids)
    positions = await _positions_by_employee(db, ids)

    page["items"] = [{
        "employee_id": e.id,
        "emp_code": e.emp_code,
        "full_name": e.full_name,
        "email": e.email,
        "department_name": e.department_name,
        "has_access": e.id in credentials,
        "locked": bool(credentials[e.id].locked_until) if e.id in credentials else False,
        "last_login_at": (credentials[e.id].last_login_at.isoformat()
                          if e.id in credentials and credentials[e.id].last_login_at
                          else None),
        "roles": roles.get(e.id, []),
        "positions": positions.get(e.id, []),
    } for e in employees]
    return page


async def grant_access(db: AsyncSession, employee_id: int, role_ids: list[int],
                       password: str | None, actor) -> dict:
    """Give an employee a login. Returns a generated password when none was supplied,
    and it is the only time that value is ever readable."""
    employee = await db.get(HcmEmployee, employee_id)
    if employee is None:
        raise NotFoundError("Employee not found")
    if not employee.is_active:
        raise ValidationError("Cannot grant access to an inactive employee")

    generated = None
    if not password:
        generated = secrets.token_urlsafe(TEMP_PASSWORD_BYTES)
        password = generated

    credential = await db.get(UserCredential, employee_id)
    if credential is None:
        credential = UserCredential(employee_id=employee_id,
                                    password_hash=hash_password(password),
                                    must_change=generated is not None)
        db.add(credential)
    else:
        credential.password_hash = hash_password(password)
        credential.must_change = generated is not None
        credential.locked_until = None
        credential.failed_attempts = 0

    await _set_roles(db, employee_id, role_ids, actor)
    await write_audit(db, entity="sys_local_credentials", entity_id=employee_id,
                      action=AuditAction.ACCESS_GRANTED, actor=actor,
                      summary=f"Access granted to {employee.full_name}")
    await db.commit()
    return {"success": True, "employee_id": employee_id,
            "temporary_password": generated}


async def revoke_access(db: AsyncSession, employee_id: int, actor) -> dict:
    """Remove the login and kill every live session, so revocation takes effect now
    rather than whenever the current token happens to expire."""
    credential = await db.get(UserCredential, employee_id)
    if credential is None:
        raise NotFoundError("That employee does not have SCM access")

    await db.delete(credential)
    sessions = (await db.execute(
        select(UserSession).where(UserSession.employee_id == employee_id,
                                  UserSession.revoked_at.is_(None))
    )).scalars().all()
    for session in sessions:
        session.revoked_at = utcnow()

    await write_audit(db, entity="sys_local_credentials", entity_id=employee_id,
                      action=AuditAction.ACCESS_REVOKED, actor=actor,
                      summary=f"Access revoked, {len(sessions)} session(s) ended")
    await db.commit()
    return {"success": True, "employee_id": employee_id,
            "sessions_revoked": len(sessions)}


async def reset_password(db: AsyncSession, employee_id: int, actor) -> dict:
    credential = await db.get(UserCredential, employee_id)
    if credential is None:
        raise NotFoundError("That employee does not have SCM access")
    generated = secrets.token_urlsafe(TEMP_PASSWORD_BYTES)
    credential.password_hash = hash_password(generated)
    credential.must_change = True
    credential.failed_attempts = 0
    credential.locked_until = None
    await write_audit(db, entity="sys_local_credentials", entity_id=employee_id,
                      action=AuditAction.UPDATE, actor=actor,
                      summary="Password reset by administrator")
    await db.commit()
    return {"success": True, "employee_id": employee_id,
            "temporary_password": generated}


async def _set_roles(db: AsyncSession, employee_id: int, role_ids: list[int],
                     actor) -> None:
    valid = set((await db.execute(
        select(Role.id).where(
            Role.id.in_(role_ids), Role.is_active.is_(True),
            or_(Role.description.is_(None),
                ~Role.description.startswith(HCM_ROLE_DESCRIPTION_PREFIX)),
        )
    )).scalars().all()) if role_ids else set()
    missing = set(role_ids or []) - valid
    if missing:
        raise ValidationError(f"Unknown or inactive role id(s): "
                              f"{', '.join(str(m) for m in sorted(missing))}")

    current = (await db.execute(
        select(UserRole).where(UserRole.employee_id == employee_id)
    )).scalars().all()
    for row in current:
        if row.role_id not in valid:
            await db.delete(row)
    held = {row.role_id for row in current}
    for role_id in valid - held:
        db.add(UserRole(employee_id=employee_id, role_id=role_id,
                        assigned_by_id=getattr(actor, "id", None)))
    await db.flush()


async def set_roles(db: AsyncSession, employee_id: int, role_ids: list[int],
                    actor) -> dict:
    if await db.get(HcmEmployee, employee_id) is None:
        raise NotFoundError("Employee not found")
    before = [r["id"] for r in (await _roles_by_employee(db, [employee_id]))
              .get(employee_id, []) if r["source"] == "SCM"]
    await _set_roles(db, employee_id, role_ids, actor)
    await write_audit(db, entity="rbac_user_roles", entity_id=employee_id,
                      action=AuditAction.UPDATE, actor=actor,
                      before={"role_ids": sorted(before)},
                      after={"role_ids": sorted(role_ids or [])})
    await db.commit()
    return {"success": True, "employee_id": employee_id,
            "role_ids": sorted(role_ids or [])}


async def access_summary(db: AsyncSession) -> dict:
    """Counts for the admin dashboard, done in the database rather than by
    fetching 2,800 rows and calling len()."""
    employees = await db.scalar(
        select(func.count()).select_from(HcmEmployee)
        .where(HcmEmployee.is_active.is_(True)))
    with_access = await db.scalar(select(func.count()).select_from(UserCredential))
    # Job-profile rows live in rbac_roles too (profiles.py) and are counted on their
    # own screen. Every other roles reader filters them out (rbac/service.py), so
    # counting them here made this card disagree with the list underneath it.
    roles = await db.scalar(
        select(func.count()).select_from(Role).where(
            Role.is_active.is_(True),
            or_(Role.description.is_(None),
                Role.description.notlike(f"{PROFILE_PREFIX}%")),
        ))
    return {"active_employees": employees or 0,
            "users_with_access": with_access or 0,
            "active_roles": roles or 0}
