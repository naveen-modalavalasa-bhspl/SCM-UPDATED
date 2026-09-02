"""User groups: CRUD plus membership resolution.

Membership is derived, not stored. A group says "everyone with role X" or "everyone
holding position Y"; asking who is in it runs that query. Storing a roster instead
would go stale the moment an HCM sync moved somebody, and nothing would notice.

A sub-group is a LOCATION group hanging off a parent: the parent decides *who*, the
child narrows it to *where*, so members are the parent's members restricted to the
employees at that place.
"""
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
from app.platform.hcm.models import (
    HcmEmployee, HcmFacility, HcmPosition, HcmPositionAssignment,
)
from app.platform.rbac.models import Role, UserGroup, UserGroupMember, UserRole
from app.platform.rbac.profiles import PROFILE_PREFIX
from app.platform.rbac.service import HCM_ROLE_DESCRIPTION_PREFIX
from app.shared.enums import GroupType
from app.shared.models.warehouse import Warehouse

MAX_GROUP_DEPTH = 10


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


async def _validate(db: AsyncSession, data, group_id: int | None) -> UserGroup | None:
    if data.group_type not in {t.value for t in GroupType}:
        raise ValidationError(
            f"group_type must be one of {', '.join(t.value for t in GroupType)}")

    required = {
        GroupType.ROLE.value: ("role_id", data.role_id),
        # HCM_ROLE reuses role_id, but it points at hcm_positions.role_id rather than
        # rbac_roles.id — the two id spaces are unrelated.
        GroupType.HCM_ROLE.value: ("role_id", data.role_id),
        GroupType.POSITION.value: ("position_id", data.position_id),
        GroupType.LOCATION.value: ("location_id", data.location_id),
    }[data.group_type]
    if required[1] is None:
        raise ValidationError(f"A {data.group_type} group needs {required[0]}")

    if data.group_type == GroupType.LOCATION.value and data.parent_id is None:
        raise ValidationError(
            "A LOCATION group is a sub-group and must have a parent group")

    parent = None
    if data.parent_id is not None:
        if data.parent_id == group_id:
            raise ValidationError("A group cannot be its own parent")
        parent = await db.get(UserGroup, data.parent_id)
        if parent is None:
            raise NotFoundError("Parent group not found")
        await _reject_cycle(db, group_id, parent)
    return parent


async def _reject_cycle(db: AsyncSession, group_id: int | None, parent: UserGroup) -> None:
    if group_id is None:
        return
    node, hops = parent, 0
    while node is not None and hops < MAX_GROUP_DEPTH:
        if node.id == group_id:
            raise ValidationError("That parent would create a group loop")
        node = await db.get(UserGroup, node.parent_id) if node.parent_id else None
        hops += 1


async def create_group(db: AsyncSession, data, user) -> dict:
    await _validate(db, data, None)
    group = UserGroup(**data.model_dump())
    db.add(group)
    await db.commit()
    await db.refresh(group)
    return group_out(group)


async def update_group(db: AsyncSession, group_id: int, data, user) -> dict:
    group = await db.get(UserGroup, group_id)
    if group is None:
        raise NotFoundError("Group not found")
    await _validate(db, data, group_id)
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


# --------------------------------------------------------------------------- #
#  Membership resolution
# --------------------------------------------------------------------------- #
async def _employee_ids_for_rule(db: AsyncSession, group: UserGroup) -> set[int]:
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
        # HCM's org role, held through a position. An employee with several positions
        # in the same role appears once, because this is a set.
        rows = await db.execute(
            select(HcmPositionAssignment.employee_id)
            .join(HcmPosition, HcmPosition.id == HcmPositionAssignment.position_id)
            .where(HcmPosition.role_id == group.role_id,
                   HcmPositionAssignment.is_active.is_(True),
                   HcmPosition.is_active.is_(True)))
        return set(rows.scalars().all())

    # LOCATION: whs_warehouses -> hcm_facility -> office -> employees in that office.
    warehouse = await db.get(Warehouse, group.location_id)
    if warehouse is None or warehouse.facility_id is None:
        return set()
    facility = await db.get(HcmFacility, warehouse.facility_id)
    if facility is None or facility.office_id is None:
        return set()
    rows = await db.execute(
        select(HcmEmployee.id).where(HcmEmployee.office_id == facility.office_id,
                                     HcmEmployee.is_active.is_(True)))
    return set(rows.scalars().all())


