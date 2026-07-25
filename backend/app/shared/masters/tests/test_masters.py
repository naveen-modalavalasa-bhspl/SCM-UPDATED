"""Masters CRUD through the MasterDef factory: permissions, deactivation, snapshots,
and the tree guards on categories and locations."""
import pytest

from app.core.exceptions import ValidationError
from app.platform.rbac import permissions as perms
from app.shared.masters.defs import ItemIn, apply_item, build_item_code
from app.shared.models.master import (
    Brand, BrandManufacturer, GeneralName, Item, ItemCategory, ItemClass,
    Manufacturer, Uom,
)
from app.shared.enums import BinType, WarehouseType

MANAGE_ALL = [perms.MASTER_ITEM_MANAGE, perms.MASTER_CATEGORY_MANAGE,
              perms.MASTER_UOM_MANAGE, perms.MASTER_LOCATION_MANAGE,
              perms.MASTER_VENDOR_MANAGE, perms.MASTER_PROJECT_MANAGE,
              perms.MASTER_BRAND_MANAGE, perms.MASTER_CLASS_MANAGE]


@pytest.fixture
async def admin(client, make_user, login):
    await make_user(employee_id=1, username="admin", password="pw",
                    permissions=MANAGE_ALL)
    return await login("admin", "pw")


@pytest.fixture
async def viewer(client, make_user, login):
    await make_user(employee_id=2, username="viewer", password="pw",
                    permissions=["indent.view"])
    return await login("viewer", "pw")


# ------------------------------- items ------------------------------- #
def test_generated_item_code_contains_all_identity_parts():
    assert build_item_code("101010", "slide", "lab", "acme") == \
        "101010-SLIDE-LAB-ACME"


def test_generated_item_code_rejects_an_incomplete_category_path():
    with pytest.raises(ValidationError, match="six-digit"):
        build_item_code("1010", "SLIDE", "LAB", "ACME")


async def item_payload(client, admin, *, name="Bolt"):
    """Create the identity masters needed by the generated item-code contract."""
    l1 = (await client.post("/api/item-categories",
                            json={"code": "L1", "name": "Level 1"},
                            headers=admin)).json()
    l2 = (await client.post("/api/item-categories",
                            json={"code": "L2", "name": "Level 2",
                                  "parent_id": l1["id"]},
                            headers=admin)).json()
    l3 = (await client.post("/api/item-categories",
                            json={"code": "L3", "name": "Level 3",
                                  "parent_id": l2["id"]},
                            headers=admin)).json()
    general = (await client.post("/api/general-names",
                                 json={"code": "GEN", "name": "General"},
                                 headers=admin)).json()
    brand = (await client.post("/api/brands",
                               json={"code": "BR", "name": "Brand"},
                               headers=admin)).json()
    manufacturer = (await client.post("/api/manufacturers",
                                      json={"code": "MFR", "name": "Maker"},
                                      headers=admin)).json()
    await client.post("/api/brand-manufacturers", json={
        "brand_id": brand["id"], "manufacturer_id": manufacturer["id"],
    }, headers=admin)
    item_class = (await client.post("/api/item-classes",
                                    json={"code": "CON", "name": "Consumable"},
                                    headers=admin)).json()
    uom = (await client.post("/api/uom", json={"code": "PCS", "name": "Pieces"},
                             headers=admin)).json()
    return {
        "name": name, "category_id": l3["id"], "general_name_id": general["id"],
        "brand_id": brand["id"], "manufacturer_id": manufacturer["id"],
        "item_class_id": item_class["id"], "uom_id": uom["id"],
    }


async def test_item_code_uses_category_general_brand_and_manufacturer(db):
    category = ItemCategory(
        code="MIC", name="Microscopy", level=3, segment_code="10",
        path="101010", is_active=True,
    )
    general = GeneralName(code="SLIDE", name="Microscope Slide", is_active=True)
    brand = Brand(code="LAB", name="Lab Brand", is_active=True)
    manufacturer = Manufacturer(code="ACME", name="Acme Medical", is_active=True)
    item_class = ItemClass(code="CON", name="Consumable", is_active=True)
    uom = Uom(code="PK", name="Pack", is_active=True)
    db.add_all([category, general, brand, manufacturer, item_class, uom])
    await db.flush()
    db.add(BrandManufacturer(
        brand_id=brand.id, manufacturer_id=manufacturer.id, is_active=True,
    ))
    await db.flush()

    item = Item()
    await apply_item(db, item, ItemIn(
        name="Microscope Slides", category_id=category.id,
        general_name_id=general.id, brand_id=brand.id,
        manufacturer_id=manufacturer.id, item_class_id=item_class.id,
        uom_id=uom.id,
    ))
    assert item.code == "101010-SLIDE-LAB-ACME"
    assert item.manufacturer_name == "Acme Medical"
    assert item.brand_name == "Lab Brand"


