from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.shared.time import not_in_past


class POLineIn(BaseModel):
    item_id: int
    indent_item_id: int | None = None
    quantity: float = Field(gt=0)
    rate: float = Field(ge=0)
    tax_percent: float = Field(ge=0, default=0)


class POHeaderIn(BaseModel):
    """What the order says beyond its lines — the same on every way of raising one.

    One base class rather than four copies: a PO typed by hand, one written off an
    indent and one written off an award are the same document, so a term agreed on one
    must be enterable on all three or the printed order changes by route.

    Discount and freight are DOCUMENT money: they are applied to the order, never
    spread across lines, because spreading them would rewrite rates a vendor quoted.
    """
    project_id: int | None = None
    remarks: str | None = None
    payment_terms: str | None = None
    delivery_terms: str | None = None
    material_terms: str | None = None
    logistics_terms: str | None = None
    billing_address: str | None = None
    shipping_address: str | None = None
    discount_amount: float = Field(ge=0, default=0)
    freight_amount: float = Field(ge=0, default=0)


class POCreate(POHeaderIn):
    vendor_id: int
    expected_date: date | None = None
    lines: list[POLineIn]

    _no_past_expected_date = field_validator("expected_date")(
        lambda cls, v: not_in_past(v, "Expected date"))


class POHeaderUpdate(POHeaderIn):
    """Fill in a DRAFT order's header after it was written for you.

    An order raised from an award arrives complete on the money and empty on
    everything a buyer negotiates in words — terms, addresses, the project it is
    booked to. Typing them was only possible on a hand-raised PO, so a PO that came
    off the chain printed blank. Same fields, same permission, DRAFT only.
    """
    expected_date: date | None = None


class POAmendLineIn(BaseModel):
    """One line of an amended order.

    `id` is the EXISTING line being changed. Omit it and the line is new; leave an
    existing id out of the payload altogether and that line is removed — which the
    service refuses if anything has already been received against it.
    """
    id: int | None = None
    item_id: int
    quantity: float = Field(gt=0)
    rate: float = Field(ge=0)
    tax_percent: float = Field(ge=0, default=0)


class POAmendIn(POHeaderIn):
    """A revision of an order that has already gone out.

    `reason` is required: an amendment is a change to something somebody has already
    agreed to, and a revision history with no reasons in it answers no questions.

    `lines` is optional — most amendments move a date or a term and leave the goods
    alone. Sending it replaces the whole line list.
    """
    reason: str
    expected_date: date | None = None
    lines: list[POAmendLineIn] | None = None


class POVendorResponseIn(BaseModel):
    """The vendor's answer. A decline must say why; an acceptance need not."""
    accept: bool
    note: str = ""


class PORevisionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    revision_no: int
    reason: str | None = None
    status: str | None = None
    vendor_status: str | None = None
    snapshot: dict | None = None
    changed_by_name: str | None = None
    created_at: datetime


class POFromQuotationIn(POHeaderIn):
    """Everything the awarded quotation does NOT already say.

    No vendor and no lines: both come from the offer being accepted, and letting the
    caller send them would make it possible to raise a PO that disagrees with the
    quotation it claims to be for.
    """
    expected_date: date | None = None


class ActionIn(BaseModel):
    comments: str = ""


# --------------------------------------------------------------------------- #
#  Approval trail — one shape for every procurement document
# --------------------------------------------------------------------------- #

class ApprovalPendingRow(BaseModel):
    """A person the engine is waiting on. A NAME, never a permission: who may press
    the button is `engine.actionable_doc_ids`, and appearing here grants nothing."""
    id: int
    name: str


class ApprovalEventRow(BaseModel):
    """One rung, as it actually happened. `stage_name` is whatever the ladder called
    it at the time — never mapped, abbreviated or re-titled here, because the rungs
    are configured per project on Settings > Approvals Config and a lookup in code
    would go stale the moment somebody renames one."""
    stage_sequence: int | None = None
    stage_name: str | None = None
    actor_id: int | None = None
    actor_name: str | None = None
    actor_position: str | None = None
    action: str
    comments: str | None = None
    acted_at: datetime | None = None


