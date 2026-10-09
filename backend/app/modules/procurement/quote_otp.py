"""The emailed code a vendor needs before their quotation counts as submitted.

WHY IT EXISTS. A vendor reaches their tender through a link that arrived in an inbox.
That link is the whole of the authentication: anyone who has it — a forwarded mail, a
shared laptop, a mailbox somebody still has access to after leaving — can price a
tender in that company's name, and the buyer has no way to tell. The code proves the
person pressing Submit is reading the address the vendor is registered under, at the
moment they press it.

WHAT IT IS NOT. It is not a second password and it does not protect the READ side: a
vendor can still open the RFQ and draft a quotation without one. The gate is on the
single irreversible act — submitting a price — because that is the one that binds them
and that a buyer will award against.

THE RULES, all enforced HERE and never by the screen (requirement 5, 2026-09-07):

  * the code is six digits, generated with `secrets`, and only its SHA-256 is stored.
    A stored code is a live submit credential and a backup is a folder full of them.
  * requesting again KILLS the previous live code. Two working codes in one inbox
    means the older mail still submits, which is exactly the forwarded-mail case this
    is here to close.
  * expiry is compared against `expires_at` on the server at verification time. A UI
    countdown is a courtesy; a client that never runs it must not get a longer window.
  * a wrong code costs an attempt, and `MAX_ATTEMPTS` of them burn the code. Six digits
    is a million possibilities, which a script exhausts in minutes without this.
  * a used code stays on the table, marked. "Already used" and "never existed" are
    different answers and only one of them is worth investigating.
  * resends are throttled per (rfq, vendor) through `core.cache`, so a vendor cannot
    be used to mail-bomb their own address, and our mailbox cannot be used as a relay.

Failure messages are deliberately specific — wrong, expired, already used, too many
tries. This is not a login: the vendor is already authenticated by their portal token,
so naming the reason leaks nothing to a stranger and saves a support call from someone
staring at a code that went stale while they typed it.
"""
from __future__ import annotations

import hashlib
import logging
import secrets
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.cache import allow
from app.core.exceptions import ValidationError
from app.modules.procurement.models import QuoteOtp
from app.shared.models.base import utcnow
from app.shared.models.master import Vendor

log = logging.getLogger("app.procurement.quote_otp")

#: Six digits. Long enough that a guess is hopeless once attempts are capped, short
#: enough to be read off a phone and typed without a mistake.
CODE_DIGITS = 6

#: How long a code lives when nothing is configured. Requirement 6 makes this an
#: admin setting; until then it is read through `ttl_seconds` so that change lands in
#: one function rather than being hunted down at every call site.
DEFAULT_TTL_SECONDS = 300

#: Where the admin's choice lives — Settings > Security, `SecuritySettings
#: .vendor_quote_otp_seconds`. The SAME string `settings.service.SETTINGS_SPEC` writes:
#: two spellings of one setting is two settings, and the one on the screen would be
#: the one that does nothing.
#:
#: Its own key, NOT shared with the password-reset window: the business may well want
#: a tender code to die in 30 seconds while a reset link lives for 30 minutes, and one
#: setting serving both makes that impossible.
SETTING_KEY = "security.vendor_quote_otp_seconds"

#: Wrong tries before the code is burned and a new one has to be requested.
MAX_ATTEMPTS = 5

#: A vendor may ask for a code this often per RFQ. Not a security control on its own —
#: it stops a stuck screen, or somebody leaning on the button, from filling a
#: stranger's inbox with our mail.
RESEND_LIMIT = 3
RESEND_WINDOW_SECONDS = 300


