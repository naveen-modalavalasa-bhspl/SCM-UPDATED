"""Position-aware RBAC read logic: effective roles, permissions, and menu."""
import re

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.platform.hcm.models import (
    HcmDepartment, HcmOffice, HcmPosition, HcmPositionAssignment,
)
from app.platform.rbac.models import Page, Permission, Role, RolePermission, UserRole
from app.platform.settings.service import write_audit
from app.shared.enums import AuditAction

HCM_ROLE_DESCRIPTION_PREFIX = "HCM role ID: "


def hcm_role_description(role_id: int) -> str:
    return f"{HCM_ROLE_DESCRIPTION_PREFIX}{role_id}"


def hcm_role_code(name: str, role_id: int) -> str:
    code = re.sub(r"[^a-z0-9]+", "_", name.strip().lower()).strip("_")
    return (code or f"hcm_role_{role_id}")[:50]


async def sync_hcm_roles(db: AsyncSession) -> int:
    """Mirror HCM identities into RBAC so page permissions can target them."""
    hcm_rows = (await db.execute(
        select(HcmPosition.role_id, HcmPosition.role_name)
        .where(
            HcmPosition.role_id.isnot(None),
            HcmPosition.role_name.isnot(None),
            HcmPosition.is_active.is_(True),
        )
        .group_by(HcmPosition.role_id, HcmPosition.role_name)
        .order_by(HcmPosition.role_id)
    )).all()
    existing = (await db.execute(select(Role))).scalars().all()
    by_description = {r.description: r for r in existing if r.description}
    used_codes = {r.code.lower() for r in existing}
    added = 0
    for hcm_role_id, name in hcm_rows:
        description = hcm_role_description(hcm_role_id)
        role = by_description.get(description)
        if role is not None:
            role.name = name
            role.is_active = True
            continue
        base = hcm_role_code(name, hcm_role_id)
        code = base
        if code.lower() in used_codes:
            suffix = f"_{hcm_role_id}"
            code = f"{base[:50 - len(suffix)]}{suffix}"
        db.add(Role(code=code, name=name, description=description,
                    is_system=True, is_active=True))
        used_codes.add(code.lower())
        added += 1
    await db.flush()
    return added


async def get_page_access_matrix(db: AsyncSession) -> dict:
    pages = (await db.execute(
        select(Page).where(Page.is_active.is_(True))
        .order_by(Page.sort_order, Page.name)
    )).scalars().all()
    roles = (await db.execute(select(Role).where(Role.is_active.is_(True)).order_by(
        Role.description.startswith(HCM_ROLE_DESCRIPTION_PREFIX).desc(), Role.name,
    ))).scalars().all()
    permission_rows = (await db.execute(
        select(RolePermission.role_id, Permission.code)
        .join(Permission, Permission.id == RolePermission.permission_id)
    )).all()
    held: dict[int, set[str]] = {}
    for role_id, code in permission_rows:
        held.setdefault(role_id, set()).add(code)
    return {
        "pages": [{
            "code": page.code, "name": page.name, "module": page.module,
            "parent_id": page.parent_id,
            "always_on": page.required_permission is None,
            "required_permission": page.required_permission,
        } for page in pages],
        "roles": [{
            "id": role.id, "code": role.code, "name": role.name,
            "source": ("HCM" if (role.description or "").startswith(
                HCM_ROLE_DESCRIPTION_PREFIX) else "SCM"),
            "page_codes": [
                page.code for page in pages
                if page.required_permission is None
                or page.required_permission in held.get(role.id, set())
            ],
        } for role in roles],
    }


