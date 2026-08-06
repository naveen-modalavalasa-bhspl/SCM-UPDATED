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
def test_filters_search_and_dates_compile(key):
    stmt, applied = service._filtered(LEDGERS[key], {
        "search": "abc",
        "date_from": "2026-01-01",
        "date_to": "2026-08-06",
        **{f.key: "X" for f in LEDGERS[key].filters},
    })
    sql = compiled(stmt).lower()
    assert "where" in sql and "order by" in sql
    assert applied["search"] == "abc"
    assert applied["dir"] == "desc"


def test_sort_direction_is_honoured():
    _, applied = service._filtered(LEDGERS["indents"], {"sort": "doc_no", "dir": "asc"})
    assert applied["sort"] == "doc_no" and applied["dir"] == "asc"


def test_unknown_ledger_is_a_404_not_a_500():
    with pytest.raises(NotFoundError):
        service.get_spec("payroll")


def test_sorting_by_an_unknown_column_is_rejected():
    """Otherwise ?sort= is a way to probe for column names."""
    with pytest.raises(ValidationError):
        service._filtered(LEDGERS["indents"], {"sort": "salary"})


def test_a_bad_date_is_a_validation_error():
    with pytest.raises(ValidationError):
        service._filtered(LEDGERS["inventory"], {"date_from": "last-tuesday"})


def test_catalog_covers_every_ledger():
    entries = service.catalog()
    assert {e["key"] for e in entries} == set(LEDGERS)
    assert all(e["columns"] and e["subtitle"] for e in entries)
