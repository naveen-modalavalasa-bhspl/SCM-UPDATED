import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS, fontScale, pageCss, printSummary, selectLabels, sheetGrid, withDefaults,
} from "../docLabels";
import type { DocLabelRow } from "../types";

/** Label printing for a posted issue / acknowledged receipt, tested without a screen. */

const row = (over: Partial<DocLabelRow>): DocLabelRow => ({
  key: "h-1", kind: "PACK", code: "PK-1", line_id: 1, item_id: 7, qty: 100, pack_size: 100,
  part: false, depth: 0, new_here: false, ...over,
});

const labels: DocLabelRow[] = [
  row({ key: "h-1", code: "BOX-1" }),
  row({ key: "h-2", code: "STRIP-1", depth: 1 }),
  row({ key: "h-3", code: "PART-1", new_here: true, part: true, qty: 5 }),
  row({ key: "u-1", code: "AST-1", kind: "UNIT" }),
  row({ key: "h-4", code: "BOX-9", line_id: 2 }),
];

describe("sheetGrid", () => {
  it("fits a 3 × 8 sheet of 70 × 36 labels with no margin", () => {
    expect(sheetGrid(70, 36, 0, 0)).toEqual({ cols: 3, rows: 8, perPage: 24 });
  });

  it("never reports less than one per row and column", () => {
    expect(sheetGrid(300, 400, 8, 2)).toEqual({ cols: 1, rows: 1, perPage: 1 });
  });
});

describe("selectLabels", () => {
  it("the whole document, packs at every level and the codes", () => {
    expect(selectLabels(labels, { lineIds: null, packs: "ALL", units: true }).map((r) => r.code))
      .toEqual(["BOX-1", "STRIP-1", "PART-1", "AST-1", "BOX-9"]);
  });

  it("chosen items, outer packs only, no codes", () => {
    expect(selectLabels(labels, { lineIds: [1], packs: "TOP", units: false }).map((r) => r.code))
      .toEqual(["BOX-1", "PART-1"]);
  });

  it("only the part packs this issue cut", () => {
    expect(selectLabels(labels, { lineIds: null, packs: "NEW", units: false }).map((r) => r.code))
      .toEqual(["PART-1"]);
  });

  it("repeats each label for its copies, capped at ten", () => {
    const out = selectLabels(labels.slice(0, 1), { lineIds: null, packs: "ALL", units: false, copies: 40 });
    expect(out).toHaveLength(10);
  });
});

describe("paper", () => {
  it("a thermal roll is one label a page at its own size", () => {
    const css = pageCss({ ...DEFAULT_SETTINGS, w: 50, h: 25, layout: "ROLL" });
    expect(css).toContain("size: 50mm 25mm");
    expect(printSummary(3, { ...DEFAULT_SETTINGS, layout: "ROLL" })).toBe("3 labels on the roll");
  });

  it("an A4 sheet counts its pages", () => {
    const s = { ...DEFAULT_SETTINGS, w: 70, h: 36, margin: 0, gap: 0, layout: "SHEET" as const };
    expect(pageCss(s)).toContain("size: A4");
    expect(printSummary(30, s)).toBe("30 labels · 2 A4 sheets (24 a sheet)");
  });

  it("text grows with the label and the chosen size", () => {
    expect(fontScale({ w: 100, h: 50, font: "M" })).toBeGreaterThan(fontScale({ w: 50, h: 25, font: "M" }));
    expect(fontScale({ w: 50, h: 25, font: "L" })).toBeGreaterThan(fontScale({ w: 50, h: 25, font: "S" }));
  });

  it("an old stored copy is read back through the defaults", () => {
    const s = withDefaults({ w: 75, fields: { item_name: false } as never });
    expect(s.w).toBe(75);
    expect(s.fields.item_name).toBe(false);
    expect(s.fields.batch).toBe(true);
    expect(s.code).toBe("BOTH");
  });
});

describe("parent labels and issued packs (2026-10-28)", () => {
  const tree: DocLabelRow[] = [
    row({ key: "h-9", code: "CAR-1", context: true }),
    row({ key: "h-1", code: "BOX-1", issued: true, depth: 1, path: [{ code: "CAR-1" }] }),
    row({ key: "h-2", code: "STR-1", depth: 2, path: [{ code: "CAR-1" }, { code: "BOX-1" }] }),
    row({ key: "h-8", code: "CAR-2", context: true, line_id: 2 }),
    row({ key: "h-4", code: "BOX-9", issued: true, line_id: 2, path: [{ code: "CAR-2" }] }),
  ];

  it("a parent label rides on top of what is printed under it, and can be left off", () => {
    expect(selectLabels(tree, { lineIds: null, packs: "ALL", units: false, parents: true }).map((r) => r.code))
      .toEqual(["CAR-1", "BOX-1", "STR-1", "CAR-2", "BOX-9"]);
    expect(selectLabels(tree, { lineIds: null, packs: "ALL", units: false, parents: false }).map((r) => r.code))
      .toEqual(["BOX-1", "STR-1", "BOX-9"]);
  });

  it("issued packs only, and a parent with nothing printed under it is dropped", () => {
    expect(selectLabels(tree, { lineIds: [1], packs: "TOP", units: false, parents: true }).map((r) => r.code))
      .toEqual(["CAR-1", "BOX-1"]);
  });
});
