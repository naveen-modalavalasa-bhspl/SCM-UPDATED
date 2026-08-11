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
    case "GRN": return `/warehouse/grn/${document.doc_id}`;
    case "ISSUE":
    case "WH_ISSUE":
    case "OWN_STOCK_ISSUE": return `/warehouse/material-issues/${document.doc_id}`;
    case "DISPATCH": return `/warehouse/transactions/dispatch/${document.doc_id}`;
    case "PURCHASE_RETURN": return `/warehouse/purchase-returns/${document.doc_id}`;
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
    case "INDENT": return `/indents/${document.doc_id}?decision=1`;
    case "ALLOCATION":
    case "OWN_STOCK_ALLOCATION":
      return `/inventory/allocation-approvals/${document.doc_id}?decision=1`;
    case "PO": return `/pos/${document.doc_id}?decision=1`;
    case "MR": return `/inventory/material-requests/${document.doc_id}`;
    case "GRN": return `/warehouse/grn/${document.doc_id}`;
    case "ISSUE":
    case "WH_ISSUE":
    case "OWN_STOCK_ISSUE": return `/warehouse/material-issues/${document.doc_id}`;
    case "DISPATCH": return `/warehouse/transactions/dispatch/${document.doc_id}`;
    case "PURCHASE_RETURN": return `/warehouse/purchase-returns/${document.doc_id}`;
    default: return "/approvals/decisions";
  }
}
