"""A return raised, edited and submitted end to end, from a LIP and from an MDP
(SCM_0121 / SCM_0203 / SCM_0204). DB-backed: these three only ever failed against
real rows — the per-item reason rows, the stock hold and the approval chain."""
from decimal import Decimal

import pytest

from app.modules.inventory import service as inventory_service
from app.modules.inventory.models import PositionLocation
from app.modules.returns import service
from app.modules.returns.schemas import ReturnLineIn, ReturnReasonRowIn, ReturnWrite
from app.platform.hcm.models import HcmPosition, HcmPositionAssignment
from app.platform.settings.models import Attachment
from app.shared.models.master import Item
from app.shared.models.warehouse import Warehouse
from app.shared.models.base import utcnow

pytestmark = pytest.mark.asyncio


async def _setup(db, make_user, *, raiser_type: str):
    """An MDP storekeeper (position 902) over a LIP storekeeper (903), under a DM
    (901). The raiser is the LIP or the MDP one; each holds its own point."""
    for pid, name, parent in ((901, "District Manager", None),
                              (902, "MDP Store Keeper", 901),
                              (903, "LIP Store Keeper", 902)):
        db.add(HcmPosition(id=pid, name=name, parent_position_id=parent,
                           is_active=True, synced_at=utcnow()))
    main = Warehouse(code="WH-MAIN", name="Main Warehouse", warehouse_type="MAIN")
    mdp = Warehouse(code="MDP-1", name="MDP One", warehouse_type="MDP")
    lip = Warehouse(code="LIP-1", name="LIP One", warehouse_type="LIP")
    item = Item(code="PHA-GEN-0101", name="Paracetamol", uom_code="TAB")
    db.add_all([main, mdp, lip, item])
    await db.flush()
    raiser_pid = 903 if raiser_type == "LIP" else 902
    users = {}
    for pid, wh in ((901, None), (902, mdp), (903, lip)):
        user = await make_user(employee_id=pid, username=f"ret{pid}",
                               permissions=["return.create", "return.view"])
        db.add(HcmPositionAssignment(id=pid, employee_id=pid, position_id=pid,
                                     is_active=True, is_primary=True, synced_at=utcnow()))
        if wh is not None:
            db.add(PositionLocation(position_id=pid, warehouse_id=wh.id, is_primary=1))
        user.active_position_id = pid
        users[pid] = user
    await db.flush()
    source = lip if raiser_type == "LIP" else mdp
    await inventory_service.move_stock(db, item_id=item.id, qty=10, direction="IN",
                                       ref_type="INIT", ref_id=1, ref_no="INIT",
                                       user=users[raiser_pid], warehouse_id=source.id)
    await db.commit()
    return users[raiser_pid], item, (mdp if raiser_type == "LIP" else main)


def _write(item_id, qty, reasons, destination):
    return ReturnWrite(
        to_warehouse_id=destination,
        items=[ReturnLineIn(item_id=item_id, quantity=Decimal(qty),
                            reasons=[ReturnReasonRowIn(reason=r, quantity=Decimal(q))
                                     for r, q in reasons])],
    )


@pytest.mark.parametrize("raiser_type", ["LIP", "MDP"])
async def test_raise_edit_and_submit_a_return(db, make_user, raiser_type):
    user, item, destination = await _setup(db, make_user, raiser_type=raiser_type)
    created = await service.create_return(
        db, _write(item.id, 5, [("DAMAGED", 3), ("EXPIRED", 2)], destination.id), user)
    return_id = created["id"]

    # SCM_0204: edit it — fewer units, the reasons re-split.
    edited = await service.update_return(
        db, return_id, _write(item.id, 4, [("DAMAGED", 4)], destination.id), user)
    assert Decimal(str(edited["total_qty"])) == 4

    db.add(Attachment(entity_type=service.ENTITY_TYPE, entity_id=return_id,
                      file_name="photo.jpg", file_path="x/photo.jpg",
                      doc_category=service.PHOTO_CATEGORY))
    await db.commit()

    # SCM_0121 / SCM_0203: submit it.
    submitted = await service.submit_return(db, return_id, user)
    assert submitted["status"] != "DRAFT"
