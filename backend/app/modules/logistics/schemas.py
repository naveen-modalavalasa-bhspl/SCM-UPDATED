from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


class GRNLineIn(BaseModel):
    po_item_id: int | None = None
    item_id: int
    received_quantity: float = Field(ge=0)
    accepted_quantity: float = Field(ge=0)
    rejected_quantity: float = Field(ge=0, default=0)
    batch_no: str | None = None


class GRNCreate(BaseModel):
    invoice_no: str | None = None
    invoice_date: date | None = None
    vehicle_no: str | None = None
    transporter: str | None = None
    remarks: str | None = None
    lines: list[GRNLineIn]


class GRNItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    ordered_quantity: float
    received_quantity: float
    accepted_quantity: float
    rejected_quantity: float
    batch_no: str | None = None


class GRNOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    grn_no: str
    grn_date: date | None = None
    po_id: int | None = None
    po_no: str | None = None
    vendor_name: str | None = None
    facility_id: int | None = None
    facility_name: str | None = None
    invoice_no: str | None = None
    vehicle_no: str | None = None
    status: str
    total_items: int
    created_at: datetime
    items: list[GRNItemOut] = []


class GRNListRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    grn_no: str
    po_no: str | None = None
    vendor_name: str | None = None
    status: str
    created_at: datetime


class IssueLineIn(BaseModel):
    item_id: int
    quantity: float = Field(gt=0)
    batch_no: str | None = None


class IssueCreate(BaseModel):
    indent_id: int | None = None
    facility_id: int
    department_id: int | None = None
    remarks: str | None = None
    lines: list[IssueLineIn]


class IssueOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    issue_no: str
    facility_id: int | None = None
    department_id: int | None = None
    status: str
    created_at: datetime


# --------------------------------------------------------------------------- #
#  Transport requests
# --------------------------------------------------------------------------- #
# Mode-specific fields are all optional here and checked in the service against
# enums.MODE_RULES. Making them conditionally required in Pydantic would put the same
# rule in two places, and the one the frontend reads is the service's — it serves the
# rule table to the form at /api/transport/modes.

class TRLineIn(BaseModel):
    item_id: int | None = None
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    quantity: float = Field(ge=0, default=0)
    package_count: int = Field(ge=0, default=0)
    package_type: str | None = None
    weight_kg: float | None = Field(ge=0, default=None)
    length_cm: float | None = Field(ge=0, default=None)
    width_cm: float | None = Field(ge=0, default=None)
    height_cm: float | None = Field(ge=0, default=None)
    is_fragile: bool = False
    remarks: str | None = None


class TRCreate(BaseModel):
    mode: str
    tr_date: date | None = None
    source_type: str | None = None
    source_id: int | None = None
    source_no: str | None = None
    issue_id: int | None = None
    dispatch_id: int | None = None
    indent_id: int | None = None
    indent_no: str | None = None
    from_warehouse_id: int | None = None
    from_warehouse_name: str | None = None
    to_location_name: str | None = None
    delivery_address: str | None = None
    contact_person: str | None = None
    contact_phone: str | None = None
    distance_km: float | None = Field(ge=0, default=None)
    project_id: int | None = None
    project_name: str | None = None
    expected_delivery: date | None = None
    remarks: str | None = None

    carrier_id: int | None = None
    vehicle_number: str | None = None
    driver_name: str | None = None
    driver_phone: str | None = None
    trip_reference: str | None = None
    handed_over_by_name: str | None = None
    received_by_name: str | None = None

    lines: list[TRLineIn] = []


class TRUpdate(TRCreate):
    """Same body; a separate name so the route reads as an edit."""
    mode: str | None = None


class TRItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    line_no: int
    item_id: int | None = None
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    quantity: float
    delivered_qty: float
    package_count: int
    package_type: str | None = None
    weight_kg: float | None = None
    length_cm: float | None = None
    width_cm: float | None = None
    height_cm: float | None = None
    is_fragile: bool
    remarks: str | None = None


class QuoteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    carrier_id: int
    carrier_name: str | None = None
    status: str
    freight_amount: float | None = None
    other_charges: float
    tax_percent: float | None = None
    transit_days: int | None = None
    valid_until: date | None = None
    vehicle_type: str | None = None
    remarks: str | None = None
    invited_at: datetime | None = None
    submitted_at: datetime | None = None
    score: float | None = None
    rank: int | None = None


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    event_type: str
    event_at: datetime
    location_name: str | None = None
    description: str | None = None
    is_exception: bool
    affected_item_name: str | None = None
    affected_qty: float | None = None
    claim_amount: float | None = None
    resolution: str | None = None
    resolved_at: datetime | None = None
    resolved_by_name: str | None = None
    recorded_by_name: str | None = None


