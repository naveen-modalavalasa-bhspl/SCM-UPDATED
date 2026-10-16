"""Three-letter master codes (2026-10-01).

Fourteen masters (categories, generic names, brands, manufacturers, item classes and
subclasses, dosage forms, attributes, specs, features, packaging, UOM, UOM types and
BOMs) carry a code of exactly three letters: ERB for Erba, TBM for Transasia
Bio-Medicals. HSN, vendors, warehouses and bins are deliberately not among them —
each has its own fixed shape.

The rule bites on EVERY save, new or old: a code that is not three letters is
refused wherever it is written. The legacy rows that predated the rule were
recoded to three letters up front (`scripts/recode_master_codes.py`), with every
live snapshot following by integer id — so there is nothing left to grandfather,
and no edit can reintroduce a long code through any door.

A person never has to invent one. A blank code is filled from the name — the first
letter of each word, or the first three letters of a single word — and when that is
taken, the next free combination is offered. Typing one by hand still works.
"""
from __future__ import annotations

import itertools
import re
from string import ascii_uppercase
from typing import Any, Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationError

SHORT_CODE_PATHS = frozenset({
    "item-categories", "general-names", "brands", "manufacturers", "item-classes",
    "item-sub-classes", "dosage-forms", "attributes", "specs", "features",
    "packaging", "uom", "uom-classes", "boms", "vendor-categories",
})
SHORT_CODE = re.compile(r"[A-Z]{3}")
# Words that make a poor initial: "Bottle of 10" is BOT, not BOO.
SKIP = {"OF", "AND", "THE", "FOR", "WITH", "LTD", "PVT", "INC", "CO", "KIT"}


def applies(defn: Any) -> bool:
    return getattr(defn, "path", None) in SHORT_CODE_PATHS


def candidates(name: str) -> Iterable[str]:
    """Codes to try for a name, best first, every one of them three letters."""
    words = re.findall(r"[A-Z]+", (name or "").upper())
    meaningful = [w for w in words if w not in SKIP] or words
    seen: set[str] = set()

    def fresh(code: str):
        if len(code) == 3 and code not in seen:
            seen.add(code)
            return code
        return None

    firsts: list[str] = []
    if len(meaningful) >= 3:
        firsts.append("".join(w[0] for w in meaningful[:3]))
    if len(meaningful) == 2:
        a, b = meaningful
        firsts += [a[0] + b[:2], a[:2] + b[0]]
    if meaningful:
        firsts.append(meaningful[0][:3])
    for code in firsts:
        if (c := fresh(code)) is not None:
            yield c

    # Then the first letter with any two later letters of the name, in order.
    letters = "".join(meaningful)
    if letters:
        for i, j in itertools.combinations(range(1, len(letters)), 2):
            if (c := fresh(letters[0] + letters[i] + letters[j])) is not None:
                yield c
        head = letters[0]
    else:
        head = "X"
    # And last, anything at all starting with that letter.
    for b, c3 in itertools.product(ascii_uppercase, repeat=2):
        if (c := fresh(head + b + c3)) is not None:
            yield c


async def taken_codes(db: AsyncSession, model: type) -> set[str]:
    return {(c or "").upper() for (c,) in (await db.execute(select(model.code))).all()}


async def suggest(db: AsyncSession, model: type, name: str,
                  also_taken: set[str] | None = None) -> str:
    taken = (await taken_codes(db, model)) | (also_taken or set())
    for code in candidates(name):
        if code not in taken:
            return code
    raise ValidationError("Code: every three-letter code for this name is taken. "
                          "Type one by hand.")


async def enforce(db: AsyncSession, defn: Any, row: Any, data: Any) -> None:
    """Upper-case the code, fill a blank one from the name, and refuse anything
    that is not three letters — on every save, new or old. There are no legacy
    codes left to grandfather (see the module docstring), so no pass-through."""
    if not applies(defn) or not hasattr(data, "code"):
        return
    code = (getattr(data, "code", None) or "").strip().upper()
    if not code:
        code = await suggest(db, defn.model, getattr(data, "name", "") or "")
    if not SHORT_CODE.fullmatch(code):
        hint = ""
        try:
            hint = f", e.g. {await suggest(db, defn.model, getattr(data, 'name', '') or '')}"
        except ValidationError:
            pass
        raise ValidationError(
            f"Code “{code}” must be exactly 3 letters (A–Z){hint}. "
            "Leave it blank to have one made from the name.")
    data.code = code


async def fill_and_check(defn: Any, db: AsyncSession,
                   parsed: list[dict]) -> list[tuple[int, str]]:
    """For a bulk import: give each NEW row with a blank code one made from its name,
    and report ANY code that is not three letters — in the review, so it is fixed
    before Save rather than refused by it. Returns (sheet row, message)."""
    if not applies(defn):
        return []
    taken = await taken_codes(db, defn.model)
    problems: list[tuple[int, str]] = []
    for record in parsed:
        line = int(record.get("__row__") or 0)
        code = str(record.get("code") or "").strip().upper()
        if record.get("id") is None and not code and record.get("name"):
            for candidate in candidates(str(record["name"])):
                if candidate not in taken:
                    record["code"] = code = candidate
                    break
        if code:
            record["code"] = code
            taken.add(code)
            if not SHORT_CODE.fullmatch(code):
                problems.append((line, f"“{code}” must be exactly 3 letters (A–Z). "
                                       "Clear the cell to have one made from the name."))
    return problems

