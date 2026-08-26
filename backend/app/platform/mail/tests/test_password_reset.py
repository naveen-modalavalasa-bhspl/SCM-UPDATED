"""Forgot-password: the address has to be PROVEN before a link is ever sent.

The rebuilt HCM serves no employee email — the only address in its payload belongs to
the person's MANAGER — so the mirror starts with none and there is nothing to match a
typed address against. These tests pin the two things that keeps safe:

  * an unproven address is FILED, never mailed, so knowing somebody's emp code (they
    are on every user list, approval and document) cannot get their reset link
    delivered to your own inbox;
  * every outcome answers 204, so none of it is an account-enumeration oracle.
"""
import pytest

from app.core.config import settings
from app.platform.mail import service
from app.platform.settings.models import EmailClaim, MailMessage, PasswordReset
from app.shared.enums import EmailClaimStatus


@pytest.fixture(autouse=True)
def mailbox(monkeypatch):
    """A configured mailbox whose SMTP never actually opens a socket.

    `request_reset` returns early when `mail_configured` is false, so without this
    every test below would pass for the wrong reason.
    """
    monkeypatch.setattr(settings, "MAIL_SMTP_HOST", "smtp.example.test")
    monkeypatch.setattr(settings, "MAIL_USERNAME", "scm@example.test")
    monkeypatch.setattr(settings, "MAIL_PASSWORD", "secret")

    async def _no_smtp(*args, **kwargs):
        return None

    monkeypatch.setattr(service.client, "send", _no_smtp)


async def _claims(db):
    from sqlalchemy import select
    return (await db.execute(select(EmailClaim))).scalars().all()


async def _mails(db):
    from sqlalchemy import select
    return (await db.execute(select(MailMessage))).scalars().all()


async def _tokens(db):
    from sqlalchemy import select
    return (await db.execute(select(PasswordReset))).scalars().all()


# --------------------------------------------------------------------------- #
#  An address nobody has vouched for is filed, not mailed
# --------------------------------------------------------------------------- #

async def test_an_unproven_address_is_filed_and_no_mail_goes_out(db, make_user):
    await make_user(employee_id=1, username="HR-EMP-1", full_name="Ravi K")

    await service.request_reset(db, "HR-EMP-1", "ravi@bhspl.in", "10.0.0.9")

    claims = await _claims(db)
    assert len(claims) == 1
    assert claims[0].employee_id == 1
    assert claims[0].email == "ravi@bhspl.in"
    assert claims[0].status == EmailClaimStatus.PENDING.value
    assert claims[0].requested_ip == "10.0.0.9"
    # The whole point: nothing was sent and no token exists to be stolen.
    assert await _mails(db) == []
    assert await _tokens(db) == []


async def test_the_takeover_a_claim_prevents(db, make_user):
    """An attacker enters the victim's emp code with their OWN address."""
    victim = await make_user(employee_id=2, username="HR-EMP-2", full_name="Victim")

    await service.request_reset(db, "HR-EMP-2", "attacker@bhspl.in")

    assert await _mails(db) == []
    await db.refresh(victim)
    assert victim.email is None          # nothing was written to the account
    assert (await _claims(db))[0].status == EmailClaimStatus.PENDING.value


async def test_asking_twice_files_one_claim(db, make_user):
    await make_user(employee_id=3, username="HR-EMP-3")

    await service.request_reset(db, "HR-EMP-3", "ravi@bhspl.in")
    await service.request_reset(db, "HR-EMP-3", "ravi@bhspl.in")

    assert len(await _claims(db)) == 1


async def test_a_second_different_address_is_its_own_claim(db, make_user):
    """Two people claiming one account is exactly what the queue exists to show."""
    await make_user(employee_id=4, username="HR-EMP-4")

    await service.request_reset(db, "HR-EMP-4", "real@bhspl.in")
    await service.request_reset(db, "HR-EMP-4", "attacker@bhspl.in")

    assert len({c.email for c in await _claims(db)}) == 2


# --------------------------------------------------------------------------- #
#  A proven address skips the queue
# --------------------------------------------------------------------------- #

