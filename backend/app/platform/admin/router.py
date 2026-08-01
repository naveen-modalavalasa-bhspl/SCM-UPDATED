"""Admin endpoints: users, groups, document numbering, notifications, audit, HCM sync.

Every route is 1-3 lines and carries a permission (rule 6); the logic lives in the
sibling service modules (rule 2).
"""
from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user, require_permission
from app.core.pagination import PageParams
from app.platform.admin import app_logs, groups, notifications, numbering, users
from app.platform.admin.schemas import (
    DocSeriesIn, FrontendErrorIn, GrantAccessIn, HcmScheduleIn,
    NotificationRuleIn, SetRolesIn, UserGroupIn,
)
from app.platform.rbac import permissions as perms
from app.platform.settings import service as settings_service

router = APIRouter(prefix="/api/admin", tags=["admin"])


# ----------------------------- users ----------------------------- #
@router.get("/users")
async def list_users(params: PageParams = Depends(), search: str | None = None,
                     with_access: bool | None = None,
                     db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(perms.ADMIN_USERS_MANAGE))):
    return await users.list_users(db, params, search, with_access)


@router.get("/users/summary")
async def users_summary(db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.ADMIN_USERS_MANAGE))):
    return await users.access_summary(db)


@router.post("/users/grant")
async def grant_access(data: GrantAccessIn, db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.ADMIN_USERS_MANAGE))):
    return await users.grant_access(db, data.employee_id, data.role_ids,
                                    data.password, user)


@router.delete("/users/{employee_id}/access")
async def revoke_access(employee_id: int, db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.ADMIN_USERS_MANAGE))):
    return await users.revoke_access(db, employee_id, user)


@router.post("/users/{employee_id}/reset-password")
async def reset_password(employee_id: int, db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(perms.ADMIN_USERS_MANAGE))):
    return await users.reset_password(db, employee_id, user)


@router.put("/users/{employee_id}/roles")
async def set_roles(employee_id: int, data: SetRolesIn,
                    db: AsyncSession = Depends(get_db),
                    user=Depends(require_permission(perms.ADMIN_USERS_MANAGE))):
    return await users.set_roles(db, employee_id, data.role_ids, user)


# ----------------------------- groups ----------------------------- #
@router.get("/groups")
async def list_groups(params: PageParams = Depends(), search: str | None = None,
                      db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.ADMIN_GROUPS_MANAGE))):
    return await groups.list_groups(db, params, search)


@router.post("/groups")
async def create_group(data: UserGroupIn, db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.ADMIN_GROUPS_MANAGE))):
    return await groups.create_group(db, data, user)


@router.put("/groups/{group_id}")
async def update_group(group_id: int, data: UserGroupIn,
                       db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.ADMIN_GROUPS_MANAGE))):
    return await groups.update_group(db, group_id, data, user)


@router.delete("/groups/{group_id}")
async def deactivate_group(group_id: int, db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.ADMIN_GROUPS_MANAGE))):
    return await groups.deactivate_group(db, group_id, user)


@router.get("/groups/{group_id}/members")
async def list_members(group_id: int, db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.ADMIN_GROUPS_MANAGE))):
    return await groups.list_members(db, group_id)


@router.post("/groups/{group_id}/members/{employee_id}")
async def add_member(group_id: int, employee_id: int,
                     db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(perms.ADMIN_GROUPS_MANAGE))):
    return await groups.add_member(db, group_id, employee_id, user)


@router.delete("/groups/{group_id}/members/{employee_id}")
async def remove_member(group_id: int, employee_id: int,
                        db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.ADMIN_GROUPS_MANAGE))):
    return await groups.remove_member(db, group_id, employee_id)


@router.get("/roles")
async def list_roles(db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(perms.ADMIN_ROLES_MANAGE))):
    return await groups.list_roles(db)


@router.get("/hcm-roles")
async def list_hcm_roles(db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(perms.ADMIN_GROUPS_MANAGE))):
    """HCM's org roles, derived from hcm_positions. Not SCM permission roles."""
    return await groups.list_hcm_roles(db)


