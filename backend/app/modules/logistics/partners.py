"""The logistics-vendor register — who moves our material, and how they sign in.

A logistics partner (Amazon, Flipkart, Alibaba, Misaba, a local truck operator) is a
`mst_vendors` row whose `vendor_type` is one of `CARRIER_VENDOR_TYPES`. That is not a
new table and not a second supplier master: reusing the vendor row is exactly what
lets a partner sign in through the portal they already have, quote a lane, and keep
their rate history in one place (see `transport.carrier_options`).

What this file adds is the DESK for it. Before, standing up a partner meant two
screens and a piece of folklore: create a vendor in Masters, remember that the type
has to be TRANSPORT or the Dispatch dropdown will not show them, then walk to
Settings > Supplier & Carrier Logins and mint an account. Three quarters of the way
through, the Dispatch screen says "No transport vendors on the master yet" and nobody
can tell which of the three steps was missed. Here it is one row: name them, and give
them a login in the same press.

Import direction (rule 5): logistics sits after procurement, so calling procurement's
account service is allowed — and it is the right call rather than a copy, because the
password rules, the forced first change and the username clash check must be the SAME
ones the supplier portal enforces. There is exactly one kind of vendor login.
"""
import logging
from types import SimpleNamespace

from pydantic import EmailStr, TypeAdapter
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
from app.modules.logistics.enums import CARRIER_VENDOR_TYPES
from app.modules.procurement.models import VendorUser
from app.platform.mail import service as mail_service
from app.platform.mail import template as mail_template
from app.platform.settings.service import write_audit
from app.shared.enums import AuditAction, MailKind
from app.shared.models.master import Vendor

logger = logging.getLogger(__name__)

AUDIT_ENTITY = "mst_vendors"
_EMAIL = TypeAdapter(EmailStr)

#: What the Logistics Vendors screen offers in its type dropdown. The same tuple the
#: Dispatch dropdown filters on, served rather than duplicated in the frontend — a
#: type the screen offers that `carrier_options` does not accept would create a
#: partner nobody can dispatch with, which is the exact failure this file exists for.
PARTNER_TYPE_LABELS = {
    "TRANSPORT": "Transport / freight",
    "LOGISTICS": "Logistics aggregator",
    "COURIER": "Courier / parcel",
}


def partner_types() -> list[dict]:
    return [{"value": code, "label": PARTNER_TYPE_LABELS.get(code, code.title())}
            for code in CARRIER_VENDOR_TYPES]


def _normalise_type(value: str | None) -> str:
    """Blank means TRANSPORT — the common case, and never a type that hides the row
    from the very dropdown it was created for."""
    code = (value or "TRANSPORT").strip().upper()
    if code not in CARRIER_VENDOR_TYPES:
        raise ValidationError(
            f"{value!r} is not a logistics vendor type. "
            f"Choose one of: {', '.join(CARRIER_VENDOR_TYPES)}.")
    return code


def _carrier_only(stmt):
    return stmt.where(func.upper(Vendor.vendor_type).in_(CARRIER_VENDOR_TYPES))


async def _partner(db: AsyncSession, vendor_id: int) -> Vendor:
    """A vendor, but only if it is one of ours.

    Refusing a material supplier by id is deliberate: this screen must never become a
    side door that edits the procurement vendor master or resets a supplier's
    password from a page whose permission was granted to the logistics desk.
    """
    vendor = await db.get(Vendor, vendor_id)
    if vendor is None:
        raise NotFoundError(f"Logistics vendor {vendor_id} not found")
    if (vendor.vendor_type or "").upper() not in CARRIER_VENDOR_TYPES:
        raise ValidationError(
            f"{vendor.name} is a {vendor.vendor_type or 'MATERIAL'} vendor, not a "
            f"logistics partner. Material suppliers are maintained in Masters.")
    return vendor


async def _accounts_by_vendor(db: AsyncSession,
                              vendor_ids: list[int]) -> dict[int, VendorUser]:
    """One query for the whole page. The login state belongs on the same row as the
    partner — a screen that makes you cross-reference two lists to answer "can
    Flipkart sign in?" is the screen we already had."""
    if not vendor_ids:
        return {}
    rows = (await db.execute(
        select(VendorUser).where(VendorUser.vendor_id.in_(vendor_ids))
    )).scalars().all()
    return {row.vendor_id: row for row in rows}


