"""Indents, STRs and monthly indents are numbered from their organisation and their
project or department — never NA (2026-11-09).

What HCM says about the raiser is used and fixed first: their project, else their
department matched BY NAME to the organisation feed; only a raiser with neither picks,
and one of the two is required. The organisation is the configured default and is
fixed when one is configured. A draft renumbers when its selection moves; a submitted
indent is fixed; an indent raised before organisations is left as it was.
"""
from datetime import date, timedelta
from types import SimpleNamespace

import pytest

from app.core.config import settings
from app.core.exceptions import ValidationError
from app.modules.indents import service
from app.modules.indents.enums import IndentType
from app.modules.indents.schemas import IndentCreate, IndentItemIn, IndentUpdate
from app.modules.indents.tests.test_indents import _approval_ladder_world
from app.platform.doc_numbering import scope as org_scope
from app.platform.hcm.models import HcmPosition
from app.shared.models.base import utcnow
from app.shared.models.master import OrgDepartment, Organization, Project
from app.shared.numbering import _fiscal_year

pytestmark = pytest.mark.asyncio

BAVYA, OTHER = 2, 9


@pytest.fixture(autouse=True)
def _default_company(monkeypatch):
    monkeypatch.setattr(settings, "ORG_DEFAULT_NAME", "BAVYA")


async def _setup(db, *, department_name=" operations "):
    """The ladder world's pilot sits in HCM department "Operations" with no project."""
    world = await _approval_ladder_world(db)
    db.add_all([
        Organization(id=BAVYA, code="B-01", name="BAVYA", is_active=True, synced_at=utcnow()),
        Organization(id=OTHER, code="S-01", name="Sample Org", is_active=True,
                     synced_at=utcnow()),
        OrgDepartment(id=5, code="D-05", name=department_name, is_active=True,
                      synced_at=utcnow()),
        OrgDepartment(id=6, code="D-06", name="Stores", is_active=True, synced_at=utcnow()),
        Project(id=77, code="P-104", name="104", is_active=True),
    ])
    await db.commit()
    return world, world["pilot"], world["item"]


def _new(item_id, **booking):
    return IndentCreate(items=[IndentItemIn(item_id=item_id, quantity=2)],
                        required_date=date.today() + timedelta(days=3), **booking)


async def test_a_department_hcm_names_is_used_and_fixed(db):
    _world, pilot, item = await _setup(db)

    indent = await service.create_indent(db, _new(item.id), pilot)
    assert indent.indent_no.startswith(f"BAV/OPE/{_fiscal_year()}/IND")
    assert "NA" not in indent.indent_no
    assert indent.organization_name == "BAVYA" and indent.org_department_id == 5

    # The department is HCM's: another one, or a project, is refused.
    with pytest.raises(ValidationError, match="Your department is"):
        await service.create_indent(db, _new(item.id, org_department_id=6), pilot)
    with pytest.raises(ValidationError, match="raised under the department"):
        await service.create_indent(db, _new(item.id, project_id=77), pilot)


async def test_a_project_hcm_names_wins_and_is_fixed(db):
    _world, pilot, item = await _setup(db)
    (await db.get(HcmPosition, 1000)).project_id = 77
    await db.commit()

    indent = await service.create_indent(db, _new(item.id), pilot)
    assert indent.indent_no.startswith(f"BAV/104/{_fiscal_year()}/IND")
    assert indent.project_id == 77 and indent.org_department_id is None


async def test_with_nothing_in_hcm_one_of_the_two_is_picked(db):
    # The HCM department matches nothing in the feed.
    _world, pilot, item = await _setup(db, department_name="Accounts")

    with pytest.raises(ValidationError, match="project or the department"):
        await service.create_indent(db, _new(item.id), pilot)
    by_project = await service.create_indent(db, _new(item.id, project_id=77), pilot)
    assert by_project.indent_no.startswith("BAV/104/")
    by_department = await service.create_indent(db, _new(item.id, org_department_id=6), pilot)
    assert by_department.indent_no.startswith("BAV/STO/")


async def test_the_configured_organisation_is_fixed(db):
    _world, pilot, item = await _setup(db)

    with pytest.raises(ValidationError, match="raised under BAVYA"):
        await service.create_indent(db, _new(item.id, organization_id=OTHER), pilot)


async def test_monthly_indents_are_mi_ind_and_strs_keep_their_series():
    assert service.indent_series(IndentType.MONTHLY.value) == "monthly_indent"
    assert service.indent_series(IndentType.STR.value) == "str"
    assert service.indent_series(IndentType.REGULAR.value) == "indent"


async def test_a_monthly_indent_prints_mi_ind(db):
    _world, pilot, item = await _setup(db)
    indent = await service.create_indent(
        db, _new(item.id, indent_type=IndentType.MONTHLY), pilot)
    assert "/MI-IND" in indent.indent_no and "NA" not in indent.indent_no


async def test_a_draft_renumbers_when_its_selection_moves(db):
    _world, pilot, item = await _setup(db, department_name="Accounts")
    indent = await service.create_indent(db, _new(item.id, org_department_id=6), pilot)
    first = indent.indent_no
    assert first.startswith("BAV/STO/")

    updated = await service.update_indent(
        db, indent.id, IndentUpdate(project_id=77, org_department_id=None, required_date=indent.required_date), pilot)
    assert updated.indent_no.startswith("BAV/104/") and updated.indent_no != first
    assert updated.org_department_id is None

    # Saving the same selection again burns no number.
    again = await service.update_indent(db, indent.id, IndentUpdate(project_id=77, required_date=indent.required_date), pilot)
    assert again.indent_no == updated.indent_no


async def test_two_feed_departments_of_one_name_are_not_an_answer(db):
    _world, pilot, _item = await _setup(db)
    db.add(OrgDepartment(id=7, code="D-07", name="OPERATIONS", is_active=True,
                         synced_at=utcnow()))
    await db.commit()
    pilot.active_position_id = 1000
    mapped = await org_scope.raiser_mapping(db, pilot)
    assert mapped["org_department_id"] is None and mapped["project_id"] is None


async def test_an_issue_copies_an_organised_source_and_leaves_an_older_one_alone(db):
    from app.modules.warehouse.service import _issue_scope

    organised = SimpleNamespace(
        organization_id=BAVYA, organization_code="B-01", organization_name="BAVYA",
        org_department_id=None, org_department_name=None, project_name="104",
        department_name=None, fiscal_year="2025-26")
    values, args = await _issue_scope(db, SimpleNamespace(fiscal_year=None), organised)
    assert values["organization_name"] == "BAVYA"
    assert values["fiscal_year"] == _fiscal_year()          # its own year, not the source's
    assert args == {"company": "BAVYA", "project": "104", "fiscal_year": _fiscal_year()}

    older = SimpleNamespace(organization_id=None)
    assert await _issue_scope(db, SimpleNamespace(), older) == (None, None)


async def test_a_direct_issue_selects_and_never_prints_na(db):
    from app.modules.warehouse.service import _issue_scope

    await _setup(db)
    data = SimpleNamespace(organization_id=None, org_department_id=None, project_id=None,
                           fiscal_year=None)
    # Opens on the configured organisation, and still needs a project or a department.
    with pytest.raises(ValidationError, match="project or the department"):
        await _issue_scope(db, data, None)
    data.project_id = 77
    values, args = await _issue_scope(db, data, None)
    assert values["organization_id"] == BAVYA
    assert args["company"] == "BAVYA" and args["project"] == "104"
