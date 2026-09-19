"""Template / export / import for every master, driven by the same MasterDef.

The masters were loaded from a spreadsheet once and will be again — 27 masters with
a hand-written importer each is 27 chances to get row numbering, header matching and
error reporting subtly different. So the shape of a master's import file is derived
from the Pydantic schema it already validates against, and this module is the only
place the behaviour is written down.

Three routes per master:

    GET  {base}/template   an empty workbook with the right headers and a How to fill sheet
    GET  {base}/export     every row, in exactly the shape /import accepts back
    POST {base}/import     upload, validate everything, then write

Import is **all-or-nothing**. A half-applied master is worse than a rejected one: the
admin cannot tell which of 400 rows landed, and re-uploading the fixed file would
double-create whatever succeeded. Every row is validated first, and a single bad row
returns the whole list of problems with nothing written.

**A foreign key is stated by NAME, not by id** (`MasterDef.lookups`). The people who
fill these sheets in are storekeepers, not administrators: `category_id = 47` meant
downloading eight other exports and looking the number up, six times a row. The
column is `Category` = `Antibiotics` now, with the allowed values in the cell's own
dropdown where the list is short enough to carry one. Both headers are still
accepted, and a bare number in a name column is still read as an id, so every file
written against the old template still imports.

That moves the failure from "the file was rejected" to "these four cells could not be
matched", which is a thing a person can fix — so there are two more routes:

    POST {base}/import/preview   parse + resolve + validate, WRITE NOTHING, and
                                 return every row with its unresolved cells and the
                                 candidates each one could have meant
    POST {base}/import/commit    the rows back from that screen, already resolved

`POST {base}/import` is unchanged and still takes the file straight through, for the
admin who knows the ids and does not want a review screen. All three end in the same
`apply_rows`, so what the preview promises is what the commit does.
"""
from __future__ import annotations

import asyncio
import io
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from types import UnionType
from typing import Any, Union, get_args, get_origin

from fastapi import Depends, File, Request, UploadFile
from fastapi.responses import StreamingResponse
from openpyxl import Workbook, load_workbook
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation
from pydantic import BaseModel, ValidationError as PydanticValidationError
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import get_current_user, require_permission
from app.core.exceptions import ValidationError
from app.shared.enums import AuditAction

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheetml"
XLSX_CONTENT_TYPE = (
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
)
# A spreadsheet cell cannot hold a list, so multi-value fields travel as "1, 2, 3".
LIST_SEPARATOR = ","
# Import is for humans fixing a file by hand, not for feeding a migration through.
MAX_IMPORT_ROWS = 5000


# --------------------------------------------------------------------------- #
#  Describing a schema as spreadsheet columns
# --------------------------------------------------------------------------- #
def _unwrap_optional(annotation: Any) -> Any:
    """`str | None` describes the same column as `str`. Optionality is already
    carried by whether the field is required, so the None arm is noise here.

    Only a union is unwrapped. Testing `get_origin(...) is None` instead collapsed
    every single-argument generic, so `list[int]` came back as `int`: the ids column
    was then read as one number and "1, 2" died on `float()`.
    """
    if get_origin(annotation) not in (Union, UnionType):
        return annotation
    args = [a for a in get_args(annotation) if a is not type(None)]
    return args[0] if len(args) == 1 else annotation


def _is_list_field(annotation: Any) -> bool:
    return get_origin(_unwrap_optional(annotation)) is list


def _type_hint(annotation: Any) -> str:
    """What to tell the person filling the sheet in."""
    inner = _unwrap_optional(annotation)
    if get_origin(inner) is list:
        return "ids separated by commas, e.g. 1, 2"
    return {
        bool: "TRUE or FALSE", int: "whole number", float: "number",
        Decimal: "number", date: "YYYY-MM-DD", datetime: "YYYY-MM-DD",
    }.get(inner, "text")


def columns_for(schema: type[BaseModel]) -> list[str]:
    """The writable columns, in the order the schema declares them."""
    return list(schema.model_fields.keys())


# --------------------------------------------------------------------------- #
#  Foreign keys, stated by name
# --------------------------------------------------------------------------- #
def lookups_by_field(defn) -> dict[str, Any]:
    return {lk.field: lk for lk in getattr(defn, "lookups", ())}


def header_for(defn, field: str) -> str:
    """What the column is called on the sheet. A looked-up key gets the readable
    label; everything else keeps the schema's own field name, because renaming all
    thirty columns would break every file already filled in for no gain."""
    lk = lookups_by_field(defn).get(field)
    return lk.label if lk else field