async def set_role_page_access(
    db: AsyncSession, role_id: int, page_codes: list[str], actor,
) -> dict:
    role = await db.get(Role, role_id)
    if role is None or not role.is_active:
        raise NotFoundError("Role not found")
    pages = (await db.execute(
        select(Page).where(Page.is_active.is_(True))
    )).scalars().all()
    known_codes = {page.code for page in pages}
    unknown = set(page_codes) - known_codes
    if unknown:
        raise ValidationError(
            f"Unknown page code(s): {', '.join(sorted(unknown))}"
        )

    protected = {
        page.code: page.required_permission
        for page in pages if page.required_permission
    }
    page_permission_codes = set(protected.values())
    permissions = (await db.execute(
        select(Permission).where(Permission.code.in_(page_permission_codes))
    )).scalars().all()
    permission_by_code = {permission.code: permission for permission in permissions}
    missing_permissions = page_permission_codes - set(permission_by_code)
    if missing_permissions:
        raise ValidationError(
            "Page permission configuration is incomplete: "
            + ", ".join(sorted(missing_permissions))
        )

    current_rows = (await db.execute(
        select(RolePermission)
        .join(Permission, Permission.id == RolePermission.permission_id)
        .where(
            RolePermission.role_id == role_id,
            Permission.code.in_(page_permission_codes),
        )
    )).scalars().all()
    current_ids = {row.permission_id for row in current_rows}
    selected_permission_codes = {
        protected[code] for code in page_codes if code in protected
    }
    selected_ids = {
        permission_by_code[code].id for code in selected_permission_codes
    }
    before = sorted(
        page.code for page in pages
        if page.required_permission is None
        or (page.required_permission in {
            code for code, permission in permission_by_code.items()
            if permission.id in current_ids
        })
    )
    for row in current_rows:
        if row.permission_id not in selected_ids:
            await db.delete(row)
    for permission_id in selected_ids - current_ids:
        db.add(RolePermission(role_id=role_id, permission_id=permission_id))

    after = sorted(
        page.code for page in pages
        if page.required_permission is None or page.code in set(page_codes)
    )
    await write_audit(
        db, entity="rbac_role_permissions", entity_id=role_id,
        action=AuditAction.UPDATE, actor=actor,
        before={"page_codes": before}, after={"page_codes": after},
        summary=f"Page access updated for {role.name}",
    )
    await db.commit()
    return {"success": True, "role_id": role_id, "page_codes": after}


async def get_feature_access_matrix(db: AsyncSession) -> dict:
    page_permission_codes = set((await db.execute(
        select(Page.required_permission).where(
            Page.is_active.is_(True), Page.required_permission.isnot(None),
        )
    )).scalars().all())
    stmt = select(Permission)
    if page_permission_codes:
        stmt = stmt.where(Permission.code.notin_(page_permission_codes))
    features = (await db.execute(
        stmt.order_by(Permission.module, Permission.code)
    )).scalars().all()
    roles = (await db.execute(select(Role).where(Role.is_active.is_(True)).order_by(
        Role.description.startswith(HCM_ROLE_DESCRIPTION_PREFIX).desc(), Role.name,
    ))).scalars().all()
    feature_codes = {feature.code for feature in features}
    permission_rows = (await db.execute(
        select(RolePermission.role_id, Permission.code)
        .join(Permission, Permission.id == RolePermission.permission_id)
        .where(Permission.code.in_(feature_codes))
    )).all() if feature_codes else []
    held: dict[int, set[str]] = {}
    for role_id, code in permission_rows:
        held.setdefault(role_id, set()).add(code)
    return {
        "features": [{
            "code": feature.code, "module": feature.module,
            "description": feature.description or feature.code,
        } for feature in features],
        "roles": [{
            "id": role.id, "code": role.code, "name": role.name,
            "source": ("HCM" if (role.description or "").startswith(
                HCM_ROLE_DESCRIPTION_PREFIX) else "SCM"),
            "permission_codes": sorted(held.get(role.id, set())),
        } for role in roles],
    }


async def set_role_feature_access(
    db: AsyncSession, role_id: int, permission_codes: list[str], actor,
) -> dict:
    role = await db.get(Role, role_id)
    if role is None or not role.is_active:
        raise NotFoundError("Role not found")
    page_permission_codes = set((await db.execute(
        select(Page.required_permission).where(
            Page.is_active.is_(True), Page.required_permission.isnot(None),
        )
    )).scalars().all())
    stmt = select(Permission)
    if page_permission_codes:
        stmt = stmt.where(Permission.code.notin_(page_permission_codes))
    features = (await db.execute(stmt)).scalars().all()
    by_code = {feature.code: feature for feature in features}
    unknown = set(permission_codes) - set(by_code)
    if unknown:
        raise ValidationError(
            f"Unknown feature permission(s): {', '.join(sorted(unknown))}"
        )

    current_rows = (await db.execute(
        select(RolePermission)
        .join(Permission, Permission.id == RolePermission.permission_id)
        .where(
            RolePermission.role_id == role_id,
            Permission.code.in_(set(by_code)),
        )
    )).scalars().all() if by_code else []
    current_ids = {row.permission_id for row in current_rows}
    selected_ids = {by_code[code].id for code in permission_codes}
    before = sorted(
        code for code, permission in by_code.items()
        if permission.id in current_ids
    )
    for row in current_rows:
        if row.permission_id not in selected_ids:
            await db.delete(row)
    for permission_id in selected_ids - current_ids:
        db.add(RolePermission(role_id=role_id, permission_id=permission_id))

    after = sorted(set(permission_codes))
    await write_audit(
        db, entity="rbac_role_permissions", entity_id=role_id,
        action=AuditAction.UPDATE, actor=actor,
        before={"feature_permissions": before},
        after={"feature_permissions": after},
        summary=f"Feature access updated for {role.name}",
    )
    await db.commit()
    return {"success": True, "role_id": role_id, "permission_codes": after}


