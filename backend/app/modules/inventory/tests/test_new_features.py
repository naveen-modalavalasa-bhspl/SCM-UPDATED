"""Tests for new inventory module features: Adjustments, STO, Cycle Counts, Replenishment, Reservations."""
from datetime import date
from decimal import Decimal
import pytest

from app.modules.inventory import service
from app.core.exceptions import ValidationError
from app.modules.inventory.models import Stock, NO_BIN, NO_PROJECT
from app.shared.models.master import Item
from app.shared.models.warehouse import Warehouse


class _Line:
    def __init__(self, item_id, *, physical_qty=None, direction=None, quantity=None):
        self.item_id = item_id
        self.bin_id = NO_BIN
        self.batch_id = 0
        self.project_id = NO_PROJECT
        self.physical_qty = physical_qty
        self.direction = direction
        self.quantity = quantity
        self.unit_cost = 5.0
        self.remarks = None
        # The fields every audit line carries now: the codes it writes off, and the
        # brand / variant / model it counts (None = every combination together).
        self.serial_numbers = []
        self.brand_id = self.variant_id = self.model_id = None


class _Adj:
    def __init__(self, warehouse_id, lines, reason="DAMAGE"):
        self.warehouse_id = warehouse_id
        self.reason = reason
        self.remarks = "Count discrepancy"
        self.items = lines


async def test_stock_adjustment_flow(db, make_user):
    """A stock audit only writes stock off (2026-10-31): an inward line is refused, and
    a write-off — however small — waits for its approver."""
    user = await make_user(employee_id=101, username="adj_user", password="pw",
                           permissions=["stock.view", "admin.settings.manage"])
    wh = Warehouse(code="WH-ADJ", name="Adjustment Warehouse")
    item = Item(code="ITEM-ADJ", name="Adj Item", uom_code="PCS")
    db.add_all([wh, item])
    await db.flush()
    await service.move_stock(db, item_id=item.id, qty=10, direction="IN", ref_type="INIT",
                             ref_id=1, ref_no="INIT", user=user, warehouse_id=wh.id)

    with pytest.raises(ValidationError, match="only writes stock off"):
        await service.create_stock_adjustment(
            db, _Adj(wh.id, [_Line(item.id, direction="IN", quantity=10)]), user)

    adj = await service.create_stock_adjustment(
        db, _Adj(wh.id, [_Line(item.id, direction="OUT", quantity=2)]), user)
    assert adj.status == "PENDING_APPROVAL"
    assert len(adj.items) == 1

    # Nothing has left the shelf yet: a write-off posts only once it is approved.
    stock = (await db.execute(
        service.select(Stock).where(Stock.item_id == item.id, Stock.warehouse_id == wh.id)
    )).scalar_one()
    assert stock.available_qty == Decimal("10")


async def test_stock_audit_derives_the_difference_from_system_stock(db, make_user):
    """The count is physical; the system figure and the correction are the server's."""
    raiser = await make_user(employee_id=103, username="audit_user", password="pw",
                             permissions=["stock.view", "admin.settings.manage"])
    approver = await make_user(employee_id=104, username="audit_approver", password="pw",
                               permissions=["stock.view", "admin.settings.manage",
                                            "stock.adjust.approve"])
    wh = Warehouse(code="WH-AUD", name="Audit Warehouse")
    short = Item(code="ITEM-AUD-1", name="Short Item", uom_code="PCS")
    match = Item(code="ITEM-AUD-2", name="Matching Item", uom_code="PCS")
    db.add_all([wh, short, match])
    await db.flush()
    for it in (short, match):
        await service.move_stock(
            db, item_id=it.id, qty=20, direction="IN",
            ref_type="INIT", ref_id=1, ref_no="INIT", user=raiser, warehouse_id=wh.id)
    await db.commit()

    sheet = await service.adjustment_count_sheet(db, wh.id, raiser)
    assert {r["item_id"]: r["system_qty"] for r in sheet} == {short.id: 20.0, match.id: 20.0}

    adj = await service.create_stock_adjustment(db, _Adj(wh.id, [
        _Line(short.id, physical_qty=17), _Line(match.id, physical_qty=20),
    ], reason="CYCLE_COUNT"), raiser)
    # Outward, so it waits; the raiser may not sign their own.
    assert adj.status == "PENDING_APPROVAL"
    lines = {line.item_id: line for line in adj.items}
    assert (lines[short.id].system_qty, lines[short.id].physical_qty) == (20, 17)
    assert (lines[short.id].direction, lines[short.id].quantity) == ("OUT", 3)
    assert lines[match.id].quantity == 0
    with pytest.raises(Exception):
        await service.act_on_adjustment(db, adj.id, "APPROVE", raiser)

    adj = await service.act_on_adjustment(db, adj.id, "APPROVE", approver)
    assert adj.status == "APPROVED"
    on_hand = {
        row.item_id: row.total_qty for row in (await db.execute(
            service.select(Stock).where(Stock.warehouse_id == wh.id))).scalars()
    }
    assert on_hand == {short.id: Decimal("17"), match.id: Decimal("20")}


async def test_sto_workflow(db, make_user):
    user = await make_user(employee_id=102, username="sto_user", password="pw", permissions=["stock.view", "stock.transfer"])
    wh1 = Warehouse(code="WH-SRC", name="Source Warehouse")
    wh2 = Warehouse(code="WH-DST", name="Destination Warehouse")
    item = Item(code="ITEM-STO", name="STO Item", uom_code="BOX")
    db.add_all([wh1, wh2, item])
    await db.flush()

    # Add initial stock in wh1
    await service.move_stock(
        db, item_id=item.id, qty=100, direction="IN",
        ref_type="INIT", ref_id=1, ref_no="INIT", user=user, warehouse_id=wh1.id
    )

    class STOItemData:
        item_id = item.id
        requested_qty = 20
        remarks = "Transfer for project"

    class STOData:
        from_warehouse_id = wh1.id
        to_warehouse_id = wh2.id
        from_project_id = NO_PROJECT
        to_project_id = NO_PROJECT
        remarks = "Need stock"
        items = [STOItemData()]

    sto = await service.create_sto(db, STOData(), user)
    assert sto.status == "PENDING_APPROVAL"

    sto = await service.approve_sto(db, sto.id, user)
    assert sto.status == "APPROVED"

    sto = await service.dispatch_sto(db, sto.id, user)
    assert sto.status == "DISPATCHED"

    sto = await service.receive_sto(db, sto.id, user)
    assert sto.status == "RECEIVED"

    # Verify stock moved physically only after receive
    stock_wh1 = (await db.execute(
        service.select(Stock).where(Stock.item_id == item.id, Stock.warehouse_id == wh1.id)
    )).scalar_one()
    stock_wh2 = (await db.execute(
        service.select(Stock).where(Stock.item_id == item.id, Stock.warehouse_id == wh2.id)
    )).scalar_one()

    assert stock_wh1.available_qty == Decimal("80")
    assert stock_wh2.available_qty == Decimal("20")
