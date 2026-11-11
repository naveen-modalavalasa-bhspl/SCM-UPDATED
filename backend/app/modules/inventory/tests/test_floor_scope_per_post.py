"""A floor in-charge's floors follow the post in "Working as" (2026-11-10).

HR-EMP-16644 holds the in-charge post of three floors and saw all three floors' issue
pieces whichever post they were working as. The floor is a fact about the POST, so the
post in hand decides; no post selected keeps every post's floors, as before.
"""
import pytest

from app.modules.inventory import locations
from app.modules.inventory.models import PositionLocation
from app.platform.hcm.models import HcmEmployee, HcmPosition, HcmPositionAssignment
from app.shared.models.base import utcnow
from app.shared.models.warehouse import Warehouse

pytestmark = pytest.mark.asyncio

FLOORS = {7101: 501, 7102: 502, 7103: 503}      # post -> its floor location


async def _person(db):
    wh = Warehouse(code="WH-F", name="Central", warehouse_type="MAIN")
    db.add(wh)
    person = HcmEmployee(id=880, full_name="Floor person", emp_code="HR-EMP-16644",
                         is_active=True, synced_at=utcnow())
    db.add(person)
    await db.flush()
    for index, (post, floor) in enumerate(FLOORS.items(), start=1):
        db.add(HcmPosition(id=post, name=f"FLOOR INCHARGE {index}",
                           role_name="Floor Incharge", is_active=True, synced_at=utcnow()))
        db.add(HcmPositionAssignment(id=9800 + index, employee_id=person.id,
                                     employee_name=person.full_name, position_id=post,
                                     is_primary=index == 1, is_active=True,
                                     synced_at=utcnow()))
    await db.flush()
    for post, floor in FLOORS.items():
        db.add(PositionLocation(position_id=post, warehouse_id=wh.id, location_id=floor))
    await db.commit()
    return person


async def test_the_post_in_hand_decides_the_floor(db):
    person = await _person(db)
    for post, floor in FLOORS.items():
        person.active_position_id = post
        db.info.clear()
        assert await locations.floor_ids_for_user(db, person) == {floor}


async def test_no_post_selected_keeps_every_floor(db):
    person = await _person(db)
    person.active_position_id = None
    assert await locations.floor_ids_for_user(db, person) == set(FLOORS.values())
