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
import json
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
from app.shared.enums import (
    AttributeDataType, CategoryTagType, UomClass, WarehouseType,
)
from app.shared.masters.messages import (
    Problem, field_hint, field_label, plain_error, rule_text, summarise,
)
from app.shared.enums import AuditAction

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheetml"
XLSX_CONTENT_TYPE = (
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
)
# A spreadsheet cell cannot hold a list, so multi-value fields travel as "1, 2, 3".
LIST_SEPARATOR = ","
# Import is for humans fixing a file by hand, not for feeding a migration through.
MAX_IMPORT_ROWS = 5000
# A draft carries the preview plus every edit; 5,000 rows of an item sheet with its
# dropdown options is a few MB. The cap only stops a runaway body.
MAX_DRAFT_BYTES = 19 * 1024 * 1024   # under nginx client_max_body_size 20m


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
        "uom_class": [c.value for c in UomClass],
        "warehouse_type": [t.value for t in WarehouseType],
        "data_type": [t.value for t in AttributeDataType],
        "tag_type": [t.value for t in CategoryTagType],
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
        for column, value in (getattr(lk, "where", None) or {}).items():
            stmt = stmt.where(getattr(lk.model, column) == value)
        if getattr(lk, "same_name_is_one", False):
            rows = (await db.execute(stmt.order_by(order))).scalars().all()
            by_name: dict[str, list] = {}
            for row in rows:
                by_name.setdefault(_norm(_display(row, lk)), []).append(row)
            rows = [_one_of_a_name(group) for group in by_name.values()][:lk.max_options + 1]
        else:
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


def _one_of_a_name(rows: list) -> Any:
    """The row the Item form offers for a name HCM repeats per office: active first,
    then one carrying a code, then the lowest id (`router._ownership_department_options`)."""
    return min(rows, key=lambda r: (getattr(r, "is_active", True) is False,
                                    0 if getattr(r, "code", None) else 1, r.id))


