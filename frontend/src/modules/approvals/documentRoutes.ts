type ApprovalDocument = {
  doc_type: string;
  doc_id: number;
};

/** Native detail screen for a document shown by the Approvals module. */
export function approvalDocumentPath(document: ApprovalDocument): string {
  switch (document.doc_type) {
    case "INDENT": return `/approvals?reviewIndent=${document.doc_id}`;
    case "MR": return `/inventory/material-requests/${document.doc_id}`;
    // OWN_STOCK_ALLOCATION is the SAME document under a different approval event —
    // an approver serving an indent out of a point they hold. Listing it here while
    // leaving it out of this switch is why clicking it went to `default`, i.e. back to
    // the page the approver was already on: the click looked like it did nothing.
    case "ALLOCATION":
    case "OWN_STOCK_ALLOCATION":
      return `/inventory/allocation-approvals/${document.doc_id}`;
    case "PO": return `/pos/${document.doc_id}?approval=1`;
    // The rest of the buying chain. Each of these was already landing in the queue and
    // falling through to `default`, i.e. back to the page the approver was already on.
    case "REQUISITION": return `/procurement/requisitions/${document.doc_id}?approval=1`;
    case "CONSOLIDATION": return `/procurement/consolidations/${document.doc_id}?approval=1`;
    case "RFQ": return `/procurement/rfqs/${document.doc_id}?approval=1`;
    case "GRN": return `/warehouse/grn/${document.doc_id}`;
    case "ISSUE":
    case "WH_ISSUE":
    case "OWN_STOCK_ISSUE": return `/warehouse/material-issues/${document.doc_id}`;
    // The consignment IS the dispatch document, and it lives under Logistics now:
    // /warehouse/transactions/dispatch/:id redirects to the queue and drops the id,
    // so an approver deep-linking from the inbox landed on a list instead of the
    // consignment they had been asked to release.
    case "DISPATCH": return `/logistics/consignments/${document.doc_id}`;
    case "QC_OUTWARD": return `/warehouse/qc-outward/${document.doc_id}`;
    case "PURCHASE_RETURN": return `/warehouse/purchase-returns/${document.doc_id}`;
    // FIX 2026-09-07: a stock return landed in the inbox with no case here, so
    // clicking it fell through to `default` and navigated back to /approvals — the
    // approver saw the queue redraw and read that as a dead button. Both phases of
    // the return (the reporting-line approval and the receipt at the point) carry the
    // return's own id, and /returns/:id is the screen that offers the decision off
    // `can_act` / `can_decide`, so both go there.
    case "STOCK_RETURN":
    case "STOCK_RETURN_RECEIPT":
    case "STOCK_RETURN_LOGISTICS": return `/returns/${document.doc_id}`;
    // A transport approval acts on the transport request itself. Without this case,
    // clicking the item in the inbox returned to the same approvals page and looked
    // like the approval button was broken.
    case "TRANSPORT_REQUEST": return `/logistics/shipments/${document.doc_id}?approval=1`;
    // The award of a transport leg. Its doc_id is the transport request, and the
    // request stays at QUOTING while the award is in approval — so this lands on the
    // transport screen, which offers the decision off `awarded_at`, not off a status.
    case "CARRIER_AWARD": return `/logistics/shipments/${document.doc_id}?approval=1`;
    case "STOCK_ADJUSTMENT": return `/inventory/adjustments?review=${document.doc_id}`;
    case "STOCK_EDIT": return `/inventory/stock-edits?review=${document.doc_id}`;
    case "VENDOR_PAYMENT": return `/accounts/payments?tab=approvals&review=${document.doc_id}`;
    case "STOCK_TRANSFER": return `/inventory/transfers?tab=orders&review=${document.doc_id}`;
    default: return "/approvals";
  }
}

/**
 * Read-only destination for a decision the signed-in employee already made.
 *
 * A completed item must not be sent back to an action-only screen: those screens
 * deliberately stop loading the document as soon as its pending task is cleared.
 */
export function approvalDecisionDocumentPath(document: ApprovalDocument): string {
  switch (document.doc_type) {
    case "INDENT": return `/approvals/decisions/INDENT/${document.doc_id}`;
    case "ALLOCATION":
    case "OWN_STOCK_ALLOCATION":
      return `/inventory/allocation-approvals/${document.doc_id}?decision=1`;
    case "PO": return `/pos/${document.doc_id}?decision=1`;
    case "REQUISITION": return `/procurement/requisitions/${document.doc_id}?decision=1`;
    case "CONSOLIDATION": return `/procurement/consolidations/${document.doc_id}?decision=1`;
    case "RFQ": return `/procurement/rfqs/${document.doc_id}?decision=1`;
    case "MR": return `/inventory/material-requests/${document.doc_id}`;
    case "GRN": return `/warehouse/grn/${document.doc_id}`;
    case "ISSUE":
    case "WH_ISSUE":
    case "OWN_STOCK_ISSUE": return `/warehouse/material-issues/${document.doc_id}`;
    // The consignment IS the dispatch document, and it lives under Logistics now:
    // /warehouse/transactions/dispatch/:id redirects to the queue and drops the id,
    // so an approver deep-linking from the inbox landed on a list instead of the
    // consignment they had been asked to release.
    case "DISPATCH": return `/logistics/consignments/${document.doc_id}`;
    case "QC_OUTWARD": return `/warehouse/qc-outward/${document.doc_id}`;
    case "PURCHASE_RETURN": return `/warehouse/purchase-returns/${document.doc_id}`;
    // FIX 2026-09-07: same gap on the read-only side — a decision already taken on a
    // stock return sent the approver to /approvals/decisions, the list they clicked from.
    case "STOCK_RETURN":
    case "STOCK_RETURN_RECEIPT":
    case "STOCK_RETURN_LOGISTICS": return `/returns/${document.doc_id}`;
    case "TRANSPORT_REQUEST": return `/logistics/shipments/${document.doc_id}?decision=1`;
    case "CARRIER_AWARD": return `/logistics/shipments/${document.doc_id}?decision=1`;
    case "STOCK_ADJUSTMENT": return `/inventory/adjustments?review=${document.doc_id}`;
    case "STOCK_EDIT": return `/inventory/stock-edits?review=${document.doc_id}`;
    case "VENDOR_PAYMENT": return `/accounts/payments?tab=approvals&review=${document.doc_id}`;
    case "STOCK_TRANSFER": return `/inventory/transfers?tab=orders&review=${document.doc_id}`;
    default: return "/approvals/decisions";
  }
}

export function approvalDecisionLedgerPath(document: ApprovalDocument & { id?: number | null }): string {
  const base = `/approvals/decisions/${encodeURIComponent(document.doc_type)}/${document.doc_id}`;
  return document.id ? `${base}?action=${document.id}` : base;
}

export function waitingDecisionLedgerPath(document: ApprovalDocument): string {
  return `/approvals/decisions/${encodeURIComponent(document.doc_type)}/${document.doc_id}`;
}
