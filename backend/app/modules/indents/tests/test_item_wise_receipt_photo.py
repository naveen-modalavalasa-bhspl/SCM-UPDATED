"""A delivery is photographed ITEM by item, and the rule is per line, never per unit.

Mock-only: no schema, no connection, no commit. Everything here is either a pure
function or `acknowledge_receipt` with its two database reads stubbed, because the
rule under test is arithmetic over attachment categories and nothing else.
"""
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.core.exceptions import ValidationError
from app.modules.indents import service
from app.shared.enums import IndentStatus


def _photo(scope: str = "") -> SimpleNamespace:
    category = service.ACK_PHOTO_CATEGORY
    if scope:
        category = f"{category}{service.ACK_SCOPE_SEP}{scope}"
    return SimpleNamespace(doc_category=category)


def _item(line_id: int, name: str, *, approved="10", received="0"):
    return SimpleNamespace(
        id=line_id, item_name=name, item_code=f"CODE-{line_id}",
        approved_quantity=Decimal(approved), quantity=Decimal(approved),
        received_quantity=Decimal(received), status="PENDING",
    )


def _indent(*items):
    return SimpleNamespace(
        id=7, indent_no="IND-7", requested_by_id=42,
        status=IndentStatus.ALLOCATED.value, items=list(items),
        acknowledged_at=None, acknowledged_by_id=None, acknowledged_by_name=None,
    )


# --------------------------------------------------------------------------- #
#  The scope: which line a photo is OF
# --------------------------------------------------------------------------- #

def test_a_bare_category_is_a_photo_of_nothing_in_particular():
    # Every receipt photo filed before this existed. It still reads as a photo, and
    # it is not counted as proof of any line — which is the whole point.
    assert service.ack_category_base("RECEIPT_PHOTO") == "RECEIPT_PHOTO"
    assert service.ack_category_item("RECEIPT_PHOTO") is None


def test_a_carton_scope_is_not_read_as_a_line():
    category = "RECEIPT_PHOTO::P-DISPATCH-4-PACKAGE-9"
    assert service.ack_category_base(category) == "RECEIPT_PHOTO"
    assert service.ack_category_item(category) is None


def test_an_item_scope_names_the_line_whatever_carton_it_was_taken_in():
    # The same line, photographed in two different cartons, is the same line. The
    # package half of the scope is the screen's business and never this rule's.
    assert service.ack_category_item("RECEIPT_PHOTO::I-1234-A3F9C1") == 1234
    assert service.ack_category_item("RECEIPT_PHOTO::I-1234-B7D200") == 1234
    # And with no carton at all — a photo taken off the manifest.
    assert service.ack_category_item("RECEIPT_PHOTO::I-1234") == 1234


def test_a_line_id_is_never_read_out_of_the_middle_of_a_scope():
    # `IMAGE-9` must not be mistaken for line 9. The scope is anchored, so only a
    # scope this screen wrote is ever parsed as one.
    assert service.ack_category_item("RECEIPT_PHOTO::IMAGE-9") is None
    assert service.ack_category_item("RECEIPT_PHOTO::C-LEG-1-I-5") is None


# --------------------------------------------------------------------------- #
#  The rule at the save
# --------------------------------------------------------------------------- #

@pytest.fixture
def stub(monkeypatch):
    """`acknowledge_receipt` with its reads and everything downstream replaced.

    The rule under test is arithmetic over attachment categories. What follows it —
    settling the outward legs, the audit row, the commit — is somebody else's tested
    behaviour, so it is stubbed rather than reproduced with a database.
    """
    from app.modules.warehouse import service as warehouse_service

    def _stub(indent, photos):
        monkeypatch.setattr(service, "get_indent", AsyncMock(return_value=indent))
        monkeypatch.setattr(service.attachments, "list_attachments",
                            AsyncMock(return_value=photos))
        monkeypatch.setattr(warehouse_service, "auto_acknowledge_for_indent",
                            AsyncMock(return_value=[]))
        monkeypatch.setattr(service, "write_audit", AsyncMock())
        monkeypatch.setattr(service, "_attach_capabilities",
                            AsyncMock(side_effect=lambda _db, row, _user: row))
        return SimpleNamespace(
            commit=AsyncMock(), flush=AsyncMock(), refresh=AsyncMock(),
            add=lambda *_: None, execute=AsyncMock(), get=AsyncMock(return_value=None),
        )
    return _stub


