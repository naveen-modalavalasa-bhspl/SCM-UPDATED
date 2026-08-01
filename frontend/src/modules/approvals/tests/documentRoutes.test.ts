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
      .toBe("/inventory/allocation-approvals?review=7&decision=1");
  });

  it("opens the exact purchase order instead of the generic PO page", () => {
    expect(approvalDecisionDocumentPath({ doc_type: "PO", doc_id: 9 })).toBe("/pos/9?decision=1");
    expect(approvalDocumentPath({ doc_type: "PO", doc_id: 9 })).toBe("/pos/9?approval=1");
  });
});
