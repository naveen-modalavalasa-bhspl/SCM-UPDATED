"""The logistics vendor register — the desk behind the Dispatch dropdown.

What is pinned here is the promise the screen makes: a partner added on this page is
one the Dispatch dropdown will actually offer, with a login they can actually answer
with. Three ways that promise used to break, and each is a test below:

  * created with a type the dropdown filters out, so they never appear
  * created without an account, so the quote request reaches nobody
  * a page whose permission reaches a MATERIAL supplier's row and password
"""
import pytest

from app.core.exceptions import NotFoundError, ValidationError
from app.core.pagination import PageParams
from app.modules.logistics import partners, transport
from app.modules.logistics.schemas import PartnerCreate, PartnerUpdate
from app.platform.hcm.models import HcmEmployee
from app.shared.models.base import utcnow
from app.shared.models.master import Vendor

pytestmark = pytest.mark.asyncio


async def _admin(db) -> HcmEmployee:
    user = HcmEmployee(id=71, full_name="Settings Admin", emp_code="E71",
                       is_active=True, synced_at=utcnow())
    db.add(user)
    await db.commit()
    return user


async def test_added_partner_is_offered_on_dispatch(db):
    """The whole point of the screen: name them, and Dispatch can pick them."""
    user = await _admin(db)
    row = await partners.create_partner(
        db, PartnerCreate(name="Flipkart", issue_login=False), user)

    assert row["vendor_type"] == "TRANSPORT"
    assert row["dispatchable"] is True
    offered = await transport.carrier_options(db)
    assert [o["name"] for o in offered] == ["Flipkart"]


async def test_login_is_issued_in_the_same_press(db):
    """A partner with no account cannot answer the quote request THIRD_PARTY sends
    them, so the screen mints one by default rather than leaving a second errand."""
    user = await _admin(db)
    row = await partners.create_partner(db, PartnerCreate(name="Amazon"), user)

    assert row["has_login"] is True
    assert row["username"] == row["code"].lower()
    assert row["must_change_password"] is True
    assert row["login_is_active"] is True


async def test_username_may_be_chosen(db):
    user = await _admin(db)
    row = await partners.create_partner(
        db, PartnerCreate(name="Alibaba", username="alibaba"), user)
    assert row["username"] == "alibaba"


async def test_code_is_derived_and_never_clashes(db):
    """Two partners with the same name must both be creatable — the code is unique on
    the live table and a clash would surface as a database error, not a sentence."""
    user = await _admin(db)
    first = await partners.create_partner(
        db, PartnerCreate(name="Misaba", issue_login=False), user)
    second = await partners.create_partner(
        db, PartnerCreate(name="Misaba", issue_login=False), user)

    assert first["code"] == "LGV-MISABA"
    assert second["code"] == "LGV-MISABA2"


async def test_an_explicit_code_that_is_taken_is_refused(db):
    user = await _admin(db)
    await partners.create_partner(
        db, PartnerCreate(name="Bluedart", code="BD-1", issue_login=False), user)
    with pytest.raises(ValidationError):
        await partners.create_partner(
            db, PartnerCreate(name="Other", code="BD-1", issue_login=False), user)


async def test_a_type_dispatch_would_hide_is_refused(db):
    """MATERIAL is a valid vendor_type and a nonsense logistics partner: the row would
    be created and then never appear in the dropdown it was created for."""
    user = await _admin(db)
    with pytest.raises(ValidationError):
        await partners.create_partner(
            db, PartnerCreate(name="Steel Co", vendor_type="MATERIAL"), user)


async def test_every_offered_type_is_one_dispatch_accepts(db):
    """The form's dropdown and `carrier_options`' filter are the same tuple. If they
    drift, this screen starts creating partners nobody can ship with."""
    user = await _admin(db)
    for spec in partners.partner_types():
        row = await partners.create_partner(
            db, PartnerCreate(name=f"P {spec['value']}", vendor_type=spec["value"],
                              issue_login=False), user)
        assert row["dispatchable"] is True
    offered = {o["id"] for o in await transport.carrier_options(db)}
    assert len(offered) == len(partners.partner_types())


