"""A direct material request is numbered from its number card (2026-11-12).

Organisation, project or department, and year are selected on the New Material Request
form and printed in the MR number — codes, never NA — exactly as a stock audit's are. A
request naming nothing where no default organisation is configured keeps the numbering
it always had, so the allocation screen's Raise MR (which sends no card) still works.
"""
import pytest

from app.core.config import settings
from app.modules.inventory import service
from app.platform.settings.models import DocSeries
from app.shared import numbering
from app.shared.models.base import utcnow
from app.shared.models.master import Item, OrgDepartment, Organization, Project

pytestmark = pytest.mark.asyncio

PATTERN = "{COMPANY}/{PROJECT}/{FY}/{PREFIX}{SEQ:4}"


async def _setup(db, make_user):
    user = await make_user(employee_id=601, username="mr_raiser", permissions=["mr.create"])
    item = Item(code="SAFE-4004", name="Gloves", uom_code="NOS", is_active=True)
    db.add_all([
        item,
        Organization(id=2, code="BHS", name="BAVYA", is_active=True, synced_at=utcnow()),
        OrgDepartment(id=5, code="HR-01", name="HUMAN RESOURCES", is_active=True,
                      synced_at=utcnow()),
        Project(id=77, code="AP-104-MMU", name="104-MMU", is_active=True),
        DocSeries(doc_type="mr", fiscal_year=numbering._fiscal_year(), prefix="MR",
                  pattern=PATTERN, last_number=0, is_active=True),
    ])
    await db.commit()
    return user, item


def _request(item, **card):
    return {"items": [{"item_id": item.id, "quantity": 5}], **card}


async def test_the_card_goes_into_the_number_and_onto_the_request(db, make_user, monkeypatch):
    monkeypatch.setattr(settings, "ORG_DEFAULT_NAME", None)
    user, item = await _setup(db, make_user)
    mr = await service.create_mr_manual(
        db, _request(item, organization_id=2, project_id=77), user)
    assert mr.mr_no.startswith("BHS/AP-104-MMU/")
    assert mr.mr_no.endswith("/MR0001")
    assert "NA" not in mr.mr_no.split("/")
    assert (mr.organization_id, mr.organization_code) == (2, "BHS")
    assert (mr.project_id, mr.project_name) == (77, "104-MMU")
    assert mr.fiscal_year == numbering._fiscal_year()


async def test_a_department_instead_of_a_project_numbers_under_the_department(
        db, make_user, monkeypatch):
    monkeypatch.setattr(settings, "ORG_DEFAULT_NAME", None)
    user, item = await _setup(db, make_user)
    mr = await service.create_mr_manual(
        db, _request(item, organization_id=2, org_department_id=5), user)
    assert mr.mr_no.startswith("BHS/HR-01/")
    assert mr.org_department_name == "HUMAN RESOURCES"
    assert mr.project_id is None


async def test_nothing_selected_and_no_default_keeps_the_old_numbering(
        db, make_user, monkeypatch):
    monkeypatch.setattr(settings, "ORG_DEFAULT_NAME", None)
    user, item = await _setup(db, make_user)
    mr = await service.create_mr_manual(db, _request(item), user)
    assert mr.mr_no and mr.organization_id is None
