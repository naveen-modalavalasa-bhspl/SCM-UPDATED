"""All report logic. One generic query builder drives all four ledgers.

Read-only by construction: nothing here writes, commits or deletes. A report that
could change a number is a report nobody can audit with.
"""
import csv
import io
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Mapping

from sqlalchemy import Select, and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.modules.reports.ledgers import LEDGERS, Col, LedgerSpec

# Query params that are controls, not filters. Anything else in the query string is
# matched against the spec's filters and ignored if it is not one.
CONTROL_PARAMS = {"page", "size", "search", "date_from", "date_to", "sort", "dir",
                  "cols"}

# A DISTINCT over a whole ledger feeds a dropdown, not a report — cap it so a
# million-row stk_ledger cannot build a million-option select.
MAX_FILTER_OPTIONS = 300

# An export is one file a person opens in Excel, not a data dump.
MAX_EXPORT_ROWS = 20_000


def get_spec(key: str) -> LedgerSpec:
    spec = LEDGERS.get((key or "").strip().lower())
    if spec is None:
        raise NotFoundError(f"Unknown report ledger: {key}")
    return spec


def catalog() -> list[dict]:
    """Every ledger with its columns — the frontend builds tabs and tables from this."""
    return [
        {
            "key": spec.key,
            "label": spec.label,
            "subtitle": spec.subtitle,
            "date_field": spec.date_col,
            "default_sort": spec.order_col,
            "columns": [_col_out(c) for c in spec.columns],
            "filters": [{"key": f.key, "label": f.label, "kind": f.kind, "options": []}
                        for f in spec.filters],
        }
        for spec in LEDGERS.values()
    ]


def _col_out(col: Col) -> dict:
    return {"key": col.key, "label": col.label, "kind": col.kind, "narrow": col.narrow}


# --------------------------------------------------------------------------- #
# Query building
# --------------------------------------------------------------------------- #

def _as_date(value: str, param: str) -> date:
    try:
        return date.fromisoformat(value[:10])
    except ValueError as exc:
        raise ValidationError(f"{param} must be a date (YYYY-MM-DD)") from exc


def _filtered(spec: LedgerSpec, query: Mapping[str, str]) -> tuple[Select, dict]:
    """The spec's SELECT wrapped in a subquery, with every filter applied to it.

    Filtering the subquery rather than the source is what lets the warehouse UNION
    behave like a table.
    """
    sq = spec.source().subquery()
    cols = sq.c
    stmt = select(sq)
    applied: dict[str, str] = {}
    conditions = []

    search = (query.get("search") or "").strip()
    if search and spec.search:
        like = f"%{search}%"
        conditions.append(or_(*[cols[c].like(like) for c in spec.search
                                if c in cols.keys()]))
        applied["search"] = search

    date_col = cols[spec.date_col]
    if query.get("date_from"):
        value = _as_date(query["date_from"], "date_from")
        conditions.append(date_col >= value)
        applied["date_from"] = value.isoformat()
    if query.get("date_to"):
        value = _as_date(query["date_to"], "date_to")
        # Inclusive: a datetime column with a time on it must still match its own day.
        conditions.append(func.date(date_col) <= value)
        applied["date_to"] = value.isoformat()

    for filt in spec.filters:
        raw = (query.get(filt.key) or "").strip()
        if not raw or filt.col not in cols.keys():
            continue
        col = cols[filt.col]
        if filt.kind == "text":
            conditions.append(col.like(f"%{raw}%"))
        else:
            # Multi-select arrives comma separated; one value is the same code path.
            values = [v.strip() for v in raw.split(",") if v.strip()]
            conditions.append(col.in_(values))
        applied[filt.key] = raw

    if conditions:
        stmt = stmt.where(and_(*conditions))

    sort_key = (query.get("sort") or spec.order_col).strip()
    if sort_key not in cols.keys():
        raise ValidationError(f"Cannot sort {spec.key} by {sort_key}")
    descending = (query.get("dir") or "desc").lower() != "asc"
    order = cols[sort_key].desc() if descending else cols[sort_key].asc()
    applied["sort"] = sort_key
    applied["dir"] = "desc" if descending else "asc"
    return stmt.order_by(order), applied


def _clean(value: Any) -> Any:
    """DB value -> something JSON and CSV can both carry."""
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime):
        stamped = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return stamped.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    if isinstance(value, date):
        return value.isoformat()
    return value


