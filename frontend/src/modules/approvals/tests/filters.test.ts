import { describe, expect, it } from "vitest";
import { approvalTypeCounts, raisedWindow } from "../filters";

describe("approval Raised filter", () => {
  const now = new Date(2026, 7, 1, 12).getTime();

  it("supports rolling quick ranges", () => {
    expect(raisedWindow("7d", "", "", now)).toEqual([
      now - (7 * 86_400_000),
      Infinity,
    ]);
  });

  it("includes the complete custom end date", () => {
    const window = raisedWindow("custom", "2026-07-10", "2026-07-10", now);
    expect(window).toEqual([
      new Date(2026, 6, 10).getTime(),
      new Date(2026, 6, 11).getTime(),
    ]);
  });

  it("does not filter when Any time is selected", () => {
    expect(raisedWindow("", "", "", now)).toBeNull();
  });

  it("always offers the main document filters and counts the queue", () => {
    expect(approvalTypeCounts([
      { doc_type: "INDENT" },
      { doc_type: "INDENT" },
      { doc_type: "MR" },
      { doc_type: "PO" },
    ])).toEqual([
      ["INDENT", 2],
      ["MR", 1],
      ["ALLOCATION", 0],
      ["PO", 1],
    ]);
  });
});
