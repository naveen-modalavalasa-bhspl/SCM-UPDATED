"""A failed courtesy email must not break the next thing that touches the session.

A rollback expires every object on an async session, and an expired attribute cannot
be re-read there, so rolling back unconditionally turned a logged mail failure into a
500. `_heal_session` rolls back only when the session is actually left "pending
rollback", and the callers read what they need into plain values first.
"""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.modules.procurement import service


def _db(active: bool):
    return SimpleNamespace(
        sync_session=SimpleNamespace(is_active=active),
        rollback=AsyncMock(), refresh=AsyncMock(),
    )


@pytest.mark.asyncio
async def test_a_healthy_session_is_left_alone():
    db = _db(active=True)
    assert await service._heal_session(db, SimpleNamespace(id=1)) is False
    db.rollback.assert_not_awaited()
    db.refresh.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_session_pending_rollback_is_rolled_back_and_the_user_reloaded():
    db = _db(active=False)
    user = SimpleNamespace(id=1)
    assert await service._heal_session(db, user) is True
    db.rollback.assert_awaited_once()
    db.refresh.assert_awaited_once_with(user)


@pytest.mark.asyncio
async def test_a_user_that_cannot_be_refreshed_does_not_fail_the_heal():
    db = _db(active=False)
    db.refresh = AsyncMock(side_effect=RuntimeError("not persistent"))
    assert await service._heal_session(db, SimpleNamespace(id=1)) is True


@pytest.mark.asyncio
async def test_one_failed_vendor_does_not_stop_the_others_being_emailed(monkeypatch):
    vendors = [
        SimpleNamespace(vendor_id=1, vendor_name="A", vendor_email="a@example.com",
                        mapped_item_ids=[1], item_quantities={"1": 2}),
        SimpleNamespace(vendor_id=2, vendor_name="B", vendor_email="b@example.com",
                        mapped_item_ids=None, item_quantities=None),
    ]
    rfq = SimpleNamespace(id=9, rfq_no="RFQ-9", due_date=None, vendors=vendors)
    db = _db(active=False)            # the first failure leaves it pending rollback

    sent_to = []

    async def send_mail(_db, payload, _user, attachments=None):
        sent_to.append(payload.to[0])
        if payload.to[0] == "a@example.com":
            # Poison the walk: if the loop still read `rfq.vendors` after the heal it
            # would find these expired. Real expiry raises MissingGreenlet on access.
            rfq.vendors = None
            raise RuntimeError("smtp unreachable")

    reloaded = SimpleNamespace(id=9, rfq_no="RFQ-9", due_date=None, vendors=[])
    get_rfq = AsyncMock(return_value=reloaded)
    monkeypatch.setattr(service, "get_rfq", get_rfq)
    monkeypatch.setattr(service.mail_service, "send_mail", send_mail)
    monkeypatch.setattr(service.mail_service, "_company", AsyncMock(return_value=None))
    monkeypatch.setattr(service.mail_template, "render", lambda **kw: "<html/>")
    monkeypatch.setattr(service.mail_template, "paragraph", lambda *a, **k: "")
    monkeypatch.setattr(service.mail_template, "facts", lambda *a, **k: "")
    monkeypatch.setattr(service.mail_template, "button", lambda *a, **k: "")
    monkeypatch.setattr(service.vendor_documents, "rfq_pdf", lambda *a, **k: b"%PDF")

    await service.email_rfq_copies(db, rfq, SimpleNamespace(id=1))

    assert sent_to == ["a@example.com", "b@example.com"]
    db.rollback.assert_awaited_once()
    get_rfq.assert_awaited_once_with(db, 9)