async def test_item_rejects_manufacturer_not_mapped_to_brand(db):
    category = ItemCategory(
        code="MIC", name="Microscopy", level=3, path="101010", is_active=True,
    )
    general = GeneralName(code="SLIDE", name="Slide", is_active=True)
    brand = Brand(code="LAB", name="Lab Brand", is_active=True)
    manufacturer = Manufacturer(code="OTHER", name="Other", is_active=True)
    item_class = ItemClass(code="CON", name="Consumable", is_active=True)
    uom = Uom(code="PK", name="Pack", is_active=True)
    db.add_all([category, general, brand, manufacturer, item_class, uom])
    await db.flush()
    with pytest.raises(ValidationError, match="not mapped"):
        await apply_item(db, Item(), ItemIn(
            name="Slides", category_id=category.id, general_name_id=general.id,
            brand_id=brand.id, manufacturer_id=manufacturer.id,
            item_class_id=item_class.id, uom_id=uom.id,
        ))


async def test_create_item_snapshots_uom_and_category(client, admin):
    r = await client.post("/api/items", json=await item_payload(client, admin),
                          headers=admin)
    assert r.status_code == 200, r.text
    body = r.json()
    # Snapshots let the item list render without joining two masters.
    assert body["uom_code"] == "PCS"
    assert body["category_name"] == "Level 3"
    assert body["code"] == "000000-GEN-BR-MFR"


async def test_item_list_is_paginated_and_searchable(client, admin):
    await client.post("/api/items",
                      json=await item_payload(client, admin, name="Widget 1"),
                      headers=admin)
    page = (await client.get("/api/items", headers=admin)).json()
    assert {"items", "total", "page", "size"} <= page.keys()
    assert page["total"] == 1

    found = (await client.get("/api/items?search=Widget 1", headers=admin)).json()
    assert [i["name"] for i in found["items"]] == ["Widget 1"]


async def test_deactivate_hides_item_from_the_default_list(client, admin):
    item = (await client.post(
        "/api/items", json=await item_payload(client, admin, name="Old"),
        headers=admin,
    )).json()

    assert (await client.delete(f"/api/items/{item['id']}",
                                headers=admin)).status_code == 200
    assert (await client.get("/api/items", headers=admin)).json()["total"] == 0
    # Still retrievable, because documents reference it by id.
    shown = (await client.get("/api/items?include_inactive=true", headers=admin)).json()
    assert shown["total"] == 1
    assert shown["items"][0]["is_active"] is False


async def test_write_requires_the_manage_permission(client, viewer):
    r = await client.post("/api/items", json={
        "name": "X", "category_id": 1, "general_name_id": 1, "brand_id": 1,
        "manufacturer_id": 1, "item_class_id": 1, "uom_id": 1,
    }, headers=viewer)
    assert r.status_code == 403


async def test_read_is_open_to_any_authenticated_user(client, viewer):
    """Every module's dropdowns read masters, so GET must not need a manage code."""
    assert (await client.get("/api/items", headers=viewer)).status_code == 200


async def test_unauthenticated_read_is_rejected(client):
    assert (await client.get("/api/items")).status_code == 401


async def test_update_missing_row_is_404(client, admin):
    r = await client.put("/api/items/9999", json={
        "name": "A", "category_id": 1, "general_name_id": 1, "brand_id": 1,
        "manufacturer_id": 1, "item_class_id": 1, "uom_id": 1,
    }, headers=admin)
    assert r.status_code == 404


# ---------------------------- categories ---------------------------- #
async def test_subcategory_level_is_derived_from_the_parent(client, admin):
    parent = (await client.post("/api/item-categories",
                                json={"code": "P", "name": "Parent"},
                                headers=admin)).json()
    child = (await client.post("/api/item-categories",
                               json={"code": "C", "name": "Child",
                                     "parent_id": parent["id"]},
                               headers=admin)).json()
    assert parent["level"] == 1
    assert child["level"] == 2


async def test_category_cannot_be_its_own_parent(client, admin):
    cat = (await client.post("/api/item-categories", json={"code": "S", "name": "Self"},
                             headers=admin)).json()
    r = await client.put(f"/api/item-categories/{cat['id']}",
                         json={"code": "S", "name": "Self", "parent_id": cat["id"]},
                         headers=admin)
    assert r.status_code == 400


# ------------------------ warehouses and bins ------------------------ #
async def warehouse(client, admin, code="WH1", name="Main Warehouse"):
    return (await client.post("/api/warehouses", json={
        "code": code, "name": name, "warehouse_type": WarehouseType.MAIN.value,
        "is_bin_managed": True}, headers=admin)).json()


