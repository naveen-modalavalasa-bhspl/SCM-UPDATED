"""Box labels, narrowed warehouse -> item -> batch -> storage location (2026-11-02).

What these pin: each step of the screen's cascade offers only what holds labels, with
the count, and the list is read off the PACK's batch and location — so a box moved to
another bay is listed where it stands now, not where its label text says it was coded.
"""
from datetime import date
from decimal import Decimal

import pytest

from app.modules.warehouse import models as m
from app.modules.warehouse.enums import STOCK_VIEW
from app.shared.models.master import Item
from app.shared.models.warehouse import Warehouse

pytestmark = pytest.mark.asyncio


async def test_the_cascade_offers_items_batches_and_locations_and_filters_the_list(
    db, client, make_user, login,
):
    wh = Warehouse(code="WH-BLC", name="Main store", warehouse_type="MAIN",
                   is_bin_managed=True, is_active=True)
    other = Warehouse(code="WH-BLX", name="Other store", warehouse_type="MAIN",
                      is_bin_managed=True, is_active=True)
    tabs = Item(code="PHA-GEN-0101", name="Tablets", uom_code="TAB", requires_qi=False, is_active=True)
    gloves = Item(code="CON-GEN-0102", name="Gloves", uom_code="PR", requires_qi=False, is_active=True)
    db.add_all([wh, other, tabs, gloves])
    await db.commit()
    early = m.Batch(batch_no="B-EARLY", item_id=tabs.id, expiry_date=date(2027, 1, 31))
    late = m.Batch(batch_no="B-LATE", item_id=tabs.id, expiry_date=date(2028, 1, 31))
    bay1 = m.WarehouseLocation(warehouse_id=wh.id, code="A1-R1-B1", name="Bay 1")
    bay2 = m.WarehouseLocation(warehouse_id=wh.id, code="A1-R1-B2", name="Bay 2")
    db.add_all([early, late, bay1, bay2])
    await db.commit()

    def pack(code, item, batch, bay, wh_id=wh.id):
        return m.HandlingUnit(hu_code=code, item_id=item.id, warehouse_id=wh_id, pack_hierarchy_id=1,
                              level=2, pack_name="Box", pack_size=Decimal(100), status="SEALED",
                              batch_id=batch.id if batch else 0, bin_id=bay.id if bay else 0)

    packs = [
        pack("BX-1", tabs, early, bay1), pack("BX-2", tabs, early, bay2),
        pack("BX-3", tabs, late, bay2), pack("BX-4", gloves, None, bay1),
        pack("BX-5", tabs, early, None, wh_id=other.id),
    ]
    db.add_all(packs)
    await db.commit()
    db.add_all([
        m.BoxLabel(handling_unit_id=hu.id, hu_code=hu.hu_code, item_id=hu.item_id,
                   item_code=(tabs if hu.item_id == tabs.id else gloves).code,
                   item_name=(tabs if hu.item_id == tabs.id else gloves).name,
                   warehouse_id=hu.warehouse_id, content_qty=Decimal(100), pack_size=Decimal(100),
                   reason="PUTAWAY", status="QUEUED",
                   # The label's own text says bay 1; the pack is the truth.
                   bin_code="A1-R1-B1")
        for hu in packs
    ])
    await db.commit()

    await make_user(username="labeller", permissions=[STOCK_VIEW])
    headers = await login("labeller", "pw")

    got = await client.get("/api/warehouse/box-labels/facets",
                           params={"warehouse_id": wh.id, "status": "QUEUED"}, headers=headers)
    assert got.status_code == 200, got.text
    facets = got.json()
    assert {(i["item_name"], i["count"]) for i in facets["items"]} == {("Tablets", 3), ("Gloves", 1)}
    assert facets["batches"] == [] and facets["locations"] == []

    got = await client.get("/api/warehouse/box-labels/facets",
                           params={"warehouse_id": wh.id, "item_id": tabs.id}, headers=headers)
    facets = got.json()
    assert [(b["batch_no"], b["count"]) for b in facets["batches"]] == [("B-EARLY", 2), ("B-LATE", 1)]
    assert {(loc["bin_code"], loc["count"]) for loc in facets["locations"]} == {("A1-R1-B1", 1), ("A1-R1-B2", 2)}

    got = await client.get("/api/warehouse/box-labels/facets",
                           params={"warehouse_id": wh.id, "item_id": tabs.id, "batch_id": early.id},
                           headers=headers)
    assert {(loc["bin_code"], loc["count"]) for loc in got.json()["locations"]} == {
        ("A1-R1-B1", 1), ("A1-R1-B2", 1)}

    listed = await client.get("/api/warehouse/box-labels", headers=headers, params={
        "warehouse_id": wh.id, "item_id": tabs.id, "batch_id": early.id, "bin_id": bay2.id})
    assert listed.status_code == 200, listed.text
    assert [r["hu_code"] for r in listed.json()["items"]] == ["BX-2"]

    gloves_none = await client.get("/api/warehouse/box-labels", headers=headers, params={
        "warehouse_id": wh.id, "item_id": gloves.id, "batch_id": 0})
    assert [r["hu_code"] for r in gloves_none.json()["items"]] == ["BX-4"]
