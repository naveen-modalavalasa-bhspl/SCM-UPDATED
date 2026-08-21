import { describe, expect, it } from "vitest";
import { approvalDecisionDocumentPath, approvalDocumentPath } from "../documentRoutes";

describe("approval document routes", () => {
  it("keeps pending indents on the actionable approval review", () => {
    expect(approvalDocumentPath({ doc_type: "INDENT", doc_id: 42 }))
      .toBe("/approvals?reviewIndent=42");
  });

  it("opens completed indents through their permanent document detail", () => {
    expect(approvalDecisionDocumentPath({ doc_type: "INDENT", doc_id: 42 }))
      .toBe("/indents/42?decision=1");
  });

  it("marks completed allocations as read-only decision views", () => {
    expect(approvalDecisionDocumentPath({ doc_type: "ALLOCATION", doc_id: 7 }))
      .toBe("/inventory/allocation-approvals/7?decision=1");
  });

  // Same document, different approval event. Left out of the switch it fell through to
  // `default`, which is the page the approver is already on — the click did nothing.
  it("routes own-stock allocations exactly like ordinary ones", () => {
    expect(approvalDocumentPath({ doc_type: "OWN_STOCK_ALLOCATION", doc_id: 7 }))
      .toBe("/inventory/allocation-approvals/7");
    expect(approvalDecisionDocumentPath({ doc_type: "OWN_STOCK_ALLOCATION", doc_id: 7 }))
      .toBe("/inventory/allocation-approvals/7?decision=1");
  });

  // The award's doc_id is the transport request. Left out of the switch, the one
  // approval that releases a shipment to its carrier had nowhere to be decided.
  it("routes a carrier award to its transport request", () => {
    expect(approvalDocumentPath({ doc_type: "CARRIER_AWARD", doc_id: 1 }))
      .toBe("/logistics/shipments/1?approval=1");
    expect(approvalDecisionDocumentPath({ doc_type: "CARRIER_AWARD", doc_id: 1 }))
      .toBe("/logistics/shipments/1?decision=1");
  });

  it("routes a transport request to its actionable transport detail", () => {
    expect(approvalDocumentPath({ doc_type: "TRANSPORT_REQUEST", doc_id: 5 }))
      .toBe("/logistics/shipments/5?approval=1");
    expect(approvalDecisionDocumentPath({ doc_type: "TRANSPORT_REQUEST", doc_id: 5 }))
      .toBe("/logistics/shipments/5?decision=1");
  });

  it("opens the exact purchase order instead of the generic PO page", () => {
    expect(approvalDecisionDocumentPath({ doc_type: "PO", doc_id: 9 })).toBe("/pos/9?decision=1");
    expect(approvalDocumentPath({ doc_type: "PO", doc_id: 9 })).toBe("/pos/9?approval=1");
  });
});
