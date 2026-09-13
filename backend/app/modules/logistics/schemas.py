from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field
from app.shared.limits import (  # request-size guards, see the module
    Annotated, BatchIds, DocumentLines, MAX_BATCH_IDS,
)


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
    lines: Annotated[list[GRNLineIn], DocumentLines]


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
    lines: Annotated[list[IssueLineIn], DocumentLines]


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
    #: ROAD / RAIL / AIR / SEA — what it travels ON, a separate question from the
    #: arrangement above. Optional so an older caller still works: the service falls
    #: back to ROAD, which is what an unstated leg has always been. Validated against
    #: the mode, because a hand-over cannot be made by sea.
    carriage_mode: str | None = None
    tr_date: date | None = None
    source_type: str | None = None
    source_id: int | None = None
    source_no: str | None = None
    issue_id: int | None = None
    #: The warehouse consignment being moved, and its number snapshotted beside it.
    dispatch_id: int | None = None
    consignment_no: str | None = None
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
    #: Written at the moment the desk decides the leg, when the gate pass is already
    #: in hand. `dispatch_tr` overwrites it if a different one is quoted when the
    #: goods actually leave — the last word is the one the security desk wrote.
    gate_pass_no: str | None = None
    #: The tracking handles, when the desk already holds them at booking time — a
    #: courier docket is written on the slip at the counter. Optional everywhere:
    #: a tendered job has no number until a carrier has been awarded and answered.
    lr_no: str | None = None
    docket_no: str | None = None
    tracking_url: str | None = None
    eway_bill_no: str | None = None

    carrier_id: int | None = None
    #: Used only when Company Settings enables manual courier dispatch.  It is kept
    #: separate from `carrier_id`: a typed counter name is not a vendor-master record
    #: and must never grant a carrier portal access.
    manual_courier_name: str | None = Field(default=None, max_length=200)
    carrier_reference: str | None = None
    vehicle_number: str | None = None
    driver_name: str | None = None
    driver_phone: str | None = None
    driver_licence_no: str | None = None
    trip_reference: str | None = None
    handed_over_by_name: str | None = None
    handed_over_employee_id: str | None = None
    handed_over_aadhaar: str | None = None
    handed_over_phone: str | None = None

    lines: Annotated[list[TRLineIn], DocumentLines] = []


class TRUpdate(TRCreate):
    """Same body; a separate name so the route reads as an edit."""
    mode: str | None = None
    #: `None` means the provider picker was not part of this edit. An empty list is
    #: intentional for a mode that does not travel with an external provider.
    carrier_ids: Annotated[list[int], BatchIds] | None = None
    evaluation_method: str | None = None


class QuickDispatchIn(TRCreate):
    """Dispatching a packed consignment in one press.

    The same body a transport request is created from, plus the freight the desk has
    already agreed on a mode that is not tendered (a courier's published rate). On
    THIRD_PARTY there is no amount to send: the carriers named here are the providers
    being ASKED, and the prices come back from them.
    """
    freight_amount: float | None = Field(ge=0, default=None)
    #: Every provider this consignment is being sent to for a price. A tender is a
    #: question asked of MORE THAN ONE carrier — asking one and calling the answer a
    #: comparison is the thing the three-quote norm exists to prevent — so the plural
    #: is the real field and `carrier_id` above is the singular case of it, kept for
    #: the modes that book one provider outright (a courier's published rate).
    carrier_ids: Annotated[list[int], BatchIds] = []
    #: Which lens the comparison ranks under. Chosen when the tender goes out rather
    #: than when it comes back, so the rule the quotes are judged by is fixed before
    #: anybody has seen a price.
    evaluation_method: str | None = None
    #: Release it on the same press. On a settled mode the gate pass, the docket and
    #: the driver are all on this form, so "confirm dispatch" IS the load leaving and
    #: the shipment goes straight to IN_TRANSIT — which is what puts it in front of
    #: the receiving site to acknowledge. Ignored on a tendered mode: there is no
    #: carrier to leave with until the award is made.
    release_now: bool = False


class AcceptQuoteIn(BaseModel):
    """Accepting the provider's price. `quote_id` is optional — with one price on the
    table, which one is meant is not a question worth asking."""
    quote_id: int | None = None


