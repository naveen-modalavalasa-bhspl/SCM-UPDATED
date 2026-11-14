"""A transport request raised on its own is numbered from its number card (2026-11-12).

The Transport form's card selects organisation, project or department and year, and the
TR number prints them — codes, never NA. Every automatic door (a dispatch, a return leg,
a trip) sends no card and keeps the numbering it always had.
"""
import pytest

from app.core.config import settings
from app.modules.logistics import transport
from app.modules.logistics.tests.test_transport_flow import _payload, _world
from app.platform.settings.models import DocSeries
from app.shared import numbering
from app.shared.models.base import utcnow
from app.shared.models.master import Organization, Project

pytestmark = pytest.mark.asyncio


async def _directory(db):
    db.add_all([
        Organization(id=2, code="BHS", name="BAVYA", is_active=True, synced_at=utcnow()),
        Project(id=77, code="AP-104-MMU", name="104-MMU", is_active=True),
        DocSeries(doc_type="transport_request", fiscal_year=numbering._fiscal_year(),
                  prefix="TR", pattern="{COMPANY}/{PROJECT}/{FY}/{PREFIX}{SEQ:4}",
                  last_number=0, is_active=True),
    ])
    await db.commit()


async def test_a_standalone_request_takes_its_number_from_the_card(db, monkeypatch):
    monkeypatch.setattr(settings, "ORG_DEFAULT_NAME", None)
    w = await _world(db)
    await _directory(db)
    doc = await transport.create_tr(
        db, _payload(organization_id=2, project_id=77, dispatch_id=None,
                     source_type=None, source_id=None, source_no=None), w.desk)
    assert doc.tr_no.startswith("BHS/AP-104-MMU/") and doc.tr_no.endswith("/TR0001")
    assert (doc.organization_code, doc.project_name) == ("BHS", "104-MMU")


async def test_an_automatic_request_with_no_card_keeps_the_old_numbering(db, monkeypatch):
    monkeypatch.setattr(settings, "ORG_DEFAULT_NAME", None)
    w = await _world(db)
    await _directory(db)
    doc = await transport.create_tr(db, _payload(), w.desk)
    assert doc.organization_id is None
    assert not doc.tr_no.startswith("BHS/")
