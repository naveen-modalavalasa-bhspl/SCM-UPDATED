"""The supplier register — who sells us material, and how they sign in.

The material counterpart of `logistics/partners.py`, and deliberately its mirror: a
supplier is a `mst_vendors` row whose `vendor_type` is anything OUTSIDE
`CARRIER_VENDOR_TYPES`, and their portal account is the same `pro_vendor_users` row a
carrier gets. One vendor master, one kind of vendor login, two desks — because the
permission that mints a courier's password must not reach a bandage supplier's, and
the other way round.

Why it exists. A vendor created in Masters has a row and no account, and nothing on
that screen says so: the supplier is on every RFQ picker, gets sent a quote request,
tries to sign in at /supplier and is told the username is wrong. The account could
only be minted from Settings > Supplier & Carrier Logins, which is not in the menu
tree — so in practice suppliers were created and never given a way in. `has_login` on
every row and `without_login` on the summary are the whole point: the gap is visible
before it costs a tender.

Scoping (rule 5): procurement sits BEFORE logistics in the import chain, so nothing
here imports logistics. `CARRIER_VENDOR_TYPES` lives in `app/shared/enums.py` for
exactly this reason and both sides read it from there.

Approvals: none, and none is right. A supplier's commercial approval
(`mst_vendors.is_approved`) is procurement's own gate on the vendor master and is
untouched here — this desk never sets it. Issuing a login is not a document, has no
ladder and enters no workflow; it is an administrator's act, gated by permission
alone, exactly as the carrier register is.
"""
import logging

from pydantic import EmailStr, TypeAdapter
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import NotFoundError, ValidationError
from app.core.pagination import PageParams, paginate
from app.modules.procurement.models import VendorUser
from app.platform.mail import service as mail_service
from app.platform.mail import template as mail_template
from app.platform.settings.service import write_audit
from app.shared.enums import CARRIER_VENDOR_TYPES, AuditAction, MailKind
from app.shared.models.master import Vendor

logger = logging.getLogger(__name__)

AUDIT_ENTITY = "mst_vendors"
_EMAIL = TypeAdapter(EmailStr)

#: What the screen offers in its type dropdown. `mst_vendors.vendor_type` is a plain
#: String(30) defaulting to MATERIAL, so this is a convenience list rather than a
#: constraint — anything that is not a carrier type is accepted, because the live
#: master already holds MANUFACTURER, DEALER, DISTRIBUTOR and SUPPLIER rows that
#: predate any list and must stay editable from here.
SUPPLIER_TYPE_LABELS = {
    "MATERIAL": "Material supplier",
    "MANUFACTURER": "Manufacturer",
    "DISTRIBUTOR": "Distributor",
    "DEALER": "Dealer",
    "SUPPLIER": "Supplier",
    "SERVICE": "Service provider",
}


def supplier_types() -> list[dict]:
    return [{"value": code, "label": label}
            for code, label in SUPPLIER_TYPE_LABELS.items()]


def _normalise_type(value: str | None) -> str:
    """Blank means MATERIAL — the column's own default, and never a carrier type.

    Refusing TRANSPORT/LOGISTICS/COURIER here is what keeps the two registers apart:
    a supplier typed as a carrier would vanish off this screen into the Dispatch
    dropdown, which is the mix-up `vendor_kind_filter` exists to prevent.
    """
    code = (value or "MATERIAL").strip().upper() or "MATERIAL"
    if code in CARRIER_VENDOR_TYPES:
        raise ValidationError(
            f"{code} is a logistics vendor type. Transport providers are maintained "
            "on Settings > Logistics Vendors, not here.")
    return code


def _material_only(stmt):
    """Everything that is not a carrier. `coalesce`, because `vendor_type` is
    NOT NULL with a default in the model but the live table holds rows written before
    that default existed — a NULL is a material supplier, not an unclassified one."""
    return stmt.where(~func.upper(func.coalesce(Vendor.vendor_type, "MATERIAL"))
                      .in_(CARRIER_VENDOR_TYPES))


