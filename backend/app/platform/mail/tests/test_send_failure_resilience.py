"""A failed courtesy email must never poison the caller's session.

SCM_0076 / SCM_0072 / SCM_0087: RFQ approve and PO send-to-vendor both commit the
real change and then email a copy as a courtesy. When that email failed AND the
commit that recorded the FAILED row in `sys_mail_messages` also failed (the same
connection loss that broke the SMTP attempt also broke the open transaction), the
session was left "pending rollback" with nothing having rolled it back — so the
very next statement on it raised `PendingRollbackError`, turning a logged mail
failure into an unrelated 500 on whatever the caller did next.
"""
import pytest
from sqlalchemy import select

from app.platform.mail import service
from app.shared.enums import MailKind


async def test_log_and_send_rolls_back_when_the_failure_commit_also_fails(db, monkeypatch):
    async def _boom_send(*args, **kwargs):
        raise RuntimeError("smtp unreachable")

    real_commit = db.commit
    calls = {"n": 0}

    async def _boom_commit():
        calls["n"] += 1
        raise RuntimeError("connection lost")

    monkeypatch.setattr(service.client, "send", _boom_send)
    monkeypatch.setattr(db, "commit", _boom_commit)

    with pytest.raises(RuntimeError, match="smtp unreachable"):
        await service._log_and_send(
            db, to_addrs=["vendor@example.test"], cc_addrs=None,
            subject="s", body="b", kind=MailKind.MANUAL,
        )

    assert calls["n"] == 1  # the FAILED-row commit was attempted, and it failed

    # The real bug: without the rollback, this next statement raised
    # PendingRollbackError instead of running.
    monkeypatch.setattr(db, "commit", real_commit)
    result = await db.execute(select(1))
    assert result.scalar() == 1


async def test_log_and_send_still_raises_the_original_error_when_commit_succeeds(db, monkeypatch):
    """The ordinary case — recording FAILED works fine — must still re-raise so the
    caller (email_po_copy / email_rfq_copies) can log and swallow it."""
    async def _boom_send(*args, **kwargs):
        raise RuntimeError("smtp unreachable")

    monkeypatch.setattr(service.client, "send", _boom_send)

    with pytest.raises(RuntimeError, match="smtp unreachable"):
        await service._log_and_send(
            db, to_addrs=["vendor@example.test"], cc_addrs=None,
            subject="s", body="b", kind=MailKind.MANUAL,
        )

    result = await db.execute(select(1))
    assert result.scalar() == 1
