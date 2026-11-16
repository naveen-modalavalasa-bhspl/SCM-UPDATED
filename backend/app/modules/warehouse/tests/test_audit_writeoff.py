"""A stock audit only takes stock off, and names exactly what it takes (2026-10-31).

The shelf in every test: one lot of 12 units — a carton holding two boxes of 5, and 2
units loose beside it. Every unit carries a code (a serial on the serial-tracked item,
an asset code on the coded one), linked to the box it sits in.

- An audit never adds stock: a count above the system figure, an inward reason, and a
  direct IN line are all refused.
- A serial-tracked shortfall of N names exactly N serials — never fewer, never a pack.
- A coded shortfall is covered by whole packs plus unit codes adding up to exactly N;
  posting consumes the packs picked, scraps every unit inside them, and shrinks the
  packs around them, so the pack tree stays in step with the stock.
"""
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.exceptions import ValidationError
from app.modules.inventory import service as inv
from app.modules.inventory.models import Stock
from app.modules.inventory.schemas import AdjustmentIn, AdjustmentItemIn
from app.modules.warehouse import models as m
from app.modules.warehouse import service as _registers_hooks  # noqa: F401
from app.shared.models.master import Item
from app.shared.models.warehouse import Warehouse

pytestmark = pytest.mark.asyncio


def _hu(code, *, item_id, wh_id, size, level, name, parent=None):
    # Only the outermost pack is SEALED; a pack inside another is INSIDE.
    return m.HandlingUnit(hu_code=code, item_id=item_id, warehouse_id=wh_id,
                          pack_hierarchy_id=1, level=level, pack_name=name,
                          pack_size=Decimal(size), parent_id=parent,
                          status="INSIDE" if parent else "SEALED")


async def _lot(db, make_user, *, serial: bool):
    raiser = await make_user(employee_id=401, username="auditor",
                             permissions=["stock.view", "stock.adjust"])
    approver = await make_user(employee_id=402, username="audit_lead",
                               permissions=["stock.view", "stock.adjust.approve"])
    wh = Warehouse(code="WH-AUD", name="Audit store", warehouse_type="MAIN",
                   is_bin_managed=False, is_active=True)
    item = Item(code="ELEC-1003", name="SMPS power supply", uom_code="NOS",
                is_serial_tracked=serial, is_asset=not serial, is_active=True)
    db.add_all([wh, item])
    await db.commit()
    await inv.move_stock(db, item_id=item.id, qty=12, direction="IN", ref_type="INIT",
                         ref_id=1, ref_no="INIT", user=raiser, warehouse_id=wh.id)
    carton = _hu("CAR-1", item_id=item.id, wh_id=wh.id, size=10, level=2, name="Carton")
    db.add(carton)
    await db.commit()
    box_a = _hu("BOX-A", item_id=item.id, wh_id=wh.id, size=5, level=1, name="Box",
                parent=carton.id)
    box_b = _hu("BOX-B", item_id=item.id, wh_id=wh.id, size=5, level=1, name="Box",
                parent=carton.id)
    db.add_all([box_a, box_b])
    await db.commit()
    homes = [box_a.id] * 5 + [box_b.id] * 5 + [None, None]
    for i, home in enumerate(homes, start=1):
        db.add(m.SerialNumber(
            item_id=item.id, warehouse_id=wh.id, handling_unit_id=home,
            serial_number=f"S{i}", asset_code=None if serial else f"A{i}",
            status="available", is_active=True))
    await db.commit()
    return raiser, approver, wh, item


def _audit(wh, item, *, physical=None, codes=(), reason="DAMAGE", direction=None,
           quantity=None):
    return AdjustmentIn(warehouse_id=wh.id, reason=reason, items=[AdjustmentItemIn(
        item_id=item.id, physical_qty=physical, direction=direction, quantity=quantity,
        serial_numbers=list(codes))])


async def _units(db, item, status):
    return set((await db.execute(select(m.SerialNumber.serial_number).where(
        m.SerialNumber.item_id == item.id, m.SerialNumber.status == status)))
        .scalars().all())


async def _pack(db, code):
    hu = (await db.execute(select(m.HandlingUnit).where(
        m.HandlingUnit.hu_code == code))).scalars().one()
    await db.refresh(hu)
    return hu


async def _stock(db, item):
    return sum((s.total_qty for s in (await db.execute(
        select(Stock).where(Stock.item_id == item.id))).scalars().all()), Decimal("0"))