async def _supplier(db: AsyncSession, vendor_id: int) -> Vendor:
    """A vendor, but only if it is a material one.

    The mirror of `partners._partner`, and refusing a carrier by id matters for the
    same reason: this screen must never become a side door that resets a transport
    provider's password from a permission granted to a buyer.
    """
    vendor = await db.get(Vendor, vendor_id)
    if vendor is None:
        raise NotFoundError(f"Supplier {vendor_id} not found")
    if (vendor.vendor_type or "MATERIAL").upper() in CARRIER_VENDOR_TYPES:
        raise ValidationError(
            f"{vendor.name} is a {vendor.vendor_type} vendor, not a material "
            "supplier. Transport providers are maintained on Settings > Logistics "
            "Vendors.")
    return vendor


async def _accounts_by_vendor(db: AsyncSession,
                              vendor_ids: list[int]) -> dict[int, VendorUser]:
    """One query for the whole page — the login state belongs on the supplier's own
    row, not on a second screen you have to cross-reference."""
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
        "vendor_type": (vendor.vendor_type or "MATERIAL").upper(),
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
        # The portal account, flattened onto the supplier row.
        "has_login": account is not None,
        "username": account.username if account else None,
        "login_is_active": account.is_active if account else None,
        "must_change_password": account.must_change_password if account else None,
        "last_login_at": account.last_login_at if account else None,
        # Whether an RFQ can actually be sent to them. Approval is procurement's own
        # commercial gate and this screen only REPORTS it — a blacklisted or
        # unapproved supplier is still a real record worth seeing.
        "quotable": bool(vendor.is_active and vendor.is_approved
                         and not vendor.is_blacklisted),
    }


def _portal_login_url() -> str:
    """The supplier-facing frontend route, rooted at this deployment's public app URL."""
    return f"{settings.APP_BASE_URL.rstrip('/')}/supplier/login"


def _invite_address(raw: str | None, supplier_name: str) -> str:
    address = (raw or "").strip()
    if not address:
        raise ValidationError(
            f"Add an email address for {supplier_name} before issuing a login.",
            field="email",
        )
    try:
        return str(_EMAIL.validate_python(address)).lower()
    except ValueError as exc:
        raise ValidationError(
            f"{address!r} is not a valid supplier email address.",
            field="email",
        ) from exc


def _require_mailbox_for_invite() -> None:
    if not settings.mail_configured:
        raise ValidationError(
            "Mail is not configured, so the supplier invite cannot be sent.")


