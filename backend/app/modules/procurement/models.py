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
    BigInteger, Column, Boolean, Date, DateTime, ForeignKey, Integer, JSON, Numeric,
    String, Text, Index,
)
from sqlalchemy.orm import relationship

from app.core.database import Base
from app.platform.workflow import doc_registry
from app.shared.enums import DocType
from app.shared.enums import DespatchNoteStatus, PackChangeStatus
from app.shared.models.base import created_at_col, pk, soft_fk, updated_at_col


class PurchaseOrder(Base):
    __tablename__ = "pro_purchase_orders"
    id = pk()
    po_no = Column(String(30), unique=True, nullable=False)
    po_date = Column(Date, nullable=True)
    expected_date = Column(Date, nullable=True)

    indent_id = Column(ForeignKey("ind_indents.id"), index=True, nullable=True)  # backward pointer
    indent_no = Column(String(30), nullable=True)   # snapshot

    # The buying chain this PO came off, when it was raised from an award rather than
    # straight off an indent. Soft FKs, all nullable: a PO raised from an indent has
    # none of them, and the quotation is what carries the vendor, the rates and the tax
    # the PO is written with — without it the winning offer had to be retyped and the
    # trail indent -> MR -> requisition -> RFQ -> quotation -> PO broke at the last hop.
    requisition_id = soft_fk()
    requisition_no = Column(String(30), nullable=True)    # snapshot
    rfq_id = soft_fk()
    rfq_no = Column(String(30), nullable=True)            # snapshot
    quotation_id = soft_fk()
    quotation_no = Column(String(50), nullable=True)      # snapshot

    # The order this one was copied from (2026-10-19). A reference for the reader and
    # nothing more: a copy is a new hand-raised order, so no quantity, approval or
    # payment is ever rolled back along it.
    copied_from_po_id = soft_fk()
    copied_from_po_no = Column(String(30), nullable=True)  # snapshot

    vendor_id = Column(ForeignKey("mst_vendors.id"), index=True, nullable=False)
    vendor_name = Column(String(200), nullable=True)   # snapshot
    vendor_gstin = Column(String(20), nullable=True)   # snapshot

    created_by_id = soft_fk()
    created_by_name = Column(String(200), nullable=True)  # snapshot
    office_id = soft_fk()
    facility_id = soft_fk()
    facility_name = Column(String(200), nullable=True)
    project_id = soft_fk()
    project_name = Column(String(200), nullable=True)     # snapshot

    # What the order says besides its lines. Free text on purpose: a term is what was
    # agreed with THIS vendor for THIS order, and every attempt to code them into a
    # picklist ends with somebody typing the real one into remarks anyway.
    payment_terms = Column(Text, nullable=True)
    # The payment-term MASTER picked for this order (2026-10-06). Its milestones are
    # copied onto `pro_po_payment_milestones` at that moment, so editing the master
    # never moves an order already raised; `payment_terms` above carries its wording.
    payment_term_id = soft_fk()
    delivery_terms = Column(Text, nullable=True)
    material_terms = Column(Text, nullable=True)
    logistics_terms = Column(Text, nullable=True)
    billing_address = Column(Text, nullable=True)
    shipping_address = Column(Text, nullable=True)

    status = Column(String(30), nullable=False, index=True)
    sub_total = Column(Numeric(16, 2), nullable=False, default=0)
    # Document-level money, on top of the line amounts. Both are stored rather than
    # derived: a freight charge and a negotiated discount belong to the ORDER, not to
    # any one line, and splitting them across lines would rewrite rates the vendor
    # quoted. total = sub_total - discount + tax + freight.
    discount_amount = Column(Numeric(16, 2), nullable=False, default=0)
    freight_amount = Column(Numeric(16, 2), nullable=False, default=0)
    tax_amount = Column(Numeric(16, 2), nullable=False, default=0)
    total_amount = Column(Numeric(16, 2), nullable=False, default=0)
    current_approver_name = Column(String(200), nullable=True)
    approved_at = Column(DateTime(timezone=True), nullable=True)
    remarks = Column(Text, nullable=True)

    # --- the vendor's answer -------------------------------------------------
    # An order becomes an agreement when the other side says yes. PENDING from the
    # moment it is sent; nothing may be received against an order still waiting, and
    # an ACCEPTED order can only be changed by an amendment they accept again.
    vendor_status = Column(String(20), nullable=True, index=True)
    vendor_responded_at = Column(DateTime(timezone=True), nullable=True)
    vendor_response_note = Column(Text, nullable=True)

    # --- amendments ----------------------------------------------------------
    # 0 is the original. Each amendment writes the whole previous order into
    # pro_po_revisions first, so what the vendor agreed to before is never overwritten.
    revision_no = Column(Integer, nullable=False, default=0)
    amended_at = Column(DateTime(timezone=True), nullable=True)
    amendment_reason = Column(Text, nullable=True)

    created_at = created_at_col()
    updated_at = updated_at_col()

    items = relationship(
        "POItem", back_populates="po",
        cascade="all, delete-orphan", lazy="selectin",
    )
    payment_milestones = relationship(
        "POPaymentMilestone", cascade="all, delete-orphan", lazy="selectin",
        order_by="POPaymentMilestone.seq",
    )


