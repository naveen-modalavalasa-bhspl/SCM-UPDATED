import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/api/client", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import { api } from "@/shared/api/client";
import {
  confirmPutaway, getPoLines, listBatches, listIssues, listReceipts, listSerials, runReport,
} from "../api";

const mockGet = api.get as unknown as ReturnType<typeof vi.fn>;
const mockPost = api.post as unknown as ReturnType<typeof vi.fn>;

const page = <T,>(items: T[]) => ({ data: { items, total: items.length, page: 1, size: 100 } });

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});

/** The params object axios was handed on the most recent call. */
const paramsOf = (mock: ReturnType<typeof vi.fn>) => mock.mock.calls.at(-1)?.[1]?.params ?? {};

describe("warehouse api", () => {
  it("calls the module's own prefix, not the old /api/v1 client", async () => {
    mockGet.mockResolvedValueOnce(page([]));
    await listReceipts();
    expect(mockGet).toHaveBeenCalledWith("/api/warehouse/receipts", expect.anything());
  });

  it("drops blank filters so a cleared control does not send an empty param", async () => {
    mockGet.mockResolvedValueOnce(page([]));
    await listReceipts({ status: "", search: undefined, warehouse_id: 4, receipt_type: "PURCHASE" });
    expect(paramsOf(mockGet)).toEqual({ warehouse_id: 4, receipt_type: "PURCHASE" });
  });

  it("keeps a zero filter, which is a real value and not a blank", async () => {
    mockGet.mockResolvedValueOnce(page([]));
    await listSerials({ item_id: 0 });
    expect(paramsOf(mockGet)).toEqual({ item_id: 0 });
  });

  it("separates issues from returns by direction", async () => {
    mockGet.mockResolvedValueOnce(page([]));
    await listIssues({ direction: "IN" });
    expect(mockGet).toHaveBeenCalledWith("/api/warehouse/issues", expect.anything());
    expect(paramsOf(mockGet)).toEqual({ direction: "IN" });
  });

  it("asks for PO lines by query param rather than a path segment", async () => {
    mockGet.mockResolvedValueOnce({ data: [] });
    await getPoLines(12);
    expect(mockGet).toHaveBeenCalledWith("/api/warehouse/options/po-lines", expect.anything());
    expect(paramsOf(mockGet)).toEqual({ po_id: 12 });
  });

  it("posts a putaway confirmation with the bin that was actually used", async () => {
    mockPost.mockResolvedValueOnce({ data: {} });
    await confirmPutaway(9, { actual_bin_id: 44, qty: 5, remarks: null });
    expect(mockPost).toHaveBeenCalledWith("/api/warehouse/putaways/9/confirm", {
      actual_bin_id: 44,
      qty: 5,
      remarks: null,
    });
  });

  it("encodes a report key into the path and passes the period as params", async () => {
    mockGet.mockResolvedValueOnce({ data: { columns: [], rows: [], total: 0 } });
    await runReport("batch-expiry", { date_from: "2026-07-01", date_to: "2026-07-31" });
    expect(mockGet).toHaveBeenCalledWith("/api/warehouse/reports/batch-expiry", expect.anything());
    expect(paramsOf(mockGet)).toEqual({ date_from: "2026-07-01", date_to: "2026-07-31" });
  });

  it("returns the page envelope untouched so callers read {items,total}", async () => {
    mockGet.mockResolvedValueOnce(page([{ id: 1, batch_no: "B1" }]));
    const result = await listBatches();
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
  });
});