async def test_an_audit_can_never_add_stock(db, make_user):
    raiser, _approver, wh, item = await _lot(db, make_user, serial=True)

    with pytest.raises(ValidationError, match="only records a shortfall"):
        await inv.create_stock_adjustment(db, _audit(wh, item, physical=15), raiser)
    with pytest.raises(ValidationError, match="not a stock audit reason"):
        await inv.create_stock_adjustment(
            db, _audit(wh, item, physical=12, reason="EXCESS"), raiser)
    with pytest.raises(ValidationError, match="only writes stock off"):
        await inv.create_stock_adjustment(
            db, _audit(wh, item, direction="IN", quantity=3), raiser)


async def test_a_serial_shortfall_names_exactly_that_many_serials(db, make_user):
    raiser, approver, wh, item = await _lot(db, make_user, serial=True)

    with pytest.raises(ValidationError, match="Pick the 2 serials"):
        await inv.create_stock_adjustment(db, _audit(wh, item, physical=10), raiser)
    with pytest.raises(ValidationError, match="cover 1. Pick exactly 2"):
        await inv.create_stock_adjustment(
            db, _audit(wh, item, physical=10, codes=["S1"]), raiser)
    with pytest.raises(ValidationError, match="is a pack"):
        await inv.create_stock_adjustment(
            db, _audit(wh, item, physical=10, codes=["BOX-A", "S1"]), raiser)

    audit = await inv.create_stock_adjustment(
        db, _audit(wh, item, physical=10, codes=["S1", "S2"]), raiser)
    assert audit.status == "PENDING_APPROVAL"   # never written off unattended

    await inv.act_on_adjustment(db, audit.id, "APPROVE", approver)
    assert await _units(db, item, "scrapped") == {"S1", "S2"}
    assert await _stock(db, item) == Decimal("10")
    # The box both came out of shrinks, and so does the carton around it.
    assert (await _pack(db, "BOX-A")).content_qty == Decimal("3")
    assert (await _pack(db, "CAR-1")).content_qty == Decimal("8")


async def test_a_coded_shortfall_takes_whole_packs_plus_unit_codes(db, make_user):
    raiser, approver, wh, item = await _lot(db, make_user, serial=False)

    with pytest.raises(ValidationError, match="cover 6. Pick exactly 7"):
        await inv.create_stock_adjustment(
            db, _audit(wh, item, physical=5, codes=["BOX-A", "A11"]), raiser)
    with pytest.raises(ValidationError, match="inside a pack you picked"):
        await inv.create_stock_adjustment(
            db, _audit(wh, item, physical=5, codes=["BOX-A", "A1", "A11"]), raiser)
    with pytest.raises(ValidationError, match="inside another pack you picked"):
        await inv.create_stock_adjustment(
            db, _audit(wh, item, physical=5, codes=["CAR-1", "BOX-A"]), raiser)

    # One whole box (5) + the two loose codes = the shortfall of 7, exactly.
    audit = await inv.create_stock_adjustment(
        db, _audit(wh, item, physical=5, codes=["BOX-A", "A11", "A12"]), raiser)
    await inv.act_on_adjustment(db, audit.id, "APPROVE", approver)

    box_a = await _pack(db, "BOX-A")
    assert box_a.status == "CONSUMED"
    assert await _units(db, item, "scrapped") == {"S1", "S2", "S3", "S4", "S5", "S11", "S12"}
    assert await _stock(db, item) == Decimal("5")
    # The carton still stands, holding only the box that is left.
    carton = await _pack(db, "CAR-1")
    assert carton.status == "SEALED" and carton.content_qty == Decimal("5")


async def test_an_old_inward_audit_can_be_rejected_but_never_approved(db, make_user):
    raiser, approver, wh, item = await _lot(db, make_user, serial=False)
    # Raised before inward audits were retired: written straight to the table.
    from app.modules.inventory.models import StockAdjustment, StockAdjustmentItem
    old = StockAdjustment(adjustment_no="ADJ-OLD-1", warehouse_id=wh.id,
                          warehouse_name=wh.name, reason="EXCESS",
                          status="PENDING_APPROVAL", created_by_id=raiser.id)
    db.add(old)
    await db.flush()
    db.add(StockAdjustmentItem(adjustment_id=old.id, item_id=item.id, direction="IN",
                               quantity=Decimal("3"), unit_cost=0))
    await db.commit()

    with pytest.raises(ValidationError, match="adds stock"):
        await inv.act_on_adjustment(db, old.id, "APPROVE", approver)
    rejected = await inv.act_on_adjustment(db, old.id, "REJECT", approver)
    assert rejected.status == "REJECTED"
    assert await _stock(db, item) == Decimal("12")


