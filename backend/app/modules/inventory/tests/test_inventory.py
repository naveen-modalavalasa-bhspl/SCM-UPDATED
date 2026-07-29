"""Inventory module tests.

These replaced a scaffold suite that asserted the module was a stub
("status == ready_for_development"). Inventory now owns stk_balance and stk_ledger,
so the tests check the real surface: /api/stock is inventory's, and it is gated on
stock.view.
"""
from decimal import Decimal

from sqlalchemy import select

from app.modules.inventory import service
from app.modules.inventory.models import Stock
from app.platform.rbac.models import Role, UserRole
from app.shared.models.master import Item
from app.shared.models.warehouse import Warehouse


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


async def test_stock_valuation_requires_its_own_permission(
    client, make_user, login,
):
    await make_user(
        employee_id=83, username="stock-only", password="pw",
        permissions=["stock.view"],
    )
    stock_headers = await login("stock-only", "pw")
    denied = await client.get("/api/stock/valuation", headers=stock_headers)
    assert denied.status_code == 403

    await make_user(
        employee_id=84, username="valuation-reader", password="pw",
        permissions=["stock.view", "stock.valuation.view"],
    )
    valuation_headers = await login("valuation-reader", "pw")
    allowed = await client.get("/api/stock/valuation", headers=valuation_headers)
    assert allowed.status_code == 200
    assert allowed.json() == {"items": [], "total_portfolio_value": 0.0}


async def test_stock_overview_omits_money_without_valuation_permission(
    client, make_user, login,
):
    await make_user(
        employee_id=85, username="operational-stock", password="pw",
        permissions=["stock.view"],
    )
    headers = await login("operational-stock", "pw")

    response = await client.get("/api/stock/overview-kpis", headers=headers)

    assert response.status_code == 200
    assert response.json()["total_stock_value"] is None


async def test_stock_view_is_office_scoped_and_omits_cost_fields(
    client, db, make_user, login,
):
    viewer = await make_user(
        employee_id=86, username="office-stock", password="pw",
        permissions=["stock.view"],
    )
    viewer.office_id = 10
    own = Warehouse(
        id=8601, code="WH-OWN", name="Own warehouse", office_id=10,
    )
    foreign = Warehouse(
        id=8602, code="WH-OTHER", name="Other warehouse", office_id=20,
    )
    item = Item(
        id=8603, code="SEC-STOCK", name="Scoped stock",
        reorder_level=Decimal("10"), purchase_price=Decimal("99"),
    )
    db.add_all((own, foreign, item))
    await db.flush()
    db.add_all((
        Stock(
            warehouse_id=own.id, item_id=item.id, item_code=item.code,
            item_name=item.name, available_qty=Decimal("2"), total_qty=Decimal("2"),
            valuation_rate=Decimal("99"), stock_value=Decimal("198"),
        ),
        Stock(
            warehouse_id=foreign.id, item_id=item.id, item_code=item.code,
            item_name=item.name, available_qty=Decimal("3"), total_qty=Decimal("3"),
            valuation_rate=Decimal("99"), stock_value=Decimal("297"),
        ),
    ))
    await db.commit()
    headers = await login("office-stock", "pw")

    response = await client.get("/api/stock", headers=headers)
    assert response.status_code == 200
    assert [row["warehouse_id"] for row in response.json()["items"]] == [own.id]
    assert "valuation_rate" not in response.json()["items"][0]
    assert "stock_value" not in response.json()["items"][0]

    foreign_response = await client.get(
        f"/api/stock?warehouse_id={foreign.id}", headers=headers,
    )
    assert foreign_response.status_code == 403

    replenishment = await client.get("/api/stock/replenishment", headers=headers)
    assert replenishment.status_code == 200
    assert replenishment.json()[0]["last_purchase_price"] is None


async def test_admin_role_has_global_stock_scope(client, db, make_user, login):
    admin = await make_user(
        employee_id=87, username="inventory-admin", password="pw",
        permissions=["stock.view"],
    )
    role = (await db.execute(
        select(Role)
        .join(UserRole, UserRole.role_id == Role.id)
        .where(UserRole.employee_id == admin.id)
    )).scalar_one()
    role.code = "ADMIN"
    db.add_all((
        Warehouse(id=8701, code="WH-A", name="Warehouse A", office_id=10),
        Warehouse(id=8702, code="WH-B", name="Warehouse B", office_id=20),
    ))
    item = Item(id=8703, code="ADMIN-STOCK", name="Admin stock")
    db.add(item)
    await db.flush()
    db.add_all((
        Stock(
            warehouse_id=8701, item_id=item.id, item_code=item.code,
            item_name=item.name, available_qty=Decimal("2"), total_qty=Decimal("2"),
        ),
        Stock(
            warehouse_id=8702, item_id=item.id, item_code=item.code,
            item_name=item.name, available_qty=Decimal("3"), total_qty=Decimal("3"),
        ),
    ))
    await db.commit()
    headers = await login("inventory-admin", "pw")

    response = await client.get("/api/stock", headers=headers)

    assert response.status_code == 200
    assert {row["warehouse_id"] for row in response.json()["items"]} == {8701, 8702}