class ApprovalTrailOut(BaseModel):
    doc_type: str
    doc_id: int
    #: None when the document has never been submitted — no instance exists yet.
    instance_status: str | None = None
    stage_name: str | None = None
    pending_with: list[ApprovalPendingRow] = []
    history: list[ApprovalEventRow] = []


class POItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    quantity: float
    rate: float
    tax_percent: float
    amount: float
    received_quantity: float


class POOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    po_no: str
    po_date: date | None = None
    expected_date: date | None = None
    indent_id: int | None = None
    indent_no: str | None = None
    # The buying chain behind this order, when it came off an award rather than an
    # indent. All optional — a PO raised straight from an indent carries none of them.
    requisition_id: int | None = None
    requisition_no: str | None = None
    rfq_id: int | None = None
    rfq_no: str | None = None
    quotation_id: int | None = None
    quotation_no: str | None = None
    vendor_id: int
    vendor_name: str | None = None
    facility_id: int | None = None
    facility_name: str | None = None
    project_id: int | None = None
    project_name: str | None = None
    status: str
    sub_total: float
    discount_amount: float = 0
    tax_amount: float
    freight_amount: float = 0
    total_amount: float
    remarks: str | None = None
    payment_terms: str | None = None
    delivery_terms: str | None = None
    material_terms: str | None = None
    logistics_terms: str | None = None
    billing_address: str | None = None
    shipping_address: str | None = None
    current_approver_name: str | None = None
    # Who the approval engine is ACTUALLY waiting on right now, read live at request
    # time. `current_approver_name` beside it is a snapshot written at submit and at
    # each decision, so it goes stale when a ladder is edited, a delegation is added,
    # or the post under a rung is retired. Both are served: the snapshot stays for
    # every existing reader, this is the one a screen should trust.
    pending_with: list[str] = []
    # Can THIS login sign it right now: on the current stage's pending list, and
    # wearing a position the ladder named. Served rather than derived in the screen,
    # because a screen can only see the document's status and its own permission
    # codes, and neither answers "is it with me". See service._attach_pending_one.
    awaiting_me: bool = False
    # What the vendor said, and which revision they said it about. Both null on an
    # order that has never been sent, which is how a reader tells "not asked yet" from
    # "asked and waiting".
    vendor_status: str | None = None
    vendor_responded_at: datetime | None = None
    vendor_response_note: str | None = None
    revision_no: int = 0
    amended_at: datetime | None = None
    amendment_reason: str | None = None
    created_at: datetime
    items: list[POItemOut] = []


class POListRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    po_no: str
    vendor_name: str | None = None
    indent_no: str | None = None
    status: str
    # Two orders can both read SENT_TO_VENDOR while one is agreed and the other has
    # been sitting unanswered for a week. The register has to be able to say which.
    vendor_status: str | None = None
    revision_no: int = 0
    total_amount: float
    # Who the approval engine is ACTUALLY waiting on right now, read live at request
    # time. `current_approver_name` beside it is a snapshot written at submit and at
    # each decision, so it goes stale when a ladder is edited, a delegation is added,
    # or the post under a rung is retired. Both are served: the snapshot stays for
    # every existing reader, this is the one a screen should trust.
    pending_with: list[str] = []
    # Can THIS login sign it right now: on the current stage's pending list, and
    # wearing a position the ladder named. Served rather than derived in the screen,
    # because a screen can only see the document's status and its own permission
    # codes, and neither answers "is it with me". See service._attach_pending_one.
    awaiting_me: bool = False
    created_at: datetime


# --------------------------------------------------------------------------- #
#  Requisition
# --------------------------------------------------------------------------- #

