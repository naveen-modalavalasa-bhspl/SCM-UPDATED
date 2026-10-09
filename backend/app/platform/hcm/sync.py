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
import logging
from datetime import datetime
from typing import Callable

from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.platform.hcm import mappers
from app.platform.hcm.client import HcmClient, reset_breaker
from app.platform.hcm.models import (
    HcmDepartment, HcmEmployee, HcmFacility, HcmFacilityType, HcmOffice,
    HcmPosition, HcmPositionAssignment, HcmPositionLevel, HcmRole, HcmSection,
)
from app.platform.settings.models import HcmSyncLog
from app.shared.models.base import utcnow

logger = logging.getLogger(__name__)


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
    ("roles", "roles", HcmRole, mappers.map_role),
    ("position_levels", "position-levels", HcmPositionLevel, mappers.map_position_level),
    ("positions", "positions", HcmPosition, mappers.map_position),
    ("employees", "employees", HcmEmployee, mappers.map_employee),
    ("position_assignments", "position-assignments", HcmPositionAssignment, mappers.map_position_assignment),
]

_DT_FIELDS = {"valid_from", "valid_to"}

# Work that must follow a sync but belongs to a MODULE, which platform may not import
# (rule 5). A module registers itself here at import time — inventory does, to rebuild
# the stocking points HCM's offices and sections describe. Each hook takes the session
# and owns its own commit; one failing hook must not lose the sync that preceded it.
POST_SYNC_HOOKS: list[Callable] = []

# What a hook produced, for the sync screen to show. Registered the same way and for
# the same reason (rule 5): the counts live in module tables platform may not import.
# A provider takes the session and returns {label, ok, detail}.
SYNC_STATUS_PROVIDERS: list[Callable] = []


async def collect_sync_status(db: AsyncSession) -> list[dict]:
    """The state of the follow-up work, so the sync screen can show whether it landed.

    A sync that reports seven green entities while its follow-up quietly wrote nothing
    is the exact failure that left every OE without a stocking point, and nothing on
    any screen said so.
    """
    out = []
    for provider in SYNC_STATUS_PROVIDERS:
        try:
            out.append(await provider(db))
        except Exception as exc:  # noqa: BLE001 — a broken panel must not 500 the page
            logger.exception("sync status provider failed")
            out.append({
                "label": getattr(provider, "__name__", "follow-up"),
                "ok": False,
                "detail": f"could not be read: {exc}"[:200],
            })
    return out


def _hook_did_nothing(result) -> bool:
    """A hook that reported only zeros did not do its job.

    Every hook returns a dict of counts. `rebuild_stocking_points` came back
    `{"warehouses": 983, "links": 4004}` on a healthy run and would come back all-zero
    if it found nothing to write — which is the shape a silently-wedged run takes.
    Anything that is not a dict of numbers is taken at face value and left alone.
    """
    if not isinstance(result, dict) or not result:
        return False
    values = [v for v in result.values() if isinstance(v, (int, float))]
    return bool(values) and not any(values)


async def _record_hook_failure(name: str, error: str) -> None:
    """Failed follow-up work belongs in the sync log, not only in a console nobody reads.

    The whole reason this exists: the stocking-point rebuild stopped running against
    the live mirror and left every OE without their own point, and because the failure
    was swallowed the only evidence was that the numbers never moved.
    """
    from app.core.database import SessionLocal
    try:
        async with SessionLocal() as session:
            session.add(HcmSyncLog(
                entity=name, source="HOOK", started_at=utcnow(), finished_at=utcnow(),
                status="FAILED", records_fetched=0, records_upserted=0,
                error_message=error[:1000],
            ))
            await session.commit()
    except Exception:  # noqa: BLE001 — logging a failure must never raise one
        logger.exception("could not record post-sync hook failure for %s", name)