def _row(vendor: Vendor, account: VendorUser | None) -> dict:
    return {
        "id": vendor.id,
        "code": vendor.code,
        "name": vendor.name,
        "vendor_type": (vendor.vendor_type or "").upper(),
        "contact_person": vendor.contact_person,
        "phone": vendor.phone,
        "email": vendor.email,
        "city": vendor.city,
        "state": vendor.state,
        "gstin": vendor.gstin,
        "payment_terms_days": vendor.payment_terms_days,
        "is_active": vendor.is_active,
        "is_approved": vendor.is_approved,
        "is_blacklisted": vendor.is_blacklisted,
        # Everything below is the portal account, flattened onto the partner row.
        "has_login": account is not None,
        "username": account.username if account else None,
        "login_is_active": account.is_active if account else None,
        "must_change_password": account.must_change_password if account else None,
        "last_login_at": account.last_login_at if account else None,
        # What Dispatch will do with them. A blacklisted or inactive partner is still
        # a real record worth seeing; it just cannot be picked (`carrier_options`).
        "dispatchable": bool(vendor.is_active and not vendor.is_blacklisted),
    }


def _carrier_login_url() -> str:
    """The carrier-facing frontend route, rooted at this deployment's public app URL."""
    return f"{settings.APP_BASE_URL.rstrip('/')}/carrier/login"


def _invite_address(raw: str | None, carrier_name: str) -> str | None:
    """Where this partner's invite goes, or None if nobody wrote an address down.

    A blank address is NOT an error, and making it one was: it put the whole Logistics
    Vendors screen behind the mail server. The login is what lets a carrier answer a
    quote request, the invite is only how the password reaches them, and a desk that
    phones the partner and reads it out is how this worked before the invite existed.
    Refusing the account because the notification cannot be sent stops carrier
    onboarding dead every time SMTP is down or a partner is on the phone only.

    A MALFORMED address still raises, and must: that is a typo, the desk can see the
    box it is in, and sending a credential to a mistyped domain is worse than not
    sending it at all.
    """
    address = (raw or "").strip()
    if not address:
        return None
    try:
        return str(_EMAIL.validate_python(address)).lower()
    except ValueError as exc:
        raise ValidationError(
            f"{address!r} is not a valid carrier email address.",
            field="email",
        ) from exc


def _invite_blocked_because(carrier: Vendor) -> str | None:
    """Why this partner's invite cannot go out, in one line for the log, or None.

    Two reasons, and neither is a reason to refuse the login itself: nobody recorded an
    address, or this deployment has no mailbox configured to send from.
    """
    if not _invite_address(carrier.email, carrier.name):
        return "no email address is recorded for them"
    if not settings.mail_configured:
        return "no mailbox is configured on this deployment"
    return None


