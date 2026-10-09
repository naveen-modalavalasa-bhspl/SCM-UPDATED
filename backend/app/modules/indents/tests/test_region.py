"""Region/Location on an indent (Phase 2).

Region is the HCM location the requester is tagged to — `hcm_employees.office_id`,
the `office` object on HCM's /employees feed — snapshotted onto the indent at create
so monthly indents can be grouped by it.

Mock-only, like test_security_units.py: these assert where the value comes from and
what SQL the filters build, never that MySQL agrees. They open no connections and
create no schemas.
"""
from datetime import date
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.core.pagination import PageParams
from app.modules.indents import service
from app.modules.indents.schemas import (
    IndentCreate, IndentOut, IndentListRow, IndentUpdate,
)
from app.shared.enums import IndentStatus


def sql_text(expression) -> str:
    return str(expression.compile(compile_kwargs={"literal_binds": True}))


class Result:
    """Enough of a SQLAlchemy Result for the code paths under test."""

    def __init__(self, scalar_row=None, rows=None):
        self.scalar_row = scalar_row
        self.rows = rows or []

    def scalars(self):
        return self

    def mappings(self):
        return self

    def scalar_one_or_none(self):
        return self.scalar_row

    def one(self):
        return (0, 0)

    def all(self):
        return self.rows


class CapturingDb:
    def __init__(self, scalar_value=0):
        self.count_stmt = None
        self.result_stmt = None
        self.scalar_stmts = []
        self.execute_stmts = []
        self.scalar_value = scalar_value

    async def scalar(self, stmt):
        self.count_stmt = stmt
        self.scalar_stmts.append(stmt)
        return self.scalar_value

    async def execute(self, stmt):
        self.result_stmt = stmt
        self.execute_stmts.append(stmt)
        return Result()


def user(employee_id=10, *, office_id=700, office_name="104-MMU-AP-Markapur"):
    return SimpleNamespace(
        id=employee_id,
        active_position_id=100,
        full_name=f"User {employee_id}",
        emp_code=f"EMP-{employee_id}",
        project_id=900,
        project_name="AP 104",
        department_id=501,
        office_id=office_id,
        office_name=office_name,
    )


# ---------------- where the value comes from ----------------


@pytest.mark.asyncio
async def test_region_comes_from_the_employee_not_the_position(monkeypatch):
    """The position office and the employee location disagree on live data.

    Region follows the employee: that is the tag HCM maintains per person, and the
    one the monthly grouping is defined against. `office_id` keeps resolving through
    the assignment/position chain, which answers a different question.
    """
    assignment = SimpleNamespace(
        position_id=100, department_id=501, office_id=999, is_primary=True,
    )
    position = SimpleNamespace(
        id=100, name="Network Technician", department_id=501, office_id=888,
        project_id=900, project_name="AP 104",
    )
    db = SimpleNamespace(
        execute=AsyncMock(return_value=Result(scalar_row=assignment)),
        get=AsyncMock(return_value=position),
    )
    monkeypatch.setattr(service, "_name", AsyncMock(return_value="Resolved Office"))

    context = await service._requester_context(
        db, user(office_id=700, office_name="104-MMU-AP-Markapur"))

    assert context["region_id"] == 700
    assert context["region_name"] == "104-MMU-AP-Markapur"
    assert context["office_id"] == 999


@pytest.mark.asyncio
async def test_region_is_null_when_hcm_has_no_location_for_the_raiser(monkeypatch):
    """33 of the 296 live indents are in exactly this state. Raising must still work."""
    db = SimpleNamespace(
        execute=AsyncMock(return_value=Result(scalar_row=None)),
        get=AsyncMock(return_value=None),
    )
    monkeypatch.setattr(service, "_name", AsyncMock(return_value=None))

    context = await service._requester_context(
        db, user(office_id=None, office_name=None))

    assert context["region_id"] is None
    assert context["region_name"] is None


@pytest.mark.asyncio
async def test_region_name_is_resolved_when_the_user_carries_only_the_id(monkeypatch):
    db = SimpleNamespace(
        execute=AsyncMock(return_value=Result(scalar_row=None)),
        get=AsyncMock(return_value=None),
    )
    monkeypatch.setattr(
        service, "_name", AsyncMock(return_value="104-MMU-AP-Hanumanthunipadu"))

    context = await service._requester_context(
        db, user(office_id=654, office_name=None))

    assert context["region_id"] == 654
    assert context["region_name"] == "104-MMU-AP-Hanumanthunipadu"


@pytest.mark.asyncio
async def test_region_name_is_dropped_when_the_id_is_missing(monkeypatch):
    """A stale name with no id would group nothing and read as a real location."""
    db = SimpleNamespace(
        execute=AsyncMock(return_value=Result(scalar_row=None)),
        get=AsyncMock(return_value=None),
    )
    monkeypatch.setattr(service, "_name", AsyncMock(return_value=None))

    context = await service._requester_context(
        db, user(office_id=None, office_name="Left over"))

    assert context["region_id"] is None
    assert context["region_name"] is None


# ---------------- read-only on create and edit ----------------


def test_region_is_absent_from_the_write_contracts():
    for schema in (IndentCreate, IndentUpdate):
        assert "region_id" not in schema.model_fields
        assert "region_name" not in schema.model_fields


def test_region_is_present_on_the_read_contracts():
    for schema in (IndentOut, IndentListRow):
        assert "region_id" in schema.model_fields
        assert "region_name" in schema.model_fields


