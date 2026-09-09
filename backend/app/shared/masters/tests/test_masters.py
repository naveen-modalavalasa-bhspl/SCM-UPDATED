"""Masters CRUD through the MasterDef factory: permissions, deactivation, snapshots,
and the tree guards on categories and locations."""
import pytest

from app.core.exceptions import ValidationError
from app.platform.rbac import permissions as perms
from app.shared.masters.defs import ItemIn, apply_item, build_item_code
from app.shared.models.master import (
    Brand, BrandManufacturer, GeneralName, HsnCode, Item, ItemCategory, ItemClass,
    Manufacturer, Project, Uom,
)
from app.shared.enums import BinType, WarehouseType

MANAGE_ALL = [perms.MASTER_ITEM_MANAGE, perms.MASTER_CATEGORY_MANAGE,
              perms.MASTER_UOM_MANAGE, perms.MASTER_LOCATION_MANAGE,
              perms.MASTER_VENDOR_MANAGE, perms.MASTER_PROJECT_MANAGE,
              perms.MASTER_BRAND_MANAGE, perms.MASTER_CLASS_MANAGE,
              perms.MASTER_HSN_MANAGE, perms.MASTER_PACKAGING_MANAGE,
              perms.MASTER_BOM_MANAGE, perms.MASTER_ATTRIBUTE_MANAGE,
              perms.MASTER_SPEC_MANAGE, perms.MASTER_FEATURE_MANAGE]


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
    assert build_item_code("101010", "slide", "lab", "acme", 1) == \
        "101010-SLIDE-LAB-ACME-0001"


def test_generated_item_code_accepts_hyphenated_master_codes():
    assert build_item_code("161010", "GN-003", "DOLO650", "RAMESHLABS", 1) == \
        "161010-GN-003-DOLO650-RAMESHLABS-0001"


@pytest.mark.parametrize("code", ["-GN003", "GN003-", "GN--003", "GN 003", "GN_003"])
def test_generated_item_code_rejects_malformed_master_codes(code):
    with pytest.raises(ValidationError, match="internal hyphens"):
        build_item_code("161010", code, "DOLO650", "RAMESHLABS", 1)


def test_generated_item_code_rejects_an_incomplete_category_path():
    with pytest.raises(ValidationError, match="six-digit"):
        build_item_code("1010", "SLIDE", "LAB", "ACME", 1)


def test_generated_item_code_pads_the_serial_to_four_digits():
    assert build_item_code("101010", "PARACET", "DOLO", "DOLO", 42) == \
        "101010-PARACET-DOLO-DOLO-0042"


def test_a_prefix_runs_out_after_9999_items():
    with pytest.raises(ValidationError, match="9999"):
        build_item_code("101010", "SLIDE", "LAB", "ACME", 10000)


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
    manufacturer = (await client.post("/api/manufacturers",
                                      json={"code": "MFR", "name": "Maker"},
                                      headers=admin)).json()
    # The brand carries its manufacturers, so no second call to a mapping screen.
    brand = (await client.post("/api/brands",
                               json={"code": "BR", "name": "Brand",
                                     "manufacturer_ids": [manufacturer["id"]]},
                               headers=admin)).json()
    item_class = (await client.post("/api/item-classes",
                                    json={"code": "CON", "name": "Consumable"},
                                    headers=admin)).json()
    uom = (await client.post("/api/uom", json={"code": "PCS", "name": "Pieces", "uom_class": "COUNT"},
                             headers=admin)).json()
    hsn = (await client.post("/api/hsn-codes",
                             json={"code": "73181500", "cgst_rate": 9,
                                   "sgst_rate": 9, "igst_rate": 18},
                             headers=admin)).json()
    return {
        "name": name, "category_id": l3["id"], "general_name_id": general["id"],
        "brand_id": brand["id"], "manufacturer_id": manufacturer["id"],
        "item_class_id": item_class["id"], "uom_id": uom["id"],
        "hsn_id": hsn["id"],
    }


async def test_identity_masters_accept_internal_hyphens(client, admin):
    general = await client.post("/api/general-names", json={
        "code": "GN-003", "name": "Absorbent Cotton"}, headers=admin)
    manufacturer = await client.post("/api/manufacturers", json={
        "code": "LABS-01", "name": "Labs 01"}, headers=admin)
    assert general.status_code == 200, general.text
    assert manufacturer.status_code == 200, manufacturer.text


async def test_item_code_uses_category_general_brand_and_manufacturer(db):
    category = ItemCategory(
        code="MIC", name="Microscopy", level=3, segment_code="10",
        path="101010", is_active=True,
    )
    general = GeneralName(code="SLIDE", name="Microscope Slide", is_active=True)
    brand = Brand(code="LAB", name="Lab Brand", is_active=True)
    manufacturer = Manufacturer(code="ACME", name="Acme Medical", is_active=True)
    item_class = ItemClass(code="CON", name="Consumable", is_active=True)
    uom = Uom(code="PK", name="Pack", uom_class="PACKAGING", is_active=True)
    hsn = HsnCode(code="90118000", is_active=True)
    db.add_all([category, general, brand, manufacturer, item_class, uom, hsn])
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
        uom_id=uom.id, hsn_id=hsn.id,
    ))
    assert item.code == "101010-SLIDE-LAB-ACME-0001"
    assert item.serial_no == 1
    assert item.manufacturer_name == "Acme Medical"
    assert item.brand_name == "Lab Brand"
    assert item.hsn_code == "90118000"


async def test_item_rejects_manufacturer_not_mapped_to_brand(db):
    category = ItemCategory(
        code="MIC", name="Microscopy", level=3, path="101010", is_active=True,
    )
    general = GeneralName(code="SLIDE", name="Slide", is_active=True)
    brand = Brand(code="LAB", name="Lab Brand", is_active=True)
    manufacturer = Manufacturer(code="OTHER", name="Other", is_active=True)
    item_class = ItemClass(code="CON", name="Consumable", is_active=True)
    uom = Uom(code="PK", name="Pack", uom_class="PACKAGING", is_active=True)
    hsn = HsnCode(code="90118000", is_active=True)
    db.add_all([category, general, brand, manufacturer, item_class, uom, hsn])
    await db.flush()
    with pytest.raises(ValidationError, match="not mapped"):
        await apply_item(db, Item(), ItemIn(
            name="Slides", category_id=category.id, general_name_id=general.id,
            brand_id=brand.id, manufacturer_id=manufacturer.id,
            item_class_id=item_class.id, uom_id=uom.id, hsn_id=hsn.id,
        ))


