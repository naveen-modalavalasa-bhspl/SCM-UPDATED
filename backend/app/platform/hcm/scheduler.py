"""Periodic HCM sync via APScheduler (runs in the app's asyncio loop).

The interval is admin-configurable and stored in sys_settings; the app reads it at
startup and the schedule endpoint reschedules the job when it changes.
"""
import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

log = logging.getLogger("hcm.scheduler")

_scheduler = AsyncIOScheduler()
JOB_ID = "hcm_sync"


async def _run_sync() -> None:
    from app.core.database import SessionLocal
    from app.platform.hcm import sync

    log.info("Scheduled HCM sync starting")
    async with SessionLocal() as db:
        logs = await sync.sync_needed(db)
    log.info("Scheduled HCM sync done: %s", {l.entity: l.status for l in logs})


def start() -> None:
    if not _scheduler.running:
        _scheduler.start()


def shutdown() -> None:
    if _scheduler.running:
        _scheduler.shutdown(wait=False)


def configure(enabled: bool, interval_minutes: int) -> None:
    """(Re)apply the schedule. enabled=False or interval<=0 removes the job."""
    if _scheduler.get_job(JOB_ID):
        _scheduler.remove_job(JOB_ID)
    if enabled and interval_minutes > 0:
        _scheduler.add_job(
            _run_sync, IntervalTrigger(minutes=interval_minutes),
            id=JOB_ID, replace_existing=True, coalesce=True, max_instances=1,
        )


def next_run() -> str | None:
    job = _scheduler.get_job(JOB_ID)
    if not job:
        return None
    # next_run_time is only set once the scheduler is running; guard for the pending case
    nrt = getattr(job, "next_run_time", None)
    return nrt.isoformat() if nrt else None