class POPaymentMilestone(Base):
    """`pro_po_payment_milestones` — one stage of the order's payment terms, frozen.

    Only the SHARE is stored. The amount is read as `percent x total_amount`, so an
    amendment that changes the order value moves what is due without anybody having to
    rewrite these rows. What has been PAID against a milestone is the accounts module's
    (`acc_vendor_payments.milestone_id`), never written here.
    """
    __tablename__ = "pro_po_payment_milestones"
    id = pk()
    po_id = Column(ForeignKey("pro_purchase_orders.id", ondelete="CASCADE"),
                   index=True, nullable=False)
    seq = Column(Integer, nullable=False, default=1)
    stage = Column(String(30), nullable=False)          # PaymentMilestoneStage
    percent = Column(Numeric(5, 2), nullable=False)
    due_days = Column(Integer, nullable=False, default=0)


class PORevision(Base):
    """What a purchase order said BEFORE an amendment changed it.

    A snapshot, not a diff: the point of a revision is to be able to show the vendor
    the exact paper they agreed to, and a diff can only be read against a version that
    still exists. The whole header and every line go into `snapshot` as JSON.

    Append-only, like every audit trail here (rule 9). Nothing updates or deletes a
    revision row, including cancelling the order it belongs to.
    """
    __tablename__ = "pro_po_revisions"
    id = pk()
    po_id = Column(ForeignKey("pro_purchase_orders.id", ondelete="CASCADE"),
                   index=True, nullable=False)
    revision_no = Column(Integer, nullable=False, default=0)
    reason = Column(Text, nullable=True)
    # The status and the vendor's answer AT THE TIME, so a reader can tell an
    # amendment made before the vendor ever saw the order from one made after they
    # had accepted it — the two mean very different things.
    status = Column(String(30), nullable=True)
    vendor_status = Column(String(20), nullable=True)
    snapshot = Column(JSON, nullable=True)
    changed_by_id = soft_fk()
    changed_by_name = Column(String(200), nullable=True)
    created_at = created_at_col()


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
    # How many days the vendor said THIS line takes, carried off the quotation line
    # that won. Per line because a quotation states it per line: one order commonly
    # mixes something on the shelf with something built to order, and a single header
    # date cannot say that. Nullable — a PO raised from an indent has no quotation
    # behind it and nobody promised anything.
    delivery_days = Column(Integer, nullable=True)
    received_quantity = Column(Numeric(14, 3), nullable=False, default=0)
    # HOW the quantity is to be packed (2026-10-08): one of the item's pack
    # hierarchies, and a breakdown inside it ("2 Carton"). `quantity` stays the truth,
    # in the item's base unit; the breakdown always adds up to it — see
    # `app/shared/packing.py`. NULL on lines written before packing existed.
    pack_hierarchy_id = Column(BigInteger, index=True, nullable=True)
    pack_breakdown = Column(JSON, nullable=True)

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
    # Who is asking, and on whose paper. Both were being derived from the raiser's HCM
    # record, which is right until somebody raises on behalf of another department —
    # and a buyer could not correct it because there was nowhere to put the answer.
    # Nullable: an existing row keeps reading from the raiser (service._header_context).
    department_id = soft_fk()
    department_name = Column(String(200), nullable=True)  # snapshot
    company_name = Column(String(200), nullable=True)     # snapshot of the settings value

    status = Column(String(30), nullable=False, index=True)
    # Added to the DB team's columns: urgency is on the raising form and it is what
    # a buyer sorts the queue by. One column beats a convention buried in remarks.
    priority = Column(String(20), nullable=True)
    # One date for the whole document. It was asked per line, which meant typing the
    # same date forty times; a line that genuinely differs still carries its own.
    required_date = Column(Date, nullable=True)

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