class ReqLineIn(BaseModel):
    item_id: int
    quantity: float = Field(gt=0)
    uom_code: str | None = None
    estimated_rate: float = Field(ge=0, default=0)
    required_date: date | None = None
    indent_id: int | None = None
    indent_item_id: int | None = None


class ReqCreate(BaseModel):
    warehouse_id: int | None = None
    project_id: int | None = None
    # Who is asking and on whose paper. Both were derived from the raiser's HCM record,
    # which is only right until somebody raises on another department's behalf.
    department_id: int | None = None
    company_name: str | None = None
    # One date for the document. A line may still override it (`ReqLineIn`), but the
    # form no longer asks for the same date once per item.
    required_date: date | None = None
    priority: str | None = None
    remarks: str | None = None
    lines: list[ReqLineIn] = Field(min_length=1)


class ReqFromMRsIn(BaseModel):
    """Fold several approved material requests into one requisition.

    Item-wise: the same item on five requests becomes one line. Every request stays on
    the requisition's sources, and none of them can be consolidated twice.
    """
    mr_ids: list[int] = Field(min_length=1)
    warehouse_id: int | None = None
    project_id: int | None = None
    department_id: int | None = None
    company_name: str | None = None
    required_date: date | None = None
    priority: str | None = None
    remarks: str | None = None


class MRCandidateRow(BaseModel):
    """An approved material request that no requisition has claimed yet."""
    model_config = ConfigDict(from_attributes=True)
    id: int
    mr_no: str
    indent_id: int | None = None
    indent_no: str | None = None
    project_id: int | None = None
    project_name: str | None = None
    status: str
    created_at: datetime


class ReqItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    line_no: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    quantity: float
    ordered_qty: float
    estimated_rate: float
    estimated_amount: float
    required_date: date | None = None
    indent_id: int | None = None
    indent_no: str | None = None


class ReqListRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    req_no: str
    req_date: date | None = None
    warehouse_name: str | None = None
    project_name: str | None = None
    status: str
    priority: str | None = None
    total_items: int
    estimated_value: float
    current_approver_name: str | None = None
    # Who the approval engine is ACTUALLY waiting on right now, read live at request
    # time. `current_approver_name` beside it is a snapshot written at submit and at
    # each decision, so it goes stale when a ladder is edited, a delegation is added,
    # or the post under a rung is retired. Both are served: the snapshot stays for
    # every existing reader, this is the one a screen should trust.
    pending_with: list[str] = []
    # Can THIS login sign it right now: on the current stage's pending list, and
    # wearing a position the ladder named. Served rather than derived in the screen,
    # because a screen can only see the document's status and its own permission
    # codes, and neither answers "is it with me". See service._attach_pending_one.
    awaiting_me: bool = False
    created_by_name: str | None = None
    created_at: datetime


class ReqOut(ReqListRow):
    warehouse_id: int | None = None
    project_id: int | None = None
    remarks: str | None = None
    approved_by_name: str | None = None
    approved_at: datetime | None = None
    # Where this demand came from, when Purchase picked it up rather than raising it.
    source_mr_id: int | None = None
    source_mr_no: str | None = None
    # Stored where the form named them; otherwise read from the raiser's HCM record and
    # the install settings. See service._fill_header_context.
    department_id: int | None = None
    department_name: str | None = None
    company_name: str | None = None
    required_date: date | None = None
    # The indents behind the lines, deduplicated. A requisition consolidated out of the
    # field serves several, and the header could not say which.
    source_indent_nos: list[str] = []
    # Every material request folded in, not just `source_mr_no`.
    source_mr_nos: list[str] = []
    has_rfq: bool = False
    items: list[ReqItemOut] = []


# --------------------------------------------------------------------------- #
#  RFQ
# --------------------------------------------------------------------------- #