async def _send_login_invite(db: AsyncSession, *, vendor: Vendor,
                             account: VendorUser, password: str, actor) -> None:
    """Send the first-login invite through the shared mailbox.

    The account is already created when this runs. A failed send is still raised to
    the buyer, and the failed mail row keeps the SMTP server's own error in Sent.
    """
    address = _invite_address(vendor.email, vendor.name)
    login_url = _portal_login_url()
    name = (vendor.contact_person or vendor.name or "Supplier").strip()
    subject = "Bavya has invited you to SCM ERP"
    text = (
        f"Hello {name},\n\n"
        f"Bavya has invited {vendor.name} to use the SCM ERP supplier portal.\n\n"
        f"Open the supplier login page:\n{login_url}\n\n"
        f"Username: {account.username}\n"
        f"Initial password: {password}\n\n"
        "You will be asked to change this password before RFQs, purchase orders or "
        "despatch notes are shown.\n\n"
        "If you were not expecting this invite, contact the Bavya procurement team.\n\n"
        "- SCM ERP"
    )
    html = mail_template.render(
        subject=subject,
        eyebrow="Supplier portal",
        heading="Bavya has invited you",
        preheader="Use your username and initial password to open the supplier portal.",
        blocks=[
            mail_template.paragraph(f"Hello {name},"),
            mail_template.paragraph(
                f"Bavya has invited {vendor.name} to use the SCM ERP supplier "
                "portal for RFQs, purchase orders and despatch notes."),
            mail_template.button("Open supplier login", login_url),
            mail_template.facts([
                ("Supplier", vendor.name),
                ("Username", account.username),
                ("Initial password", password),
                ("Portal", login_url),
            ]),
            mail_template.link_fallback(login_url),
            mail_template.paragraph(
                "You will be asked to change this password before RFQs, purchase "
                "orders or despatch notes are shown.",
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


# --------------------------------------------------------------------------- #
#  Read
# --------------------------------------------------------------------------- #
async def list_suppliers(db: AsyncSession, params: PageParams,
                         search: str | None = None,
                         vendor_type: str | None = None,
                         active_only: bool = False) -> dict:
    """The register, with each supplier's login state on its own row."""
    stmt = _material_only(select(Vendor)).order_by(Vendor.name)
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


async def get_supplier(db: AsyncSession, vendor_id: int) -> dict:
    vendor = await _supplier(db, vendor_id)
    accounts = await _accounts_by_vendor(db, [vendor.id])
    return _row(vendor, accounts.get(vendor.id))


async def supplier_summary(db: AsyncSession) -> dict:
    """Four counts, so the desk sees at a glance that a supplier exists but has no way
    in — the failure that leaves an RFQ unanswered and looks like the vendor ignoring
    us."""
    rows = [v for v in (await db.execute(_material_only(select(Vendor)))).scalars().all()
            if v.is_active]
    accounts = await _accounts_by_vendor(db, [v.id for v in rows])
    live = [v for v in rows if v.is_approved and not v.is_blacklisted]
    return {
        "total": len(rows),
        "quotable": len(live),
        "with_login": sum(1 for v in rows
                          if (a := accounts.get(v.id)) is not None and a.is_active),
        "without_login": sum(1 for v in live if v.id not in accounts),
    }


# --------------------------------------------------------------------------- #
#  Write
# --------------------------------------------------------------------------- #
async def _next_code(db: AsyncSession, name: str) -> str:
    """A code nobody has to invent. Derived from the name (3M -> SUP-3M) and suffixed
    until it is free, because `code` is unique on the live table and a clash would
    surface as a database error rather than a sentence."""
    stem = "".join(ch for ch in (name or "").upper() if ch.isalnum())[:12] or "SUPPLIER"
    base = f"SUP-{stem}"
    taken = set((await db.execute(
        select(Vendor.code).where(Vendor.code.like(f"{base}%"))
    )).scalars().all())
    if base not in taken:
        return base
    for n in range(2, 100):
        candidate = f"{base}{n}"
        if candidate not in taken:
            return candidate
    raise ValidationError(f"Too many suppliers named like {name!r}")


_EDITABLE = ("name", "contact_person", "phone", "email", "address", "city", "state",
             "pincode", "gstin", "pan", "payment_terms_days", "is_active",
             "is_blacklisted")


async def create_supplier(db: AsyncSession, data, user) -> dict:
    """Add a material supplier, and optionally let them in.

    `is_approved` is FALSE on creation, unlike a carrier's. Approving a supplier is a
    commercial decision procurement owns on the vendor master — a screen about
    passwords must not be able to make one quotable by accident. The row is created,
    the login can be issued, and approval stays where it always was.
    """
    if getattr(data, "issue_login", False):
        _invite_address(data.email, data.name)
        _require_mailbox_for_invite()
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
        is_approved=False, is_blacklisted=False, is_active=True,
    )
    db.add(vendor)
    await db.flush()
    await write_audit(db, entity=AUDIT_ENTITY, entity_id=vendor.id,
                      entity_no=vendor.code, action=AuditAction.CREATE, actor=user,
                      after={"name": vendor.name, "vendor_type": vendor.vendor_type},
                      summary=f"Added supplier {vendor.name}")
    await db.commit()
    await db.refresh(vendor)

    if getattr(data, "issue_login", False):
        await issue_login(db, vendor.id, data.username, user)
    return await get_supplier(db, vendor.id)


async def update_supplier(db: AsyncSession, vendor_id: int, data, user) -> dict:
    """Edit a supplier. The code is never rewritten — RFQs, quotations and orders
    snapshot the vendor against it."""
    vendor = await _supplier(db, vendor_id)
    before = {"name": vendor.name, "vendor_type": vendor.vendor_type,
              "is_active": vendor.is_active}
    payload = data.model_dump(exclude_unset=True)
    if "vendor_type" in payload:
        vendor.vendor_type = _normalise_type(payload["vendor_type"])
    for field in _EDITABLE:
        if field in payload:
            setattr(vendor, field, payload[field])
    if not (vendor.name or "").strip():
        raise ValidationError("A supplier needs a name")
    await write_audit(db, entity=AUDIT_ENTITY, entity_id=vendor.id,
                      entity_no=vendor.code, action=AuditAction.UPDATE, actor=user,
                      before=before,
                      after={"name": vendor.name, "vendor_type": vendor.vendor_type,
                             "is_active": vendor.is_active},
                      summary=f"Updated supplier {vendor.name}")
    await db.commit()
    return await get_supplier(db, vendor.id)


async def deactivate_supplier(db: AsyncSession, vendor_id: int, user) -> dict:
    """Take a supplier off the pickers without deleting their history.

    Their portal account goes with them: a disabled supplier who can still sign in
    reads RFQ prices they can no longer be awarded, which is the wrong half of a
    removal to leave running.
    """
    vendor = await _supplier(db, vendor_id)
    vendor.is_active = False
    account = (await _accounts_by_vendor(db, [vendor.id])).get(vendor.id)
    if account is not None:
        account.is_active = False
    await write_audit(db, entity=AUDIT_ENTITY, entity_id=vendor.id,
                      entity_no=vendor.code, action=AuditAction.UPDATE, actor=user,
                      before={"is_active": True}, after={"is_active": False},
                      summary=f"Deactivated supplier {vendor.name}")
    await db.commit()
    return await get_supplier(db, vendor.id)


# --------------------------------------------------------------------------- #
#  Their login — this module's own account service, reached from this desk
# --------------------------------------------------------------------------- #
# Nothing below re-implements an account. `ensure_vendor_account` is the one place a
# vendor login is minted, and it is idempotent: pressing Issue login twice leaves the
# password the supplier may already have changed exactly as it is.
#
# A supplier KEEPS the forced first change that carriers are excused (see
# `partners._clear_forced_change`): an RFQ carries prices, so the buyer who typed the
# default must not stay able to sign in as the vendor and read them.

async def issue_login(db: AsyncSession, vendor_id: int, username: str | None,
                      user) -> dict:
    from app.modules.procurement.schemas import VendorAccountIn
    from app.modules.procurement.service import (
        DEFAULT_VENDOR_PASSWORD, ensure_vendor_account,
    )

    vendor = await _supplier(db, vendor_id)
    _invite_address(vendor.email, vendor.name)
    _require_mailbox_for_invite()
    account = await ensure_vendor_account(
        db, VendorAccountIn(vendor_id=vendor.id,
                            username=(username or "").strip() or None), user)
    await _send_login_invite(
        db, vendor=vendor, account=account, password=DEFAULT_VENDOR_PASSWORD,
        actor=user)
    logger.info("Issued a portal login for supplier %s", vendor.name)
    return await get_supplier(db, vendor.id)


async def reset_login(db: AsyncSession, vendor_id: int, user) -> dict:
    from app.modules.procurement.service import reset_vendor_password

    vendor = await _supplier(db, vendor_id)
    await reset_vendor_password(db, vendor.id, user)
    return await get_supplier(db, vendor.id)


async def set_login_active(db: AsyncSession, vendor_id: int, is_active: bool,
                           user) -> dict:
    from app.modules.procurement.service import set_vendor_account_active

    vendor = await _supplier(db, vendor_id)
    await set_vendor_account_active(db, vendor.id, is_active, user)
    return await get_supplier(db, vendor.id)
