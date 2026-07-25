import { describe, expect, it } from "vitest";
import { inventoryApi } from "../api";

describe("inventory api", () => {
  it("exposes the registered overview operation", () => {
    expect(Object.keys(inventoryApi)).toEqual(["overview"]);
  });
});