class RequisitionSource(Base):
    """`pro_requisition_sources` — which material requests a requisition was built from.

    `Requisition.source_mr_id` holds one, which was the whole story while one MR became
    one requisition. It no longer is: MRs are raised one item at a time and the same
    item comes in on several of them, so Purchase consolidates a batch into a single
    demand and tenders it once.

    Kept as its own table rather than a list on the header for the reason
    `pro_consolidation_sources` exists: the question asked of it is "is this MR already
    consolidated?", which has to be answered by MR id, and a text blob cannot be
    queried. It is also what stops an MR being consolidated twice.
    """
    __tablename__ = "pro_requisition_sources"
    id = pk()
    requisition_id = Column(ForeignKey("pro_requisitions.id", ondelete="CASCADE"),
                            index=True, nullable=False)
    # Soft FK: inventory owns inv_material_requests and a module may not hard-link
    # across (rule 10).
    mr_id = soft_fk()
    mr_no = Column(String(30), nullable=True)             # snapshot
    indent_no = Column(String(30), nullable=True)         # snapshot, for the trail
    item_count = Column(Integer, nullable=False, default=0)
    created_at = created_at_col()


Index("ix_pro_req_source_mr", RequisitionSource.mr_id)


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
    # Carried from the requisition where there is one, typed on the form where there
    # is not: an RFQ raised cold still has to say who is buying and on whose paper.
    department_id = soft_fk()
    department_name = Column(String(200), nullable=True)  # snapshot
    company_name = Column(String(200), nullable=True)     # snapshot

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

    # ── Freeze Prices (2026-09-26) ───────────────────────────────────────── #
    # The lock a buyer closes BEFORE comparing and awarding, and the gate every
    # PO raised off this tender hangs on. While it is open, a supplier's price is
    # still an opinion; once it is closed, prices are arithmetic.
    #
    # Deliberately a COLUMN, not a status: every existing RFQStatus filter, KPI,
    # badge and report keeps its meaning, and "open but frozen" — the state a
    # buyer needs while they read the sheet — is expressible without inventing a
    # status no other reader knows.
    is_price_frozen = Column(Boolean, nullable=False, default=False)
    frozen_at = Column(DateTime(timezone=True), nullable=True)
    frozen_by_id = soft_fk()
    frozen_by_name = Column(String(200), nullable=True)   # snapshot
    # How many quotations were in when the buyer closed the door. A comparison
    # sheet whose row count changed after the freeze date is worth a question —
    # this is what makes "frozen at 4 quotes, 5 came in later" checkable.
    frozen_at_revision = Column(Integer, nullable=True)

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
    # The RFQ item master IDs this vendor was tagged to supply when the buyer saved
    # the invitation. A snapshot keeps an issued tender stable if mappings change.
    mapped_item_ids = Column(JSON, nullable=True)
    # Item id -> quantity this supplier is being asked to quote. Stored with the
    # invitation so every supplier can receive a different share of one RFQ line.
    item_quantities = Column(JSON, nullable=True)
    # Item id -> quantity this supplier WON. Separate from `item_quantities` above
    # because that one is the ASK and is already filled, for everybody, at send time:
    # a tender invites each supplier to quote the whole line. The split is decided
    # against the quotations that come back — the first moment anyone knows a price —
    # so it belongs to the award. NULL means this supplier won nothing, or the RFQ
    # was awarded whole to a single quotation, which is still the common case.
    awarded_quantities = Column(JSON, nullable=True)
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

    # ── Quotation negotiation (2026-09-26) ───────────────────────────────── #
    # A buyer asking the supplier for a better number, carried on the quotation
    # itself. A badge COLUMN rather than a QuotationStatus value: negotiation is
    # an overlay on SUBMITTED/REVISED, not a place the document moved to, and a
    # new status would have made every existing filter, KPI and report lie.
    under_negotiation = Column(Boolean, nullable=False, default=False)
    # How many change requests the supplier has ACCEPTED. "v2 pricing" is a
    # number, not archaeology; `revision_count` beside it still counts every
    # resubmission of any kind.
    accepted_revision = Column(Integer, nullable=False, default=0)

    created_by_id = soft_fk()
    created_at = created_at_col()

    items = relationship("QuotationItem", back_populates="quotation",
                         cascade="all, delete-orphan", lazy="selectin")


