"""A material request's quantity may come down, never go up (2026-11-03).

What these pin:
- a request remembers what each line asked for when it was raised;
- an approver may lower a line or leave it, and is refused raising it;
- every change is kept — from, to, the ceiling, the stage, who and why.
"""
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.core.exceptions import ValidationError
from app.modules.inventory import service
from app.modules.inventory.models import MaterialRequestItem, MRQtyChange
from app.modules.inventory.tests.test_material_requests import _projects, _raiser, _world
from app.shared.enums import MRStatus

pytestmark = pytest.mark.asyncio


async def _mr(db):
    stocked, _bare, _main, _lip, admin = await _world(db)
    _indent_project, raiser_project = await _projects(db)
    user = _raiser(admin, raiser_project)
    mr = await service.create_mr_manual(db, {
        "items": [{"item_id": stocked.id, "quantity": 10}],
    }, user)
    line = (await db.execute(select(MaterialRequestItem).where(
        MaterialRequestItem.mr_id == mr.id))).scalars().one()
    # This world has no ladder, so the request may sign itself at once; what is under
    # test is the approver's revision, which only a pending request takes.
    mr.status = MRStatus.PENDING_APPROVAL.value
    ids = SimpleNamespace(id=mr.id), SimpleNamespace(id=line.id,
                                                     requested=line.requested_quantity)
    await db.commit()
    return ids[0], ids[1], user


async def test_a_raised_request_remembers_what_it_asked_for(db):
    _mr_row, line, _user = await _mr(db)
    assert float(line.requested) == 10


async def test_an_approver_may_lower_a_line_and_the_change_is_kept(db):
    mr, line, user = await _mr(db)
    await service.revise_mr_items(db, mr.id, [{"id": line.id, "quantity": 7}], user,
                                  comments="Two cases on the way already")
    changes = (await db.execute(select(MRQtyChange).where(
        MRQtyChange.mr_id == mr.id))).scalars().all()
    assert len(changes) == 1
    change = changes[0]
    assert (float(change.from_qty), float(change.to_qty), float(change.ceiling_qty)) == (10, 7, 10)
    assert change.stage == "APPROVAL"
    assert change.comments == "Two cases on the way already"
    assert change.changed_by_name == "Inventory Manager"

    served = await service.mr_quantity_changes(db, mr.id, user)
    assert served[0]["to_qty"] == 7 and served[0]["stage"] == "APPROVAL"


async def test_an_approver_may_not_raise_a_line(db):
    mr, line, user = await _mr(db)
    with pytest.raises(ValidationError, match="never increased"):
        await service.revise_mr_items(db, mr.id, [{"id": line.id, "quantity": 12}], user)
    # Back up to what was asked is not an increase over the ask.
    await service.revise_mr_items(db, mr.id, [{"id": line.id, "quantity": 6}], user)
    await service.revise_mr_items(db, mr.id, [{"id": line.id, "quantity": 10}], user)
