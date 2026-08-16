"""pro_ tables — the buying chain. Owned by modules/procurement.

Backward pointer only: a PO stores indent_id; an indent never stores its PO id. The
same rule runs down the whole chain:

    Requisition  ->  RFQ (`requisition_id`)  ->  Quotation (`rfq_id`)  ->  PO

Table names are the ones the DB team already created in the QA schema
(`pro_requisitions`, `pro_quotations`, …), not the `pro_material_requests` /
`pro_supplier_quotations` spelling an earlier draft of this code used. Their columns
are also the ones kept: they snapshot `item_code`, `item_name`, `vendor_name` and
`warehouse_name` inline, which is rule 10 — a document must still read correctly after
a master is renamed.
"""
from sqlalchemy import (
    Column, Boolean, Date, DateTime, ForeignKey, Integer, Numeric, String, Text, Index,
)
from sqlalchemy.orm import relationship

from app.core.database import Base
from app.shared.models.base import created_at_col, pk, soft_fk, updated_at_col


class PurchaseOrder(Base):
    __tablename__ = "pro_purchase_orders"
    id = pk()
    po_no = Column(String(30), unique=True, nullable=False)
    po_date = Column(Date, nullable=True)
    expected_date = Column(Date, nullable=True)

    indent_id = Column(ForeignKey("ind_indents.id"), index=True, nullable=True)  # backward pointer
    indent_no = Column(String(30), nullable=True)   # snapshot

    vendor_id = Column(ForeignKey("mst_vendors.id"), index=True, nullable=False)
    vendor_name = Column(String(200), nullable=True)   # snapshot
    vendor_gstin = Column(String(20), nullable=True)   # snapshot

    created_by_id = soft_fk()
    created_by_name = Column(String(200), nullable=True)  # snapshot
    office_id = soft_fk()
    facility_id = soft_fk()
    facility_name = Column(String(200), nullable=True)

    status = Column(String(30), nullable=False, index=True)
    sub_total = Column(Numeric(16, 2), nullable=False, default=0)
    tax_amount = Column(Numeric(16, 2), nullable=False, default=0)
    total_amount = Column(Numeric(16, 2), nullable=False, default=0)
    current_approver_name = Column(String(200), nullable=True)
    approved_at = Column(DateTime(timezone=True), nullable=True)
    remarks = Column(Text, nullable=True)
    created_at = created_at_col()
    updated_at = updated_at_col()

    items = relationship(
        "POItem", back_populates="po",
        cascade="all, delete-orphan", lazy="selectin",
    )


Index("ix_pro_po_date", PurchaseOrder.po_date.desc())


class POItem(Base):
    __tablename__ = "pro_po_items"
    id = pk()
    po_id = Column(ForeignKey("pro_purchase_orders.id", ondelete="CASCADE"), index=True, nullable=False)
    indent_item_id = Column(ForeignKey("ind_indent_items.id"), index=True, nullable=True)
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    item_code = Column(String(50), nullable=True)
    item_name = Column(String(300), nullable=True)
    uom_code = Column(String(20), nullable=True)
    quantity = Column(Numeric(14, 3), nullable=False)
    rate = Column(Numeric(14, 2), nullable=False, default=0)
    tax_percent = Column(Numeric(5, 2), nullable=False, default=0)
    amount = Column(Numeric(16, 2), nullable=False, default=0)
    received_quantity = Column(Numeric(14, 3), nullable=False, default=0)

    po = relationship("PurchaseOrder", back_populates="items")


# --------------------------------------------------------------------------- #
#  Requisition — what a buyer wants to buy
# --------------------------------------------------------------------------- #