class RFQLineIn(BaseModel):
    item_id: int
    quantity: float = Field(gt=0)
    uom_code: str | None = None
    description: str | None = None
    required_date: date | None = None


class RFQCreate(BaseModel):
    title: str | None = None
    requisition_id: int | None = None
    consolidation_id: int | None = None
    warehouse_id: int | None = None
    project_id: int | None = None
    # Typed only on an RFQ raised cold. Where a requisition or a sheet is named, that
    # document's own values win and these are left empty.
    department_id: int | None = None
    company_name: str | None = None
    due_date: date | None = None
    terms: str | None = None
    # None means "use the default" — see shared/evaluation.method_of. Validated in the
    # service against the shared catalogue, never against a list kept here.
    evaluation_method: str | None = None
    vendor_ids: list[int] = []
    lines: list[RFQLineIn] = Field(min_length=1)


class RFQQuantityIn(BaseModel):
    """One line's quantity, by RFQ line id."""
    id: int
    quantity: float = Field(gt=0)


class RFQQuantitiesIn(BaseModel):
    """What the approver is sending back down: quantities only.

    A separate body from `RFQUpdate` on purpose. An approver holds `rfq.approve`, not
    `rfq.create`, so they cannot reach the editing route at all — and they should not:
    the deadline, the vendor list and the item list are the buyer's. The one thing a
    person signing a tender genuinely needs to change is HOW MUCH, and that is all
    this carries.
    """
    lines: list[RFQQuantityIn] = Field(min_length=1)
    comments: str = ""


class RFQUpdate(BaseModel):
    """Every field optional: this is a PATCH in a PUT's clothing, because the RFQ
    form saves the whole header and the caller should not have to resend the lines
    to move a deadline."""
    title: str | None = None
    due_date: date | None = None
    terms: str | None = None
    warehouse_id: int | None = None
    project_id: int | None = None
    department_id: int | None = None
    company_name: str | None = None
    evaluation_method: str | None = None
    vendor_ids: list[int] | None = None
    lines: list[RFQLineIn] | None = None


class RFQItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    line_no: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    description: str | None = None
    uom_code: str | None = None
    quantity: float
    required_date: date | None = None


class RFQVendorOut(BaseModel):
    """No `access_token`. It is a bearer credential — whoever holds it can quote as
    that vendor — so it leaves the server exactly once, in the invite link."""
    model_config = ConfigDict(from_attributes=True)
    id: int
    vendor_id: int
    vendor_name: str | None = None
    vendor_email: str | None = None
    status: str | None = None
    sent_at: datetime | None = None
    responded_at: datetime | None = None


class RFQListRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    rfq_no: str
    title: str | None = None
    rfq_date: date | None = None
    due_date: date | None = None
    status: str
    total_items: int
    vendor_count: int
    response_count: int
    awarded_vendor_name: str | None = None
    current_approver_name: str | None = None
    # Who the approval engine is ACTUALLY waiting on right now, read live at request
    # time. `current_approver_name` beside it is a snapshot written at submit and at
    # each decision, so it goes stale when a ladder is edited, a delegation is added,
    # or the post under a rung is retired. Both are served: the snapshot stays for
    # every existing reader, this is the one a screen should trust.
    pending_with: list[str] = []
    # Can THIS login sign it right now: on the current stage's pending list, and
    # wearing a position the ladder named. Served rather than derived in the screen,
    # because a screen can only see the document's status and its own permission
    # codes, and neither answers "is it with me". See service._attach_pending_one.
    awaiting_me: bool = False
    created_at: datetime


