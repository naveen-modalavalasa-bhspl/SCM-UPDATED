"""How much one request may carry. One place, so every module agrees.

Added 2026-09-03, after a resilience review traced a crash to a quantity of 200,000-
300,000 on a single line. The quantity itself is harmless: it is one `NUMERIC(16,3)`
column and one short write. What is not harmless is what happens downstream when that
line is serial-tracked — `_claim_units`, `_land_units`, `_ship_units` and
`_mark_serials` work on individual unit records, so one document can try to lock and
update hundreds of thousands of rows inside a single HTTP request, hold the
transaction open, exhaust the connection pool and run past nginx's 60-second read
timeout. The user sees a dead screen and has no way to tell whether it worked.

Ninety-five request-body list fields had no maximum length at all. A cap is not a
substitute for moving that work to a job queue — it is what stops the request being
accepted in the first place, and it is a day's work rather than an architecture.

**These are REQUEST limits, not business limits.** A site that genuinely needs to
issue 50,000 serials does it by uploading a manifest and letting a worker process it
in chunks, not by posting 50,000 strings in one JSON body. Raising a number here to
make a screen work is almost always the wrong fix.

The serial caps were raised to 10,000 on 2026-09-09, which is the one time that was
not true — and only because the paths underneath were rewritten to match in the same
change. Raising a cap is the LAST step of that work, never the first: the number here
is a statement about what the write path can actually absorb inside one request, so
moving it without measuring that path is how the timeout comes back.
"""
from typing import Annotated

from pydantic import AfterValidator, Field

#: Lines on one document — an indent, a PO, a GRN, an issue, a consignment.
#: Comfortably above any real document; far below anything that threatens a request.
MAX_DOCUMENT_LINES = 500

#: Ids selected in one batch action: indents in a monthly cycle, allocations approved
#: together, requisitions consolidated, vendors on an RFQ. The approvals bulk route
#: already capped itself at 200 and was the only one that did.
MAX_BATCH_IDS = 500

#: Whole documents submitted inside ONE request (AllocationBatchIn.allocations). Lower
#: than MAX_BATCH_IDS on purpose: each of these carries its own lines, so the real cost
#: is this number multiplied by MAX_DOCUMENT_LINES.
MAX_BATCH_DOCUMENTS = 200

#: Serial / IMEI strings on a single line.
#:
#: Raised 1,000 -> 10,000 (2026-09-09) for the GRN, where a single carton delivery of
#: handsets genuinely carries that many scans and splitting it across documents would
#: be inventing paperwork the delivery does not have. What makes it affordable is not
#: the number: it is that the unit writes underneath became SET-BASED in the same
#: change. `_clear_issue_serial_reservations`, `_reserve_issue_serials`, `_mark_serials`
#: and `_claim_units` used to assign to `row.remarks` / `row.status` in a Python loop,
#: which is one UPDATE per unit on flush — 10,000 round trips inside one transaction.
#: They now issue chunked `UPDATE ... WHERE id IN (...)` statements instead, so the
#: cost of a document is measured in statements, not in units.
#:
#: Do NOT raise this further without doing the same work again for whatever path the
#: new number reaches. The module docstring's warning stands: the fix for 50,000 is the
#: job queue, not another zero here.
MAX_SERIALS_PER_LINE = 10_000

#: Serial / IMEI strings across the WHOLE request, counted by `assert_serial_budget`.
#: The per-line cap alone is not enough — 500 lines x 10,000 serials is five million
#: units in one transaction, which is the exact failure this module exists to stop.
#:
#: Equal to MAX_SERIALS_PER_LINE on purpose: one line may carry the whole budget, and
#: a document that spreads 10,000 units over several lines costs the same as one that
#: puts them all on one. It is the TOTAL that decides how long the request runs.
MAX_SERIALS_PER_REQUEST = 10_000

#: Units that may be individually CODED in one request.
#:
#: This is a different guard from the list caps above, and it is the one that catches
#: the case they miss. `warehouse._place_unit_codes` mints ONE `whs_serial_numbers`
#: row per whole unit of a countable, code-tracked item at a warehouse -- driven by
#: the QUANTITY, not by any list the caller sent. A receipt or putaway of 300,000
#: units therefore builds 300,000 ORM objects, inserts them, re-reads them, names
#: them and updates them, inside one request and one transaction.
#:
#: A large quantity is perfectly normal and stays allowed. What is refused is
#: individually coding that many units in one press: the codes are labels on stock,
#: and stock moves on quantity. Split the receipt, or code the units once the durable
#: job queue exists to do it in chunks.
MAX_UNITS_PER_CODE_MINT = 10_000

#: How many unit rows are built and flushed at a time under that ceiling. Bounds peak
#: memory: without it every row of the request is held in one Python list before the
#: first flush.
UNIT_MINT_CHUNK = 1_000

