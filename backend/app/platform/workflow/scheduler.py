"""The timer behind approval reminders and escalation.

Same shape as `platform/hcm/scheduler.py` — one APScheduler job in the app's own
asyncio loop, configured from `sys_settings` at startup and rescheduled when an
administrator changes the interval. Kept separate from the HCM job so a slow sync can
never delay a chase, and so turning one off does not touch the other.
"""
import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

log = logging.getLogger("workflow.scheduler")

_scheduler = AsyncIOScheduler()
JOB_ID = "approval_reminders"


async def _run() -> None:
    from app.core.database import SessionLocal
    from app.platform.workflow import reminders

    async with SessionLocal() as db:
        # Re-read the switch on every tick. An admin turning it off should take effect
        # at the next wake-up, without anyone restarting the server.
        config = await reminders.get_config(db)
        if not config["enabled"]:
            log.debug("Approval chase skipped: disabled")
            return
        await reminders.run(db)


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
            _run, IntervalTrigger(minutes=interval_minutes),
            id=JOB_ID, replace_existing=True, coalesce=True, max_instances=1,
        )


def next_run() -> str | None:
    job = _scheduler.get_job(JOB_ID)
    if not job:
        return None
    nrt = getattr(job, "next_run_time", None)
    return nrt.isoformat() if nrt else None
