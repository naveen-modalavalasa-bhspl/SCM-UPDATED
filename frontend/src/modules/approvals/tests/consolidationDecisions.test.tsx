import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useConsolidationDecisions } from "../consolidationDecisions";
import { cycleTile, isExcluded, resolveItem } from "../pages/ConsolidationPage";
import type { ConsolidatedItem } from "../types";

/** The approver's draft outlives the screen it was typed on — quantities are set on
 *  an item's own page and spent by Approve all on the consolidation — so the store
 *  behind it is what these two screens actually agree through. */
describe("useConsolidationDecisions", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    // The module caches snapshots per cycle; a fresh cycle per test keeps them apart.
  });

  it("keeps a cycle's decisions where both screens can read them", () => {
    const { result, unmount } = renderHook(() => useConsolidationDecisions("2026-08"));
    act(() => result.current.setApproved(7, "40"));

    // A remount is what navigating between the two screens does.
    unmount();
    const reopened = renderHook(() => useConsolidationDecisions("2026-08"));
    expect(reopened.result.current.decisions["7"].approved).toBe("40");
  });

  it("keeps cycles apart", () => {
    const august = renderHook(() => useConsolidationDecisions("2026-08-sep-test"));
    act(() => august.result.current.setApproved(7, "40"));
    const september = renderHook(() => useConsolidationDecisions("2026-09-sep-test"));
    expect(september.result.current.decisions["7"]).toBeUndefined();
  });

  it("toggles an exclusion on and back off", () => {
    const { result } = renderHook(() => useConsolidationDecisions("2026-08-toggle"));
    act(() => result.current.toggleExcluded(7, "ind-0001"));
    // Normalised on the way in, so a pick and a stored value always compare equal.
    expect(result.current.decisions["7"].excluded).toEqual(["IND-0001"]);

    act(() => result.current.toggleExcluded(7, "IND-0001"));
    expect(result.current.decisions["7"]).toBeUndefined();
  });

  it("restores everyone at once and forgets a spent cycle", () => {
    const { result } = renderHook(() => useConsolidationDecisions("2026-08-clear"));
    act(() => {
      result.current.toggleExcluded(7, "IND-0001");
      result.current.toggleExcluded(7, "IND-0002");
    });
    expect(result.current.decisions["7"].excluded).toHaveLength(2);

    act(() => result.current.includeAll(7));
    expect(result.current.decisions["7"]).toBeUndefined();

    act(() => result.current.setApproved(9, "5"));
    act(() => result.current.clearCycle());
    expect(result.current.decisions).toEqual({});
  });
});

const item = (allocations: Array<[string, number]>): ConsolidatedItem => ({
  item_id: 7,
  item_code: "MED-DOL-650",
  item_name: "Dolo 650",
  uom_code: "STRIP",
  total_requested_quantity: allocations.reduce((sum, [, qty]) => sum + qty, 0),
  total_ceiling_quantity: allocations.reduce((sum, [, qty]) => sum + qty, 0),
  indent_count: allocations.length,
  allocations: allocations.map(([indent_no, requested_quantity], index) => ({
    indent_id: index + 1,
    indent_no,
    line_id: index + 1,
    requested_quantity,
    ceiling_quantity: requested_quantity,
  })),
});

describe("resolveItem", () => {
  it("excludes only the indent that was picked", () => {
    // The old exclude box was free text matched on substrings, so "IND-1" silently
    // took IND-10 out with it. Exclusion is now by whole indent number.
    const dolo = item([["IND-1", 10], ["IND-10", 10], ["IND-11", 10]]);
    const { included, split } = resolveItem(dolo, { approved: "", excluded: ["IND-1"] });

    expect(included.map((a) => a.indent_no)).toEqual(["IND-10", "IND-11"]);
    expect(split.get(1)).toBe(0);
    // Each of the two left asked for 10 and may have no more than 10, so the excluded
    // indent's 10 goes nowhere — it is simply not approved.
    expect(split.get(2)).toBe(10);
    expect(split.get(3)).toBe(10);
  });

  it("never hands an excluded indent's share past somebody else's own ceiling", () => {
    // The share does go to the rest — but only as far as each of them may receive.
    // Dropping one of two indents used to offer the survivor the whole 60 when it had
    // asked for 30, which the server then refused: an approval nobody could complete.
    const dolo = item([["IND-1", 30], ["IND-2", 30]]);
    const { total, ceiling, droppedCount, split } =
      resolveItem(dolo, { approved: "", excluded: ["IND-2"] });

    expect(droppedCount).toBe(1);
    expect(ceiling).toBe(30);
    expect(total).toBe(30);
    expect(split.get(1)).toBe(30);
  });

  it("shares an excluded indent's quantity out where there is room for it", () => {
    // Three asking 30 each, only 60 approvable: dropping one leaves 60 across two
    // ceilings of 30, so the whole 60 still goes out — 30 and 30.
    const dolo = item([["IND-1", 30], ["IND-2", 30], ["IND-3", 30]]);
    const { total, split } = resolveItem(
      { ...dolo, total_ceiling_quantity: 60 }, { approved: "60", excluded: ["IND-3"] },
    );

    expect(total).toBe(60);
    expect(split.get(1)).toBe(30);
    expect(split.get(2)).toBe(30);
    expect(split.get(3)).toBe(0);
  });

  it("splits a countable unit in whole numbers only", () => {
    // 20 across lines asking 10 and 7 is 11.8 and 8.2 pro-rata. Gloves do not come in
    // fifths, so the split moves in whole units: the fulfilment queue's 5.7 bug.
    const gloves = { ...item([["IND-1", 10], ["IND-2", 7]]), uom_decimals: 0 };
    const { split } = resolveItem({ ...gloves, total_ceiling_quantity: 15 }, undefined);

    expect(split.get(1)).toBe(9);
    expect(split.get(2)).toBe(6);
    expect((split.get(1) ?? 0) + (split.get(2) ?? 0)).toBe(15);
  });

  it("caps an over-ceiling total and says so", () => {
    const dolo = item([["IND-1", 10]]);
    expect(resolveItem(dolo, { approved: "40", excluded: [] })).toMatchObject({
      over: true, total: 10,
    });
    expect(resolveItem(dolo, { approved: "-1", excluded: [] }).invalid).toBe(true);
    // Blank means the full ceiling, not zero.
    expect(resolveItem(dolo, { approved: "", excluded: [] }).total).toBe(10);
  });
});

describe("cycleTile", () => {
  it("reads the month off the cycle key", () => {
    expect(cycleTile("2026-08")).toEqual({ top: "AUG", bottom: "2026" });
    expect(cycleTile("2026-01")).toEqual({ top: "JAN", bottom: "2026" });
    expect(cycleTile("2026-12")).toEqual({ top: "DEC", bottom: "2026" });
  });

  it("has no month to show for an undated cycle", () => {
    // UNDATED is a real group key — an indent with no date still has to land
    // somewhere — so the tile degrades rather than rendering "NaN".
    expect(cycleTile("UNDATED")).toEqual({ top: "—", bottom: "" });
    expect(cycleTile("2026-13")).toEqual({ top: "—", bottom: "" });
  });
});

describe("isExcluded", () => {
  it("matches on the whole indent number, case-insensitively", () => {
    const allocation = { indent_id: 1, indent_no: "IND-0001", line_id: 1, requested_quantity: 1, ceiling_quantity: 1 };
    expect(isExcluded(allocation, ["IND-0001"])).toBe(true);
    expect(isExcluded(allocation, ["IND-000"])).toBe(false);
    expect(isExcluded(allocation, [])).toBe(false);
  });
});
