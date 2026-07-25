"""Masters CRUD through the MasterDef factory: permissions, deactivation, snapshots,
and the tree guards on categories and locations."""
import pytest

from app.platform.rbac import permissions as perms
from app.shared.enums import LocationType

MANAGE_ALL = [perms.MASTER_ITEM_MANAGE, perms.MASTER_CATEGORY_MANAGE,
              perms.MASTER_UOM_MANAGE, perms.MASTER_LOCATION_MANAGE,
              perms.MASTER_VENDOR_MANAGE]


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
async def test_create_item_snapshots_uom_and_category(client, admin):
    uom = (await client.post("/api/uom", json={"code": "PCS", "name": "Pieces"},
                             headers=admin)).json()
    cat = (await client.post("/api/item-categories",
                             json={"code": "CON", "name": "Consumables"},
                             headers=admin)).json()

    r = await client.post("/api/items", json={
        "code": "IT-1", "name": "Bolt", "uom_id": uom["id"],
        "category_id": cat["id"]}, headers=admin)
    assert r.status_code == 200, r.text
    body = r.json()
    # Snapshots let the item list render without joining two masters.
    assert body["uom_code"] == "PCS"
    assert body["category_name"] == "Consumables"


async def test_item_list_is_paginated_and_searchable(client, admin):
    for i in range(3):
        await client.post("/api/items", json={"code": f"IT-{i}", "name": f"Widget {i}"},
                          headers=admin)
    page = (await client.get("/api/items", headers=admin)).json()
    assert {"items", "total", "page", "size"} <= page.keys()
    assert page["total"] == 3

    found = (await client.get("/api/items?search=Widget 1", headers=admin)).json()
    assert [i["name"] for i in found["items"]] == ["Widget 1"]


async def test_deactivate_hides_item_from_the_default_list(client, admin):
    item = (await client.post("/api/items", json={"code": "IT-X", "name": "Old"},
                              headers=admin)).json()

    assert (await client.delete(f"/api/items/{item['id']}",
                                headers=admin)).status_code == 200
    assert (await client.get("/api/items", headers=admin)).json()["total"] == 0
    # Still retrievable, because documents reference it by id.
    shown = (await client.get("/api/items?include_inactive=true", headers=admin)).json()
    assert shown["total"] == 1
    assert shown["items"][0]["is_active"] is False


async def test_write_requires_the_manage_permission(client, viewer):
    r = await client.post("/api/items", json={"code": "X", "name": "X"}, headers=viewer)
    assert r.status_code == 403


async def test_read_is_open_to_any_authenticated_user(client, viewer):
    """Every module's dropdowns read masters, so GET must not need a manage code."""
    assert (await client.get("/api/items", headers=viewer)).status_code == 200


async def test_unauthenticated_read_is_rejected(client):
    assert (await client.get("/api/items")).status_code == 401


async def test_update_missing_row_is_404(client, admin):
    r = await client.put("/api/items/9999", json={"code": "A", "name": "A"},
                         headers=admin)
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


# ----------------------------- locations ----------------------------- #
async def test_location_tree_snapshots_the_parent_name(client, admin):
    site = (await client.post("/api/locations", json={
        "code": "SITE1", "name": "Chennai Site",
        "location_type": LocationType.SITE.value}, headers=admin)).json()
    warehouse = (await client.post("/api/locations", json={
        "code": "WH1", "name": "Main Warehouse",
        "location_type": LocationType.WAREHOUSE.value,
        "parent_id": site["id"], "is_stock_point": True}, headers=admin)).json()

    assert warehouse["parent_name"] == "Chennai Site"
    assert warehouse["is_stock_point"] is True


async def test_invalid_location_type_is_rejected(client, admin):
    r = await client.post("/api/locations", json={
        "code": "X", "name": "X", "location_type": "PLANET"}, headers=admin)
    assert r.status_code == 400


async def test_location_loop_is_rejected(client, admin):
    a = (await client.post("/api/locations", json={
        "code": "A", "name": "A",
        "location_type": LocationType.SITE.value}, headers=admin)).json()
    b = (await client.post("/api/locations", json={
        "code": "B", "name": "B", "location_type": LocationType.WAREHOUSE.value,
        "parent_id": a["id"]}, headers=admin)).json()

    # Making A a child of B would close the loop A -> B -> A.
    r = await client.put(f"/api/locations/{a['id']}", json={
        "code": "A", "name": "A", "location_type": LocationType.SITE.value,
        "parent_id": b["id"]}, headers=admin)
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
