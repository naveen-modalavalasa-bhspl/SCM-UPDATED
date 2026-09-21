"""Monthly Indent settings endpoints."""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import require_permission
from app.platform.monthly_indent import scheduler, service
from app.platform.monthly_indent.schemas import (
    MonthlyIndentCycle, MonthlyIndentPreviewIn, MonthlyIndentPreviewOut,
    MonthlyIndentRuleIn, MonthlyIndentRuleOut, MonthlyIndentRunOut,
    MonthlyIndentSettingsOut,
)
from app.platform.rbac import permissions as perms

router = APIRouter(prefix="/api/monthly-indent", tags=["monthly-indent"])


@router.get("/settings", response_model=MonthlyIndentSettingsOut)
async def get_settings(db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.ADMIN_SETTINGS_MANAGE))):
    result = await service.overview(db)
    result["next_run"] = scheduler.next_run()
    return result


@router.put("/cycle", response_model=MonthlyIndentSettingsOut)
async def update_cycle(data: MonthlyIndentCycle, db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(perms.ADMIN_SETTINGS_MANAGE))):
    result = await service.update_cycle_settings(db, data, user)
    scheduler.configure(data.scheduler_enabled, data.scheduler_interval_minutes)
    result["next_run"] = scheduler.next_run()
    return result


@router.post("/rules", response_model=MonthlyIndentRuleOut)
async def create_rule(data: MonthlyIndentRuleIn, db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.ADMIN_SETTINGS_MANAGE))):
    return await service.create_rule(db, data, user)


@router.put("/rules/{rule_id}", response_model=MonthlyIndentRuleOut)
async def update_rule(rule_id: int, data: MonthlyIndentRuleIn,
                      db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.ADMIN_SETTINGS_MANAGE))):
    return await service.update_rule(db, rule_id, data, user)


@router.delete("/rules/{rule_id}")
async def delete_rule(rule_id: int, db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(perms.ADMIN_SETTINGS_MANAGE))):
    return await service.delete_rule(db, rule_id, user)


@router.post("/preview", response_model=MonthlyIndentPreviewOut)
async def preview(data: MonthlyIndentPreviewIn,
                  user=Depends(require_permission(perms.ADMIN_SETTINGS_MANAGE))):
    return {"message": service.render_template(data.template, data.model_dump())}


@router.post("/run", response_model=MonthlyIndentRunOut)
async def run_now(db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission(perms.ADMIN_SETTINGS_MANAGE))):
    return await service.run_due(db)

