"""Document numbering via sys_doc_series (canonical schema).

Each series row: (doc_type, fiscal_year, prefix, pattern, last_number). We lock the
row, bump last_number, and format. `pattern` supports {prefix}/{fy}/{num} placeholders.
"""
import re
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationError
from app.platform.settings.models import DocSeries
from app.shared.enums import ResetPolicy


def _fiscal_year(now: datetime | None = None) -> str:
    now = now or datetime.now()
    # Indian FY: Apr–Mar, rendered as e.g. 2026-27
    start = now.year if now.month >= 4 else now.year - 1
    return f"{start}-{str(start + 1)[-2:]}"


DEFAULT_PATTERN = "{PREFIX}/{FY}/{SEQ:5}"

# The DB team's rows use {PREFIX}/{FY}/{SEQ:5}; earlier code wrote {prefix}/{fy}/{num:04d}.
# Both are accepted, because rejecting either would break live series or existing code.
# {SEQ:5} means "pad to 5 digits", which is not Python's format spec, so it is rewritten.
_ALIASES = {"PREFIX": "prefix", "FY": "fy", "SEQ": "num", "NUM": "num",
            "prefix": "prefix", "fy": "fy", "seq": "num", "num": "num"}
_FIELD = re.compile(r"\{(\w+)(?::(\d+)d?)?\}")


def normalise_pattern(pattern: str) -> str:
    """Rewrite a stored pattern into a Python format string."""
    def swap(match: re.Match) -> str:
        name, width = match.group(1), match.group(2)
        field = _ALIASES.get(name)
        if field is None:
            return match.group(0)      # unknown field: leave it, render() will catch it
        if field == "num":
            return "{num:0%sd}" % (width or "4")
        return "{%s}" % field
    return _FIELD.sub(swap, pattern or DEFAULT_PATTERN)


def render(pattern: str | None, prefix: str, fiscal_year: str, number: int) -> str:
    """Format one document number, falling back rather than raising on a bad pattern:
    a misconfigured series must not block the document being created."""
    try:
        return normalise_pattern(pattern or DEFAULT_PATTERN).format(
            prefix=prefix, fy=fiscal_year, num=number)
    except (KeyError, ValueError, IndexError):
        return f"{prefix}/{fiscal_year}/{number:04d}"


def current_period(policy: str | None, now: datetime | None = None) -> str | None:
    """The period label a counter belongs to, or None when it never resets."""
    now = now or datetime.now()
    if policy == ResetPolicy.YEARLY.value:
        return _fiscal_year(now)
    if policy == ResetPolicy.MONTHLY.value:
        return f"{now.year}-{now.month:02d}"
    return None


async def next_number(db: AsyncSession, doc_type: str) -> str:
    fy = _fiscal_year()
    row = (await db.execute(
        select(DocSeries).where(
            DocSeries.doc_type == doc_type, DocSeries.is_active.is_(True)
        ).order_by(DocSeries.fiscal_year.desc()).with_for_update()
    )).scalars().first()
    if row is None:
        raise ValidationError(f"No active document series for '{doc_type}'")

    # The reset happens here, under the same row lock that guards the increment, so two
    # concurrent documents at a period boundary cannot both reset and both take number 1.
    period = current_period(row.reset_policy)
    if period is not None and row.last_reset_period != period:
        row.last_number = 0
        row.last_reset_period = period

    row.last_number += 1
    n = row.last_number
    await db.flush()

    return render(row.pattern, row.prefix, row.fiscal_year or fy, n)