async def _run_post_sync_hooks() -> None:
    """Run each hook on its OWN session, verify it did something, retry once if not.

    Not `db`: that session has just carried the entire sync, and a hook handed a
    session left dirty by earlier work does its queries inside a transaction that can
    no longer commit — the hook then appears to succeed while writing nothing at all.
    A fresh session per hook removes the shared state entirely.

    The retry is free because every hook is idempotent by contract (the rebuild is
    named for it), and it turns the one failure mode that matters — follow-up work
    that quietly does not happen — into either a fixed run or a logged one.
    """
    from app.core.database import SessionLocal

    for hook in POST_SYNC_HOOKS:
        name = getattr(hook, "__name__", str(hook))
        problem = "did not run"
        for attempt in (1, 2):
            try:
                async with SessionLocal() as session:
                    result = await hook(session)
                logger.info("post-sync hook %s (attempt %s): %s", name, attempt, result)
                if not _hook_did_nothing(result):
                    problem = ""
                    break
                problem = f"returned {result!r} — nothing was written"
            except Exception as exc:  # noqa: BLE001 — a hook is follow-up work, not the sync
                problem = f"{type(exc).__name__}: {exc}"
                logger.exception("post-sync hook %s failed (attempt %s)", name, attempt)
        if problem:
            await _record_hook_failure(name, problem)

# mst_projects is SCM-owned, not an hcm_ mirror: it has no raw/synced_at columns and
# admins may edit it. HCM is treated as the source for identity (id, code, name,
# office) while SCM keeps the rest, so it upserts through its own path below.
_PROJECT_ENTITY = "projects"


async def _load_existing(db: AsyncSession, model: type) -> dict:
    """Every row of a mirror table, by id, in one query.

    `_upsert` used to ask the database for each incoming row, which on the positions
    feed meant 4002 round trips to decide 4002 inserts-or-updates. The mirror tables
    are small enough to hold whole (thousands of rows, not millions), and one SELECT
    beats one per record by an order of magnitude on a remote MySQL.
    """
    return {row.id: row for row in (await db.execute(select(model))).scalars().all()}


async def _upsert(db: AsyncSession, model: type, cols: dict, raw: dict,
                  existing_by_id: dict | None = None) -> bool:
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
    if existing_by_id is None:
        existing = await db.get(model, row_id)
    else:
        existing = existing_by_id.get(row_id)
    now = utcnow()
    if existing is None:
        fresh = model(**cols, raw=raw, synced_at=now)
        db.add(fresh)
        if existing_by_id is not None:
            # A feed that lists the same id twice must update, not insert again.
            existing_by_id[row_id] = fresh
    else:
        for k, v in cols.items():
            if k == "id":
                continue
            setattr(existing, k, v)   # SCM-owned columns are absent from cols
        existing.raw = raw
        existing.synced_at = now
    return True


def _rescuable(position_id: int, known: dict) -> bool:
    """May the employee feed's copy of this post be written?

    Yes when the post is new, and yes when the row we already hold was ITSELF rescued —
    otherwise a post that only the employee feed knows about is frozen at whatever HCM
    sent the day it first appeared. That is how the six SCM warehouse posts kept
    `parent_position_id = NULL` long after HCM populated their `reporting_to`: they were
    inserted once and never looked at again, so the reporting line existed upstream and
    never arrived here.

    No when the positions feed owns the row. That feed is authoritative wherever it
    lists a post, and its record is much richer — project, section id, department id —
    so letting the thinner employee copy overwrite it would blank those columns.

    Told apart by the stored payload: a rescued row's `raw` is the employee record, and
    only that shape carries an `employee` block.
    """
    existing = known.get(position_id)
    if existing is None:
        return True
    raw = getattr(existing, "raw", None)
    return isinstance(raw, dict) and "employee" in raw


async def _last_employee_sync_start(db: AsyncSession) -> datetime | None:
    """When the last SUCCESSFUL employees sync began, or None if there has never been one.

    Used as the cutoff below. A SUCCESS row is required on purpose: a run that failed
    part-way never reached most employee records, so its start time would condemn every
    post those records would have re-stamped.
    """
    return await db.scalar(
        select(HcmSyncLog.started_at)
        .where(HcmSyncLog.entity == "employees", HcmSyncLog.status == "SUCCESS",
               HcmSyncLog.started_at.is_not(None))
        .order_by(HcmSyncLog.id.desc()).limit(1)
    )


