"""A delivery can be partly accepted, and what is turned away is said by reason.

Mock-only, like `test_item_wise_receipt_photo.py`: no schema, no connection. The rules under
test are arithmetic and grouping over the rejections of one acknowledgement; what follows
them (settling the issue, the audit row, the commit, raising the returns) is stubbed.
"""
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError as SchemaError

from app.core.exceptions import ValidationError
from app.modules.indents import hooks, service
from app.modules.indents.schemas import (
    ACK_DAMAGE_REASONS, ACK_REJECTION_LABELS, AcknowledgeLineIn, ReceiptRejectionIn,
)
from app.shared.enums import IndentStatus


def _photo(scope: str = "") -> SimpleNamespace:
    category = service.ACK_PHOTO_CATEGORY
    if scope:
        category = f"{category}{service.ACK_SCOPE_SEP}{scope}"
    return SimpleNamespace(doc_category=category)


def _item(line_id: int, name: str, *, approved="10", received="0", rejected="0", item_id=None):
    return SimpleNamespace(
        id=line_id, item_id=item_id or 100 + line_id, item_name=name,
        item_code=f"CODE-{line_id}", approved_quantity=Decimal(approved),
        quantity=Decimal(approved), received_quantity=Decimal(received),
        rejected_quantity=Decimal(rejected), status="PENDING",
    )


def _indent(*items):
    return SimpleNamespace(
        id=7, indent_no="IND-7", requested_by_id=42,
        status=IndentStatus.ALLOCATED.value, items=list(items),
        acknowledged_at=None, acknowledged_by_id=None, acknowledged_by_name=None,
    )


def _row(reason: str, quantity: float, comment: str | None = None) -> dict:
    return {"reason": reason, "quantity": quantity, "comment": comment}


# --------------------------------------------------------------------------- #
#  The input
# --------------------------------------------------------------------------- #

def test_every_reason_the_screen_offers_has_words():
    assert list(ACK_REJECTION_LABELS.values()) == [
        "Damaged", "Expired", "Near expiry", "Leakage", "Broken package", "Other"]


def test_other_has_to_say_what_it_means():
    with pytest.raises(SchemaError):
        ReceiptRejectionIn(reason="OTHER", quantity=1)
    assert ReceiptRejectionIn(reason="other", quantity=1, comment="wrong colour").reason == "OTHER"


def test_an_unknown_reason_is_refused():
    with pytest.raises(SchemaError):
        ReceiptRejectionIn(reason="STOLEN", quantity=1)


def test_a_rejection_has_to_be_more_than_nothing():
    with pytest.raises(SchemaError):
        ReceiptRejectionIn(reason="DAMAGED", quantity=0)


def test_a_line_can_be_wholly_rejected_but_never_wholly_empty():
    only_rejected = AcknowledgeLineIn(
        indent_item_id=1, received_quantity=0,
        rejections=[ReceiptRejectionIn(reason="EXPIRED", quantity=3)])
    assert only_rejected.received_quantity == 0
    with pytest.raises(SchemaError):
        AcknowledgeLineIn(indent_item_id=1, received_quantity=0)


# --------------------------------------------------------------------------- #
#  Grouping: one return per reason
# --------------------------------------------------------------------------- #

def test_rejections_are_grouped_by_reason_across_lines():
    lines = {1: _item(1, "Gloves", item_id=11), 2: _item(2, "Syringe", item_id=22)}
    groups = service.rejection_groups(lines, {
        1: [_row("EXPIRED", 2, "batch A"), _row("DAMAGED", 10)],
        2: [_row("EXPIRED", 1, "batch A"), _row("EXPIRED", 1, "batch B")],
    })

    by_reason = {g["reason"]: g for g in groups}
    assert set(by_reason) == {"EXPIRED", "DAMAGED"}
    assert by_reason["EXPIRED"]["total"] == 4
    assert by_reason["DAMAGED"]["total"] == 10
    # Same note twice is said once.
    assert by_reason["EXPIRED"]["notes"] == ["batch A", "batch B"]
    # One line per item inside a group.
    assert sorted((l["item_id"], l["quantity"]) for l in by_reason["EXPIRED"]["lines"]) == [(11, 2), (22, 2)]


def test_the_same_item_twice_in_a_reason_is_one_line_of_the_return():
    lines = {1: _item(1, "Gloves", item_id=11)}
    (group,) = service.rejection_groups(lines, {1: [_row("DAMAGED", 2, "left"), _row("DAMAGED", 3, "right")]})
    assert len(group["lines"]) == 1
    assert group["lines"][0]["quantity"] == 5
    assert group["lines"][0]["remarks"] == "left · right"