async def test_create_item_snapshots_uom_and_category(client, admin):
    r = await client.post("/api/items", json=await item_payload(client, admin),
                          headers=admin)
    assert r.status_code == 200, r.text
    body = r.json()
    # Snapshots let the item list render without joining two masters.
    assert body["uom_code"] == "PCS"
    assert body["category_name"] == "Level 3"
    assert body["code"] == "000000-GEN-BR-MFR-0001"


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
        "manufacturer_id": 1, "item_class_id": 1, "uom_id": 1, "hsn_id": 1,
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
        "manufacturer_id": 1, "item_class_id": 1, "uom_id": 1, "hsn_id": 1,
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
    assert r.status_code == 422


async def test_two_level_1_categories_cannot_share_a_name(client, admin):
    await client.post("/api/item-categories",
                      json={"code": "F1", "name": "Furniture"}, headers=admin)
    r = await client.post("/api/item-categories",
                          json={"code": "F2", "name": "Furniture"}, headers=admin)
    assert r.status_code == 422
    assert "already exists" in r.json()["error"]


async def test_a_level_1_name_may_reappear_as_a_level_2(client, admin):
    """Furniture is a Level 1 in its own right and a Level 2 under Office Supplies.
    The rule is one name per parent, not one name per level."""
    office = (await client.post("/api/item-categories",
                                json={"code": "OFF", "name": "Office Supplies"},
                                headers=admin)).json()
    await client.post("/api/item-categories",
                      json={"code": "FUR", "name": "Furniture"}, headers=admin)
    r = await client.post("/api/item-categories",
                          json={"code": "OFUR", "name": "Furniture",
                                "parent_id": office["id"]}, headers=admin)
    assert r.status_code == 200, r.text
    assert r.json()["level"] == 2


async def test_two_children_of_one_parent_cannot_share_a_name(client, admin):
    parent = (await client.post("/api/item-categories",
                                json={"code": "P", "name": "Parent"},
                                headers=admin)).json()
    await client.post("/api/item-categories",
                      json={"code": "C1", "name": "Chairs", "parent_id": parent["id"]},
                      headers=admin)
    r = await client.post("/api/item-categories",
                          json={"code": "C2", "name": "Chairs",
                                "parent_id": parent["id"]}, headers=admin)
    assert r.status_code == 422


async def test_renaming_a_category_does_not_clash_with_itself(client, admin):
    cat = (await client.post("/api/item-categories",
                             json={"code": "K", "name": "Kitchen"},
                             headers=admin)).json()
    r = await client.put(f"/api/item-categories/{cat['id']}",
                         json={"code": "K", "name": "Kitchen"}, headers=admin)
    assert r.status_code == 200, r.text


# ---------------------------- item classes ---------------------------- #
async def test_item_class_name_is_unique_case_insensitively(client, admin):
    await client.post("/api/item-classes", json={"code": "CON", "name": "Consumable"},
                      headers=admin)
    r = await client.post("/api/item-classes",
                          json={"code": "CON2", "name": "consumable"}, headers=admin)
    assert r.status_code == 422


async def test_item_class_no_longer_reports_an_asset_flag(client, admin):
    """Asset-ness moved to the item: one class holds both a laptop and a mouse."""
    body = (await client.post("/api/item-classes",
                              json={"code": "IT", "name": "IT Equipment"},
                              headers=admin)).json()
    assert "is_capitalised" not in body


# ------------------------------ brands ------------------------------ #
async def test_a_brand_carries_many_manufacturers(client, admin):
    first = (await client.post("/api/manufacturers",
                               json={"code": "M1", "name": "Plant One"},
                               headers=admin)).json()
    second = (await client.post("/api/manufacturers",
                                json={"code": "M2", "name": "Plant Two"},
                                headers=admin)).json()
    body = (await client.post("/api/brands", json={
        "code": "DOLO", "name": "Dolo",
        "manufacturer_ids": [first["id"], second["id"]]}, headers=admin)).json()
    assert set(body["manufacturer_ids"]) == {first["id"], second["id"]}
    assert set(body["manufacturer_names"]) == {"Plant One", "Plant Two"}


async def test_removing_a_manufacturer_deactivates_the_link(client, admin):
    """Deactivated, never deleted: items already carry the pair, and the row is what
    proves it was once a legal combination."""
    first = (await client.post("/api/manufacturers",
                               json={"code": "M1", "name": "Plant One"},
                               headers=admin)).json()
    second = (await client.post("/api/manufacturers",
                                json={"code": "M2", "name": "Plant Two"},
                                headers=admin)).json()
    brand = (await client.post("/api/brands", json={
        "code": "DOLO", "name": "Dolo",
        "manufacturer_ids": [first["id"], second["id"]]}, headers=admin)).json()

    updated = (await client.put(f"/api/brands/{brand['id']}", json={
        "code": "DOLO", "name": "Dolo",
        "manufacturer_ids": [first["id"]]}, headers=admin)).json()
    assert updated["manufacturer_ids"] == [first["id"]]

    links = (await client.get(f"/api/brand-manufacturers?brand_id={brand['id']}",
                              headers=admin)).json()["items"]
    assert {l["manufacturer_id"]: l["is_active"] for l in links} == {
        first["id"]: True, second["id"]: False,
    }


async def test_brand_name_is_unique(client, admin):
    await client.post("/api/brands", json={"code": "B1", "name": "Dolo"},
                      headers=admin)
    r = await client.post("/api/brands", json={"code": "B2", "name": "DOLO"},
                          headers=admin)
    assert r.status_code == 422


async def test_brand_rejects_a_manufacturer_that_does_not_exist(client, admin):
    r = await client.post("/api/brands", json={
        "code": "B1", "name": "Ghost", "manufacturer_ids": [9999]}, headers=admin)
    assert r.status_code == 422


# ------------------------------- HSN -------------------------------- #
async def test_create_hsn_code(client, admin):
    r = await client.post("/api/hsn-codes", json={
        "code": "30049099", "description": "Medicaments",
        "cgst_rate": 6, "sgst_rate": 6, "igst_rate": 12}, headers=admin)
    assert r.status_code == 200, r.text
    assert r.json()["igst_rate"] == 12.0


