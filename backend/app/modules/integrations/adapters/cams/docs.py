"""What B-CAMS is told: where to post, how to sign, and what each body looks like.

The mirror of `webhooks.connection_docs`, and for the same reason — the partner's
developer will never have an SCM login, so the details have to leave this screen as
text somebody can paste into an email. What makes such a document survive contact with
the second month is that nothing in it is written twice: `WRITES` below is the ONE
table of event -> path -> model, and `router.py` registers the five endpoints from it.
A URL in the docs is therefore a URL that exists, because the same row created both.

The samples are held to that too. `tests/test_cams.py` validates every one against the
model it documents, so a schema change that would have broken the example breaks the
suite instead of a partner's integration.
"""
from dataclasses import dataclass
from typing import Any, Callable

from app.modules.integrations.adapters.cams.enums import (
    MAX_EVENT_ID, SIGNATURE_ALGO, SIGNATURE_HEADER, EventType,
)
from app.modules.integrations.adapters.cams.schemas import (
    AckIn, ConsumptionIn, StockBalanceIn, StockTransferIn, WastageIn,
)


@dataclass(frozen=True)
class Write:
    """One inbound endpoint, described once and used three ways: to register the
    route, to count what a body carried, and to document itself."""
    event: str
    path: str
    label: str
    model: type
    #: How many rows this body carried — the number the receipt reports.
    count: Callable[[Any], int]
    #: Whether accepting it MOVES STOCK. Two of the five do, and a partner reading
    #: this needs to know which ones before they start replaying a batch.
    deducts: bool
    sample: dict


WRITES: tuple[Write, ...] = (
    Write(
        event=EventType.ACK.value,
        path="material-issue-ack",
        label="Issue acknowledged",
        model=AckIn,
        count=lambda p: len(p.items),
        deducts=False,
        sample={
            "event": EventType.ACK.value,
            "event_id": "cams-ack-2026-09-01-0001",
            "generated_at": "2026-09-01T06:30:00Z",
            "issue_number": "MI-2026-000418",
            "warehouse_id": 1549,
            "sac": "SAC-0207",
            "acknowledged_by_employee_code": "HR-EMP-17099",
            "acknowledged_at": "2026-09-01T06:28:11Z",
            "status": "partial",
            "items": [
                {
                    "item_code": "MED-GEN-ABC-XYZ-0001",
                    "batch_number": "B-2291",
                    "issued_qty": 100,
                    "received_qty": 96,
                    "shortage_qty": 4,
                    "damaged_qty": 0,
                    "remarks": "4 strips short on arrival",
                }
            ],
        },
    ),
    Write(
        event=EventType.CONSUMPTION.value,
        path="consumption",
        label="Consumption",
        model=ConsumptionIn,
        count=lambda p: len(p.records),
        deducts=True,
        sample={
            "event": EventType.CONSUMPTION.value,
            "event_id": "cams-cons-2026-09-01-0001",
            "generated_at": "2026-09-01T18:05:00Z",
            "scope": "partial",
            "consumption_date": "2026-09-01",
            "records": [
                {
                    "sac": "SAC-0207",
                    "warehouse_id": 1549,
                    "facility_name": "LIP KURNOOL-3",
                    "employee_code": "HR-EMP-17099",
                    "item_code": "MED-GEN-ABC-XYZ-0001",
                    "batch_number": "B-2291",
                    "uom": "NOS",
                    "opening_qty": 96,
                    "received_qty": 0,
                    "consumed_qty": 12,
                    "wastage_qty": 0,
                    "returned_qty": 0,
                    "closing_qty": 84,
                    "tests_done": 12,
                }
            ],
        },
    ),
    Write(
        event=EventType.STOCK_BALANCE.value,
        path="stock-balance",
        label="Field stock balance",
        model=StockBalanceIn,
        count=lambda p: sum(len(f.items) for f in p.facilities),
        deducts=False,
        sample={
            "event": EventType.STOCK_BALANCE.value,
            "event_id": "cams-bal-2026-09-01-0001",
            "generated_at": "2026-09-01T18:45:00Z",
            "scope": "full",
            "basis": "eod_closing",
            "facilities": [
                {
                    "sac": "SAC-0207",
                    "warehouse_id": 1549,
                    "facility_name": "LIP KURNOOL-3",
                    "tier": "LIP",
                    "as_of": "2026-09-01",
                    "items": [
                        {
                            "item_code": "MED-GEN-ABC-XYZ-0001",
                            "batch_number": "B-2291",
                            "uom": "NOS",
                            "closing_qty": 84,
                        }
                    ],
                }
            ],
        },
    ),
    Write(
        event=EventType.STOCK_TRANSFER.value,
        path="stock-transfer",
        label="Stock transfer",
        model=StockTransferIn,
        count=lambda p: len(p.items),
        deducts=False,
        sample={
            "event": EventType.STOCK_TRANSFER.value,
            "event_id": "cams-trf-2026-09-01-0001",
            "generated_at": "2026-09-01T11:20:00Z",
            "transfer_date": "2026-09-01",
            "reason": "Vehicle re-stocked from the LIP",
            "from": {"sac": "SAC-0207", "warehouse_id": 1549},
            "to": {"sac": "SAC-0207", "vehicle_number": "AP21TC4417"},
            "approved_by_employee_code": "HR-EMP-17099",
            "items": [
                {
                    "item_code": "MED-GEN-ABC-XYZ-0001",
                    "batch_number": "B-2291",
                    "qty": 20,
                    "uom": "NOS",
                }
            ],
        },
    ),
    Write(
        event=EventType.WASTAGE.value,
        path="wastage",
        label="Wastage",
        model=WastageIn,
        count=lambda p: len(p.records),
        deducts=True,
        sample={
            "event": EventType.WASTAGE.value,
            "event_id": "cams-wst-2026-09-01-0001",
            "generated_at": "2026-09-01T18:05:00Z",
            "wastage_date": "2026-09-01",
            "records": [
                {
                    "sac": "SAC-0207",
                    "warehouse_id": 1549,
                    "facility_name": "LIP KURNOOL-3",
                    "employee_code": "HR-EMP-17099",
                    "item_code": "MED-GEN-ABC-XYZ-0001",
                    "batch_number": "B-2291",
                    "uom": "NOS",
                    "wastage_qty": 2,
                    "reason": "Vial broken in handling",
                }
            ],
        },
    ),
)


