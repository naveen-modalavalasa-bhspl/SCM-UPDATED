import { describe, expect, it } from "vitest";
import { grnApi, issueApi, stockApi } from "../api";

describe("logistics api", () => {
  it("exposes GRN operations", () => {
    expect(Object.keys(grnApi).sort()).toEqual(
      ["createFromPo", "get", "list", "qcFail", "qcPass"].sort(),
    );
  });
  it("exposes stock + issue reads", () => {
    expect(typeof stockApi.list).toBe("function");
    expect(typeof stockApi.movements).toBe("function");
    expect(typeof issueApi.issue).toBe("function");
  });
});
