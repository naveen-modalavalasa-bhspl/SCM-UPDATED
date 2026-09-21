/**
 * What a document type is CALLED, in one place.
 *
 * The inbox carried this table privately, so the dashboard guessed at the codes
 * and drew "Mr 2" and "Allocation 1" — the raw enum values, prettified. The codes
 * are short (`MR`, `PO`, `RFQ`), which means a generic underscore-to-space
 * fallback can never produce the right words; only a table can.
 */
export const DOC_TYPE_LABELS: Record<string, string> = {
  INDENT: "Indent", ALLOCATION: "Stock allocation", MR: "Material request",
  PO: "Purchase order", GRN: "Goods receipt", ISSUE: "Material issue",
  WH_ISSUE: "Warehouse issue", OWN_STOCK_ISSUE: "Issue from my point",
  OWN_STOCK_ALLOCATION: "Allocation from my point",
  DISPATCH: "Dispatch", PURCHASE_RETURN: "Purchase return",
  QC_OUTWARD: "Outward QC",
  REQUISITION: "Purchase requisition", CONSOLIDATION: "Purchase sheet",
  RFQ: "Request for quotation", CARRIER_AWARD: "Carrier award",
  TRANSPORT_REQUEST: "Shipment",
<<<<<<< HEAD
=======
  // FIX 2026-09-07: absent, so the queue printed the raw enum "STOCK RETURN" through
  // the underscore fallback while every row beside it read as words.
  STOCK_RETURN: "Stock return", STOCK_RETURN_RECEIPT: "Stock return receipt", STOCK_RETURN_LOGISTICS: "Stock return logistics",
>>>>>>> 521e00de7951bd2a6c34d574b1bc3596f47d6b04
  STOCK_MOVEMENT_ORDER: "Stock movement order",
};

export const docTypeLabel = (value: string) =>
  DOC_TYPE_LABELS[value] ?? value.replace(/_/g, " ");
