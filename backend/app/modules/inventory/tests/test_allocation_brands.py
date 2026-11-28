"""One item asked for twice in one indent — "Any brand" beside a named brand (2026-11-28).

BHS/NSRCPH-01/2026-27/MI-IND0001 (cycle C2) asked for Oxytetracycline twice: 20 of any
brand and 30 of OXYDEEP. Every press of Submit on the cycle came back with "item 205
takes 50 from this warehouse, which can give 0". Three things were wrong, one per layer:

* the issue draft folded the two allocation lines into ONE item line, dropping the
  indent line and its brand, so the draft could not see the indent's own reservation;
* an "Any brand" line reserved the named brand's stock first (FEFO does not look at
  brands), leaving the named line short with its brand on the shelf;
* the screens counted the named brand's stock as free for the Any line too, so the
  proposal promised the same units twice and the save refused the whole indent.

DB-backed: they need real rows and the real issue builder.
"""
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.modules.indents.models import Indent, IndentItem
from app.modules.inventory import allocation
from app.modules.inventory.models import (
    NO_BIN, NO_PROJECT, Allocation, AllocationItem, Reservation, Stock,
)
from app.shared.enums import RefType, ReservationStatus
from app.shared.models.master import Brand, Item
from app.shared.models.warehouse import Warehouse

pytestmark = pytest.mark.asyncio


@pytest.fixture
def actor():
    return SimpleNamespace(id=1, full_name="Tester")


async def _setup(db):
    wh = Warehouse(code="WH-BR", name="Central", warehouse_type="MAIN", is_active=True)
    item = Item(code="INJ-OXY-0001", name="Oxytetracycline", uom_code="NOS",
                is_batch_tracked=True)
    brand = Brand(code="OXY", name="OXYDEEP")
    db.add_all([wh, item, brand])
    await db.flush()
    return wh, item, brand


async def _stock(db, item, wh, qty, *, brand_id=0, batch_id=0, expiry=None):
    row = Stock(item_id=item.id, item_code=item.code, item_name=item.name,
                warehouse_id=wh.id, warehouse_name=wh.name, bin_id=NO_BIN,
                batch_id=batch_id, project_id=NO_PROJECT, expiry_date=expiry,
                brand_id=brand_id, available_qty=Decimal(qty), reserved_qty=Decimal(0),
                total_qty=Decimal(qty))
    db.add(row)
    await db.flush()
    return row


async def test_an_any_brand_reservation_leaves_the_named_brand_for_its_own_line(db, actor):
    """The named brand sits in the EARLIEST batch. FEFO alone would hand it to the Any
    line; the Any line takes stock with no brand first."""
    wh, item, brand = await _setup(db)
    named = await _stock(db, item, wh, 10, brand_id=brand.id, batch_id=1,
                         expiry=date(2027, 1, 1))
    plain = await _stock(db, item, wh, 50, batch_id=2, expiry=date(2028, 1, 1))

    got, short = await allocation.reserve(
        db, item.id, Decimal(20), RefType.RESERVATION.value, 1, "IND-1", actor, item=item)

    assert (got, short) == (Decimal(20), Decimal(0))
    await db.refresh(named)
    await db.refresh(plain)
    assert named.available_qty == Decimal(10)   # untouched: OXYDEEP's line needs it
    assert plain.available_qty == Decimal(30)


async def test_an_any_brand_reservation_still_reaches_branded_stock_when_short(db, actor):
    """Preferring untagged stock is an order, never a filter."""
    wh, item, brand = await _setup(db)
    await _stock(db, item, wh, 5, brand_id=brand.id, batch_id=1)
    await _stock(db, item, wh, 5, batch_id=2)

    got, short = await allocation.reserve(
        db, item.id, Decimal(8), RefType.RESERVATION.value, 1, "IND-1", actor, item=item)
    assert (got, short) == (Decimal(8), Decimal(0))


async def test_the_issue_draft_keeps_one_line_per_indent_line(db, actor):
    """The C2 refusal. Two allocation lines of one item, two brands: the draft must
    carry two issue lines, each on its own indent line and combination."""
    from app.modules.warehouse import service as wh_service

    wh, item, brand = await _setup(db)
    await _stock(db, item, wh, 20)
    await _stock(db, item, wh, 30, brand_id=brand.id)

    indent = Indent(indent_no="MI-IND-T1", indent_type="MONTHLY",
                    indent_date=date.today(), status="AWAITING_ALLOCATION",
                    project_id=0)
    db.add(indent)
    await db.flush()
    any_line = IndentItem(indent_id=indent.id, line_no=1, item_id=item.id,
                          item_code=item.code, item_name=item.name, uom_code="NOS",
                          quantity=20, approved_quantity=20, combination_any=True)
    oxy_line = IndentItem(indent_id=indent.id, line_no=2, item_id=item.id,
                          item_code=item.code, item_name=item.name, uom_code="NOS",
                          quantity=30, approved_quantity=30, brand_id=brand.id,
                          brand_name=brand.name)
    db.add_all([any_line, oxy_line])
    await db.flush()

    # The reservations approval writes, one per indent line and combination.
    await allocation.reserve(db, item.id, Decimal(30), RefType.RESERVATION.value,
                             indent.id, indent.indent_no, actor, item=item,
                             ref_line_id=oxy_line.id,
                             combination={"brand_id": brand.id, "variant_id": 0,
                                          "model_id": 0, "no_brand": False})
    await allocation.reserve(db, item.id, Decimal(20), RefType.RESERVATION.value,
                             indent.id, indent.indent_no, actor, item=item,
                             ref_line_id=any_line.id)
    held = {row.ref_line_id: (row.quantity, row.brand_id) for row in (await db.execute(
        select(Reservation).where(Reservation.ref_id == indent.id,
                                  Reservation.status == ReservationStatus.ACTIVE.value)
    )).scalars().all()}
    assert held == {oxy_line.id: (Decimal(30), brand.id), any_line.id: (Decimal(20), 0)}

    alloc = Allocation(allocation_no="ALL-T1", indent_id=indent.id,
                       indent_no=indent.indent_no, status="APPROVED")
    db.add(alloc)
    await db.flush()
    db.add_all([
        AllocationItem(allocation_id=alloc.id, indent_item_id=any_line.id,
                       item_id=item.id, requested_qty=20, quantity=20,
                       warehouse_id=wh.id, warehouse_name=wh.name, combination_any=True),
        AllocationItem(allocation_id=alloc.id, indent_item_id=oxy_line.id,
                       item_id=item.id, requested_qty=30, quantity=30,
                       warehouse_id=wh.id, warehouse_name=wh.name, brand_id=brand.id),
    ])
    await db.flush()
    await db.refresh(alloc, ["items"])

    drafts = await wh_service.create_fulfilment_drafts_for_allocation(db, alloc, actor)

    assert len(drafts) == 1
    await db.refresh(drafts[0], ["items"])
    lines = {line.indent_item_id: (line.issued_qty, int(line.brand_id or 0))
             for line in drafts[0].items}
    assert lines == {any_line.id: (Decimal(20), 0),
                     oxy_line.id: (Decimal(30), brand.id)}