def _enum_choices(defn, field: str) -> list[str]:
    """The values a plain string column will actually accept.

    Declared here rather than sniffed off the annotation: these are `str` fields with
    a default, so the schema itself does not say what else is legal, and a column
    that silently takes anything is how "FIFO " with a trailing space became a
    valuation method.
    """
    return {
        "valuation_method": ["FIFO", "LIFO", "WEIGHTED_AVERAGE"],
        "barcode_type": ["EAN13", "UPC", "CODE128", "QR"],
    }.get(field, [])


async def lookup_choices(defn, db: AsyncSession) -> dict[str, list[dict]]:
    """`{field: [{id, label, code}]}` for every looked-up column on this master.

    Ordered by the label so a dropdown reads alphabetically, and capped per lookup:
    Excel will accept a validation list of nine hundred warehouses and then be
    unusable, and the review screen resolves what the sheet cannot offer.
    """
    out: dict[str, list[dict]] = {}
    for lk in getattr(defn, "lookups", ()):
        order = next((getattr(lk.model, c) for c in lk.display
                      if hasattr(lk.model, c)), None)
        if order is None:
            continue
        stmt = select(lk.model)
        if hasattr(lk.model, "is_active"):
            stmt = stmt.where(lk.model.is_active.is_(True))
        stmt = stmt.order_by(order).limit(lk.max_options + 1)
        rows = (await db.execute(stmt)).scalars().all()
        out[lk.field] = [
            {"id": row.id,
             "label": _display(row, lk),
             "code": (getattr(row, "code", None) or "").strip()}
            for row in rows if _display(row, lk)
        ]
    return out


def _norm(value: Any) -> str:
    return str(value or "").strip().casefold()


def _display(row: Any, lk: Any) -> str:
    """What this row is called. First of the lookup's `display` columns that answers."""
    for column in getattr(lk, "display", ("name", "code")):
        text = str(getattr(row, column, None) or "").strip()
        if text:
            return text
    return ""


async def resolve_lookups(defn, db: AsyncSession,
                          parsed: list[dict]) -> list[dict]:
    """Turn the names in `__lookup__` into ids on the record itself.

    Returns one problem per cell that could not be matched, each carrying the
    candidates it might have meant so the review screen can offer them. An
    AMBIGUOUS name is a problem, never a guess: two rows called "Cipla" and a silent
    pick means a year of stock counted against the wrong manufacturer, and nobody
    ever finds it. A cell holding a number is taken as the id it looks like — the
    export round-trips, and an admin who knows the ids keeps working the old way.
    """
    problems: list[dict] = []
    by_field = lookups_by_field(defn)
    if not by_field:
        # Still strip the key. Everything downstream reads the record as the schema's
        # own fields, and a leftover __lookup__ would reach defn.schema(**record).
        for record in parsed:
            record.pop("__lookup__", None)
        return problems

    wanted = {f for record in parsed for f in record.get("__lookup__", {})}
    index: dict[str, dict[str, list]] = {}
    ids: dict[str, set[int]] = {}
    for field in wanted:
        lk = by_field[field]
        rows = (await db.execute(select(lk.model))).scalars().all()
        table: dict[str, list] = {}
        for column in lk.match:
            for row in rows:
                key = _norm(getattr(row, column, None))
                if key:
                    table.setdefault(f"{column}:{key}", []).append(row)
        index[field] = table
        ids[field] = {row.id for row in rows}

    for record in parsed:
        line = record.get("__row__")
        for field, raw in (record.pop("__lookup__", {}) or {}).items():
            lk = by_field[field]
            text = str(raw).strip()
            if not text:
                continue                       # empty means "say nothing" as ever

            # MATCH ON THE NAME FIRST, and only read the cell as an id if nothing
            # answered. The other way round is a silent mis-link: an HSN code IS a
            # number, so "28289011" was taken as row id 28289011 — a row that does
            # not exist — and the same trap waits for any master whose code is
            # numeric. A name that matches wins over a number that merely looks like
            # an id, because the sheet asked for the name.
            hits: list = []
            for column in lk.match:
                hits = index[field].get(f"{column}:{_norm(text)}", [])
                if hits:
                    break

            if not hits:
                # An id, but only if it is one. Excel hands ids back as 47.0.
                try:
                    candidate = int(float(text))
                except (TypeError, ValueError):
                    candidate = None
                if candidate is not None and candidate in ids[field]:
                    record[field] = candidate
                    continue

            if len(hits) == 1:
                record[field] = hits[0].id
            else:
                problems.append({
                    "row": line,
                    "field": field,
                    "label": lk.label,
                    "raw": text,
                    "message": (
                        f"{lk.label} “{text}” matches "
                        f"{len(hits)} rows — pick which one."
                        if hits else
                        f"No {lk.label.lower()} called “{text}”."),
                    "candidates": [
                        {"id": row.id,
                         "label": _display(row, lk),
                         "code": (getattr(row, "code", None) or "").strip()}
                        for row in hits
                    ],
                })
    return problems


