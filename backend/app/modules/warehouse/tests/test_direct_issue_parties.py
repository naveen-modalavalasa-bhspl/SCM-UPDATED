"""A direct material issue names where the goods go and who takes them (2026-10-21).

With no indent behind it, the destination and the person are the only record of why
the stock left. An indent-backed issue carries both on the indent and is not held to
it, and neither is a return.
"""
import pytest

from app.core.exceptions import ValidationError
from app.modules.warehouse import service
from app.modules.warehouse.tests.test_issue_split_and_holds import _stock, _world, _write


@pytest.mark.asyncio
async def test_a_direct_issue_without_destination_or_person_is_refused(db):
    w = await _world(db)
    bay = w.floors["F1"]
    await _stock(db, w.user, w.item, w.main, 10, bay.id, w.old.id)
    data = _write(w, w.main, [(bay, w.old, 3)], indent=False)
    data.destination_warehouse_id = None
    data.issued_to_id = None
    with pytest.raises(ValidationError,
                       match="needs a destination and the person it is issued to"):
        await service.create_issue(db, data, w.user)


@pytest.mark.asyncio
async def test_a_direct_issue_naming_only_the_person_still_needs_a_destination(db):
    w = await _world(db)
    bay = w.floors["F1"]
    await _stock(db, w.user, w.item, w.main, 10, bay.id, w.old.id)
    data = _write(w, w.main, [(bay, w.old, 3)], indent=False)
    data.destination_warehouse_id = None
    with pytest.raises(ValidationError, match="needs a destination. Pick it"):
        await service.create_issue(db, data, w.user)


@pytest.mark.asyncio
async def test_a_direct_issue_naming_both_is_saved(db):
    w = await _world(db)
    bay = w.floors["F1"]
    await _stock(db, w.user, w.item, w.main, 10, bay.id, w.old.id)
    issue = await service.create_issue(
        db, _write(w, w.main, [(bay, w.old, 3)], indent=False), w.user)
    assert issue.destination_warehouse_id == w.mdp.id
    assert issue.issued_to_id == w.user.id
