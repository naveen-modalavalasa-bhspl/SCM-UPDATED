"""The organisation directory: a read-only copy of a feed that is not HCM.

The feed (`ORG_SYNC_URL`, `X-API-Key: ORG_SYNC_API_KEY`) answers one request with two
independent lists:

    {"status": "success",
     "organizations": [{"id": 2, "name": "BAVYA", "code": "B-01"}, ...],
     "departments":   [{"id": 2, "name": "HUMAN RESOURCES", "code": "HR-01"}, ...]}

Nothing links one list to the other. Equal ids across them are a coincidence, and an
earlier shape of this feed that did pair them is gone, so nothing here infers a link.

**A bad answer changes nothing.** The two lists are written together or not at all, and
a response that is not `success`, or is missing or empties either list, is refused
before any row is touched: reading "the feed is broken" as "every company closed" would
take the Organisation dropdown off every procurement form at once.
"""
import logging
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import ValidationError
from app.platform.hcm import sync as hcm_sync
from app.platform.settings.models import HcmSyncLog
from app.shared.models.base import utcnow
from app.shared.models.master import OrgDepartment, Organization

logger = logging.getLogger(__name__)

#: `sys_hcm_sync_log.source` for a run of this feed, so its rows read apart from HCM's.
LOG_SOURCE = "ORG_DIRECTORY"
LOG_ENTITY = "org_directory"


class FeedError(Exception):
    """The feed could not be read or did not say what it should. The message is shown
    to an administrator, so it names the problem rather than the exception."""


def configured() -> bool:
    return bool(settings.ORG_SYNC_URL and settings.ORG_SYNC_API_KEY)


def _row(row: Any, label: str) -> dict:
    if not isinstance(row, dict) or row.get("id") in (None, "") or not row.get("name"):
        raise FeedError(f"The feed sent a {label} with no id or no name: {row!r}")
    try:
        identifier = int(row["id"])
    except (TypeError, ValueError) as exc:
        raise FeedError(f"The feed sent a {label} with a bad id: {row['id']!r}") from exc
    return {"id": identifier, "code": row.get("code") or None,
            "name": str(row["name"]).strip(), "raw": row}


def parse_feed(payload: Any) -> tuple[list[dict], list[dict]]:
    """Every feed field name lives here. Pure, so the refusals are tested on their own."""
    if not isinstance(payload, dict) or payload.get("status") != "success":
        status = payload.get("status") if isinstance(payload, dict) else type(payload).__name__
        raise FeedError(f"The feed did not report success (status: {status!r}).")
    lists = []
    for key, label in (("organizations", "organisation"), ("departments", "department")):
        rows = payload.get(key)
        if not isinstance(rows, list) or not rows:
            raise FeedError(f"The feed sent no {key}, so nothing was changed.")
        parsed = [_row(row, label) for row in rows]
        if len({row["id"] for row in parsed}) != len(parsed):
            raise FeedError(f"The feed repeated an id in {key}.")
        lists.append(parsed)
    return lists[0], lists[1]


async def fetch_feed() -> Any:
    if not configured():
        raise FeedError("ORG_SYNC_URL and ORG_SYNC_API_KEY are not set in backend/.env.")
    try:
        async with httpx.AsyncClient(timeout=settings.ORG_SYNC_TIMEOUT_SECONDS) as client:
            response = await client.get(settings.ORG_SYNC_URL,
                                        headers={"X-API-Key": settings.ORG_SYNC_API_KEY})
            response.raise_for_status()
            return response.json()
    except httpx.HTTPStatusError as exc:
        raise FeedError(f"The organisation feed answered HTTP "
                        f"{exc.response.status_code}.") from exc
    except httpx.HTTPError as exc:
        raise FeedError("Could not reach the organisation feed — it is down or this "
                        f"server cannot reach it ({type(exc).__name__}).") from exc
    except ValueError as exc:
        raise FeedError("The organisation feed did not answer with JSON.") from exc