def test_the_receipt_says_what_was_turned_away_in_words():
    lines = {1: _item(1, "Gloves")}
    groups = service.rejection_groups(lines, {1: [_row("EXPIRED", 2), _row("DAMAGED", 10, "crushed")]})
    assert service.rejection_remark(groups) == "Not accepted: Expired 2, Damaged 10 (crushed)"


# --------------------------------------------------------------------------- #
#  The acknowledgement
# --------------------------------------------------------------------------- #

@pytest.fixture
def stub(monkeypatch):
    """`acknowledge_receipt` with its reads and everything downstream replaced."""
    from app.modules.warehouse import service as warehouse_service

    def _stub(indent, photos, *, delivered=None, raised=None):
        monkeypatch.setattr(service, "get_indent", AsyncMock(return_value=indent))
        monkeypatch.setattr(service.attachments, "list_attachments", AsyncMock(return_value=photos))
        confirm = AsyncMock(return_value=[])
        monkeypatch.setattr(warehouse_service, "auto_acknowledge_for_indent", confirm)
        monkeypatch.setattr(warehouse_service, "delivered_by_indent_item",
                            AsyncMock(return_value=delivered or {}))
        raise_returns = AsyncMock(return_value=raised or [])
        monkeypatch.setattr(hooks, "raise_returns", raise_returns)
        monkeypatch.setattr(service, "write_audit", AsyncMock())
        monkeypatch.setattr(service, "_attach_capabilities",
                            AsyncMock(side_effect=lambda _db, row, _user: row))
        db = SimpleNamespace(commit=AsyncMock(), flush=AsyncMock(), refresh=AsyncMock(),
                             add=lambda *_: None, execute=AsyncMock(),
                             get=AsyncMock(return_value=None))
        return SimpleNamespace(db=db, confirm=confirm, raise_returns=raise_returns)
    return _stub


USER = SimpleNamespace(id=42)
PHOTOS = [_photo("C-DISPATCH-4"), _photo("I-1-AAAAAA"), _photo("I-2-BBBBBB")]


@pytest.mark.asyncio
async def test_rejected_goods_are_arrived_but_not_received(stub):
    gloves = _item(1, "Gloves")
    ctx = stub(_indent(gloves), PHOTOS, delivered={1: Decimal("10")})

    await service.acknowledge_receipt(
        ctx.db, 7, {1: Decimal("6")}, USER,
        rejections={1: [_row("EXPIRED", 2), _row("DAMAGED", 2, "crushed")]})

    # Only the accepted six are received: the line is still owed the rest.
    assert gloves.received_quantity == Decimal("6")
    assert gloves.rejected_quantity == Decimal("4")


@pytest.mark.asyncio
async def test_a_line_can_be_turned_away_whole(stub):
    gloves = _item(1, "Gloves")
    ctx = stub(_indent(gloves), PHOTOS, delivered={1: Decimal("10")})

    await service.acknowledge_receipt(
        ctx.db, 7, {1: Decimal("0")}, USER, rejections={1: [_row("EXPIRED", 10)]})

    assert gloves.received_quantity == Decimal("0")
    assert gloves.rejected_quantity == Decimal("10")


@pytest.mark.asyncio
async def test_each_acknowledgement_adds_to_what_was_rejected_before(stub):
    gloves = _item(1, "Gloves", received="3", rejected="2")
    ctx = stub(_indent(gloves), PHOTOS, delivered={1: Decimal("10")})

    await service.acknowledge_receipt(
        ctx.db, 7, {1: Decimal("2")}, USER, rejections={1: [_row("EXPIRED", 3)]})

    assert gloves.received_quantity == Decimal("5")
    assert gloves.rejected_quantity == Decimal("5")


@pytest.mark.asyncio
async def test_more_than_reached_you_cannot_be_accepted_and_rejected(stub):
    # 5 delivered, 3 already accepted: 2 left to account for, and 3 + 1 is too many.
    gloves = _item(1, "Gloves", received="3")
    ctx = stub(_indent(gloves), PHOTOS, delivered={1: Decimal("5")})

    with pytest.raises(ValidationError) as caught:
        await service.acknowledge_receipt(
            ctx.db, 7, {1: Decimal("1")}, USER, rejections={1: [_row("DAMAGED", 2)]})

    assert "not yet accounted for" in str(caught.value)
    assert gloves.rejected_quantity == Decimal("0")        # nothing written


