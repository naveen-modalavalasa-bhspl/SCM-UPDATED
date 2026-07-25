import { describe, expect, it } from "vitest";
import { inventoryApi } from "../api";

describe("inventory api", () => {
  it("exposes the registered inventory operations", () => {
    expect(typeof inventoryApi.overview).toBe("function");
    expect(typeof inventoryApi.getStockBalances).toBe("function");
    expect(typeof inventoryApi.adjustStock).toBe("function");
    expect(typeof inventoryApi.getStockLedger).toBe("function");
    expect(typeof inventoryApi.getReplenishments).toBe("function");
    expect(typeof inventoryApi.createTransfer).toBe("function");
  });
});
