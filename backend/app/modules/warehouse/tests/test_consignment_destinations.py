"""SCM_0132: a logistics desk sees the consignment's warehouses.

The consignment screen requires `dispatch.view`; its warehouse list was gated on
`stock.view`, which a logistics profile does not hold, so both warehouse boxes came up
empty. The destinations are served on the screen's own permission now.
"""
import pytest

from app.shared.models.warehouse import Warehouse

pytestmark = pytest.mark.asyncio


async def test_a_dispatch_only_login_reads_the_destinations(db, client, make_user, login):
    db.add_all([
        Warehouse(code="WH-A", name="Central warehouse", warehouse_type="MAIN", is_active=True),
        Warehouse(code="WH-B", name="Gollapalli warehouse", warehouse_type="MAIN", is_active=True),
    ])
    await db.commit()
    await make_user(username="logi", permissions=["dispatch.view"])
    headers = await login("logi", "pw")

    served = await client.get("/api/warehouse/options/consignment-destinations", headers=headers)
    assert served.status_code == 200, served.text
    names = {row["name"] for row in served.json()}
    assert {"Central warehouse", "Gollapalli warehouse"} <= names

    # The stock-gated list stays stock-gated: nothing was widened.
    gated = await client.get("/api/warehouse/options/warehouses",
                             params={"all_points": True}, headers=headers)
    assert gated.status_code == 403
