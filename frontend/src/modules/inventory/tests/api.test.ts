import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/shared/api/client", () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

import { api } from "@/shared/api/client";
import { inventoryApi } from "../api";

const mockGet = api.get as unknown as ReturnType<typeof vi.fn>;
const mockPost = api.post as unknown as ReturnType<typeof vi.fn>;

const page = <T,>(items: T[]) => ({
  data: { items, total: items.length, page: 1, size: 100 },
});

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});

describe("inventory api", () => {
  it("reads stock from /api/stock, not a local store", async () => {
    mockGet.mockResolvedValueOnce(page([]));
    await inventoryApi.getStockBalances();
    expect(mockGet).toHaveBeenCalledWith("/api/stock", expect.anything());
  });

  it("maps stk_balance columns onto the shape the views read", async () => {
    mockGet.mockResolvedValueOnce(
      page([
        {
          id: 1,
          warehouse_id: 4,
          warehouse_name: "Main",
          item_id: 7,
          item_code: "IT-1",
          item_name: "Cement",
          uom_code: "BAG",
          bin_id: 0,
          bin_code: "A-1",
          batch_id: 0,
          batch_no: "B7",
          expiry_date: "2027-01-01",
          project_id: 0,
          available_qty: 60,
          reserved_qty: 40,
          total_qty: 100,
        },
      ]),
    );

    const [row] = await inventoryApi.getStockBalances();

    // physical is what is on the shelf, reserved or not
    expect(row.physical_qty).toBe(100);
    expect(row.available_qty).toBe(60);
    expect(row.reserved_qty).toBe(40);
    expect(row.storage_location).toBe("A-1");
    expect(row.batch_number).toBe("B7");
    // costing is deferred: zero reads as "not costed", a guess would read as fact
    expect(row.valuation_rate).toBe(0);
  });

  it("splits a ledger row into in or out, never both", async () => {
    mockGet.mockResolvedValueOnce(
      page([
        {
          id: 1,
          warehouse_id: 1,
          item_id: 2,
          direction: "OUT",
          quantity: 15,
          balance_after: 85,
          ref_type: "ISSUE",
          ref_no: "ISS-1",
          created_at: "2026-07-26T00:00:00Z",
        },
      ]),
    );

    const [row] = await inventoryApi.getStockLedger();

    expect(row.out_qty).toBe(15);
    expect(row.in_qty).toBe(0);
    expect(row.balance_qty).toBe(85);
    expect(row.transaction_type).toBe("ISSUE");
  });

  it("posts a transfer to the real endpoint", async () => {
    mockPost.mockResolvedValueOnce({ data: undefined });
    await inventoryApi.createStockTransfer({
      item_id: 1,
      quantity: 5,
      from_warehouse_id: 1,
      to_warehouse_id: 2,
    } as never);
    expect(mockPost).toHaveBeenCalledWith("/api/stock/transfer", expect.anything());
  });

  it("lists material requests from the API", async () => {
    mockGet.mockResolvedValueOnce(
      page([{ id: 1, mr_no: "MR/2026-27/00001", status: "PENDING_APPROVAL" }]),
    );
    const result = await inventoryApi.listMaterialRequests();
    expect(mockGet).toHaveBeenCalledWith("/api/material-requests", expect.anything());
    expect(result.items[0].mr_no).toBe("MR/2026-27/00001");
  });

  it("lets a failure surface instead of returning invented rows", async () => {
    mockGet.mockRejectedValueOnce(new Error("Network down"));
    await expect(inventoryApi.getStockBalances()).rejects.toThrow("Network down");
  });

  it("fetches replenishments from the API", async () => {
    mockGet.mockResolvedValueOnce({ data: [] });
    await inventoryApi.getReplenishments();
    expect(mockGet).toHaveBeenCalledWith("/api/stock/replenishment", expect.anything());
  });
});