async def test_a_material_supplier_is_out_of_reach(db):
    """This page's permission is granted to the logistics desk. It must never become a
    side door onto a procurement vendor's record or their portal password."""
    user = await _admin(db)
    supplier = Vendor(code="MAT-1", name="Steel Traders", vendor_type="MATERIAL",
                      is_active=True, is_blacklisted=False)
    db.add(supplier)
    await db.commit()

    with pytest.raises(ValidationError):
        await partners.get_partner(db, supplier.id)
    with pytest.raises(ValidationError):
        await partners.issue_login(db, supplier.id, None, user)
    with pytest.raises(ValidationError):
        await partners.reset_login(db, supplier.id, user)
    with pytest.raises(ValidationError):
        await partners.update_partner(
            db, supplier.id, PartnerUpdate(name="Renamed"), user)

    # And it is not in the register either.
    page = await partners.list_partners(db, PageParams(page=1, size=50))
    assert page["total"] == 0


async def test_missing_partner_is_a_not_found(db):
    with pytest.raises(NotFoundError):
        await partners.get_partner(db, 999_999)


async def test_removing_a_partner_takes_their_login_with_them(db):
    """Half a removal — off the dropdown but still able to sign in and read a
    shipment — is the wrong half to leave running."""
    user = await _admin(db)
    row = await partners.create_partner(db, PartnerCreate(name="Delhivery"), user)
    off = await partners.deactivate_partner(db, row["id"], user)

    assert off["is_active"] is False
    assert off["login_is_active"] is False
    assert off["dispatchable"] is False
    assert await transport.carrier_options(db) == []


async def test_a_blacklisted_partner_is_kept_but_not_offered(db):
    """Blacklisted is not deleted: the record stays readable and the history stays
    attached, it simply stops being a thing Dispatch will hand a consignment to."""
    user = await _admin(db)
    row = await partners.create_partner(
        db, PartnerCreate(name="Late Lines", issue_login=False), user)
    updated = await partners.update_partner(
        db, row["id"], PartnerUpdate(is_blacklisted=True), user)

    assert updated["is_blacklisted"] is True
    assert updated["dispatchable"] is False
    assert await transport.carrier_options(db) == []


async def test_issuing_a_login_twice_keeps_one_account(db):
    """Idempotent, and it must not reset a password the partner already changed."""
    user = await _admin(db)
    row = await partners.create_partner(
        db, PartnerCreate(name="Ecom Express", issue_login=False), user)
    first = await partners.issue_login(db, row["id"], None, user)
    again = await partners.issue_login(db, row["id"], None, user)
    assert first["username"] == again["username"]

    disabled = await partners.set_login_active(db, row["id"], False, user)
    assert disabled["login_is_active"] is False
    enabled = await partners.set_login_active(db, row["id"], True, user)
    assert enabled["login_is_active"] is True


async def test_summary_counts_the_partner_who_cannot_answer(db):
    """The count that matters: on the dropdown, sent a job, no way to reply."""
    user = await _admin(db)
    await partners.create_partner(db, PartnerCreate(name="With Login"), user)
    await partners.create_partner(
        db, PartnerCreate(name="No Login", issue_login=False), user)

    summary = await partners.partner_summary(db)
    assert summary == {"total": 2, "dispatchable": 2,
                       "with_login": 1, "without_login": 1}


async def test_search_and_type_filter(db):
    user = await _admin(db)
    await partners.create_partner(
        db, PartnerCreate(name="Flipkart", city="Bengaluru", issue_login=False), user)
    await partners.create_partner(
        db, PartnerCreate(name="Blue Dart", vendor_type="COURIER",
                          city="Chennai", issue_login=False), user)

    params = PageParams(page=1, size=50)
    assert (await partners.list_partners(db, params, search="flip"))["total"] == 1
    assert (await partners.list_partners(db, params, search="Chennai"))["total"] == 1
    typed = await partners.list_partners(db, params, vendor_type="COURIER")
    assert [r["name"] for r in typed["items"]] == ["Blue Dart"]