# --------------------------------------------------------------------------- #
#  Cell <-> value
# --------------------------------------------------------------------------- #
def _cell_out(value: Any) -> Any:
    """Model value -> something openpyxl can write."""
    if value is None:
        return None
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (list, tuple)):
        return LIST_SEPARATOR.join(str(v) for v in value)
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()[:10]
    return value


_TRUE = {"true", "yes", "y", "1", "active"}
_FALSE = {"false", "no", "n", "0", "inactive", ""}


def _cell_in(raw: Any, annotation: Any) -> Any:
    """Cell -> something the Pydantic schema will accept.

    Only the conversions a spreadsheet forces on us: Excel hands back "TRUE" as a
    string in one file and a real bool in the next, and 1.0 for a column of ids.
    Everything else is left for the schema to judge, so validation stays in one place.
    """
    inner = _unwrap_optional(annotation)
    if isinstance(raw, str):
        raw = raw.strip()
    if raw in (None, ""):
        return None

    if get_origin(inner) is list:
        member = (get_args(inner) or (str,))[0]
        parts = [p.strip() for p in str(raw).split(LIST_SEPARATOR) if p.strip()]
        return [int(float(p)) if member is int else p for p in parts]

    if inner is bool:
        if isinstance(raw, bool):
            return raw
        text = str(raw).strip().lower()
        if text in _TRUE:
            return True
        if text in _FALSE:
            return False
        raise ValueError(f"{raw!r} is not TRUE or FALSE")

    if inner is int:
        # Excel stores every number as a float, so an id column reads back as 7.0.
        return int(float(raw))

    if inner is Decimal:
        try:
            return Decimal(str(raw))
        except InvalidOperation as exc:
            raise ValueError(f"{raw!r} is not a number") from exc

    if inner in (date, datetime):
        if isinstance(raw, (date, datetime)):
            return raw.date() if isinstance(raw, datetime) else raw
        return str(raw)[:10]

    return raw


# --------------------------------------------------------------------------- #
#  Workbook building
# --------------------------------------------------------------------------- #
def _autosize(sheet) -> None:
    for column in sheet.columns:
        width = max((len(str(c.value)) for c in column if c.value is not None),
                    default=0)
        sheet.column_dimensions[column[0].column_letter].width = min(
            max(width + 2, 12), 50)


def _workbook_bytes(book: Workbook) -> bytes:
    buffer = io.BytesIO()
    book.save(buffer)
    return buffer.getvalue()


def _dropdown(sheet, lists, column_index: int, values: list[str]) -> None:
    """Put `values` on the hidden Lists sheet and point the column's cells at them.

    A validation list written inline (`formula1='"A,B,C"'`) is capped at 255
    characters by Excel and silently truncates, which is worse than no dropdown at
    all — the storekeeper picks from a list that is missing the row they need and
    has no way to know it is missing.
    """
    if not values:
        return
    letter = get_column_letter(lists.max_column + 1)
    lists.cell(row=1, column=lists.max_column + 1, value=f"__{column_index}")
    for offset, value in enumerate(values, start=2):
        lists[f"{letter}{offset}"] = value
    rule = DataValidation(
        type="list",
        formula1=f"=Lists!${letter}$2:${letter}${len(values) + 1}",
        allow_blank=True,
    )
    rule.error = "Pick a value from the list."
    rule.errorTitle = "Not one of the allowed values"
    sheet.add_data_validation(rule)
    target = get_column_letter(column_index)
    rule.add(f"{target}2:{target}1000")


def _example_value(defn, name: str, field, choices: dict[str, list[dict]]) -> Any:
    """One plausible cell, for the Example sheet.

    Built out of the master's own live rows rather than invented, so the example is a
    category that exists and can be copied straight across.
    """
    lk = lookups_by_field(defn).get(name)
    if lk:
        options = choices.get(name) or []
        return options[0]["label"] if options else ""
    inner = _unwrap_optional(field.annotation)
    enum = _enum_choices(defn, name)
    if enum:
        return enum[0]
    if inner is bool:
        return "Yes" if field.default is True else "No"
    if inner in (int, float, Decimal):
        return 1
    if inner in (date, datetime):
        return "2026-01-31"
    if name == "name":
        return f"Example {defn.name.lower()}"
    return ""


