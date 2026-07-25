import { describe, expect, it } from "vitest";
import { indentApi } from "../api";

describe("indents api", () => {
  it("exposes the indent operations", () => {
    expect(Object.keys(indentApi).sort()).toEqual(
      [
        "acknowledgments", "activity", "approve", "create", "get", "list",
        "notifications", "pendingApprovals", "reject", "stats", "submit",
      ].sort(),
    );
  });
});