def _digest(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


async def ttl_seconds(db: AsyncSession) -> int:
    """How long a freshly issued code is good for.

    A single function so requirement 6 — an admin-configurable expiry — is a change to
    what this reads, not a change to the four places that would otherwise each have
    their own idea of the window.
    """
    try:
        from app.platform.settings.service import get_setting
        raw = await get_setting(db, SETTING_KEY)
        # Floored at 30s: the business named 30 seconds as the shortest sensible
        # window, and a nought typed into the box must not make every code dead on
        # arrival with no way back into the screen that sets it.
        return max(30, int(raw)) if raw else DEFAULT_TTL_SECONDS
    except Exception:  # noqa: BLE001 - an unreadable setting must not stop a tender
        return DEFAULT_TTL_SECONDS


def mask_email(address: str | None) -> str:
    """`ab****@example.com` — enough for the vendor to recognise which of their
    addresses it went to, not enough to hand a stranger a new one to try."""
    address = (address or "").strip()
    if "@" not in address:
        return "the address on your vendor record"
    name, _, domain = address.partition("@")
    head = name[:2] if len(name) > 2 else name[:1]
    return f"{head}{'*' * max(2, len(name) - len(head))}@{domain}"


async def issue(db: AsyncSession, rfq_id: int, vendor_id: int,
                *, ip_address: str | None = None) -> dict:
    """Mint a code, kill any live one, mail it. Returns what the screen may show.

    The RETURN carries the masked address and the window, never the code. A route that
    answered with the digits would make the mail decorative and the gate meaningless.
    """
    vendor = await db.get(Vendor, vendor_id)
    address = (getattr(vendor, "email", None) or "").strip()
    if not address:
        raise ValidationError(
            "No email address is recorded for your account, so a code cannot be sent. "
            "Contact the buyer to have it added before submitting.")

    if not await allow(f"quote-otp:{rfq_id}:{vendor_id}",
                       limit=RESEND_LIMIT, window_seconds=RESEND_WINDOW_SECONDS):
        raise ValidationError(
            "Too many codes requested for this tender. Wait a few minutes and try "
            "again, or use the last code that was sent to you.")

    now = utcnow()
    # Every earlier live code dies here. Otherwise the previous mail still submits.
    for stale in (await db.execute(
        select(QuoteOtp).where(QuoteOtp.rfq_id == rfq_id,
                               QuoteOtp.vendor_id == vendor_id,
                               QuoteOtp.used_at.is_(None),
                               QuoteOtp.expires_at > now)
    )).scalars().all():
        stale.used_at = now

    code = "".join(secrets.choice("0123456789") for _ in range(CODE_DIGITS))
    seconds = await ttl_seconds(db)
    db.add(QuoteOtp(
        rfq_id=rfq_id, vendor_id=vendor_id, code_hash=_digest(code),
        sent_to=address, expires_at=now + timedelta(seconds=seconds),
        requested_ip=ip_address,
    ))
    await db.flush()

    await _send(db, vendor, address, code, seconds, rfq_id)
    await db.commit()
    return {"sent_to": mask_email(address), "expires_in_seconds": seconds}


async def verify(db: AsyncSession, rfq_id: int, vendor_id: int, code: str | None) -> None:
    """Spend the code, or refuse the submission. Returns None; raises on every failure.

    Marking `used_at` BEFORE the caller writes the quotation is deliberate: the code is
    spent by the attempt, not by the outcome. If the submit then fails on its own
    validation the vendor requests another — which costs them a moment, and costs an
    attacker a code they can no longer replay.
    """
    typed = (code or "").strip()
    if not typed:
        raise ValidationError("Enter the code emailed to you to submit this quotation.")

    now = utcnow()
    row = (await db.execute(
        select(QuoteOtp)
        .where(QuoteOtp.rfq_id == rfq_id, QuoteOtp.vendor_id == vendor_id)
        .order_by(QuoteOtp.id.desc())
    )).scalars().first()

    if row is None:
        raise ValidationError(
            "No code has been requested for this tender. Press Request OTP first.")
    if row.used_at is not None:
        raise ValidationError(
            "That code has already been used. Request a new one to submit again.")
    if row.expires_at <= now:
        raise ValidationError(
            "That code has expired. Request a new one and enter it straight away.")
    if row.attempts >= MAX_ATTEMPTS:
        raise ValidationError(
            "Too many incorrect attempts on that code. Request a new one.")

    if not secrets.compare_digest(row.code_hash, _digest(typed)):
        row.attempts += 1
        # Committed on the failure path too, or the count resets with the rolled-back
        # transaction and the cap protects nothing.
        await db.commit()
        left = MAX_ATTEMPTS - row.attempts
        raise ValidationError(
            f"That code is not correct. {left} attempt{'' if left == 1 else 's'} left."
            if left > 0 else
            "That code is not correct, and no attempts are left. Request a new one.")

    row.used_at = now
    await db.flush()


async def _send(db: AsyncSession, vendor, address: str, code: str,
                seconds: int, rfq_id: int) -> None:
    """Mail the code through the house letterhead.

    A failed send RAISES, unlike the password-reset path which stays silent on purpose.
    The difference is who is asking: a reset request comes from a stranger who must not
    learn whether an account exists, while this vendor is signed in, is waiting on this
    screen, and needs to know the mail is not coming rather than watching an inbox.
    """
    from app.platform.mail import template
    from app.platform.mail.service import _company, _log_and_send
    from app.shared.enums import MailKind

    minutes = seconds // 60
    window = (f"{minutes} minutes" if minutes >= 2
              else "1 minute" if minutes == 1 else f"{seconds} seconds")
    rfq = await _rfq_number(db, rfq_id)
    subject = f"Your code to submit a quotation for {rfq}"
    text = (
        f"Hello {vendor.name},\n\n"
        f"Your one-time code to submit a quotation for {rfq} is:\n\n"
        f"    {code}\n\n"
        f"It stops working in {window} and can be used once.\n\n"
        "If you did not ask to submit a quotation, ignore this message — nothing has "
        "been submitted in your name.\n\n"
        "— SCM ERP"
    )
    html = template.render(
        subject=subject,
        eyebrow="Tender submission",
        heading="Your one-time code",
        preheader=f"Code for {rfq}. Good for {window}.",
        blocks=[
            template.paragraph(f"Hello {vendor.name},"),
            template.paragraph(
                f"Enter this code on the quotation screen to submit your price for "
                f"{rfq}."),
            template.facts([("Code", code), ("Good for", window),
                            ("Tender", rfq)]),
            template.paragraph(
                "If you did not ask to submit a quotation, ignore this message — "
                "nothing has been submitted in your name.", muted=True),
        ],
        company=await _company(db),
    )
    await _log_and_send(
        db, to_addrs=[address], cc_addrs=None, subject=subject, body=text, html=html,
        kind=MailKind.VENDOR_QUOTE_OTP, actor=None,
        # NEVER log the body: it carries a live code and the Sent tab is readable by
        # anyone with `mail.view`. Same rule as a reset link.
        store_body=False,
    )


async def _rfq_number(db: AsyncSession, rfq_id: int) -> str:
    from app.modules.procurement.models import RFQ
    rfq = await db.get(RFQ, rfq_id)
    return getattr(rfq, "rfq_no", None) or f"RFQ {rfq_id}"