class QuoteChangeRequest(Base):
    """`pro_quote_change_requests` — the buyer's ask on a supplier's quotation.

    An amendment for a quotation, cut from the same cloth as `PORevision` and
    `amend_po`: the quote as the supplier priced it is snapshotted BEFORE anything
    is proposed, so the price trail always has a version that still exists to diff
    against; the proposed change is applied only when the COUNTERPARTY accepts it;
    and the trail is append-only (rule 9) — nothing deletes a row, including a
    decline, which files its reason and stands in the history like any decision.

    One open (AWAITING_SUPPLIER) request per quotation, enforced in the service:
    two parallel asks on one price is how contracts end up with two truths.
    """
    __tablename__ = "pro_quote_change_requests"
    id = pk()
    quotation_id = Column(ForeignKey("pro_quotations.id", ondelete="CASCADE"),
                          index=True, nullable=False)
    # Denormalised for the same reason every pointer here carries one: the RFQ is
    # the tender the request is negotiating against, and listing a vendor's open
    # requests must not chase two joins.
    rfq_id = Column(ForeignKey("pro_rfqs.id"), index=True, nullable=False)
    cr_no = Column(String(30), unique=True, nullable=False)   # CR-2026-27/0001
    # DRAFT is never persisted — a proposed request goes straight to the supplier.
    # AWAITING_SUPPLIER -> ACCEPTED | DECLINED, or WITHDRAWN by the buyer, or
    # SUPERSEDED when a different request on the same quote was accepted first.
    status = Column(String(30), nullable=False, index=True)
    # "Say why" — the same rule `amend_po` holds. A price change with no recorded
    # reason answers no question six months later.
    reason = Column(Text, nullable=False)
    # The buyer's proposed lines: one entry per quotation line touched.
    # {quotation_item_id, item_id, proposed_quantity, proposed_rate,
    #  proposed_discount_percent, note}. Applied only on ACCEPT, through
    # `_quote_totals`, never by the screen.
    proposed_lines = Column(JSON, nullable=False)
    # The quote's header + lines as they stood when the ask was made — the price
    # trail's "from" version. Same shape as `_po_snapshot`'s output, via
    # `_quote_snapshot` beside it in service.py.
    snapshot_before = Column(JSON, nullable=False)
    proposed_by_id = soft_fk()
    proposed_by_name = Column(String(200), nullable=True)  # snapshot
    supplier_decision_note = Column(Text, nullable=True)
    supplier_decided_at = Column(DateTime(timezone=True), nullable=True)
    supplier_counter_lines = Column(JSON, nullable=True)
    created_at = created_at_col()
    updated_at = updated_at_col()


Index("ix_pro_quote_cr_quote_status", QuoteChangeRequest.quotation_id,
      QuoteChangeRequest.status)


