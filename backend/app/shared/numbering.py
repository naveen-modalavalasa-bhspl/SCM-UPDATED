"""Document numbering via sys_doc_series (canonical schema).

Each series row: (doc_type, fiscal_year, prefix, pattern, last_number). We lock the
row, bump last_number, and format. `pattern` supports {prefix}/{fy}/{num} placeholders.
"""
import logging
import re
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.platform.settings.models import DocSeries, Setting
from app.shared.enums import ResetPolicy
from app.shared.time import now as ist_now, today as ist_today

logger = logging.getLogger(__name__)


def _fiscal_year(now: datetime | None = None) -> str:
    now = now or ist_now()
    # Indian FY: Apr–Mar, rendered as e.g. 2026-27
    start = now.year if now.month >= 4 else now.year - 1
    return f"{start}-{str(start + 1)[-2:]}"


# CHANGED 2026-08-21 — was "{PREFIX}/{FY}/{SEQ:5}". A number now names the company and
# the project it belongs to, so `BHS/MED/2026-27/IND0007` says on sight where the paper
# came from. `c3d4e5f6a7b9` moves the series already in the database; this is what a
# series AUTO-CREATED from here on gets, so a doc type nobody configured does not
# quietly go back to the old shape.
#
# Both scope tokens always render — `numbering.UNSET` ("NA") stands in where the caller
# has no project — so adding them can never stop a document getting a number. See
# SCOPE_SLUG_LEN for why they are three letters and not twelve.
DEFAULT_PATTERN = "{COMPANY}/{PROJECT}/{FY}/{PREFIX}{SEQ:4}"

# The DB team's rows use {PREFIX}/{FY}/{SEQ:5}; earlier code wrote {prefix}/{fy}/{num:04d}.
# Both are accepted, because rejecting either would break live series or existing code.
# {SEQ:5} means "pad to 5 digits", which is not Python's format spec, so it is rewritten.
#
# COMPANY/PROJECT/date tokens were added so a series can read
# {COMPANY}/{PROJECT}/{MON}-{YY}/{SEQ:4} without a code change. Every one of them
# always has a value at render time (see `_context`), so adding a token to a pattern
# can never make a document fail to get a number.
_ALIASES = {"PREFIX": "prefix", "FY": "fy", "SEQ": "num", "NUM": "num",
            "prefix": "prefix", "fy": "fy", "seq": "num", "num": "num",
            "COMPANY": "company", "PROJECT": "project",
            "company": "company", "project": "project",
            "YYYY": "yyyy", "YY": "yy", "MM": "mm", "MON": "mon", "DD": "dd",
            "yyyy": "yyyy", "yy": "yy", "mm": "mm", "mon": "mon", "dd": "dd"}
_FIELD = re.compile(r"\{(\w+)(?::(\d+)d?)?\}")

# Tokens whose value identifies WHO the document belongs to. A pattern that names one
# gets its own running number per value — see `scope_key_for`.
_SCOPE_TOKENS = {"company": "COMPANY", "project": "PROJECT"}
_MONTHS = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN",
           "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")
# What a scope token renders as when the caller has no value for it. Not blank: a blank
# would collapse "no project" and "project 1" into the same-looking number.
UNSET = "NA"

#: How many letters a COMPANY or PROJECT contributes to a document number.
#:
#: THREE, fixed, 2026-08-21. The scope tokens used to take `slug`'s default of 12, and
#: a real pair of names blew the number past the column that has to hold it:
#: "Tirumala Constructions" + "Medak Phase Two" renders
#: `TIRUMALACONS/MEDAKPHASETW/2026-27/IND0007` — 41 characters into a `String(30)`
#: document-number column, which is a truncation or an error on every document raised.
#:
#: Three is also what makes the number READABLE, which is the point of putting them
#: there: `TIR/MED/2026-27/IND0007` is 23 characters and says at a glance whose it is
#: and which project it came from. Longer is not more informative, it is just longer.
#:
#: If this is ever widened, check every `*_no` column first — the narrowest is 30.
SCOPE_SLUG_LEN = 3


def slug(value: str | None, limit: int = 12) -> str:
    """A name as it can appear inside a document number: A-Z0-9 only, uppercased."""
    cleaned = re.sub(r"[^A-Za-z0-9]", "", value or "").upper()
    return cleaned[:limit] or UNSET


def tokens_in(pattern: str | None) -> set[str]:
    """The field names a pattern uses, normalised (`{SEQ:5}` -> `num`)."""
    return {_ALIASES[m.group(1)] for m in _FIELD.finditer(pattern or "")
            if m.group(1) in _ALIASES}


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


def _context(now: datetime | None = None, **extra: str) -> dict:
    """Every token this file can resolve, with a value for each. Caller-supplied
    values win, so `render(..., project="MEDAK")` overrides the UNSET default."""
    now = now or ist_now()
    values = {"company": UNSET, "project": UNSET,
              "yyyy": f"{now.year}", "yy": f"{now.year % 100:02d}",
              "mm": f"{now.month:02d}", "mon": _MONTHS[now.month - 1],
              "dd": f"{now.day:02d}"}
    for key, value in extra.items():
        # An empty COMPANY/PROJECT leaves the default standing; an empty token this
        # file does not own (a lot's {WH}) is passed through exactly as before.
        if value in (None, "") and key in values:
            continue
        values[key] = value
    return values