class ReviseQuoteIn(BaseModel):
    note: str = Field(min_length=1)


class TRPackageQuantityOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    package_id: int | None = None
    package_no: str | None = None
    package_type: str | None = None
    quantity: float


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
    package_quantities: list[TRPackageQuantityOut] = []


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


class ActivityRow(BaseModel):
    """One line of the activity ledger.

    Not `from_attributes`: the rows come off a UNION of four sources, not off a model,
    and the whole point of the ledger is that they arrive already normalised — one
    vocabulary, one label, one result, whichever table the event was recorded in.
    """
    #: Unique across the whole union ("evt:12", "wf:9", "tr:5:awarded"). The table
    #: key alone is not: a quote row contributes both an invite and a price.
    event_id: str
    tr_id: int
    tr_no: str
    consignment_no: str | None = None
    indent_no: str | None = None
    mode: str
    event_type: str
    #: Both SERVED rather than mapped in the screen — see `enums.ACTIVITY_META`.
    event_label: str
    result: str
    occurred_at: datetime
    actor_name: str | None = None
    carrier_name: str | None = None
    location_name: str | None = None
    detail: str | None = None
    amount: float | None = None
    is_exception: bool = False
    from_name: str | None = None
    to_name: str | None = None


class TROut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    tr_no: str
    tr_date: date | None = None
    mode: str
    carriage_mode: str | None = None
    status: str
    source_type: str | None = None
    source_id: int | None = None
    source_no: str | None = None
    issue_id: int | None = None
    dispatch_id: int | None = None
    consignment_no: str | None = None
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
    carrier_accepted_at: datetime | None = None
    carrier_declined_at: datetime | None = None
    carrier_decline_reason: str | None = None
    carrier_reference: str | None = None
    carrier_confirmed_by_name: str | None = None
    vehicle_number: str | None = None
    driver_name: str | None = None
    driver_phone: str | None = None
    driver_licence_no: str | None = None
    trip_reference: str | None = None
    handed_over_by_name: str | None = None
    handed_over_employee_id: str | None = None
    handed_over_aadhaar: str | None = None
    handed_over_phone: str | None = None
    received_by_name: str | None = None
    lr_no: str | None = None
    docket_no: str | None = None
    tracking_url: str | None = None
    eway_bill_no: str | None = None
    gate_pass_no: str | None = None
    expected_delivery: date | None = None
    dispatched_at: datetime | None = None
    dispatched_by_name: str | None = None
    delivered_at: datetime | None = None
    delivered_to_name: str | None = None
    pod_url: str | None = None
    tracking_shared_at: datetime | None = None
    acknowledged_at: datetime | None = None
    acknowledged_by_name: str | None = None
    ack_condition: str | None = None
    ack_remarks: str | None = None
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
    carriage_mode: str | None = None
    status: str
    # FIX 2026-09-07: which document this leg is carrying, so a list can say so. The
    # outward leg has always had `consignment_no`/`indent_no` below to name its source;
    # a RETURN leg has neither, and without these it read as a bare TR number with no
    # way to tell it apart from an outward one. Additive: `TROut` has carried both
    # since the column existed, so nothing downstream changes shape.
    source_type: str | None = None
    source_no: str | None = None
    dispatch_id: int | None = None
    consignment_no: str | None = None
    indent_no: str | None = None
    from_warehouse_name: str | None = None
    to_location_name: str | None = None
    carrier_name: str | None = None
    freight_amount: float | None = None
    total_items: int
    total_qty: float
    total_packages: int
    total_weight_kg: float
    lr_no: str | None = None
    docket_no: str | None = None
    tracking_url: str | None = None
    expected_delivery: date | None = None
    dispatched_at: datetime | None = None
    delivered_at: datetime | None = None
    acknowledged_at: datetime | None = None
    tracking_shared_at: datetime | None = None
    created_at: datetime
    # Filled in by the carrier portal for the signed-in carrier only; the desk's own
    # board leaves them None. `freight_amount` above is the AGREED price and stays
    # empty all the way through the tender, so without these a lane this carrier has
    # already priced looks, in the list, exactly like one they have not touched.
    my_quote_status: str | None = None
    my_quote_amount: float | None = None
    my_quote_submitted_at: datetime | None = None


