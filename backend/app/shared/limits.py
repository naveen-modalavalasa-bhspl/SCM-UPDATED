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
"""
from typing import Annotated

from pydantic import Field

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
MAX_SERIALS_PER_LINE = 1_000

#: Serial / IMEI strings across the WHOLE request, counted by `assert_serial_budget`.
#: The per-line cap alone is not enough — 500 lines x 1,000 serials is half a million
#: units in one transaction, which is the exact failure this module exists to stop.
MAX_SERIALS_PER_REQUEST = 5_000

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

#: The shorthand used across the schemas.
DocumentLines = Field(max_length=MAX_DOCUMENT_LINES)
BatchIds = Field(max_length=MAX_BATCH_IDS)
BatchDocuments = Field(max_length=MAX_BATCH_DOCUMENTS)
SerialList = Field(max_length=MAX_SERIALS_PER_LINE)
ConfigEntries = Field(max_length=MAX_CONFIG_ENTRIES)


def assert_serial_budget(model, *collections: str) -> None:
    """Refuse a request whose serial/IMEI lists add up to more than one worker's worth.

    Called from a model validator on the request schemas that nest serial lines, e.g.

        @model_validator(mode="after")
        def _serial_budget(self):
            assert_serial_budget(self, "items")
            return self

    Raises `ValueError`, which Pydantic turns into the 422 every other validation
    failure uses — the caller gets a sentence naming the limit, not a timeout.
    """
    total = 0
    for name in collections:
        for line in (getattr(model, name, None) or []):
            for field in ("serial_numbers", "imei_numbers"):
                total += len(getattr(line, field, None) or [])
    if total > MAX_SERIALS_PER_REQUEST:
        raise ValueError(
            f"This document carries {total} serial/IMEI numbers, and a single request "
            f"may carry at most {MAX_SERIALS_PER_REQUEST}. Split it across documents, "
            "or upload a manifest so it can be processed in the background."
        )


__all__ = [
    "MAX_DOCUMENT_LINES", "MAX_BATCH_IDS", "MAX_BATCH_DOCUMENTS",
    "MAX_SERIALS_PER_LINE", "MAX_SERIALS_PER_REQUEST", "MAX_CONFIG_ENTRIES",
    "MAX_UNITS_PER_CODE_MINT", "UNIT_MINT_CHUNK",
    "DocumentLines", "BatchIds", "BatchDocuments", "SerialList", "ConfigEntries",
    "assert_serial_budget", "Annotated",
]
