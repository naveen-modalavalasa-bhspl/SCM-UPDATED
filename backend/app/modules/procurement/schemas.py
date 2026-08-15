from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


class POLineIn(BaseModel):
    item_id: int
    indent_item_id: int | None = None
    quantity: float = Field(gt=0)
    rate: float = Field(ge=0)
    tax_percent: float = Field(ge=0, default=0)


class POCreate(BaseModel):
    vendor_id: int
    expected_date: date | None = None
    remarks: str | None = None
    lines: list[POLineIn]


class ActionIn(BaseModel):
    comments: str = ""


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
    vendor_id: int
    vendor_name: str | None = None
    facility_id: int | None = None
    facility_name: str | None = None
    status: str
    sub_total: float
    tax_amount: float
    total_amount: float
    current_approver_name: str | None = None
    created_at: datetime
    items: list[POItemOut] = []


class POListRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    po_no: str
    vendor_name: str | None = None
    indent_no: str | None = None
    status: str
    total_amount: float
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
    priority: str | None = None
    remarks: str | None = None
    lines: list[ReqLineIn] = Field(min_length=1)


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
    created_by_name: str | None = None
    created_at: datetime


class ReqOut(ReqListRow):
    warehouse_id: int | None = None
    project_id: int | None = None
    remarks: str | None = None
    approved_by_name: str | None = None
    approved_at: datetime | None = None
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
    warehouse_id: int | None = None
    project_id: int | None = None
    due_date: date | None = None
    terms: str | None = None
    vendor_ids: list[int] = []
    lines: list[RFQLineIn] = Field(min_length=1)


class RFQUpdate(BaseModel):
    """Every field optional: this is a PATCH in a PUT's clothing, because the RFQ
    form saves the whole header and the caller should not have to resend the lines
    to move a deadline."""
    title: str | None = None
    due_date: date | None = None
    terms: str | None = None
    warehouse_id: int | None = None
    project_id: int | None = None
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
    created_at: datetime


class RFQOut(RFQListRow):
    requisition_id: int | None = None
    requisition_no: str | None = None
    warehouse_id: int | None = None
    warehouse_name: str | None = None
    project_id: int | None = None
    project_name: str | None = None
    terms: str | None = None
    awarded_vendor_id: int | None = None
    created_by_name: str | None = None
    items: list[RFQItemOut] = []
    vendors: list[RFQVendorOut] = []


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
