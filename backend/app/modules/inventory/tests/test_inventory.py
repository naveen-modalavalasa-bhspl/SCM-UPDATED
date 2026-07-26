"""Inventory module tests.

These replaced a scaffold suite that asserted the module was a stub
("status == ready_for_development"). Inventory now owns stk_balance and stk_ledger,
so the tests check the real surface: /api/stock is inventory's, and it is gated on
stock.view.
"""
from app.modules.inventory import service


def test_inventory_owns_the_stock_mutation_point():
    """move_stock lives here, not in logistics. If this moves again, every module
    that imports it breaks, so the location is worth asserting."""
    assert hasattr(service, "move_stock")
    assert hasattr(service, "transfer_stock")


def test_inventory_imports_no_sibling_module():
    """Inventory is the base module: it must not import another app.modules package,
    or the chain that lets indents call allocate_for_indent() inverts."""
    import inspect

    source = inspect.getsource(service)
    siblings = ("app.modules.indents", "app.modules.procurement",
                "app.modules.logistics", "app.modules.warehouse")
    assert not [s for s in siblings if s in source]


async def test_stock_endpoint_requires_permission(client, make_user, login):
    await make_user(
        employee_id=81, username="inventory-denied", password="pw",
        permissions=["indent.view"],
    )
    headers = await login("inventory-denied", "pw")
    response = await client.get("/api/stock", headers=headers)
    assert response.status_code == 403


async def test_stock_endpoint_available_with_stock_view(client, make_user, login):
    await make_user(
        employee_id=82, username="inventory-viewer", password="pw",
        permissions=["stock.view"],
    )
    headers = await login("inventory-viewer", "pw")
    response = await client.get("/api/stock", headers=headers)
    assert response.status_code == 200
    assert response.json()["items"] == []