# --------------------------------------------------------------------------- #
#  Brand-wise segregation (2026-10-31)
# --------------------------------------------------------------------------- #

BRAND_A, BRAND_B = 7, 8


async def _two_brands(db, make_user):
    """One batch and location holding Brand A (8) and Brand B (4) of an uncoded item —
    two balances on one shelf."""
    raiser = await make_user(employee_id=411, username="auditor_b",
                             permissions=["stock.view", "stock.adjust"])
    approver = await make_user(employee_id=412, username="audit_lead_b",
                               permissions=["stock.view", "stock.adjust.approve"])
    wh = Warehouse(code="WH-AUB", name="Brand store", warehouse_type="MAIN",
                   is_bin_managed=False, is_active=True)
    item = Item(code="CONS-0042", name="Surgical gloves", uom_code="BOX", is_active=True)
    db.add_all([wh, item])
    await db.commit()
    for brand, qty in ((BRAND_A, 8), (BRAND_B, 4)):
        await inv.move_stock(db, item_id=item.id, qty=qty, direction="IN", ref_type="INIT",
                             ref_id=brand, ref_no="INIT", user=raiser, warehouse_id=wh.id,
                             brand_id=brand)
    return raiser, approver, wh, item


async def _brand_stock(db, item, brand):
    return sum((s.total_qty for s in (await db.execute(select(Stock).where(
        Stock.item_id == item.id, Stock.brand_id == brand))).scalars().all()), Decimal("0"))


def _brand_line(item, brand, *, physical, codes=()):
    return AdjustmentItemIn(item_id=item.id, brand_id=brand, variant_id=0, model_id=0,
                            physical_qty=physical, serial_numbers=list(codes))


async def test_each_brand_is_counted_and_written_off_on_its_own(db, make_user):
    raiser, approver, wh, item = await _two_brands(db, make_user)

    # Brand A is counted against Brand A's 8, not the shelf's 12: counting 9 is an excess.
    with pytest.raises(ValidationError, match="only records a shortfall"):
        await inv.create_stock_adjustment(db, AdjustmentIn(
            warehouse_id=wh.id, reason="SHORTAGE",
            items=[_brand_line(item, BRAND_A, physical=9)]), raiser)

    audit = await inv.create_stock_adjustment(db, AdjustmentIn(
        warehouse_id=wh.id, reason="SHORTAGE",
        items=[_brand_line(item, BRAND_A, physical=6),
               _brand_line(item, BRAND_B, physical=4)]), raiser)
    lines = {line.brand_id: line for line in audit.items}
    assert lines[BRAND_A].quantity == Decimal("2") and lines[BRAND_A].system_qty == Decimal("8")
    assert lines[BRAND_B].quantity == Decimal("0")

    await inv.act_on_adjustment(db, audit.id, "APPROVE", approver)
    # The shortfall came out of Brand A only; Brand B's balance is untouched.
    assert await _brand_stock(db, item, BRAND_A) == Decimal("6")
    assert await _brand_stock(db, item, BRAND_B) == Decimal("4")


async def test_the_same_brand_twice_on_one_audit_is_refused(db, make_user):
    raiser, _approver, wh, item = await _two_brands(db, make_user)
    with pytest.raises(ValidationError, match="twice"):
        await inv.create_stock_adjustment(db, AdjustmentIn(
            warehouse_id=wh.id, reason="SHORTAGE",
            items=[_brand_line(item, BRAND_A, physical=6),
                   _brand_line(item, BRAND_A, physical=7)]), raiser)


async def test_a_code_is_never_written_off_on_two_brand_lines(db, make_user):
    raiser, _approver, wh, item = await _lot(db, make_user, serial=True)
    # Codes carry no brand: two lines of one batch and location share one pool.
    with pytest.raises(ValidationError, match="picked on two lines"):
        await inv.create_stock_adjustment(db, AdjustmentIn(
            warehouse_id=wh.id, reason="DAMAGE",
            items=[_brand_line(item, 0, physical=11, codes=["S1"]),
                   _brand_line(item, BRAND_A, physical=0, codes=["S1"])]), raiser)
