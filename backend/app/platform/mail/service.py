"""Mail business rules: what gets logged, who is told what, and the reset ladder.

The transport is `client.py`; nothing here opens a socket. The split matters because
every rule below is about the DATABASE and the ANSWER, not about SMTP:

  * a send is written to `sys_mail_messages` BEFORE it is attempted, so a message lost
    to a crash mid-send is still visible as QUEUED rather than leaving no trace;
  * a failure is recorded with the server's own words and then raised, so the Sent tab
    is a truthful log rather than a list of successes;
  * "forgot password" answers the SAME thing whether or not the address exists.

That last one is the whole security of the feature. An endpoint that says "no such
account" is an account-enumeration oracle: anyone can walk a list of addresses and
learn which ones are real, which is the first half of a credential-stuffing run. So
`request_reset` returns None in every case — unknown address, disabled employee, no
local credential, mailbox not configured, SMTP refusing the message. The only place
the difference is visible is the app log, which is not served to anybody.
"""
from __future__ import annotations

import hashlib
import logging
import secrets
from datetime import timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import ValidationError
from app.core.pagination import PageParams, paginate
from app.core.security import hash_password, verify_password
from app.platform.hcm.models import HcmEmployee
from app.platform.mail import client
from app.platform.mail.schemas import MailSendIn
from app.platform.settings.models import MailMessage, PasswordReset, UserCredential
from app.shared.enums import MailKind, MailStatus
from app.shared.models.base import utcnow

log = logging.getLogger(__name__)

#: Same floor as `auth.service.change_password`. One rule for a password, wherever
#: it is set — a reset that accepted a weaker one would be the way around the other.
MIN_PASSWORD_LENGTH = 8


def _digest(token: str) -> str:
    """SHA-256 hex of a reset token. The database only ever holds this."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def mailbox_status() -> dict:
    """What this deployment's mailbox can do. Read from config, never guessed."""
    return {
        "can_send": settings.mail_configured,
        "can_read": settings.imap_configured,
        "from_address": settings.mail_from_address,
        "from_name": settings.MAIL_FROM_NAME,
    }


# --------------------------------------------------------------------------- #
#  Sending
# --------------------------------------------------------------------------- #

async def _log_and_send(db: AsyncSession, *, to_addrs: list[str],
                        cc_addrs: list[str] | None, subject: str, body: str,
                        kind: MailKind, actor=None,
                        store_body: bool = True) -> MailMessage:
    """Write the row, attempt the send, record what happened. Commits either way.

    `store_body=False` for password-reset mail: that body carries a live reset link
    and the Sent tab is readable by anyone holding `mail.view`, so logging it would
    hand every reader a working takeover link for whoever asked for one.
    """
    row = MailMessage(
        to_addrs=", ".join(to_addrs),
        cc_addrs=", ".join(cc_addrs) if cc_addrs else None,
        subject=subject,
        body=body if store_body else None,
        status=MailStatus.QUEUED.value,
        kind=kind.value,
        sent_by_id=getattr(actor, "id", None),
        sent_by_name=getattr(actor, "full_name", None),
    )
    db.add(row)
    # Flushed, not committed: the row must exist before the send is attempted so a
    # crash leaves it QUEUED, but the transaction still belongs to the caller.
    await db.flush()

    try:
        await client.send(to_addrs, subject, body, cc_addrs)
    except Exception as exc:  # noqa: BLE001 - recorded, then re-raised unchanged
        row.status = MailStatus.FAILED.value
        row.error = str(exc)[:2000]
        await db.commit()
        raise

    row.status = MailStatus.SENT.value
    row.sent_at = utcnow()
    await db.commit()
    await db.refresh(row)
    return row


async def send_mail(db: AsyncSession, data: MailSendIn, user) -> MailMessage:
    """Send one message from the Mail screen. Gated on `mail.send` in the router."""
    return await _log_and_send(
        db,
        to_addrs=[str(a) for a in data.to],
        cc_addrs=[str(a) for a in data.cc],
        subject=data.subject,
        body=data.body,
        kind=MailKind.MANUAL,
        actor=user,
    )


async def list_sent(db: AsyncSession, params: PageParams,
                    search: str | None = None) -> dict:
    """The Sent log, newest first. Gated on `mail.view`.

    Every message this app sent, including the failures — which is the reason this
    tab reads our own table rather than the mailbox's Sent folder. A message the
    server refused never reaches that folder, and that is exactly the one somebody
    comes here to find.
    """
    stmt = select(MailMessage)
    if search and search.strip():
        term = f"%{search.strip()}%"
        stmt = stmt.where(or_(
            MailMessage.to_addrs.ilike(term),
            MailMessage.subject.ilike(term),
            MailMessage.sent_by_name.ilike(term),
        ))
    return await paginate(db, stmt.order_by(MailMessage.id.desc()), params)