async def test_hsn_rejects_cgst_plus_sgst_that_disagrees_with_igst(client, admin):
    """The two GST routes must charge the same total, or the same sale would be
    taxed differently depending on where the buyer is."""
    r = await client.post("/api/hsn-codes", json={
        "code": "30049099", "cgst_rate": 6, "sgst_rate": 6, "igst_rate": 18},
        headers=admin)
    assert r.status_code == 422


async def test_hsn_code_must_be_digits(client, admin):
    r = await client.post("/api/hsn-codes", json={"code": "ABCD"}, headers=admin)
    assert r.status_code == 422


async def test_hsn_code_must_be_exactly_eight_digits(client, admin):
    for code in ("1006301", "100630100"):
        r = await client.post("/api/hsn-codes", json={"code": code}, headers=admin)
        assert r.status_code == 422


async def test_item_entry_can_register_a_provisional_hsn(client, admin):
    created = await client.post("/api/hsn-codes/resolve",
                                json={"code": "10063010"}, headers=admin)
    assert created.status_code == 200, created.text
    assert created.json()["code"] == "10063010"
    assert created.json()["igst_rate"] == 0

    # Resolving the same code again selects the existing master row.
    resolved = await client.post("/api/hsn-codes/resolve",
                                 json={"code": "10063010"}, headers=admin)
    assert resolved.json()["id"] == created.json()["id"]


async def test_hsn_code_is_unique(client, admin):
    await client.post("/api/hsn-codes", json={"code": "30049099"}, headers=admin)
    r = await client.post("/api/hsn-codes", json={"code": "30049099"}, headers=admin)
    assert r.status_code == 422


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
    assert r.status_code == 422


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
    assert r.status_code == 422


async def test_bin_parent_must_be_in_the_same_warehouse(client, admin):
    first = await warehouse(client, admin, "WH1", "One")
    second = await warehouse(client, admin, "WH2", "Two")
    zone = (await client.post("/api/bins", json={
        "warehouse_id": first["id"], "code": "A",
        "bin_type": BinType.ZONE.value}, headers=admin)).json()

    r = await client.post("/api/bins", json={
        "warehouse_id": second["id"], "code": "B", "bin_type": BinType.RACK.value,
        "parent_id": zone["id"]}, headers=admin)
    assert r.status_code == 422


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
    assert r.status_code == 422


# ----------------------------- projects ----------------------------- #
async def test_projects_can_be_read(client, admin, db):
    db.add(Project(code="PRJ-01", name="Metro Line 3", is_active=True))
    await db.commit()
    page = (await client.get("/api/projects", headers=admin)).json()
    assert [p["code"] for p in page["items"]] == ["PRJ-01"]


async def test_projects_cannot_be_written_locally(client, admin):
    """HCM owns projects. The write routes must not exist — hiding the button is
    not enough, because the next sync would silently overwrite a local edit."""
    # 405 on the collection: the path exists but only answers GET. 404 on a row:
    # /api/projects/{id} was never registered at all, so there is nothing to answer.
    created = await client.post("/api/projects",
                                json={"code": "PRJ-02", "name": "Local"},
                                headers=admin)
    assert created.status_code == 405
    assert (await client.put("/api/projects/1", json={"code": "X", "name": "X"},
                             headers=admin)).status_code == 404
    assert (await client.delete("/api/projects/1", headers=admin)).status_code == 404


# ---------------------------- item identity ---------------------------- #
async def test_a_second_item_on_the_same_prefix_gets_the_next_serial(client, admin):
    """Dolo 650 and Dolo 500 share every part of the code but the serial."""
    payload = await item_payload(client, admin, name="Bolt M8")
    first = (await client.post("/api/items", json=payload, headers=admin)).json()
    second = (await client.post(
        "/api/items", json={**payload, "name": "Bolt M10"}, headers=admin)).json()
    assert first["code"].endswith("-0001")
    assert second["code"].endswith("-0002")
    assert (first["serial_no"], second["serial_no"]) == (1, 2)


async def test_editing_an_item_never_renumbers_it(client, admin):
    """The code is on stock rows, ledger entries and documents. Re-deriving it on
    an edit would silently point them all somewhere else."""
    payload = await item_payload(client, admin, name="Bolt")
    item = (await client.post("/api/items", json=payload, headers=admin)).json()
    updated = (await client.put(f"/api/items/{item['id']}",
                                json={**payload, "name": "Bolt renamed"},
                                headers=admin)).json()
    assert updated["code"] == item["code"]
    assert updated["name"] == "Bolt renamed"


async def test_an_item_cannot_be_saved_without_an_hsn(client, admin):
    payload = await item_payload(client, admin)
    payload.pop("hsn_id")
    r = await client.post("/api/items", json=payload, headers=admin)
    assert r.status_code == 422


async def test_item_records_the_asset_choice_but_generates_no_code(client, admin):
    """Asset and consumable codes are generated during putaway in the warehouse
    module, so the item master records only the choice."""
    payload = await item_payload(client, admin)
    body = (await client.post("/api/items", json={**payload, "is_asset": True},
                              headers=admin)).json()
    assert body["is_asset"] is True
    assert body["code"].endswith("-0001")


async def test_item_can_be_imei_tracked(client, admin):
    payload = await item_payload(client, admin)
    body = (await client.post("/api/items",
                              json={**payload, "is_imei_tracked": True},
                              headers=admin)).json()
    assert body["is_imei_tracked"] is True


async def test_pricing_and_stock_limits_are_no_longer_part_of_an_item(client, admin):
    """Tax comes from the HSN row and reorder levels are a warehouse decision, so
    neither is typed here or reported back."""
    body = (await client.post("/api/items", json=await item_payload(client, admin),
                              headers=admin)).json()
    for gone in ("purchase_price", "selling_price", "mrp", "cgst_rate",
                 "sgst_rate", "igst_rate", "tax_percent", "safety_stock",
                 "reorder_level", "reorder_qty", "shelf_life_days"):
        assert gone not in body


# ------------------------------- specs ------------------------------- #
@pytest.fixture
async def tagger(client, make_user, login):
    """Someone who maintains what an item can be described by, but not items."""
    await make_user(employee_id=7, username="tagger", password="pw",
                    permissions=[perms.MASTER_SPEC_MANAGE, perms.MASTER_UOM_MANAGE,
                                 perms.MASTER_ATTRIBUTE_MANAGE,
                                 perms.MASTER_CATEGORY_MANAGE,
                                 perms.MASTER_FEATURE_MANAGE])
    return await login("tagger", "pw")


