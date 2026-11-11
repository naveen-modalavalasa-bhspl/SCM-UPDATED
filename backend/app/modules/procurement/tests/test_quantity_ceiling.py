"""Requisitions and quotation amendments: down or left, never up (2026-11-03).

- A hand-made requisition is free while it is a DRAFT and locked once SUBMITTED.
- A requisition drawn from material requests is capped by them from the start, and
  every cut is kept.
- A quotation amendment — the buyer's ask and the supplier's counter — may not go
  above what the RFQ asked for.
"""
from decimal import Decimal
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.core.exceptions import ValidationError
from app.modules.procurement import service
from app.modules.procurement.models import RequisitionItem, RequisitionQtyChange
from app.modules.procurement.schemas import ReqCreate, ReqLineIn
from app.modules.procurement.tests.test_procurement import _world

pytestmark = pytest.mark.asyncio


def _req(item_id, qty):
    return ReqCreate(organization_id=2, org_department_id=2,
                     lines=[ReqLineIn(item_id=item_id, quantity=qty)])


async def _lines(db, req_id):
    return (await db.execute(select(RequisitionItem).where(
        RequisitionItem.requisition_id == req_id))).scalars().all()


async def test_a_hand_made_draft_is_free_and_is_locked_on_submit(db):
    item, _vendor, _indent, _ind_item, creator, _approver = await _world(db)
    item_id = item.id
    req_id = (await service.create_requisition(db, _req(item_id, 10), creator)).id
    assert (await _lines(db, req_id))[0].requested_quantity is None

    # Still a draft: its author may raise it.
    await service.update_requisition(db, req_id, _req(item_id, 14), creator)
    assert float((await _lines(db, req_id))[0].quantity) == 14

    await service.submit_requisition(db, req_id, creator)
    assert float((await _lines(db, req_id))[0].requested_quantity) == 14


async def test_a_draft_drawn_from_requests_may_be_cut_never_raised(db):
    item, _vendor, _indent, _ind_item, creator, _approver = await _world(db)
    item_id = item.id
    req_id = (await service.create_requisition(db, _req(item_id, 10), creator)).id
    # As `create_requisition_from_mr(s)` writes it: capped by the request behind it.
    line = (await _lines(db, req_id))[0]
    line.requested_quantity = Decimal("10")
    await db.commit()

    with pytest.raises(ValidationError, match="never increased"):
        await service.update_requisition(db, req_id, _req(item_id, 11), creator)
    await db.rollback()
    await db.refresh(creator)  # The rollback expired it; a request has its own.

    await service.update_requisition(db, req_id, _req(item_id, 6), creator)
    line = (await _lines(db, req_id))[0]
    assert float(line.quantity) == 6 and float(line.requested_quantity) == 10

    changes = (await db.execute(select(RequisitionQtyChange).where(
        RequisitionQtyChange.requisition_id == req_id))).scalars().all()
    assert [(float(c.from_qty), float(c.to_qty), c.stage) for c in changes] == [
        (10, 6, "DRAFT_EDIT")]
    served = await service.requisition_quantity_changes(db, req_id, creator)
    assert served[0]["ceiling_qty"] == 10


@pytest.mark.filterwarnings("ignore")
def test_a_quotation_amendment_above_the_rfq_needs_a_reason():
    """Since 2026-11-11 an amendment may go above the RFQ's quantity, with a reason."""
    line = SimpleNamespace(id=1, item_code="IT-1", item_name="Bolt", uom_code="NOS")
    by_id, asked = {1: line}, {1: Decimal("10")}
    service._assert_amendment_within_rfq(
        [{"quotation_item_id": 1, "proposed_quantity": 8}], by_id, asked)
    service._assert_amendment_within_rfq(
        [{"quotation_item_id": 1, "proposed_quantity": 10}], by_id, asked)
    with pytest.raises(ValidationError, match="Give a reason on this line"):
        service._assert_amendment_within_rfq(
            [{"quotation_item_id": 1, "proposed_quantity": 12}], by_id, asked)
    with pytest.raises(ValidationError, match="Give a reason on this line"):
        service._assert_amendment_within_rfq(
            [{"quotation_item_id": 1, "proposed_quantity": 12, "note": "   "}], by_id, asked)
    service._assert_amendment_within_rfq(
        [{"quotation_item_id": 1, "proposed_quantity": 12,
          "note": "Site added two more rooms"}], by_id, asked)
