import { describe, expect, it } from "vitest";
import { poApi, requisitionApi, rfqApi } from "../api";

// Module-scoped smoke: the procurement API surface exists and is callable.
describe("procurement api", () => {
  it("exposes the PO operations", () => {
    expect(Object.keys(poApi).sort()).toEqual(
      ["amend", "approve", "create", "createFromIndent", "createFromQuotation",
       "export", "get", "list", "openForGrn", "reject", "revisions", "sendToVendor",
       "submit", "update",
       // The approval desk's own two: the approver asks the raiser a question on the
       // document instead of over a side channel the audit never sees, and trims the
       // quantities they are signing for. Both are gated per document by the engine,
       // not by the screen — see `update_po_approval_quantities`.
       "comments", "postComment", "updateApprovalQuantities",
       // A supplier sending a different pack hierarchy from the order's: the buyer
       // reads the changes and accepts or declines each (2026-10-08).
       "packChanges", "decidePackChange"].sort(),
    );
    expect(typeof poApi.createFromIndent).toBe("function");
    // Raised by hand, alongside the two derived paths: an order that begins as a
    // repeat buy or an emergency has no indent and no quotation to come from.
    expect(typeof poApi.create).toBe("function");
  });

  // The two hops that had a backend and no caller: an approved MR could not become a
  // requisition, and an awarded quotation could not become a PO. Asserted by name
  // because a chain is only connected if something actually calls the endpoint.
  it("closes the chain from an MR and from an awarded quotation", () => {
    expect(typeof requisitionApi.createFromMr).toBe("function");
    expect(typeof poApi.createFromQuotation).toBe("function");
    expect(typeof rfqApi.awardSplit).toBe("function");
  });
});
