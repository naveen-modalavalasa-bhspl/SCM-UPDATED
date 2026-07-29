"""Tests for new inventory module features: Adjustments, STO, Cycle Counts, Replenishment, Reservations."""
from datetime import date
from decimal import Decimal
import pytest

from app.modules.inventory import service
from app.modules.inventory.models import Stock, NO_BIN, NO_PROJECT
from app.shared.models.master import Item
from app.shared.models.warehouse import Warehouse


async def test_stock_adjustment_flow(db, make_user):
    user = await make_user(employee_id=101, username="adj_user", password="pw", permissions=["stock.view"])
    wh = Warehouse(code="WH-ADJ", name="Adjustment Warehouse")
    item = Item(code="ITEM-ADJ", name="Adj Item", uom_code="PCS")
    db.add_all([wh, item])
    await db.flush()

    class AdjItemData:
        item_id = item.id
        bin_id = NO_BIN
        batch_id = 0
        project_id = NO_PROJECT
        direction = "IN"
        quantity = 10
        unit_cost = 5.0
        remarks = "Found extra"

    class AdjData:
        warehouse_id = wh.id
        reason = "FOUND"
        remarks = "Count discrepancy"
        items = [AdjItemData()]

    adj = await service.create_stock_adjustment(db, AdjData(), user)
    assert adj.status == "APPROVED"
    assert len(adj.items) == 1

    # Check stock balance
    stock = (await db.execute(
        service.select(Stock).where(Stock.item_id == item.id, Stock.warehouse_id == wh.id)
    )).scalar_one()
    assert stock.available_qty == Decimal("10")


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
