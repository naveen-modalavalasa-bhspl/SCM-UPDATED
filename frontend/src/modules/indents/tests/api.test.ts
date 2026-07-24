import { describe, expect, it } from "vitest";
import { indentApi } from "../api";

describe("indents api", () => {
  it("exposes the indent operations", () => {
    expect(Object.keys(indentApi).sort()).toEqual(
      ["approve", "create", "get", "list", "reject", "stats", "submit"].sort(),
    );
  });
});
