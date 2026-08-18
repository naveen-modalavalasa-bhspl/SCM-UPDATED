"""HCM sync against mocked payloads (real nested shapes from docs/hcm-samples/)."""
from sqlalchemy import select

from app.platform.hcm import sync
from app.platform.hcm.models import HcmEmployee, HcmFacility, HcmOffice, HcmPositionAssignment
from app.shared.models.base import utcnow


class FakeClient:
    """Stands in for HcmClient; returns canned rows per endpoint."""
    def __init__(self, data: dict[str, list[dict]]):
        self.data = data

    async def fetch_all(self, entity: str, page_size: int = 100):
        return self.data.get(entity, [])


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
        async def fetch_all(self, entity, page_size=100):
            raise RuntimeError("HCM down")

    log = await sync.sync_entity(db, "offices", Boom())
    assert log.status == "FAILED"
    assert "HCM down" in log.error_message


class _Row:
    """Just the two attributes _stale_position_ids reads off a mirror row."""
    def __init__(self, is_active=True, raw=None):
        self.is_active = is_active
        self.raw = raw if raw is not None else {"id": 1}


def test_stale_positions_are_the_active_ones_the_feed_dropped():
    existing = {1: _Row(), 2: _Row(), 3: _Row(is_active=False)}
    assert sync._stale_position_ids({1}, existing) == [2]


def test_rescued_positions_are_never_retired():
    # The positions feed never lists these, so absence from it says nothing.
    existing = {1: _Row(), 9: _Row(raw={"employee": {"id": 12290}})}
    assert sync._stale_position_ids({1}, existing) == []


def test_an_empty_feed_retires_nothing():
    assert sync._stale_position_ids(set(), {1: _Row(), 2: _Row()}) == []