async def test_an_address_already_on_the_account_is_mailed_straight_away(db, make_user):
    employee = await make_user(employee_id=5, username="HR-EMP-5")
    employee.email = "ravi@bhspl.in"
    await db.commit()

    await service.request_reset(db, "HR-EMP-5", "Ravi@BHSPL.in")   # case is irrelevant

    assert await _claims(db) == []
    assert len(await _tokens(db)) == 1
    assert [m.to_addrs for m in await _mails(db)] == ["ravi@bhspl.in"]


# --------------------------------------------------------------------------- #
#  Approving is what sends the link
# --------------------------------------------------------------------------- #

async def test_approving_records_the_address_and_sends_the_link(db, make_user):
    employee = await make_user(employee_id=6, username="HR-EMP-6")
    admin = await make_user(employee_id=99, username="ADMIN-1", full_name="Admin A")
    await service.request_reset(db, "HR-EMP-6", "ravi@bhspl.in")
    claim = (await _claims(db))[0]

    out = await service.decide_email_claim(db, claim.id, approve=True, actor=admin)

    assert out["status"] == EmailClaimStatus.APPROVED.value
    assert out["decided_by_name"] == "Admin A"
    await db.refresh(employee)
    assert employee.email == "ravi@bhspl.in"
    assert len(await _tokens(db)) == 1
    assert [m.to_addrs for m in await _mails(db)] == ["ravi@bhspl.in"]


async def test_a_later_reset_is_immediate_once_approved(db, make_user):
    await make_user(employee_id=7, username="HR-EMP-7")
    admin = await make_user(employee_id=98, username="ADMIN-2")
    await service.request_reset(db, "HR-EMP-7", "ravi@bhspl.in")
    await service.decide_email_claim(db, (await _claims(db))[0].id, True, admin)

    await service.request_reset(db, "HR-EMP-7", "ravi@bhspl.in")

    assert len(await _claims(db)) == 1              # no second claim was filed
    assert len(await _tokens(db)) == 2              # a second link went out


async def test_rejecting_sends_nothing_and_records_no_address(db, make_user):
    employee = await make_user(employee_id=8, username="HR-EMP-8")
    admin = await make_user(employee_id=97, username="ADMIN-3")
    await service.request_reset(db, "HR-EMP-8", "attacker@bhspl.in")

    out = await service.decide_email_claim(db, (await _claims(db))[0].id, False, admin)

    assert out["status"] == EmailClaimStatus.REJECTED.value
    await db.refresh(employee)
    assert employee.email is None
    assert await _mails(db) == []
    assert await _tokens(db) == []


async def test_a_claim_cannot_be_decided_twice(db, make_user):
    from app.core.exceptions import ValidationError
    await make_user(employee_id=9, username="HR-EMP-9")
    admin = await make_user(employee_id=96, username="ADMIN-4")
    await service.request_reset(db, "HR-EMP-9", "ravi@bhspl.in")
    claim_id = (await _claims(db))[0].id
    await service.decide_email_claim(db, claim_id, True, admin)

    with pytest.raises(ValidationError):
        await service.decide_email_claim(db, claim_id, True, admin)


async def test_an_address_already_proven_elsewhere_is_refused_at_decision_time(
    db, make_user,
):
    """`request_reset` takes the FIRST match, so two rows sharing an address means one
    person silently receives the other's reset links forever."""
    from app.core.exceptions import ValidationError
    owner = await make_user(employee_id=10, username="HR-EMP-10")
    await make_user(employee_id=11, username="HR-EMP-11")
    admin = await make_user(employee_id=95, username="ADMIN-5")

    await service.request_reset(db, "HR-EMP-11", "shared@bhspl.in")
    claim_id = (await _claims(db))[0].id
    # Approved for somebody else while this one sat in the queue.
    owner.email = "shared@bhspl.in"
    await db.commit()

    with pytest.raises(ValidationError):
        await service.decide_email_claim(db, claim_id, True, admin)


# --------------------------------------------------------------------------- #
#  The gates that file nothing at all
# --------------------------------------------------------------------------- #

async def test_an_address_outside_the_allowed_domain_is_refused(db, make_user,
                                                                monkeypatch):
    monkeypatch.setattr(settings, "PASSWORD_RESET_EMAIL_DOMAIN", "bhspl.in")
    await make_user(employee_id=12, username="HR-EMP-12")

    await service.request_reset(db, "HR-EMP-12", "ravi@gmail.com")

    assert await _claims(db) == []
    assert await _mails(db) == []


