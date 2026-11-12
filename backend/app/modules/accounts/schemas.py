"""Accounts request/response shapes."""
from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from app.shared.org_scope_schemas import OrgScopeIn, OrgScopeOut


class PaymentIn(OrgScopeIn):
    """Record one payment against one milestone of one PO.

    The number card (2026-11-12): a payment against an organised PO COPIES the PO's
    organisation and project and only its year is picked; against an older PO they are
    selected here. Sent with none of them, it keeps the old numbering."""
    po_id: int
    milestone_id: int
    amount: Decimal = Field(gt=0, max_digits=16, decimal_places=2)
    paid_on: date
    mode: str = Field(min_length=1, max_length=20)
    reference_no: str | None = Field(None, max_length=100)
    invoice_attachment_id: int | None = None
    remarks: str | None = Field(None, max_length=2000)


class PaymentActionIn(BaseModel):
    action: str                       # APPROVE | REJECT
    remarks: str | None = Field(None, max_length=2000)


class DocumentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    file_name: str
    file_size: int | None = None
    doc_category: str | None = None
    uploaded_by_name: str | None = None
    created_at: datetime | None = None


class PaymentOut(OrgScopeOut):
    model_config = ConfigDict(from_attributes=True)
    id: int
    payment_no: str
    project_id: int | None = None
    project_name: str | None = None
    po_id: int
    po_no: str | None = None
    milestone_id: int
    stage: str
    stage_label: str | None = None
    vendor_id: int
    vendor_name: str | None = None
    amount: float
    paid_on: date
    mode: str
    reference_no: str | None = None
    invoice_attachment_id: int | None = None
    remarks: str | None = None
    status: str
    current_approver_name: str | None = None
    created_by_name: str | None = None
    approved_by_name: str | None = None
    approved_at: datetime | None = None
    created_at: datetime | None = None
    # Bank advice / UTR screenshot / cheque scan the payer attached.
    proofs: list[DocumentOut] = []
    # Can THIS login approve or reject it right now. Served, never derived on screen.
    can_act: bool = False


class MilestoneOut(BaseModel):
    """One stage of a PO's payment terms, with what it comes to and what is left."""
    id: int
    seq: int
    stage: str
    code: str = ""          # ADV 1/1, DLV 2/4: the stage's short code, nth of its count
    label: str
    trigger: str
    percent: float
    due_days: int
    amount: float
    paid: float
    pending: float          # recorded, awaiting approval
    balance: float          # amount - paid - pending: what may still be recorded
    trigger_met: bool | None = None     # None = the system cannot tell; accounts confirms
    due_date: date | None = None
    state: str              # NOT_DUE | DUE | OVERDUE | PART_PAID | PAID | CONFIRM


class PoPaymentsOut(OrgScopeOut):
    """Everything accounts (and the PO desk) needs about one order's money."""
    po_id: int
    po_no: str
    po_status: str
    project_id: int | None = None
    vendor_id: int
    vendor_name: str | None = None
    project_name: str | None = None
    po_date: date | None = None
    approved_at: datetime | None = None
    payment_terms: str | None = None
    total_amount: float
    paid: float
    pending: float
    outstanding: float
    milestones: list[MilestoneOut] = []
    payments: list[PaymentOut] = []
    documents: list[DocumentOut] = []


class PayableRow(BaseModel):
    """One order on the desk's list."""
    po_id: int
    po_no: str
    po_status: str
    vendor_name: str | None = None
    project_name: str | None = None
    po_date: date | None = None
    payment_terms: str | None = None
    total_amount: float
    paid: float
    pending: float
    outstanding: float
    invoices: int = 0
    next_stage: str | None = None
    next_due_date: date | None = None
    next_state: str | None = None


class CarrierInvoiceRow(BaseModel):
    """A freight invoice a carrier filed against a shipment."""
    attachment_id: int
    tr_id: int
    tr_no: str
    tr_status: str
    carrier_name: str | None = None
    freight_amount: float | None = None
    file_name: str
    uploaded_at: datetime | None = None