@pytest.mark.asyncio
async def test_a_line_without_a_photo_of_itself_is_refused_by_name(stub):
    indent = _indent(_item(1, "HDMI cable"), _item(2, "Monitor"))
    # One shot of the sealed load, and one of the cable. The monitor has none.
    db = stub(indent, [_photo(), _photo("I-1-A3F9C1")])

    with pytest.raises(ValidationError) as caught:
        await service.acknowledge_receipt(
            db, 7, {1: Decimal("3"), 2: Decimal("2")}, SimpleNamespace(id=42))

    # Named, not counted: "1 item still needs a photo" on a delivery of eleven sends
    # somebody back through every carton to work out which.
    assert "Monitor" in str(caught.value)
    assert "HDMI cable" not in str(caught.value)


@pytest.mark.asyncio
async def test_one_photo_is_enough_however_large_the_quantity(stub):
    # Sixty cables are photographed ONCE. A rule that scaled with the quantity would
    # be satisfied by sixty pictures of the same bundle.
    indent = _indent(_item(1, "HDMI cable", approved="60"))
    db = stub(indent, [_photo("C-DISPATCH-4"), _photo("I-1-A3F9C1")])

    await service.acknowledge_receipt(db, 7, {1: Decimal("60")}, SimpleNamespace(id=42))

    assert indent.items[0].received_quantity == Decimal("60")


@pytest.mark.asyncio
async def test_a_photo_taken_in_another_carton_still_counts(stub):
    # The same item split across two packages is one item. Demanding a second shot
    # when the second carton is opened teaches a storekeeper that it is a formality.
    indent = _indent(_item(1, "HDMI cable"))
    db = stub(indent, [_photo("C-DISPATCH-4"), _photo("I-1-FFFFFF")])

    await service.acknowledge_receipt(db, 7, {1: Decimal("4")}, SimpleNamespace(id=42))

    assert indent.items[0].received_quantity == Decimal("4")


@pytest.mark.asyncio
async def test_a_line_nobody_is_confirming_needs_no_photo(stub):
    # Only what is being acknowledged today is proved. A line still with procurement
    # cannot be photographed and must not block the goods that did arrive.
    indent = _indent(_item(1, "HDMI cable"), _item(2, "Monitor"))
    db = stub(indent, [_photo("C-DISPATCH-4"), _photo("I-1-A3F9C1")])

    await service.acknowledge_receipt(db, 7, {1: Decimal("4")}, SimpleNamespace(id=42))

    assert indent.items[0].received_quantity == Decimal("4")
    assert indent.items[1].received_quantity == Decimal("0")


@pytest.mark.asyncio
async def test_a_receipt_with_no_photo_at_all_still_says_so_first(stub):
    # The older, wider message. Told before the per-item one, because "attach a
    # photo" is the useful instruction when there are none rather than a list of
    # every line that has none.
    indent = _indent(_item(1, "HDMI cable"))
    db = stub(indent, [])

    with pytest.raises(ValidationError, match="Attach a photo"):
        await service.acknowledge_receipt(
            db, 7, {1: Decimal("4")}, SimpleNamespace(id=42))


@pytest.mark.asyncio
async def test_item_photos_without_a_consignment_photo_are_refused(stub):
    # Every item photographed but not the load: the seal and the number plate are
    # what a carrier claim is argued from, and a carton shot cannot show them.
    indent = _indent(_item(1, "HDMI cable"))
    db = stub(indent, [_photo("P-DISPATCH-4-PACKAGE-9"), _photo("I-1-A3F9C1")])

    with pytest.raises(ValidationError, match="photo of the consignment"):
        await service.acknowledge_receipt(
            db, 7, {1: Decimal("4")}, SimpleNamespace(id=42))