class ProviderBoardRow(TRListRow):
    """A shipment as the Provider Selection desk sees it — the row plus its tender.

    The transport register answers "where is this consignment"; this answers the only
    question that desk has — "how many of the partners I asked have answered, and what
    is the best price on the table". Both come off the same document, but a desk that
    has to open every request to count the replies is a desk that awards late.

    A mode with no tender reads 0 of 0, which is exactly right: it was settled at
    dispatch and there is nothing to compare.
    """
    invited_count: int = 0
    responded_count: int = 0
    #: The cheapest landed cost quoted so far, and who quoted it. Not an award and not
    #: a recommendation — the comparison sheet makes that call under the chosen method.
    best_amount: float | None = None
    best_carrier_name: str | None = None
    best_transit_days: int | None = None


class ActionIn(BaseModel):
    comments: str = ""


class InviteIn(BaseModel):
    carrier_ids: list[int] = Field(min_length=1, max_length=MAX_BATCH_IDS)
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
    driver_licence_no: str | None = None
    trip_reference: str | None = None
    handed_over_by_name: str | None = None
    handed_over_employee_id: str | None = None
    handed_over_aadhaar: str | None = None
    handed_over_phone: str | None = None


class DispatchIn(BaseModel):
    """Releasing the consignment. The gate pass belongs here rather than on the
    warehouse document: it is written at the same moment as the LR it travels with.

    The custody block below is the HAND-OVER's answer to the LR and the docket above
    it. A direct hand-over has neither of those papers — nobody issues an LR for a
    storekeeper walking a carton to the requester — so the boxes the desk was asked to
    fill at this press were four it could only leave blank, and the one fact the leg
    actually records (who took it, and which number pins them down) was frozen at
    booking with no way to correct it at the gate. The person who finally collects is
    often not the person named the day before.

    `_release` applies these ONLY to a direct hand-over, so no other mode's dispatch
    changes shape.
    """
    lr_no: str | None = None
    docket_no: str | None = None
    tracking_url: str | None = None
    eway_bill_no: str | None = None
    gate_pass_no: str | None = None
    expected_delivery: date | None = None
    remarks: str | None = None
    handed_over_by_name: str | None = None
    handed_over_employee_id: str | None = None
    handed_over_aadhaar: str | None = None
    handed_over_phone: str | None = None


class CarrierAcceptIn(BaseModel):
    """The carrier taking the job. `carrier_reference` is their own booking id."""
    carrier_reference: str | None = None


class CarrierAckIn(BaseModel):
    """The awarded carrier acknowledging the job, with what is coming for the load.

    The same boxes the dispatch desk fills for a leg it settles on the spot — driver,
    vehicle, the numbers the site chases it on — asked of the carrier instead, because
    on a tender nobody on our side knows them until the winner says so. Answering it
    IS accepting the award, so it lands the shipment on READY exactly as `/accept`
    does; the difference is that the details come with the yes rather than after it.

    Two are required: a load leaves with a vehicle and somebody driving it, and a
    booking with neither cannot be met at the gate. The rest are optional — a docket
    is issued at the counter and a tracking link may not exist at all.
    """
    driver_name: str = Field(min_length=1)
    vehicle_number: str = Field(min_length=1)
    driver_phone: str | None = None
    driver_licence_no: str | None = None
    lr_no: str | None = None
    docket_no: str | None = None
    tracking_url: str | None = None
    eway_bill_no: str | None = None
    carrier_reference: str | None = None


class CarrierDeclineIn(BaseModel):
    reason: str = Field(min_length=1)


class CarrierConfirmIn(BaseModel):
    """The desk confirming a carrier's acceptance taken over the phone. `confirmed_by`
    is recorded so an acceptance the carrier never made in the portal reads as one."""
    carrier_reference: str | None = None
    confirmed_by: str = Field(min_length=1)


