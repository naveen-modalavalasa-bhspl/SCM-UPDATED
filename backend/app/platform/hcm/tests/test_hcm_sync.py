"""HCM sync against mocked payloads (real nested shapes from docs/hcm-samples/)."""
from datetime import datetime

from sqlalchemy import select

from app.platform.hcm import sync
from app.platform.hcm.models import HcmEmployee, HcmFacility, HcmOffice, HcmPositionAssignment
from app.shared.models.base import utcnow


class FakeClient:
    """Stands in for HcmClient; returns canned rows per endpoint."""
    def __init__(self, data: dict[str, list[dict]]):
        self.data = data

    async def fetch_all_checked(self, entity: str, page_size: int = 100):
        # (rows, complete) — canned data is by definition the whole feed.
        return self.data.get(entity, []), True

    async def fetch_all(self, entity: str, page_size: int = 100):
        rows, _complete = await self.fetch_all_checked(entity, page_size)
        return rows


async def test_sync_employees_maps_nested_payload(db):
    fake = FakeClient({"employees": [
        {"employee": {"id": 12290, "name": "B SATISH BABU", "employee_code": "HR-EMP-10807",
                      "email": "x@bhspl.in", "phone": "6309244150", "status": "Active"},
         "position": {"id": 4501, "department": "Networking department"},
         "office": {"id": 1, "name": "BAVYA HELTH SERVICE 104"}}
    ]})
    log = await sync.sync_entity(db, "employees", fake)
    assert log.status == "SUCCESS"
    assert log.records_upserted == 1

    emp = await db.get(HcmEmployee, 12290)
    assert emp.full_name == "B SATISH BABU"
    assert emp.emp_code == "HR-EMP-10807"
    assert emp.office_id == 1
    assert emp.position_id == 4501
    assert emp.is_active is True


async def test_sync_does_not_overwrite_is_stock_location(db):
    # admin previously flagged this facility as a stock location
    db.add(HcmFacility(id=99, name="Old name", is_stock_location=True, synced_at=utcnow()))
    await db.commit()

    fake = FakeClient({"facilities": [{"id": 99, "name": "New name", "status": "Active"}]})
    await sync.sync_entity(db, "facilities", fake)

    fac = await db.get(HcmFacility, 99)
    assert fac.name == "New name"            # sync updated the mapped column
    assert fac.is_stock_location is True     # ...but preserved the SCM-owned flag


async def test_positions_derive_assignment_from_assigned_employee(db):
    fake = FakeClient({"positions": [
        {"id": 4501, "name": "Network Technician 4", "code": "NT@4",
         "department_id": 1579, "office_id": 1, "status": "Active",
         "reporting_to": [], "assigned_employee": {"id": 12290, "name": "B SATISH BABU"}}
    ]})
    await sync.sync_entity(db, "positions", fake)

    rows = (await db.execute(
        select(HcmPositionAssignment).where(HcmPositionAssignment.position_id == 4501)
    )).scalars().all()
    assert len(rows) == 1
    assert rows[0].employee_id == 12290


async def test_failed_entity_is_logged_not_raised(db):
    class Boom:
        async def fetch_all_checked(self, entity, page_size=100):
            raise RuntimeError("HCM down")

    log = await sync.sync_entity(db, "offices", Boom())
    assert log.status == "FAILED"
    assert "HCM down" in log.error_message


class _Row:
    """Just the attributes _stale_position_ids reads off a mirror row."""
    def __init__(self, is_active=True, raw=None, synced_at=None):
        self.is_active = is_active
        self.raw = raw if raw is not None else {"id": 1}
        self.synced_at = synced_at


def test_stale_positions_are_the_active_ones_the_feed_dropped():
    existing = {1: _Row(), 2: _Row(), 3: _Row(is_active=False)}
    assert sync._stale_position_ids({1}, existing) == [2]


def test_rescued_positions_are_never_retired():
    # The positions feed never lists these, so absence from it says nothing.
    existing = {1: _Row(), 9: _Row(raw={"employee": {"id": 12290}})}
    assert sync._stale_position_ids({1}, existing) == []


def test_an_empty_feed_retires_nothing():
    assert sync._stale_position_ids(set(), {1: _Row(), 2: _Row()}) == []


# ---- a rescued post the employee feed has also stopped naming (2026-08-26) ---- #

_RESCUED = {"employee": {"id": 12290}}
_RUN = datetime(2026, 8, 24, 14, 34, 33)


