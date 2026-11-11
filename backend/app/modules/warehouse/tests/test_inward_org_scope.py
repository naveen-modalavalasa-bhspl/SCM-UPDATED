"""Material inward / GRN, QC and put-away carry their organisation (2026-11-11).

- A receipt against a document that carries an organisation COPIES it (organisation and
  department fixed), keeps its own project, and takes the source's when it names none.
- With no such document before it — an older PO, or none — it SELECTS, opening on the
  configured default organisation, and needs a project or a department.
- QC and put-away copy the receipt and number from it; a receipt older than
  organisations numbers them the old way.
"""
from types import SimpleNamespace

import pytest

from app.core.config import settings
from app.core.exceptions import ValidationError
from app.modules.warehouse import service
from app.shared.models.base import utcnow
from app.shared.models.master import Organization, Project
from app.shared.numbering import _fiscal_year

pytestmark = pytest.mark.asyncio


def _receipt(**over):
    base = dict(id=None, project_id=None, project_name=None, organization_id=None,
                fiscal_year=None)
    base.update(over)
    return SimpleNamespace(**base)


def _data(**over):
    base = dict(organization_id=None, org_department_id=None, project_id=None,
                fiscal_year=None)
    base.update(over)
    return SimpleNamespace(**base)


_PO = SimpleNamespace(organization_id=2, organization_code="B-01", organization_name="BAVYA",
                      org_department_id=None, org_department_name=None,
                      project_id=77, project_name="104", fiscal_year="2025-26")


async def test_a_receipt_copies_the_po_and_keeps_its_own_project(db):
    own = _receipt(project_id=55, project_name="MMU")
    assert await service._apply_receipt_scope(db, own, _data(), _PO) is True
    assert own.organization_name == "BAVYA" and own.organization_code == "B-01"
    assert own.project_name == "MMU"                    # whose stock it becomes: its own
    assert own.fiscal_year == _fiscal_year()           # its own year, not the PO's

    bare = _receipt()
    await service._apply_receipt_scope(db, bare, _data(), _PO)
    assert bare.project_id == 77 and bare.project_name == "104"   # the PO's, when none


async def test_with_nothing_before_it_and_no_default_it_numbers_the_old_way(db, monkeypatch):
    monkeypatch.setattr(settings, "ORG_DEFAULT_NAME", None)
    assert await service._apply_receipt_scope(db, _receipt(), _data(), None) is False


async def test_an_older_po_receipt_selects_and_opens_on_the_default(db, monkeypatch):
    monkeypatch.setattr(settings, "ORG_DEFAULT_NAME", "BAVYA")
    db.add_all([
        Organization(id=2, code="B-01", name="BAVYA", is_active=True, synced_at=utcnow()),
        Project(id=77, code="P-104", name="104", is_active=True),
    ])
    await db.commit()

    with pytest.raises(ValidationError, match="project or the department"):
        await service._apply_receipt_scope(db, _receipt(), _data(), None)
    receipt = _receipt()
    assert await service._apply_receipt_scope(db, receipt, _data(project_id=77), None) is True
    assert receipt.organization_id == 2 and receipt.project_name == "104"


async def test_qc_and_putaway_copy_the_receipt_and_number_from_it():
    receipt = SimpleNamespace(**{**vars(_PO), "department_name": None})
    values, args = service._carried_scope(receipt)
    assert values["organization_name"] == "BAVYA" and values["fiscal_year"] == _fiscal_year()
    assert args["company_code"] == "B-01" and args["project_id"] == 77
    assert args["fiscal_year"] == _fiscal_year()
    assert service._carried_scope(SimpleNamespace(organization_id=None)) == (None, None)
    assert service._carried_scope(None) == (None, None)