# ------------------------ document numbering ------------------------ #
@router.get("/doc-series")
async def list_series(db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.ADMIN_NUMBERING_MANAGE))):
    return await numbering.list_series(db)


@router.post("/doc-series")
async def create_series(data: DocSeriesIn, db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.ADMIN_NUMBERING_MANAGE))):
    return await numbering.create_series(db, data, user)


@router.put("/doc-series/{series_id}")
async def update_series(series_id: int, data: DocSeriesIn,
                        db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.ADMIN_NUMBERING_MANAGE))):
    return await numbering.update_series(db, series_id, data, user)


@router.delete("/doc-series/{series_id}")
async def deactivate_series(series_id: int, db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(perms.ADMIN_NUMBERING_MANAGE))):
    return await numbering.deactivate_series(db, series_id, user)


# ------------------------- notifications ------------------------- #
@router.get("/notifications")
async def list_notification_rules(event_code: str | None = None,
                                  db: AsyncSession = Depends(get_db),
                                  user=Depends(require_permission(
                                      perms.ADMIN_NOTIFICATIONS_MANAGE))):
    return await notifications.list_rules(db, event_code)


@router.post("/notifications")
async def create_notification_rule(
        data: NotificationRuleIn, db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.ADMIN_NOTIFICATIONS_MANAGE))):
    return await notifications.create_rule(db, data, user)


@router.put("/notifications/{rule_id}")
async def update_notification_rule(
        rule_id: int, data: NotificationRuleIn, db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.ADMIN_NOTIFICATIONS_MANAGE))):
    return await notifications.update_rule(db, rule_id, data, user)


@router.delete("/notifications/{rule_id}")
async def delete_notification_rule(
        rule_id: int, db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(perms.ADMIN_NOTIFICATIONS_MANAGE))):
    return await notifications.delete_rule(db, rule_id, user)


# ---------------------------- audit ---------------------------- #
@router.get("/audit")
async def list_audit(params: PageParams = Depends(), entity: str | None = None,
                     entity_id: int | None = None, actor_id: int | None = None,
                     action: str | None = None,
                     db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(perms.ADMIN_AUDIT_VIEW))):
    return await settings_service.list_audit(db, params, entity, entity_id,
                                             actor_id, action)


# ------------------------- application logs ------------------------- #
@router.get("/app-logs")
async def list_app_logs(params: PageParams = Depends(), source: str | None = None,
                        level: str | None = None, status_code: int | None = None,
                        search: str | None = None, endpoint: str | None = None,
                        source_file: str | None = None,
                        function_name: str | None = None,
                        message: str | None = None, request_id: str | None = None,
                        db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(perms.ADMIN_AUDIT_VIEW))):
    return await app_logs.list_app_logs(
        db, params, source, level, status_code, search,
        endpoint, source_file, function_name, message, request_id,
    )


@router.post("/app-logs/client-errors", status_code=202)
async def report_client_error(data: FrontendErrorIn, request: Request,
                              db: AsyncSession = Depends(get_db),
                              user=Depends(get_current_user)):
    return await app_logs.capture_frontend_error(db, data, request, user)


# --------------------------- HCM sync --------------------------- #
@router.get("/hcm-schedule")
async def get_hcm_schedule(db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.ADMIN_USERS_MANAGE))):
    enabled, interval = await settings_service.get_hcm_schedule(db)
    return {"enabled": enabled, "interval_minutes": interval}


@router.put("/hcm-schedule")
async def set_hcm_schedule(data: HcmScheduleIn, db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.ADMIN_USERS_MANAGE))):
    await settings_service.set_hcm_schedule(db, data.enabled, data.interval_minutes)
    from app.platform.hcm import scheduler
    scheduler.configure(data.enabled, data.interval_minutes)
    return {"enabled": data.enabled, "interval_minutes": data.interval_minutes}
