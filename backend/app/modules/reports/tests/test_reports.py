"""Reports tests. No database needed: every ledger is a SELECT, so compiling it
against the MySQL dialect catches the failures this module can actually have —
a column that does not exist, a UNION whose branches disagree, a filter pointing at
a name the source never labelled.
"""
import pytest
from sqlalchemy.dialects import mysql

from app.core.exceptions import NotFoundError, ValidationError
from app.modules.reports import service
from app.modules.reports.ledgers import LEDGERS


def compiled(stmt) -> str:
    return str(stmt.compile(dialect=mysql.dialect()))


@pytest.mark.parametrize("key", sorted(LEDGERS))
def test_source_compiles(key):
    assert compiled(LEDGERS[key].source()).lower().startswith("select")


@pytest.mark.parametrize("key", sorted(LEDGERS))
def test_every_declared_column_exists_in_the_source(key):
    spec = LEDGERS[key]
    available = set(spec.source().subquery().c.keys())
    assert set(spec.column_keys) <= available
    assert {f.col for f in spec.filters} <= available
    assert set(spec.search) <= available
    assert spec.date_col in available
    assert spec.order_col in available


@pytest.mark.parametrize("key", sorted(LEDGERS))
@pytest.mark.asyncio
async def test_filters_search_and_dates_compile(key):
    # `_filtered` became async and took a session when the ledgers learned the
    # login's data scope. No session is needed here: with no user there is no rung to
    # resolve, so `_scope_conditions` returns before it touches one.
    stmt, applied = await service._filtered(None, LEDGERS[key], {
        "search": "abc",
        "date_from": "2026-01-01",
        "date_to": "2026-08-06",
        **{f.key: "X" for f in LEDGERS[key].filters},
    })
    sql = compiled(stmt).lower()
    assert "where" in sql and "order by" in sql
    assert applied["search"] == "abc"
    assert applied["dir"] == "desc"


@pytest.mark.asyncio
async def test_sort_direction_is_honoured():
    _, applied = await service._filtered(
        None, LEDGERS["indents"], {"sort": "doc_no", "dir": "asc"})
    assert applied["sort"] == "doc_no" and applied["dir"] == "asc"


def test_unknown_ledger_is_a_404_not_a_500():
    with pytest.raises(NotFoundError):
        service.get_spec("payroll")


@pytest.mark.asyncio
async def test_sorting_by_an_unknown_column_is_rejected():
    """Otherwise ?sort= is a way to probe for column names."""
    with pytest.raises(ValidationError):
        await service._filtered(None, LEDGERS["indents"], {"sort": "salary"})


@pytest.mark.asyncio
async def test_a_bad_date_is_a_validation_error():
    with pytest.raises(ValidationError):
        await service._filtered(
            None, LEDGERS["inventory"], {"date_from": "last-tuesday"})


def test_catalog_covers_every_ledger():
    entries = service.catalog()
    assert {e["key"] for e in entries} == set(LEDGERS)
    assert all(e["columns"] and e["subtitle"] for e in entries)


def test_every_ledger_declares_a_scope_column():
    """A ledger with no scope column answers "everybody's rows".

    That is occasionally right and never accidental, so the exceptions are listed
    here by name: adding a ledger that reads the whole company has to be a decision
    somebody wrote down, not an omission.
    """
    unscoped = {
        key for key, spec in LEDGERS.items()
        if not (spec.scope_indent_col or spec.scope_warehouse_name_col
                or spec.scope_actor_col or spec.scope_owner_col)
    }
    assert unscoped == set()


def test_the_procurement_ledger_is_scoped_exactly_as_the_po_list_is():
    """The ledger is a second door onto `pro_purchase_orders`, and two doors onto one
    document set must not be different widths.

    `scope_condition` reads the rungs as exclusive branches, so a column the ledger
    passes and `procurement.service.list_pos` does not is a rung at which the ledger
    shows more than the screen does.
    """
    spec = LEDGERS["procurement"]
    assert spec.scope_owner_col == "created_by_id"
    assert spec.scope_office_col == "office_id"
    assert spec.scope_project_col is None
    assert spec.scope_position_col is None


def test_assets_is_scoped_like_stock():
    """Same table, same shelves. A login that may not read a warehouse's stock may
    not read its asset tags either."""
    assert (LEDGERS["assets"].scope_warehouse_name_col
            == LEDGERS["stock"].scope_warehouse_name_col)


@pytest.mark.asyncio
async def test_a_ledger_needs_its_own_permission_not_just_report_view(monkeypatch):
    """`report.view` opens the screen; it is not a right to every document class.

    Without this, a profile holding nothing but `report.view` could read every
    purchase order's value by typing the URL — the catalogue hid the tab, the
    endpoint did not.
    """
    from app.core.exceptions import PermissionError_
    from app.platform.rbac import service as rbac_service

    held = {"report.view"}

    async def fake_permissions(db, user, position_id=None):
        return held

    monkeypatch.setattr(rbac_service, "get_user_permissions", fake_permissions)
    user = type("U", (), {"id": 1, "active_position_id": None})()

    with pytest.raises(PermissionError_):
        await service.readable_spec(None, "procurement", user)

    held.add("po.view")
    assert (await service.readable_spec(None, "procurement", user)).key == "procurement"


@pytest.mark.asyncio
async def test_a_service_call_with_no_user_is_not_gated():
    """Scripts and tests call the service directly. The routes always pass a user."""
    assert (await service.readable_spec(None, "procurement")).key == "procurement"