def connection_docs(base_url: str = "", *, configured: bool = False,
                    feeds: tuple[str, ...] = ()) -> dict:
    """Everything B-CAMS needs in order to start, as one document.

    `base_url` comes from the request that asked, so the host in the document is the
    host the reader reached us on — the LAN address on a LAN, the public one from
    outside. Hardcoding it would put a developer's `localhost` in a partner's email.
    """
    base = base_url.rstrip("/")
    prefix = f"{base}/api/ext/v1/cams" if base else "/api/ext/v1/cams"
    return {
        "base_url": prefix,
        "configured": configured,
        "signature_header": SIGNATURE_HEADER,
        "headers": [
            {"name": "X-API-Key",
             "note": "The key issued for the B-CAMS application on the Applications "
                     "tab. Its scopes must be empty or include `cams`."},
            {"name": SIGNATURE_HEADER,
             "note": f"{SIGNATURE_ALGO}=<HMAC-{SIGNATURE_ALGO.upper()} of the RAW "
                     f"request body, keyed with the shared secret>"},
            {"name": "Content-Type", "note": "application/json"},
        ],
        "signing_note": (
            "The HMAC input is the RAW bytes of the body, before any re-serialising, "
            "and there is no timestamp in it — unlike the webhook endpoints. Signing "
            "a re-encoded copy produces a signature for a document that was never "
            "sent, and it will be refused."),
        "envelope": [
            {"field": "event",
             "note": "One of the five below. Anything else is refused, and the "
                     "refusal names what is accepted."},
            {"field": "event_id",
             "note": f"Unique per push, 8 to {MAX_EVENT_ID} characters of "
                     f"A-Z a-z 0-9 . _ : and -. A repeat is answered `duplicate` "
                     f"and changes nothing, so retrying is always safe."},
            {"field": "generated_at",
             "note": "When B-CAMS produced the body. Optional; recorded as sent."},
            {"field": "scope",
             "note": "`partial` for a single facility seconds after the change, "
                     "`full` for the nightly sweep. Recorded, never enforced."},
        ],
        "writes": [
            {
                "event": write.event,
                "label": write.label,
                "url": f"{prefix}/{write.path}",
                "method": "POST",
                "deducts_stock": write.deducts,
                "effect": ("Deducts what the field used, through the same movement "
                           "path as every other issue." if write.deducts
                           else "Recorded only. Nothing moves."),
                "sample": write.sample,
            }
            for write in WRITES
        ],
        # The read side is listed, not described: fourteen feeds with their own
        # filters are B-CAMS' own §1, and repeating every query parameter here is
        # exactly the second copy this module exists to avoid.
        "feeds": [f"{prefix}/{path}" for path in feeds],
        "answers": [
            {"status": 200, "note": "Accepted. The body is the receipt, and where the "
                                    "event moves stock it carries what posted and "
                                    "what did not."},
            {"status": 200, "note": "Already seen — a repeated `event_id`. Nothing "
                                    "changed."},
            {"status": 401, "note": "Bad or missing API key, missing signature, or a "
                                    "signature that does not match the body."},
            {"status": 403, "note": "The key is valid but carries no `cams` scope."},
            {"status": 422, "note": "An unknown event, a body that is not a JSON "
                                    "object, or a field that failed validation. The "
                                    "answer names the field."},
        ],
    }
