"""APScheduler wrapper for Monthly Indent alerts.

The job is a short fixed TICK that reads the settings row every time, and only runs
`service.run_due` when the configured interval has passed since the last run.

It used to be a job whose interval was fixed when it was scheduled, re-scheduled by
the `PUT /cycle` request. In a deployment that request lands on a web worker, and only
the single `worker` container runs schedulers (RUN_SCHEDULERS), so the change never
reached the process that sends anything: a new interval waited for a restart, and a
scheduler that was switched off at startup had no job at all, so switching it back on
from the screen could never start it. Reading the row on each tick makes the screen
the one source of truth, in whichever process the scheduler happens to live.
"""
import logging
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

log = logging.getLogger("monthly_indent.scheduler")

_scheduler = AsyncIOScheduler()
JOB_ID = "monthly_indent_notifications"
#: How soon a change on the screen (on/off, interval) takes effect. Also the finest
#: interval that means anything — the settings schema allows nothing below 5.
TICK_MINUTES = 5

_last_run: datetime | None = None
_interval_minutes: int = 30
_enabled: bool = True


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _tick() -> None:
    global _last_run, _interval_minutes, _enabled
    from app.core.database import SessionLocal
    from app.platform.monthly_indent import service

    try:
        async with SessionLocal() as db:
            cycle = await service.get_cycle_settings(db)
            _enabled = cycle.scheduler_enabled
            _interval_minutes = max(TICK_MINUTES, int(cycle.scheduler_interval_minutes))
            if not _enabled:
                log.debug("Monthly indent scheduler skipped: disabled")
                return
            now = _now()
            if _last_run and now - _last_run < timedelta(minutes=_interval_minutes):
                return
            _last_run = now
            result = await service.run_due(db)
            if result.get("sent") or result.get("skipped"):
                log.info("Monthly indent reminders: %s", result)
    except Exception:  # a failed tick must not take the job down with it
        log.exception("Monthly indent scheduler tick failed")


def start() -> None:
    if not _scheduler.running:
        _scheduler.start()


def shutdown() -> None:
    if _scheduler.running:
        _scheduler.shutdown(wait=False)


def configure(enabled: bool, interval_minutes: int) -> None:
    """Make sure the tick exists, and remember the settings for `next_run`.

    The tick is scheduled whether or not checking is on — it reads the switch itself —
    so turning checking on later needs nothing from this function. Harmless in a web
    worker, whose scheduler is never started.
    """
    global _enabled, _interval_minutes
    _enabled = enabled
    _interval_minutes = max(TICK_MINUTES, int(interval_minutes or TICK_MINUTES))
    if not _scheduler.get_job(JOB_ID):
        _scheduler.add_job(
            _tick, IntervalTrigger(minutes=TICK_MINUTES),
            id=JOB_ID, replace_existing=True, coalesce=True, max_instances=1,
        )


def next_run() -> str | None:
    """When the next real check is due, as far as THIS process knows.

    None in a process whose scheduler is not running (a web worker in production):
    that process has no honest answer, and a made-up time is worse than none.
    """
    if not _scheduler.running or not _enabled:
        return None
    job = _scheduler.get_job(JOB_ID)
    tick = getattr(job, "next_run_time", None) if job else None
    if tick is None:
        return None
    if _last_run is None:
        return tick.isoformat()
    due = _last_run + timedelta(minutes=_interval_minutes)
    return max(tick, due).isoformat()