@pytest.mark.asyncio
async def test_a_rejection_on_a_line_that_is_not_on_the_indent_is_refused(stub):
    ctx = stub(_indent(_item(1, "Gloves")), PHOTOS, delivered={1: Decimal("10")})

    with pytest.raises(ValidationError):
        await service.acknowledge_receipt(
            ctx.db, 7, {1: Decimal("1")}, USER, rejections={99: [_row("DAMAGED", 1)]})


@pytest.mark.asyncio
async def test_a_rejected_line_still_needs_a_photo_of_itself(stub):
    ctx = stub(_indent(_item(1, "Gloves")), [_photo("C-DISPATCH-4")],
               delivered={1: Decimal("10")})

    with pytest.raises(ValidationError) as caught:
        await service.acknowledge_receipt(
            ctx.db, 7, {1: Decimal("0")}, USER, rejections={1: [_row("EXPIRED", 2)]})

    assert "Gloves" in str(caught.value)


@pytest.mark.asyncio
async def test_goods_harmed_in_transit_claim_the_carrier(stub):
    ctx = stub(_indent(_item(1, "Gloves")), PHOTOS, delivered={1: Decimal("10")})

    await service.acknowledge_receipt(
        ctx.db, 7, {1: Decimal("8")}, USER, rejections={1: [_row("DAMAGED", 2, "crushed")]})

    kwargs = ctx.confirm.await_args.kwargs
    assert kwargs["condition"] == "DAMAGED"
    # The description the claim is investigated from is written for them.
    assert "Not accepted: Damaged 2 (crushed)" in kwargs["remarks"]


@pytest.mark.asyncio
async def test_expired_goods_are_not_the_carriers_fault(stub):
    ctx = stub(_indent(_item(1, "Gloves")), PHOTOS, delivered={1: Decimal("10")})

    await service.acknowledge_receipt(
        ctx.db, 7, {1: Decimal("8")}, USER,
        rejections={1: [_row("EXPIRED", 1), _row("NEAR_EXPIRY", 1)]})

    assert ctx.confirm.await_args.kwargs["condition"] == "GOOD"


@pytest.mark.asyncio
async def test_one_return_is_asked_for_per_reason_and_reported_back(stub):
    raised = [{"id": 1, "return_no": "RET-1", "reason": "EXPIRED", "quantity": 2}]
    ctx = stub(_indent(_item(1, "Gloves")), PHOTOS, delivered={1: Decimal("10")}, raised=raised)

    result = await service.acknowledge_receipt(
        ctx.db, 7, {1: Decimal("6")}, USER,
        rejections={1: [_row("EXPIRED", 2), _row("DAMAGED", 2)]})

    _db, _user, source, groups = ctx.raise_returns.await_args.args
    assert source["kind"] == "INDENT" and source["number"] == "IND-7" and source["indent_id"] == 7
    assert [g["reason"] for g in groups] == ["EXPIRED", "DAMAGED"]
    assert result.receipt_returns == raised


@pytest.mark.asyncio
async def test_a_plain_acknowledgement_raises_nothing_and_asks_nothing_extra(stub):
    gloves = _item(1, "Gloves")
    ctx = stub(_indent(gloves), PHOTOS)

    await service.acknowledge_receipt(ctx.db, 7, {1: Decimal("4")}, USER)

    assert gloves.received_quantity == Decimal("4")
    assert gloves.rejected_quantity == Decimal("0")
    # Nothing was turned away, so the returns hook is not even asked.
    ctx.raise_returns.assert_not_awaited()
    assert ctx.confirm.await_args.kwargs["condition"] == "GOOD"


def test_the_damage_reasons_are_exactly_the_ones_that_claim_the_carrier():
    assert ACK_DAMAGE_REASONS == {"DAMAGED", "PACKAGING_DAMAGED", "LEAKED_SPILLED"}


def test_serial_numbers_must_match_the_quantity_turned_away():
    assert ReceiptRejectionIn(reason="DAMAGED", quantity=2, serial_numbers=["A", "B"]).serial_numbers == ["A", "B"]
    with pytest.raises(ValueError):
        ReceiptRejectionIn(reason="DAMAGED", quantity=2, serial_numbers=["A"])
    with pytest.raises(ValueError):
        ReceiptRejectionIn(reason="DAMAGED", quantity=2, serial_numbers=["A", "A"])


def test_the_serials_follow_the_goods_into_the_grouped_lines():
    by_id = {1: SimpleNamespace(item_id=10)}
    groups = service.rejection_groups(by_id, {1: [
        {"reason": "EXPIRED", "quantity": 2, "serial_numbers": ["A", "B"]}]})
    assert groups[0]["lines"][0]["serial_numbers"] == ["A", "B"]
