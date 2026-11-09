import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useConsolidationDecisions } from "../consolidationDecisions";
import { cycleTile } from "../pages/ConsolidationPage";

/** The approver's draft outlives the screen it was typed on — quantities are set on
 *  an item's own page and spent by Approve all on the consolidation — so the store
 *  behind it is what these two screens actually agree through. It holds ONE ENTRY PER
 *  INDENT LINE: what is typed in that row's box, and whether the row is excluded. */
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
    expect(reopened.result.current.decisions["7"]).toEqual({ approved: "40", excluded: false });
  });

  it("keeps cycles apart", () => {
    const august = renderHook(() => useConsolidationDecisions("2026-08-sep-test"));
    act(() => august.result.current.setApproved(7, "40"));
    const september = renderHook(() => useConsolidationDecisions("2026-09-sep-test"));
    expect(september.result.current.decisions["7"]).toBeUndefined();
  });

  it("excludes a line and brings it back, storing nothing for an untouched one", () => {
    const { result } = renderHook(() => useConsolidationDecisions("2026-08-toggle"));
    act(() => result.current.setExcluded([7], true));
    expect(result.current.decisions["7"]).toEqual({ approved: "", excluded: true });

    act(() => result.current.setExcluded([7], false));
    // Back to untouched: absent, not stored empty.
    expect(result.current.decisions["7"]).toBeUndefined();
  });

  it("keeps what was typed while a line is excluded and restored", () => {
    const { result } = renderHook(() => useConsolidationDecisions("2026-08-keep"));
    act(() => result.current.setApproved(7, "4"));
    act(() => result.current.setExcluded([7], true));
    act(() => result.current.setExcluded([7], false));
    expect(result.current.decisions["7"]).toEqual({ approved: "4", excluded: false });
  });

  it("applies a whole-indent exclusion to every line in one write", () => {
    const { result } = renderHook(() => useConsolidationDecisions("2026-08-many"));
    act(() => result.current.setExcluded([1, 2, 3], true));
    expect(Object.keys(result.current.decisions).sort()).toEqual(["1", "2", "3"]);

    act(() => result.current.setExcluded([1, 2, 3], false));
    expect(result.current.decisions).toEqual({});
  });

  it("fills several quantities at once, and a blank clears the box", () => {
    const { result } = renderHook(() => useConsolidationDecisions("2026-08-fill"));
    act(() => result.current.setApprovedMany([
      { lineId: 1, approved: "8" }, { lineId: 2, approved: "4" },
    ]));
    expect(result.current.decisions["1"].approved).toBe("8");
    expect(result.current.decisions["2"].approved).toBe("4");

    act(() => result.current.setApprovedMany([{ lineId: 1, approved: "" }]));
    expect(result.current.decisions["1"]).toBeUndefined();
    expect(result.current.decisions["2"].approved).toBe("4");
  });

  it("forgets a spent cycle", () => {
    const { result } = renderHook(() => useConsolidationDecisions("2026-08-clear"));
    act(() => {
      result.current.setApproved(9, "5");
      result.current.setExcluded([10], true);
    });
    act(() => result.current.clearCycle());
    expect(result.current.decisions).toEqual({});
  });

  it("ignores a draft left by the old batch-total model", () => {
    // v1 held `{ itemId: { approved: <batch total>, excluded: [indent numbers] } }`.
    // Reading it as a line draft would approve numbers nobody typed on a line.
    window.sessionStorage.setItem(
      "scm-erp:approvals:consolidation:draft:v1:2026-08-old",
      JSON.stringify({ 7: { approved: "40", excluded: ["IND-1"] } }),
    );
    const { result } = renderHook(() => useConsolidationDecisions("2026-08-old"));
    expect(result.current.decisions).toEqual({});
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