async def test_a_spec_carries_a_real_uom(client, tagger):
    uom = (await client.post("/api/uom", json={"code": "V", "name": "Volt",
                                               "uom_class": "ENERGY"},
                             headers=tagger)).json()
    body = (await client.post("/api/specs", json={
        "code": "OP_VOLTAGE", "name": "Operating voltage", "uom_id": uom["id"]},
        headers=tagger)).json()
    assert body["uom_code"] == "V"


async def test_spec_name_is_unique(client, tagger):
    await client.post("/api/specs", json={"code": "W", "name": "Weight"},
                      headers=tagger)
    r = await client.post("/api/specs", json={"code": "W2", "name": "weight"},
                          headers=tagger)
    assert r.status_code == 422


async def test_an_attribute_takes_a_uom_row_not_free_text(client, tagger):
    uom = (await client.post("/api/uom", json={"code": "MM", "name": "Millimetre",
                                               "uom_class": "LENGTH"},
                             headers=tagger)).json()
    body = (await client.post("/api/attributes", json={
        "code": "CLEARANCE", "name": "Clearance", "data_type": "NUMBER",
        "uom_id": uom["id"]}, headers=tagger)).json()
    assert body["uom_code"] == "MM"
    assert "unit" not in body


# -------------------------- category tagging -------------------------- #
async def test_one_screen_tags_attributes_specs_and_features(client, tagger):
    """All three answer the same two questions of a category, so they share a
    table instead of needing three near-identical ones."""
    category = (await client.post("/api/item-categories",
                                  json={"code": "ELEC", "name": "Electrical"},
                                  headers=tagger)).json()
    attribute = (await client.post("/api/attributes", json={
        "code": "MATERIAL", "name": "Material", "data_type": "LIST",
        "allowed_values": ["Steel", "Copper"]}, headers=tagger)).json()
    uom = (await client.post("/api/uom", json={"code": "V", "name": "Volt",
                                               "uom_class": "ENERGY"},
                             headers=tagger)).json()
    spec = (await client.post("/api/specs", json={
        "code": "VOLTAGE", "name": "Voltage", "uom_id": uom["id"]},
        headers=tagger)).json()
    feature = (await client.post("/api/features", json={
        "code": "FRAGILE", "name": "Fragile"}, headers=tagger)).json()

    for tag_type, target, required in (("ATTRIBUTE", attribute, False),
                                       ("SPEC", spec, True),
                                       ("FEATURE", feature, False)):
        r = await client.post("/api/category-tags", json={
            "category_id": category["id"], "tag_type": tag_type,
            "tag_id": target["id"], "is_required": required}, headers=tagger)
        assert r.status_code == 200, r.text

    rows = (await client.get(f"/api/category-tags?category_id={category['id']}",
                             headers=tagger)).json()["items"]
    assert {r["tag_type"] for r in rows} == {"ATTRIBUTE", "SPEC", "FEATURE"}
    # A spec's unit rides along so the item form can label the input.
    voltage = next(r for r in rows if r["tag_type"] == "SPEC")
    assert (voltage["tag_uom_code"], voltage["is_required"]) == ("V", True)


async def test_the_same_thing_cannot_be_tagged_to_a_category_twice(client, tagger):
    category = (await client.post("/api/item-categories",
                                  json={"code": "C", "name": "Cables"},
                                  headers=tagger)).json()
    feature = (await client.post("/api/features", json={
        "code": "FRAGILE", "name": "Fragile"}, headers=tagger)).json()
    body = {"category_id": category["id"], "tag_type": "FEATURE",
            "tag_id": feature["id"]}
    assert (await client.post("/api/category-tags", json=body,
                              headers=tagger)).status_code == 200
    assert (await client.post("/api/category-tags", json=body,
                              headers=tagger)).status_code == 422


async def test_an_unknown_tag_type_is_rejected(client, tagger):
    category = (await client.post("/api/item-categories",
                                  json={"code": "C", "name": "Cables"},
                                  headers=tagger)).json()
    r = await client.post("/api/category-tags", json={
        "category_id": category["id"], "tag_type": "COLOUR", "tag_id": 1},
        headers=tagger)
    assert r.status_code == 422


# ------------------------- packaging ladder -------------------------- #
async def test_a_container_type_carries_its_own_box_but_not_what_it_holds(client, admin):
    """The line the packaging master is drawn along.

    The spec here is the CONTAINER'S — its outer box empty, its tare weight, the
    handling rules that follow from how it is built — because none of that depends on
    what goes inside, and a warehouse checks a bin against those measurements. How MUCH
    it holds, and what it weighs full, are not here: the same box takes 50 SIM cards or
    4 litres of oil, so both belong to each item's own rung.
    """
    body = (await client.post("/api/packaging", json={
        "code": "TOTE", "name": "Tote", "length_cm": 60, "width_cm": 40,
        "height_cm": 32, "weight_kg": 1.8, "max_stack_tiers": 4,
        "fill_efficiency_pct": 75}, headers=admin)).json()

    assert body["length_cm"] == 60
    assert body["weight_kg"] == 1.8            # TARE — the container empty
    assert body["max_stack_tiers"] == 4
    assert body["fill_efficiency_pct"] == 75
    # Derived on read, never stored: 60 x 40 x 32 cm is 0.0768 m3.
    assert round(body["volume_cbm"], 6) == 0.0768
    # And it still says nothing about the goods.
    assert "quantity" not in body and "gross_weight_kg" not in body


async def test_a_container_measured_on_two_sides_is_refused(client, admin):
    # Two sides describe nothing a slotting check can use, and a missing side treated
    # as zero would let anything through.
    r = await client.post("/api/packaging", json={
        "code": "HALF", "name": "Half measured", "length_cm": 60, "width_cm": 40},
        headers=admin)
    assert r.status_code == 422


async def test_a_non_stackable_container_is_one_tier_by_definition(client, admin):
    # Storing the two so they can disagree is how a screen ends up showing
    # "not stackable, 4 high".
    body = (await client.post("/api/packaging", json={
        "code": "DRUM", "name": "Drum", "is_stackable": False, "max_stack_tiers": 4},
        headers=admin)).json()
    assert body["max_stack_tiers"] == 1


