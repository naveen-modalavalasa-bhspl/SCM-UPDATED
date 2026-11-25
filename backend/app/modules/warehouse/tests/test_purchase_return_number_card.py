"""A manual purchase return is numbered from its number card (2026-11-12).

Nothing stands before a manual return, so organisation, project or department and year
are selected and printed in the number — codes, never NA. Sent with no card (an older
client) it keeps the numbering it always had.
"""
from decimal import Decimal

import pytest

from app.core.config import settings
from app.modules.warehouse import schemas as s
from app.modules.warehouse import service
from app.platform.settings.models import DocSeries
from app.shared import numbering
from app.shared.models.base import utcnow
from app.shared.models.master import Organization, Project
from app.shared.time import today as ist_today

pytestmark = pytest.mark.asyncio


async def _setup(db, make_user):
    user = await make_user(employee_id=701, username="pr_store", permissions=["return.create"])
    db.add_all([
        Organization(id=2, code="BHS", name="BAVYA", is_active=True, synced_at=utcnow()),
        Project(id=77, code="AP-104-MMU", name="104-MMU", is_active=True),
        DocSeries(doc_type="PURCHASE_RETURN", fiscal_year=numbering._fiscal_year(),
                  prefix="PRET", pattern="{COMPANY}/{PROJECT}/{FY}/{PREFIX}{SEQ:4}",
                  last_number=0, is_active=True),
    ])
    await db.commit()
    return user


def _manual(**card):
    return s.ReturnWrite(
        return_date=ist_today(), is_manual=True, vendor_name="Acme Medical", reason="DAMAGED",
        items=[s.ReturnItemWrite(is_manual=True, item_name="Gloves", uom_code="NOS",
                                 quantity=Decimal("2"))],
        **card)


async def test_a_manual_return_takes_its_number_from_the_card(db, make_user, monkeypatch):
    monkeypatch.setattr(settings, "ORG_DEFAULT_NAME", None)
    user = await _setup(db, make_user)
    doc = await service.create_return(db, _manual(organization_id=2, project_id=77), user)
    assert doc.return_no.startswith("BHS/AP-104-MMU/")
    assert (doc.organization_code, doc.project_name) == ("BHS", "104-MMU")


async def test_no_card_keeps_the_old_numbering(db, make_user, monkeypatch):
    monkeypatch.setattr(settings, "ORG_DEFAULT_NAME", None)
    user = await _setup(db, make_user)
    doc = await service.create_return(db, _manual(), user)
    assert doc.organization_id is None and not doc.return_no.startswith("BHS/")
