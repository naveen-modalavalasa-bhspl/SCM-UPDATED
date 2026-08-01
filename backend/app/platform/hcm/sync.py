"""HCM -> mirror sync. THE ONLY place that writes hcm_* tables.

Parents first (offices -> facility_types -> facilities -> departments -> sections
-> position_levels -> positions -> employees -> position_assignments). Each entity
runs in its own transaction and is logged to sys_hcm_sync_log, so one failing entity
does not roll back the rest.

The upsert uses an explicit column list from mappers.py; it therefore never
overwrites SCM-owned columns (hcm_facilities.is_stock_location, hcm_employees
.password_hash) because those keys are not produced by the mappers.
"""
import asyncio
from datetime import datetime
from typing import Callable

from sqlalchemy.ext.asyncio import AsyncSession

from app.platform.hcm import mappers
from app.platform.hcm.client import HcmClient
from app.platform.hcm.models import (
    HcmDepartment, HcmEmployee, HcmFacility, HcmFacilityType, HcmOffice,
    HcmPosition, HcmPositionAssignment, HcmPositionLevel, HcmSection,
)
from app.platform.settings.models import HcmSyncLog
from app.shared.models.base import utcnow


def _coerce_dt(value):
    if isinstance(value, datetime) or value is None:
        return value
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


# entity key -> (HCM endpoint, Model, mapper)
PLAN: list[tuple[str, str, type, Callable[[dict], dict]]] = [
    ("offices", "offices", HcmOffice, mappers.map_office),
    ("facility_types", "facility-masters", HcmFacilityType, mappers.map_facility_type),
    ("facilities", "facilities", HcmFacility, mappers.map_facility),
    ("departments", "departments", HcmDepartment, mappers.map_department),
    ("sections", "sections", HcmSection, mappers.map_section),
    ("position_levels", "position-levels", HcmPositionLevel, mappers.map_position_level),
    ("positions", "positions", HcmPosition, mappers.map_position),
    ("employees", "employees", HcmEmployee, mappers.map_employee),
    ("position_assignments", "position-assignments", HcmPositionAssignment, mappers.map_position_assignment),
]

_DT_FIELDS = {"valid_from", "valid_to"}

# mst_projects is SCM-owned, not an hcm_ mirror: it has no raw/synced_at columns and
# admins may edit it. HCM is treated as the source for identity (id, code, name,
# office) while SCM keeps the rest, so it upserts through its own path below.
_PROJECT_ENTITY = "projects"


async def _upsert(db: AsyncSession, model: type, cols: dict, raw: dict) -> bool:
    row_id = cols.get("id")
    if row_id is None:
        return False
    for f in _DT_FIELDS:
        if f in cols:
            cols[f] = _coerce_dt(cols[f])
    # Rule 10: bank, salary, EPFO, health and national-ID fields must never be stored.
    # Scrubbing here rather than in each mapper means a newly added sensitive field is
    # dropped even from entities whose mapper has not been touched.
    raw = mappers.scrub_raw(raw)
    existing = await db.get(model, row_id)
    now = utcnow()
    if existing is None:
        db.add(model(**cols, raw=raw, synced_at=now))
    else:
        for k, v in cols.items():
            if k == "id":
                continue
            setattr(existing, k, v)   # SCM-owned columns are absent from cols
        existing.raw = raw
        existing.synced_at = now
    return True


async def _upsert_project(db: AsyncSession, cols: dict) -> bool:
    """mst_projects has no raw/synced_at, and is_active is SCM's call once a project
    exists, so only HCM's identity fields are refreshed on an update."""
    from app.shared.models.master import Project

    row_id = cols.get("id")
    if row_id is None or not cols.get("name"):
        return False
    cols = {k: v for k, v in cols.items() if v is not None}
    existing = await db.get(Project, row_id)
    if existing is None:
        cols.setdefault("code", f"PRJ-{row_id}")
        cols.setdefault("is_active", True)
        db.add(Project(**cols))
    else:
        for key in ("code", "name", "office_id", "office_name"):
            if cols.get(key) is not None:
                setattr(existing, key, cols[key])
    return True