class QuotationComment(Base):
    """Discussion on a quotation between the buyer and THE SUPPLIER.

    Shaped on `POComment` with no new ideas — a thread beside the paper, append
    only. One thread per quotation, and a quotation already answers to exactly one
    supplier on one RFQ, so "unique to that supplier" falls out of the table's
    shape: two suppliers' threads can never mix because their quotations cannot.
    Both sides write into the same thread, so the negotiation the audit needs to
    see is not happening over WhatsApp.
    """
    __tablename__ = "pro_quotation_comments"
    id = pk()
    quotation_id = Column(ForeignKey("pro_quotations.id", ondelete="CASCADE"),
                          index=True, nullable=False)
    author_id = soft_fk()
    author_name = Column(String(200), nullable=True)
    # "BUYER" or "SUPPLIER" — written at post time from which side sent it, so the
    # screen never has to guess from an id which tint to draw a bubble in.
    author_side = Column(String(10), nullable=False, default="BUYER")
    message = Column(Text, nullable=False)
    created_at = created_at_col()


Index("ix_pro_quotation_comments_q_created", QuotationComment.quotation_id,
      QuotationComment.created_at)


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
    # The GST the vendor actually quoted, as one rate. A within-state supply is
    # charged half as CGST and half as SGST and an across-state one as the whole as
    # IGST — the same number on two routes — so the offer states one figure and the
    # split is derived from it wherever a document needs the halves.
    tax_percent = Column(Numeric(5, 2), nullable=False, default=0)
    amount = Column(Numeric(16, 2), nullable=False, default=0)
    delivery_days = Column(Integer, nullable=True)

    quotation = relationship("Quotation", back_populates="items")


# --------------------------------------------------------------------------- #
#  Despatch note — what the vendor says they put on the vehicle
# --------------------------------------------------------------------------- #

class DespatchNote(Base):
    """`pro_despatch_notes`. The vendor's own statement of a delivery, filed before it
    arrives.

    Doc B12 makes the invoice and the e-way bill mandatory before dispatch, and until
    now that paperwork reached us on paper: a storekeeper at the gate retyped the
    invoice number, the e-way bill, the vehicle, and then a batch and an expiry date per
    line — every one of them already typed once, by the vendor, in their own system.

    So this is the same document, filed by the party that has the facts. The warehouse
    then confirms what physically arrived rather than transcribing what was sent.

    It is NOT approved by anybody here. A despatch note is a claim; the GRN is where we
    agree with it or do not, and `received_qty` on the receipt is the number that counts
    against stock. Nothing here ever writes to `stk_`.
    """
    __tablename__ = "pro_despatch_notes"
    id = pk()
    dn_no = Column(String(30), unique=True, nullable=False)
    dn_date = Column(Date, nullable=True)

    # Backward pointer, like every other link in this chain.
    po_id = Column(ForeignKey("pro_purchase_orders.id"), index=True, nullable=False)
    po_no = Column(String(30), nullable=True)              # snapshot
    vendor_id = Column(ForeignKey("mst_vendors.id"), index=True, nullable=False)
    vendor_name = Column(String(200), nullable=True)       # snapshot

    # The paperwork the gate would otherwise retype. Same names as `inb_receipts`
    # carries, so the prefill is a copy rather than a translation.
    invoice_no = Column(String(50), nullable=True)
    invoice_date = Column(Date, nullable=True)
    invoice_amount = Column(Numeric(16, 2), nullable=True)
    eway_bill_no = Column(String(50), nullable=True)
    vehicle_no = Column(String(50), nullable=True)
    transporter_name = Column(String(200), nullable=True)
    lr_no = Column(String(50), nullable=True)
    expected_date = Column(Date, nullable=True)

    status = Column(String(30), nullable=False,
                    default=DespatchNoteStatus.DRAFT.value, index=True)
    remarks = Column(Text, nullable=True)
    submitted_at = Column(DateTime(timezone=True), nullable=True)
    created_at = created_at_col()
    updated_at = updated_at_col()

    items = relationship("DespatchNoteItem", back_populates="note",
                         cascade="all, delete-orphan", lazy="selectin")