class RFQOut(RFQListRow):
    requisition_id: int | None = None
    requisition_no: str | None = None
    consolidation_id: int | None = None
    consolidation_no: str | None = None
    warehouse_id: int | None = None
    warehouse_name: str | None = None
    project_id: int | None = None
    project_name: str | None = None
    terms: str | None = None
    evaluation_method: str | None = None
    awarded_vendor_id: int | None = None
    created_by_name: str | None = None
    # The purchase order this award became. Not stored on pro_rfqs — the PO points
    # backward at the RFQ and this is read from there, so there is one link, not two.
    po_id: int | None = None
    po_no: str | None = None
    po_status: str | None = None
    # Carried from the requisition behind it, so a tender reads on its own. Derived at
    # request time (service.get_rfq) and empty on the vendor-facing routes, which read
    # the RFQ by a different path — a supplier has no business with our indent numbers.
    department_id: int | None = None
    department_name: str | None = None
    company_name: str | None = None
    priority: str | None = None
    requisition_status: str | None = None
    source_indent_nos: list[str] = []
    items: list[RFQItemOut] = []
    vendors: list[RFQVendorOut] = []


# --------------------------------------------------------------------------- #
#  Consolidated buying sheet
# --------------------------------------------------------------------------- #

class ConsolidationCreate(BaseModel):
    requisition_ids: list[int] = Field(min_length=1)
    title: str | None = None
    period_label: str | None = None
    cons_date: date | None = None
    project_id: int | None = None
    project_name: str | None = None
    warehouse_id: int | None = None
    warehouse_name: str | None = None
    remarks: str | None = None


class ConsolidationLineEdit(BaseModel):
    line_id: int
    approved_qty: float = Field(ge=0)
    remarks: str | None = None


class ConsolidationLinesIn(BaseModel):
    lines: list[ConsolidationLineEdit] = Field(min_length=1)


class ConsolidationItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    line_no: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    quantity: float
    approved_qty: float
    estimated_rate: float
    estimated_amount: float
    required_date: date | None = None
    sources: str | None = None
    source_count: int
    remarks: str | None = None


class ConsolidationSourceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    requisition_id: int
    requisition_no: str | None = None
    project_name: str | None = None
    item_count: int
    estimated_value: float


class ConsolidationListRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    cons_no: str
    cons_date: date | None = None
    title: str | None = None
    period_label: str | None = None
    project_name: str | None = None
    status: str
    total_items: int
    source_count: int
    estimated_value: float
    current_approver_name: str | None = None
    # Who the approval engine is ACTUALLY waiting on right now, read live at request
    # time. `current_approver_name` beside it is a snapshot written at submit and at
    # each decision, so it goes stale when a ladder is edited, a delegation is added,
    # or the post under a rung is retired. Both are served: the snapshot stays for
    # every existing reader, this is the one a screen should trust.
    pending_with: list[str] = []
    # Can THIS login sign it right now: on the current stage's pending list, and
    # wearing a position the ladder named. Served rather than derived in the screen,
    # because a screen can only see the document's status and its own permission
    # codes, and neither answers "is it with me". See service._attach_pending_one.
    awaiting_me: bool = False
    created_by_name: str | None = None
    created_at: datetime


class ConsolidationOut(ConsolidationListRow):
    project_id: int | None = None
    warehouse_id: int | None = None
    warehouse_name: str | None = None
    approved_by_name: str | None = None
    approved_at: datetime | None = None
    remarks: str | None = None
    items: list[ConsolidationItemOut] = []


class VendorInviteOut(BaseModel):
    """The one response that carries a raw access token, once, per vendor."""
    vendor_id: int
    vendor_name: str | None = None
    vendor_email: str | None = None
    invite_path: str


# --------------------------------------------------------------------------- #
#  Quotation
# --------------------------------------------------------------------------- #

class QuoteLineIn(BaseModel):
    rfq_item_id: int
    # What the vendor can actually supply. Optional: say nothing and the quantity asked
    # for stands. It may never be MORE than was asked — a quotation is an answer to a
    # request, and a vendor cannot enlarge the order they were invited to.
    quantity: float | None = Field(default=None, gt=0)
    rate: float = Field(ge=0)
    discount_percent: float = Field(ge=0, le=100, default=0)
    tax_percent: float = Field(ge=0, default=0)
    cgst_rate: float | None = None
    sgst_rate: float | None = None
    igst_rate: float | None = None
    delivery_days: int | None = None


