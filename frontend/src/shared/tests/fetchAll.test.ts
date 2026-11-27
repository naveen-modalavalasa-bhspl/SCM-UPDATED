import { describe, expect, it, vi } from "vitest";
import { ALL_ROWS_MAX_PAGES, ALL_ROWS_PAGE_SIZE, fetchAllPages } from "../api/fetchAll";
import { optionWindow } from "../components/optionWindow";

/** A fake paginated endpoint holding `total` rows numbered 1..total. */
const endpoint = (total: number) => vi.fn(async (params: Record<string, unknown>) => {
  const page = Number(params.page);
  const size = Number(params.size);
  const start = (page - 1) * size;
  const items = Array.from({ length: Math.max(0, Math.min(size, total - start)) }, (_, i) => start + i + 1);
  return { items, total, page, size };
});

describe("fetchAllPages", () => {
  it("reads every row, not just the first page (QA-5: 983 warehouses, 100 shown)", async () => {
    const load = endpoint(983);
    const rows = await fetchAllPages(load);
    expect(rows).toHaveLength(983);
    expect(rows[0]).toBe(1);
    expect(rows[982]).toBe(983);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("asks for the server's own ceiling and keeps the caller's filters", async () => {
    const load = endpoint(10);
    await fetchAllPages(load, { search: "gauze", page: 7, size: 3, is_active: true });
    expect(load).toHaveBeenCalledWith({ search: "gauze", is_active: true, page: 1, size: ALL_ROWS_PAGE_SIZE });
  });

  it("keeps page order when the later pages come back out of order", async () => {
    const load = vi.fn(async (params: Record<string, unknown>) => {
      const page = Number(params.page);
      if (page === 2) await new Promise((r) => setTimeout(r, 20));
      const start = (page - 1) * ALL_ROWS_PAGE_SIZE;
      return { items: [start + 1], total: ALL_ROWS_PAGE_SIZE * 3, page, size: ALL_ROWS_PAGE_SIZE };
    });
    expect(await fetchAllPages(load)).toEqual([1, 501, 1001]);
  });

  it("stops at its ceiling rather than pulling an unbounded table into the browser", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const load = endpoint(ALL_ROWS_PAGE_SIZE * (ALL_ROWS_MAX_PAGES + 10));
    const rows = await fetchAllPages(load);
    expect(rows).toHaveLength(ALL_ROWS_PAGE_SIZE * ALL_ROWS_MAX_PAGES);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("an empty list is one request and no rows", async () => {
    const load = endpoint(0);
    expect(await fetchAllPages(load)).toEqual([]);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("optionWindow", () => {
  const options = Array.from({ length: 983 }, (_, i) => ({ value: i + 1 }));

  it("draws everything when the list is short", () => {
    const w = optionWindow(options.slice(0, 40), () => false);
    expect(w).toMatchObject({ hidden: 0, matched: 40 });
    expect(w.shown).toHaveLength(40);
  });

  it("draws the first 100 and says how many it left out", () => {
    const w = optionWindow(options, () => false);
    expect(w.shown).toHaveLength(100);
    expect(w.hidden).toBe(883);
    expect(w.matched).toBe(983);
  });

  it("keeps the chosen option in view even far down the list", () => {
    const w = optionWindow(options, (o) => o.value === 900);
    expect(w.shown[0]).toEqual({ value: 900 });
    expect(w.shown).toHaveLength(101);
    expect(w.hidden).toBe(882);
  });
});
