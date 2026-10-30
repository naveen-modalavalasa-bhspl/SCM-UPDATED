"""A direct STO goes between SIBLINGS — two points under one parent (2026-10-29).

`whs_warehouses` carries no parent: the chain is the org's. An LIP's parent is the
point its holder's manager holds (`locations.parent_points`), so two LIPs whose
holders report into the same OE are siblings and two under different OEs are not.
The STO form's "To" list is served off the same rule (`sto_destinations`), so it
offers exactly what `create_sto` accepts.
"""
import pytest

from app.core.exceptions import ValidationError
from app.modules.inventory import locations, service
from app.modules.inventory.models import PositionLocation
from app.platform.hcm.models import HcmPosition
from app.shared.models.master import Item
from app.shared.models.warehouse import Warehouse
from app.shared.models.base import utcnow

pytestmark = pytest.mark.asyncio


class _Line:
    def __init__(self, item_id, qty):
        self.item_id, self.requested_qty, self.remarks = item_id, qty, None
        self.brand_id = self.variant_id = self.model_id = None


class _Sto:
    def __init__(self, src, dst, lines):
        self.from_warehouse_id, self.to_warehouse_id = src, dst
        self.from_project_id = self.to_project_id = 0
        self.remarks, self.items = None, lines


async def _network(db):
    """Two OEs, each holding an MDP; two LIPs under the first, one under the second."""
    mdp_a = Warehouse(code="MDP-A", name="MDP Alpha", warehouse_type="MDP")
    mdp_b = Warehouse(code="MDP-B", name="MDP Beta", warehouse_type="MDP")
    lip_1 = Warehouse(code="LIP-1", name="LIP One", warehouse_type="LIP")
    lip_2 = Warehouse(code="LIP-2", name="LIP Two", warehouse_type="LIP")
    lip_3 = Warehouse(code="LIP-3", name="LIP Three", warehouse_type="LIP")
    db.add_all([mdp_a, mdp_b, lip_1, lip_2, lip_3])
    for pid, parent in ((9001, None), (9002, None), (9011, 9001), (9012, 9001), (9013, 9002)):
        db.add(HcmPosition(id=pid, name=f"Post {pid}", parent_position_id=parent,
                           is_active=True, synced_at=utcnow()))
    await db.flush()
    for pid, wh in ((9001, mdp_a), (9002, mdp_b), (9011, lip_1), (9012, lip_2), (9013, lip_3)):
        db.add(PositionLocation(position_id=pid, warehouse_id=wh.id))
    await db.flush()
    return mdp_a, mdp_b, lip_1, lip_2, lip_3


async def test_an_lip_parent_is_the_point_its_holders_manager_holds(db):
    mdp_a, mdp_b, lip_1, lip_2, lip_3 = await _network(db)
    parents = await locations.parent_points(db, {lip_1.id, lip_2.id, lip_3.id, mdp_a.id})
    assert parents[lip_1.id] == mdp_a.id
    assert parents[lip_2.id] == mdp_a.id
    assert parents[lip_3.id] == mdp_b.id
    # An MDP's holder reports to nobody here: parent unknown, never "itself".
    assert parents[mdp_a.id] is None


async def test_a_transfer_between_cousins_is_refused_and_siblings_are_offered(db, make_user):
    user = await make_user(employee_id=302, username="sto_sib",
                           permissions=["stock.view", "stock.transfer"])
    _mdp_a, _mdp_b, lip_1, lip_2, lip_3 = await _network(db)
    item = Item(code="PHA-GEN-0008", name="Bandage", uom_code="NOS")
    db.add(item)
    await db.flush()
    await service.move_stock(db, item_id=item.id, qty=10, direction="IN", ref_type="INIT",
                             ref_id=1, ref_no="INIT", user=user, warehouse_id=lip_1.id)

    with pytest.raises(ValidationError, match="different parent points"):
        await service.create_sto(db, _Sto(lip_1.id, lip_3.id, [_Line(item.id, 2)]), user)

    sto = await service.create_sto(db, _Sto(lip_1.id, lip_2.id, [_Line(item.id, 2)]), user)
    assert sto.status == "PENDING_APPROVAL"

    served = await service.sto_destinations(db, lip_1.id, user)
    assert [row["id"] for row in served["items"]] == [lip_2.id]
    assert served["parent_name"] == "MDP Alpha"