class QuoteSubmit(BaseModel):
    vendor_ref_no: str | None = None
    valid_till: date | None = None
    expected_delivery_date: date | None = None
    payment_terms: str | None = None
    delivery_days: int | None = None
    freight_amount: float = Field(ge=0, default=0)
    discount_amount: float = Field(ge=0, default=0)
    remarks: str | None = None
    lines: list[QuoteLineIn] = Field(min_length=1)


class QuoteItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    line_no: int
    rfq_item_id: int | None = None
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    quantity: float
    rate: float
    discount_percent: float
    tax_percent: float
    cgst_rate: float | None = None
    sgst_rate: float | None = None
    igst_rate: float | None = None
    amount: float
    delivery_days: int | None = None
    # The classification and the rates it notifies — the ceiling this line may quote up
    # to. Read at request time off the HSN, never stored: a rate change is a government
    # notification, not an edit to a quotation. Null when the item has no HSN, which
    # means no ceiling rather than a ceiling of zero.
    hsn_code: str | None = None
    max_cgst_rate: float | None = None
    max_sgst_rate: float | None = None
    max_igst_rate: float | None = None
    # What the RFQ line asked for, and when it is wanted. Read off the RFQ at request
    # time rather than copied: `quantity` above is the vendor's ANSWER and may be
    # short, so without this the buyer cannot see that the offer covers only part of
    # what was requested.
    requested_quantity: float | None = None
    required_date: date | None = None


class QuoteListRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    quotation_no: str
    rfq_id: int
    rfq_no: str | None = None
    vendor_id: int
    vendor_name: str | None = None
    status: str
    grand_total: float
    rank_position: int | None = None
    revision_count: int
    submitted_at: datetime | None = None
    created_at: datetime


class QuoteOut(QuoteListRow):
    vendor_ref_no: str | None = None
    quotation_date: date | None = None
    valid_till: date | None = None
    expected_delivery_date: date | None = None
    currency: str | None = None
    sub_total: float
    discount_amount: float
    tax_amount: float
    freight_amount: float
    payment_terms: str | None = None
    delivery_days: int | None = None
    remarks: str | None = None
    # Which tax applies, decided by the two GSTINs' state codes: INTRA is CGST+SGST,
    # INTER is IGST. Derived, never stored — see service.tax_region.
    tax_region: str | None = None
    company_gstin: str | None = None
    vendor_gstin: str | None = None
    items: list[QuoteItemOut] = []


class AwardIn(BaseModel):
    quotation_id: int
    comments: str = ""


# --------------------------------------------------------------------------- #
#  Vendor portal
# --------------------------------------------------------------------------- #

class VendorLoginIn(BaseModel):
    username: str
    password: str


class VendorTokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    vendor_id: int
    vendor_name: str | None = None
    must_change_password: bool


class VendorPasswordIn(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8)


class VendorProfileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    code: str | None = None
    name: str
    contact_person: str | None = None
    phone: str | None = None
    email: str | None = None
    city: str | None = None
    state: str | None = None
    gstin: str | None = None


class VendorAccountOut(BaseModel):
    """What the buyer sees on the vendor master. Never the hash."""
    model_config = ConfigDict(from_attributes=True)
    vendor_id: int
    username: str
    is_active: bool
    must_change_password: bool
    last_login_at: datetime | None = None


class VendorAccountIn(BaseModel):
    vendor_id: int
    username: str | None = None


# --------------------------------------------------------------------------- #
#  Despatch note — the vendor's statement of what they sent
# --------------------------------------------------------------------------- #