class Requisition(Base):
    """`pro_requisitions`. Procurement's own demand note.

    Not `inv_material_requests`: that one is raised BY the system when an approved
    indent cannot be filled from stock. This is raised by a buyer, for anything, and
    it is the head of the RFQ chain.
    """
    __tablename__ = "pro_requisitions"
    id = pk()
    req_no = Column(String(30), unique=True, nullable=False)
    req_date = Column(Date, nullable=True)

    warehouse_id = soft_fk()
    warehouse_name = Column(String(200), nullable=True)   # snapshot
    project_id = soft_fk()
    project_name = Column(String(200), nullable=True)     # snapshot

    status = Column(String(30), nullable=False, index=True)
    # Added to the DB team's columns: urgency is on the raising form and it is what
    # a buyer sorts the queue by. One column beats a convention buried in remarks.
    priority = Column(String(20), nullable=True)

    total_items = Column(Integer, nullable=False, default=0)
    estimated_value = Column(Numeric(16, 2), nullable=False, default=0)

    current_approver_name = Column(String(200), nullable=True)
    approved_by_name = Column(String(200), nullable=True)
    approved_at = Column(DateTime(timezone=True), nullable=True)
    remarks = Column(Text, nullable=True)

    # The material request this came from, when Purchase picked one up rather than
    # raising a demand of its own. Every document in this chain points BACKWARD at the
    # one before it; without this the trail broke between inventory and procurement and
    # somebody had to retype the lines. Soft FK — inventory owns that table.
    source_mr_id = soft_fk()
    source_mr_no = Column(String(30), nullable=True)     # snapshot

    created_by_id = soft_fk()
    created_by_name = Column(String(200), nullable=True)  # snapshot
    created_at = created_at_col()
    updated_at = updated_at_col()

    items = relationship("RequisitionItem", back_populates="requisition",
                         cascade="all, delete-orphan", lazy="selectin")


Index("ix_pro_req_status_created", Requisition.status, Requisition.created_at.desc())


class RequisitionItem(Base):
    __tablename__ = "pro_requisition_items"
    id = pk()
    requisition_id = Column(ForeignKey("pro_requisitions.id", ondelete="CASCADE"),
                            index=True, nullable=False)
    line_no = Column(Integer, nullable=False, default=1)

    # Backward pointers, both optional: a requisition may be raised cold, or it may
    # come off an indent that stock could not fill.
    indent_id = soft_fk()
    indent_no = Column(String(30), nullable=True)         # snapshot
    indent_item_id = soft_fk()

    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    item_code = Column(String(50), nullable=True)         # snapshot
    item_name = Column(String(300), nullable=True)        # snapshot
    uom_code = Column(String(20), nullable=True)
    quantity = Column(Numeric(16, 3), nullable=False)
    # How much of `quantity` has reached a PO. Lets a requisition be bought in parts.
    ordered_qty = Column(Numeric(16, 3), nullable=False, default=0)
    estimated_rate = Column(Numeric(16, 2), nullable=False, default=0)
    estimated_amount = Column(Numeric(16, 2), nullable=False, default=0)
    required_date = Column(Date, nullable=True)

    requisition = relationship("Requisition", back_populates="items")


# --------------------------------------------------------------------------- #
#  RFQ — what went out to vendors
# --------------------------------------------------------------------------- #

class RFQ(Base):
    __tablename__ = "pro_rfqs"
    id = pk()
    rfq_no = Column(String(30), unique=True, nullable=False)
    rfq_type = Column(String(20), nullable=True)
    rfq_date = Column(Date, nullable=True)
    # The submission deadline. A vendor may read after it and may not quote.
    due_date = Column(Date, nullable=True)

    requisition_id = Column(ForeignKey("pro_requisitions.id"), index=True, nullable=True)
    requisition_no = Column(String(30), nullable=True)    # snapshot

    warehouse_id = soft_fk()
    warehouse_name = Column(String(200), nullable=True)   # snapshot
    project_id = soft_fk()
    project_name = Column(String(200), nullable=True)     # snapshot

    title = Column(String(300), nullable=True)
    status = Column(String(30), nullable=False, index=True)
    total_items = Column(Integer, nullable=False, default=0)
    vendor_count = Column(Integer, nullable=False, default=0)
    response_count = Column(Integer, nullable=False, default=0)

    # How the quotes are ranked. Nullable, and read through
    # `evaluation.method_of()` — an RFQ raised before this column existed has no
    # opinion and gets the default (lowest landed cost), which is exactly what the
    # old `ORDER BY grand_total` was already doing.
    evaluation_method = Column(String(30), nullable=True)
    # The consolidated sheet this RFQ is buying against, when it came off one.
    # Backward pointer, like every other link in this chain.
    consolidation_id = soft_fk()
    consolidation_no = Column(String(30), nullable=True)  # snapshot

    awarded_vendor_id = Column(ForeignKey("mst_vendors.id"), index=True, nullable=True)
    awarded_vendor_name = Column(String(200), nullable=True)   # snapshot
    terms = Column(Text, nullable=True)
    current_approver_name = Column(String(200), nullable=True)

    created_by_id = soft_fk()
    created_by_name = Column(String(200), nullable=True)  # snapshot
    created_at = created_at_col()
    updated_at = updated_at_col()

    items = relationship("RFQItem", back_populates="rfq",
                         cascade="all, delete-orphan", lazy="selectin")
    vendors = relationship("RFQVendor", back_populates="rfq",
                           cascade="all, delete-orphan", lazy="selectin")