Index("ix_pro_dn_po_status", DespatchNote.po_id, DespatchNote.status)


class DespatchNoteItem(Base):
    """`pro_despatch_note_items`. Batch, manufacture and expiry per line.

    These three are the reason this document earns its place. They cannot be derived
    from the PO — they are properties of the physical goods, known only to whoever
    packed them — and they drive FEFO picking and expiry alerts for the rest of the
    item's life. Typed at a gate, off a carton, they are typed wrong.
    """
    __tablename__ = "pro_despatch_note_items"
    id = pk()
    despatch_note_id = Column(ForeignKey("pro_despatch_notes.id", ondelete="CASCADE"),
                              index=True, nullable=False)
    line_no = Column(Integer, nullable=False, default=1)

    po_item_id = soft_fk()
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    item_code = Column(String(50), nullable=True)          # snapshot
    item_name = Column(String(300), nullable=True)         # snapshot
    uom_code = Column(String(20), nullable=True)

    despatched_qty = Column(Numeric(16, 3), nullable=False, default=0)
    batch_no = Column(String(50), nullable=True)
    mfg_date = Column(Date, nullable=True)
    expiry_date = Column(Date, nullable=True)
    remarks = Column(String(500), nullable=True)

    # How the supplier PACKED what they sent (2026-10-08) — "1 Carton + 10 Box +
    # 20 Strip". `despatched_qty` is that breakdown's total in base units. The gate
    # receives against exactly this, read-only.
    pack_hierarchy_id = Column(BigInteger, index=True, nullable=True)
    pack_breakdown = Column(JSON, nullable=True)
    # A different hierarchy from the order's is allowed but goes to the buyer
    # (PackChangeStatus). The order's hierarchy at the time is snapshotted so the
    # buyer reads "you ordered X, they sent Y" even after accepting it.
    pack_change_status = Column(String(20), nullable=False,
                                default=PackChangeStatus.NONE.value)
    ordered_pack_hierarchy_id = Column(BigInteger, nullable=True)
    ordered_pack_hierarchy_name = Column(String(100), nullable=True)
    pack_change_reason = Column(String(500), nullable=True)
    pack_change_note = Column(String(500), nullable=True)
    pack_change_by_name = Column(String(200), nullable=True)
    pack_change_at = Column(DateTime, nullable=True)

    note = relationship("DespatchNote", back_populates="items")


# --------------------------------------------------------------------------- #
#  Vendor portal identity
# --------------------------------------------------------------------------- #

class VendorNotification(Base):
    """`pro_vendor_notifications`. Something the company needs a vendor to know.

    NEW 2026-08-21, for the amendment case: a buyer could revise a purchase order and
    the vendor was told NOTHING. The order simply went back to DRAFT, vanished off
    their portal until somebody re-sent it, and reappeared later carrying different
    numbers with no statement anywhere that it had changed or why.

    Why a table of its own rather than `sys_notifications`: that one is keyed on
    `employee_id`, and a vendor is not an employee and never will be (see VendorUser).
    There is nowhere in it to put a vendor. Keyed on the VENDOR, not on the vendor
    USER, for the same reason `pro_vendor_users` is one row per vendor — the message is
    for the company, not for whoever happens to hold the login today, so re-issuing an
    account never loses the history.

    Deliberately dumb. No delivery, no email, no retry: the portal reads it. Raising one
    must never be able to fail the transaction that raised it — see `notify_vendor`.
    """
    __tablename__ = "pro_vendor_notifications"
    id = pk()
    vendor_id = Column(ForeignKey("mst_vendors.id", ondelete="CASCADE"),
                       nullable=False, index=True)
    title = Column(String(200), nullable=False)
    body = Column(String(1000), nullable=True)
    #: Where it happened, so the portal can link straight at the document.
    entity_type = Column(String(30), nullable=True)
    entity_id = Column(BigInteger, nullable=True)
    deep_link = Column(String(300), nullable=True)
    is_read = Column(Boolean, nullable=False, default=False, index=True)


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

