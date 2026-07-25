from app.modules.inventory import service


async def test_inventory_overview_scaffold():
    result = await service.get_overview()
    assert result.module == "inventory"
    assert result.status == "ready_for_development"
    assert result.database_ready is False


async def test_inventory_endpoint_requires_permission(client, make_user, login):
    await make_user(
        employee_id=81, username="inventory-denied", password="pw",
        permissions=["indent.view"],
    )
    headers = await login("inventory-denied", "pw")
    response = await client.get("/api/inventory", headers=headers)
    assert response.status_code == 403


async def test_inventory_endpoint_available_with_stock_view(client, make_user, login):
    await make_user(
        employee_id=82, username="inventory-viewer", password="pw",
        permissions=["stock.view"],
    )
    headers = await login("inventory-viewer", "pw")
    response = await client.get("/api/inventory", headers=headers)
    assert response.status_code == 200
    assert response.json()["module"] == "inventory"