class CarrierTrackIn(BaseModel):
    """What a carrier can write against a job it holds: the tracking handle, and a
    progress scan. Never a claim — a carrier does not raise claims against itself."""
    lr_no: str | None = None
    docket_no: str | None = None
    tracking_url: str | None = None
    carrier_reference: str | None = None
    event_type: str | None = None
    location_name: str | None = None
    description: str | None = None


class AcknowledgeIn(BaseModel):
    """The receiving site signing for the consignment (doc A6).

    `condition` is GOOD / SHORT / DAMAGED; anything but GOOD needs remarks and opens a
    claim against the provider on the same shipment timeline.
    """
    acknowledged_by_name: str | None = None
    condition: str = "GOOD"
    remarks: str | None = None
    pod_url: str | None = None
    affected_item_name: str | None = None
    affected_qty: float | None = Field(ge=0, default=None)
    claim_amount: float | None = Field(ge=0, default=None)


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


class ConsignmentLink(BaseModel):
    """"Does this packed consignment already have transport, and where has it got to?"

    Asked once for a whole page of consignments. The `dispatch_id` is the warehouse
    consignment; everything else is the transport leg carrying it.
    """
    dispatch_id: int
    tr_id: int
    tr_no: str
    mode: str
    #: Read back onto the dispatch screen beside the arrangement, so the desk that
    #: raised the leg sees the way it is actually going — including a carriage the
    #: WINNING carrier changed when they acknowledged it.
    carriage_mode: str | None = None
    status: str
    carrier_name: str | None = None
    lr_no: str | None = None
    # Who is coming for it. On a tender these are the CARRIER's answer, written when
    # they acknowledge the award — the desk never typed them, so the queue is where
    # they are first read.
    driver_name: str | None = None
    vehicle_number: str | None = None


class Option(BaseModel):
    id: int
    code: str | None = None
    name: str


# --------------------------------------------------------------------------- #
#  Logistics vendors — the partners the Dispatch dropdown offers
# --------------------------------------------------------------------------- #
class PartnerCreate(BaseModel):
    """Adding a third-party provider (Amazon, Flipkart, Alibaba, Misaba, a truck
    operator). Only the name is required — the code is derived and the type defaults
    to TRANSPORT, because a form that demands a vendor code before it will accept
    "Flipkart" is the reason the register stayed empty."""
    name: str = Field(min_length=1, max_length=200)
    code: str | None = Field(default=None, max_length=50)
    vendor_type: str = "TRANSPORT"
    contact_person: str | None = None
    phone: str | None = None
    email: str | None = None
    address: str | None = None
    city: str | None = None
    state: str | None = None
    pincode: str | None = None
    gstin: str | None = None
    pan: str | None = None
    payment_terms_days: int | None = Field(default=None, ge=0, le=365)
    # Name them and let them in, in one press. A partner with no account cannot
    # answer the quote request THIRD_PARTY exists to send them.
    issue_login: bool = True
    username: str | None = None


class PartnerUpdate(BaseModel):
    """Every field optional: the screen PATCHes what the row changed. `code` is absent
    on purpose — documents snapshot the carrier against it."""
    name: str | None = Field(default=None, max_length=200)
    vendor_type: str | None = None
    contact_person: str | None = None
    phone: str | None = None
    email: str | None = None
    address: str | None = None
    city: str | None = None
    state: str | None = None
    pincode: str | None = None
    gstin: str | None = None
    pan: str | None = None
    payment_terms_days: int | None = Field(default=None, ge=0, le=365)
    is_active: bool | None = None
    is_blacklisted: bool | None = None


class PartnerLoginIn(BaseModel):
    username: str | None = None


class PartnerOut(BaseModel):
    id: int
    code: str | None = None
    name: str
    vendor_type: str
    contact_person: str | None = None
    phone: str | None = None
    email: str | None = None
    city: str | None = None
    state: str | None = None
    gstin: str | None = None
    payment_terms_days: int | None = None
    is_active: bool
    is_approved: bool
    is_blacklisted: bool
    # The portal account, flattened onto the partner row.
    has_login: bool
    username: str | None = None
    login_is_active: bool | None = None
    must_change_password: bool | None = None
    last_login_at: datetime | None = None
    dispatchable: bool
