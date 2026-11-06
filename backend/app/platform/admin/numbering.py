"""Document numbering administration over sys_doc_series.

Editing a series is deliberately restrictive: prefix, pattern and reset policy are
free to change, but `last_number` is not editable through the API. Rewinding a counter
would hand out a document number that already exists on a live document.
"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.platform.settings.models import DocSeries
from app.platform.settings.service import write_audit
from app.shared.enums import AuditAction, DocType, ResetPolicy
from app.shared.numbering import (
    DEFAULT_PATTERN, _fiscal_year, current_period, normalise_pattern, render, tokens_in,
)

# What each token stands for, shown on the screen so an admin can compose a pattern
# without reading this file. Order is the order they are listed in.
TOKENS = (
    ("{PREFIX}", "the prefix on this row, e.g. IND"),
    ("{SEQ:5}", "the running number, padded to 5 digits"),
    ("{FY}", "financial year, worked out from today and changing by itself on 1 April"),
    ("{COMPANY}", "the document's organisation (procurement); elsewhere, Settings > Company"),
    ("{PROJECT}", "the document's project, or its department when it has no project"),
    ("{YYYY}", "calendar year, e.g. 2026"),
    ("{YY}", "2-digit year, e.g. 26"),
    ("{MM}", "month number, 01-12"),
    ("{MON}", "month name, JAN-DEC"),
    ("{DD}", "day of month, 01-31"),
)
# Sample values for the preview. Real values are only known when a document is
# created, so the preview shows the shape, with today's date where the date is meant.
SAMPLE = {"project": "PROJECT", "company": "COMPANY", "WH": "WH01", "PATH": "A-01-02"}


def series_out(s: DocSeries) -> dict:
    return {"id": s.id, "doc_type": s.doc_type, "fiscal_year": s.fiscal_year,
            "prefix": s.prefix, "pattern": s.pattern, "last_number": s.last_number,
            "reset_policy": s.reset_policy or ResetPolicy.NEVER.value,
            "last_reset_period": s.last_reset_period, "is_active": s.is_active,
            "preview": preview(s)}


def preview(s: DocSeries) -> str:
    """Render what the next document number would look like, so an admin editing a
    pattern sees the result before saving it rather than on the next real document.

    Goes through the same `render()` the documents use — a preview built by a second
    formatter is a preview that can disagree with reality."""
    # `render` deliberately falls back to the default pattern when a stored pattern
    # is invalid so document creation is never blocked. The admin preview must still
    # expose that configuration error rather than making the fallback look like the
    # saved pattern worked.
    try:
        known = {t: t.upper() for t in (
            "company", "project", "yyyy", "yy", "mm", "mon", "dd",
        )}
        normalise_pattern(s.pattern or DEFAULT_PATTERN).format(
            prefix=s.prefix, fy=s.fiscal_year, num=(s.last_number or 0) + 1,
            **{**known, **SAMPLE},
        )
    except (KeyError, ValueError, IndexError):
        return "invalid pattern"
    return render(s.pattern or DEFAULT_PATTERN, s.prefix, _fiscal_year(),
                  (s.last_number or 0) + 1, **SAMPLE)


# Column widths, read off the model rather than retyped: a value one character over
# these reached MySQL and came back as a 500 (DataError 1406) instead of a message the
# admin could act on.
_LIMITS = {name: DocSeries.__table__.c[name].type.length
           for name in ("doc_type", "fiscal_year", "prefix", "pattern")}
_LABELS = {"doc_type": "Document type", "fiscal_year": "Fiscal year",
           "prefix": "Prefix", "pattern": "Pattern"}


def _validate(data, current_doc_type: str | None = None) -> None:
    for field, limit in _LIMITS.items():
        value = getattr(data, field, None) or ""
        if len(value) > limit:
            raise ValidationError(
                f"{_LABELS[field]} is too long: {len(value)} characters, "
                f"the most it can hold is {limit}")
    # A token in the prefix would be stored and printed literally — `render()` fills
    # {PREFIX} with this value, it does not then re-scan it for tokens. Say so, rather
    # than letting IND turn into "{COMPANY}/{PROJECT}/IND" on every document.
    if "{" in (data.prefix or ""):
        raise ValidationError(
            "Prefix is plain text, e.g. IND — it is not expanded. Put "
            "{COMPANY}, {PROJECT} or a date token in Pattern instead")
    # A row's OWN doc type is always accepted on edit. `next_number` auto-creates
    # series under the caller's key ("mr", "po", "lot", "adj"), most of them lowercase
    # and some not in DocType at all, so checking them against the enum made those
    # rows impossible to edit — their pattern could never be changed from the screen.
    if (data.doc_type != current_doc_type
            and data.doc_type not in {t.value for t in DocType}):
        raise ValidationError(
            f"doc_type must be one of {', '.join(t.value for t in DocType)}")
    if data.reset_policy not in {p.value for p in ResetPolicy}:
        raise ValidationError(
            f"reset_policy must be one of {', '.join(p.value for p in ResetPolicy)}")
    if "num" not in tokens_in(data.pattern):
        raise ValidationError(
            "pattern must contain a running number placeholder, {SEQ:5} or "
            "{num:04d} — without it every document would get the same number")
    try:
        known = {t: t for t in ("company", "project", "yyyy", "yy", "mm", "mon", "dd")}
        normalise_pattern(data.pattern).format(
            prefix=data.prefix, fy=data.fiscal_year, num=1, **{**known, **SAMPLE})
    except (KeyError, ValueError, IndexError) as exc:
        raise ValidationError(
            f"pattern is not a valid format string; it uses an unknown token: {exc}. "
            "Known tokens: "
            + ", ".join(name for name, _ in TOKENS)) from exc


async def list_series(db: AsyncSession) -> dict:
    # scope_key IS NULL: the rows an admin configures. The per-project counter rows
    # numbering.py splits off are derived from these and are not separately editable.
    rows = (await db.execute(
        select(DocSeries).where(DocSeries.scope_key.is_(None))
        .order_by(DocSeries.doc_type, DocSeries.fiscal_year)
    )).scalars().all()
    return {"items": [series_out(s) for s in rows], "tokens": [
        {"token": name, "meaning": meaning} for name, meaning in TOKENS]}


async def create_series(db: AsyncSession, data, actor) -> dict:
    _validate(data)
    clash = (await db.execute(
        select(DocSeries).where(DocSeries.doc_type == data.doc_type,
                                DocSeries.fiscal_year == data.fiscal_year,
                                # Counter rows share the doc_type and year by design.
                                DocSeries.scope_key.is_(None))
    )).scalar_one_or_none()
    if clash is not None:
        raise ValidationError(
            f"A series already exists for {data.doc_type} {data.fiscal_year}")

    row = DocSeries(**data.model_dump(), last_number=0,
                    last_reset_period=current_period(data.reset_policy))
    db.add(row)
    await db.flush()
    await write_audit(db, entity="sys_doc_series", entity_id=row.id,
                      action=AuditAction.CREATE, actor=actor, after=series_out(row))
    await db.commit()
    await db.refresh(row)
    return series_out(row)


async def update_series(db: AsyncSession, series_id: int, data, actor) -> dict:
    row = await db.get(DocSeries, series_id)
    if row is None:
        raise NotFoundError("Document series not found")
    _validate(data, current_doc_type=row.doc_type)
    before = series_out(row)
    # last_number is intentionally absent from the payload: see the module docstring.
    for key, value in data.model_dump().items():
        setattr(row, key, value)
    await db.flush()
    await write_audit(db, entity="sys_doc_series", entity_id=row.id,
                      action=AuditAction.UPDATE, actor=actor,
                      before=before, after=series_out(row))
    await db.commit()
    await db.refresh(row)
    return series_out(row)


async def deactivate_series(db: AsyncSession, series_id: int, actor) -> dict:
    row = await db.get(DocSeries, series_id)
    if row is None:
        raise NotFoundError("Document series not found")
    row.is_active = False
    await db.flush()
    await write_audit(db, entity="sys_doc_series", entity_id=row.id,
                      action=AuditAction.DEACTIVATE, actor=actor)
    await db.commit()
    return {"success": True, "id": series_id, "is_active": False}