def _stale_position_ids(live_ids: set[int], existing: dict,
                        rescued_cutoff: datetime | None = None) -> list[int]:
    """Positions the mirror still calls active that the feed has stopped serving.

    A sync only ever upserts, so until now a post HCM deleted stayed active here for
    good: its role kept showing on the holder's profile and the ladder kept resolving
    to it. Two FLOOR INCHARGE posts carrying a role HCM had already dropped outlived it
    that way, and only a hand-run of scripts/hcm_cutover.py would have cleared them.

    Rows the employee feed rescued are left alone WHILE AN EMPLOYEE RECORD STILL NAMES
    THEM. The positions feed never lists a rescued post (see _rescuable), so its silence
    about one says nothing — but the employee feed's silence does. `synced_at` is the
    difference: every employees sync re-stamps each post it can still rescue, so a
    rescued row whose stamp predates the last successful employees run was offered to
    that feed and not claimed. Nothing in HCM references it any more, and it retires
    like any other.

    FIXED 2026-08-26. The exemption used to be unconditional, and a post that entered
    the mirror through the employee feed could NEVER be retired afterwards. Live case:
    position 2144 "WARE HOUSE MANAGER" (role MANAGER, WM@SCM). HCM deleted it from the
    positions feed and later from its holder's record, yet on any database whose row
    came from the employee side it stayed active for good — carrying a whole Job
    Profile ("23:MANAGER") for a post that no longer exists, and offering grants
    against it. Which database it bit was pure history: a mirror synced while the post
    was still in the positions feed holds the positions-feed payload and retires it
    normally; one first synced after the deletion holds the employee-feed payload and
    is stuck with it.

    `rescued_cutoff=None` keeps the old unconditional exemption, and is what a caller
    with no successful employees sync behind it passes — with nothing to compare
    against, every rescued row reads as unclaimed, and retiring on that would empty the
    mirror of exactly the posts the positions feed never covers. A row with no stamp is
    kept for the same reason.

    An empty id set means the fetch came back empty, not that HCM has no posts —
    retiring the whole mirror on that would strand every ladder, so it retires nothing.
    """
    if not live_ids:
        return []

    def retirable(pid: int, row) -> bool:
        if not _rescuable(pid, existing):
            return True                       # the positions feed owns it, and dropped it
        if rescued_cutoff is None:
            return False
        synced_at = getattr(row, "synced_at", None)
        return synced_at is not None and synced_at < rescued_cutoff

    return [pid for pid, row in existing.items()
            if pid not in live_ids and row.is_active and retirable(pid, row)]


async def _retire_positions(db: AsyncSession, stale: list[int]) -> int:
    """Deactivate the listed posts and the seats on them.

    Retire, not delete: `wf_instances.resolved_chain` and every historical approval
    name a position id and must still resolve to a name. `is_active = 0` is exactly
    the flag the ladder and the resolver already filter on.
    """
    if not stale:
        return 0
    await db.execute(
        update(HcmPosition)
        .where(HcmPosition.id.in_(stale))
        .values(is_active=False)
        .execution_options(synchronize_session=False)
    )
    await db.execute(
        update(HcmPositionAssignment)
        .where(HcmPositionAssignment.position_id.in_(stale),
               HcmPositionAssignment.is_active.is_(True))
        .values(is_active=False)
        .execution_options(synchronize_session=False)
    )
    return len(stale)