#: Configuration collections: workflow stages, ladder rungs, rule conditions and
#: actions, inspection parameters, endpoint field lists. Small by nature; a request
#: carrying hundreds is a mistake, not a large site.
MAX_CONFIG_ENTRIES = 100

#: The three unit caps as the RUNNING process applies them (2026-10-08). Set on
#: Settings > Company > Warehouse (`warehouse.max_*` in sys_settings) and loaded by
#: `platform.settings.service.load_unit_limits` at startup and on every settings save.
#: 0 means NO LIMIT, and that is the default: the business asked for every count to
#: go through. The constants above stay as the recommended values shown on screen.
#: Per process: another worker picks a change up on its next restart or settings save.
RUNTIME_LIMITS: dict[str, int] = {
    "max_serials_per_line": 0,
    "max_serials_per_request": 0,
    "max_units_per_code_mint": 0,
}


def set_runtime_limits(**values: int | None) -> None:
    for key, value in values.items():
        if key in RUNTIME_LIMITS:
            RUNTIME_LIMITS[key] = max(int(value or 0), 0)


def limit(key: str) -> int:
    """The live cap, or 0 for none."""
    return RUNTIME_LIMITS[key]


def _check_serial_line(values: list[str] | None) -> list[str] | None:
    cap = limit("max_serials_per_line")
    if cap and values and len(values) > cap:
        raise ValueError(
            f"This line names {len(values)} units, and one line may carry at most "
            f"{cap} (Settings > Company > Warehouse limits)."
        )
    return values


#: The shorthand used across the schemas.
DocumentLines = Field(max_length=MAX_DOCUMENT_LINES)
BatchIds = Field(max_length=MAX_BATCH_IDS)
BatchDocuments = Field(max_length=MAX_BATCH_DOCUMENTS)
SerialList = AfterValidator(_check_serial_line)
ConfigEntries = Field(max_length=MAX_CONFIG_ENTRIES)


def assert_serial_budget(model, *collections: str) -> None:
    """Refuse a request that names more physical UNITS than one worker's worth.

    Called from a model validator on the request schemas that nest serial lines, e.g.

        @model_validator(mode="after")
        def _serial_budget(self):
            assert_serial_budget(self, "items")
            return self

    Counted per line as `max(serials, IMEIs)`, NOT as their sum (fixed 2026-09-09).
    A handset carries both numbers — the same unit, labelled twice — so a GRN for
    10,000 of them sends 10,000 serials and 10,000 IMEIs and was being charged 20,000
    against the budget. It was refused for being twice the size it is, and the message
    told the storekeeper to split a delivery that was already inside the limit.

    The sum was never the quantity this limit is about. What costs is the UNIT: one
    `whs_serial_numbers` row, claimed, locked and stamped by `_claim_units`,
    `_land_units`, `_ship_units` and `_mark_serials`. Two identifiers for one unit is
    one row, so `max` is the count of things the request will actually do work on.
    A line naming 900 serials and 20 IMEIs is 900 units, not 920.

    Raises `ValueError`, which Pydantic turns into the 422 every other validation
    failure uses — the caller gets a sentence naming the limit, not a timeout.
    """
    total = 0
    for name in collections:
        for line in (getattr(model, name, None) or []):
            total += max(
                len(getattr(line, field, None) or [])
                for field in ("serial_numbers", "imei_numbers")
            )
    cap = limit("max_serials_per_request")
    if cap and total > cap:
        raise ValueError(
            f"This document names {total} units, and a single request may carry at "
            f"most {cap}. Split it across documents, or upload a "
            "manifest so it can be processed in the background."
        )


__all__ = [
    "MAX_DOCUMENT_LINES", "MAX_BATCH_IDS", "MAX_BATCH_DOCUMENTS",
    "MAX_SERIALS_PER_LINE", "MAX_SERIALS_PER_REQUEST", "MAX_CONFIG_ENTRIES",
    "MAX_UNITS_PER_CODE_MINT", "UNIT_MINT_CHUNK",
    "DocumentLines", "BatchIds", "BatchDocuments", "SerialList", "ConfigEntries",
    "assert_serial_budget", "Annotated",
    "RUNTIME_LIMITS", "set_runtime_limits", "limit",
]


#: Entries in one pack breakdown ("1 Carton + 10 Box + 20 Strip" is three). A
#: hierarchy rarely has more than five levels; twelve leaves room and no more.
MAX_PACK_ENTRIES = 12

#: Physical packs (`whs_handling_units` rows) one putaway, repack or issue may create.
#: Each pack is a row and, for a code-tracked item, a minted code; a breakdown of
#: "40,000 Strip" is the same flood of rows the serial budget exists to stop. Put
#: away in a bigger pack level, or in several presses.
MAX_PACKS_PER_REQUEST = 5_000