async def resolve_member_ids(db: AsyncSession, group_id: int) -> set[int]:
    """Everyone in a group: its own rule, narrowed by each ancestor, plus explicit rows.

    A sub-group intersects with its parent rather than replacing it, so
    "Approvers" + "Chennai" means the approvers in Chennai and not everyone in Chennai.
    """
    group = await db.get(UserGroup, group_id)
    if group is None:
        raise NotFoundError("Group not found")

    members = await _employee_ids_for_rule(db, group)

    node, hops = group, 0
    while node.parent_id is not None and hops < MAX_GROUP_DEPTH:
        parent = await db.get(UserGroup, node.parent_id)
        if parent is None:
            break
        members &= await _employee_ids_for_rule(db, parent)
        node, hops = parent, hops + 1

    explicit = await db.execute(
        select(UserGroupMember.employee_id).where(UserGroupMember.group_id == group_id))
    return members | set(explicit.scalars().all())


async def list_members(db: AsyncSession, group_id: int) -> dict:
    ids = await resolve_member_ids(db, group_id)
    if not ids:
        return {"items": [], "total": 0}
    rows = (await db.execute(
        select(HcmEmployee).where(HcmEmployee.id.in_(ids)).order_by(HcmEmployee.full_name)
    )).scalars().all()
    return {"items": [{"id": e.id, "emp_code": e.emp_code, "full_name": e.full_name,
                       "email": e.email, "department_name": e.department_name}
                      for e in rows],
            "total": len(rows)}


async def add_member(db: AsyncSession, group_id: int, employee_id: int, user) -> dict:
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


async def remove_member(db: AsyncSession, group_id: int, employee_id: int) -> dict:
    row = await db.get(UserGroupMember, {"group_id": group_id, "employee_id": employee_id})
    if row is not None:
        await db.delete(row)
        await db.commit()
    return {"success": True, "group_id": group_id, "employee_id": employee_id}


async def list_roles(db: AsyncSession) -> dict:
    """HCM roles first; temporary SCM access roles are appended.

    Job-profile rows (profiles.py) are excluded, as they are by every other roles
    reader. They are held through a POSITION, never through rbac_user_roles, so
    filtering the user list by one matched nobody and always came back empty.

    Retired roles stay in the list — an admin still needs to find who holds one —
    but they are not `assignable`: granting a role that has been retired is how a
    dead grant gets issued.
    """
    rows = (await db.execute(select(Role).where(
        or_(Role.description.is_(None),
            Role.description.notlike(f"{PROFILE_PREFIX}%")),
    ).order_by(
        Role.description.startswith(HCM_ROLE_DESCRIPTION_PREFIX).desc(), Role.name,
    ))).scalars().all()
    return {"items": [{"id": r.id, "code": r.code, "name": r.name,
                       "description": r.description, "is_system": r.is_system,
                       "is_active": r.is_active,
                       "source": ("HCM" if (r.description or "").startswith(
                           HCM_ROLE_DESCRIPTION_PREFIX) else "SCM"),
                       "assignable": r.is_active and not (
                           r.description or "").startswith(
                           HCM_ROLE_DESCRIPTION_PREFIX)}
                      for r in rows]}


async def list_hcm_roles(db: AsyncSession) -> dict:
    """The distinct org roles HCM defines, with how many positions carry each.

    These are HCM's roles ("Network Technicians"), not SCM permission roles. There is
    no hcm_roles table — the role lives denormalised on each position — so the list is
    derived. It exists so an HCM_ROLE group can be picked from a dropdown rather than
    by typing an id.
    """
    rows = (await db.execute(
        select(HcmPosition.role_id, HcmPosition.role_name,
               func.count(HcmPosition.id).label("positions"))
        .where(HcmPosition.role_id.isnot(None), HcmPosition.is_active.is_(True))
        .group_by(HcmPosition.role_id, HcmPosition.role_name)
        .order_by(HcmPosition.role_name)
    )).all()
    return {"items": [{"id": r.role_id, "name": r.role_name or f"Role {r.role_id}",
                       "positions": r.positions} for r in rows]}
