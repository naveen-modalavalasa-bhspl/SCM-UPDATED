"""The buying trail: every procurement document in one register.

WHY IT LIVES HERE and not in `modules/reports`, which owns the other ledgers: it reads
nothing outside procurement. A requisition, an RFQ, a quotation and a purchase order are
all this module's own tables, so there is no reason to hand the join to a module that
sits outside the import chain — and every reason not to, because a reader wants to click
a row through to the document, which is a procurement screen.

The precedent is `logistics.activity_ledger`, which unions the places a logistics event
is ALREADY recorded rather than writing a second copy for the ledger's benefit. Same
rule here: NOTHING is written for this view. It is four SELECTs over documents that
exist, unioned into one shape, so it cannot show an event the documents do not carry and
it can never drift out of step with them.

The four rungs of the buying chain, in the order they happen:

    Requisition  ->  RFQ  ->  Quotation  ->  Purchase Order

`ref_no` is what each row points BACK at — the requisition an RFQ came from, the RFQ a
quote answers, the quotation a PO was raised off — which is what makes the register
readable as a chain rather than as four unrelated lists.
"""
from sqlalchemy import String, Numeric, Select, cast, func, literal, select, union_all

from app.modules.procurement.models import (
    PurchaseOrder, Quotation, RFQ, Requisition,
)

#: The document kinds this register carries, in buying order. Served to the screen so
#: the filter and the rows can never disagree about what exists.
DOC_KINDS: list[dict] = [
    {"value": "REQUISITION", "label": "Requisition"},
    {"value": "RFQ", "label": "RFQ"},
    {"value": "QUOTATION", "label": "Quotation"},
    {"value": "PO", "label": "Purchase Order"},
]

#: What the screen renders, by key. Kept beside the query so a column can never be
#: added to one and forgotten in the other.
COLUMNS: list[dict] = [
    {"key": "doc_kind", "label": "Type", "kind": "text"},
    {"key": "doc_no", "label": "Number", "kind": "text"},
    {"key": "doc_date", "label": "Date", "kind": "date"},
    {"key": "party", "label": "Vendor / Project", "kind": "text"},
    {"key": "project_name", "label": "Project", "kind": "text", "narrow": True},
    {"key": "title", "label": "Detail", "kind": "text", "narrow": True},
    {"key": "status", "label": "Status", "kind": "status"},
    {"key": "value", "label": "Value", "kind": "number"},
    {"key": "ref_no", "label": "Raised from", "kind": "text", "narrow": True},
    {"key": "with_whom", "label": "With", "kind": "text", "narrow": True},
]


def _row(kind: str, doc_id, doc_no, doc_date, party, project, title, status,
         value, ref_no, with_whom) -> Select:
    """One rung of the chain, cast into the one shape the union needs.

    Every branch must present the SAME column types or MySQL decides them from the
    first SELECT and silently truncates the rest — a 30-character requisition number
    would clip a 50-character quotation number. Hence the explicit casts.
    """
    return select(
        literal(kind).label("doc_kind"),
        doc_id.label("doc_id"),
        cast(doc_no, String(60)).label("doc_no"),
        doc_date.label("doc_date"),
        cast(party, String(200)).label("party"),
        cast(project, String(200)).label("project_name"),
        cast(title, String(300)).label("title"),
        cast(status, String(30)).label("status"),
        cast(value, Numeric(16, 2)).label("value"),
        cast(ref_no, String(60)).label("ref_no"),
        cast(with_whom, String(200)).label("with_whom"),
    )


def source() -> Select:
    """The whole buying trail as one SELECT, newest first.

    Read-only by construction: four SELECTs and a UNION, no writes anywhere.
    """
    requisitions = _row(
        "REQUISITION", Requisition.id, Requisition.req_no, Requisition.req_date,
        # A requisition has no vendor yet — that is the entire point of the rung. The
        # project stands in, so the column is never blank on a third of the register.
        Requisition.project_name, Requisition.project_name,
        Requisition.department_name, Requisition.status,
        Requisition.estimated_value, Requisition.source_mr_no,
        Requisition.current_approver_name,
    )
    rfqs = _row(
        "RFQ", RFQ.id, RFQ.rfq_no, RFQ.rfq_date,
        RFQ.project_name, RFQ.project_name, RFQ.title, RFQ.status,
        # An enquiry carries no money: asking is not committing.
        literal(None), RFQ.requisition_no, RFQ.current_approver_name,
    )
    quotations = _row(
        "QUOTATION", Quotation.id, Quotation.quotation_no, Quotation.quotation_date,
        Quotation.vendor_name, literal(None), Quotation.vendor_ref_no,
        Quotation.status, Quotation.grand_total, Quotation.rfq_no,
        # A quote waits on the buyer comparing it, not on an approval ladder.
        literal(None),
    )
    orders = _row(
        "PO", PurchaseOrder.id, PurchaseOrder.po_no, PurchaseOrder.po_date,
        PurchaseOrder.vendor_name, PurchaseOrder.project_name,
        PurchaseOrder.remarks, PurchaseOrder.status, PurchaseOrder.total_amount,
        # What it was raised off, whichever route it came by: a PO can come from a
        # quotation, straight off a requisition, or straight off an indent.
        func.coalesce(PurchaseOrder.quotation_no, PurchaseOrder.requisition_no,
                      PurchaseOrder.indent_no),
        PurchaseOrder.current_approver_name,
    )
    return union_all(requisitions, rfqs, quotations, orders)


#: Columns an ILIKE search sweeps. Numbers first: a buyer searching this register is
#: almost always holding a document number somebody quoted at them.
SEARCH_COLUMNS = ["doc_no", "ref_no", "party", "project_name", "title"]