async def _issue_missing_logins(db: AsyncSession, *, commit: bool = True) -> int:
    """Give every active employee without one a login, on the configured password.

    HCM is the joiner feed: someone hired today appears in the mirror on the next sync
    and, until now, could not sign in until an admin cut them a credential by hand.
    Only ever ADDS — an existing password is never touched, so this cannot reset
    anybody back to the shared default.

    Off unless NEW_USER_DEFAULT_PASSWORD is set (rule 13: no secret in code).
    """
    from app.core.config import settings
    from app.core.security import hash_password_async
    from app.platform.settings.models import UserCredential

    password = settings.NEW_USER_DEFAULT_PASSWORD
    if not password:
        return 0

    missing = (await db.execute(
        select(HcmEmployee.id)
        .outerjoin(UserCredential, UserCredential.employee_id == HcmEmployee.id)
        .where(HcmEmployee.is_active.is_(True), UserCredential.employee_id.is_(None))
    )).scalars().all()
    if not missing:
        return 0

    # Hashed once, not per row: bcrypt is deliberately slow, and 1900 of them would
    # turn a sync into a coffee break.
    digest = await hash_password_async(password)
    db.add_all(UserCredential(employee_id=employee_id, password_hash=digest,
                              must_change=False)
               for employee_id in missing)
    if commit:
        await db.commit()
    else:
        await db.flush()
    logger.warning("hcm sync: issued %s new logins on the default password",
                   len(missing))
    return len(missing)


async def _release_emp_code(db: AsyncSession, cols: dict) -> None:
    """Let an employee HCM has re-keyed keep their code.

    `hcm_employees.emp_code` is unique, and HCM occasionally re-issues a person under
    a new id — the same HR-EMP code then arrives owned by an id the mirror has never
    seen, and the insert dies on the unique key, taking the whole employee sync with
    it. The stale row is stripped of the code and marked inactive instead of deleted:
    documents, approvals and credentials still point at that id and must keep
    resolving to a name.

    Only ever touches a row whose id HCM did not just send, so it cannot disturb a
    normal update-in-place.
    """
    code, row_id = cols.get("emp_code"), cols.get("id")
    if not code or row_id is None:
        return
    await db.execute(
        update(HcmEmployee)
        .where(HcmEmployee.emp_code == code, HcmEmployee.id != row_id)
        .values(emp_code=None, is_active=False)
        .execution_options(synchronize_session=False)
    )


# Every column in THIS database that points at a project, discovered rather than
# listed. 26 tables carry one today (ind_indents, stk_ledger, pro_purchase_orders,
# wf_instances, inv_sto's two, …) and the list grows with every module, so a
# hand-written one would go stale in exactly the direction that hurts: a table left
# off it reads as "nobody points at this project" and the row gets deactivated anyway.
#
# Identifiers are interpolated below because an identifier cannot be a bind parameter.
# They come from this database's own information_schema, never from a request —
# the same reasoning `shared/masters/crud.row_usage` records for its usage counts.
_PROJECT_REF_COLUMNS_SQL = text("""
    SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND COLUMN_NAME IN ('project_id', 'from_project_id', 'to_project_id')
      AND TABLE_NAME <> 'mst_projects'
""")

_project_ref_columns: list[tuple[str, str]] | None = None


async def _project_referent(db: AsyncSession, project_id: int) -> str | None:
    """The first place that points at this project, or None if nothing does.

    Deliberately stops at the first hit: this answers "is it safe to deactivate", not
    "how much is there", and the whole point is to be cheap enough to run on every
    project of every sync.
    """
    global _project_ref_columns
    if _project_ref_columns is None:
        _project_ref_columns = [
            (table, column)
            for table, column in (await db.execute(_PROJECT_REF_COLUMNS_SQL)).all()
        ]
    for table, column in _project_ref_columns:
        hit = await db.scalar(
            text(f"SELECT 1 FROM {table} WHERE {column} = :pid LIMIT 1"),
            {"pid": project_id},
        )
        if hit:
            return f"{table}.{column}"
    return None