def render(pattern: str | None, prefix: str, fiscal_year: str, number: int,
           **extra: str) -> str:
    """Format one document number, falling back rather than raising on a bad pattern:
    a misconfigured series must not block the document being created.

    `extra` carries series-specific tokens the caller knows about and this file does
    not — a LOT number's `{WH}` and `{PATH}`, for instance. Unknown tokens are left
    alone by `normalise_pattern`, so they resolve here or fall back."""
    try:
        return normalise_pattern(pattern or DEFAULT_PATTERN).format(
            prefix=prefix, fy=fiscal_year, num=number, **_context(**extra))
    except (KeyError, ValueError, IndexError):
        return f"{prefix}/{fiscal_year}/{number:04d}"


def scope_key_for(pattern: str | None, **extra: str) -> str | None:
    """Which counter a document drawn on this pattern belongs to, or None for the one
    shared counter — which is what every pattern written before this returns, so an
    existing series keeps using the row it has always used.

    Only identity tokens split a counter. Date tokens do not: restarting on a date is
    what `reset_policy` already does, and splitting on both would mint a row a month.
    """
    used = tokens_in(pattern) & set(_SCOPE_TOKENS)
    if not used:
        return None
    values = _context(**extra)
    return "|".join(f"{_SCOPE_TOKENS[t]}:{values[t]}" for t in sorted(used))


def current_period(policy: str | None, now: datetime | None = None) -> str | None:
    """The period label a counter belongs to, or None when it never resets."""
    now = now or ist_now()
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
                     # The consignment's own series. "CON" is free: consolidation is
                     # CONS, named below for exactly that reason.
                     "consignment": "CON",
                     # The lot stamped on stock at putaway; its pattern carries the
                     # storage path, so a lot number reads as where the stock went.
                     "lot": "LOT",
                     # Logistics and the consolidated buying sheet. Named for the same
                     # reason the warehouse types are: the three-letter fallback gives
                     # "TRA" and "CON", neither of which is what anyone calls them.
                     "transport_request": "TR", "consolidation": "CONS",
                     "consolidated_trip": "TRIP",
                     # FIXED 2026-08-21 — both of these fell through to the
                     # three-letter fallback, and `STOCK_MOVEMENT`[:3] is "STO", which
                     # is what everybody in this system reads as a Stock TRANSFER
                     # Order. So every bin-to-bin movement and every movement ORDER
                     # came out numbered STO/..., indistinguishable on paper from an
                     # inter-warehouse transfer that is a completely different
                     # document. Named explicitly so the fallback can never rename
                     # them again.
                     "stock_movement": "SMV",
                     "stock_movement_order": "SMO",
                     # "STO" again otherwise — see above.
                     "stock_edit": "SCR",
                     # The buyer's change request on a supplier's quotation. "CR"
                     # is what the desk calls it; the three-letter fallback for
                     # QUOTE_CHANGE_REQUEST would have been "QUO", which is what
                     # the quotation itself is already numbered as.
                     "quote_change_request": "CR"}


# A doc type whose number is more than prefix/year/sequence says so here, or the
# auto-created series would quietly drop the extra tokens the caller passes.
_DEFAULT_PATTERNS = {"lot": "{PREFIX}/{WH}/{PATH}/{FY}/{SEQ:5}"}


def default_prefix(doc_type: str) -> str:
    return _DEFAULT_PREFIXES.get(doc_type.lower(), doc_type[:3].upper())


def default_pattern(doc_type: str) -> str:
    return _DEFAULT_PATTERNS.get(doc_type.lower(), DEFAULT_PATTERN)


async def _company(db: AsyncSession) -> str:
    """The company token, from Settings > Company. Read here rather than passed by
    every caller — it is the same for every document in the database."""
    row = (await db.execute(
        select(Setting).where(Setting.setting_key == "company.name")
    )).scalar_one_or_none()
    return slug(row.setting_value if row else None, SCOPE_SLUG_LEN)


async def next_number(db: AsyncSession, doc_type: str, *, project: str | None = None,
                      **extra: str) -> str:
    fy = _fiscal_year()
    series = (await db.execute(
        select(DocSeries).where(
            DocSeries.doc_type == doc_type, DocSeries.is_active.is_(True),
            DocSeries.scope_key.is_(None),
        ).order_by(DocSeries.fiscal_year.desc()).with_for_update()
    )).scalars().first()
    row = series
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
        series = row

    # Identity tokens the pattern asks for. Resolved only when asked for, so a plain
    # {PREFIX}/{FY}/{SEQ} series still costs exactly one query.
    wanted = tokens_in(series.pattern) & set(_SCOPE_TOKENS)
    if "project" in wanted:
        extra["project"] = slug(project, SCOPE_SLUG_LEN)
    if "company" in wanted:
        extra["company"] = await _company(db)

    key = scope_key_for(series.pattern, **extra)
    if key is not None:
        # One counter per company/project. The counter row holds nothing but its
        # number: prefix and pattern are read off `series` below, so re-editing the
        # pattern still governs every project.
        row = (await db.execute(
            select(DocSeries).where(
                DocSeries.doc_type == doc_type, DocSeries.scope_key == key,
            ).with_for_update()
        )).scalars().first()
        if row is None:
            row = DocSeries(doc_type=doc_type, fiscal_year=series.fiscal_year or fy,
                            prefix=series.prefix, pattern=series.pattern,
                            reset_policy=series.reset_policy, scope_key=key,
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

    # Rendered from `series`, never from the counter row: the admin edits one series
    # and every project it split into follows it.
    return render(series.pattern, series.prefix, series.fiscal_year or fy, n, **extra)
