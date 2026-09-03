"""The five inbound payloads of §4, and the console shapes that show what arrived.

Validated strictly: a field-consumption row that fails validation is refused with a
422 so B-CAMS retries it, rather than being stored half-read and quietly forgotten.
`extra="allow"` on the payload bodies is deliberate — B-CAMS adding a field must not
start rejecting their whole nightly batch.
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated

from pydantic import (
    AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field, field_validator,
    model_validator,
)

from app.modules.integrations.adapters.cams.enums import MAX_EVENT_ID, AckStatus, EventType
from app.shared.time import to_ist
from app.shared.limits import (  # request-size guards, see the module
    MAX_DOCUMENT_LINES,
)

# An event_id is a filename in all but name — it becomes part of a `sys_settings` key.
EVENT_ID_PATTERN = r"^[A-Za-z0-9._:-]{8,80}$"


def _as_day(value):
    """A day, however B-CAMS spelled it.

    Since their move to 60-second pushes, a date field can arrive stamped with the
    moment of the movement (`as_of: "2026-08-14T06:52:20"`) while the nightly snapshot
    still sends a plain `2026-08-14`. Pydantic refuses the first for a `date` field
    ("Datetimes provided to dates should have zero time"), which would 422 every
    real-time push. Both spellings name the same day, so the timestamp is reduced to
    it — in IST, because a UTC-stamped evening is already tomorrow here.

    Anything unparseable is handed back untouched, so pydantic reports it in its own
    words rather than this helper inventing a message.
    """
    if isinstance(value, datetime):
        return to_ist(value).date()
    if isinstance(value, str) and len(value.strip()) > 10:
        try:
            stamp = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return value
        return to_ist(stamp).date()
    return value


#: A date field that also accepts the timestamp form of the same day.
Day = Annotated[date, BeforeValidator(_as_day)]

#: A timestamp normalised to naive IST, the one clock the rest of SCM stores
#: (`shared/time.py`). B-CAMS stamps `generated_at` in UTC, so without this the
#: receipt would carry the single offset-aware value in `sys_settings`.
Stamp = Annotated[datetime, AfterValidator(to_ist)]


class _Payload(BaseModel):
    """Everything the five events share: who fired it, when, and its identity."""
    model_config = ConfigDict(extra="allow")

    event: str
    event_id: str = Field(pattern=EVENT_ID_PATTERN, max_length=MAX_EVENT_ID)
    generated_at: Stamp | None = None
    # `partial` (one facility, seconds after the change) or `full` (the nightly sweep).
    # Declared but not constrained: a scope word SCM has not heard of is a thing to
    # record, never a reason to refuse the batch behind it.
    scope: str | None = Field(default=None, max_length=30)

    @field_validator("event")
    @classmethod
    def _known(cls, value: str) -> str:
        known = {e.value for e in EventType}
        if value not in known:
            raise ValueError(f"unknown event; expected one of {', '.join(sorted(known))}")
        return value


# --------------------------------------------------------------------------- #
# B4 — receipt acknowledgement
# --------------------------------------------------------------------------- #

class AckLine(BaseModel):
    model_config = ConfigDict(extra="allow")
    item_id: int | None = None
    item_code: str | None = None
    batch_number: str | None = None
    issued_qty: Decimal = Decimal(0)
    received_qty: Decimal = Decimal(0)
    shortage_qty: Decimal = Decimal(0)
    damaged_qty: Decimal = Decimal(0)
    remarks: str | None = Field(default=None, max_length=500)


class AckIn(_Payload):
    issue_id: int | None = None
    issue_number: str | None = Field(default=None, max_length=50)
    warehouse_id: int | None = None
    sac: str | None = Field(default=None, max_length=50)
    acknowledged_by_employee_code: str | None = Field(default=None, max_length=50)
    acknowledged_at: Stamp | None = None
    status: AckStatus
    items: list[AckLine] = Field(default_factory=list, max_length=MAX_DOCUMENT_LINES)

    @model_validator(mode="after")
    def _identified(self):
        # One of the two has to be there or the acknowledgement points at nothing.
        # Checked on the whole model, not on one field: a field validator never runs
        # for a key the payload simply omitted.
        if not self.issue_id and not self.issue_number:
            raise ValueError("issue_id or issue_number is required")
        return self


# --------------------------------------------------------------------------- #
# B2 — daily consumption
# --------------------------------------------------------------------------- #

class ConsumptionLine(BaseModel):
    model_config = ConfigDict(extra="allow")
    sac: str | None = None
    warehouse_id: int | None = None
    facility_name: str | None = None
    vehicle_number: str | None = None
    employee_code: str | None = None
    employee_name: str | None = None
    role: str | None = None
    item_code: str
    batch_number: str | None = None
    expiry_date: Day | None = None
    uom: str | None = None
    opening_qty: Decimal = Decimal(0)
    received_qty: Decimal = Decimal(0)
    consumed_qty: Decimal = Decimal(0)
    wastage_qty: Decimal = Decimal(0)
    returned_qty: Decimal = Decimal(0)
    closing_qty: Decimal = Decimal(0)
    rate: Decimal | None = None
    consumed_value: Decimal | None = None
    # Decimal, not int: B-CAMS sends this as a JSON float (`"tests_done": 0.0`), and an
    # int field 422s on any float that is not whole.
    tests_done: Decimal | None = None


class ConsumptionIn(_Payload):
    consumption_date: Day
    records: list[ConsumptionLine] = Field(min_length=1, max_length=MAX_DOCUMENT_LINES)


# --------------------------------------------------------------------------- #
# B1 — field stock balance
# --------------------------------------------------------------------------- #

class StockBatchLine(BaseModel):
    """One batch's slice of an item's on-hand quantity."""
    model_config = ConfigDict(extra="allow")
    batch_number: str | None = None
    expiry_date: Day | None = None
    qty: Decimal = Decimal(0)


class FacilityStockLine(BaseModel):
    model_config = ConfigDict(extra="allow")
    item_code: str
    item_name: str | None = None
    batch_number: str | None = None
    expiry_date: Day | None = None
    uom: str | None = None
    # `on_hand_qty` is the canonical live figure; `closing_qty` mirrors it on the
    # real-time push and carries the LT's declared close on the nightly one. Both are
    # kept as sent — which of the two a reader wants depends on `basis`, so collapsing
    # them here would destroy the reconciliation signal.
    on_hand_qty: Decimal | None = None
    closing_qty: Decimal = Decimal(0)
    # A slice of on_hand_qty each, not a second pile: lt_drawn + sk_held == on_hand.
    lt_drawn_qty: Decimal | None = None
    sk_held_qty: Decimal | None = None
    batches: list[StockBatchLine] = Field(default_factory=list)
    rate: Decimal | None = None
    value: Decimal | None = None


class FacilityStock(BaseModel):
    model_config = ConfigDict(extra="allow")
    sac: str | None = None
    hcm_office_id: int | None = None
    warehouse_id: int | None = None
    warehouse_code: str | None = None
    facility_name: str | None = None
    vehicle_number: str | None = None
    tier: str | None = Field(default=None, max_length=10)
    is_vehicle: bool | None = None
    # Stamped with the moment of the movement on a real-time push, a plain date on the
    # nightly snapshot. `Day` accepts both.
    as_of: Day | None = None
    items: list[FacilityStockLine] = Field(default_factory=list)


class StockBalanceIn(_Payload):
    source: str | None = None
    # `stock_balance` (live ledger on-hand) or `eod_closing` (the LT's declared close).
    # Two different numbers on one endpoint; SCM records which it got and never merges
    # them. Unconstrained for the same reason as `scope`.
    basis: str | None = Field(default=None, max_length=30)
    facilities: list[FacilityStock] = Field(min_length=1, max_length=MAX_DOCUMENT_LINES)


# --------------------------------------------------------------------------- #
# B3 — stock transfer / vehicle swap
# --------------------------------------------------------------------------- #

class TransferPoint(BaseModel):
    model_config = ConfigDict(extra="allow")
    sac: str | None = None
    warehouse_id: int | None = None
    vehicle_number: str | None = None


class TransferLine(BaseModel):
    model_config = ConfigDict(extra="allow")
    item_code: str
    batch_number: str | None = None
    qty: Decimal
    uom: str | None = None


class StockTransferIn(_Payload):
    transfer_date: Day | None = None
    reason: str | None = Field(default=None, max_length=200)
    from_: TransferPoint = Field(alias="from")
    to: TransferPoint
    approved_by_employee_code: str | None = None
    items: list[TransferLine] = Field(min_length=1, max_length=MAX_DOCUMENT_LINES)

    model_config = ConfigDict(extra="allow", populate_by_name=True)


# --------------------------------------------------------------------------- #
# U5 — wastage and expiry write-offs
# --------------------------------------------------------------------------- #
# Separate from consumption because `consumption.wastage_qty` carries the quantity but
# not the reason or the value, and a spoiled unit costs against a different head from a
# used one. The two feeds overlap by design: the same quantity appears as
# `wastage_qty` on the consumption record and as a row here.

class WastageLine(BaseModel):
    model_config = ConfigDict(extra="allow")
    sac: str | None = None
    warehouse_id: int | None = None
    facility_name: str | None = None
    vehicle_number: str | None = None
    employee_code: str | None = None
    employee_name: str | None = None
    item_code: str
    batch_number: str | None = None
    expiry_date: Day | None = None
    uom: str | None = None
    wastage_qty: Decimal
    reason: str | None = Field(default=None, max_length=200)
    remarks: str | None = Field(default=None, max_length=500)
    rate: Decimal | None = None
    wastage_value: Decimal | None = None


class WastageIn(_Payload):
    wastage_date: Day
    records: list[WastageLine] = Field(min_length=1, max_length=MAX_DOCUMENT_LINES)


# --------------------------------------------------------------------------- #
# Console — what SCM sees of what arrived
# --------------------------------------------------------------------------- #

class ReceiptOut(BaseModel):
    """One stored receipt. `payload` is present only when the body fitted the store."""
    event_id: str
    event: str
    received_at: str
    generated_at: str | None = None
    client_code: str | None = None
    rows: int = 0
    body_sha256: str | None = None
    payload: dict | None = None
    payload_truncated: bool = False


class SecretOut(BaseModel):
    """The rotate response. The only place the shared HMAC secret is ever readable."""
    shared_secret: str
    rotated_at: str
    note: str
