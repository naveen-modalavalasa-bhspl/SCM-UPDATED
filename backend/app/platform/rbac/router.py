"""Admin read endpoints for roles/permissions. (Full admin CRUD is week-2 scope.)"""
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import require_permission
from app.platform.rbac import permissions as perms
from app.platform.rbac.models import Permission, Role, RolePermission

router = APIRouter(prefix="/api/rbac", tags=["rbac"])


@router.get("/permissions")
async def list_permissions(db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(perms.ADMIN_ROLES_MANAGE))):
    rows = (await db.execute(select(Permission).order_by(Permission.code))).scalars().all()
    return {"items": [{"code": p.code, "module": p.module, "description": p.description}
                      for p in rows]}


@router.get("/roles")
async def list_roles(db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(perms.ADMIN_ROLES_MANAGE))):
    roles = (await db.execute(select(Role).order_by(Role.code))).scalars().all()
    out = []
    for r in roles:
        codes = (await db.execute(
            select(Permission.code)
            .join(RolePermission, RolePermission.permission_id == Permission.id)
            .where(RolePermission.role_id == r.id)
        )).scalars().all()
        out.append({"code": r.code, "name": r.name, "is_system": r.is_system,
                    "permissions": sorted(codes)})
    return {"items": out}
