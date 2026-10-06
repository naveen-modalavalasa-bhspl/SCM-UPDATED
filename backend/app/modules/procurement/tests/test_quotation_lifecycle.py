"""Quotation lifecycle tests (2026-09-26).

Covers the three pieces that landed together:

  * Freeze Prices — the buyer's lock between "open to quotes" and "comparing /
    awarding / raising POs". Every price-changing door must refuse while frozen,
    and POs must refuse while NOT frozen.
  * Change Requests — the buyer asks, the supplier accepts or declines. The
    quote re-prices only on acceptance, through `_quote_totals`'s own arithmetic.
  * Quotation chat — one append-only thread per quotation, shared by both sides.

Shaped on `test_procurement.py`'s `_world`: a small real graph (item, vendor,
RFQ, quotation) built directly on the session, then the service functions called
the way the routers call them.
"""
import pytest
from sqlalchemy import select

from app.core.exceptions import ValidationError
from app.modules.procurement import service
from app.modules.procurement.models import (
    Quotation, QuotationComment, QuotationItem, QuoteChangeRequest,
    RFQ, RFQItem, RFQVendor,
)
from app.modules.procurement.schemas import QuoteChangeRequestIn
from app.platform.hcm.models import HcmEmployee
from app.shared.enums import (
    QuoteChangeStatus, QuotationStatus, RFQStatus,
)
from app.shared.models.base import utcnow
from app.shared.models.master import Item, Uom, Vendor


async def _tender(db):
    """A published RFQ with one invited supplier, their submitted quotation, and
    the buyer who raised the tender."""
    uom = Uom(code="NOS", name="Numbers")
    db.add(uom)
    await db.flush()
    item = Item(code="IT-QL-1", name="Washer", uom_id=uom.id, uom_code="NOS")
    vendor = Vendor(code="V-QL", name="Nexus", gstin="GSTQL", is_active=True)
    buyer = HcmEmployee(id=41, full_name="Buyer Bee", emp_code="E41",
                        is_active=True, synced_at=utcnow())
    db.add_all([item, vendor, buyer])
    await db.flush()

    rfq = RFQ(
        rfq_no="RFQ/2026/QL01", status=RFQStatus.PUBLISHED.value,
        total_items=1, vendor_count=1,
        created_by_id=buyer.id, created_by_name=buyer.full_name,
    )
    db.add(rfq)
    await db.flush()
    rfq_line = RFQItem(
        rfq_id=rfq.id, line_no=1, item_id=item.id, item_code=item.code,
        item_name=item.name, uom_code="NOS", quantity=10,
    )
    db.add(rfq_line)
    db.add(RFQVendor(
        rfq_id=rfq.id, vendor_id=vendor.id, vendor_name=vendor.name,
        mapped_item_ids=[item.id], item_quantities={str(item.id): 10},
    ))
    quote = Quotation(
        quotation_no="Q-QL-1", rfq_id=rfq.id, rfq_no=rfq.rfq_no,
        vendor_id=vendor.id, vendor_name=vendor.name,
        status=QuotationStatus.SUBMITTED.value,
        submitted_at=utcnow(), freight_amount=0, discount_amount=0,
    )
    db.add(quote)
    await db.flush()
    db.add(QuotationItem(
        quotation_id=quote.id, line_no=1, rfq_item_id=rfq_line.id,
        item_id=item.id, item_code=item.code, item_name=item.name,
        uom_code="NOS", quantity=10, rate=100, tax_percent=18, amount=1000,
    ))
    await db.commit()
    # The header totals, priced exactly the way `vendor_submit_quotation` prices
    # a real offer — through the service's own arithmetic, never by hand.
    priced = await service._load_quotation_locked(db, quote.id)
    service._quote_totals(priced)
    await db.commit()
    return item, vendor, buyer, rfq, priced


async def _propose(db, quote, buyer, quantity=10, rate=90):
    # The line id comes off an explicit query, never `quote.items`: the collection
    # is lazy on a freshly flushed object, and touching it outside the async
    # greenlet is the MissingGreenlet trap this suite has hit before.
    line = (await db.execute(
        select(QuotationItem).where(QuotationItem.quotation_id == quote.id)
    )).scalars().first()
    data = QuoteChangeRequestIn(
        reason="Budget ceiling for this line is lower",
        lines=[{
            "quotation_item_id": line.id,
            "proposed_quantity": quantity,
            "proposed_rate": rate,
            "proposed_discount_percent": 0,
        }],
    )
    return await service.propose_quote_change(db, quote.id, data, buyer)


# ── Freeze Prices ─────────────────────────────────────────────────────────────


async def test_freeze_then_unfreeze_round_trip(db):
    _item, _vendor, buyer, rfq, _quote = await _tender(db)
    assert rfq.is_price_frozen is False

    frozen = await service.freeze_rfq(db, rfq.id, buyer)
    assert frozen.is_price_frozen is True
    assert frozen.frozen_by_id == buyer.id
    assert frozen.frozen_at_revision == 1     # the one submitted quotation

    reopened = await service.unfreeze_rfq(
        db, rfq.id, "Vendor asked to re-price a short offer", buyer)
    assert reopened.is_price_frozen is False
    assert reopened.frozen_at is None


