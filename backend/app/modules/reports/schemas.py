"""Report shapes. A ledger row is deliberately untyped: the column list comes from
the spec, so a new column must not need a new Pydantic field in two places."""
from typing import Any

from pydantic import BaseModel


class ReportColumn(BaseModel):
    key: str
    label: str
    kind: str
    narrow: bool


class ReportFilter(BaseModel):
    key: str
    label: str
    kind: str
    options: list[str] = []


class ReportLedgerInfo(BaseModel):
    """What a ledger is, enough for the frontend to build its tab and its table."""
    key: str
    label: str
    subtitle: str
    date_field: str
    default_sort: str
    columns: list[ReportColumn]
    filters: list[ReportFilter]


class ReportRows(BaseModel):
    """The standard list envelope plus the columns the rows were built from."""
    items: list[dict[str, Any]]
    total: int
    page: int
    size: int
    columns: list[ReportColumn]
    applied: dict[str, str] = {}
