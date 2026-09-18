import pytest
from sqlalchemy import select

from app.core.config import settings
from app.core.exceptions import ValidationError
from app.modules.procurement import suppliers
from app.modules.procurement.models import VendorUser
from app.platform.settings.models import MailMessage
from app.shared.enums import MailKind, MailStatus
from app.shared.models.master import Vendor


@pytest.fixture(autouse=True)
def mailbox(monkeypatch):
    monkeypatch.setattr(settings, "MAIL_SMTP_HOST", "smtp.example.test")
    monkeypatch.setattr(settings, "MAIL_USERNAME", "scm@example.test")
    monkeypatch.setattr(settings, "MAIL_PASSWORD", "secret")
    monkeypatch.setattr(settings, "APP_BASE_URL", "https://scm.example.test")

    sent = []

    async def _no_smtp(*args, **kwargs):
        sent.append((args, kwargs))

    monkeypatch.setattr(suppliers.mail_service.client, "send", _no_smtp)
    return sent


async def test_issue_login_sends_supplier_invite_with_deployed_portal_link(
    db, make_user, mailbox,
):
    actor = await make_user(employee_id=41, username="BUYER-1", full_name="Buyer")
    vendor = Vendor(
        code="VINAYDEEPAK",
        name="Vinay Deepak Medicals",
        contact_person="Vinay Deepak",
        email="vinaydeepak@example.com",
        vendor_type="SUPPLIER",
        is_active=True,
        is_approved=True,
    )
    db.add(vendor)
    await db.commit()
    await db.refresh(vendor)

    row = await suppliers.issue_login(db, vendor.id, "vinaydeepak", actor)

    assert row["username"] == "vinaydeepak"
    assert row["has_login"] is True
    [(args, kwargs)] = mailbox
    assert args[0] == ["vinaydeepak@example.com"]
    assert args[1] == "Bavya has invited you to SCM ERP"
    assert "https://scm.example.test/supplier/login" in args[2]
    assert "Username: vinaydeepak" in args[2]
    assert "Initial password: Bavya@123" in args[2]
    assert "https://scm.example.test/supplier/login" in kwargs["html"]

    mail = (await db.execute(select(MailMessage))).scalar_one()
    assert mail.kind == MailKind.VENDOR_LOGIN_INVITE.value
    assert mail.status == MailStatus.SENT.value
    assert mail.body is None

    account = (await db.execute(select(VendorUser))).scalar_one()
    assert account.vendor_id == vendor.id
    assert account.must_change_password is True


async def test_issue_login_needs_supplier_email(db, make_user):
    actor = await make_user(employee_id=42, username="BUYER-2")
    vendor = Vendor(
        code="NOEMAIL",
        name="No Email Supplier",
        vendor_type="SUPPLIER",
        is_active=True,
        is_approved=True,
    )
    db.add(vendor)
    await db.commit()
    await db.refresh(vendor)

    with pytest.raises(ValidationError, match="Add an email address"):
        await suppliers.issue_login(db, vendor.id, None, actor)

    accounts = (await db.execute(select(VendorUser))).scalars().all()
    assert accounts == []
