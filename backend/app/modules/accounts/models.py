"""acc_ tables — vendor payments. Owned by modules/accounts (2026-10-06).

What a PO owes is NOT stored here. It is READ off the order: each frozen milestone on
`pro_po_payment_milestones` is `percent x total_amount`, and what is still due is that
less the payments below. A payment is the only fact accounts records, and it points
BACKWARD at the order and the milestone it settles, like every other link in the chain.
"""
from sqlalchemy import Column, Date, DateTime, ForeignKey, Index, Numeric, String, Text

from app.core.database import Base
from app.platform.workflow import doc_registry
from app.shared.enums import DocType, VendorPaymentStatus
from app.shared.models.base import created_at_col, pk, soft_fk, updated_at_col


class VendorPayment(Base):
    """`acc_vendor_payments` — money paid (or about to be) against one PO milestone.

    Recorded by the accounts desk, signed on the VENDOR_PAYMENT ladder. Only a PAID row
    counts against the milestone; a PENDING_APPROVAL row still holds its amount so two
    people cannot each record the whole balance; a REJECTED row counts for nothing.
    """
    __tablename__ = "acc_vendor_payments"
    id = pk()
    payment_no = Column(String(30), unique=True, nullable=False)

    po_id = Column(ForeignKey("pro_purchase_orders.id"), index=True, nullable=False)
    po_no = Column(String(30), nullable=True)                  # snapshot
    milestone_id = Column(ForeignKey("pro_po_payment_milestones.id"), index=True,
                          nullable=False)
    stage = Column(String(30), nullable=False)                 # snapshot
    vendor_id = Column(ForeignKey("mst_vendors.id"), index=True, nullable=False)
    vendor_name = Column(String(200), nullable=True)           # snapshot
    project_id = soft_fk()

    amount = Column(Numeric(16, 2), nullable=False)
    paid_on = Column(Date, nullable=False)
    mode = Column(String(20), nullable=False)                  # PaymentMode
    reference_no = Column(String(100), nullable=True)          # UTR / cheque no.
    # The supplier's invoice this payment settles, when they filed one on the portal.
    invoice_attachment_id = soft_fk()
    remarks = Column(Text, nullable=True)

    status = Column(String(30), nullable=False, index=True,
                    default=VendorPaymentStatus.PENDING_APPROVAL.value)
    current_approver_name = Column(String(200), nullable=True)
    created_by_id = soft_fk()
    created_by_name = Column(String(200), nullable=True)
    approved_by_id = soft_fk()
    approved_by_name = Column(String(200), nullable=True)
    approved_at = Column(DateTime(timezone=True), nullable=True)
    created_at = created_at_col()
    updated_at = updated_at_col()


Index("ix_acc_payment_milestone_status", VendorPayment.milestone_id, VendorPayment.status)

doc_registry.register(DocType.VENDOR_PAYMENT.value, "acc_vendor_payments")
