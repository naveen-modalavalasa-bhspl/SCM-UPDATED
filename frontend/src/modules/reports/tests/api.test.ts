import { describe, expect, it, vi, beforeEach } from "vitest";
import { api } from "@/shared/api/client";
import { exportLedger, getRows, toParams } from "../api";

vi.mock("@/shared/api/client", () => ({
  api: { get: vi.fn() },
}));

const get = api.get as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => get.mockReset());

describe("toParams", () => {
  it("flattens filter values to top-level query params", () => {
    expect(toParams({ filters: { status: "APPROVED", department: "Mech" } }))
      .toEqual({ status: "APPROVED", department: "Mech" });
  });

  it("drops empty controls and filters, so a cleared box widens the view", () => {
    expect(toParams({ search: "  ", date_from: "", filters: { status: "" } }))
      .toEqual({});
  });

  it("trims what it sends", () => {
    expect(toParams({ search: " grn-1 ", filters: { actor: " Sunil " } }))
      .toEqual({ search: "grn-1", actor: "Sunil" });
  });
});

describe("getRows", () => {
  it("puts the ledger key in the path and everything else in the query", async () => {
    get.mockResolvedValue({ data: { items: [], total: 0, page: 1, size: 50, columns: [] } });
    await getRows("inventory", { page: 2, size: 50, filters: { direction: "OUT" } });
    expect(get).toHaveBeenCalledWith("/api/reports/inventory", {
      params: { page: 2, size: 50, direction: "OUT" },
    });
  });
});

describe("exportLedger", () => {
  it("asks for a blob so the download carries the bearer token", async () => {
    get.mockResolvedValue({ data: new Blob(["a,b"]), headers: {} });
    await exportLedger("approvals", { search: "x" });
    expect(get).toHaveBeenCalledWith("/api/reports/approvals/export", {
      params: { search: "x", format: "xlsx" },
      responseType: "blob",
    });
  });

  it("asks for csv when csv is what was clicked", async () => {
    get.mockResolvedValue({ data: new Blob(["a,b"]), headers: {} });
    await exportLedger("approvals", {}, "csv");
    expect(get).toHaveBeenCalledWith("/api/reports/approvals/export", {
      params: { format: "csv" },
      responseType: "blob",
    });
  });

  it("uses the filename the backend named the file", async () => {
    get.mockResolvedValue({
      data: new Blob(["a,b"]),
      headers: { "content-disposition": 'attachment; filename="approvals-ledger-1.csv"' },
    });
    const { filename } = await exportLedger("approvals", {});
    expect(filename).toBe("approvals-ledger-1.csv");
  });

  it("falls back to a sensible name when the header is missing", async () => {
    get.mockResolvedValue({ data: new Blob([""]), headers: {} });
    const { filename } = await exportLedger("warehouse", {});
    expect(filename).toBe("warehouse-ledger.xlsx");
  });
});