async def _apply(db: AsyncSession, model, rows: list[dict], now) -> int:
    existing = {row.id: row for row in (await db.execute(select(model))).scalars().all()}
    for incoming in rows:
        row = existing.get(incoming["id"])
        if row is None:
            db.add(model(id=incoming["id"], code=incoming["code"], name=incoming["name"],
                         is_active=True, raw=incoming["raw"], synced_at=now))
            continue
        row.code, row.name = incoming["code"], incoming["name"]
        row.is_active, row.raw, row.synced_at = True, incoming["raw"], now
    served = {incoming["id"] for incoming in rows}
    for identifier, row in existing.items():
        if identifier not in served:
            row.is_active = False
    return len(rows)


async def sync(db: AsyncSession, payload: Any = None) -> dict:
    """Fetch, validate, write both lists in one transaction, and log the run.

    `payload` skips the fetch, for tests. A failure is logged and re-raised as a
    FeedError with the rows exactly as they were.
    """
    started = utcnow()
    try:
        raw = payload if payload is not None else await fetch_feed()
        organisations, departments = parse_feed(raw)
        now = utcnow()
        count = await _apply(db, Organization, organisations, now)
        count += await _apply(db, OrgDepartment, departments, now)
    except FeedError as exc:
        await db.rollback()
        db.add(HcmSyncLog(entity=LOG_ENTITY, source=LOG_SOURCE, started_at=started,
                          finished_at=utcnow(), status="FAILED", records_fetched=0,
                          records_upserted=0, error_message=str(exc)[:1000]))
        await db.commit()
        raise
    db.add(HcmSyncLog(entity=LOG_ENTITY, source=LOG_SOURCE, started_at=started,
                      finished_at=utcnow(), status="SUCCESS", records_fetched=count,
                      records_upserted=count))
    await db.commit()
    logger.info("organisation directory synced: %d organisation(s), %d department(s)",
                len(organisations), len(departments))
    return {"organisations": len(organisations), "departments": len(departments)}


async def sync_now(db: AsyncSession) -> dict:
    """The button: a feed problem is said to the administrator, in words."""
    try:
        return await sync(db)
    except FeedError as exc:
        raise ValidationError(str(exc)) from exc


async def sync_after_hcm(db: AsyncSession) -> dict | str:
    """Runs after every HCM sync. Unconfigured is not a failure, so nothing is logged."""
    if not configured():
        return "organisation feed not configured"
    return await sync(db)


if sync_after_hcm not in hcm_sync.POST_SYNC_HOOKS:
    hcm_sync.POST_SYNC_HOOKS.append(sync_after_hcm)


def _out(row) -> dict:
    return {"id": row.id, "code": row.code, "name": row.name, "is_active": row.is_active,
            "synced_at": row.synced_at}


async def _list(db: AsyncSession, model, include_inactive: bool) -> dict:
    stmt = select(model).order_by(model.name, model.id)
    if not include_inactive:
        stmt = stmt.where(model.is_active.is_(True))
    rows = (await db.execute(stmt)).scalars().all()
    return {"items": [_out(row) for row in rows], "total": len(rows), "page": 1,
            "size": len(rows)}


async def list_organisations(db: AsyncSession, include_inactive: bool = False) -> dict:
    return await _list(db, Organization, include_inactive)


async def list_org_departments(db: AsyncSession, include_inactive: bool = False) -> dict:
    return await _list(db, OrgDepartment, include_inactive)


async def sync_status(db: AsyncSession) -> dict:
    """The newest run, and the newest good one: a red run must not hide how old the data
    on screen is."""
    async def newest(*conditions):
        return (await db.execute(
            select(HcmSyncLog).where(HcmSyncLog.source == LOG_SOURCE, *conditions)
            .order_by(HcmSyncLog.id.desc()).limit(1)
        )).scalars().first()

    last = await newest()
    good = await newest(HcmSyncLog.status == "SUCCESS")
    return {
        "configured": configured(),
        "last_status": last.status if last else None,
        "last_error": last.error_message if last else None,
        "last_success_at": good.finished_at if good else None,
    }