class RFQItem(Base):
    __tablename__ = "pro_rfq_items"
    id = pk()
    rfq_id = Column(ForeignKey("pro_rfqs.id", ondelete="CASCADE"),
                    index=True, nullable=False)
    line_no = Column(Integer, nullable=False, default=1)
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    item_code = Column(String(50), nullable=True)         # snapshot
    item_name = Column(String(300), nullable=True)        # snapshot
    description = Column(Text, nullable=True)
    uom_code = Column(String(20), nullable=True)
    quantity = Column(Numeric(16, 3), nullable=False)
    required_date = Column(Date, nullable=True)

    rfq = relationship("RFQ", back_populates="items")


class RFQVendor(Base):
    """Who the RFQ went to, and how they get in."""
    __tablename__ = "pro_rfq_vendors"
    id = pk()
    rfq_id = Column(ForeignKey("pro_rfqs.id", ondelete="CASCADE"),
                    index=True, nullable=False)
    vendor_id = Column(ForeignKey("mst_vendors.id"), index=True, nullable=False)
    vendor_name = Column(String(200), nullable=True)      # snapshot
    vendor_email = Column(String(200), nullable=True)     # snapshot
    # Added to the DB team's columns. A single-use link is what lets a vendor who has
    # no portal account still open exactly this RFQ and nothing else — without it the
    # only way in is a password, and most vendors will never have one.
    access_token = Column(String(100), unique=True, nullable=True, index=True)
    sent_at = Column(DateTime(timezone=True), nullable=True)
    responded_at = Column(DateTime(timezone=True), nullable=True)
    status = Column(String(30), nullable=True)

    rfq = relationship("RFQ", back_populates="vendors")


# --------------------------------------------------------------------------- #
#  Quotation — what a vendor answered
# --------------------------------------------------------------------------- #

class Quotation(Base):
    __tablename__ = "pro_quotations"
    id = pk()
    quotation_no = Column(String(50), unique=True, nullable=False)
    quotation_type = Column(String(20), nullable=True)

    rfq_id = Column(ForeignKey("pro_rfqs.id", ondelete="CASCADE"),
                    index=True, nullable=False)
    rfq_no = Column(String(30), nullable=True)            # snapshot
    vendor_id = Column(ForeignKey("mst_vendors.id"), index=True, nullable=False)
    vendor_name = Column(String(200), nullable=True)      # snapshot
    vendor_ref_no = Column(String(50), nullable=True)

    quotation_date = Column(Date, nullable=True)
    valid_till = Column(Date, nullable=True)
    # Added: what the vendor promises on the portal form. `delivery_days` is per line
    # and this is the header commitment; a buyer compares on this one.
    expected_delivery_date = Column(Date, nullable=True)
    currency = Column(String(10), nullable=True)

    sub_total = Column(Numeric(16, 2), nullable=False, default=0)
    discount_amount = Column(Numeric(16, 2), nullable=False, default=0)
    tax_amount = Column(Numeric(16, 2), nullable=False, default=0)
    freight_amount = Column(Numeric(16, 2), nullable=False, default=0)
    grand_total = Column(Numeric(16, 2), nullable=False, default=0)

    payment_terms = Column(String(200), nullable=True)
    delivery_days = Column(Integer, nullable=True)
    status = Column(String(30), nullable=False, index=True)
    # Where this quote came in the buyer's comparison. 1 is best under whichever
    # method the RFQ was evaluated by — not always "cheapest by total" any more.
    rank_position = Column(Integer, nullable=True)
    # The score that produced that rank, snapshotted at award. Higher is better under
    # every method, so a reader never has to know which one was used to see who won.
    evaluation_score = Column(Numeric(10, 4), nullable=True)
    remarks = Column(Text, nullable=True)
    # Added: a vendor may re-quote until the deadline, and a buyer must be able to
    # tell a first offer from a fourth one without diffing timestamps.
    revision_count = Column(Integer, nullable=False, default=0)
    submitted_at = Column(DateTime(timezone=True), nullable=True)

    created_by_id = soft_fk()
    created_at = created_at_col()

    items = relationship("QuotationItem", back_populates="quotation",
                         cascade="all, delete-orphan", lazy="selectin")