async def test_packaging_breakdown_multiplies_up_the_ladder(client, admin, db):
    """10 litres in a tray, 10 trays in a box, 10 boxes in a container."""
    item = (await client.post("/api/items", json=await item_payload(client, admin),
                              headers=admin)).json()
    packages = {}
    for code, name in (("TRAY", "Tray"), ("BOX", "Box"), ("CONT", "Container")):
        packages[code] = (await client.post("/api/packaging",
                                            json={"code": code, "name": name},
                                            headers=admin)).json()
    for level, code in enumerate(("TRAY", "BOX", "CONT"), start=1):
        r = await client.post("/api/item-packaging", json={
            "item_id": item["id"], "level": level,
            "package_id": packages[code]["id"], "quantity": 10}, headers=admin)
        assert r.status_code == 200, r.text

    rows = (await client.get(f"/api/items/{item['id']}/packaging-breakdown",
                             headers=admin)).json()["items"]
    assert [r["base_quantity"] for r in rows] == [10.0, 100.0, 1000.0]
    assert [r["package_name"] for r in rows] == ["Tray", "Box", "Container"]
    assert [[part["package_name"] for part in r["package_breakup"]]
            for r in rows] == [
        ["Tray"],
        ["Box", "Tray"],
        ["Container", "Box", "Tray"],
    ]
    assert [[part["quantity"] for part in r["package_breakup"]]
            for r in rows] == [[1.0], [1.0, 10.0], [1.0, 10.0, 100.0]]
    # Level 1 is measured in the item's own unit, which is what the totals are in.
    assert rows[0]["base_uom_code"] == "PCS"


async def test_milk_packaging_shows_each_container_and_end_product(client, admin):
    item = (await client.post("/api/items", json=await item_payload(
        client, admin, name="Milk"), headers=admin)).json()
    packages = {}
    for code, name in (("PACKET", "Packet"), ("BOX", "Box"), ("TANKER", "Tanker")):
        packages[code] = (await client.post(
            "/api/packaging", json={"code": code, "name": name},
            headers=admin)).json()

    for level, code, quantity in (
        (1, "PACKET", 1), (2, "BOX", 10), (3, "TANKER", 10),
    ):
        r = await client.post("/api/item-packaging", json={
            "item_id": item["id"], "level": level,
            "package_id": packages[code]["id"], "quantity": quantity,
        }, headers=admin)
        assert r.status_code == 200, r.text

    rows = (await client.get(
        f"/api/items/{item['id']}/packaging-breakdown",
        headers=admin)).json()["items"]
    assert [row["base_quantity"] for row in rows] == [1.0, 10.0, 100.0]
    assert rows[-1]["package_breakup"] == [
        {"package_id": packages["TANKER"]["id"],
         "package_name": "Tanker", "quantity": 1.0},
        {"package_id": packages["BOX"]["id"],
         "package_name": "Box", "quantity": 10.0},
        {"package_id": packages["PACKET"]["id"],
         "package_name": "Packet", "quantity": 100.0},
    ]


async def test_level_one_can_be_a_tanker_holding_100_base_units(client, admin):
    item = (await client.post("/api/items", json=await item_payload(
        client, admin, name="Bulk milk"), headers=admin)).json()
    tanker = (await client.post(
        "/api/packaging", json={"code": "TANKER", "name": "Tanker"},
        headers=admin)).json()
    r = await client.post("/api/item-packaging", json={
        "item_id": item["id"], "level": 1,
        "package_id": tanker["id"], "quantity": 100,
    }, headers=admin)
    assert r.status_code == 200, r.text

    row = (await client.get(
        f"/api/items/{item['id']}/packaging-breakdown",
        headers=admin)).json()["items"][0]
    assert row["package_name"] == "Tanker"
    assert row["base_quantity"] == 100.0


async def test_upper_packaging_levels_require_whole_container_counts(client, admin):
    item = (await client.post("/api/items", json=await item_payload(
        client, admin), headers=admin)).json()
    packet = (await client.post(
        "/api/packaging", json={"code": "PACKET", "name": "Packet"},
        headers=admin)).json()
    box = (await client.post(
        "/api/packaging", json={"code": "BOX", "name": "Box"},
        headers=admin)).json()
    await client.post("/api/item-packaging", json={
        "item_id": item["id"], "level": 1,
        "package_id": packet["id"], "quantity": 1,
    }, headers=admin)
    r = await client.post("/api/item-packaging", json={
        "item_id": item["id"], "level": 2,
        "package_id": box["id"], "quantity": 1.5,
    }, headers=admin)
    assert r.status_code == 422
    assert "whole number" in r.json()["error"]


async def test_a_rung_inherits_the_container_box_and_can_override_it(client, admin):
    """Blank sides on a rung mean "the container type's", which is the ordinary case.

    Configuring a ladder would be unusable if every rung had to repeat the same carton's
    measurements, so the override exists only for the item that genuinely packs
    differently — and `dims_from` says which of the two the warehouse actually used.
    """
    item = (await client.post("/api/items", json=await item_payload(client, admin),
                              headers=admin)).json()
    carton = (await client.post("/api/packaging", json={
        "code": "CARTON", "name": "Carton", "length_cm": 40, "width_cm": 30,
        "height_cm": 25}, headers=admin)).json()

    await client.post("/api/item-packaging", json={
        "item_id": item["id"], "level": 1, "package_id": carton["id"],
        "quantity": 50, "gross_weight_kg": 12.5}, headers=admin)
    await client.post("/api/item-packaging", json={
        "item_id": item["id"], "level": 2, "package_id": carton["id"],
        "quantity": 4, "length_cm": 80, "width_cm": 60, "height_cm": 50},
        headers=admin)

    rows = (await client.get(f"/api/items/{item['id']}/packaging-breakdown",
                             headers=admin)).json()["items"]
    assert rows[0]["dims_from"] == "PACKAGE"
    assert round(rows[0]["volume_cbm"], 6) == 0.03        # 40 x 30 x 25
    assert rows[0]["gross_weight_kg"] == 12.5
    assert rows[1]["dims_from"] == "RUNG"
    assert round(rows[1]["volume_cbm"], 6) == 0.24        # 80 x 60 x 50, not the carton
    # The ladder still multiplies up: 4 of a 50-unit carton is 200 units.
    assert rows[1]["base_quantity"] == 200


async def test_a_rung_measured_on_two_sides_is_refused(client, admin):
    item = (await client.post("/api/items", json=await item_payload(client, admin),
                              headers=admin)).json()
    box = (await client.post("/api/packaging", json={"code": "BOX", "name": "Box"},
                             headers=admin)).json()
    r = await client.post("/api/item-packaging", json={
        "item_id": item["id"], "level": 1, "package_id": box["id"], "quantity": 10,
        "length_cm": 40, "height_cm": 25}, headers=admin)
    assert r.status_code == 422


