"""The number card reads the series, and the year in a number follows the calendar."""
from datetime import datetime
from types import SimpleNamespace

import pytest

from app.core.config import settings
from app.core.exceptions import ValidationError
from app.platform.doc_numbering import scope, service
from app.platform.settings.models import DocSeries
from app.shared import numbering
from app.shared.models.base import utcnow
from app.shared.models.master import OrgDepartment, Organization, Project

FULL = "{COMPANY}/{PROJECT}/{FY}/{PREFIX}{SEQ:4}"


def _keys(pattern):
    return [(field["key"], field["in_number"]) for field in service.card_fields(pattern)]


def test_the_fields_follow_the_pattern():
    assert _keys(FULL) == [("organisation", True), ("project", True), ("department", True),
                           ("fiscal_year", True)]
    assert _keys("{FY}/{PROJECT}/{COMPANY}/{SEQ:4}") == [
        ("fiscal_year", True), ("project", True), ("department", True), ("organisation", True)]


def test_a_pattern_that_prints_less_still_asks_what_the_next_document_copies():
    assert _keys("{PREFIX}/{FY}/{SEQ:5}") == [
        ("fiscal_year", True), ("organisation", False), ("project", False),
        ("department", False)]
    # The year is not carried, so a pattern without it does not ask for it.
    assert "fiscal_year" not in [key for key, _ in _keys("{COMPANY}/{SEQ:4}")]


def test_only_this_year_and_last_can_be_picked():
    assert numbering.selectable_fiscal_years(datetime(2027, 3, 31)) == ["2026-27", "2025-26"]
    assert numbering.selectable_fiscal_years(datetime(2027, 4, 1)) == ["2027-28", "2026-27"]
    assert numbering.selectable_fiscal_years(datetime(2028, 2, 29)) == ["2027-28", "2026-27"]


def test_a_year_outside_the_list_is_refused_unless_the_draft_holds_it():
    current, previous = numbering.selectable_fiscal_years()
    assert scope.assert_fiscal_year(None) == current
    assert scope.assert_fiscal_year(previous) == previous
    with pytest.raises(ValidationError, match="cannot be used"):
        scope.assert_fiscal_year("2001-02")
    assert scope.assert_fiscal_year("2001-02", held="2001-02") == "2001-02"


async def _series(db, doc_type="po", pattern=FULL, year="2026-27", reset=None, last=0):
    row = DocSeries(doc_type=doc_type, fiscal_year=year, prefix="PO", pattern=pattern,
                    last_number=last, is_active=True, reset_policy=reset)
    db.add(row)
    await db.flush()
    return row


def _on(monkeypatch, day):
    monkeypatch.setattr(numbering, "ist_now", lambda: day)


@pytest.mark.asyncio
async def test_the_year_changes_by_itself_on_1_april(db, monkeypatch):
    await _series(db)
    args = {"company": "BAVYA", "project": "104"}
    _on(monkeypatch, datetime(2027, 3, 31))
    assert await numbering.next_number(db, "po", **args) == "BAV/104/2026-27/PO0001"
    assert await numbering.next_number(db, "po", **args) == "BAV/104/2026-27/PO0002"
    _on(monkeypatch, datetime(2027, 4, 1))
    # Nobody edited the series, which still says 2026-27. The new year restarts at 1.
    assert await numbering.next_number(db, "po", **args) == "BAV/104/2027-28/PO0001"


@pytest.mark.asyncio
async def test_picking_last_year_goes_on_from_where_it_stopped(db, monkeypatch):
    await _series(db)
    args = {"company": "BAVYA", "project": "104"}
    _on(monkeypatch, datetime(2027, 3, 31))
    await numbering.next_number(db, "po", **args)
    _on(monkeypatch, datetime(2027, 4, 1))
    await numbering.next_number(db, "po", **args)
    assert (await numbering.next_number(db, "po", fiscal_year="2026-27", **args)
            == "BAV/104/2026-27/PO0002")
    assert await numbering.next_number(db, "po", **args) == "BAV/104/2027-28/PO0002"


@pytest.mark.asyncio
async def test_a_yearly_reset_does_not_repeat_a_number_of_last_year(db, monkeypatch):
    await _series(db, reset="YEARLY")
    args = {"company": "BAVYA", "project": "104"}
    _on(monkeypatch, datetime(2027, 3, 31))
    await numbering.next_number(db, "po", **args)
    _on(monkeypatch, datetime(2027, 4, 1))
    assert (await numbering.next_number(db, "po", fiscal_year="2026-27", **args)
            == "BAV/104/2026-27/PO0002")