async def _send_login_invite(db: AsyncSession, *, carrier: Vendor,
                             account: VendorUser, password: str, actor) -> None:
    """Send the carrier's portal invite through the shared mailbox.

    A no-op when there is nothing to send to, so every caller is spared the check and
    no caller can skip it. The account is already minted by this point either way.
    """
    blocked = _invite_blocked_because(carrier)
    if blocked:
        logger.info("No portal invite sent to %s: %s", carrier.name, blocked)
        return
    address = _invite_address(carrier.email, carrier.name)
    login_url = _carrier_login_url()
    name = (carrier.contact_person or carrier.name or "Carrier").strip()
    subject = "Bavya has invited you to SCM ERP"
    text = (
        f"Hello {name},\n\n"
        f"Bavya has invited {carrier.name} to use the SCM ERP carrier portal.\n\n"
        f"Open the carrier login page:\n{login_url}\n\n"
        f"Username: {account.username}\n"
        f"Initial password: {password}\n\n"
        "Use this portal to quote freight, accept awarded jobs and update delivery "
        "progress.\n\n"
        "If you were not expecting this invite, contact the Bavya logistics team.\n\n"
        "- SCM ERP"
    )
    html = mail_template.render(
        subject=subject,
        eyebrow="Carrier portal",
        heading="Bavya has invited you",
        preheader="Use your username and initial password to open the carrier portal.",
        blocks=[
            mail_template.paragraph(f"Hello {name},"),
            mail_template.paragraph(
                f"Bavya has invited {carrier.name} to use the SCM ERP carrier "
                "portal for freight quotes, awarded jobs and delivery updates."),
            mail_template.button("Open carrier login", login_url),
            mail_template.facts([
                ("Carrier", carrier.name),
                ("Username", account.username),
                ("Initial password", password),
                ("Portal", login_url),
            ]),
            mail_template.link_fallback(login_url),
            mail_template.paragraph(
                "Use this portal to quote freight, accept awarded jobs and update "
                "delivery progress.",
                muted=True,
            ),
        ],
        company=await mail_service._company(db),
        footer_note="Keep this invite private. It contains first-login credentials.",
    )
    await mail_service._log_and_send(
        db,
        to_addrs=[address],
        cc_addrs=None,
        subject=subject,
        body=text,
        html=html,
        kind=MailKind.VENDOR_LOGIN_INVITE,
        actor=actor,
        store_body=False,
    )


async def _send_login_invite_from_ids(*, carrier_id: int, account_id: int,
                                      password: str, actor_id: int | None,
                                      actor_name: str | None) -> None:
    """Background-safe invite send with its own database session."""
    from app.core.database import SessionLocal

    async with SessionLocal() as db:
        carrier = await db.get(Vendor, carrier_id)
        account = await db.get(VendorUser, account_id)
        if carrier is None or account is None:
            logger.warning(
                "Carrier invite skipped; carrier=%s account=%s was not found",
                carrier_id, account_id)
            return
        actor = SimpleNamespace(id=actor_id, full_name=actor_name)
        try:
            await _send_login_invite(
                db, carrier=carrier, account=account, password=password,
                actor=actor)
        except Exception:
            logger.exception("Carrier invite email failed for %s", carrier.name)


# --------------------------------------------------------------------------- #
#  Read
# --------------------------------------------------------------------------- #
async def list_partners(db: AsyncSession, params: PageParams,
                        search: str | None = None,
                        vendor_type: str | None = None,
                        active_only: bool = False) -> dict:
    """The register, with each partner's login state on its own row."""
    stmt = _carrier_only(select(Vendor)).order_by(Vendor.name)
    if vendor_type:
        stmt = stmt.where(func.upper(Vendor.vendor_type) == vendor_type.strip().upper())
    if active_only:
        stmt = stmt.where(Vendor.is_active.is_(True))
    if search:
        like = f"%{search.strip()}%"
        stmt = stmt.where(or_(Vendor.name.ilike(like), Vendor.code.ilike(like),
                              Vendor.city.ilike(like)))
    page = await paginate(db, stmt, params)
    accounts = await _accounts_by_vendor(db, [v.id for v in page["items"]])
    page["items"] = [_row(v, accounts.get(v.id)) for v in page["items"]]
    return page


async def get_partner(db: AsyncSession, vendor_id: int) -> dict:
    vendor = await _partner(db, vendor_id)
    accounts = await _accounts_by_vendor(db, [vendor.id])
    return _row(vendor, accounts.get(vendor.id))


async def partner_summary(db: AsyncSession) -> dict:
    """Four counts, so the desk can see at a glance that a partner was created but
    never given a way in — the failure that leaves a quote request unanswered."""
    # The register, not the archive. A removed partner is deactivated rather than
    # deleted, and the screen no longer lists one — counting it here left the Partners
    # tile one ahead of the rows underneath it, with nothing on the page to explain the
    # difference.
    rows = [v for v in (await db.execute(_carrier_only(select(Vendor)))).scalars().all()
            if v.is_active]
    accounts = await _accounts_by_vendor(db, [v.id for v in rows])
    live = [v for v in rows if v.is_active and not v.is_blacklisted]
    return {
        "total": len(rows),
        "dispatchable": len(live),
        "with_login": sum(1 for v in rows
                          if (a := accounts.get(v.id)) is not None and a.is_active),
        "without_login": sum(1 for v in live if v.id not in accounts),
    }


