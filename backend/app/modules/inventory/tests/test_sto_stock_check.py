"""A transfer the source cannot give is refused when it is raised (2026-10-28).

Approving a direct STO drafts its material issue at the source, and the issue refuses
a line asking for more than the point holds — inside the post-approval hook, where the
refusal is swallowed by design. So the transfer was approved, no issue was drafted, and
it sat at "To issue" with nothing anyone could act on (and the approver got a 500 from
reading the expired row after the hook's rollback). Asked when it is raised instead.
"""
import pytest

from app.core.exceptions import ValidationError
from app.modules.inventory import service
from app.shared.models.master import Item
from app.shared.models.warehouse import Warehouse

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


async def test_a_transfer_asking_for_more_than_the_source_holds_is_refused(db, make_user):
    user = await make_user(employee_id=301, username="sto_check",
                           permissions=["stock.view", "stock.transfer"])
    src = Warehouse(code="MDP-A", name="MDP Amalapuram", warehouse_type="MDP")
    dst = Warehouse(code="MDP-B", name="MDP Anakapalli", warehouse_type="MDP")
    item = Item(code="PHA-GEN-0007", name="Paracetamol", uom_code="TAB")
    db.add_all([src, dst, item])
    await db.flush()
    await service.move_stock(db, item_id=item.id, qty=5, direction="IN", ref_type="INIT",
                             ref_id=1, ref_no="INIT", user=user, warehouse_id=src.id)

    with pytest.raises(ValidationError, match=r"MDP Amalapuram cannot give this transfer: "
                                              r"PHA-GEN-0007 asks for 20, 5 free"):
        await service.create_sto(db, _Sto(src.id, dst.id, [_Line(item.id, 20)]), user)

    sto = await service.create_sto(db, _Sto(src.id, dst.id, [_Line(item.id, 5)]), user)
    assert sto.status == "PENDING_APPROVAL"