# --------------------------------------------------------------------------- #
# Where these documents keep their "waiting on" snapshot.
#
# Declared HERE, beside the models, because this file is the only place that knows
# the table and column names. `platform.workflow.engine.move_to_workflow` reads the
# registry when an admin moves a document onto another ladder version — that is the
# one transition with no module on the other end to update the row afterwards, and
# before this the document went on naming the approver from the version it had just
# been taken off. See `platform/workflow/doc_registry.py`.
#
# Modules -> platform, never the reverse (rule 5): this passes plain strings, so the
# platform never imports a model.
# --------------------------------------------------------------------------- #
class POComment(Base):
    """Discussion on a purchase order between the raiser and the approver.

    One flat thread per PO, append-only. Approver asks, raiser replies — the
    history stays beside the document so the approval decision can be made with
    context rather than over a side channel that the audit never sees.
    """
    __tablename__ = "pro_po_comments"
    id = pk()
    po_id = Column(ForeignKey("pro_purchase_orders.id", ondelete="CASCADE"),
                   index=True, nullable=False)
    author_id = soft_fk()
    author_name = Column(String(200), nullable=True)
    message = Column(Text, nullable=False)
    created_at = created_at_col()


Index("ix_pro_po_comments_po_created", POComment.po_id, POComment.created_at)

# The CR-number series and the comment routes both live under /api/rfqs, which the
# supplier portal routes mirror under /api/supplier — the doc series is registered
# once, beside the other procurement series, in `shared/numbering.py`.


class QuoteOtp(Base):
    """`pro_quote_otps` — one emailed code standing between a vendor and a submitted
    quotation (2026-09-07).

    A tender response is a priced commitment from an outside company, sent over a link
    that reached somebody's inbox. Until now anybody holding that link could submit on
    the vendor's behalf; the code proves the person pressing Submit is reading the
    address the vendor registered with us.

    SHAPED ON `sys_password_resets`, deliberately, and for the same reasons:

      * the RAW code is never stored, only its SHA-256. A row is otherwise a live
        submit credential, and a database backup is a folder full of them.
      * rows are KEPT after use rather than deleted, so "this code was already used" is
        a different answer from "this code never existed" — one is a double press, the
        other is worth looking at.

    `pro_`, not `sys_`: the rule it enforces is procurement's, it is read by nothing
    outside this module, and a table only ever carries its owning module's prefix.

    `attempts` is what makes six digits safe. Without a cap, a code with a million
    possibilities and a five-minute life is guessable by a script; with one, a wrong
    code costs the guesser the whole OTP.
    """
    __tablename__ = "pro_quote_otps"
    id = pk()
    rfq_id = Column(ForeignKey("pro_rfqs.id", ondelete="CASCADE"),
                    index=True, nullable=False)
    #: The vendor the code was issued to. Not a hard FK — `mst_vendors` is a master and
    #: a deactivated vendor's issued codes must still read back.
    vendor_id = Column(BigInteger, index=True, nullable=False)
    #: SHA-256 hex of the six digits that were emailed.
    code_hash = Column(String(64), nullable=False)
    #: Where it went. Snapshotted so the record says which address was trusted at the
    #: time, even after the vendor master is edited (rule 10).
    sent_to = Column(String(255), nullable=True)
    expires_at = Column(DateTime, nullable=False)
    used_at = Column(DateTime, nullable=True)
    #: Wrong codes tried against THIS row. Cheaper than a rate limiter and it survives
    #: a restart, which a per-process counter does not.
    attempts = Column(Integer, nullable=False, default=0)
    requested_ip = Column(String(45), nullable=True)
    created_at = created_at_col()


#: The lookup every verification makes: the live code for this vendor on this RFQ.
Index("ix_pro_quote_otps_rfq_vendor", QuoteOtp.rfq_id, QuoteOtp.vendor_id)


doc_registry.register(DocType.PO.value, "pro_purchase_orders")
doc_registry.register(DocType.REQUISITION.value, "pro_requisitions")
doc_registry.register(DocType.RFQ.value, "pro_rfqs")
doc_registry.register(DocType.CONSOLIDATION.value, "pro_consolidations")