async def _upsert_project(db: AsyncSession, cols: dict) -> bool:
    """mst_projects has no raw/synced_at, and is_active is SCM's call once a project
    exists, so only HCM's identity fields are refreshed on an update."""
    from app.shared.models.master import Project

    row_id = cols.get("id")
    if row_id is None or not cols.get("name"):
        return False
    cols = {k: v for k, v in cols.items() if v is not None}
    # Same story as _release_emp_code: HCM re-keys, `mst_projects.code` is unique, and
    # the project arriving under a new id carries the code an older row still holds.
    # The old row keeps its id (documents point at it) and loses the code.
    #
    # FIXED 2026-08-28 — this used to free the code and set `is_active = 0` in one
    # blind UPDATE, and that is the only place in the whole sync where HCM overrides
    # SCM's call on `is_active`. On a deployment whose SUPPLY CHAIN MANAGEMENT row
    # predated the HCM cutover, the project arriving under its new id demoted the row
    # every indent, stock balance, workflow instance and `PROFILE:<id>:<job>` grant
    # pointed at — the project and its whole job-profile list vanished from every
    # screen at once, with nothing said and no way back: `mst_projects` is
    # `read_only=True` in `masters/defs.py`, so no admin can reactivate it by hand.
    #
    # Freeing the code is the part the UNIQUE constraint actually requires.
    # Deactivating is not, so it now happens ONLY when nothing points at the old row —
    # a genuinely unused stale row still retires exactly as before, and one carrying
    # live documents stays visible and says so loudly. A duplicate an admin can see is
    # always better than a disappearance they cannot.
    if cols.get("code"):
        superseded = (await db.execute(
            select(Project).where(Project.code == cols["code"], Project.id != row_id)
        )).scalars().all()
        for old in superseded:
            # The id, not a bare "-OLD" suffix: a second re-key of the same code would
            # otherwise mint a second `SCM-OLD` and die on the unique key it is here to
            # protect. 35 + 5 + the id fits `code`'s String(50).
            old.code = f"{old.code[:35]}-OLD-{old.id}"
            referent = await _project_referent(db, old.id)
            if referent is None:
                old.is_active = False
                logger.warning(
                    "hcm sync: project %s (%s) was re-keyed to id %s; the old row is "
                    "unused and has been retired", old.id, old.name, row_id,
                )
            else:
                logger.error(
                    "hcm sync: project %s (%s) was re-keyed to id %s, but %s still "
                    "points at the old id — it has been left ACTIVE under code %s. "
                    "Its documents and job profiles are keyed on the OLD id and will "
                    "not follow the new one; move them before retiring it.",
                    old.id, old.name, row_id, referent, old.code,
                )
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


# How many times a whole entity is pulled again before the pull is called a failure.
_ENTITY_ATTEMPTS = 4


def _retry_delay(entity_key: str, attempt: int, exc: Exception) -> float:
    """How long to wait before pulling this entity again.

    The backoff is 3s, 6s, 9s. A breaker REFUSAL overrides it: that is not an answer
    about HCM, it is the client declining to ask, and waiting less than the cooldown
    spends the rest of the ladder on refusals that cannot come out any other way. That
    is how one unreachable entity used to fail the seven that came after it — the run
    at 14:39 on 2026-08-31 lost six entities to "HCM circuit is open" without sending
    a packet, seconds after the link was back.
    """
    delay = 3.0 * (attempt + 1)
    refused_for = getattr(exc, "retry_after", 0.0) or 0.0
    if refused_for:
        delay = max(delay, refused_for + 1.0)
    logger.warning("hcm sync: %s attempt %s/%s failed (%s) — trying again in %.0fs",
                   entity_key, attempt + 1, _ENTITY_ATTEMPTS, exc, delay)
    return delay


async def close_interrupted_runs(db: AsyncSession) -> int:
    """Close out RUNNING rows left behind by a process that stopped mid-sync.

    `sync_entity` commits a RUNNING row before it pulls, so the screen can follow a run
    live. If the server is restarted or reloaded while that entity is in flight, nobody
    ever writes the row again: the entity spins on Settings > HCM & Config for ever,
    and because the page only polls while a sync is running, it never corrects itself.
    Called when the status is read with nothing actually running, so it is self-healing.
    """
    result = await db.execute(
        update(HcmSyncLog)
        .where(HcmSyncLog.status == "RUNNING")
        .values(status="FAILED", finished_at=utcnow(),
                error_message="Interrupted — the server stopped or reloaded while this "
                              "entity was syncing. Nothing was pulled; run the sync "
                              "again.")
        .execution_options(synchronize_session=False)
    )
    closed = result.rowcount or 0
    if closed:
        await db.commit()
        logger.warning("hcm sync: closed %s sync rows left RUNNING by a stopped process",
                       closed)
    return closed