def test_a_client_sending_a_region_on_edit_cannot_move_the_indent():
    payload = IndentUpdate.model_validate({
        "required_date": date.today().isoformat(),
        "region_id": 4242,
        "region_name": "Somewhere else",
    })

    assert not hasattr(payload, "region_id")
    assert payload.model_fields_set == {"required_date"}


# ---------------- filtering ----------------


def test_region_ids_narrow_the_list():
    text = sql_text(service._apply_indent_filters(
        service.select(service.Indent), region_ids=[654, 937],
    ).whereclause)

    assert "ind_indents.region_id IN (654, 937)" in text
    assert "IS NULL" not in text


def test_unassigned_region_is_opt_in():
    """`IN (...)` drops NULLs, so "no location" needs a choice of its own."""
    unassigned = sql_text(service._apply_indent_filters(
        service.select(service.Indent), include_unassigned_region=True,
    ).whereclause)
    both = sql_text(service._apply_indent_filters(
        service.select(service.Indent),
        region_ids=[654], include_unassigned_region=True,
    ).whereclause)

    assert "ind_indents.region_id IS NULL" in unassigned
    assert " IN (" not in unassigned
    assert "ind_indents.region_id IN (654)" in both
    assert "ind_indents.region_id IS NULL" in both
    assert " OR " in both


def test_no_region_filter_leaves_existing_queries_untouched():
    """Indents with a NULL region stay visible to every caller that does not ask."""
    assert service._apply_indent_filters(
        service.select(service.Indent),
    ).whereclause is None


def test_region_is_not_a_free_text_search_field():
    """Search stays on the columns the list screen shows, as office_name already does."""
    text = sql_text(service._apply_indent_filters(
        service.select(service.Indent), search="Markapur",
    ).whereclause)

    assert "ind_indents.region_name" not in text


@pytest.mark.asyncio
async def test_list_indents_narrows_by_region_inside_the_access_condition(monkeypatch):
    captured = {}

    async def fake_paginate(db, stmt, params):
        captured["stmt"] = stmt
        return {"items": [], "total": 0, "page": 1, "size": 20}

    monkeypatch.setattr(service, "paginate", fake_paginate)
    monkeypatch.setattr(
        service, "indent_access_condition",
        AsyncMock(return_value=service.Indent.requested_by_id == 10),
    )

    await service.list_indents(
        SimpleNamespace(), PageParams(page=1, size=20), user=user(),
        region_ids=[654], include_unassigned_region=True,
    )
    text = sql_text(captured["stmt"])

    assert "ind_indents.requested_by_id = 10" in text
    assert "ind_indents.region_id IN (654)" in text
    assert "ind_indents.region_id IS NULL" in text


@pytest.mark.asyncio
async def test_stats_narrow_by_region_and_report_a_region_breakdown(monkeypatch):
    db = CapturingDb()
    monkeypatch.setattr(
        service, "indent_access_condition",
        AsyncMock(return_value=service.Indent.requested_by_id == 10),
    )

    result = await service.indent_stats(
        db, user=user(), region_ids=[654], statuses=[IndentStatus.APPROVED],
    )
    combined = "\n".join(
        sql_text(stmt) for stmt in [*db.scalar_stmts, *db.execute_stmts])

    assert "ind_indents.region_id IN (654)" in combined
    assert "GROUP BY ind_indents.region_id, ind_indents.region_name" in combined
    assert result["by_region"] == []


@pytest.mark.asyncio
async def test_activity_ledger_filters_region_on_the_visible_cte(monkeypatch):
    """Narrowed before the UNION: each branch fans one indent into many rows."""
    db = CapturingDb()
    monkeypatch.setattr(
        service, "indent_access_condition",
        AsyncMock(return_value=service.Indent.requested_by_id == 10),
    )

    await service.activity_ledger(
        db, PageParams(page=1, size=20), user=user(), region_ids=[654],
    )

    for text in (sql_text(db.count_stmt), sql_text(db.result_stmt)):
        assert "ind_indents.region_id IN (654)" in text


@pytest.mark.asyncio
async def test_activity_ledger_carries_region_on_every_event(monkeypatch):
    db = CapturingDb()
    monkeypatch.setattr(
        service, "indent_access_condition",
        AsyncMock(return_value=service.Indent.requested_by_id == 10),
    )

    await service.activity_ledger(db, PageParams(page=1, size=20), user=user())
    result_sql = sql_text(db.result_stmt)

    assert set(service._ACTIVITY_RESPONSE_FIELDS) >= {"region_id", "region_name"}
    assert "activity_events.region_id" in result_sql
    assert "activity_events.region_name" in result_sql


@pytest.mark.asyncio
async def test_region_options_offer_only_locations_that_exist_on_visible_indents(
    monkeypatch,
):
    """Not the 1,504-row office master: an option that returns nothing is noise."""
    db = CapturingDb()
    db.execute = AsyncMock(return_value=Result(rows=[(654, "104-MMU-AP-Markapur")]))
    monkeypatch.setattr(
        service, "indent_access_condition",
        AsyncMock(return_value=service.Indent.requested_by_id == 10),
    )

    options = await service.list_region_options(db, user())
    text = sql_text(db.execute.await_args.args[0])

    assert options == {"items": [{"id": 654, "name": "104-MMU-AP-Markapur"}]}
    assert "DISTINCT" in text
    assert "ind_indents.region_id IS NOT NULL" in text
    assert "ind_indents.requested_by_id = 10" in text
    assert "hcm_offices" not in text