def build_template(defn, choices: dict[str, list[dict]] | None = None) -> bytes:
    """Headers, a dropdown wherever the answer is one of a known list, a How to fill
    sheet, and a filled Example row.

    The example is on its OWN sheet and not on `Data`: a sample row someone forgets
    to delete is a junk master record, which is why there was no example at all
    before — but a person who has never seen the file cannot infer from an empty grid
    what "Category" wants, and would guess. A separate sheet answers both.
    """
    choices = choices or {}
    book = Workbook()
    sheet = book.active
    sheet.title = "Data"
    fields = defn.schema.model_fields
    columns = columns_for(defn.schema)
    sheet.append([header_for(defn, c) for c in columns])
    for cell in sheet[1]:
        cell.font = cell.font.copy(bold=True)
    sheet.freeze_panes = "A2"
    _autosize(sheet)

    lists = book.create_sheet("Lists")
    for position, name in enumerate(columns, start=1):
        field = fields[name]
        lk = lookups_by_field(defn).get(name)
        if lk:
            options = choices.get(name) or []
            # Over the cap the list is served by the review screen instead; a
            # truncated dropdown would look complete and be wrong.
            if 0 < len(options) <= lk.max_options:
                _dropdown(sheet, lists, position, [o["label"] for o in options if o["label"]])
        elif _unwrap_optional(field.annotation) is bool:
            _dropdown(sheet, lists, position, ["Yes", "No"])
        elif _enum_choices(defn, name):
            _dropdown(sheet, lists, position, _enum_choices(defn, name))
    lists.sheet_state = "hidden"

    guide = book.create_sheet("How to fill")
    guide.append(["Column", "Required", "What to write", "Notes"])
    for cell in guide[1]:
        cell.font = cell.font.copy(bold=True)
    for name, field in fields.items():
        lk = lookups_by_field(defn).get(name)
        note = field.description or ""
        if lk:
            how = f"Exactly as it is spelt on the {lk.label} master"
            count = len(choices.get(name) or [])
            note = note or (
                "Pick from the drop-down in the cell."
                if 0 < count <= lk.max_options else
                "Type the name. Anything that cannot be matched is listed for you "
                "to pick from after you upload the file.")
        elif _unwrap_optional(field.annotation) is bool:
            how = "Yes or No"
        elif _enum_choices(defn, name):
            how = " / ".join(_enum_choices(defn, name))
        else:
            how = _type_hint(field.annotation)
            if name == "id":
                note = note or "Leave blank to create. Fill to update that row."
            elif name.endswith("_ids"):
                note = note or "Numeric ids separated by commas."
        guide.append([header_for(defn, name),
                      "Yes" if field.is_required() else "No", how, note])
    guide.append([])
    guide.append(["Leave a cell empty and that column is left alone."])
    guide.append(["Rows are matched on `id` first, then on `code`."])
    guide.append(["A row that matches nothing is created."])
    guide.append(["If any row is invalid the whole file is rejected and "
                  "nothing is saved."])
    _autosize(guide)

    example = book.create_sheet("Example")
    example.append([header_for(defn, c) for c in columns])
    for cell in example[1]:
        cell.font = cell.font.copy(bold=True)
    example.append([_example_value(defn, name, fields[name], choices)
                    for name in columns])
    example.append([])
    example.append(["This sheet is ignored on upload. Copy the row into Data and "
                    "change it."])
    _autosize(example)
    return _workbook_bytes(book)


async def lookup_labels(defn, db: AsyncSession) -> dict[str, dict[int, str]]:
    """`{field: {id: name}}`, uncapped — the export names every row it points at,
    including ones the dropdown was too long to offer."""
    out: dict[str, dict[int, str]] = {}
    for lk in getattr(defn, "lookups", ()):
        rows = (await db.execute(select(lk.model))).scalars().all()
        out[lk.field] = {row.id: _display(row, lk) for row in rows
                         if _display(row, lk)}
    return out


def build_export(defn, rows: list,
                 labels: dict[str, dict[int, str]] | None = None) -> bytes:
    """Exactly the columns /import accepts, plus `id` so the file round-trips into
    an update rather than into 400 duplicates.

    A looked-up column is written as the NAME, matching the template — an export the
    admin edits and sends back has to be the same shape as the sheet they were given,
    or the two files disagree about what column six means. An id with no row behind
    it is written as the bare number rather than blank: it is wrong, and saying so is
    better than quietly dropping the only record of what it pointed at.
    """
    labels = labels or {}
    book = Workbook()
    sheet = book.active
    sheet.title = "Data"
    columns = columns_for(defn.schema)
    sheet.append(["id", *[header_for(defn, c) for c in columns]])
    for cell in sheet[1]:
        cell.font = cell.font.copy(bold=True)
    by_field = lookups_by_field(defn)
    for row in rows:
        payload = defn.serialize(row)
        line = [_cell_out(getattr(row, "id", None))]
        for column in columns:
            value = payload.get(column, getattr(row, column, None))
            if column in by_field and value is not None:
                line.append(labels.get(column, {}).get(value) or value)
            else:
                line.append(_cell_out(value))
        sheet.append(line)
    sheet.freeze_panes = "A2"
    _autosize(sheet)
    return _workbook_bytes(book)