async def test_only_one_rung_can_be_the_default_putaway_unit(client, admin):
    """Setting one clears the others rather than refusing the save.

    "At most one TRUE per item" is not something a unique index can express, and a form
    that refuses until the storekeeper goes and finds the old default first is a form
    that gets worked around.
    """
    item = (await client.post("/api/items", json=await item_payload(client, admin),
                              headers=admin)).json()
    carton = (await client.post("/api/packaging", json={
        "code": "CARTON", "name": "Carton"}, headers=admin)).json()
    pallet = (await client.post("/api/packaging", json={
        "code": "PALLET", "name": "Pallet"}, headers=admin)).json()

    first = (await client.post("/api/item-packaging", json={
        "item_id": item["id"], "level": 1, "package_id": carton["id"],
        "quantity": 50, "is_default_putaway_unit": True}, headers=admin)).json()
    assert first["is_default_putaway_unit"] is True

    await client.post("/api/item-packaging", json={
        "item_id": item["id"], "level": 2, "package_id": pallet["id"],
        "quantity": 20, "is_default_putaway_unit": True}, headers=admin)

    rows = (await client.get("/api/item-packaging",
                             params={"item_id": item["id"], "size": 50},
                             headers=admin)).json()["items"]
    flagged = [r["level"] for r in rows if r["is_default_putaway_unit"]]
    assert flagged == [2]


async def test_only_the_highest_packaging_level_can_be_removed(client, admin):
    item = (await client.post("/api/items", json=await item_payload(
        client, admin), headers=admin)).json()
    packet = (await client.post(
        "/api/packaging", json={"code": "PACKET", "name": "Packet"},
        headers=admin)).json()
    box = (await client.post(
        "/api/packaging", json={"code": "BOX", "name": "Box"},
        headers=admin)).json()
    first = (await client.post("/api/item-packaging", json={
        "item_id": item["id"], "level": 1,
        "package_id": packet["id"], "quantity": 1,
    }, headers=admin)).json()
    second = (await client.post("/api/item-packaging", json={
        "item_id": item["id"], "level": 2,
        "package_id": box["id"], "quantity": 10,
    }, headers=admin)).json()

    blocked = await client.delete(
        f"/api/item-packaging/{first['id']}", headers=admin)
    assert blocked.status_code == 422
    assert "highest" in blocked.json()["error"]
    assert (await client.delete(
        f"/api/item-packaging/{second['id']}", headers=admin)).status_code == 200
    rows = (await client.get(
        f"/api/item-packaging?item_id={item['id']}", headers=admin)).json()["items"]
    assert [row["level"] for row in rows] == [1]


async def test_a_packaging_level_cannot_skip_the_one_below_it(client, admin):
    item = (await client.post("/api/items", json=await item_payload(client, admin),
                              headers=admin)).json()
    box = (await client.post("/api/packaging", json={"code": "BOX", "name": "Box"},
                             headers=admin)).json()
    r = await client.post("/api/item-packaging", json={
        "item_id": item["id"], "level": 2, "package_id": box["id"],
        "quantity": 10}, headers=admin)
    assert r.status_code == 422
    assert "level 1" in r.json()["error"]


async def test_one_level_per_item(client, admin):
    item = (await client.post("/api/items", json=await item_payload(client, admin),
                              headers=admin)).json()
    tray = (await client.post("/api/packaging", json={"code": "TRAY", "name": "Tray"},
                              headers=admin)).json()
    body = {"item_id": item["id"], "level": 1, "package_id": tray["id"],
            "quantity": 10}
    assert (await client.post("/api/item-packaging", json=body,
                              headers=admin)).status_code == 200
    assert (await client.post("/api/item-packaging", json=body,
                              headers=admin)).status_code == 422


async def test_a_package_no_longer_carries_a_quantity(client, admin):
    """A tray of milk and a tray of vials hold different amounts, so the quantity
    belongs to the item's chain, not to the tray."""
    body = (await client.post("/api/packaging",
                              json={"code": "TRAY", "name": "Tray"},
                              headers=admin)).json()
    assert "qty_per_pack" not in body
    assert "uom_id" not in body


# --------------------------- kit components --------------------------- #
async def test_a_kit_lists_its_components(client, admin):
    payload = await item_payload(client, admin, name="First Aid Kit")
    kit = (await client.post("/api/items",
                             json={**payload, "has_components": True},
                             headers=admin)).json()
    bandage = (await client.post("/api/items",
                                 json={**payload, "name": "Bandage"},
                                 headers=admin)).json()

    r = await client.post("/api/item-components", json={
        "item_id": kit["id"], "component_item_id": bandage["id"],
        "quantity": 5, "remarks": "Sterile only"}, headers=admin)
    assert r.status_code == 200, r.text
    line = r.json()
    # The UOM follows the component unless it is overridden.
    assert (line["component_name"], line["quantity"], line["uom_code"]) == \
        ("Bandage", 5.0, "PCS")


async def test_a_kit_cannot_contain_itself(client, admin):
    kit = (await client.post("/api/items", json=await item_payload(client, admin),
                             headers=admin)).json()
    r = await client.post("/api/item-components", json={
        "item_id": kit["id"], "component_item_id": kit["id"], "quantity": 1},
        headers=admin)
    assert r.status_code == 422


async def test_components_require_the_item_to_be_saved_as_a_kit(client, admin):
    payload = await item_payload(client, admin, name="Plain item")
    item = (await client.post("/api/items", json=payload, headers=admin)).json()
    component = (await client.post(
        "/api/items", json={**payload, "name": "Component"}, headers=admin)).json()

    r = await client.post("/api/item-components", json={
        "item_id": item["id"], "component_item_id": component["id"],
        "quantity": 1}, headers=admin)
    assert r.status_code == 422
    assert "Has Components" in r.json()["error"]


async def test_removed_kit_components_are_hidden(client, admin):
    payload = await item_payload(client, admin, name="Kit")
    kit = (await client.post(
        "/api/items", json={**payload, "has_components": True},
        headers=admin)).json()
    component = (await client.post(
        "/api/items", json={**payload, "name": "Component"}, headers=admin)).json()
    line = (await client.post("/api/item-components", json={
        "item_id": kit["id"], "component_item_id": component["id"],
        "quantity": 1}, headers=admin)).json()

    assert (await client.delete(
        f"/api/item-components/{line['id']}", headers=admin)).status_code == 200
    rows = (await client.get(
        f"/api/item-components?item_id={kit['id']}", headers=admin)).json()["items"]
    assert rows == []