async def inbox(search: str | None = None, limit: int = client.INBOX_FETCH_LIMIT):
    """The mailbox, live over IMAP, read-only. Gated on `mail.view`."""
    messages = await client.fetch_inbox(limit=limit, search=search)
    return [vars(m) for m in messages]


# --------------------------------------------------------------------------- #
#  Password reset
# --------------------------------------------------------------------------- #

def _reset_email(name: str, link: str, minutes: int) -> tuple[str, str]:
    subject = "Reset your SCM ERP password"
    body = (
        f"Hello {name},\n\n"
        "Somebody asked to reset the password for your SCM ERP account.\n"
        "Open this link to choose a new one:\n\n"
        f"{link}\n\n"
        f"The link stops working in {minutes} minutes and can be used once.\n\n"
        "If this was not you, ignore this message — your password has not changed "
        "and nobody has been given access to your account.\n\n"
        "— SCM ERP"
    )
    return subject, body


async def request_reset(db: AsyncSession, email: str,
                        ip_address: str | None = None) -> None:
    """Start a reset. Returns None in EVERY case, including failure.

    See the module docstring: the caller is unauthenticated, so any difference between
    "sent" and "no such account" tells a stranger which addresses are real. The route
    answers 204 unconditionally and this function never raises.
    """
    address = (email or "").strip().lower()
    if not address:
        return

    employee = (await db.execute(
        select(HcmEmployee).where(func.lower(HcmEmployee.email) == address)
    )).scalars().first()
    if employee is None or not employee.is_active:
        log.info("password reset requested for unknown or inactive address")
        return

    # No local credential means this person signs in some other way. Minting one here
    # would turn "forgot password" into "create me an account".
    cred = await db.get(UserCredential, employee.id)
    if cred is None:
        log.info("password reset requested for employee %s with no local login",
                 employee.id)
        return

    if not settings.mail_configured:
        log.warning("password reset requested but no mailbox is configured")
        return

    # Every earlier unused link for this account dies now. Otherwise asking twice
    # leaves two working takeover links in an inbox, and only one of them gets used.
    now = utcnow()
    live = (await db.execute(
        select(PasswordReset).where(
            PasswordReset.employee_id == employee.id,
            PasswordReset.used_at.is_(None),
            PasswordReset.expires_at > now,
        )
    )).scalars().all()
    for stale in live:
        stale.used_at = now

    token = secrets.token_urlsafe(32)
    db.add(PasswordReset(
        employee_id=employee.id,
        token_hash=_digest(token),
        expires_at=now + timedelta(minutes=settings.PASSWORD_RESET_MINUTES),
        requested_ip=ip_address,
    ))
    await db.flush()

    link = f"{settings.APP_BASE_URL.rstrip('/')}/reset-password?token={token}"
    subject, body = _reset_email(
        employee.full_name or "there", link, settings.PASSWORD_RESET_MINUTES)
    try:
        await _log_and_send(
            db,
            to_addrs=[employee.email],
            cc_addrs=None,
            subject=subject,
            body=body,
            kind=MailKind.PASSWORD_RESET,
            actor=None,
            # NEVER log the body: it is a live takeover link and the Sent tab is
            # readable by anyone with `mail.view`.
            store_body=False,
        )
    except Exception as exc:  # noqa: BLE001 - the caller must not learn it failed
        log.error("password reset mail failed for employee %s: %s", employee.id, exc)
        # `_log_and_send` already committed the FAILED row and the token with it. The
        # token is harmless on its own — it only ever left in the mail that did not go.
        return


async def reset_password(db: AsyncSession, token: str, new_password: str) -> None:
    """Spend a reset link and set the new password.

    Every failure says the same thing — an expired link, a used one and one that never
    existed are indistinguishable to the caller, for the same reason `request_reset`
    is. A weak password is the one exception: that is the caller's own input and they
    have to be told what is wrong with it.
    """
    if len(new_password) < MIN_PASSWORD_LENGTH:
        raise ValidationError(
            f"Use at least {MIN_PASSWORD_LENGTH} characters for the new password")

    now = utcnow()
    row = (await db.execute(
        select(PasswordReset).where(PasswordReset.token_hash == _digest(token))
    )).scalars().first()
    if row is None or row.used_at is not None or row.expires_at <= now:
        raise ValidationError(
            "This reset link is no longer valid. Ask for a new one.")

    cred = await db.get(UserCredential, row.employee_id)
    if cred is None:
        raise ValidationError(
            "This reset link is no longer valid. Ask for a new one.")
    if verify_password(new_password, cred.password_hash):
        raise ValidationError("The new password must differ from the current one")

    cred.password_hash = hash_password(new_password)
    # The whole point of a reset is that the holder chose this password themselves,
    # so there is nothing left to force them to change at next sign-in.
    cred.must_change = False
    cred.failed_attempts = 0
    cred.locked_until = None
    cred.updated_at = now
    # Spent. One link, one password — a second use would let anyone who saw the mail
    # set it again after the owner had.
    row.used_at = now
    await db.commit()