# --------------------------------------------------------------------------- #
#  Write
# --------------------------------------------------------------------------- #
async def _next_code(db: AsyncSession, name: str) -> str:
    """A code nobody has to think of. Derived from the name (FLIPKART -> LGV-FLIPKART)
    and suffixed until it is free, because the code is unique on the live table and a
    clash here would reject the row with a database error rather than a sentence."""
    stem = "".join(ch for ch in (name or "").upper() if ch.isalnum())[:12] or "PARTNER"
    base = f"LGV-{stem}"
    taken = set((await db.execute(
        select(Vendor.code).where(Vendor.code.like(f"{base}%"))
    )).scalars().all())
    if base not in taken:
        return base
    for n in range(2, 100):
        candidate = f"{base}{n}"
        if candidate not in taken:
            return candidate
    raise ValidationError(f"Too many logistics vendors named like {name!r}")


_EDITABLE = ("name", "contact_person", "phone", "email", "address", "city", "state",
             "pincode", "gstin", "pan", "payment_terms_days", "is_active",
             "is_blacklisted")


async def create_partner(db: AsyncSession, data, user,
                         background_tasks=None) -> dict:
    """Add a third-party logistics provider, and optionally let them in.

    `issue_login` is on by default from the screen: a partner with no account cannot
    answer a quote request, and the whole reason THIRD_PARTY exists is the round trip.
    Creating one silently loginless is the same trap the old two-screen route set.
    """
    # The typed address is checked for SHAPE here, while the desk is still looking at
    # the form — but a blank one does not stop the partner or the login being created.
    # See `_invite_address`.
    if getattr(data, "issue_login", False):
        _invite_address(data.email, data.name)
    code = (data.code or "").strip().upper() or await _next_code(db, data.name)
    clash = (await db.execute(
        select(Vendor).where(func.upper(Vendor.code) == code)
    )).scalars().first()
    if clash is not None:
        raise ValidationError(f"The code {code} already belongs to {clash.name}")

    vendor = Vendor(
        code=code,
        name=data.name.strip(),
        vendor_type=_normalise_type(data.vendor_type),
        contact_person=data.contact_person, phone=data.phone, email=data.email,
        address=data.address, city=data.city, state=data.state, pincode=data.pincode,
        gstin=data.gstin, pan=data.pan,
        payment_terms_days=data.payment_terms_days,
        # A partner is created to be used — approved on sight, unlike a material
        # supplier whose approval is a commercial gate procurement owns.
        is_approved=True, is_blacklisted=False, is_active=True,
    )
    db.add(vendor)
    await db.flush()
    await write_audit(db, entity=AUDIT_ENTITY, entity_id=vendor.id,
                      entity_no=vendor.code, action=AuditAction.CREATE, actor=user,
                      after={"name": vendor.name, "vendor_type": vendor.vendor_type},
                      summary=f"Added logistics vendor {vendor.name}")
    await db.commit()
    await db.refresh(vendor)

    if getattr(data, "issue_login", False):
        await issue_login(db, vendor.id, data.username, user, background_tasks)
    return await get_partner(db, vendor.id)


async def update_partner(db: AsyncSession, vendor_id: int, data, user) -> dict:
    """Edit a partner. The code is never rewritten — transport requests, quotes and
    awards snapshot the carrier name against a row identified by that code."""
    vendor = await _partner(db, vendor_id)
    before = {"name": vendor.name, "vendor_type": vendor.vendor_type,
              "is_active": vendor.is_active}
    payload = data.model_dump(exclude_unset=True)
    if "vendor_type" in payload:
        vendor.vendor_type = _normalise_type(payload["vendor_type"])
    for field in _EDITABLE:
        if field in payload:
            setattr(vendor, field, payload[field])
    if not (vendor.name or "").strip():
        raise ValidationError("A logistics vendor needs a name")
    await write_audit(db, entity=AUDIT_ENTITY, entity_id=vendor.id,
                      entity_no=vendor.code, action=AuditAction.UPDATE, actor=user,
                      before=before,
                      after={"name": vendor.name, "vendor_type": vendor.vendor_type,
                             "is_active": vendor.is_active},
                      summary=f"Updated logistics vendor {vendor.name}")
    await db.commit()
    return await get_partner(db, vendor.id)


