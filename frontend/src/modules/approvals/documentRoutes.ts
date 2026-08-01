type ApprovalDocument = {
  doc_type: string;
  doc_id: number;
};

/** Native detail screen for a document shown by the Approvals module. */
export function approvalDocumentPath(document: ApprovalDocument): string {
  switch (document.doc_type) {
    case "INDENT": return `/approvals?reviewIndent=${document.doc_id}`;
    case "MR": return `/inventory/material-requests/${document.doc_id}`;
    // ?review= opens that allocation's review panel directly; without it the approver
    // lands on the queue and has to find the row again.
    case "ALLOCATION": return `/inventory/allocation-approvals?review=${document.doc_id}`;
    case "PO": return "/pos";
    case "GRN": return `/warehouse/grn/${document.doc_id}`;
    case "ISSUE":
    case "WH_ISSUE": return `/warehouse/material-issues/${document.doc_id}`;
    case "DISPATCH": return `/warehouse/transactions/dispatch/${document.doc_id}`;
    case "PURCHASE_RETURN": return `/warehouse/purchase-returns/${document.doc_id}`;
    default: return "/approvals";
  }
}
