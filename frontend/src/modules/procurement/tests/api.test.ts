import { describe, expect, it } from "vitest";
import { poApi, requisitionApi } from "../api";

// Module-scoped smoke: the procurement API surface exists and is callable.
describe("procurement api", () => {
  it("exposes the PO operations", () => {
    expect(Object.keys(poApi).sort()).toEqual(
      ["approve", "createFromIndent", "createFromQuotation", "get", "list",
       "openForGrn", "reject", "sendToVendor", "submit"].sort(),
    );
    expect(typeof poApi.createFromIndent).toBe("function");
  });

  // The two hops that had a backend and no caller: an approved MR could not become a
  // requisition, and an awarded quotation could not become a PO. Asserted by name
  // because a chain is only connected if something actually calls the endpoint.
  it("closes the chain from an MR and from an awarded quotation", () => {
    expect(typeof requisitionApi.createFromMr).toBe("function");
    expect(typeof poApi.createFromQuotation).toBe("function");
  });
});