async def test_double_freeze_refuses(db):
    _item, _vendor, buyer, rfq, _quote = await _tender(db)
    await service.freeze_rfq(db, rfq.id, buyer)
    with pytest.raises(ValidationError, match="already frozen"):
        await service.freeze_rfq(db, rfq.id, buyer)


async def test_unfreeze_requires_a_reason(db):
    _item, _vendor, buyer, rfq, _quote = await _tender(db)
    await service.freeze_rfq(db, rfq.id, buyer)
    with pytest.raises(ValidationError, match="Say why"):
        await service.unfreeze_rfq(db, rfq.id, "  ", buyer)


async def test_award_refused_while_unfrozen_and_allowed_when_frozen(db):
    item, vendor, buyer, rfq, quote = await _tender(db)
    from app.modules.procurement.schemas import AwardIn

    # Unfrozen: the race is still open to re-pricing, so no award.
    with pytest.raises(ValidationError, match="Freeze prices"):
        await service.award_rfq(db, rfq.id, AwardIn(quotation_id=quote.id), buyer)

    await service.freeze_rfq(db, rfq.id, buyer)
    awarded = await service.award_rfq(
        db, rfq.id, AwardIn(quotation_id=quote.id), buyer)
    assert awarded.awarded_vendor_id == vendor.id


async def test_po_refused_while_unfrozen(db):
    _item, _vendor, buyer, rfq, quote = await _tender(db)
    # Award while frozen (the only legal route), then reopen bidding. The PO must
    # STILL refuse: an order is raised against a comparison that was frozen when
    # it mattered, and "not frozen any more" is exactly the state a PO must not
    # be born into.
    await service.freeze_rfq(db, rfq.id, buyer)
    from app.modules.procurement.schemas import AwardIn
    await service.award_rfq(db, rfq.id, AwardIn(quotation_id=quote.id), buyer)
    await service.unfreeze_rfq(db, rfq.id, "checking the PO gate", buyer)

    from app.modules.procurement.schemas import POFromQuotationIn
    with pytest.raises(ValidationError, match="not frozen"):
        await service.create_po_from_quotation(
            db, quote.id, POFromQuotationIn(), buyer)


# ── Change requests ──────────────────────────────────────────────────────────


async def test_accept_reprices_through_service_arithmetic(db):
    item, vendor, buyer, rfq, quote = await _tender(db)
    cr = await _propose(db, quote, buyer, quantity=10, rate=90)

    assert quote.under_negotiation is True
    assert cr.status == QuoteChangeStatus.AWAITING_SUPPLIER.value
    assert cr.snapshot_before["grand_total"] == 1180.0   # 1000 + 18% tax

    out = await service.accept_quote_change(db, vendor.id, cr.id, "done")
    # 10 x 90 = 900, + 18% tax = 1062 — the same arithmetic `_quote_totals` runs.
    assert float(out.items[0].rate) == 90
    assert float(out.items[0].amount) == 900
    assert float(out.grand_total) == 1062
    assert out.status == QuotationStatus.REVISED.value
    assert out.revision_count == 1
    assert out.accepted_revision == 1
    assert out.under_negotiation is False

    # The lister serves dicts (the diff is decorated server-side), so read keys.
    rows = await service.list_quote_change_requests(db, quote.id, user=None)
    assert [c["status"] for c in rows] == [QuoteChangeStatus.ACCEPTED.value]


async def test_decline_leaves_the_quote_untouched(db):
    item, vendor, buyer, rfq, quote = await _tender(db)
    cr = await _propose(db, quote, buyer, quantity=10, rate=50)

    out = await service.decline_quote_change(db, vendor.id, cr.id, "cannot go below 90")
    assert float(out.items[0].rate) == 100
    assert float(out.grand_total) == 1180
    assert out.under_negotiation is False
    cr_row = (await service.list_quote_change_requests(db, quote.id))[0]
    assert cr_row["status"] == QuoteChangeStatus.DECLINED.value
    assert cr_row["supplier_decision_note"] == "cannot go below 90"


async def test_one_open_request_per_quotation(db):
    _item, _vendor, buyer, rfq, quote = await _tender(db)
    await _propose(db, quote, buyer)
    with pytest.raises(ValidationError, match="already awaiting"):
        await _propose(db, quote, buyer)


async def test_second_request_superseded_when_a_different_one_is_accepted(db):
    """Two asks on one quote is how contracts get two truths. Accept one and the
    other must read SUPERSEDED, never AWAITING_SUPPLIER."""
    item, vendor, buyer, rfq, quote = await _tender(db)
    first = await _propose(db, quote, buyer, rate=80)
    # Withdraw is NOT what a supplier does; a second proposal is refused while
    # the first is open. Simulate the historical hole: the first ask answered.
    first.status = QuoteChangeStatus.DECLINED.value
    second = await _propose(db, quote, buyer, rate=85)
    # Force two open asks by hand — the exact state the guard exists to prevent —
    # and confirm the accept path still closes the loop.
    first.status = QuoteChangeStatus.AWAITING_SUPPLIER.value
    await db.commit()

    await service.accept_quote_change(db, vendor.id, second.id, "")
    assert first.status == QuoteChangeStatus.SUPERSEDED.value
    assert second.status == QuoteChangeStatus.ACCEPTED.value