async def get_user_roles(
    db: AsyncSession, employee_id: int, position_id: int | None = None,
) -> list[Role]:
    stmt = (
        select(Role)
        .join(UserRole, UserRole.role_id == Role.id)
        .where(
            UserRole.employee_id == employee_id,
            Role.is_active.is_(True),
        )
    )
    roles = {row.id: row for row in (await db.execute(stmt)).scalars().all()}

    if position_id is not None:
        hcm_role_id = await db.scalar(
            select(HcmPosition.role_id).where(HcmPosition.id == position_id)
        )
        if hcm_role_id is not None:
            hcm_role = (await db.execute(
                select(Role).where(
                    Role.description == hcm_role_description(hcm_role_id),
                    Role.is_active.is_(True),
                )
            )).scalars().first()
            if hcm_role is not None:
                roles[hcm_role.id] = hcm_role

    return sorted(roles.values(), key=lambda row: row.id)


async def get_user_permissions(
    db: AsyncSession, user, position_id: int | None = None,
) -> set[str]:
    roles = await get_user_roles(db, user.id, position_id)
    role_ids = [role.id for role in roles]
    if not role_ids:
        return set()
    stmt = (
        select(Permission.code)
        .join(RolePermission, RolePermission.permission_id == Permission.id)
        .where(RolePermission.role_id.in_(role_ids))
    )
    return set((await db.execute(stmt)).scalars().all())


async def get_user_positions(db: AsyncSession, employee_id: int) -> list[dict]:
    stmt = (
        select(
            HcmPosition.id, HcmPosition.name,
            func.coalesce(
                HcmPositionAssignment.department_id, HcmPosition.department_id,
            ).label("department_id"),
            HcmDepartment.name.label("department_name"),
            func.coalesce(
                HcmPositionAssignment.office_id, HcmPosition.office_id,
            ).label("office_id"),
            HcmOffice.name.label("office_name"),
            HcmPositionAssignment.is_primary,
        )
        .join(HcmPositionAssignment, HcmPositionAssignment.position_id == HcmPosition.id)
        .outerjoin(HcmDepartment, HcmDepartment.id == func.coalesce(
            HcmPositionAssignment.department_id, HcmPosition.department_id,
        ))
        .outerjoin(HcmOffice, HcmOffice.id == func.coalesce(
            HcmPositionAssignment.office_id, HcmPosition.office_id,
        ))
        .where(
            HcmPositionAssignment.employee_id == employee_id,
            HcmPositionAssignment.is_active.is_(True),
        )
        .order_by(HcmPositionAssignment.is_primary.desc(), HcmPosition.name)
    )
    rows = (await db.execute(stmt)).all()
    return [{
        "id": r.id, "name": r.name, "department_id": r.department_id,
        "department_name": r.department_name, "office_id": r.office_id,
        "office_name": r.office_name, "is_primary": r.is_primary,
    } for r in rows]


async def get_assigned_position(
    db: AsyncSession, employee_id: int, position_id: int,
) -> dict | None:
    return next(
        (row for row in await get_user_positions(db, employee_id)
         if row["id"] == position_id),
        None,
    )


async def get_default_position(db: AsyncSession, employee_id: int) -> dict | None:
    positions = await get_user_positions(db, employee_id)
    return positions[0] if positions else None


async def get_user_menu(db: AsyncSession, permissions: set[str]) -> list[dict]:
    """Pages the user may see (required_permission null or held), built into a tree."""
    rows = (await db.execute(
        select(Page).where(Page.is_active.is_(True)).order_by(Page.sort_order)
    )).scalars().all()

    visible = [p for p in rows if not p.required_permission or p.required_permission in permissions]

    def node(p: Page) -> dict:
        return {"code": p.code, "path": p.path, "name": p.name, "icon": p.icon,
                "module": p.module, "show_on_mobile": p.show_on_mobile, "children": []}

    by_id = {p.id: node(p) for p in visible}
    roots: list[dict] = []
    for p in visible:
        n = by_id[p.id]
        if p.parent_id and p.parent_id in by_id:
            by_id[p.parent_id]["children"].append(n)
        else:
            roots.append(n)
    return roots
