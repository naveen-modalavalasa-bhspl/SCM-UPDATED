"""Document numbering via sys_doc_series (canonical schema).

Each series row: (doc_type, fiscal_year, prefix, pattern, last_number). We lock the
row, bump last_number, and format. `pattern` supports {prefix}/{fy}/{num} placeholders.
"""
import logging
import re
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.platform.settings.models import DocSeries
from app.shared.enums import ResetPolicy

logger = logging.getLogger(__name__)


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


def render(pattern: str | None, prefix: str, fiscal_year: str, number: int,
           **extra: str) -> str:
    """Format one document number, falling back rather than raising on a bad pattern:
    a misconfigured series must not block the document being created.

    `extra` carries series-specific tokens the caller knows about and this file does
    not — a LOT number's `{WH}` and `{PATH}`, for instance. Unknown tokens are left
    alone by `normalise_pattern`, so they resolve here or fall back."""
    try:
        return normalise_pattern(pattern or DEFAULT_PATTERN).format(
            prefix=prefix, fy=fiscal_year, num=number, **extra)
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


# Prefixes for the series auto-created when none is configured. Anything not listed
# falls back to the first three letters of the doc type.
_DEFAULT_PREFIXES = {"indent": "IND", "mr": "MR", "po": "PO", "grn": "GRN",
                     "issue": "ISS", "gatepass": "GP",
                     # Warehouse. Named here because the three-letter fallback reads
                     # badly for the two-word types ("WH_" for WH_ISSUE, "PUR" for
                     # PURCHASE_RETURN, which collides with how people say "PO").
                     "receipt": "REC", "gate_entry": "GE", "inspection": "QC",
                     "putaway": "PUT", "picking": "PICK", "wh_issue": "WHI",
                     "dispatch": "DSP", "purchase_return": "PRET",
                     # The lot stamped on stock at putaway; its pattern carries the
                     # storage path, so a lot number reads as where the stock went.
                     "lot": "LOT"}


# A doc type whose number is more than prefix/year/sequence says so here, or the
# auto-created series would quietly drop the extra tokens the caller passes.
_DEFAULT_PATTERNS = {"lot": "{PREFIX}/{WH}/{PATH}/{FY}/{SEQ:5}"}


def default_prefix(doc_type: str) -> str:
    return _DEFAULT_PREFIXES.get(doc_type.lower(), doc_type[:3].upper())


def default_pattern(doc_type: str) -> str:
    return _DEFAULT_PATTERNS.get(doc_type.lower(), DEFAULT_PATTERN)


async def next_number(db: AsyncSession, doc_type: str, **extra: str) -> str:
    fy = _fiscal_year()
    row = (await db.execute(
        select(DocSeries).where(
            DocSeries.doc_type == doc_type, DocSeries.is_active.is_(True)
        ).order_by(DocSeries.fiscal_year.desc()).with_for_update()
    )).scalars().first()
    if row is None:
        # A missing series must not block the document. Numbering is configuration,
        # and configuration that nobody filled in should degrade, not stop work —
        # the same rule the approval fallback follows. The row is created here so the
        # sequence is still gapless and still admin-editable afterwards.
        logger.warning(
            "No active document series for %r; creating a default one (prefix %s). "
            "Configure it under Settings > Document Numbering.",
            doc_type, default_prefix(doc_type))
        row = DocSeries(doc_type=doc_type, fiscal_year=fy,
                        prefix=default_prefix(doc_type),
                        pattern=default_pattern(doc_type),
                        last_number=0, is_active=True)
        db.add(row)
        await db.flush()

    # The reset happens here, under the same row lock that guards the increment, so two
    # concurrent documents at a period boundary cannot both reset and both take number 1.
    period = current_period(row.reset_policy)
    if period is not None and row.last_reset_period != period:
        row.last_number = 0
        row.last_reset_period = period

    row.last_number += 1
    n = row.last_number
    await db.flush()

    return render(row.pattern, row.prefix, row.fiscal_year or fy, n, **extra)
