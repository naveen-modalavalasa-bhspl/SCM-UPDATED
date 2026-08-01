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
from app.shared.numbering import current_period

PLACEHOLDERS = ("{prefix}", "{fy}", "{num")


def series_out(s: DocSeries) -> dict:
    return {"id": s.id, "doc_type": s.doc_type, "fiscal_year": s.fiscal_year,
            "prefix": s.prefix, "pattern": s.pattern, "last_number": s.last_number,
            "reset_policy": s.reset_policy or ResetPolicy.NEVER.value,
            "last_reset_period": s.last_reset_period, "is_active": s.is_active,
            "preview": preview(s)}


def preview(s: DocSeries) -> str:
    """Render what the next document number would look like, so an admin editing a
    pattern sees the result before saving it rather than on the next real document."""
    pattern = s.pattern or "{prefix}/{fy}/{num:04d}"
    try:
        return pattern.format(prefix=s.prefix, fy=s.fiscal_year,
                              num=(s.last_number or 0) + 1)
    except (KeyError, ValueError, IndexError):
        return "invalid pattern"


def _validate(data) -> None:
    if data.doc_type not in {t.value for t in DocType}:
        raise ValidationError(
            f"doc_type must be one of {', '.join(t.value for t in DocType)}")
    if data.reset_policy not in {p.value for p in ResetPolicy}:
        raise ValidationError(
            f"reset_policy must be one of {', '.join(p.value for p in ResetPolicy)}")
    if not any(p in (data.pattern or "") for p in PLACEHOLDERS):
        raise ValidationError(
            "pattern must contain at least one of {prefix}, {fy} or {num}")
    try:
        (data.pattern or "").format(prefix=data.prefix, fy=data.fiscal_year, num=1)
    except (KeyError, ValueError, IndexError) as exc:
        raise ValidationError(f"pattern is not a valid format string: {exc}") from exc


async def list_series(db: AsyncSession) -> dict:
    rows = (await db.execute(
        select(DocSeries).order_by(DocSeries.doc_type, DocSeries.fiscal_year)
    )).scalars().all()
    return {"items": [series_out(s) for s in rows]}


async def create_series(db: AsyncSession, data, actor) -> dict:
    _validate(data)
    clash = (await db.execute(
        select(DocSeries).where(DocSeries.doc_type == data.doc_type,
                                DocSeries.fiscal_year == data.fiscal_year)
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
    _validate(data)
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