@pytest.mark.asyncio
async def test_a_series_with_only_the_year_counts_per_year_and_shows_where_it_got_to(
        db, monkeypatch):
    series = await _series(db, doc_type="indent", pattern="{PREFIX}/{FY}/{SEQ:5}")
    _on(monkeypatch, datetime(2026, 11, 5))
    assert await numbering.next_number(db, "indent") == "PO/2026-27/00001"
    assert series.last_number == 1
    _on(monkeypatch, datetime(2027, 4, 1))
    assert await numbering.next_number(db, "indent") == "PO/2027-28/00001"


@pytest.mark.asyncio
async def test_a_pattern_with_no_year_keeps_one_counter(db, monkeypatch):
    await _series(db, pattern="{COMPANY}/{PREFIX}{SEQ:4}")
    _on(monkeypatch, datetime(2027, 3, 31))
    assert await numbering.next_number(db, "po", company="BAVYA") == "BAV/PO0001"
    _on(monkeypatch, datetime(2027, 4, 1))
    assert await numbering.next_number(db, "po", company="BAVYA") == "BAV/PO0002"


async def _directory(db):
    db.add_all([
        Organization(id=1, code="S-ORG-01", name="Sample Org", is_active=True, synced_at=utcnow()),
        Organization(id=2, code="B-01", name="BAVYA", is_active=True, synced_at=utcnow()),
        OrgDepartment(id=2, code="HR-01", name="HUMAN RESOURCES", is_active=True,
                      synced_at=utcnow()),
        Project(id=77, code="P-104", name="104", is_active=True),
    ])
    await db.flush()


@pytest.mark.asyncio
async def test_the_card_opens_on_the_configured_organisation(db, monkeypatch):
    await _directory(db)
    await _series(db)
    monkeypatch.setattr(settings, "ORG_DEFAULT_NAME", "bavya")
    card = await service.card(db, "po", SimpleNamespace(project_id=77))
    assert card["default_organization_id"] == 2
    assert card["own_project_id"] == 77
    assert card["pattern"] == FULL

    monkeypatch.setattr(settings, "ORG_DEFAULT_NAME", None)
    card = await service.card(db, "po", SimpleNamespace(project_id=999))
    assert card["default_organization_id"] is None
    assert card["own_project_id"] is None  # Not a project anyone can select.


@pytest.mark.asyncio
async def test_preview_says_what_is_missing_and_never_na(db):
    await _directory(db)
    await _series(db)
    empty = await service.preview(db, "po", fiscal_year="2026-27")
    assert empty["number"] is None
    assert empty["missing"] == ["organisation", "project"]
    assert "NA" not in [part["text"] for part in empty["parts"]]

    by_project = await service.preview(db, "po", organization_id=2, project_id=77,
                                       org_department_id=2, fiscal_year="2026-27")
    assert by_project["number"] == "B-01/P-104/2026-27/PO####"
    assert by_project["scope_source"] == "project"

    by_department = await service.preview(db, "po", organization_id=2, org_department_id=2,
                                          fiscal_year="2025-26")
    assert by_department["number"] == "B-01/HR-01/2025-26/PO####"
    assert by_department["scope_source"] == "department"
    assert {part["kind"]: part["field"] for part in by_department["parts"]}["project"] == "department"


@pytest.mark.asyncio
async def test_preview_prints_exactly_what_the_save_draws(db):
    await _directory(db)
    await _series(db)
    preview = await service.preview(db, "po", organization_id=2, project_id=77,
                                    fiscal_year=numbering._fiscal_year())
    drawn = await numbering.next_number(db, "po", company="BAVYA", project="104",
                                        company_code="B-01", project_id=77)
    assert preview["number"].replace("####", "0001") == drawn


def test_a_code_prints_as_written_and_a_missing_one_falls_back():
    """Numbers print CODES (2026-11-11), cleaned and capped; no code means the name."""
    assert numbering.code_token("ap-104-mmu") == "AP-104-MMU"
    assert numbering.code_token(" B/1 ") == "B1"
    assert numbering.code_token("--X--Y--") == "X-Y"
    assert numbering.code_token("ABCDEFGHIJKLMNOP") == "ABCDEFGHIJKL"
    assert numbering.code_token(None) is None and numbering.code_token(" - ") is None


@pytest.mark.asyncio
async def test_a_project_without_a_code_prints_its_name(db):
    from app.shared.models.master import Project
    await _series(db)
    db.add(Project(id=88, code="", name="Medak Phase", is_active=True))
    await db.flush()
    drawn = await numbering.next_number(db, "po", company="BAVYA", project="Medak Phase",
                                        company_code="B-01", project_id=88)
    assert drawn.startswith("B-01/MED/")
