"""APScheduler wrapper for Monthly Indent alerts."""
import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

log = logging.getLogger("monthly_indent.scheduler")

_scheduler = AsyncIOScheduler()
JOB_ID = "monthly_indent_notifications"


async def _run() -> None:
    from app.core.database import SessionLocal
    from app.platform.monthly_indent import service

    async with SessionLocal() as db:
        cycle = await service.get_cycle_settings(db)
        if not cycle.scheduler_enabled:
            log.debug("Monthly indent scheduler skipped: disabled")
            return
        await service.run_due(db)


def start() -> None:
    if not _scheduler.running:
        _scheduler.start()


def shutdown() -> None:
    if _scheduler.running:
        _scheduler.shutdown(wait=False)


def configure(enabled: bool, interval_minutes: int) -> None:
    if _scheduler.get_job(JOB_ID):
        _scheduler.remove_job(JOB_ID)
    if enabled and interval_minutes > 0:
        _scheduler.add_job(
            _run, IntervalTrigger(minutes=interval_minutes),
            id=JOB_ID, replace_existing=True, coalesce=True, max_instances=1,
        )


def next_run() -> str | None:
    job = _scheduler.get_job(JOB_ID)
    if not job:
        return None
    nrt = getattr(job, "next_run_time", None)
    return nrt.isoformat() if nrt else None