class DespatchLineIn(BaseModel):
    """One line the vendor says is on the vehicle.

    `po_item_id` rather than a free item choice: a despatch note answers an order, and
    a vendor must not be able to add a line nobody bought. The service rejects any id
    that is not on the PO.
    """
    po_item_id: int
    despatched_qty: float = Field(ge=0, default=0)
    batch_no: str | None = None
    mfg_date: date | None = None
    expiry_date: date | None = None
    remarks: str | None = None


class DespatchNoteIn(BaseModel):
    """Saved as a draft with anything filled in; the invoice and e-way bill are only
    required at submit, which is where `submit_despatch_note` checks them."""
    dn_date: date | None = None
    invoice_no: str | None = None
    invoice_date: date | None = None
    invoice_amount: float | None = Field(ge=0, default=None)
    eway_bill_no: str | None = None
    vehicle_no: str | None = None
    transporter_name: str | None = None
    lr_no: str | None = None
    expected_date: date | None = None
    remarks: str | None = None
    lines: list[DespatchLineIn] = Field(min_length=1)


class DespatchItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    line_no: int
    po_item_id: int | None = None
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    despatched_qty: float
    batch_no: str | None = None
    mfg_date: date | None = None
    expiry_date: date | None = None
    remarks: str | None = None


class DespatchNoteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    dn_no: str
    dn_date: date | None = None
    po_id: int
    po_no: str | None = None
    vendor_id: int
    vendor_name: str | None = None
    invoice_no: str | None = None
    invoice_date: date | None = None
    invoice_amount: float | None = None
    eway_bill_no: str | None = None
    vehicle_no: str | None = None
    transporter_name: str | None = None
    lr_no: str | None = None
    expected_date: date | None = None
    status: str
    remarks: str | None = None
    submitted_at: datetime | None = None
    created_at: datetime
    items: list[DespatchItemOut] = []


class VendorPOLineOut(BaseModel):
    """A PO line as the VENDOR sees it. `pending_qty` is what is still owed, so a
    second delivery opens with the remainder rather than the whole order."""
    model_config = ConfigDict(from_attributes=True)
    po_item_id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    ordered_qty: float
    despatched_qty: float
    pending_qty: float


class VendorPOOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    po_no: str
    po_date: date | None = None
    expected_date: date | None = None
    status: str
    total_amount: float
    remarks: str | None = None
    # The order's own answer state, so the portal can ask for one rather than
    # presenting a despatch form for something never agreed to.
    vendor_status: str | None = None
    vendor_responded_at: datetime | None = None
    vendor_response_note: str | None = None
    revision_no: int = 0
    amendment_reason: str | None = None
    payment_terms: str | None = None
    delivery_terms: str | None = None
    material_terms: str | None = None
    logistics_terms: str | None = None
    billing_address: str | None = None
    shipping_address: str | None = None
    lines: list[VendorPOLineOut] = []
    despatch_notes: list[DespatchNoteOut] = []


class VendorPOListRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    po_no: str
    vendor_status: str | None = None
    revision_no: int = 0
    po_date: date | None = None
    expected_date: date | None = None
    status: str
    total_amount: float
    despatch_note_count: int = 0


class VendorNotificationOut(BaseModel):
    """One message on the vendor's own bell.

    `deep_link` is a PORTAL path, resolved by the portal — the vendor has no access to
    an internal screen and must never be handed a link to one.
    """
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    body: str | None = None
    entity_type: str | None = None
    entity_id: int | None = None
    deep_link: str | None = None
    is_read: bool
    created_at: datetime | None = None


class LedgerRow(BaseModel):
    """One document on the buying trail. See `procurement/ledger.py`."""
    model_config = ConfigDict(from_attributes=True)

    doc_kind: str
    doc_id: int
    doc_no: str
    doc_date: date | None = None
    party: str | None = None
    project_name: str | None = None
    title: str | None = None
    status: str | None = None
    value: Decimal | None = None
    ref_no: str | None = None
    with_whom: str | None = None