# --------------------------------------------------------------------------- #
#  Reading an uploaded file
# --------------------------------------------------------------------------- #
def parse_upload(defn, content: bytes) -> tuple[list[dict], list[str]]:
    """Returns (row dicts keyed by schema field, per-row errors).

    Unknown headers are ignored rather than rejected: an admin who adds a "notes to
    self" column should not be blocked, and the export's own `id` column is one of
    the columns this has to skip past.
    """
    try:
        book = load_workbook(io.BytesIO(content), data_only=True, read_only=True)
    except Exception as exc:                       # noqa: BLE001 - openpyxl raises broadly
        raise ValidationError(
            "That file is not a readable .xlsx workbook.") from exc

    sheet = book["Data"] if "Data" in book.sheetnames else book.worksheets[0]
    rows = sheet.iter_rows(values_only=True)
    try:
        header = next(rows)
    except StopIteration:
        raise ValidationError("The sheet is empty — no header row.") from None

    headers = [str(h).strip() if h is not None else "" for h in header]
    fields = defn.schema.model_fields
    by_field = lookups_by_field(defn)
    # A column is found by its readable label OR by the schema's own field name, so a
    # file written against the old template — or an export taken before this — still
    # imports. Matched without case or spacing so "Category " is still Category.
    alias = {_norm(name): name for name in fields}
    alias["id"] = "id"
    alias.update({_norm(lk.label): lk.field for lk in by_field.values()})
    known: dict[str, int] = {}
    for index, name in enumerate(headers):
        field = alias.get(_norm(name))
        if field is not None and field not in known:
            known[field] = index
    missing = [header_for(defn, name) for name, field in fields.items()
               if field.is_required() and name not in known]
    if missing:
        raise ValidationError(
            f"The sheet is missing required column(s): {', '.join(missing)}. "
            "Download the template to get the right headers.")

    parsed: list[dict] = []
    errors: list[str] = []
    for offset, values in enumerate(rows, start=2):
        if values is None or all(v in (None, "") for v in values):
            continue                                # blank spacer row
        if len(parsed) >= MAX_IMPORT_ROWS:
            raise ValidationError(
                f"That file has more than {MAX_IMPORT_ROWS} rows. "
                "Split it into smaller files.")
        record: dict[str, Any] = {"__row__": offset, "__lookup__": {}}
        for name, index in known.items():
            raw = values[index] if index < len(values) else None
            if name in by_field:
                # Held as typed and resolved against the target master afterwards.
                # Running it through _cell_in here would try int(float("Antibiotics")).
                text = str(raw).strip() if raw is not None else ""
                if text:
                    record["__lookup__"][name] = text
                continue
            annotation = int if name == "id" else fields[name].annotation
            try:
                parsed_value = _cell_in(raw, annotation)
            except (ValueError, TypeError) as exc:
                errors.append(f"Row {offset}, {name}: {exc}")
                continue
            # An empty cell means "say nothing about this column", so the key is
            # left out and the schema's own default applies. Passing None instead
            # rejected every list field ("input should be a valid list") and turned
            # a missing required value into a type error rather than "field
            # required", which is the message that tells the admin what to type.
            if parsed_value is None:
                continue
            record[name] = parsed_value
        parsed.append(record)

    if not parsed:
        raise ValidationError("The sheet has headers but no rows.")
    return parsed, errors


def _exported_record(defn, row, fields) -> dict:
    """The stored row as /export would write it, read straight back through the same
    cell parser — so it can be compared with a sheet row field for field."""
    payload = defn.serialize(row)
    out: dict[str, Any] = {}
    for name, field in fields.items():
        try:
            value = _cell_in(_cell_out(payload.get(name, getattr(row, name, None))),
                             field.annotation)
        except (ValueError, TypeError):
            return {}            # cannot be compared, so treat the row as changed
        if value is not None:
            out[name] = value
    return out