class QuotationItem(Base):
    __tablename__ = "pro_quotation_items"
    id = pk()
    quotation_id = Column(ForeignKey("pro_quotations.id", ondelete="CASCADE"),
                          index=True, nullable=False)
    line_no = Column(Integer, nullable=False, default=1)
    rfq_item_id = Column(ForeignKey("pro_rfq_items.id"), index=True, nullable=True)
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    item_code = Column(String(50), nullable=True)         # snapshot
    item_name = Column(String(300), nullable=True)        # snapshot
    description = Column(Text, nullable=True)
    uom_code = Column(String(20), nullable=True)
    quantity = Column(Numeric(16, 3), nullable=False)
    rate = Column(Numeric(16, 2), nullable=False, default=0)
    discount_percent = Column(Numeric(5, 2), nullable=False, default=0)
    tax_percent = Column(Numeric(5, 2), nullable=False, default=0)
    # Added: the split the vendor actually quoted. Derived from the HSN at read time
    # would be wrong — a quotation is an offer, and the offer's own numbers are what
    # a buyer compares and what the PO is raised against.
    cgst_rate = Column(Numeric(5, 2), nullable=True)
    sgst_rate = Column(Numeric(5, 2), nullable=True)
    igst_rate = Column(Numeric(5, 2), nullable=True)
    amount = Column(Numeric(16, 2), nullable=False, default=0)
    delivery_days = Column(Integer, nullable=True)

    quotation = relationship("Quotation", back_populates="items")


# --------------------------------------------------------------------------- #
#  Vendor portal identity
# --------------------------------------------------------------------------- #

