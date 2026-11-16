"""Goods turned away at the door have ARRIVED, and are not RECEIVED.

The requester's acknowledgement decides two different things from the same line:

  * is it still OWED? — measured on `received_quantity` alone, untouched by a rejection, so
    a line with goods turned away stays open for the replacement;
  * has the delivery ARRIVED? — measured on received + rejected, because rejected goods are
    physically on the receiving shelf and have to be credited there before a return can be
    raised from it, and an issue whose every unit is accounted for must settle.

These are DB-backed because the change is two SQL expressions.
"""
from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.modules.indents.models import Indent, IndentItem
from app.modules.warehouse import models as m
from app.modules.warehouse import service as wh
from app.shared.models.master import Item, Uom


async def _delivery(db, *, issued: int, received: int = 0, rejected: int = 0,
                    status: str = "DISPATCHED"):
    uom = Uom(code="NOS", name="Numbers")
    db.add(uom)
    await db.flush()
    item = Item(code="IT-ACK", name="Ack Item", uom_id=uom.id, uom_code="NOS")
    db.add(item)
    await db.flush()
    indent = Indent(indent_no="IND-ACK-1", indent_date=date(2026, 11, 6),
                    required_date=date(2026, 11, 10), requested_by_id=1,
                    requested_by_name="Requester", status="ALLOCATED")
    db.add(indent)
    await db.flush()
    line = IndentItem(indent_id=indent.id, line_no=1, item_id=item.id, item_code=item.code,
                      item_name=item.name, uom_code="NOS", quantity=Decimal(10),
                      approved_quantity=Decimal(10), received_quantity=Decimal(received),
                      rejected_quantity=Decimal(rejected))
    db.add(line)
    await db.flush()
    issue = m.MaterialIssue(issue_no="WHI-ACK-1", issue_date=date(2026, 11, 6),
                            warehouse_id=1, warehouse_name="Central", direction="OUT",
                            status=status, is_stock_posted=True, indent_id=indent.id)
    db.add(issue)
    await db.flush()
    db.add(m.MaterialIssueLine(issue_id=issue.id, line_no=1, item_id=item.id,
                               indent_item_id=line.id, item_code=item.code,
                               item_name=item.name, uom_code="NOS",
                               requested_qty=Decimal(issued), issued_qty=Decimal(issued)))
    await db.commit()
    issue = (await db.execute(select(m.MaterialIssue).options(
        selectinload(m.MaterialIssue.items)).where(m.MaterialIssue.id == issue.id))).scalar_one()
    return item, line, issue


async def test_a_partly_accepted_delivery_is_not_yet_confirmed(db):
    _item, _line, issue = await _delivery(db, issued=10, received=4)
    assert await wh._receiver_confirmed(db, issue) is False


async def test_turning_the_rest_away_accounts_for_the_whole_delivery(db):
    # 4 accepted + 6 rejected = 10 arrived. Nothing is still on the road, so the issue
    # may settle — even though the line is still owed 6.
    _item, _line, issue = await _delivery(db, issued=10, received=4, rejected=6)
    assert await wh._receiver_confirmed(db, issue) is True


async def test_a_wholly_rejected_delivery_still_arrived(db):
    _item, _line, issue = await _delivery(db, issued=10, received=0, rejected=10)
    assert await wh._receiver_confirmed(db, issue) is True


async def test_rejected_goods_are_credited_to_the_shelf_with_the_accepted_ones(db):
    item, _line, issue = await _delivery(db, issued=10, received=4, rejected=2)
    caps = await wh._issue_confirmation_caps(db, issue)
    # 4 usable + 2 turned away are physically there: 6 land, so a return can leave them.
    assert caps == {item.id: Decimal(6)}


async def test_nothing_accepted_or_rejected_credits_nothing(db):
    _item, _line, issue = await _delivery(db, issued=10)
    assert await wh._issue_confirmation_caps(db, issue) == {}


async def test_what_reached_the_requester_is_what_left_the_store_net_of_returns(db):
    _item, line, _issue = await _delivery(db, issued=10)
    assert await wh.delivered_by_indent_item(db, [line.id]) == {line.id: Decimal(10)}
    assert await wh.delivered_by_indent_item(db, []) == {}


async def test_an_issue_that_never_left_has_delivered_nothing(db):
    _item, line, _issue = await _delivery(db, issued=10, status="APPROVED")
    assert await wh.delivered_by_indent_item(db, [line.id]) == {}


async def test_rejected_quantity_does_not_change_what_is_still_owed(db):
    # `owed` is measured on received alone: the 6 turned away are still to be supplied.
    from app.modules.indents.service import owed_quantity
    _item, line, _issue = await _delivery(db, issued=10, received=4, rejected=6)
    assert owed_quantity(line) - line.received_quantity == Decimal(6)
