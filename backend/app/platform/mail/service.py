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
from app.core.exceptions import NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
from app.core.security import hash_password_async, verify_password_async
from app.platform.hcm.models import HcmEmployee
from app.platform.mail import client, template
from app.platform.mail.schemas import MailComposeIn, MailSendIn
from app.platform.settings.models import (
    EmailClaim, MailMessage, PasswordReset, UserCredential,
)
from app.shared.enums import EmailClaimStatus, MailKind, MailStatus
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
                        store_body: bool = True,
                        html: str | None = None) -> MailMessage:
    """Write the row, attempt the send, record what happened. Commits either way.

    `store_body=False` for password-reset mail: that body carries a live reset link
    and the Sent tab is readable by anyone holding `mail.view`, so logging it would
    hand every reader a working takeover link for whoever asked for one.

    The row logs `body`, the plain-text half, and never `html`: the Sent tab is a
    record of what was said, the markup around it says nothing a reader of that tab
    needs, and a table column holding 12 KB of inline styles per message is a cost
    with no reader.
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
        await client.send(to_addrs, subject, body, cc_addrs, html=html)
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


async def send_mail(db: AsyncSession, data: MailComposeIn | MailSendIn,
                    user) -> MailMessage:
    """Send one message from the Mail screen. Gated on `mail.send` in the router.

    Typed text is WRAPPED in the house template, never sent bare: a message from this
    system carries the same letterhead whether a person wrote it or a document did.
    A caller that has already built its own html (procurement's order copy) passes it
    on `data.html` and is wrapped no further.
    """
    body = data.body
    html = getattr(data, "html", None) or template.render(
        subject=data.subject,
        heading=data.subject,
        preheader=" ".join(body.split())[:120],
        # One typed line is one paragraph. A blank line in the box is therefore
        # spacing and not an empty `<p>`, which is what a naive split would put in.
        blocks=[template.paragraph(line) for line in body.splitlines() if line.strip()],
        company=await _company(db),
    )
    return await _log_and_send(
        db,
        to_addrs=[str(a) for a in data.to],
        cc_addrs=[str(a) for a in data.cc],
        subject=data.subject,
        body=body,
        kind=MailKind.MANUAL,
        actor=user,
        html=html,
    )


async def _reset_minutes(db: AsyncSession) -> int:
    """How long a reset link lives, as the admin has set it.

    Settings first, `config.PASSWORD_RESET_MINUTES` behind it. The env value stays the
    DEFAULT rather than being deleted: it is what shipped, it is what an unconfigured
    deployment and every test still get, and rule 13 keeps deployment-time values in
    `.env`. What changed is only that an admin no longer needs a redeploy to move it.

    Never fatal. An unreadable settings row must not stop somebody getting back into
    their account — the fallback is a working window, not zero.
    """
    try:
        from app.platform.settings.service import get_setting
        raw = await get_setting(db, "security.password_reset_minutes")
        # Floored at 5: a link that dies before the mail is opened is a support call,
        # and a nought typed into the box must not lock everybody out of recovery.
        return max(5, int(raw)) if raw else settings.PASSWORD_RESET_MINUTES
    except Exception as exc:  # noqa: BLE001 - a setting is not worth a locked-out user
        log.warning("reset expiry setting unreadable, using the configured default: %s",
                    exc)
        return settings.PASSWORD_RESET_MINUTES


async def _company(db: AsyncSession) -> template.Company:
    """The letterhead the footer prints. Never fatal: an unreadable settings row must
    not stop a password reset, and `Company()` is the registered particulars."""
    try:
        from app.platform.settings.service import get_company_letterhead
        return template.Company.of(await get_company_letterhead(db))
    except Exception as exc:  # noqa: BLE001 - a footer is not worth a failed send
        log.warning("company letterhead unavailable for mail footer: %s", exc)
        return template.Company()


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

def _reset_email(name: str, link: str, minutes: int,
                 company: template.Company | None = None) -> tuple[str, str, str]:
    """Subject, plain-text body, html body — the three halves of the reset message.

    The plain text is WRITTEN and not derived from the html: this is the one message
    whose fallback a person may genuinely have to read, and the link has to sit on a
    line of its own where a client will make it clickable.

    The link is repeated under the button (`link_fallback`) for the same reason. A
    reset that arrives as an unclickable button is a locked-out user and a support
    call, and the token is already in the message either way.
    """
    subject = "Reset your SCM ERP password"
    text = (
        f"Hello {name},\n\n"
        "Somebody asked to reset the password for your SCM ERP account.\n"
        "Open this link to choose a new one:\n\n"
        f"{link}\n\n"
        f"The link stops working in {minutes} minutes and can be used once.\n\n"
        "If this was not you, ignore this message — your password has not changed "
        "and nobody has been given access to your account.\n\n"
        "— SCM ERP"
    )
    html = template.render(
        subject=subject,
        eyebrow="Account security",
        heading="Reset your password",
        preheader=f"Choose a new password. The link is good for {minutes} minutes.",
        blocks=[
            template.paragraph(f"Hello {name},"),
            template.paragraph(
                "Somebody asked to reset the password for your SCM ERP account. "
                "Choose a new one here:"),
            template.button("Choose a new password", link),
            template.facts([
                ("Valid for", f"{minutes} minutes from now"),
                ("Uses", "Once — the link stops working after a password is set"),
            ]),
            template.link_fallback(link),
            template.paragraph(
                "If this was not you, ignore this message. Your password has not "
                "changed and nobody has been given access to your account.",
                muted=True),
        ],
        company=company,
        footer_note="Never forward this message — the link inside it signs in as you.",
    )
    return subject, text, html


def domain_allowed(address: str) -> bool:
    """Is this address inside the one domain resets may be delivered to?

    `PASSWORD_RESET_EMAIL_DOMAIN` unset means no restriction — a deployment whose
    staff are not all on one domain must not be locked out of its own reset flow.
    """
    allowed = (settings.PASSWORD_RESET_EMAIL_DOMAIN or "").strip().lower().lstrip("@")
    if not allowed:
        return True
    return address.rsplit("@", 1)[-1] == allowed


async def _find_employee(db: AsyncSession, emp_code: str) -> HcmEmployee | None:
    """The account a reset is being asked for, by employee code or numeric id.

    The same two handles `auth.service.authenticate` accepts, minus email — the
    address is what is being ESTABLISHED here, so it cannot also be the way in.
    """
    handle = (emp_code or "").strip()
    if not handle:
        return None
    employee_id = int(handle) if handle.isdigit() else None
    return (await db.execute(
        select(HcmEmployee).where(or_(
            HcmEmployee.emp_code == handle,
            HcmEmployee.id == employee_id if employee_id is not None else False,
        ))
    )).scalars().first()


async def request_reset(db: AsyncSession, emp_code: str, email: str,
                        ip_address: str | None = None) -> None:
    """Start a reset. Returns None in EVERY case, including failure.

    See the module docstring: the caller is unauthenticated, so any difference between
    "sent" and "no such account" tells a stranger which addresses are real. The route
    answers 204 unconditionally and this function never raises.

    TWO WAYS OUT, and which one a request takes is never visible to the caller:

      * the address already on the employee's row matches what was typed — the account
        is proven, and the link goes out now;
      * it does not — the address is FILED as a claim (`sys_email_claims`) and nothing
        is sent until an admin confirms it belongs to that person.

    The second path is the whole reason this takes an emp code at all. HCM serves no
    employee email, so the mirror starts empty and there is nothing to match against;
    trusting the typed address on sight would mean knowing somebody's emp code — which
    is printed on every user list, approval and document — was enough to have their
    reset link delivered to your own inbox. Once a claim is approved the address is on
    the row, and every later reset for that person takes the first path.
    """
    address = (email or "").strip().lower()
    if not address or not domain_allowed(address):
        log.info("password reset requested for an address outside the allowed domain")
        return

    employee = await _find_employee(db, emp_code)
    if employee is None or not employee.is_active:
        log.info("password reset requested for unknown or inactive employee")
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

    if (employee.email or "").strip().lower() != address:
        await _file_email_claim(db, employee, address, ip_address)
        return

    await _send_reset_link(db, employee, ip_address)


async def _file_email_claim(db: AsyncSession, employee: HcmEmployee, address: str,
                            ip_address: str | None) -> None:
    """Hold an unproven address for an admin to confirm. Sends nothing.

    One live claim per (employee, address): asking twice must not queue the same
    decision twice for an admin to work through. A claim for a DIFFERENT address on
    the same account is its own row on purpose — two people claiming one account is
    exactly what the queue exists to show.
    """
    address_taken = (await db.execute(
        select(HcmEmployee).where(func.lower(HcmEmployee.email) == address,
                                  HcmEmployee.id != employee.id)
    )).scalars().first()
    if address_taken is not None:
        # Already proven to belong to somebody else. Approving it would silently
        # redirect that person's future reset links to this account's claimant.
        log.warning("reset claim for employee %s used an address already on employee %s",
                    employee.id, address_taken.id)
        return

    existing = (await db.execute(
        select(EmailClaim).where(EmailClaim.employee_id == employee.id,
                                 func.lower(EmailClaim.email) == address,
                                 EmailClaim.status == EmailClaimStatus.PENDING.value)
    )).scalars().first()
    if existing is not None:
        return

    db.add(EmailClaim(
        employee_id=employee.id,
        employee_code=employee.emp_code,
        employee_name=employee.full_name,
        email=address,
        status=EmailClaimStatus.PENDING.value,
        requested_ip=ip_address,
    ))
    await db.commit()
    log.info("reset address for employee %s filed for confirmation", employee.id)


async def _send_reset_link(db: AsyncSession, employee: HcmEmployee,
                           ip_address: str | None = None) -> None:
    """Issue a token for a PROVEN address and mail the link. Never raises."""
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
    # Read once and used for BOTH the stamp and the sentence in the mail. Reading it
    # twice would let a setting changed between the two lines put a link on the wire
    # that promises one window and dies at another.
    minutes = await _reset_minutes(db)
    db.add(PasswordReset(
        employee_id=employee.id,
        token_hash=_digest(token),
        expires_at=now + timedelta(minutes=minutes),
        requested_ip=ip_address,
    ))
    await db.flush()

    link = f"{settings.APP_BASE_URL.rstrip('/')}/reset-password?token={token}"
    subject, body, html = _reset_email(
        employee.full_name or "there", link, minutes,
        await _company(db))
    try:
        await _log_and_send(
            db,
            to_addrs=[employee.email],
            cc_addrs=None,
            subject=subject,
            body=body,
            html=html,
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


def _claim_out(claim: EmailClaim) -> dict:
    return {
        "id": claim.id,
        "employee_id": claim.employee_id,
        "employee_code": claim.employee_code,
        "employee_name": claim.employee_name,
        "email": claim.email,
        "status": claim.status,
        "requested_ip": claim.requested_ip,
        "created_at": claim.created_at,
        "decided_at": claim.decided_at,
        "decided_by_name": claim.decided_by_name,
    }


async def list_email_claims(db: AsyncSession, params: PageParams,
                            status: str | None = None) -> dict:
    """The confirmation queue. PENDING first, newest first inside that."""
    stmt = select(EmailClaim)
    if status:
        stmt = stmt.where(EmailClaim.status == status)
    stmt = stmt.order_by(
        (EmailClaim.status == EmailClaimStatus.PENDING.value).desc(),
        EmailClaim.created_at.desc(),
    )
    page = await paginate(db, stmt, params)
    page["items"] = [_claim_out(c) for c in page["items"]]
    return page


async def decide_email_claim(db: AsyncSession, claim_id: int, approve: bool,
                             actor) -> dict:
    """Confirm or refuse an address, and on confirmation send the link.

    Approving does BOTH halves in one press on purpose. The address is written onto
    the employee row — which is what makes every later reset for that person immediate
    — and only then is a token issued, so the link is minted against an address an
    admin has just vouched for rather than one sitting in a queue.

    The token is created HERE rather than when the claim was filed: a link issued at
    request time would have burned most of its `PASSWORD_RESET_MINUTES` waiting for a
    human, and would have arrived expired.
    """
    claim = await db.get(EmailClaim, claim_id)
    if claim is None:
        raise NotFoundError("That request no longer exists")
    if claim.status != EmailClaimStatus.PENDING.value:
        raise ValidationError("That request has already been decided")

    now = utcnow()
    claim.decided_at = now
    claim.decided_by_id = getattr(actor, "id", None)
    claim.decided_by_name = getattr(actor, "full_name", None)

    if not approve:
        claim.status = EmailClaimStatus.REJECTED.value
        await db.commit()
        return _claim_out(claim)

    employee = await db.get(HcmEmployee, claim.employee_id)
    if employee is None or not employee.is_active:
        raise ValidationError("That employee is no longer active")

    address = claim.email.strip().lower()
    taken = (await db.execute(
        select(HcmEmployee).where(func.lower(HcmEmployee.email) == address,
                                  HcmEmployee.id != employee.id)
    )).scalars().first()
    if taken is not None:
        # Checked again at decision time, not only when the claim was filed: the
        # address may have been approved for somebody else while this one queued, and
        # `request_reset` takes the FIRST match — two rows sharing an address means
        # one of those people silently receives the other's reset links forever.
        raise ValidationError(
            f"{claim.email} already belongs to another employee. A reset link can "
            "only be delivered to one account.")

    claim.status = EmailClaimStatus.APPROVED.value
    # A DELIBERATE, NARROW exception to rule 10 (`hcm_*` is written only by sync), and
    # a safe one: `mappers.map_employee` omits the `email` key when the feed does not
    # carry one, and `sync._upsert` writes only the keys it is handed, so the address
    # survives every sync. If HCM ever serves emails, its value wins — right way round.
    employee.email = address
    await db.commit()

    await _send_reset_link(db, employee, claim.requested_ip)
    return _claim_out(claim)


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
    if await verify_password_async(new_password, cred.password_hash):
        raise ValidationError("The new password must differ from the current one")

    cred.password_hash = await hash_password_async(new_password)
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
