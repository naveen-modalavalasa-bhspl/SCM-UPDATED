"""`scope.carry_or_select` (2026-11-12) — purchase return, indent return, transport
request and vendor payment: copied from the document before when it carries an
organisation, selected on the number card otherwise, the old numbering with neither."""
from types import SimpleNamespace

import pytest

from app.core.config import settings
from app.platform.doc_numbering import scope
from app.shared.models.base import utcnow
from app.shared.models.master import OrgDepartment, Organization, Project

pytestmark = pytest.mark.asyncio


def _card(**picked):
    return SimpleNamespace(**{"organization_id": None, "org_department_id": None,
                              "project_id": None, "fiscal_year": None, **picked})


async def test_an_organised_source_is_copied_and_the_year_is_this_documents_own():
    source = SimpleNamespace(
        organization_id=2, organization_code="BHS", organization_name="BAVYA",
        org_department_id=None, org_department_name=None,
        project_id=77, project_name="104-MMU", fiscal_year="2025-26")
    # A card naming another organisation changes nothing: the source wins.
    values, args = await scope.carry_or_select(None, _card(organization_id=9), source)
    assert (values["organization_id"], values["project_id"]) == (2, 77)
    assert values["fiscal_year"] == scope.assert_fiscal_year(None)   # today's, not 2025-26
    assert args["company_code"] == "BHS" and args["fiscal_year"] == values["fiscal_year"]


async def test_no_card_and_no_organised_source_keeps_the_old_numbering():
    older = SimpleNamespace(organization_id=None)
    assert await scope.carry_or_select(None, _card(), older) == (None, None)
    assert await scope.carry_or_select(None, _card(project_id=77), None) == (None, None)


async def test_off_an_older_source_the_card_selects(db, monkeypatch):
    monkeypatch.setattr(settings, "ORG_DEFAULT_NAME", None)
    db.add_all([
        Organization(id=2, code="BHS", name="BAVYA", is_active=True, synced_at=utcnow()),
        OrgDepartment(id=5, code="HR-01", name="HUMAN RESOURCES", is_active=True,
                      synced_at=utcnow()),
        Project(id=77, code="AP-104-MMU", name="104-MMU", is_active=True),
    ])
    await db.flush()
    older = SimpleNamespace(organization_id=None)
    values, args = await scope.carry_or_select(
        db, _card(organization_id=2, project_id=77), older)
    assert values["organization_code"] == "BHS" and values["project_name"] == "104-MMU"
    assert args["project_id"] == 77