async def test_create_warehouse(client, admin):
    body = await warehouse(client, admin)
    assert body["code"] == "WH1"
    assert body["is_bin_managed"] is True


async def test_invalid_warehouse_type_is_rejected(client, admin):
    r = await client.post("/api/warehouses", json={
        "code": "X", "name": "X", "warehouse_type": "MOON"}, headers=admin)
    assert r.status_code == 400


async def test_bin_path_and_level_derive_from_the_parent(client, admin):
    wh = await warehouse(client, admin)
    zone = (await client.post("/api/bins", json={
        "warehouse_id": wh["id"], "code": "A", "name": "Zone A",
        "bin_type": BinType.ZONE.value}, headers=admin)).json()
    rack = (await client.post("/api/bins", json={
        "warehouse_id": wh["id"], "code": "A-01", "name": "Rack 1",
        "bin_type": BinType.RACK.value, "parent_id": zone["id"]}, headers=admin)).json()

    assert (zone["path"], zone["level"]) == ("A", 1)
    assert (rack["path"], rack["level"]) == ("A/A-01", 2)


async def test_invalid_bin_type_is_rejected(client, admin):
    wh = await warehouse(client, admin)
    r = await client.post("/api/bins", json={
        "warehouse_id": wh["id"], "code": "X", "bin_type": "CUPBOARD"}, headers=admin)
    assert r.status_code == 400


async def test_bin_parent_must_be_in_the_same_warehouse(client, admin):
    first = await warehouse(client, admin, "WH1", "One")
    second = await warehouse(client, admin, "WH2", "Two")
    zone = (await client.post("/api/bins", json={
        "warehouse_id": first["id"], "code": "A",
        "bin_type": BinType.ZONE.value}, headers=admin)).json()

    r = await client.post("/api/bins", json={
        "warehouse_id": second["id"], "code": "B", "bin_type": BinType.RACK.value,
        "parent_id": zone["id"]}, headers=admin)
    assert r.status_code == 400


async def test_bin_loop_is_rejected(client, admin):
    wh = await warehouse(client, admin)
    a = (await client.post("/api/bins", json={
        "warehouse_id": wh["id"], "code": "A",
        "bin_type": BinType.ZONE.value}, headers=admin)).json()
    b = (await client.post("/api/bins", json={
        "warehouse_id": wh["id"], "code": "B", "bin_type": BinType.RACK.value,
        "parent_id": a["id"]}, headers=admin)).json()

    # Making A a child of B would close the loop A -> B -> A.
    r = await client.put(f"/api/bins/{a['id']}", json={
        "warehouse_id": wh["id"], "code": "A", "bin_type": BinType.ZONE.value,
        "parent_id": b["id"]}, headers=admin)
    assert r.status_code == 400


# ----------------------------- projects ----------------------------- #
async def test_create_project(client, admin):
    r = await client.post("/api/projects",
                          json={"code": "PRJ-01", "name": "Metro Line 3"},
                          headers=admin)
    assert r.status_code == 200, r.text
    assert r.json()["code"] == "PRJ-01"


async def test_project_end_date_cannot_precede_start(client, admin):
    r = await client.post("/api/projects", json={
        "code": "PRJ-02", "name": "Bad", "start_date": "2026-12-01",
        "end_date": "2026-01-01"}, headers=admin)
    assert r.status_code == 400


# -------------------------- UOM conversions -------------------------- #
async def test_uom_conversion_snapshots_both_codes(client, admin):
    box = (await client.post("/api/uom", json={"code": "BOX", "name": "Box"},
                             headers=admin)).json()
    pcs = (await client.post("/api/uom", json={"code": "PCS", "name": "Pieces"},
                             headers=admin)).json()

    r = await client.post("/api/uom-conversions", json={
        "from_uom_id": box["id"], "to_uom_id": pcs["id"], "factor": 12},
        headers=admin)
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["from_uom_code"], body["to_uom_code"], body["factor"]) == \
        ("BOX", "PCS", 12.0)


async def test_uom_cannot_convert_to_itself(client, admin):
    pcs = (await client.post("/api/uom", json={"code": "PCS", "name": "Pieces"},
                             headers=admin)).json()
    r = await client.post("/api/uom-conversions", json={
        "from_uom_id": pcs["id"], "to_uom_id": pcs["id"], "factor": 1}, headers=admin)
    assert r.status_code == 400


async def test_conversion_factor_must_be_positive(client, admin):
    a = (await client.post("/api/uom", json={"code": "A", "name": "A"},
                           headers=admin)).json()
    b = (await client.post("/api/uom", json={"code": "B", "name": "B"},
                           headers=admin)).json()
    r = await client.post("/api/uom-conversions", json={
        "from_uom_id": a["id"], "to_uom_id": b["id"], "factor": 0}, headers=admin)
    assert r.status_code == 400