async def sync_entity(db: AsyncSession, entity_key: str, client: HcmClient | None = None) -> HcmSyncLog:
    if entity_key == _PROJECT_ENTITY:
        return await _sync_projects(db, client)
    plan = next((p for p in PLAN if p[0] == entity_key), None)
    if plan is None:
        raise ValueError(f"Unknown HCM entity: {entity_key}")
    _, endpoint, model, mapper = plan
    # One entity synced on its own (POST /api/hcm/sync/{entity}) owns its client and
    # starts on a clean breaker; inside a run the caller owns both.
    owns_client = client is None
    if owns_client:
        reset_breaker()
        client = HcmClient()

    # Commit the RUNNING row immediately so the Admin UI can track progress live.
    log = HcmSyncLog(entity=entity_key, started_at=utcnow(), status="RUNNING")
    db.add(log)
    await db.commit()

    try:
        # Long paginated pulls can hit a transient network blip mid-way; retry the
        # whole entity a few times before giving up.
        rows = None
        complete = False
        last_exc = None
        for attempt in range(_ENTITY_ATTEMPTS):
            try:
                rows, complete = await client.fetch_all_checked(endpoint)
                break
            except Exception as exc:  # noqa: BLE001 — retry on any fetch error
                last_exc = exc
                if attempt == _ENTITY_ATTEMPTS - 1:
                    break          # nothing left to wait for
                await asyncio.sleep(_retry_delay(entity_key, attempt, exc))
        if rows is None:
            raise last_exc or RuntimeError("HCM fetch failed")
        upserted = 0
        existing_by_id = await _load_existing(db, model)
        seats = (await _load_existing(db, HcmPositionAssignment)
                 if entity_key in ("positions", "employees") else None)
        # Posts the positions feed does not list, rescued from the employee record.
        # Loaded for employees only, and only ever ADDED to: the positions feed is
        # authoritative wherever it does list a post, and must not be overwritten by
        # the thinner copy an employee record carries.
        known_positions = (await _load_existing(db, HcmPosition)
                           if entity_key == "employees" else None)
        rescued = 0
        for row in rows:
            cols = mapper(row)
            if entity_key == "employees":
                await _release_emp_code(db, cols)
            if await _upsert(db, model, cols, row, existing_by_id):
                upserted += 1
            # positions carry the employee assignment inline (HCM's own feed is empty)
            if entity_key == "positions":
                derived = mappers.position_assignment_from_position(row)
                if derived:
                    await _upsert(db, HcmPositionAssignment, derived, row, seats)
            elif entity_key == "employees":
                orphan = mappers.position_from_employee(row)
                if orphan and _rescuable(orphan[0]["id"], known_positions):
                    position_cols, seat = orphan
                    await _upsert(db, HcmPosition, position_cols, row, known_positions)
                    await _upsert(db, HcmPositionAssignment, seat, row, seats)
                    rescued += 1
        if rescued:
            logger.warning(
                "hcm sync: %s positions were missing from the positions feed and were "
                "taken from the employee records instead", rescued,
            )
        if entity_key == "positions" and not complete:
            # Retiring reads the feed's SILENCE about a post as a deletion, so it may
            # only ever run on a pull the client could vouch for. HCM's unordered
            # pagination drops a different slice of the list on every walk, and taking
            # one of those for a deletion is what cost the Central Warehouse and
            # Procurement desks their posts (see `HcmClient.fetch_all_checked`).
            logger.warning(
                "hcm sync: the positions feed came up short, so nothing was retired — "
                "%s posts read, and the mirror keeps what this pull did not mention",
                len(rows),
            )
        elif entity_key == "positions":
            # The cutoff comes from the PREVIOUS employees run, because this one has
            # not happened yet — positions sync first (see NEEDED_ENTITIES). A post
            # HCM dropped this morning therefore survives one more cycle before it
            # retires, which is the right way round: a stale row costs a line on a
            # screen, retiring a live one costs somebody their access.
            retired = await _retire_positions(db, _stale_position_ids(
                {r.get("id") for r in rows if r.get("id") is not None},
                existing_by_id,
                await _last_employee_sync_start(db),
            ))
            if retired:
                logger.warning(
                    "hcm sync: retired %s positions the feed no longer serves, and "
                    "their assignments", retired,
                )
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
    if owns_client:
        await client.aclose()
    return log