def _eligible(row: Any, lk: Any) -> bool:
    """Whether the row passes the lookup's `where`, e.g. a Level 3 category."""
    return all(getattr(row, column, None) == value
               for column, value in (getattr(lk, "where", None) or {}).items())


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
    # Codes and names this sheet itself is about to create, for lookups that point
    # back at the same master (a category's parent). Such a name cannot match the
    # database yet; it is resolved at save time, once that row exists.
    in_sheet = {_norm(record.get(key)) for record in parsed
                for key in ("code", "name") if record.get(key)}
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
        ids[field] = {row.id for row in rows if _eligible(row, lk)}

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
            keys = [text]
            normalize = getattr(lk, "normalize", None)
            if normalize is not None:
                alt = normalize(text)
                if alt and alt != text:
                    keys.append(alt)       # e.g. an HSN code that lost its leading zero
            for key in keys:
                for column in lk.match:
                    hits = index[field].get(f"{column}:{_norm(key)}", [])
                    if hits:
                        break
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

            if (not hits and lk.model is getattr(defn, "model", None)
                    and _norm(text) in in_sheet):
                record.setdefault("__pending__", {})[field] = text
                continue

            barred = [row for row in hits if not _eligible(row, lk)]
            hits = [row for row in hits if _eligible(row, lk)]
            if getattr(lk, "same_name_is_one", False) and len(hits) > 1:
                hits = [_one_of_a_name(hits)]
            if barred and not hits:
                problems.append({
                    "row": line, "field": field, "label": lk.label, "raw": text,
                    "message": f"“{text}” cannot be used here. {lk.where_hint}".strip(),
                    "candidates": [],
                })
            elif len(hits) == 1:
                record[field] = hits[0].id
            else:
                problems.append({
                    "row": line,
                    "field": field,
                    "label": lk.label,
                    "raw": text,
                    "message": (
                        f"“{text}” matches {len(hits)} different "
                        f"{lk.label.lower()} entries. Pick the right one from the list."
                        if hits else
                        f"There is no {lk.label.lower()} called “{text}”. Pick one "
                        f"from the list, or add it on the {lk.label} master first."),
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


def _cell_text(raw: Any) -> str:
    """A cell as the text a person typed into it.

    Excel decides a cell is NUMERIC the moment it holds only digits, so a code
    column — HSN 10005040, a pincode, a numeric SKU — reads back as an int, or as
    10005040.0 from a sheet that went through a CSV. The schema declares those
    columns `str` and Pydantic, rightly, will not guess a string out of a number:
    that was "Input should be a valid string" on every row of an HSN import. So a
    whole number is written without its ".0", and nothing else is reformatted.
    """
    if isinstance(raw, bool):
        return "TRUE" if raw else "FALSE"
    if isinstance(raw, float) and raw.is_integer():
        return str(int(raw))
    if isinstance(raw, Decimal) and raw == raw.to_integral_value():
        return str(int(raw))
    if isinstance(raw, datetime):
        return raw.isoformat()[:10] if raw.time() == datetime.min.time() \
            else raw.isoformat()
    if isinstance(raw, date):
        return raw.isoformat()
    return str(raw).strip()


def fixed_width(field: Any) -> int | None:
    """The width of a fixed-width code column (min_length == max_length), if the
    field is one — HSN is 8. Read off the schema so no master is named here."""
    low = high = None
    for meta in getattr(field, "metadata", ()):
        low = getattr(meta, "min_length", low)
        high = getattr(meta, "max_length", high)
    return low if low and low == high else None


# How far down the template's code columns are pre-formatted as text.
TEXT_FORMATTED_ROWS = 1000


def _is_code_column(name: str, field: Any) -> bool:
    """A text column whose values are codes, which Excel would read as numbers."""
    return _unwrap_optional(field.annotation) is str and (
        fixed_width(field) is not None or name == "code" or name.endswith("_code"))


def _cell_in(raw: Any, annotation: Any, width: int | None = None) -> Any:
    """Cell -> something the Pydantic schema will accept.

    Only the conversions a spreadsheet forces on us: Excel hands back "TRUE" as a
    string in one file and a real bool in the next, 1.0 for a column of ids, and a
    NUMBER for any text column that happens to hold only digits. Everything else is
    left for the schema to judge, so validation stays in one place.

    `width` is a fixed-width code column's length. A number cannot carry a leading
    zero, so "01012100" typed into Excel comes back as 1012100; when a NUMERIC cell in
    such a column is one digit short, the zero it lost is put back. A TEXT cell is never
    padded — a short code typed as text is a typo, and the schema says so.
    """
    inner = _unwrap_optional(annotation)
    if isinstance(raw, str):
        raw = raw.strip()
    if raw in (None, ""):
        return None

    if inner is str and not isinstance(raw, (str, bool)):
        text = _cell_text(raw)
        # ONE digit only: a code that is several digits short is not a lost zero,
        # it is the wrong number, and padding it would make the error quote a value
        # nobody typed ("00001234" for a cell reading 1234).
        if width and isinstance(raw, (int, float, Decimal)) \
                and text.isdigit() and len(text) == width - 1:
            text = "0" + text
        return text

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


# How many Data rows a template's dropdowns cover.
TEMPLATE_ROWS = 1000


def _dropdown(sheet, lists, column_index: int, values: list[str],
              sheet_column: int | None = None) -> None:
    """Put `values` on the hidden Lists sheet and point the column's cells at them.

    A validation list written inline (`formula1='"A,B,C"'`) is capped at 255
    characters by Excel and silently truncates, which is worse than no dropdown at
    all — the storekeeper picks from a list that is missing the row they need and
    has no way to know it is missing.
    """
    if not values and sheet_column is None:
        return
    letter = get_column_letter(lists.max_column + 1)
    lists.cell(row=1, column=lists.max_column + 1, value=f"__{column_index}")
    for offset, value in enumerate(values, start=2):
        lists[f"{letter}{offset}"] = value
    last = len(values) + 1
    formula = f"=Lists!${letter}$2:${letter}${last}"
    if sheet_column is not None:
        # The list also offers what THIS sheet is adding (a parent category typed
        # three rows up), not only what existed when the template was downloaded.
        # Each Data row is mirrored under the stored names, and the range is cut to
        # the cells that hold something, so the dropdown carries no blank tail.
        source = get_column_letter(sheet_column)
        for offset in range(2, TEMPLATE_ROWS + 1):
            lists[f"{letter}{last + offset - 1}"] = (
                f'=IF(Data!${source}${offset}="","",Data!${source}${offset})')
        end = last + TEMPLATE_ROWS - 1
        formula = (f'=OFFSET(Lists!${letter}$2,0,0,'
                   f'MAX(1,COUNTIF(Lists!${letter}$2:${letter}${end},"?*")),1)')
    rule = DataValidation(
        type="list",
        formula1=formula,
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
    from app.shared.masters import short_codes
    choices = choices or {}
    book = Workbook()
    sheet = book.active
    sheet.title = "Data"
    fields = defn.schema.model_fields
    columns = [c for c in columns_for(defn.schema)
               if c not in getattr(defn, "template_omit", ())]
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
            same_sheet = (lk.model is getattr(defn, "model", None) and "name" in columns)
            if len(options) <= lk.max_options and (options or same_sheet):
                _dropdown(sheet, lists, position,
                          [o["label"] for o in options if o["label"]],
                          sheet_column=columns.index("name") + 1 if same_sheet else None)
        elif _unwrap_optional(field.annotation) is bool:
            _dropdown(sheet, lists, position, ["Yes", "No"])
        elif _enum_choices(defn, name):
            _dropdown(sheet, lists, position, _enum_choices(defn, name))
        elif _is_code_column(name, field):
            # Formatted as TEXT before anyone types into it, so Excel keeps
            # "01012100" as typed instead of turning it into the number 1012100.
            letter = get_column_letter(position)
            for row in range(2, TEXT_FORMATTED_ROWS + 2):
                sheet[f"{letter}{row}"].number_format = "@"
    lists.sheet_state = "hidden"

    guide = book.create_sheet("How to fill")
    guide.append(["Column", "Required", "What to write", "Notes"])
    for cell in guide[1]:
        cell.font = cell.font.copy(bold=True)
    for name, field in ((n, fields[n]) for n in columns):
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
            how = rule_text(field) or _type_hint(field.annotation)
            width = fixed_width(field)
            if width:
                how = f"exactly {width} characters"
                note = note or ("Keep any leading zeros. The column is formatted as "
                                "text; a number that lost them is repaired on upload.")
            if name == "code" and short_codes.applies(defn):
                how = "Exactly 3 letters (A–Z), different on every row"
                note = ("e.g. ERB for Erba. No two rows may share a code. Leave it "
                        "blank and one is made from the name.")
            if name == "id":
                note = note or "Leave blank to create. Fill to update that row."
            elif name.endswith("_ids"):
                note = note or "Numeric ids separated by commas."
        guide.append([header_for(defn, name),
                      "Yes" if field.is_required() else "No", how,
                      note or field_hint(defn, name)])
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
def _cell_problem(raw: Any, annotation: Any, exc: Exception) -> str:
    """Why a cell could not even be read, in words — never Python's own message
    ("could not convert string to float: 'ten'")."""
    inner = _unwrap_optional(annotation)
    shown = f"“{str(raw).strip()[:60]}”"
    if inner is bool:
        return f"{shown} is not Yes or No. Type Yes or No."
    if inner is int:
        return f"{shown} is not a whole number. Type a number like 10."
    if inner in (Decimal, float):
        return f"{shown} is not a number. Type a number like 12.5."
    if get_origin(inner) is list:
        return f"{shown} could not be read. Separate the values with commas."
    return f"{shown} could not be read."


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
    # Headers renamed since a file may have been filled in.
    if "general_name_id" in by_field:
        alias.setdefault(_norm("General name"), "general_name_id")
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
                text = _cell_text(raw) if raw is not None else ""
                if text:
                    record["__lookup__"][name] = text
                continue
            annotation = int if name == "id" else fields[name].annotation
            width = None if name == "id" else fixed_width(fields[name])
            try:
                parsed_value = _cell_in(raw, annotation, width)
            except (ValueError, TypeError) as exc:
                errors.append(Problem(offset, name, field_label(defn, name),
                                      _cell_problem(raw, annotation, exc)))
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
                             field.annotation, fixed_width(field))
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


async def _short_code_problems(defn, db: AsyncSession, parsed: list[dict]) -> list:
    """Fill blank three-letter codes from the name; report ones that do not fit."""
    from app.shared.masters import short_codes
    return [Problem(line, "code", field_label(defn, "code"), message)
            for line, message in await short_codes.fill_and_check(defn, db, parsed)]


def take_pending(parsed: list[dict]) -> dict[int, dict[str, str]]:
    """`{sheet row: {field: name}}` for references to rows of this same sheet, popped
    off the records so the schema never sees them."""
    out: dict[int, dict[str, str]] = {}
    for record in parsed:
        pending = record.pop("__pending__", None)
        if pending:
            out[int(record["__row__"])] = dict(pending)
    return out


def _in_sheet_order(ready: list, pending: dict[int, dict[str, str]]) -> list:
    """Parents before children, whatever order the sheet lists them in."""
    if not pending:
        return ready
    line_of = {}
    for line, _row_id, data in ready:
        for key in ("code", "name"):
            if getattr(data, key, None):
                line_of[_norm(getattr(data, key))] = line
    depth: dict[int, int] = {}

    def walk(line: int, seen: frozenset = frozenset()) -> int:
        if line in depth:
            return depth[line]
        if line in seen:
            return 0                                  # a loop; apply refuses it
        parents = [line_of.get(_norm(t)) for t in pending.get(line, {}).values()]
        depth[line] = 1 + max((walk(p, seen | {line}) for p in parents if p), default=-1)
        return depth[line]

    return sorted(ready, key=lambda item: walk(item[0]))


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
            fields = defn.schema.model_fields
            for problem in exc.errors():
                field = str(problem["loc"][0]) if problem["loc"] else None
                label = field_label(defn, field) if field else "This row"
                errors.append(Problem(line, field, label, plain_error(
                    problem, label, fields.get(field) if field else None)))
    return ready, errors


# --------------------------------------------------------------------------- #
#  Writing the rows
# --------------------------------------------------------------------------- #
async def apply_rows(defn, db: AsyncSession, ready, unchanged: int, user,
                     *, write: Any, audit: Any,
                     pending: dict[int, dict[str, str]] | None = None) -> dict:
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

    async def run_apply(line: int, row, data) -> None:
        # A rule that lives in the master's apply (uniqueness, a parent that must
        # exist) raises without knowing which sheet row it was judging, and four
        # hundred rows in, "HSN code already exists" alone sends the admin hunting.
        try:
            await (defn.apply(db, row, data, user) if defn.apply_needs_user
                   else defn.apply(db, row, data))
        except ValidationError as exc:
            if not exc.message.startswith("Row "):
                exc.message = f"Row {line} — {exc.message}"
                exc.args = (exc.message,)
            raise

    pending = pending or {}
    ready = _in_sheet_order(ready, pending)
    saved_by_key: dict[str, Any] = {}               # code/name -> row, this run
    created = updated = 0
    from app.shared.masters import short_codes
    for line, row_id, data in ready:
        for field, text in pending.get(line, {}).items():
            target = saved_by_key.get(_norm(text))
            if target is None:
                raise ValidationError(
                    f"Row {line} — {field_label(defn, field)}: “{text}” is in this "
                    "file but could not be saved first. Check that row.")
            setattr(data, field, target.id)
        row = None
        if row_id is not None:
            row = await db.get(defn.model, row_id)
            if row is None:
                raise ValidationError(
                    f"Row {line} — the ID column says {row_id}, but there is no "
                    f"{defn.name.lower()} with that ID. Clear the ID cell to add it "
                    "as a new row.")
            # The same boundary PUT enforces. Imported here rather than at module
            # level: crud imports THIS module to register these routes, so the
            # dependency only runs one way if it is resolved at call time.
            from app.shared.masters.crud import _require_in_scope
            await _require_in_scope(db, defn, row_id, user)
        elif has_code:
            row = by_code.get(getattr(data, "code", None))

        try:
            await short_codes.enforce(db, defn, row, data)
        except ValidationError as exc:
            raise ValidationError(f"Row {line} — {exc.message}") from exc
        if row is None:
            row = defn.model()
            if defn.apply is not None:
                # Same call the CRUD route makes: a master whose apply checks the
                # caller must get the caller here too, or a spreadsheet would be
                # the way around a check the form enforces.
                from app.shared.masters.crud import UseExistingRow
                try:
                    await run_apply(line, row, data)
                except UseExistingRow as existing:
                    # Another brand of an item already in the master: the brand was
                    # added to that item; there is no new row to write (2026-10-23).
                    saved_by_key[_norm(getattr(existing.row, "code", "") or "")] = existing.row
                    updated += 1
                    continue
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
            for key in ("code", "name"):
                if getattr(row, key, None):
                    saved_by_key[_norm(getattr(row, key))] = row
            created += 1
        else:
            before = defn.serialize(row)
            if defn.apply is not None:
                await run_apply(line, row, data)
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
            for key in ("code", "name"):
                if getattr(row, key, None):
                    saved_by_key[_norm(getattr(row, key))] = row
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

    # The review in progress, kept on the server so it survives an expired login, a
    # refresh or a different machine. The page sends the whole state (the preview it
    # was given plus every pick and edit) and gets it back unchanged; nothing here
    # interprets it, because Save re-validates everything regardless.
    async def _draft_row(db: AsyncSession, user):
        from app.platform.settings.models import ImportDraft
        return await db.scalar(select(ImportDraft).where(
            ImportDraft.employee_id == user.id,
            ImportDraft.master_path == defn.path))

    @router.get(base + "/import/draft", name=f"import_draft_get_{defn.path}")
    async def import_draft_get(
        db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(defn.manage_perm)),
    ):
        row = await _draft_row(db, user)
        if row is None:
            return {"draft": None}
        return {"draft": json.loads(row.payload),
                "saved_at": row.updated_at.isoformat() + "Z"}

    @router.put(base + "/import/draft", name=f"import_draft_put_{defn.path}")
    async def import_draft_put(
        payload: dict,
        db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(defn.manage_perm)),
    ):
        from app.platform.settings.models import ImportDraft
        body = json.dumps(payload, default=str)
        if len(body) > MAX_DRAFT_BYTES:
            raise ValidationError("This review is too large to keep as a draft.")
        row = await _draft_row(db, user)
        if row is None:
            row = ImportDraft(employee_id=user.id, master_path=defn.path)
            db.add(row)
        row.payload = body
        row.updated_at = datetime.utcnow()
        await db.commit()
        return {"saved_at": row.updated_at.isoformat() + "Z"}

    @router.delete(base + "/import/draft", name=f"import_draft_delete_{defn.path}")
    async def import_draft_delete(
        db: AsyncSession = Depends(get_db),
        user=Depends(require_permission(defn.manage_perm)),
    ):
        row = await _draft_row(db, user)
        if row is not None:
            await db.delete(row)
            await db.commit()
        return {"success": True}

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
        read_errors += await _short_code_problems(defn, db, parsed)
        # Validated on a COPY: validate_rows pops `id` and `__row__` off the records,
        # and the screen needs them back to show which sheet row it is talking about.
        copies = [dict(r) for r in parsed]
        take_pending(copies)
        ready, schema_errors = validate_rows(defn, copies)
        await db.rollback()

        # Show each row as it WILL be saved, not as the sheet spelled it: the code
        # whose lost leading zero came back, the "8471 30 10" that is 84713010, the
        # CGST and SGST worked out from an IGST-only row. The review is where the
        # admin checks what they are about to commit, so it must be the real thing.
        # A row that failed validation keeps its raw cells, which is what they fix.
        understood = {line: data.model_dump(mode="json", exclude_none=True)
                      for line, _, data in ready}
        for record in parsed:
            normalised = understood.get(record.get("__row__"))
            if normalised:
                record.update(normalised)

        # The review is editable, so every mapped column carries its familiar names.
        # A user can correct a blank or wrong selection without returning to Excel.
        options = await lookup_choices(defn, db)

        blocked = {p["row"] for p in unmatched}
        by_row: dict[int, list[dict]] = {}
        for problem in unmatched:
            by_row.setdefault(problem["row"], []).append(problem)
        for problem in [*read_errors, *schema_errors]:
            line, field = getattr(problem, "row", None), getattr(problem, "field", None)
            if line is None:
                continue
            blocked.add(line)
            if any(p.get("field") == field for p in by_row.get(line, [])):
                continue
            by_row.setdefault(line, []).append(
                {"row": line, "field": field, "label": problem.label,
                 "raw": None, "message": problem.detail, "candidates": []})

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
                        "label": field_label(defn, duplicate_field), "raw": str(raw),
                        "message": (f"“{raw}” is already used on row {seen[key]} of this "
                                    "file. Each row needs its own "
                                    f"{field_label(defn, duplicate_field).lower()}."),
                        "candidates": [],
                    })
                else:
                    seen[key] = line

        return {
            "success": not blocked,
            "columns": [
                {"field": name,
                 "label": field_label(defn, name),
                 "hint": " ".join(filter(None, [field_hint(defn, name),
                                                rule_text(field).capitalize()])),
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
        fields = defn.schema.model_fields
        parsed = []
        for offset, row in enumerate(rows, start=2):
            if not isinstance(row, dict):
                raise ValidationError(f"Row {offset} is not a row.")
            record = {}
            for key, value in row.items():
                if key in ("__row__", "__lookup__") or value is None:
                    continue
                # The review screen edits every cell as text and posts back whatever
                # the preview served, numbers included, so a value is read the way a
                # sheet cell is: a number in a text column (an HSN code) is its text,
                # and a cell cleared on screen means "say nothing", as it does in Excel.
                field = fields.get(key)
                if field is not None and not isinstance(value, (list, dict)):
                    try:
                        value = _cell_in(value, field.annotation, fixed_width(field))
                    except (ValueError, TypeError):
                        pass                        # left for the schema to report
                    if value is None:
                        continue
                record[key] = value
            record["__row__"] = int(row.get("__row__") or offset)
            parsed.append(record)

        parsed, unchanged = await untouched_rows(defn, db, parsed)
        pending = take_pending(parsed)
        code_problems = await _short_code_problems(defn, db, parsed)
        ready, problems = validate_rows(defn, parsed)
        problems = code_problems + problems
        if problems:
            raise ValidationError(summarise(problems))
        return await apply_rows(defn, db, ready, unchanged, user,
                                write=write, audit=audit, pending=pending)

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
        pending = take_pending(parsed)
        read_errors += await _short_code_problems(defn, db, parsed)
        ready, schema_errors = validate_rows(defn, parsed)
        problems = (read_errors
                    + [Problem(p["row"], p["field"], p["label"], p["message"])
                       for p in unmatched]
                    + schema_errors)
        if problems:
            # Everything wrong with the file, not just the first thing: the admin is
            # going to fix this in Excel and re-upload, and one error per round trip
            # across 400 rows is how an afternoon disappears.
            raise ValidationError(summarise(problems))

        return await apply_rows(defn, db, ready, unchanged, user,
                                write=write, audit=audit, pending=pending)

