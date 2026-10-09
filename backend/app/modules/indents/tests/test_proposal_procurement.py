from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from app.modules.indents import service


@pytest.mark.asyncio
@pytest.mark.parametrize("ordered,remaining,allowed", [(10, 0, False), (4, 6, True), (0, 10, True)])
async def test_proposal_uses_outstanding_procurement(monkeypatch, ordered, remaining, allowed):
    line = SimpleNamespace(id=1, item_id=1, item_code="A", item_name="A",
                           uom_code="NOS", allocated_quantity=0)
    indent = SimpleNamespace(id=1, indent_no="IND1", items=[line],
        status=next(iter(service._ALLOCATION_ELIGIBLE_STATUSES)), project_id=1,
        department_name="D", requested_by_name="U")
    db = SimpleNamespace(execute=AsyncMock(side_effect=[
        SimpleNamespace(scalar_one_or_none=lambda: indent),
        SimpleNamespace(all=lambda: []),
    ]))
    monkeypatch.setattr(service, "_committed_by_line", AsyncMock(return_value={}))
    monkeypatch.setattr(service, "_on_order_by_line", AsyncMock(return_value={1: Decimal(ordered)}))
    monkeypatch.setattr(service, "_quantities_recorded", lambda _: True)
    monkeypatch.setattr(service, "_owed_quantity", lambda *_: Decimal(10))
    async def propose(db, indent_id, lines, **kwargs):
        return [dict(row, available_total=20, main_available_qty=20,
                     competing_demand=0, warehouses=[]) for row in lines]
    monkeypatch.setattr(service.allocations, "propose", propose)
    result = await service.allocation_proposal(db, 1)
    assert result["allocatable"] is allowed
    assert result["lines"][0]["requested_qty"] == remaining
    assert result["lines"][0]["on_order_qty"] == ordered