async def untouched_rows(defn, db: AsyncSession, parsed: list[dict]) -> tuple[list[dict], int]:
    """Split the sheet into rows that ask for a change and rows that do not.

    A row identical to what /export wrote is a no-op, and running it through the
    create-form schema is what makes one legacy record reject the whole file: 69 of
    the live items predate the mandatory general name / brand / manufacturer, so an
    admin who exports the item master, types three new rows at the bottom and uploads
    it gets 296 errors about rows they never touched and nothing is saved. Rows the
    admin actually edited are still validated in full.
    """
    ids = [r["id"] for r in parsed if r.get("id") is not None]
    if not ids:
        return parsed, 0
    stored = {row.id: row for row in (await db.execute(
        select(defn.model).where(defn.model.id.in_(ids)))).scalars().all()}
    fields = defn.schema.model_fields
    changed, unchanged = [], 0
    for record in parsed:
        row = stored.get(record.get("id"))
        supplied = {k: v for k, v in record.items() if k not in ("id", "__row__")}
        if row is not None and _exported_record(defn, row, fields) == supplied:
            unchanged += 1
            continue
        changed.append(record)
    return changed, unchanged


def validate_rows(defn, parsed: list[dict]) -> tuple[list[tuple[int, int | None, BaseModel]], list[str]]:
    """Run every row through the master's own schema before anything is written."""
    ready: list[tuple[int, int | None, BaseModel]] = []
    errors: list[str] = []
    for record in parsed:
        line = record.pop("__row__")
        row_id = record.pop("id", None)
        try:
            ready.append((line, row_id, defn.schema(**record)))
        except PydanticValidationError as exc:
            for problem in exc.errors():
                where = ".".join(str(p) for p in problem["loc"]) or "row"
                errors.append(f"Row {line}, {where}: {problem['msg']}")
    return ready, errors


# --------------------------------------------------------------------------- #
#  Writing the rows
# --------------------------------------------------------------------------- #
async def apply_rows(defn, db: AsyncSession, ready, unchanged: int, user,
                     *, write: Any, audit: Any) -> dict:
    """Create or update every validated row, then commit once.

    Shared by all three doors — the straight file import, the reviewed commit, and
    anything added later — so what the preview screen promised is what actually
    happens. `write` and `audit` are passed in for the same reason they are passed
    into `register_bulk_routes`: they live in crud.py, which imports this module.
    """
    has_code = hasattr(defn.model, "code")
    by_code: dict[str, Any] = {}
    if has_code:
        codes = [getattr(data, "code", None) for _, _, data in ready]
        codes = [c for c in codes if c]
        if codes:
            existing = (await db.execute(
                select(defn.model).where(defn.model.code.in_(codes))
            )).scalars().all()
            by_code = {row.code: row for row in existing}

    created = updated = 0
    for line, row_id, data in ready:
        row = None
        if row_id is not None:
            row = await db.get(defn.model, row_id)
            if row is None:
                raise ValidationError(
                    f"Row {line}: no {defn.name.lower()} with id {row_id}.")
            # The same boundary PUT enforces. Imported here rather than at module
            # level: crud imports THIS module to register these routes, so the
            # dependency only runs one way if it is resolved at call time.
            from app.shared.masters.crud import _require_in_scope
            await _require_in_scope(db, defn, row_id, user)
        elif has_code:
            row = by_code.get(getattr(data, "code", None))

        if row is None:
            row = defn.model()
            if defn.apply is not None:
                # Same call the CRUD route makes: a master whose apply checks the
                # caller must get the caller here too, or a spreadsheet would be
                # the way around a check the form enforces.
                await (defn.apply(db, row, data, user) if defn.apply_needs_user
                       else defn.apply(db, row, data))
            else:
                for key, value in data.model_dump().items():
                    setattr(row, key, value)
            db.add(row)
            await write(db, defn)
            # The same reload the single-row POST does, for the same reason: a row
            # that has only ever been written holds nothing the database filled in,
            # so a serializer that reads a server default, an eager relationship
            # (vendor_item_out reads row.vendor.name) or a column_property
            # (bom_out reads Bom.line_count) fires a lazy SELECT from async code
            # and raises MissingGreenlet. Importing vendor items or BOMs was a 500
            # every time until this was here.
            await db.refresh(row)
            await audit(db, entity=defn.model.__tablename__, entity_id=row.id,
                        action=AuditAction.CREATE, actor=user,
                        after=defn.serialize(row))
            if has_code and getattr(row, "code", None):
                by_code[row.code] = row
            created += 1
        else:
            before = defn.serialize(row)
            if defn.apply is not None:
                await (defn.apply(db, row, data, user) if defn.apply_needs_user
                       else defn.apply(db, row, data))
            else:
                for key, value in data.model_dump().items():
                    setattr(row, key, value)
            await write(db, defn)
            # Updates expire computed SQL expressions too. BOM imports hit the same
            # line_count lazy-load failure as the single-row PUT unless the row is
            # explicitly reloaded before audit serialization.
            await db.refresh(row)
            await audit(db, entity=defn.model.__tablename__, entity_id=row.id,
                        action=AuditAction.UPDATE, actor=user,
                        before=before, after=defn.serialize(row))
            updated += 1

    await write(db, defn, commit=True)
    return {"success": True, "created": created, "updated": updated,
            "unchanged": unchanged, "total": created + updated}


