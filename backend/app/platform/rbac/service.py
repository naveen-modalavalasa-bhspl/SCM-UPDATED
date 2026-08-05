"""Position-aware RBAC read logic: effective roles, permissions, and menu."""
import re

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
from app.platform.hcm.models import (
    HcmDepartment, HcmEmployee, HcmOffice, HcmPosition, HcmPositionAssignment,
)
from app.platform.rbac.models import (
    Page, Permission, Role, RolePermission, UserGroup, UserGroupMember, UserRole,
)
from app.platform.settings.models import UserCredential
from app.platform.settings.service import write_audit
from app.platform.rbac.profiles import PROFILE_PREFIX
from app.shared.enums import AuditAction, GroupType

MAX_GROUP_DEPTH = 10

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
    roles = (await db.execute(select(Role).where(
        Role.is_active.is_(True),
        # Job-profile rows live in rbac_roles too (profiles.py). They are granted on
        # their own screen and would only confuse this one, so they stay out of it.
        #
        # The NULL arm is required, not defensive: in SQL `NULL NOT LIKE 'x%'` is
        # NULL, which is not true, so a bare NOT LIKE drops every role with no
        # description — that is ADMIN, REQUESTER, APPROVER, PROCUREMENT and STORE.
        or_(Role.description.is_(None),
            Role.description.notlike(f"{PROFILE_PREFIX}%")),
    ).order_by(
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

    # Derived from the permissions that actually end up granted, NOT from the codes
    # that were asked for. Several pages share one required_permission (indent.view
    # covers twelve), so a request to drop one of them while keeping its siblings
    # cannot be honoured — the permission stays and so does the page. Reporting the
    # request back made the screen look like it had saved when nothing had moved.
    granted = {
        code for code, permission in permission_by_code.items()
        if permission.id in selected_ids
    }
    after = sorted(
        page.code for page in pages
        if page.required_permission is None or page.required_permission in granted
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
    roles = (await db.execute(select(Role).where(
        Role.is_active.is_(True),
        # Job-profile rows live in rbac_roles too (profiles.py). They are granted on
        # their own screen and would only confuse this one, so they stay out of it.
        #
        # The NULL arm is required, not defensive: in SQL `NULL NOT LIKE 'x%'` is
        # NULL, which is not true, so a bare NOT LIKE drops every role with no
        # description — that is ADMIN, REQUESTER, APPROVER, PROCUREMENT and STORE.
        or_(Role.description.is_(None),
            Role.description.notlike(f"{PROFILE_PREFIX}%")),
    ).order_by(
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
        # A job profile REPLACES the position's HCM role rather than adding to it —
        # that replacement is the entire point. HCM role 29 "MANAGER" covers fifteen
        # unrelated jobs, so anything granted to it leaks to all fifteen; the profile
        # ("IVM", "CPO", "LE"...) is the job the person actually does.
        # Until an admin saves a profile there is no profile row, so this falls
        # straight through and resolution is exactly what it was before.
        from app.platform.rbac.profiles import profile_role_for_position

        profile_role = await profile_role_for_position(db, position_id)
        if profile_role is not None:
            # The profile replaces EVERYTHING, including personal rbac_user_roles.
            # Those are grants made to a human on the Users & roles screen, and they
            # used to be unioned in — so emptying a profile changed nothing for anyone
            # who had been handed REQUESTER or STORE when their login was created.
            # A job profile that cannot take access away is not a grant unit, so once
            # a position has one it is the only thing that decides.
            #
            # A login with no position, or a position nobody has configured, still
            # falls through to its personal roles — which is what keeps the
            # position-less System Admin able to configure the profiles.
            return [profile_role]

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
    """Which hat a login starts under.

    Position order (primary first, then name) decides it — except that a position
    granting nothing is never chosen over one that grants something. HCM can flag
    two positions primary at once, and it does: HR-EMP-15450 holds both LAB
    TECHNICIAN and STORE KEEPER as primary, so the name tie-break landed her on the
    LAB TECHNICIAN hat, which carries no roles, and Home said "No modules are
    assigned yet" to a storekeeper with a full queue of work. Whether a hat is
    configured with roles is a fact this function can check, so it does.
    """
    positions = await get_user_positions(db, employee_id)
    if not positions:
        return None
    for position in positions:
        # Permissions, not roles. A position can hold a role that grants nothing —
        # jp_lt is exactly that — and landing on it is indistinguishable from having
        # no access at all. What matters is whether the hat can actually do anything.
        roles = await get_user_roles(db, employee_id, position["id"])
        if not roles:
            continue
        granted = await db.scalar(
            select(func.count())
            .select_from(RolePermission)
            .where(RolePermission.role_id.in_([role.id for role in roles]))
        )
        if granted:
            return position
    # Nothing is configured anywhere — keep the old answer rather than inventing one.
    return positions[0]


async def all_page_paths(db: AsyncSession) -> list[str]:
    """Every active page path, regardless of who may see it.

    Not a permission leak: these are static route strings, the same ones already in
    the compiled bundle. What they buy the client is the ability to route-guard
    precisely instead of by path prefix.
    """
    return sorted({
        path for path in (await db.execute(
            select(Page.path).where(Page.is_active.is_(True))
        )).scalars().all() if path
    })


async def get_user_menu(db: AsyncSession, permissions: set[str]) -> list[dict]:
    """Pages the user may see (required_permission null or held), built into a tree."""
    rows = (await db.execute(
        select(Page).where(Page.is_active.is_(True)).order_by(Page.sort_order)
    )).scalars().all()

    visible_ids = {
        page.id for page in rows
        if not page.required_permission or page.required_permission in permissions
    }
    # A child is meaningful only inside its visible parent. Repeatedly remove pages
    # whose parent is absent so a hidden group can never leak one of its children into
    # the top-level rail, including for deeper-than-one-level trees.
    while True:
        orphan_ids = {
            page.id for page in rows
            if page.id in visible_ids
            and page.parent_id is not None
            and page.parent_id not in visible_ids
        }
        if not orphan_ids:
            break
        visible_ids -= orphan_ids

    # A group whose children are ALL hidden is an empty folder. It used to survive
    # and, because several groups share a path with their first child (grp_indents
    # and ind_dashboard are both /indents/dashboard), clicking it opened a screen
    # that had not been granted. Dropping it is also what makes "untick everything"
    # mean Home and nothing else.
    #
    # Only groups that HAVE children are dropped — a leaf page like Masters has none
    # by design and must stay.
    has_children = {page.parent_id for page in rows if page.parent_id is not None}
    while True:
        empty_groups = {
            page.id for page in rows
            if page.id in visible_ids
            and page.id in has_children
            and not any(other.parent_id == page.id and other.id in visible_ids
                        for other in rows)
        }
        if not empty_groups:
            break
        visible_ids -= empty_groups

    visible = [page for page in rows if page.id in visible_ids]

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


# --------------------------------------------------------------------------- #
#  User directory with a role filter (RBAC-owned)
# --------------------------------------------------------------------------- #
async def _employee_ids_for_role(db: AsyncSession, role_id: int):
    """A subquery of the employees who hold one rbac role.

    An HCM-mirrored role is held through a position; an SCM role through
    rbac_user_roles — the same two sources the roles column is built from — so the
    filter always agrees with what the row shows.
    """
    role = await db.get(Role, role_id)
    if role is None:
        raise NotFoundError("Role not found")
    description = role.description or ""
    if description.startswith(HCM_ROLE_DESCRIPTION_PREFIX):
        hcm_role_id = int(description[len(HCM_ROLE_DESCRIPTION_PREFIX):])
        return (select(HcmPositionAssignment.employee_id)
                .join(HcmPosition, HcmPosition.id == HcmPositionAssignment.position_id)
                .where(HcmPosition.role_id == hcm_role_id,
                       HcmPositionAssignment.is_active.is_(True),
                       HcmPosition.is_active.is_(True)))
    return select(UserRole.employee_id).where(UserRole.role_id == role_id)


async def _roles_by_employee(db: AsyncSession, employee_ids: list[int]) -> dict:
    """HCM position roles first, then assignable SCM roles, keyed by employee id."""
    if not employee_ids:
        return {}
    hcm_rows = (await db.execute(
        select(HcmPositionAssignment.employee_id, HcmPosition.role_id,
               HcmPosition.role_name)
        .join(HcmPosition, HcmPosition.id == HcmPositionAssignment.position_id)
        .where(HcmPositionAssignment.employee_id.in_(employee_ids),
               HcmPositionAssignment.is_active.is_(True),
               HcmPosition.is_active.is_(True),
               HcmPosition.role_id.isnot(None))
        .order_by(HcmPositionAssignment.is_primary.desc(), HcmPosition.role_name)
    )).all()
    scm_rows = (await db.execute(
        select(UserRole.employee_id, Role.id, Role.code, Role.name)
        .join(Role, Role.id == UserRole.role_id)
        .where(UserRole.employee_id.in_(employee_ids),
               or_(Role.description.is_(None),
                   ~Role.description.startswith(HCM_ROLE_DESCRIPTION_PREFIX)))
    )).all()
    out: dict[int, list[dict]] = {}
    seen: set[tuple[int, int]] = set()
    for employee_id, role_id, name in hcm_rows:
        if (employee_id, role_id) not in seen:
            out.setdefault(employee_id, []).append(
                {"id": role_id, "code": name, "name": name,
                 "source": "HCM", "assignable": False})
            seen.add((employee_id, role_id))
    for employee_id, role_id, code, name in scm_rows:
        out.setdefault(employee_id, []).append(
            {"id": role_id, "code": code, "name": name,
             "source": "SCM", "assignable": True})
    return out


async def _positions_by_employee(db: AsyncSession, employee_ids: list[int]) -> dict:
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
                     with_access: bool | None = None, role_id: int | None = None,
                     department: str | None = None,
                     position_id: int | None = None) -> dict:
    """Paginated employee directory for the Roles & Access screen.

    role_id narrows to the holders of one role; department and position_id narrow to a
    department or one exact post; search matches name, code or email; with_access
    filters to those who can (or cannot) sign in. The credential table is read in one
    query rather than per row, because there are ~2,800 employees.

    Department is matched by NAME, not id. HCM carries duplicate department rows under
    the same name — "Warehouse" exists twice — and an employee's department_id points at
    a different one than their position's does, so an id filter silently drops half a
    department.
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
    if role_id is not None:
        stmt = stmt.where(HcmEmployee.id.in_(await _employee_ids_for_role(db, role_id)))
    if department:
        stmt = stmt.where(HcmEmployee.department_name == department)
    if position_id is not None:
        stmt = stmt.where(HcmEmployee.id.in_(
            select(HcmPositionAssignment.employee_id).where(
                HcmPositionAssignment.position_id == position_id,
                HcmPositionAssignment.is_active.is_(True))))

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


async def user_filters(db: AsyncSession, department: str | None = None) -> dict:
    """What the Department and Position dropdowns on the Roles & Access screen offer.

    Counted in MySQL and keyed on the employee, so every option is a filter that
    actually returns somebody — an empty result is never offered.

    Positions narrow to the chosen department. There are 3,729 posts in the mirror and
    only a dozen or so in any one department, which is the difference between a
    dropdown you can read and one you have to search.
    """
    departments = [{"name": row.name, "count": row.count} for row in (await db.execute(
        select(HcmEmployee.department_name.label("name"),
               func.count(HcmEmployee.id).label("count"))
        .where(HcmEmployee.is_active.is_(True),
               HcmEmployee.department_name.isnot(None),
               HcmEmployee.department_name != "")
        .group_by(HcmEmployee.department_name)
        .order_by(HcmEmployee.department_name)
    )).all()]

    stmt = (select(HcmPosition.id, HcmPosition.name,
                   func.count(func.distinct(HcmPositionAssignment.employee_id))
                       .label("count"))
            .select_from(HcmPosition)
            .join(HcmPositionAssignment,
                  HcmPositionAssignment.position_id == HcmPosition.id)
            .join(HcmEmployee, HcmEmployee.id == HcmPositionAssignment.employee_id)
            .where(HcmPosition.is_active.is_(True),
                   HcmPositionAssignment.is_active.is_(True),
                   HcmEmployee.is_active.is_(True))
            .group_by(HcmPosition.id, HcmPosition.name)
            .order_by(HcmPosition.name))
    if department:
        stmt = stmt.where(HcmEmployee.department_name == department)
    positions = [{"id": row.id, "name": row.name, "count": row.count}
                 for row in (await db.execute(stmt)).all()]
    return {"departments": departments, "positions": positions}


# --------------------------------------------------------------------------- #
#  User groups (RBAC-owned tables rbac_user_groups / rbac_user_group_members)
#
#  Membership is derived, never stored: a group states a rule ("everyone with role
#  X", "everyone in region Y") and asking who is in it runs that rule, so an HCM sync
#  that moves people never leaves a stale roster. A sub-group is a LOCATION group with
#  a parent: the parent decides *who*, the child narrows it to *where* (a district /
#  office), and membership is the intersection.
# --------------------------------------------------------------------------- #
def group_out(g: UserGroup) -> dict:
    return {"id": g.id, "code": g.code, "name": g.name, "description": g.description,
            "parent_id": g.parent_id, "group_type": g.group_type, "role_id": g.role_id,
            "position_id": g.position_id, "location_id": g.location_id,
            "is_active": g.is_active}


async def list_groups(db: AsyncSession, params: PageParams,
                      search: str | None = None) -> dict:
    stmt = select(UserGroup)
    if search:
        stmt = stmt.where(UserGroup.name.ilike(f"%{search}%"))
    page = await paginate(db, stmt.order_by(UserGroup.name), params)
    page["items"] = [group_out(g) for g in page["items"]]
    return page


async def list_regions(db: AsyncSession) -> dict:
    """Offices, offered as the 'where' of a LOCATION sub-group (e.g. a district)."""
    rows = (await db.execute(
        select(HcmOffice).where(HcmOffice.is_active.is_(True)).order_by(HcmOffice.name)
    )).scalars().all()
    return {"items": [{"id": o.id, "name": o.name, "city": o.city, "state": o.state}
                      for o in rows]}


async def _reject_group_cycle(db: AsyncSession, group_id: int | None,
                              parent: UserGroup) -> None:
    if group_id is None:
        return
    node, hops = parent, 0
    while node is not None and hops < MAX_GROUP_DEPTH:
        if node.id == group_id:
            raise ValidationError("That parent would create a group loop")
        node = await db.get(UserGroup, node.parent_id) if node.parent_id else None
        hops += 1


async def _validate_group(db: AsyncSession, data, group_id: int | None) -> None:
    if data.group_type not in {t.value for t in GroupType}:
        raise ValidationError(
            f"group_type must be one of {', '.join(t.value for t in GroupType)}")

    required = {
        GroupType.ROLE.value: ("role_id", data.role_id),
        GroupType.HCM_ROLE.value: ("role_id", data.role_id),
        GroupType.POSITION.value: ("position_id", data.position_id),
        GroupType.LOCATION.value: ("location_id", data.location_id),
    }[data.group_type]
    if required[1] is None:
        raise ValidationError(f"A {data.group_type} group needs {required[0]}")

    if data.group_type == GroupType.LOCATION.value and data.parent_id is None:
        raise ValidationError(
            "A LOCATION group is a sub-group and must have a parent group")

    if data.parent_id is not None:
        if data.parent_id == group_id:
            raise ValidationError("A group cannot be its own parent")
        parent = await db.get(UserGroup, data.parent_id)
        if parent is None:
            raise NotFoundError("Parent group not found")
        await _reject_group_cycle(db, group_id, parent)


async def create_group(db: AsyncSession, data, user) -> dict:
    await _validate_group(db, data, None)
    group = UserGroup(**data.model_dump())
    db.add(group)
    await db.commit()
    await db.refresh(group)
    return group_out(group)


async def update_group(db: AsyncSession, group_id: int, data, user) -> dict:
    group = await db.get(UserGroup, group_id)
    if group is None:
        raise NotFoundError("Group not found")
    await _validate_group(db, data, group_id)
    for key, value in data.model_dump().items():
        setattr(group, key, value)
    await db.commit()
    await db.refresh(group)
    return group_out(group)


async def deactivate_group(db: AsyncSession, group_id: int, user) -> dict:
    group = await db.get(UserGroup, group_id)
    if group is None:
        raise NotFoundError("Group not found")
    group.is_active = False
    await db.commit()
    return {"success": True, "id": group_id, "is_active": False}


async def _group_rule_employee_ids(db: AsyncSession, group: UserGroup) -> set[int]:
    """The employees a single group's own rule selects, ignoring its parent."""
    if group.group_type == GroupType.ROLE.value:
        rows = await db.execute(
            select(UserRole.employee_id).where(UserRole.role_id == group.role_id))
        return set(rows.scalars().all())

    if group.group_type == GroupType.POSITION.value:
        rows = await db.execute(
            select(HcmPositionAssignment.employee_id).where(
                HcmPositionAssignment.position_id == group.position_id,
                HcmPositionAssignment.is_active.is_(True)))
        return set(rows.scalars().all())

    if group.group_type == GroupType.HCM_ROLE.value:
        rows = await db.execute(
            select(HcmPositionAssignment.employee_id)
            .join(HcmPosition, HcmPosition.id == HcmPositionAssignment.position_id)
            .where(HcmPosition.role_id == group.role_id,
                   HcmPositionAssignment.is_active.is_(True),
                   HcmPosition.is_active.is_(True)))
        return set(rows.scalars().all())

    # LOCATION: a region/district, resolved straight from the office the employee
    # belongs to. location_id holds the hcm_offices id.
    rows = await db.execute(
        select(HcmEmployee.id).where(HcmEmployee.office_id == group.location_id,
                                     HcmEmployee.is_active.is_(True)))
    return set(rows.scalars().all())


async def resolve_group_member_ids(db: AsyncSession, group_id: int) -> set[int]:
    """Everyone in a group: its own rule, intersected with each ancestor, plus the
    explicit rows. A district sub-group of "Lab Technicians" therefore yields the lab
    technicians in that district, not everyone in the district."""
    group = await db.get(UserGroup, group_id)
    if group is None:
        raise NotFoundError("Group not found")

    members = await _group_rule_employee_ids(db, group)
    node, hops = group, 0
    while node.parent_id is not None and hops < MAX_GROUP_DEPTH:
        parent = await db.get(UserGroup, node.parent_id)
        if parent is None:
            break
        members &= await _group_rule_employee_ids(db, parent)
        node, hops = parent, hops + 1

    explicit = await db.execute(
        select(UserGroupMember.employee_id).where(UserGroupMember.group_id == group_id))
    return members | set(explicit.scalars().all())


async def list_group_members(db: AsyncSession, group_id: int) -> dict:
    ids = await resolve_group_member_ids(db, group_id)
    if not ids:
        return {"items": [], "total": 0}
    rows = (await db.execute(
        select(HcmEmployee).where(HcmEmployee.id.in_(ids)).order_by(HcmEmployee.full_name)
    )).scalars().all()
    return {"items": [{"id": e.id, "emp_code": e.emp_code, "full_name": e.full_name,
                       "email": e.email, "department_name": e.department_name}
                      for e in rows],
            "total": len(rows)}


async def add_group_member(db: AsyncSession, group_id: int, employee_id: int,
                           user) -> dict:
    if await db.get(UserGroup, group_id) is None:
        raise NotFoundError("Group not found")
    if await db.get(HcmEmployee, employee_id) is None:
        raise NotFoundError("Employee not found")
    existing = await db.get(UserGroupMember, {"group_id": group_id,
                                              "employee_id": employee_id})
    if existing is None:
        db.add(UserGroupMember(group_id=group_id, employee_id=employee_id,
                               added_by_id=user.id))
        await db.commit()
    return {"success": True, "group_id": group_id, "employee_id": employee_id}


async def remove_group_member(db: AsyncSession, group_id: int,
                              employee_id: int) -> dict:
    row = await db.get(UserGroupMember, {"group_id": group_id,
                                         "employee_id": employee_id})
    if row is not None:
        await db.delete(row)
        await db.commit()
    return {"success": True, "group_id": group_id, "employee_id": employee_id}


# --------------------------------------------------------------------------- #
#  Role lifecycle. System roles (is_system, and every HCM-mirrored role) can be
#  neither renamed nor deleted: they are referenced by seed data or owned by the
#  HCM sync, and renaming one silently changes what its holders may do.
# --------------------------------------------------------------------------- #
async def list_permissions(db: AsyncSession) -> dict:
    """Every permission with its module/resource grouping — the matrix's columns."""
    rows = (await db.execute(
        select(Permission).order_by(Permission.module, Permission.resource,
                                    Permission.code)
    )).scalars().all()
    return {"items": [{"id": p.id, "code": p.code, "module": p.module,
                       "resource": p.resource, "action": p.action,
                       "description": p.description or p.code} for p in rows]}


async def list_roles_with_permissions(db: AsyncSession) -> dict:
    """All roles with their held permission codes, in two queries (no N+1)."""
    roles = (await db.execute(select(Role).where(
        or_(Role.description.is_(None),
            Role.description.notlike(f"{PROFILE_PREFIX}%")),
    ).order_by(Role.code))).scalars().all()
    held_rows = (await db.execute(
        select(RolePermission.role_id, Permission.code)
        .join(Permission, Permission.id == RolePermission.permission_id)
    )).all()
    held: dict[int, list[str]] = {}
    for role_id, code in held_rows:
        held.setdefault(role_id, []).append(code)
    return {"items": [{
        "id": r.id, "code": r.code, "name": r.name, "is_system": r.is_system,
        "is_active": r.is_active,
        "source": ("HCM" if (r.description or "").startswith(
            HCM_ROLE_DESCRIPTION_PREFIX) else "SCM"),
        "permissions": sorted(held.get(r.id, [])),
    } for r in roles]}
def _role_out(role: Role) -> dict:
    return {"id": role.id, "code": role.code, "name": role.name,
            "description": role.description, "is_system": role.is_system,
            "is_active": role.is_active}


def _is_protected(role: Role) -> bool:
    return role.is_system or (role.description or "").startswith(
        HCM_ROLE_DESCRIPTION_PREFIX)


async def _get_role(db: AsyncSession, role_id: int) -> Role:
    role = await db.get(Role, role_id)
    if role is None:
        raise NotFoundError("Role not found")
    return role


async def _member_count(db: AsyncSession, role_id: int) -> int:
    return (await db.scalar(
        select(func.count()).select_from(UserRole)
        .where(UserRole.role_id == role_id))) or 0


async def create_role(db: AsyncSession, data, actor) -> dict:
    clash = (await db.execute(
        select(Role).where(func.lower(Role.code) == data.code.strip().lower())
    )).scalars().first()
    if clash is not None:
        raise ValidationError(f"A role with code '{clash.code}' already exists")
    role = Role(code=data.code.strip(), name=data.name.strip(),
                description=data.description, is_system=False,
                is_active=data.is_active)
    db.add(role)
    await db.flush()
    await write_audit(db, entity="rbac_roles", entity_id=role.id,
                      entity_no=role.code, action=AuditAction.CREATE, actor=actor,
                      summary=f"Role '{role.name}' created")
    await db.commit()
    await db.refresh(role)
    return _role_out(role)


async def update_role(db: AsyncSession, role_id: int, data, actor) -> dict:
    role = await _get_role(db, role_id)
    if _is_protected(role) and (data.code.strip() != role.code
                                or data.name.strip() != role.name):
        raise ValidationError("System roles cannot be renamed")
    if data.code.strip() != role.code:
        clash = (await db.execute(
            select(Role).where(func.lower(Role.code) == data.code.strip().lower(),
                               Role.id != role_id)
        )).scalars().first()
        if clash is not None:
            raise ValidationError(f"A role with code '{clash.code}' already exists")

    before = {"code": role.code, "name": role.name,
              "description": role.description, "is_active": role.is_active}
    role.code = data.code.strip()
    role.name = data.name.strip()
    role.description = data.description
    role.is_active = data.is_active
    after = {"code": role.code, "name": role.name,
             "description": role.description, "is_active": role.is_active}
    await write_audit(db, entity="rbac_roles", entity_id=role.id,
                      entity_no=role.code, action=AuditAction.UPDATE, actor=actor,
                      before=before, after=after,
                      summary=f"Role '{role.name}' updated")
    await db.commit()
    await db.refresh(role)
    return _role_out(role)


async def delete_role(db: AsyncSession, role_id: int, actor) -> dict:
    role = await _get_role(db, role_id)
    if _is_protected(role):
        raise ValidationError("System roles cannot be deleted")
    members = await _member_count(db, role_id)
    if members:
        raise ValidationError(
            f"'{role.name}' is still assigned to {members} user(s). "
            f"Remove it from them first, then delete the role.")
    role.is_active = False
    await write_audit(db, entity="rbac_roles", entity_id=role.id,
                      entity_no=role.code, action=AuditAction.DEACTIVATE, actor=actor,
                      summary=f"Role '{role.name}' deleted")
    await db.commit()
    return {"success": True, "id": role_id}


async def set_role_permissions(db: AsyncSession, role_id: int,
                               permission_codes: list[str], actor) -> dict:
    """Replace a role's whole permission set in one call.

    Unlike set_role_feature_access this covers every permission, page-linked ones
    included, and reports the diff — the caller shows "granting 4, revoking 2"
    before saving, so the audit row records the same numbers.
    """
    role = await _get_role(db, role_id)
    all_permissions = (await db.execute(select(Permission))).scalars().all()
    by_code = {p.code: p for p in all_permissions}
    unknown = set(permission_codes) - set(by_code)
    if unknown:
        raise ValidationError(f"Unknown permission(s): {', '.join(sorted(unknown))}")

    current_rows = (await db.execute(
        select(RolePermission).where(RolePermission.role_id == role_id)
    )).scalars().all()
    current_ids = {row.permission_id for row in current_rows}
    selected_ids = {by_code[c].id for c in permission_codes}
    code_by_id = {p.id: p.code for p in all_permissions}
    granted = sorted(code_by_id[i] for i in selected_ids - current_ids)
    revoked = sorted(code_by_id[i] for i in current_ids - selected_ids
                     if i in code_by_id)

    for row in current_rows:
        if row.permission_id not in selected_ids:
            await db.delete(row)
    for permission_id in selected_ids - current_ids:
        db.add(RolePermission(role_id=role_id, permission_id=permission_id))

    await write_audit(db, entity="rbac_role_permissions", entity_id=role_id,
                      entity_no=role.code, action=AuditAction.UPDATE, actor=actor,
                      before={"granted": granted, "revoked": revoked},
                      after={"permission_codes": sorted(set(permission_codes))},
                      summary=(f"Permissions of '{role.name}': "
                               f"granted {len(granted)}, revoked {len(revoked)}"))
    await db.commit()
    return {"success": True, "role_id": role_id,
            "granted": granted, "revoked": revoked,
            "permission_codes": sorted(set(permission_codes))}


# --------------------------------------------------------------------------- #
#  Access lookups: who holds a permission, and what a given user would see.
# --------------------------------------------------------------------------- #
async def permission_holders(db: AsyncSession, code: str) -> dict:
    """Reverse lookup: every role that grants a permission, and who holds each role.

    Answers "who can approve a PO" / "who can issue stock". HCM-mirrored roles are
    resolved through positions, SCM roles through rbac_user_roles — the same paths
    the permission check itself uses.
    """
    permission = (await db.execute(
        select(Permission).where(Permission.code == code)
    )).scalars().first()
    if permission is None:
        raise NotFoundError(f"Permission '{code}' not found")

    roles = (await db.execute(
        select(Role)
        .join(RolePermission, RolePermission.role_id == Role.id)
        .where(RolePermission.permission_id == permission.id,
               Role.is_active.is_(True))
        .order_by(Role.name)
    )).scalars().all()

    out_roles = []
    all_ids: set[int] = set()
    for role in roles:
        holder_stmt = await _employee_ids_for_role(db, role.id)
        ids = set((await db.execute(holder_stmt)).scalars().all())
        all_ids |= ids
        employees = (await db.execute(
            select(HcmEmployee).where(HcmEmployee.id.in_(ids),
                                      HcmEmployee.is_active.is_(True))
            .order_by(HcmEmployee.full_name)
        )).scalars().all() if ids else []
        out_roles.append({
            "id": role.id, "name": role.name,
            "source": ("HCM" if (role.description or "").startswith(
                HCM_ROLE_DESCRIPTION_PREFIX) else "SCM"),
            "employees": [_employee_brief(e, e.id) for e in employees],
        })
    return {"permission": {"code": permission.code,
                           "description": permission.description or permission.code,
                           "module": permission.module},
            "roles": out_roles,
            "total_employees": len(all_ids)}


async def view_as_user(db: AsyncSession, employee_id: int) -> dict:
    """What a given employee would see: their roles, permissions and menu.

    Uses the same resolution as login (default position), without touching
    /api/auth/me or issuing a token.
    """
    employee = await db.get(HcmEmployee, employee_id)
    if employee is None:
        raise NotFoundError("Employee not found")
    position = await get_default_position(db, employee_id)
    roles = await get_user_roles(db, employee_id,
                                 position["id"] if position else None)
    permissions = await get_user_permissions(
        db, employee, position["id"] if position else None)
    menu = await get_user_menu(db, permissions)
    return {
        "employee": _employee_brief(employee, employee_id),
        "position": position,
        "roles": [{"id": r.id, "code": r.code, "name": r.name,
                   "source": ("HCM" if (r.description or "").startswith(
                       HCM_ROLE_DESCRIPTION_PREFIX) else "SCM")} for r in roles],
        "permissions": sorted(permissions),
        "menu": menu,
    }


# --------------------------------------------------------------------------- #
#  Reporting hierarchy, read straight from the HCM mirror.
#
#  HCM models the org as a position tree (hcm_positions.parent_position_id); people
#  hold positions through hcm_position_assignments. "Who do I report to" is my
#  position's parent chain; "who reports to me" is the subtree under my position(s).
#  Nothing is stored here — the answer always reflects the latest HCM sync.
# --------------------------------------------------------------------------- #
MAX_REPORTING_DEPTH = 12


async def _org_snapshot(db: AsyncSession):
    """Positions, active holders and employee names, loaded once per request."""
    positions = {p.id: p for p in (await db.execute(
        select(HcmPosition).where(HcmPosition.is_active.is_(True))
    )).scalars().all()}
    assignment_rows = (await db.execute(
        select(HcmPositionAssignment.position_id, HcmPositionAssignment.employee_id)
        .where(HcmPositionAssignment.is_active.is_(True))
    )).all()
    holders: dict[int, list[int]] = {}
    positions_of: dict[int, list[int]] = {}
    for position_id, employee_id in assignment_rows:
        holders.setdefault(position_id, []).append(employee_id)
        positions_of.setdefault(employee_id, []).append(position_id)
    employees = {e.id: e for e in (await db.execute(
        select(HcmEmployee).where(HcmEmployee.is_active.is_(True))
    )).scalars().all()}
    return positions, holders, positions_of, employees


def _employee_brief(e: HcmEmployee | None, employee_id: int) -> dict:
    if e is None:
        return {"id": employee_id, "emp_code": None, "full_name": f"Employee {employee_id}",
                "department_name": None, "office_name": None}
    return {"id": e.id, "emp_code": e.emp_code, "full_name": e.full_name,
            "department_name": e.department_name, "office_name": e.office_name}


class _OrgTreeBuilder:
    """Shared tree logic over one snapshot: nodes carry holders, direct-report and
    total team-member counts, so the screen can say '3 direct · 41 total'."""

    def __init__(self, positions, holders, employees):
        self.positions = positions
        self.holders = holders
        self.employees = employees
        self.children_of: dict[int, list[int]] = {}
        for p in positions.values():
            if p.parent_position_id:
                self.children_of.setdefault(p.parent_position_id, []).append(p.id)

    def node(self, position_id: int) -> dict:
        p = self.positions.get(position_id)
        return {
            "position_id": position_id,
            "position_name": p.name if p else f"Position {position_id}",
            "role_name": p.role_name if p else None,
            "employees": [
                _employee_brief(self.employees.get(i), i)
                for i in self.holders.get(position_id, [])
            ],
        }

    def subtree(self, position_id: int, depth: int = 0) -> list[dict]:
        if depth >= MAX_REPORTING_DEPTH:
            return []
        out = []
        for child_id in sorted(self.children_of.get(position_id, []),
                               key=lambda i: (self.positions[i].name or "")):
            node = self.node(child_id)
            node["children"] = self.subtree(child_id, depth + 1)
            node["direct_count"] = len(node["children"])
            node["team_size"] = sum(
                c["team_size"] + len(c["employees"]) for c in node["children"])
            out.append(node)
        return out


async def get_reporting(db: AsyncSession, employee_id: int) -> dict:
    """The manager chain above an employee and the full team tree below them."""
    positions, holders, positions_of, employees = await _org_snapshot(db)
    employee = await db.get(HcmEmployee, employee_id)
    if employee is None:
        raise NotFoundError("Employee not found")

    builder = _OrgTreeBuilder(positions, holders, employees)
    my_position_ids = positions_of.get(employee_id, [])

    # Upward: walk the parent chain from the primary position. Nearest manager first.
    managers: list[dict] = []
    if my_position_ids:
        seen: set[int] = set()
        node = positions.get(my_position_ids[0])
        hops = 0
        while (node is not None and node.parent_position_id
               and node.parent_position_id not in seen and hops < MAX_REPORTING_DEPTH):
            seen.add(node.parent_position_id)
            managers.append(builder.node(node.parent_position_id))
            node = positions.get(node.parent_position_id)
            hops += 1

    team: list[dict] = []
    for position_id in my_position_ids:
        team.extend(builder.subtree(position_id))

    return {
        "employee": _employee_brief(employee, employee_id),
        "positions": [builder.node(i) for i in my_position_ids],
        "managers": managers,     # nearest first
        "team": team,             # direct reports, each with nested children
        "team_size": sum(t["team_size"] + len(t["employees"]) for t in team),
    }


async def get_org_tree(db: AsyncSession) -> dict:
    """The whole organisation from the top: every active root position (no parent)
    with its subtree. Lets the screen show the org chart before anyone searches."""
    positions, holders, positions_of, employees = await _org_snapshot(db)
    builder = _OrgTreeBuilder(positions, holders, employees)
    roots = []
    for p in sorted(positions.values(), key=lambda x: (x.name or "")):
        if p.parent_position_id and p.parent_position_id in positions:
            continue    # a real child; roots also cover orphans whose parent is gone
        node = builder.node(p.id)
        node["children"] = builder.subtree(p.id)
        node["direct_count"] = len(node["children"])
        node["team_size"] = sum(
            c["team_size"] + len(c["employees"]) for c in node["children"])
        roots.append(node)
    # Positions with no holders and no team are noise (empty seats at the root).
    roots = [r for r in roots if r["employees"] or r["children"]]
    return {"roots": roots}


async def clone_role(db: AsyncSession, role_id: int, data, actor) -> dict:
    """A new custom role starting from an existing one's permission set."""
    source = await _get_role(db, role_id)
    clash = (await db.execute(
        select(Role).where(func.lower(Role.code) == data.code.strip().lower())
    )).scalars().first()
    if clash is not None:
        raise ValidationError(f"A role with code '{clash.code}' already exists")

    role = Role(code=data.code.strip(), name=data.name.strip(),
                description=f"Cloned from {source.name}", is_system=False,
                is_active=True)
    db.add(role)
    await db.flush()
    source_permissions = (await db.execute(
        select(RolePermission.permission_id)
        .where(RolePermission.role_id == role_id)
    )).scalars().all()
    for permission_id in source_permissions:
        db.add(RolePermission(role_id=role.id, permission_id=permission_id))
    await write_audit(db, entity="rbac_roles", entity_id=role.id,
                      entity_no=role.code, action=AuditAction.CREATE, actor=actor,
                      summary=(f"Role '{role.name}' cloned from '{source.name}' "
                               f"with {len(source_permissions)} permission(s)"))
    await db.commit()
    await db.refresh(role)
    return _role_out(role)