async def test_withdraw_clears_the_badge(db):
    _item, _vendor, buyer, rfq, quote = await _tender(db)
    cr = await _propose(db, quote, buyer)
    out = await service.withdraw_quote_change(db, quote.id, cr.id, buyer)
    assert out.status == QuoteChangeStatus.WITHDRAWN.value
    assert quote.under_negotiation is False


async def test_frozen_tender_refuses_both_sides_of_negotiation(db):
    item, vendor, buyer, rfq, quote = await _tender(db)
    await service.freeze_rfq(db, rfq.id, buyer)
    with pytest.raises(ValidationError, match="frozen"):
        await _propose(db, quote, buyer)
    # A supplier cannot revive an old ask either.
    rfq.is_price_frozen = False
    cr = await _propose(db, quote, buyer)
    await service.freeze_rfq(db, rfq.id, buyer)
    with pytest.raises(ValidationError, match="frozen"):
        await service.accept_quote_change(db, vendor.id, cr.id, "")


async def test_vendor_scope_is_enforced(db):
    """A different vendor's token cannot accept or even see this quote's asks."""
    item, vendor, buyer, rfq, quote = await _tender(db)
    cr = await _propose(db, quote, buyer)
    stranger = Vendor(code="V-OTHER", name="Rival", gstin="G2", is_active=True)
    db.add(stranger)
    await db.commit()
    from app.core.exceptions import NotFoundError
    with pytest.raises(NotFoundError):
        await service.accept_quote_change(db, stranger.id, cr.id, "")


async def test_price_trail_reads_the_versions(db):
    item, vendor, buyer, rfq, quote = await _tender(db)
    trail = await service.quote_price_trail(db, quote.id)
    assert len(trail) == 1
    assert trail[0]["source"] == "ORIGINAL"
    assert trail[0]["totals"]["grand_total"] == 1180.0

    cr = await _propose(db, quote, buyer, rate=90)
    await service.accept_quote_change(db, vendor.id, cr.id, "")
    trail = await service.quote_price_trail(db, quote.id)
    assert [row["version"] for row in trail] == [1, 2]
    assert trail[1]["source"] == "CHANGE_REQUEST"
    assert trail[1]["cr_no"] == cr.cr_no
    assert trail[1]["totals"]["grand_total"] == 1062


# ── Quotation chat ───────────────────────────────────────────────────────────


async def test_chat_is_append_only_and_shared(db):
    item, vendor, buyer, rfq, quote = await _tender(db)
    buyer_msg = await service.add_quotation_comment(db, quote.id, "Can you do 90?", buyer)
    vendor_msg = await service.add_vendor_quotation_comment(
        db, vendor.id, rfq.id, "Only at 500 units")

    assert buyer_msg.author_side == "BUYER"
    assert vendor_msg.author_side == "SUPPLIER"

    # Both sides read the SAME thread.
    buyer_view = await service.quotation_comments(db, quote.id)
    vendor_view = await service.vendor_quotation_comments(db, vendor.id, rfq.id)
    assert [c.id for c in buyer_view] == [c.id for c in vendor_view]
    assert [c.message for c in buyer_view] == ["Can you do 90?", "Only at 500 units"]

    # Append-only: there is no delete, and the count only grows.
    await service.add_quotation_comment(db, quote.id, "Deal at 500", buyer)
    assert len(await service.quotation_comments(db, quote.id)) == 3


async def test_supplier_cannot_write_on_another_suppliers_quote(db):
    item, vendor, buyer, rfq, _quote = await _tender(db)
    stranger = Vendor(code="V-OTHER2", name="Rival Co", gstin="G3", is_active=True)
    db.add(stranger)
    await db.commit()
    from app.core.exceptions import NotFoundError
    with pytest.raises(NotFoundError):
        await service.add_vendor_quotation_comment(
            db, stranger.id, rfq.id, "let me in")


async def test_supplier_counter_proposal_applies(db):
    item, vendor, buyer, rfq, quote = await _tender(db)
    cr = await _propose(db, quote, buyer, quantity=10, rate=80)
    line = (await db.execute(
        select(QuotationItem).where(QuotationItem.quotation_id == quote.id)
    )).scalars().first()

    counter_lines = [{
        "quotation_item_id": line.id,
        "proposed_quantity": 8,
        "proposed_rate": 85,
        "proposed_discount_percent": 0,
    }]
    out = await service.accept_quote_change(db, vendor.id, cr.id, "counter offer 85 @ 8 units", counter_lines=counter_lines)
    assert float(out.items[0].quantity) == 8
    assert float(out.items[0].rate) == 85
    assert float(out.items[0].amount) == 680
    assert out.accepted_revision == 1
    cr_row = (await service.list_quote_change_requests(db, quote.id))[0]
    assert cr_row["supplier_counter_lines"] is not None

