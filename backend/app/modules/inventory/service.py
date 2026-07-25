"""Inventory business logic.

The module is registered, but database-backed operations must wait for an
approved mapping to the frozen schema.
"""
from app.modules.inventory.schemas import InventoryOverviewOut


async def get_overview() -> InventoryOverviewOut:
    return InventoryOverviewOut(
        module="inventory",
        status="ready_for_development",
        database_ready=False,
    )