async def test_no_configured_domain_accepts_any_address(db, make_user, monkeypatch):
    monkeypatch.setattr(settings, "PASSWORD_RESET_EMAIL_DOMAIN", None)
    await make_user(employee_id=13, username="HR-EMP-13")

    await service.request_reset(db, "HR-EMP-13", "ravi@gmail.com")

    assert len(await _claims(db)) == 1


async def test_an_unknown_emp_code_files_nothing(db):
    await service.request_reset(db, "HR-EMP-NOBODY", "ravi@bhspl.in")
    assert await _claims(db) == []


async def test_an_employee_with_no_local_login_files_nothing(db):
    """Minting a credential here would turn 'forgot password' into 'create me an
    account'."""
    from app.platform.hcm.models import HcmEmployee
    from app.shared.models.base import utcnow
    db.add(HcmEmployee(id=14, full_name="No Login", emp_code="HR-EMP-14",
                       is_active=True, synced_at=utcnow()))
    await db.commit()

    await service.request_reset(db, "HR-EMP-14", "ravi@bhspl.in")

    assert await _claims(db) == []


async def test_an_inactive_employee_files_nothing(db, make_user):
    employee = await make_user(employee_id=15, username="HR-EMP-15")
    employee.is_active = False
    await db.commit()

    await service.request_reset(db, "HR-EMP-15", "ravi@bhspl.in")

    assert await _claims(db) == []


async def test_an_unconfigured_mailbox_files_nothing(db, make_user, monkeypatch):
    """Filing a claim an admin could approve into a mail that can never be sent would
    be a queue of work with no outcome."""
    monkeypatch.setattr(settings, "MAIL_SMTP_HOST", None)
    await make_user(employee_id=16, username="HR-EMP-16")

    await service.request_reset(db, "HR-EMP-16", "ravi@bhspl.in")

    assert await _claims(db) == []


# --------------------------------------------------------------------------- #
#  The route says the same thing every time
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("emp_code,email", [
    ("HR-EMP-20", "ravi@bhspl.in"),        # filed for confirmation
    ("HR-EMP-NOBODY", "ravi@bhspl.in"),    # no such person
])
async def test_the_route_always_answers_204(client, db, make_user, emp_code, email):
    await make_user(employee_id=20, username="HR-EMP-20")

    response = await client.post("/api/auth/forgot-password",
                                 json={"emp_code": emp_code, "email": email})

    assert response.status_code == 204


async def test_the_queue_needs_the_users_permission(client, make_user, login):
    await make_user(employee_id=21, username="nosy", password="pw",
                    permissions=["mail.view"])
    headers = await login("nosy", "pw")

    response = await client.get("/api/mail/email-claims", headers=headers)

    assert response.status_code == 403


async def test_the_queue_lists_pending_claims(client, db, make_user, login):
    await make_user(employee_id=22, username="HR-EMP-22", full_name="Ravi K")
    await make_user(employee_id=23, username="boss", password="pw",
                    permissions=["admin.users.manage"])
    await service.request_reset(db, "HR-EMP-22", "ravi@bhspl.in")
    headers = await login("boss", "pw")

    response = await client.get("/api/mail/email-claims", headers=headers)

    assert response.status_code == 200
    items = response.json()["items"]
    assert len(items) == 1
    assert items[0]["employee_code"] == "HR-EMP-22"
    assert items[0]["email"] == "ravi@bhspl.in"
    assert items[0]["status"] == EmailClaimStatus.PENDING.value


# --------------------------------------------------------------------------- #
#  Pure logic
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("configured,address,allowed", [
    ("bhspl.in", "ravi@bhspl.in", True),
    ("bhspl.in", "ravi@BHSPL.in".lower(), True),
    ("@bhspl.in", "ravi@bhspl.in", True),          # a leading @ is tolerated
    ("bhspl.in", "ravi@gmail.com", False),
    ("bhspl.in", "ravi@notbhspl.in", False),       # not a suffix match
    (None, "ravi@anywhere.com", True),
    ("", "ravi@anywhere.com", True),
])
def test_domain_allowed(monkeypatch, configured, address, allowed):
    monkeypatch.setattr(settings, "PASSWORD_RESET_EMAIL_DOMAIN", configured)
    assert service.domain_allowed(address) is allowed
