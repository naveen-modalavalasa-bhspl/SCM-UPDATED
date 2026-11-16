"""Goods turned away at delivery arrive in Returns as ONE draft return per acknowledgement.

Mock-only: `create_return` is replaced, so these pin down WHAT is asked of it — the reason,
the lines, the indent it names — and that the reasons the delivery screen offers are real
return reasons. The stock it needs to find on the shelf is the acknowledgement's job and is
tested where the credit happens.
"""
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.modules.indents import hooks as indent_hooks
from app.modules.indents.schemas import ACK_REJECTION_LABELS
from app.modules.returns import service
from app.modules.returns.enums import REASON_LABELS, SELECTABLE_REASONS, ReturnReason


def test_every_reason_the_delivery_screen_offers_is_a_selectable_return_reason():
    # Indents cannot import returns (rule 5), so it keeps a copy of the values. This is
    # what stops the copy drifting: a rename or a retirement here fails the test there.
    selectable = {reason.value for reason in SELECTABLE_REASONS}
    for value in ACK_REJECTION_LABELS:
        assert ReturnReason(value)                      # a real member
        assert value in selectable, f"{value} is no longer a selectable return reason"
        assert value in REASON_LABELS


def test_returns_registers_itself_to_receive_rejected_goods():
    assert service._receipt_rejected in indent_hooks.ON_RECEIPT_REJECTIONS
    service._register_receipt_hooks()                    # twice is still once
    assert indent_hooks.ON_RECEIPT_REJECTIONS.count(service._receipt_rejected) == 1


USER = SimpleNamespace(id=42)


def _group(reason, lines, notes=()):
    return {"reason": reason, "total": sum(l["quantity"] for l in lines),
            "notes": list(notes), "lines": lines}


def _line(item_id, quantity, remarks=None):
    return {"item_id": item_id, "line_id": item_id, "quantity": quantity, "remarks": remarks}


@pytest.fixture
def ctx(monkeypatch):
    created = []

    async def fake_create(db, data, user, *, commit=True, allow_blank_reason=False):
        created.append((data, commit))
        assert allow_blank_reason is True      # the reasons are asked on the Returns page
        n = len(created)
        return {"id": n, "return_no": f"RET-{n}",
                "reason": data.reasons[0].reason.value if data.reasons else None}

    monkeypatch.setattr(service, "create_return", fake_create)
    indent = SimpleNamespace(id=7, requested_by_id=42, status="ALLOCATED")
    db = SimpleNamespace(get=AsyncMock(return_value=indent))
    return SimpleNamespace(db=db, created=created, indent=indent)


@pytest.mark.asyncio
async def test_one_draft_return_for_the_whole_acknowledgement(ctx):
    raised = await service._receipt_rejected(
        ctx.db, USER, {"kind": "INDENT", "number": "IND-7", "indent_id": 7},
        [_group("", [_line(11, 10.0), _line(22, 1.0)])])

    # No reason was asked at the delivery: one return, no reason rows, no main reason.
    assert [r["return_no"] for r in raised] == ["RET-1"]
    assert raised[0]["reason"] is None and raised[0]["quantity"] == 11.0
    (data, commit), = ctx.created
    assert data.reason is None and data.reasons == []
    assert [(l.item_id, l.quantity) for l in data.items] == [
        (11, Decimal("10.000")), (22, Decimal("1.000"))]
    assert "IND-7" in data.reason_note
    # Never commits on its own: the acknowledgement owns the transaction.
    assert commit is False


@pytest.mark.asyncio
async def test_reasons_a_caller_did_name_become_rows_on_the_same_return(ctx):
    raised = await service._receipt_rejected(
        ctx.db, USER, {"kind": "INDENT", "number": "IND-7", "indent_id": 7},
        [_group("EXPIRED", [_line(11, 2.0, "batch A")], ["batch A"]),
         _group("DAMAGED", [_line(11, 10.0), _line(22, 1.0)])])

    assert len(raised) == 1
    (data, _), = ctx.created
    assert [(r.reason, r.quantity) for r in data.reasons] == [
        (ReturnReason.EXPIRED, Decimal("2.000")), (ReturnReason.DAMAGED, Decimal("11.000"))]
    # The same item named under two reasons is one line on the return.
    assert [(l.item_id, l.quantity) for l in data.items] == [
        (11, Decimal("12.000")), (22, Decimal("1.000"))]
    assert "batch A" in data.reason_note


@pytest.mark.asyncio
async def test_the_return_names_the_indent_it_answers(ctx):
    await service._receipt_rejected(
        ctx.db, USER, {"kind": "INDENT", "number": "IND-7", "indent_id": 7},
        [_group("", [_line(11, 1.0)])])
    assert ctx.created[0][0].indent_id == 7


@pytest.mark.asyncio
async def test_an_indent_a_return_cannot_name_never_blocks_the_goods_being_turned_away(ctx):
    # Someone else's request, or one not far enough along: the return is raised on its
    # own instead of the whole acknowledgement failing.
    ctx.indent.status = "PENDING_APPROVAL"
    await service._receipt_rejected(
        ctx.db, USER, {"kind": "INDENT", "number": "IND-7", "indent_id": 7},
        [_group("DAMAGED", [_line(11, 1.0)])])
    assert ctx.created[0][0].indent_id is None

    ctx.created.clear()
    ctx.indent.status, ctx.indent.requested_by_id = "ALLOCATED", 99
    await service._receipt_rejected(
        ctx.db, USER, {"kind": "INDENT", "number": "IND-7", "indent_id": 7},
        [_group("DAMAGED", [_line(11, 1.0)])])
    assert ctx.created[0][0].indent_id is None


@pytest.mark.asyncio
async def test_a_direct_issue_has_no_indent_to_name(ctx):
    await service._receipt_rejected(
        ctx.db, USER, {"kind": "DIRECT_ISSUE", "number": "WHI0042", "indent_id": None},
        [_group("OTHER", [_line(11, 1.0, "wrong colour")], ["wrong colour"])])
    data = ctx.created[0][0]
    assert data.indent_id is None
    assert "WHI0042" in data.reason_note
    assert data.reasons[0].note == "wrong colour"
