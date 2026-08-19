"""Employee authentication and selected-position session context."""
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.exceptions import (
    AuthenticationError,
    PermissionError_,
    ValidationError,
)
from app.core.security import create_access_token, hash_password, verify_password
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
    if cred is None or not verify_password(current, cred.password_hash):
        raise AuthenticationError("Current password is incorrect")
    if len(new) < MIN_PASSWORD_LENGTH:
        raise ValidationError(
            f"Use at least {MIN_PASSWORD_LENGTH} characters for the new password")
    if verify_password(new, cred.password_hash):
        raise ValidationError("The new password must differ from the current one")

    cred.password_hash = hash_password(new)
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