async def list_rows(db: AsyncSession, key: str, page: int, size: int,
                    query: Mapping[str, str]) -> dict:
    """One page of a ledger: {items, total, page, size, columns, applied}."""
    spec = get_spec(key)
    stmt, applied = _filtered(spec, query)
    total = await db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    result = await db.execute(stmt.offset((page - 1) * size).limit(size))
    items = [{k: _clean(v) for k, v in row.items()} for row in result.mappings()]
    return {
        "items": items, "total": total, "page": page, "size": size,
        "columns": [_col_out(c) for c in spec.columns], "applied": applied,
    }


async def filter_options(db: AsyncSession, key: str) -> list[dict]:
    """The dropdown values that actually occur in the data.

    Read from the ledger instead of from an enum on purpose: a status that no
    document has ever held is a filter that returns nothing, and a legacy value the
    enum has since dropped would otherwise be unfilterable — and unfilterable is
    exactly where a bad row hides.
    """
    spec = get_spec(key)
    sq = spec.source().subquery()
    out = []
    for filt in spec.filters:
        options: list[str] = []
        if filt.kind == "select" and filt.col in sq.c.keys():
            col = sq.c[filt.col]
            rows = await db.execute(
                select(col).where(col.isnot(None)).distinct()
                .order_by(col).limit(MAX_FILTER_OPTIONS)
            )
            options = [str(v) for (v,) in rows.all() if str(v).strip()]
        out.append({"key": filt.key, "label": filt.label, "kind": filt.kind,
                    "options": options})
    return out


def _describe_filters(spec: LedgerSpec, applied: Mapping[str, str]) -> str:
    """The filter set in words, for the file's own header block.

    A spreadsheet that says 269 rows without saying "status = APPROVED, June
    onwards" is a number nobody can check a month later.
    """
    labels = {f.key: f.label for f in spec.filters}
    parts = []
    if applied.get("search"):
        parts.append(f"Search: {applied['search']}")
    for key, value in applied.items():
        if key in labels:
            parts.append(f"{labels[key]}: {value.replace(',', ' / ')}")
    return "; ".join(parts) or "None — every row in this ledger"


def _date_range(applied: Mapping[str, str], spec: LedgerSpec) -> str:
    field = spec.date_col.replace("_", " ")
    start, end = applied.get("date_from"), applied.get("date_to")
    if start and end:
        return f"{field} between {start} and {end}"
    if start:
        return f"{field} from {start}"
    if end:
        return f"{field} up to {end}"
    return f"All dates ({field})"


def export_header(spec: LedgerSpec, applied: Mapping[str, str], rows: int,
                  actor: str | None,
                  columns: list[Col] | None = None) -> list[list[str]]:
    """The block above the column headings: what this file is, and who pulled it.

    Kept as rows rather than a comment prefix so it survives an Excel round-trip.
    """
    generated = datetime.now(timezone.utc).strftime("%d %b %Y %H:%M UTC")
    shown = list(columns if columns is not None else spec.columns)
    lines = [
        [f"SCM ERP — {spec.label} Ledger"],
        [spec.subtitle],
        [],
        ["Generated at", generated],
        ["Generated by", actor or "—"],
        ["Date range", _date_range(applied, spec)],
        ["Filters", _describe_filters(spec, applied)],
        ["Sorted by", f"{applied.get('sort', spec.order_col)} "
                      f"({'descending' if applied.get('dir') != 'asc' else 'ascending'})"],
        ["Rows in this file", str(rows)],
    ]
    # Only worth saying when something is missing. A file that silently holds fewer
    # columns than the ledger defines has to say so on its face, or the next person
    # reads an absent column as an absent value.
    if len(shown) < len(spec.columns):
        lines.append([
            "Columns",
            f"{len(shown)} of {len(spec.columns)} — "
            + ", ".join(col.label for col in shown),
        ])
    lines.append([])
    return lines


async def _export_rows(db: AsyncSession, spec: LedgerSpec,
                       query: Mapping[str, str]) -> tuple[list, dict]:
    stmt, applied = _filtered(spec, query)
    result = await db.execute(stmt.limit(MAX_EXPORT_ROWS))
    return list(result.mappings()), applied