class VendorUser(Base):
    """A login for someone outside the company.

    Identity in SCM is otherwise always `hcm_employees` — a vendor is not an employee
    and never will be, so it cannot ride on that table or on `sys_local_credentials`
    (keyed on employee id). One row per vendor, and the token it mints carries
    `typ: "vendor"` so `get_current_user` refuses it outright: a leaked vendor token
    must not reach a single internal endpoint, permissions or no permissions.
    """
    __tablename__ = "pro_vendor_users"
    id = pk()
    vendor_id = Column(ForeignKey("mst_vendors.id", ondelete="CASCADE"),
                       unique=True, nullable=False)
    username = Column(String(100), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    is_active = Column(Boolean, nullable=False, default=True)
    # Seeded accounts all share one password. Until it is changed, the portal shows
    # nothing but the change-password form.
    must_change_password = Column(Boolean, nullable=False, default=True)
    last_login_at = Column(DateTime(timezone=True), nullable=True)
    created_at = created_at_col()
    updated_at = updated_at_col()


# --------------------------------------------------------------------------- #
#  The consolidated buying sheet
# --------------------------------------------------------------------------- #
#  Doc B7: the PO team rolls the month's requisitions into ONE sheet the CPO and the
#  SCM Head sign, instead of forty documents nobody can see a total across.
#
#  Item-wise, not requisition-wise. That is the whole point: the same bandage asked
#  for by nine districts is one line with one quantity, which is what gets tendered.
#  The requisitions it came from are kept on the line (`sources`) so the sheet can
#  always answer "who asked for this" without the aggregation being reversible only
#  by re-running it.

class PurchaseConsolidation(Base):
    """`pro_consolidations` — many requisitions, one buying sheet.

    `PurchaseConsolidation`, not `Consolidation`: `modules/indents` already maps a
    `Consolidation` (`ind_consolidations`, where indents are grouped region/phase/
    vehicle-wise). Two classes of the same name in one declarative registry makes
    every string-based `relationship("Consolidation")` ambiguous and fails mapper
    configuration for the whole app, not just this module. The frontend pages carry
    the same prefix for the same reason — they are different documents.
    """
    __tablename__ = "pro_consolidations"
    id = pk()
    cons_no = Column(String(30), unique=True, nullable=False)
    cons_date = Column(Date, nullable=True)
    title = Column(String(300), nullable=True)
    # What the sheet covers, in the buyer's words: "August 2026 — Southern region".
    period_label = Column(String(100), nullable=True)

    project_id = soft_fk()
    project_name = Column(String(200), nullable=True)     # snapshot
    warehouse_id = soft_fk()
    warehouse_name = Column(String(200), nullable=True)   # snapshot

    status = Column(String(30), nullable=False, index=True)
    total_items = Column(Integer, nullable=False, default=0)
    # How many requisitions were folded in. Kept on the header because it is the first
    # thing anyone asks of a consolidated sheet and counting it means loading lines.
    source_count = Column(Integer, nullable=False, default=0)
    estimated_value = Column(Numeric(16, 2), nullable=False, default=0)

    current_approver_name = Column(String(200), nullable=True)
    approved_by_name = Column(String(200), nullable=True)
    approved_at = Column(DateTime(timezone=True), nullable=True)
    remarks = Column(Text, nullable=True)

    created_by_id = soft_fk()
    created_by_name = Column(String(200), nullable=True)  # snapshot
    created_position_id = soft_fk()
    created_at = created_at_col()
    updated_at = updated_at_col()

    items = relationship("PurchaseConsolidationItem", back_populates="consolidation",
                         cascade="all, delete-orphan", lazy="selectin",
                         order_by="PurchaseConsolidationItem.line_no")


Index("ix_pro_cons_status_created", PurchaseConsolidation.status,
      PurchaseConsolidation.created_at.desc())


class PurchaseConsolidationItem(Base):
    """`pro_consolidation_items` — one line per ITEM, whatever it was asked on."""
    __tablename__ = "pro_consolidation_items"
    id = pk()
    consolidation_id = Column(ForeignKey("pro_consolidations.id", ondelete="CASCADE"),
                              index=True, nullable=False)
    line_no = Column(Integer, nullable=False, default=1)

    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    item_code = Column(String(50), nullable=True)         # snapshot
    item_name = Column(String(300), nullable=True)        # snapshot
    uom_code = Column(String(20), nullable=True)

    # The sum of every requisition line for this item.
    quantity = Column(Numeric(16, 3), nullable=False, default=0)
    # What the buyer decided to actually tender, which is not always what was asked:
    # a sheet is where over-ordering gets trimmed. Defaults to `quantity`.
    approved_qty = Column(Numeric(16, 3), nullable=False, default=0)
    estimated_rate = Column(Numeric(16, 2), nullable=False, default=0)
    estimated_amount = Column(Numeric(16, 2), nullable=False, default=0)
    required_date = Column(Date, nullable=True)

    # Which requisitions fed this line, as "REQ/2026-27/00012 x 40" text. Held on the
    # line rather than in a third table: it is read as one block, never queried by
    # requisition, and a join table here would triple the writes for a string nobody
    # filters on. The requisition ids stay authoritative on `pro_requisition_items`.
    sources = Column(Text, nullable=True)
    source_count = Column(Integer, nullable=False, default=0)
    remarks = Column(Text, nullable=True)

    consolidation = relationship("PurchaseConsolidation", back_populates="items")


class PurchaseConsolidationSource(Base):
    """`pro_consolidation_sources` — which requisitions are on this sheet.

    The header-level membership list, kept apart from the item lines because it
    answers a different question ("is REQ/…/12 already consolidated?") and has to be
    queryable by requisition id — which the text blob on the line deliberately is not.
    """
    __tablename__ = "pro_consolidation_sources"
    id = pk()
    consolidation_id = Column(ForeignKey("pro_consolidations.id", ondelete="CASCADE"),
                              index=True, nullable=False)
    requisition_id = Column(ForeignKey("pro_requisitions.id"), index=True,
                            nullable=False)
    requisition_no = Column(String(30), nullable=True)    # snapshot
    project_name = Column(String(200), nullable=True)     # snapshot
    item_count = Column(Integer, nullable=False, default=0)
    estimated_value = Column(Numeric(16, 2), nullable=False, default=0)


Index("ix_pro_cons_source_req", PurchaseConsolidationSource.requisition_id)