class TROut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    tr_no: str
    tr_date: date | None = None
    mode: str
    status: str
    source_type: str | None = None
    source_id: int | None = None
    source_no: str | None = None
    issue_id: int | None = None
    dispatch_id: int | None = None
    indent_id: int | None = None
    indent_no: str | None = None
    from_warehouse_id: int | None = None
    from_warehouse_name: str | None = None
    to_location_name: str | None = None
    delivery_address: str | None = None
    contact_person: str | None = None
    contact_phone: str | None = None
    distance_km: float | None = None
    project_id: int | None = None
    project_name: str | None = None
    total_items: int
    total_qty: float
    total_weight_kg: float
    total_volume_cbm: float
    total_packages: int
    carrier_id: int | None = None
    carrier_name: str | None = None
    evaluation_method: str | None = None
    freight_amount: float | None = None
    awarded_by_name: str | None = None
    awarded_at: datetime | None = None
    vehicle_number: str | None = None
    driver_name: str | None = None
    driver_phone: str | None = None
    trip_reference: str | None = None
    handed_over_by_name: str | None = None
    received_by_name: str | None = None
    lr_no: str | None = None
    docket_no: str | None = None
    tracking_url: str | None = None
    eway_bill_no: str | None = None
    expected_delivery: date | None = None
    dispatched_at: datetime | None = None
    delivered_at: datetime | None = None
    delivered_to_name: str | None = None
    pod_url: str | None = None
    tracking_shared_at: datetime | None = None
    remarks: str | None = None
    requested_by_name: str | None = None
    created_at: datetime
    items: list[TRItemOut] = []
    quotes: list[QuoteOut] = []
    events: list[EventOut] = []


class TRListRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    tr_no: str
    tr_date: date | None = None
    mode: str
    status: str
    indent_no: str | None = None
    from_warehouse_name: str | None = None
    to_location_name: str | None = None
    carrier_name: str | None = None
    freight_amount: float | None = None
    total_packages: int
    total_weight_kg: float
    lr_no: str | None = None
    docket_no: str | None = None
    expected_delivery: date | None = None
    created_at: datetime


class ActionIn(BaseModel):
    comments: str = ""


class InviteIn(BaseModel):
    carrier_ids: list[int] = Field(min_length=1)
    evaluation_method: str | None = None


class QuoteIn(BaseModel):
    """A quote typed in by the logistics desk, or submitted by the carrier itself."""
    freight_amount: float = Field(ge=0)
    other_charges: float = Field(ge=0, default=0)
    tax_percent: float | None = Field(ge=0, default=None)
    transit_days: int | None = Field(ge=0, default=None)
    valid_until: date | None = None
    vehicle_type: str | None = None
    remarks: str | None = None


class AwardIn(BaseModel):
    quote_id: int
    comments: str = ""


class ProviderIn(BaseModel):
    """Fixing the provider on a mode that has no quoting round."""
    carrier_id: int | None = None
    freight_amount: float | None = Field(ge=0, default=None)
    vehicle_number: str | None = None
    driver_name: str | None = None
    driver_phone: str | None = None
    trip_reference: str | None = None
    handed_over_by_name: str | None = None
    received_by_name: str | None = None


class DispatchIn(BaseModel):
    lr_no: str | None = None
    docket_no: str | None = None
    tracking_url: str | None = None
    eway_bill_no: str | None = None
    expected_delivery: date | None = None
    remarks: str | None = None


class EventIn(BaseModel):
    event_type: str
    event_at: datetime | None = None
    location_name: str | None = None
    description: str | None = None
    affected_item_name: str | None = None
    affected_qty: float | None = Field(ge=0, default=None)
    claim_amount: float | None = Field(ge=0, default=None)


class ResolveIn(BaseModel):
    resolution: str = Field(min_length=1)


class DeliverIn(BaseModel):
    delivered_at: datetime | None = None
    delivered_to_name: str | None = None
    pod_url: str | None = None
    remarks: str | None = None


class Option(BaseModel):
    id: int
    code: str | None = None
    name: str