def export_columns(spec: LedgerSpec, query: Mapping[str, str]) -> list[Col]:
    """The columns the screen was showing, in the ledger's own order.

    `cols` is the same URL parameter the column picker writes, so the file matches
    what the person was looking at when they pressed Export — an export that quietly
    contains columns the screen was hiding is a different document.

    Order comes from the spec rather than from the parameter: the ledger decides what
    reads left to right, and a hand-edited `cols` should not be able to shuffle it.
    Unknown keys are ignored, and asking for nothing at all means everything.
    """
    picked = {key for key in (query.get("cols") or "").split(",") if key}
    if not picked:
        return list(spec.columns)
    chosen = [col for col in spec.columns if col.key in picked]
    return chosen or list(spec.columns)


def _filename(spec: LedgerSpec, extension: str) -> str:
    stamp = datetime.now(timezone.utc).strftime("%d-%b-%Y %H%M")
    return f"SCM {spec.label} Ledger {stamp}.{extension}"


async def export_csv(db: AsyncSession, key: str, query: Mapping[str, str],
                     actor: str | None = None) -> tuple[str, str]:
    """(filename, csv text) for the current filter set. Same rows, same order as the
    screen — an export that does not match what was on screen is not evidence."""
    spec = get_spec(key)
    rows, applied = await _export_rows(db, spec, query)
    columns = export_columns(spec, query)

    buffer = io.StringIO()
    # Excel on Windows opens \r\n cleanly; \n alone puts everything on one line.
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerows(export_header(spec, applied, len(rows), actor, columns))
    writer.writerow([c.label for c in columns])
    for row in rows:
        writer.writerow(["" if (v := _clean(row.get(c.key))) is None else v
                         for c in columns])

    return _filename(spec, "csv"), buffer.getvalue()


# One accent colour and one grey. A report that arrives in six colours is a report
# nobody trusts to be neutral — the styling exists to find the heading row, nothing
# more.
_HEADER_FILL = "1F3A5F"
_TITLE_COLOUR = "1F3A5F"
_META_COLOUR = "5B6B7F"
_MAX_COL_WIDTH = 46


async def export_xlsx(db: AsyncSession, key: str, query: Mapping[str, str],
                      actor: str | None = None) -> tuple[str, bytes]:
    """The same rows as `export_csv`, as a real spreadsheet.

    A styled heading row is the only thing CSV cannot carry, and it is what makes a
    200-column-wide audit extract readable. Frozen panes and an autofilter come with
    it because the first thing anybody does with this file is sort it.
    """
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter

    spec = get_spec(key)
    rows, applied = await _export_rows(db, spec, query)
    columns = export_columns(spec, query)

    book = Workbook()
    sheet = book.active
    sheet.title = spec.label[:31]

    header_block = export_header(spec, applied, len(rows), actor, columns)
    for line in header_block:
        sheet.append(line)
    sheet["A1"].font = Font(bold=True, size=14, color=_TITLE_COLOUR)
    sheet["A2"].font = Font(italic=True, color=_META_COLOUR)
    for row_index in range(4, len(header_block) + 1):
        sheet.cell(row=row_index, column=1).font = Font(bold=True, color=_META_COLOUR)
        sheet.cell(row=row_index, column=2).font = Font(color=_META_COLOUR)

    head_row = len(header_block) + 1
    fill = PatternFill("solid", start_color=_HEADER_FILL, end_color=_HEADER_FILL)
    edge = Side(style="thin", color="D5DAE2")
    for index, col in enumerate(columns, start=1):
        cell = sheet.cell(row=head_row, column=index, value=col.label)
        cell.fill = fill
        cell.font = Font(bold=True, color="FFFFFF")
        cell.alignment = Alignment(vertical="center", wrap_text=True)

    for row in rows:
        sheet.append([_clean(row.get(col.key)) for col in columns])

    # Width from the widest value actually present, capped — a remarks column left
    # unclamped pushes every other column off the screen.
    for index, col in enumerate(columns, start=1):
        widest = max(
            [len(col.label)] +
            [len(str(_clean(r.get(col.key)) or "")) for r in rows[:500]]
        )
        sheet.column_dimensions[get_column_letter(index)].width = min(
            _MAX_COL_WIDTH, max(11, widest + 2))
        for row_index in range(head_row + 1, head_row + 1 + len(rows)):
            sheet.cell(row=row_index, column=index).border = Border(bottom=edge)

    last_col = get_column_letter(len(columns))
    sheet.freeze_panes = f"A{head_row + 1}"
    sheet.auto_filter.ref = f"A{head_row}:{last_col}{head_row + len(rows)}"

    stream = io.BytesIO()
    book.save(stream)
    return _filename(spec, "xlsx"), stream.getvalue()