async def _sync_projects(db: AsyncSession, client: HcmClient | None = None) -> HcmSyncLog:
    """Pull HCM projects into mst_projects. Same logging shape as any other entity."""
    owns_client = client is None
    if owns_client:
        reset_breaker()
        client = HcmClient()
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
    if owns_client:
        await client.aclose()
    return log


async def sync_all(db: AsyncSession, client: HcmClient | None = None) -> list[HcmSyncLog]:
    owns_client = client is None
    if owns_client:
        reset_breaker()
        client = HcmClient()
    logs = []
    try:
        for entity_key, *_ in PLAN:
            logs.append(await sync_entity(db, entity_key, client))
    finally:
        if owns_client:
            await client.aclose()
    from app.platform.rbac.service import sync_hcm_roles
    await sync_hcm_roles(db)
    await db.commit()
    # A joiner HCM sent us can sign in without waiting for an admin.
    await _issue_missing_logins(db)
    await _run_post_sync_hooks()
    return logs


# The entities SCM actually needs (skips the empty facilities/facility_types/
# organization_levels feeds). Used by "Sync now" and the scheduled job.
# Order = parents first.
#
# `sections` is in: it used to be a huge unusable feed, and is now three rows that say
# which rung a post serves ("L I P", "M.D.P") — the only place the org states that.
#
# `position_assignments` is deliberately OUT. Who holds a position is derived from the
# `assigned_employee` that every position already carries (see
# position_assignment_from_position), and the derived row is keyed BY POSITION ID.
# HCM's own assignment ids share a range with its position ids, so pulling that feed
# as well would have the two overwrite each other by id and silently reseat people.
NEEDED_ENTITIES = [
    "offices", "departments", "sections", "roles", "position_levels", "projects",
    "positions", "employees",
]


async def sync_needed(db: AsyncSession, client: HcmClient | None = None) -> list[HcmSyncLog]:
    owns_client = client is None
    if owns_client:
        reset_breaker()
        client = HcmClient()
    logs = []
    try:
        for entity_key in NEEDED_ENTITIES:
            logs.append(await sync_entity(db, entity_key, client))
    finally:
        if owns_client:
            await client.aclose()
    from app.platform.rbac.service import sync_hcm_roles
    await sync_hcm_roles(db)
    await db.commit()
    # A joiner HCM sent us can sign in without waiting for an admin.
    await _issue_missing_logins(db)
    await _run_post_sync_hooks()
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

        # A run a person just asked for starts on a clean breaker: whether the link
        # was down ten minutes ago is no reason to refuse to look now, and an armed
        # breaker used to fail the FIRST entity without sending a packet.
        reset_breaker()
        client = HcmClient()
        keys = entities or NEEDED_ENTITIES
        async with SessionLocal() as db:
            try:
                for key in keys:
                    await sync_entity(db, key, client)
            finally:
                await client.aclose()
            if "positions" in keys:
                from app.platform.rbac.service import sync_hcm_roles
                await sync_hcm_roles(db)
                await db.commit()
            # The same follow-up work sync_needed() does. "Sync now" in the UI comes
            # through here, so without it a synced database ends with no stocking
            # points rebuilt and joiners with no login — the sync reports all green
            # and the only symptom is an OE who cannot see their own store.
            await _issue_missing_logins(db)
        await _run_post_sync_hooks()
    finally:
        _running = False
