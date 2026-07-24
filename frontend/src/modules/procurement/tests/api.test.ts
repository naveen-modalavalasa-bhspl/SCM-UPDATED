import { describe, expect, it } from "vitest";
import { poApi } from "../api";

// Module-scoped smoke: the procurement API surface exists and is callable.
describe("procurement api", () => {
  it("exposes the PO operations", () => {
    expect(Object.keys(poApi).sort()).toEqual(
      ["approve", "createFromIndent", "get", "list", "openForGrn", "reject", "sendToVendor", "submit"].sort(),
    );
    expect(typeof poApi.createFromIndent).toBe("function");
  });
});