async def deactivate_partner(db: AsyncSession, vendor_id: int, user) -> dict:
    """Take a partner out of the Dispatch dropdown without deleting their history.

    Their portal account goes with them. A disabled partner whose login still works
    can read a shipment they can no longer be awarded, which is the wrong half of a
    removal to leave running.
    """
    vendor = await _partner(db, vendor_id)
    vendor.is_active = False
    account = (await _accounts_by_vendor(db, [vendor.id])).get(vendor.id)
    if account is not None:
        account.is_active = False
    await write_audit(db, entity=AUDIT_ENTITY, entity_id=vendor.id,
                      entity_no=vendor.code, action=AuditAction.UPDATE, actor=user,
                      before={"is_active": True}, after={"is_active": False},
                      summary=f"Deactivated logistics vendor {vendor.name}")
    await db.commit()
    return await get_partner(db, vendor.id)


# --------------------------------------------------------------------------- #
#  Their login — procurement's account service, reached from this desk
# --------------------------------------------------------------------------- #
# Nothing below re-implements an account. The portal is one portal: same default
# password, same forced first change, same `get_current_vendor` guard. What this desk
# adds is the guarantee that the vendor id it passes is a logistics partner, so the
# permission on this page can never mint or reset a material supplier's credentials.

async def _legacy_clear_forced_change(db: AsyncSession, vendor_id: int) -> None:
    """A logistics partner signs in with the password they were handed, once.

    `ensure_vendor_account` sets the forced first change for every vendor it mints, and
    SUPPLIERS keep it: an RFQ carries prices, so the buyer who typed the password must
    not stay able to read them. A carrier account is a desk rather than a person — the
    number it answers with is a freight rate that desk quoted us anyway — and the change
    screen only meant nobody at the courier could get in on the day a job was tendered.

    Retained only for historical context. New and reset carrier logins no longer call
    this: the invite above emails the partner the default password, so the partner can
    change it themselves and every emailed credential must be changed on first sign-in.
    """
    account = (await db.execute(
        select(VendorUser).where(VendorUser.vendor_id == vendor_id)
    )).scalars().first()
    if account is not None and account.must_change_password:
        account.must_change_password = False
        await db.commit()


async def issue_login(db: AsyncSession, vendor_id: int, username: str | None,
                      user, background_tasks=None) -> dict:
    from app.modules.procurement.schemas import VendorAccountIn
    from app.modules.procurement.service import (
        DEFAULT_VENDOR_PASSWORD, ensure_vendor_account,
    )

    vendor = await _partner(db, vendor_id)
    account = await ensure_vendor_account(
        db, VendorAccountIn(vendor_id=vendor.id,
                            username=(username or "").strip() or None), user)
    if background_tasks is not None:
        background_tasks.add_task(
            _send_login_invite_from_ids,
            carrier_id=vendor.id,
            account_id=account.id,
            password=DEFAULT_VENDOR_PASSWORD,
            actor_id=getattr(user, "id", None),
            actor_name=getattr(user, "full_name", None),
        )
    else:
        await _send_login_invite(
            db, carrier=vendor, account=account, password=DEFAULT_VENDOR_PASSWORD,
            actor=user)
    logger.info("Issued a portal login for logistics vendor %s", vendor.name)
    return await get_partner(db, vendor.id)


async def reset_login(db: AsyncSession, vendor_id: int, user) -> dict:
    from app.modules.procurement.service import reset_vendor_password

    vendor = await _partner(db, vendor_id)
    await reset_vendor_password(db, vendor.id, user)
    return await get_partner(db, vendor.id)


async def set_login_active(db: AsyncSession, vendor_id: int, is_active: bool,
                           user) -> dict:
    from app.modules.procurement.service import set_vendor_account_active

    vendor = await _partner(db, vendor_id)
    await set_vendor_account_active(db, vendor.id, is_active, user)
    return await get_partner(db, vendor.id)