async def sync_entity(db: AsyncSession, entity_key: str, client: HcmClient | None = None) -> HcmSyncLog:
    if entity_key == _PROJECT_ENTITY:
        return await _sync_projects(db, client)
    plan = next((p for p in PLAN if p[0] == entity_key), None)
    if plan is None:
        raise ValueError(f"Unknown HCM entity: {entity_key}")
    _, endpoint, model, mapper = plan
    client = client or HcmClient()

    # Commit the RUNNING row immediately so the Admin UI can track progress live.
    log = HcmSyncLog(entity=entity_key, started_at=utcnow(), status="RUNNING")
    db.add(log)
    await db.commit()

    try:
        # Long paginated pulls can hit a transient network blip mid-way; retry the
        # whole entity a few times before giving up.
        rows = None
        last_exc = None
        for attempt in range(4):
            try:
                rows = await client.fetch_all(endpoint)
                break
            except Exception as exc:  # noqa: BLE001 — retry on any fetch error
                last_exc = exc
                await asyncio.sleep(3 * (attempt + 1))
        if rows is None:
            raise last_exc or RuntimeError("HCM fetch failed")
        upserted = 0
        for row in rows:
            if await _upsert(db, model, mapper(row), row):
                upserted += 1
            # positions carry the employee assignment inline (HCM's own feed is empty)
            if entity_key == "positions":
                derived = mappers.position_assignment_from_position(row)
                if derived:
                    await _upsert(db, HcmPositionAssignment, derived, row)
        log.records_fetched = len(rows)
        log.records_upserted = upserted
        log.status = "SUCCESS"
        log.finished_at = utcnow()
        await db.commit()
    except Exception as exc:  # one entity failing must not sink the others
        await db.rollback()
        log.status = "FAILED"
        log.error_message = str(exc)[:1000]
        log.finished_at = utcnow()
        await db.commit()
    return log


async def _sync_projects(db: AsyncSession, client: HcmClient | None = None) -> HcmSyncLog:
    """Pull HCM projects into mst_projects. Same logging shape as any other entity."""
    client = client or HcmClient()
    log = HcmSyncLog(entity=_PROJECT_ENTITY, started_at=utcnow(), status="RUNNING")
    db.add(log)
    await db.commit()

    try:
        rows = await client.fetch_all(_PROJECT_ENTITY)
        upserted = 0
        for row in rows:
            if await _upsert_project(db, mappers.map_project(row)):
                upserted += 1
        log.records_fetched = len(rows)
        log.records_upserted = upserted
        log.status = "SUCCESS"
        log.finished_at = utcnow()
        await db.commit()
    except Exception as exc:  # noqa: BLE001 — one entity must not sink the rest
        await db.rollback()
        log.status = "FAILED"
        log.error_message = str(exc)[:1000]
        log.finished_at = utcnow()
        await db.commit()
    return log


async def sync_all(db: AsyncSession, client: HcmClient | None = None) -> list[HcmSyncLog]:
    client = client or HcmClient()
    logs = []
    for entity_key, *_ in PLAN:
        logs.append(await sync_entity(db, entity_key, client))
    from app.platform.rbac.service import sync_hcm_roles
    await sync_hcm_roles(db)
    await db.commit()
    return logs


# The entities SCM actually needs (skips the huge `sections` feed and the empty
# facilities/facility_types/organization_levels feeds). Used by "Sync now" and the
# scheduled job. Order = parents first.
NEEDED_ENTITIES = [
    "offices", "departments", "position_levels", "projects", "positions",
    "employees", "position_assignments",
]


async def sync_needed(db: AsyncSession, client: HcmClient | None = None) -> list[HcmSyncLog]:
    client = client or HcmClient()
    logs = []
    for entity_key in NEEDED_ENTITIES:
        logs.append(await sync_entity(db, entity_key, client))
    from app.platform.rbac.service import sync_hcm_roles
    await sync_hcm_roles(db)
    await db.commit()
    return logs


# ---- background runner (detached from the HTTP request; survives a browser refresh) ----

_running = False


def is_syncing() -> bool:
    return _running


async def run_background(entities: list[str] | None = None) -> None:
    """Run a sync in its own DB session, in the background. Progress is visible via the
    sys_hcm_sync_log rows (each entity commits RUNNING then SUCCESS/FAILED)."""
    global _running
    if _running:
        return
    _running = True
    try:
        from app.core.database import SessionLocal

        client = HcmClient()
        keys = entities or NEEDED_ENTITIES
        async with SessionLocal() as db:
            for key in keys:
                await sync_entity(db, key, client)
            if "positions" in keys:
                from app.platform.rbac.service import sync_hcm_roles
                await sync_hcm_roles(db)
                await db.commit()
    finally:
        _running = False