# --------------------------------------------------------------------------- #
# KPI strips. See `procurement/stats.py` — one schema per document family, and
# deliberately not one composite, so each endpoint can be gated on the view code of
# the documents it counts.
#
# `awaiting_me` is on every document that has a ladder. It is NOT "how many are
# pending approval" — it is how many are pending on THIS login, straight off
# `wf_pending`, so the tile can never tell four approvers the same queue is each of
# theirs.
# --------------------------------------------------------------------------- #

class ReqStatsOut(BaseModel):
    awaiting_me: int = 0
    pending_approval: int = 0
    approved: int = 0
    draft: int = 0
    rejected: int = 0
    total: int = 0
    this_month: int = 0
    open_value: float = 0
    total_lines: int = 0
    by_status: dict[str, int] = {}
    #: What each tile OPENS, keyed by the bucket above it — served so the count and
    #: the list can never disagree. See `stats.REQ_FILTERS` and friends.
    filters: dict[str, dict[str, str]] = {}


class ConsolidationStatsOut(BaseModel):
    awaiting_me: int = 0
    pending_approval: int = 0
    approved: int = 0
    draft: int = 0
    total: int = 0
    this_month: int = 0
    requisitions_rolled: int = 0
    total_items: int = 0
    estimated_value: float = 0
    by_status: dict[str, int] = {}
    #: What each tile OPENS, keyed by the bucket above it — served so the count and
    #: the list can never disagree. See `stats.REQ_FILTERS` and friends.
    filters: dict[str, dict[str, str]] = {}


class RFQStatsOut(BaseModel):
    awaiting_me: int = 0
    pending_approval: int = 0
    out_to_vendors: int = 0
    ready_to_award: int = 0
    draft: int = 0
    awarded: int = 0
    total: int = 0
    closing_soon: int = 0
    vendors_invited: int = 0
    quotes_received: int = 0
    by_status: dict[str, int] = {}
    #: What each tile OPENS, keyed by the bucket above it — served so the count and
    #: the list can never disagree. See `stats.REQ_FILTERS` and friends.
    filters: dict[str, dict[str, str]] = {}


class QuoteStatsOut(BaseModel):
    to_compare: int = 0
    revised: int = 0
    accepted: int = 0
    not_selected: int = 0
    draft: int = 0
    total: int = 0
    this_month: int = 0
    rfqs_covered: int = 0
    vendors_quoting: int = 0
    quoted_value: float = 0
    by_status: dict[str, int] = {}
    #: What each tile OPENS, keyed by the bucket above it — served so the count and
    #: the list can never disagree. See `stats.REQ_FILTERS` and friends.
    filters: dict[str, dict[str, str]] = {}


class POStatsOut(BaseModel):
    awaiting_me: int = 0
    pending_approval: int = 0
    to_send: int = 0
    at_vendor: int = 0
    awaiting_vendor: int = 0
    draft: int = 0
    received: int = 0
    total: int = 0
    this_month: int = 0
    month_value: float = 0
    open_commitment: float = 0
    by_status: dict[str, int] = {}
    #: What each tile OPENS, keyed by the bucket above it — served so the count and
    #: the list can never disagree. See `stats.REQ_FILTERS` and friends.
    filters: dict[str, dict[str, str]] = {}


class DemandPoolRow(BaseModel):
    """One item's sanctioned, unbought demand across every requisition the caller may
    read. `open_qty` is the remainder — `quantity - ordered_qty` summed — so buying in
    rounds shrinks it without anything being rewritten."""
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    open_qty: float = 0
    estimated_value: float = 0
    requisition_count: int = 0
    project_count: int = 0
    earliest_required: date | None = None


class LedgerStatsOut(BaseModel):
    """The buying trail's own strip — one count per document kind, under the same
    filters the register is showing. See `stats.ledger_stats`."""
    by_kind: dict[str, int] = {}
    total: int = 0
    filters: dict[str, dict[str, str]] = {}