# ------------------------------ BOM ---------------------------------- #
async def test_a_bom_is_a_named_set_of_items_on_a_project(client, admin, db):
    project = Project(code="PRJ-01", name="Metro Line 3", is_active=True)
    db.add(project)
    await db.commit()
    item = (await client.post("/api/items", json=await item_payload(client, admin),
                              headers=admin)).json()

    bom = (await client.post("/api/boms", json={
        "code": "STARTER", "name": "Site starter kit",
        "project_id": project.id}, headers=admin)).json()
    assert bom["project_name"] == "Metro Line 3"
    # No parent item, output quantity or assembly type: this is a request template.
    for gone in ("parent_item_id", "output_qty", "bom_type"):
        assert gone not in bom

    line = (await client.post("/api/bom-items", json={
        "bom_id": bom["id"], "item_id": item["id"], "quantity": 3,
        "remarks": "One per bay"}, headers=admin)).json()
    assert (line["item_name"], line["quantity"], line["uom_code"]) == \
        ("Bolt", 3.0, "PCS")


# ------------------------------- UOM -------------------------------- #
async def test_uom_requires_a_measurement_class(client, admin):
    """An unclassified unit would vanish from every class-filtered dropdown, which
    is a data loss nobody would notice until an item could not be saved."""
    r = await client.post("/api/uom", json={"code": "XX", "name": "Mystery"},
                          headers=admin)
    assert r.status_code == 422


async def test_uom_rejects_an_unknown_class(client, admin):
    r = await client.post("/api/uom",
                          json={"code": "XX", "name": "Mystery",
                                "uom_class": "LUMINOSITY"}, headers=admin)
    assert r.status_code == 422


async def test_the_same_name_may_exist_in_two_classes(client, admin):
    """A weight Ton and a refrigeration Ton are different units sharing a word."""
    a = await client.post("/api/uom", json={"code": "TON", "name": "Ton",
                                            "uom_class": "WEIGHT"}, headers=admin)
    b = await client.post("/api/uom", json={"code": "TR", "name": "Ton",
                                            "uom_class": "ENERGY"}, headers=admin)
    assert (a.status_code, b.status_code) == (200, 200), b.text


async def test_one_name_cannot_repeat_inside_a_class(client, admin):
    await client.post("/api/uom", json={"code": "LTR", "name": "Litre",
                                        "uom_class": "VOLUME"}, headers=admin)
    r = await client.post("/api/uom", json={"code": "L", "name": "litre",
                                            "uom_class": "VOLUME"}, headers=admin)
    assert r.status_code == 422


async def test_uom_list_can_be_filtered_by_class(client, admin):
    await client.post("/api/uom", json={"code": "CEL", "name": "Celsius",
                                        "uom_class": "TEMPERATURE"}, headers=admin)
    await client.post("/api/uom", json={"code": "KG", "name": "Kilogram",
                                        "uom_class": "WEIGHT"}, headers=admin)
    rows = (await client.get("/api/uom?uom_class=TEMPERATURE",
                             headers=admin)).json()["items"]
    assert [u["code"] for u in rows] == ["CEL"]


async def test_temperature_suggests_its_standard_units(client, admin):
    body = (await client.get("/api/uom/suggestions?uom_class=TEMPERATURE",
                             headers=admin)).json()
    assert [u["name"] for u in body["items"]] == ["Celsius", "Fahrenheit", "Kelvin"]
    assert all(u["exists"] is False for u in body["items"])


async def test_creating_suggested_units_is_repeatable(client, admin):
    """Ticking the same list twice must not fail — the second run has nothing to do
    rather than a duplicate to reject."""
    first = (await client.post("/api/uom/suggestions", json={
        "uom_class": "TEMPERATURE", "codes": ["CEL", "FAH"]}, headers=admin)).json()
    assert first["created"] == ["CEL", "FAH"]

    second = (await client.post("/api/uom/suggestions", json={
        "uom_class": "TEMPERATURE", "codes": ["CEL", "FAH"]}, headers=admin)).json()
    assert (second["created"], second["skipped"]) == ([], ["CEL", "FAH"])

    listed = (await client.get("/api/uom/suggestions?uom_class=TEMPERATURE",
                               headers=admin)).json()["items"]
    assert [u["exists"] for u in listed] == [True, True, False]


async def test_a_unit_outside_the_catalogue_is_rejected(client, admin):
    r = await client.post("/api/uom/suggestions", json={
        "uom_class": "TEMPERATURE", "codes": ["RANKINE"]}, headers=admin)
    assert r.status_code == 422


# -------------------------- UOM conversions -------------------------- #
async def test_uom_conversion_snapshots_both_codes(client, admin):
    box = (await client.post("/api/uom", json={"code": "BOX", "name": "Box", "uom_class": "PACKAGING"},
                             headers=admin)).json()
    pcs = (await client.post("/api/uom", json={"code": "PCS", "name": "Pieces", "uom_class": "COUNT"},
                             headers=admin)).json()

    r = await client.post("/api/uom-conversions", json={
        "from_uom_id": box["id"], "to_uom_id": pcs["id"], "factor": 12},
        headers=admin)
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["from_uom_code"], body["to_uom_code"], body["factor"]) == \
        ("BOX", "PCS", 12.0)


async def test_uom_cannot_convert_to_itself(client, admin):
    pcs = (await client.post("/api/uom", json={"code": "PCS", "name": "Pieces", "uom_class": "COUNT"},
                             headers=admin)).json()
    r = await client.post("/api/uom-conversions", json={
        "from_uom_id": pcs["id"], "to_uom_id": pcs["id"], "factor": 1}, headers=admin)
    assert r.status_code == 422


async def test_conversion_factor_must_be_positive(client, admin):
    a = (await client.post("/api/uom", json={"code": "A", "name": "A", "uom_class": "COUNT"},
                           headers=admin)).json()
    b = (await client.post("/api/uom", json={"code": "B", "name": "B", "uom_class": "COUNT"},
                           headers=admin)).json()
    r = await client.post("/api/uom-conversions", json={
        "from_uom_id": a["id"], "to_uom_id": b["id"], "factor": 0}, headers=admin)
    assert r.status_code == 422


