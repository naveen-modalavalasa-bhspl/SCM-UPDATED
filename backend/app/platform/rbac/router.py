"""Admin read endpoints for roles/permissions. (Full admin CRUD is week-2 scope.)"""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import require_permission
from app.core.pagination import PageParams
from app.platform.rbac import permissions as perms
from app.platform.rbac.schemas import (
    RoleCloneIn, RoleFeatureAccessIn, RoleIn, RolePageAccessIn,
    RolePermissionsIn, UserGroupIn,
)
from app.platform.rbac import service

router = APIRouter(prefix="/api/rbac", tags=["rbac"])


@router.get("/users")
async def list_users(params: PageParams = Depends(), search: str | None = None,
                     with_access: bool | None = None, role_id: int | None = None,
                     department: str | None = None, position_id: int | None = None,
                     db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(perms.ADMIN_USERS_MANAGE))):
    return await service.list_users(db, params, search, with_access, role_id,
                                    department, position_id)


@router.get("/user-filters")
async def user_filters(department: str | None = None,
                       db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.ADMIN_USERS_MANAGE))):
    return await service.user_filters(db, department)


@router.get("/users/{employee_id}/reporting")
async def get_reporting(employee_id: int, db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.ADMIN_USERS_MANAGE))):
    return await service.get_reporting(db, employee_id)


@router.get("/org-tree")
async def get_org_tree(db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.ADMIN_USERS_MANAGE))):
    return await service.get_org_tree(db)


@router.get("/users/{employee_id}/view-as")
async def view_as_user(employee_id: int, db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.ADMIN_USERS_MANAGE))):
    return await service.view_as_user(db, employee_id)


@router.get("/permissions/{code}/holders")
async def permission_holders(code: str, db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.ADMIN_ROLES_MANAGE))):
    return await service.permission_holders(db, code)


# --------------------------------- roles --------------------------------- #
@router.post("/roles")
async def create_role(data: RoleIn, db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.ADMIN_ROLES_MANAGE))):
    return await service.create_role(db, data, user)


@router.put("/roles/{role_id}")
async def update_role(role_id: int, data: RoleIn, db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.ADMIN_ROLES_MANAGE))):
    return await service.update_role(db, role_id, data, user)


@router.delete("/roles/{role_id}")
async def delete_role(role_id: int, db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.ADMIN_ROLES_MANAGE))):
    return await service.delete_role(db, role_id, user)


@router.put("/roles/{role_id}/permissions")
async def set_role_permissions(role_id: int, data: RolePermissionsIn,
                               db: AsyncSession = Depends(get_db),
                               user=Depends(require_permission(perms.ADMIN_ROLES_MANAGE))):
    return await service.set_role_permissions(db, role_id, data.permission_codes, user)


@router.post("/roles/{role_id}/clone")
async def clone_role(role_id: int, data: RoleCloneIn,
                     db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(perms.ADMIN_ROLES_MANAGE))):
    return await service.clone_role(db, role_id, data, user)


# ------------------------------- user groups ------------------------------- #
@router.get("/groups")
async def list_groups(params: PageParams = Depends(), search: str | None = None,
                      db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.ADMIN_GROUPS_MANAGE))):
    return await service.list_groups(db, params, search)


@router.get("/regions")
async def list_regions(db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.ADMIN_GROUPS_MANAGE))):
    return await service.list_regions(db)


@router.post("/groups")
async def create_group(data: UserGroupIn, db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.ADMIN_GROUPS_MANAGE))):
    return await service.create_group(db, data, user)


@router.put("/groups/{group_id}")
async def update_group(group_id: int, data: UserGroupIn,
                       db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.ADMIN_GROUPS_MANAGE))):
    return await service.update_group(db, group_id, data, user)


@router.delete("/groups/{group_id}")
async def deactivate_group(group_id: int, db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.ADMIN_GROUPS_MANAGE))):
    return await service.deactivate_group(db, group_id, user)


@router.get("/groups/{group_id}/members")
async def list_group_members(group_id: int, db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.ADMIN_GROUPS_MANAGE))):
    return await service.list_group_members(db, group_id)


@router.post("/groups/{group_id}/members/{employee_id}")
async def add_group_member(group_id: int, employee_id: int,
                           db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.ADMIN_GROUPS_MANAGE))):
    return await service.add_group_member(db, group_id, employee_id, user)


@router.delete("/groups/{group_id}/members/{employee_id}")
async def remove_group_member(group_id: int, employee_id: int,
                              db: AsyncSession = Depends(get_db),
                              user=Depends(require_permission(perms.ADMIN_GROUPS_MANAGE))):
    return await service.remove_group_member(db, group_id, employee_id)


@router.get("/permissions")
async def list_permissions(db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.ADMIN_ROLES_MANAGE))):
    return await service.list_permissions(db)


@router.get("/roles")
async def list_roles(db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(perms.ADMIN_ROLES_MANAGE))):
    return await service.list_roles_with_permissions(db)


@router.get("/page-access")
async def page_access(db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.ADMIN_ROLES_MANAGE))):
    return await service.get_page_access_matrix(db)


@router.put("/roles/{role_id}/page-access")
async def update_page_access(role_id: int, data: RolePageAccessIn,
                             db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(perms.ADMIN_ROLES_MANAGE))):
    return await service.set_role_page_access(db, role_id, data.page_codes, user)


@router.get("/feature-access")
async def feature_access(db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(perms.ADMIN_ROLES_MANAGE))):
    return await service.get_feature_access_matrix(db)


@router.put("/roles/{role_id}/feature-access")
async def update_feature_access(role_id: int, data: RoleFeatureAccessIn,
                                db: AsyncSession = Depends(get_db),
                                user=Depends(require_permission(perms.ADMIN_ROLES_MANAGE))):
    return await service.set_role_feature_access(
        db, role_id, data.permission_codes, user,
    )