# --------------------------------------------------------------------------- #
#  Route registration
# --------------------------------------------------------------------------- #
def _filename(defn, suffix: str) -> str:
    return f"{defn.path}-{suffix}.xlsx"


def _xlsx_response(payload: bytes, filename: str) -> StreamingResponse:
    return StreamingResponse(
        io.BytesIO(payload),
        media_type=XLSX_CONTENT_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def register_bulk_routes(router, defn, *, write: Any, audit: Any) -> None:
    """Adds template/export (and import, unless the master is read-only).

    `write` and `audit` are passed in rather than imported: they live in crud.py,
    which imports this module, and reaching back would make the cycle real.
    """
    base = f"/api/{defn.path}"

    @router.get(base + "/template", name=f"template_{defn.path}")
    async def template(db: AsyncSession = Depends(get_db),
                       user=Depends(get_current_user)):
        # The dropdown values are read here rather than baked in: the template has to
        # offer the categories that exist this morning, not the ones that existed
        # when the file was designed.
        choices = await lookup_choices(defn, db)
        # Off the event loop: openpyxl is CPU-bound with no `await` in it, and a
        # workbook built inline blocks every other request for its duration.
        body = await asyncio.to_thread(build_template, defn, choices)
        return _xlsx_response(body, _filename(defn, "template"))

    @router.get(base + "/export", name=f"export_{defn.path}")
    async def export(
        request: Request,
        search: str | None = None,
        include_inactive: bool = True,
        db: AsyncSession = Depends(get_db),
        user=Depends(get_current_user),
    ):
        """Defaults to including inactive rows — an export is a backup and a
        round-trip source, and silently dropping deactivated rows would delete
        them from the admin's own copy of the master."""
        stmt = select(defn.model)
        if defn.default_active_only and not include_inactive:
            stmt = stmt.where(defn.model.is_active.is_(True))
        for column in defn.filters:
            raw = request.query_params.get(column)
            if raw not in (None, ""):
                stmt = stmt.where(getattr(defn.model, column) == raw)
        if search and defn.search_cols:
            cols = [getattr(defn.model, c) for c in defn.search_cols]
            stmt = stmt.where(or_(*[c.ilike(f"%{search}%") for c in cols]))
        stmt = stmt.order_by(getattr(defn.model, defn.order_col))
        rows = (await db.execute(stmt)).scalars().all()
        labels = await lookup_labels(defn, db)
        body = await asyncio.to_thread(build_export, defn, rows, labels)
        return _xlsx_response(body, _filename(defn, "export"))

    if defn.read_only:
        return

    @router.post(base + "/import/preview", name=f"import_preview_{defn.path}")
    async def import_preview(
        file: UploadFile = File(...),
        db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(defn.manage_perm)),
    ):
        """Everything the commit would do, except the writing.

        A rejected file used to be the end of the road: the storekeeper got a list of
        400 problems, went back to Excel and guessed again. This returns the sheet as
        the server understood it — every row, every cell it could not match, and what
        each unmatched cell might have meant — so the fixing happens on the screen
        with the master's real values in front of them, once, instead of over five
        uploads.

        It WRITES NOTHING and the session is rolled back before it returns: the row
        counting done here loads rows to compare against, and leaving that sitting in
        a session that never commits is how a preview ends up holding locks.
        """
        content = await file.read()
        if not content:
            raise ValidationError("That file is empty.")
        parsed, read_errors = parse_upload(defn, content)
        unmatched = await resolve_lookups(defn, db, parsed)
        # Validated on a COPY: validate_rows pops `id` and `__row__` off the records,
        # and the screen needs them back to show which sheet row it is talking about.
        ready, schema_errors = validate_rows(defn, [dict(r) for r in parsed])
        await db.rollback()

        # The review is editable, so every mapped column carries its familiar names.
        # A user can correct a blank or wrong selection without returning to Excel.
        options = await lookup_choices(defn, db)

        blocked = {p["row"] for p in unmatched}
        by_row: dict[int, list[dict]] = {}
        for problem in unmatched:
            by_row.setdefault(problem["row"], []).append(problem)
        for message in [*read_errors, *schema_errors]:
            # "Row 12, name: Field required" — the row number is the only part the
            # screen needs to attach it to a line.
            try:
                head, detail = message.split(": ", 1)
                row_part, field = head.split(", ", 1)
                line = int(row_part.removeprefix("Row "))
            except (ValueError, AttributeError):
                continue
            blocked.add(line)
            if any(p.get("field") == field for p in by_row.get(line, [])):
                continue
            by_row.setdefault(line, []).append(
                {"row": line, "field": field,
                 "label": header_for(defn, field) if field in defn.schema.model_fields else field,
                 "raw": None, "message": detail, "candidates": []})

        # Show duplicate business keys in preview instead of discovering them only
        # after Save. The commit path still revalidates authoritatively.
        duplicate_field = "code" if "code" in defn.schema.model_fields else (
            "name" if "name" in defn.schema.model_fields else None)
        if duplicate_field:
            seen: dict[str, int] = {}
            for record in parsed:
                raw = record.get(duplicate_field)
                key = _norm(raw)
                if not key:
                    continue
                line = int(record["__row__"])
                if key in seen:
                    blocked.add(line)
                    by_row.setdefault(line, []).append({
                        "row": line, "field": duplicate_field,
                        "label": header_for(defn, duplicate_field), "raw": str(raw),
                        "message": f"Duplicate of row {seen[key]}. Enter a different value.",
                        "candidates": [],
                    })
                else:
                    seen[key] = line

        return {
            "success": not blocked,
            "columns": [
                {"field": name,
                 "label": header_for(defn, name),
                 "required": field.is_required(),
                 "lookup": name in lookups_by_field(defn),
                 "choices": _enum_choices(defn, name),
                 "type": ("lookup" if name in lookups_by_field(defn)
                          else "boolean" if _unwrap_optional(field.annotation) is bool
                          else "text")}
                for name, field in defn.schema.model_fields.items()
            ],
            "rows": [
                {"row": record.get("__row__"),
                 "values": {k: v for k, v in record.items()
                            if k not in ("__row__", "__lookup__")},
                 "problems": by_row.get(record.get("__row__"), [])}
                for record in parsed
            ],
            "options": options,
            "file_errors": [],
            "summary": {"total": len(parsed),
                        "ready": len(parsed) - len(blocked),
                        "blocked": len(blocked)},
        }

    @router.post(base + "/import/commit", name=f"import_commit_{defn.path}")
    async def import_commit(
        payload: dict,
        db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(defn.manage_perm)),
    ):
        """The rows back from the review screen, with every name already an id.

        Validated again in full rather than trusted. The screen is a convenience; the
        rules are here, and a payload posted straight at this route must not be able
        to reach `apply_rows` by having skipped the preview.
        """
        rows = payload.get("rows")
        if not isinstance(rows, list) or not rows:
            raise ValidationError("No rows were sent.")
        if len(rows) > MAX_IMPORT_ROWS:
            raise ValidationError(
                f"That is more than {MAX_IMPORT_ROWS} rows. Split it into "
                "smaller files.")
        parsed = []
        for offset, row in enumerate(rows, start=2):
            if not isinstance(row, dict):
                raise ValidationError(f"Row {offset} is not a row.")
            record = {k: v for k, v in row.items()
                      if k not in ("__row__", "__lookup__") and v is not None}
            record["__row__"] = int(row.get("__row__") or offset)
            parsed.append(record)

        parsed, unchanged = await untouched_rows(defn, db, parsed)
        ready, problems = validate_rows(defn, parsed)
        if problems:
            raise ValidationError(
                f"{len(problems)} problem(s) found — nothing was saved.\n"
                + "\n".join(problems[:50])
                + ("\n…and more." if len(problems) > 50 else ""))
        return await apply_rows(defn, db, ready, unchanged, user,
                                write=write, audit=audit)

    @router.post(base + "/import", name=f"import_{defn.path}")
    async def import_rows(
        file: UploadFile = File(...),
        db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(defn.manage_perm)),
    ):
        content = await file.read()
        if not content:
            raise ValidationError("That file is empty.")
        parsed, read_errors = parse_upload(defn, content)
        unmatched = await resolve_lookups(defn, db, parsed)
        parsed, unchanged = await untouched_rows(defn, db, parsed)
        ready, schema_errors = validate_rows(defn, parsed)
        problems = (read_errors
                    + [f"Row {p['row']}, {p['label']}: {p['message']}"
                       for p in unmatched]
                    + schema_errors)
        if problems:
            # Everything wrong with the file, not just the first thing: the admin is
            # going to fix this in Excel and re-upload, and one error per round trip
            # across 400 rows is how an afternoon disappears.
            raise ValidationError(
                f"{len(problems)} problem(s) found — nothing was saved.\n"
                + "\n".join(problems[:50])
                + ("\n…and more." if len(problems) > 50 else ""))

        return await apply_rows(defn, db, ready, unchanged, user,
                                write=write, audit=audit)

