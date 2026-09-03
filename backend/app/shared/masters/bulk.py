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


def build_template(defn) -> bytes:
    """Headers plus a sheet explaining each one. No sample data row: a sample row
    that someone forgets to delete is a junk master record."""
    book = Workbook()
    sheet = book.active
    sheet.title = "Data"
    columns = columns_for(defn.schema)
    sheet.append(columns)
    for cell in sheet[1]:
        cell.font = cell.font.copy(bold=True)
    sheet.freeze_panes = "A2"
    _autosize(sheet)

    guide = book.create_sheet("How to fill")
    guide.append(["Column", "Required", "Format", "Notes"])
    for cell in guide[1]:
        cell.font = cell.font.copy(bold=True)
    for name, field in defn.schema.model_fields.items():
        note = ""
        if name == "id":
            note = "Leave blank to create. Fill to update that row."
        elif name.endswith("_id"):
            note = "The numeric id from the related master's export."
        elif name.endswith("_ids"):
            note = "Numeric ids separated by commas."
        guide.append([
            name,
            "Yes" if field.is_required() else "No",
            _type_hint(field.annotation),
            field.description or note,
        ])
    guide.append([])
    guide.append(["Rows are matched on `id` first, then on `code`."])
    guide.append(["A row that matches nothing is created."])
    guide.append(["If any row is invalid the whole file is rejected and "
                  "nothing is saved."])
    _autosize(guide)
    return _workbook_bytes(book)


def build_export(defn, rows: list) -> bytes:
    """Exactly the columns /import accepts, plus `id` so the file round-trips into
    an update rather than into 400 duplicates."""
    book = Workbook()
    sheet = book.active
    sheet.title = "Data"
    columns = columns_for(defn.schema)
    sheet.append(["id", *columns])
    for cell in sheet[1]:
        cell.font = cell.font.copy(bold=True)
    for row in rows:
        payload = defn.serialize(row)
        sheet.append([
            _cell_out(getattr(row, "id", None)),
            *[_cell_out(payload.get(column, getattr(row, column, None)))
              for column in columns],
        ])
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
    known = {name: index for index, name in enumerate(headers)
             if name in fields or name == "id"}
    missing = [name for name, field in fields.items()
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
        record: dict[str, Any] = {"__row__": offset}
        for name, index in known.items():
            raw = values[index] if index < len(values) else None
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
    async def template(user=Depends(get_current_user)):
        # Off the event loop: openpyxl is CPU-bound with no `await` in it, and a
        # workbook built inline blocks every other request for its duration.
        body = await asyncio.to_thread(build_template, defn)
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
        body = await asyncio.to_thread(build_export, defn, rows)
        return _xlsx_response(body, _filename(defn, "export"))

    if defn.read_only:
        return

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
        parsed, unchanged = await untouched_rows(defn, db, parsed)
        ready, schema_errors = validate_rows(defn, parsed)
        problems = read_errors + schema_errors
        if problems:
            # Everything wrong with the file, not just the first thing: the admin is
            # going to fix this in Excel and re-upload, and one error per round trip
            # across 400 rows is how an afternoon disappears.
            raise ValidationError(
                f"{len(problems)} problem(s) found — nothing was saved.\n"
                + "\n".join(problems[:50])
                + ("\n…and more." if len(problems) > 50 else ""))

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
                await audit(db, entity=defn.model.__tablename__, entity_id=row.id,
                            action=AuditAction.UPDATE, actor=user,
                            before=before, after=defn.serialize(row))
                updated += 1

        await write(db, defn, commit=True)
        return {"success": True, "created": created, "updated": updated,
                "unchanged": unchanged, "total": created + updated}