def test_a_rescued_post_no_employee_still_names_is_retired():
    """Stamped BEFORE the last employees run: that run could have re-rescued it and
    did not, so nothing in HCM references the post any more. This is live position
    2144 "WARE HOUSE MANAGER", which outlived its own deletion on the deployed
    mirror and kept a Job Profile alive with it."""
    existing = {1: _Row(),
                2144: _Row(raw=_RESCUED, synced_at=datetime(2026, 8, 13, 21, 16, 49))}
    assert sync._stale_position_ids({1}, existing, _RUN) == [2144]


def test_a_rescued_post_the_employee_feed_still_claims_survives():
    """Stamped DURING the last employees run — an employee record still names it."""
    existing = {1: _Row(),
                4811: _Row(raw=_RESCUED, synced_at=datetime(2026, 8, 24, 14, 36, 41))}
    assert sync._stale_position_ids({1}, existing, _RUN) == []


def test_without_a_successful_employees_run_no_rescued_post_is_retired():
    """Nothing to compare against reads as 'unclaimed' for every rescued row, which
    would retire exactly the posts the positions feed never covers."""
    existing = {1: _Row(),
                2144: _Row(raw=_RESCUED, synced_at=datetime(2026, 8, 13, 21, 16, 49))}
    assert sync._stale_position_ids({1}, existing, None) == []


def test_a_rescued_post_with_no_stamp_is_kept():
    existing = {1: _Row(), 2144: _Row(raw=_RESCUED, synced_at=None)}
    assert sync._stale_position_ids({1}, existing, _RUN) == []


def test_the_cutoff_does_not_reprieve_a_positions_feed_post():
    """A row the positions feed owns is retired on its absence alone, however
    recently it was stamped — the cutoff is only about rescued rows."""
    existing = {1: _Row(), 2: _Row(synced_at=datetime(2026, 8, 26, 9, 0, 0))}
    assert sync._stale_position_ids({1}, existing, _RUN) == [2]


# --------------------------------------------------------------------------- #
#  A re-keyed project must never take its documents down with it
# --------------------------------------------------------------------------- #
# HCM re-keys on a cutover, so the same project arrives under a new id carrying the
# code the old row still holds. `mst_projects.code` is unique, so the code has to be
# freed — but the old row is what every indent, stock balance and `PROFILE:<id>:<job>`
# grant points at, and deactivating it is what made SUPPLY CHAIN MANAGEMENT and its
# whole job-profile list disappear from a live deployment in one sync.

_REKEYED = [{"id": 901, "code": "SCM", "name": "SUPPLY CHAIN MANAGEMENT",
             "status": "Active"}]


async def _old_scm_project(db):
    from app.shared.models.master import Project

    db.add(Project(id=900, code="SCM", name="SUPPLY CHAIN MANAGEMENT", is_active=True))
    await db.commit()
    return Project


async def test_a_rekeyed_project_frees_the_code_but_keeps_a_used_row_alive(db):
    Project = await _old_scm_project(db)
    # An employee still carries the OLD project id — `profiles.profile_key` is built
    # from exactly this column, so retiring the row here is retiring their access.
    db.add(HcmEmployee(id=7001, full_name="MAHENDRA", emp_code="E7001",
                       project_id=900, is_active=True, synced_at=utcnow()))
    await db.commit()

    await sync.sync_entity(db, "projects", FakeClient({"projects": _REKEYED}))

    old = await db.get(Project, 900)
    assert old.code == "SCM-OLD-900"     # freed, so the new row's insert can succeed
    assert old.is_active is True         # ...but NOT retired: things point at it
    new = await db.get(Project, 901)
    assert (new.code, new.is_active) == ("SCM", True)


async def test_a_rekeyed_project_retires_an_old_row_nothing_points_at(db):
    Project = await _old_scm_project(db)

    await sync.sync_entity(db, "projects", FakeClient({"projects": _REKEYED}))

    old = await db.get(Project, 900)
    assert old.code == "SCM-OLD-900"
    assert old.is_active is False        # unused stale row retires exactly as before


async def test_a_second_rekey_does_not_mint_a_duplicate_old_code(db):
    """The suffix carries the id because a bare `-OLD` collides on the very unique
    key it exists to protect."""
    Project = await _old_scm_project(db)
    db.add(Project(id=902, code="SCM-OLD-900-SPARE", name="Older still",
                   is_active=False))
    await db.commit()

    await sync.sync_entity(db, "projects", FakeClient({"projects": _REKEYED}))
    await sync.sync_entity(db, "projects", FakeClient({
        "projects": [{"id": 903, "code": "SCM", "name": "SUPPLY CHAIN MANAGEMENT",
                      "status": "Active"}]}))

    assert (await db.get(Project, 900)).code == "SCM-OLD-900"
    assert (await db.get(Project, 901)).code == "SCM-OLD-901"
    assert (await db.get(Project, 903)).code == "SCM"