# ------------------- the spreadsheet, as a storekeeper fills it ------------- #
# The masters are typed in by people whose job is the goods. Six of the item
# sheet's foreign keys are required, so a column asking for `category_id = 47`
# meant eight other exports open on the desk. These cover the columns being names
# instead, and the one trap that turns a readable sheet into a silent mis-link.

def _items_def():
    from app.shared.masters.defs import MASTERS
    return next(m for m in MASTERS if m.path == "items")


def test_the_item_sheet_asks_for_names_not_ids():
    from app.shared.masters.bulk import columns_for, header_for

    defn = _items_def()
    headers = [header_for(defn, f) for f in columns_for(defn.schema)]
    assert "Category" in headers and "category_id" not in headers
    assert "HSN code" in headers and "hsn_id" not in headers
    # Booleans keep the schema's own name on purpose: renaming all thirty columns
    # would break every file already filled in, and a Yes/No dropdown is what makes
    # those readable, not the header.
    assert "is_asset" in headers


def test_the_template_carries_a_worked_example_off_the_data_sheet():
    """A sample row left on `Data` is a junk master record, which is why there was
    no example at all — but somebody who has never seen the file cannot guess what
    "Category" wants. Its own sheet answers both."""
    import io as _io

    from openpyxl import load_workbook

    from app.shared.masters.bulk import build_template

    book = load_workbook(_io.BytesIO(build_template(
        _items_def(), {"category_id": [{"id": 1, "label": "Antibiotics", "code": "AB"}]})))
    assert book.sheetnames == ["Data", "Lists", "How to fill", "Example"]
    assert book["Data"].max_row == 1                    # headers, and nothing else
    assert "Antibiotics" in [c.value for c in book["Example"][2]]


def test_a_sheet_written_against_the_old_template_still_imports():
    """The header is matched by the readable label OR the schema's own field name.
    An export taken before this, or a file an admin has kept, must not stop working
    because a column was renamed."""
    import io as _io

    from openpyxl import Workbook

    from app.shared.masters.bulk import parse_upload

    book = Workbook()
    sheet = book.active
    sheet.title = "Data"
    sheet.append(["name", "category_id", "General name", "brand_id",
                  "manufacturer_id", "item_class_id", "uom_id", "hsn_id"])
    sheet.append(["Bolt", 4, "Fasteners", 5, 6, 7, 8, 9])
    buffer = _io.BytesIO()
    book.save(buffer)

    parsed, errors = parse_upload(_items_def(), buffer.getvalue())
    assert errors == []
    # Both spellings land on the same schema field, and neither is read as a number
    # here — a looked-up cell is resolved against its master afterwards.
    assert parsed[0]["__lookup__"]["category_id"] == "4"
    assert parsed[0]["__lookup__"]["general_name_id"] == "Fasteners"


async def test_a_numeric_code_is_the_code_and_not_a_row_id(db):
    """The trap this whole shape sets for itself.

    An HSN code IS a number. Reading a numeric cell as the row id first — which is
    the obvious way to keep old files working — silently linked an item to row
    28289011, a row that does not exist. The name is matched first and the number is
    only read as an id when nothing answered AND that id is really there.
    """
    from app.shared.masters.bulk import resolve_lookups

    hsn = HsnCode(code="28289011", is_active=True)
    db.add(hsn)
    await db.flush()
    assert hsn.id != 28289011                       # or the test proves nothing

    parsed = [{"__row__": 2, "__lookup__": {"hsn_id": "28289011"}}]
    problems = await resolve_lookups(_items_def(), db, parsed)
    assert problems == []
    assert parsed[0]["hsn_id"] == hsn.id


async def test_a_name_matching_two_rows_is_refused_rather_than_guessed(db):
    """Master data is not the place to take the closer of two answers. An item
    filed under the wrong manufacturer is stock counted wrong for a year, and
    nobody goes looking."""
    from app.shared.masters.bulk import resolve_lookups

    db.add_all([Manufacturer(code="CIP1", name="Cipla", is_active=True),
                Manufacturer(code="CIP2", name="Cipla", is_active=True)])
    await db.flush()

    parsed = [{"__row__": 2, "__lookup__": {"manufacturer_id": "Cipla"}}]
    problems = await resolve_lookups(_items_def(), db, parsed)
    assert len(problems) == 1
    assert "manufacturer_id" not in parsed[0]
    # The screen offers both rather than making the choice for them.
    assert len(problems[0]["candidates"]) == 2
    assert {c["code"] for c in problems[0]["candidates"]} == {"CIP1", "CIP2"}


async def test_an_unknown_name_is_reported_with_the_row_it_was_on(db):
    from app.shared.masters.bulk import resolve_lookups

    parsed = [{"__row__": 7, "__lookup__": {"manufacturer_id": "Cipla Ltd Typo"}}]
    problems = await resolve_lookups(_items_def(), db, parsed)
    assert len(problems) == 1
    assert problems[0]["row"] == 7
    assert problems[0]["label"] == "Manufacturer"
    assert problems[0]["raw"] == "Cipla Ltd Typo"
    assert problems[0]["candidates"] == []


def _category_workbook(rows):
    import io
    from openpyxl import Workbook

    book = Workbook()
    sheet = book.active
    sheet.title = "Data"
    sheet.append(["code", "name", "is_active"])
    for row in rows:
        sheet.append(row)
    payload = io.BytesIO()
    book.save(payload)
    return payload.getvalue()


async def test_import_preview_never_writes_even_when_file_is_clean(client, admin):
    content = _category_workbook([["TOOLS", "Tools", "Yes"]])
    preview = await client.post(
        "/api/item-categories/import/preview", headers=admin,
        files={"file": ("categories.xlsx", content,
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    assert preview.status_code == 200, preview.text
    assert preview.json()["summary"] == {"total": 1, "ready": 1, "blocked": 0}
    assert (await client.get("/api/item-categories", headers=admin)).json()["total"] == 0


async def test_import_preview_marks_duplicate_codes_before_commit(client, admin):
    content = _category_workbook([
        ["TOOLS", "Tools", "Yes"], [" tools ", "Other tools", "Yes"],
    ])
    preview = await client.post(
        "/api/item-categories/import/preview", headers=admin,
        files={"file": ("categories.xlsx", content,
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["summary"] == {"total": 2, "ready": 1, "blocked": 1}
    assert body["rows"][1]["problems"][0]["field"] == "code"
    assert "Duplicate of row 2" in body["rows"][1]["problems"][0]["message"]
