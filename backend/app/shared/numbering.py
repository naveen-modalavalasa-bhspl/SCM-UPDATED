"""Document numbering via sys_doc_series (canonical schema).

Each series row: (doc_type, fiscal_year, prefix, pattern, last_number). We lock the
row, bump last_number, and format. `pattern` supports {prefix}/{fy}/{num} placeholders.
"""
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationError
from app.platform.settings.models import DocSeries


def _fiscal_year(now: datetime | None = None) -> str:
    now = now or datetime.now()
    # Indian FY: Apr–Mar, rendered as e.g. 2026-27
    start = now.year if now.month >= 4 else now.year - 1
    return f"{start}-{str(start + 1)[-2:]}"


async def next_number(db: AsyncSession, doc_type: str) -> str:
    fy = _fiscal_year()
    row = (await db.execute(
        select(DocSeries).where(
            DocSeries.doc_type == doc_type, DocSeries.is_active.is_(True)
        ).order_by(DocSeries.fiscal_year.desc()).with_for_update()
    )).scalars().first()
    if row is None:
        raise ValidationError(f"No active document series for '{doc_type}'")

    row.last_number += 1
    n = row.last_number
    await db.flush()

    pattern = row.pattern or "{prefix}/{fy}/{num:04d}"
    try:
        return pattern.format(prefix=row.prefix, fy=row.fiscal_year or fy, num=n)
    except (KeyError, ValueError):
        return f"{row.prefix}/{row.fiscal_year or fy}/{n:04d}"
