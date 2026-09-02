"""Admin endpoints: trigger HCM sync (manual) and configure the periodic schedule."""
import asyncio

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import require_permission
from app.platform.hcm import scheduler, sync
from app.platform.rbac import permissions as perms
from app.platform.settings import service as settings_service
from app.platform.settings.models import HcmSyncLog

router = APIRouter(prefix="/api/hcm", tags=["hcm"])
ADMIN = perms.ADMIN_USERS_MANAGE


class ScheduleIn(BaseModel):
    enabled: bool
    interval_minutes: int = Field(ge=5, le=43200)  # 5 min .. 30 days


def _log_out(log: HcmSyncLog) -> dict:
    return {
        "entity": log.entity, "status": log.status,
        "records_fetched": log.records_fetched, "records_upserted": log.records_upserted,
        "error_message": log.error_message,
        # WHEN each entity last ran. The screen shows the newest row per entity, so
        # without this a two-day-old "4021 synced" sat directly under today's red
        # Offices row and read as part of the same run.
        "started_at": log.started_at, "finished_at": log.finished_at,
    }


async def _schedule_out(db: AsyncSession) -> dict:
    enabled, interval = await settings_service.get_hcm_schedule(db)
    return {"enabled": enabled, "interval_minutes": interval, "next_run": scheduler.next_run()}


@router.post("/sync-now")
async def sync_now(user=Depends(require_permission(ADMIN))):
    """Start a sync in the background (survives a browser refresh). Track it via
    GET /api/hcm/sync-status."""
    if sync.is_syncing():
        return {"started": False, "running": True}
    asyncio.create_task(sync.run_background())
    return {"started": True, "running": True}


@router.get("/sync-status")
async def sync_status(db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(ADMIN))):
    running = sync.is_syncing()
    if not running:
        # Nothing is syncing, so any row still marked RUNNING belongs to a process that
        # stopped mid-run. Left alone it spins on the screen for ever.
        await sync.close_interrupted_runs(db)
    rows = await db.execute(select(HcmSyncLog).order_by(HcmSyncLog.id.desc()).limit(20))
    return {
        "running": running,
        "items": [_log_out(l) for l in rows.scalars().all()],
        # The follow-up work each sync triggers, so a rebuild that silently wrote
        # nothing is visible on the same card that claims the sync succeeded.
        "follow_up": await sync.collect_sync_status(db),
    }


@router.post("/sync/{entity}")
async def sync_one(entity: str, db: AsyncSession = Depends(get_db),
                   user=Depends(require_permission(ADMIN))):
    log = await sync.sync_entity(db, entity)
    return {"success": True, "result": _log_out(log)}


@router.post("/sync-all")
async def sync_everything(db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(ADMIN))):
    logs = await sync.sync_all(db)
    return {"success": True, "results": [_log_out(l) for l in logs]}


@router.get("/sync-log")
async def recent_sync_logs(db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(ADMIN))):
    rows = await db.execute(select(HcmSyncLog).order_by(HcmSyncLog.id.desc()).limit(50))
    return {"items": [_log_out(l) for l in rows.scalars().all()]}


@router.get("/schedule")
async def get_schedule(db: AsyncSession = Depends(get_db), user=Depends(require_permission(ADMIN))):
    return await _schedule_out(db)


@router.put("/schedule")
async def set_schedule(body: ScheduleIn, db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(ADMIN))):
    await settings_service.set_hcm_schedule(db, body.enabled, body.interval_minutes)
    scheduler.configure(body.enabled, body.interval_minutes)
    return await _schedule_out(db)
