import { describe as group, expect, it } from "vitest";
import {
  type PackHierarchy, baseOf, countsOf, describe, greedy, matchState, shrinkWithin,
  toPayload,
} from "@/shared/packing/packing";

const STRIP_OF_10: PackHierarchy = {
  hierarchy_id: 1, name: "Strip of 10", base_uom: "TAB",
  levels: [
    { item_packaging_id: null, level: 0, name: "Loose TAB", size: 1, ratio: 1, label: "Loose TAB" },
    { item_packaging_id: 11, level: 1, name: "Strip", size: 10, ratio: 10, label: "Strip (10 TAB)" },
    { item_packaging_id: 12, level: 2, name: "Box", size: 100, ratio: 10, label: "Box" },
    { item_packaging_id: 13, level: 3, name: "Carton", size: 1200, ratio: 12, label: "Carton" },
  ],
};

group("pack arithmetic mirrors the server", () => {
  it("fills the biggest packs first and leaves the rest loose", () => {
    const out = greedy(STRIP_OF_10, 2745);
    expect(countsOf(out)).toEqual({ 3: 2, 2: 3, 1: 4, 0: 5 });
    expect(baseOf(out)).toBe(2745);
    expect(describe(out, "TAB")).toBe("2 Carton + 3 Box + 4 Strip + 5 loose TAB = 2,745 TAB");
  });

  it("reads a short delivery inside the declared packs", () => {
    const declared = greedy(STRIP_OF_10, 2400, 3);
    // Two cartons were declared, so 2,300 is one carton and the rest loose — a count
    // never invents a level the supplier did not send.
    expect(countsOf(shrinkWithin(declared, 2300))).toEqual({ 3: 1, 0: 1100 });
  });

  it("says whether the packs make the quantity", () => {
    const packs = greedy(STRIP_OF_10, 200);
    expect(matchState(packs, 200).state).toBe("match");
    expect(matchState(packs, 250)).toEqual({ state: "short", gap: 50 });
    expect(matchState(packs, 150)).toEqual({ state: "over", gap: 50 });
  });

  it("sends only what the server needs", () => {
    expect(toPayload(greedy(STRIP_OF_10, 110))).toEqual([
      { item_packaging_id: 12, level: 2, qty: 1 },
      { item_packaging_id: 11, level: 1, qty: 1 },
    ]);
  });
});

const CARTON_600: PackHierarchy = {
  hierarchy_id: 7, name: "Carton of 600", base_uom: "NOS",
  levels: [
    { item_packaging_id: null, level: 0, name: "Loose NOS", size: 1, ratio: 1, label: "Loose NOS" },
    { item_packaging_id: 71, level: 1, name: "Box", size: 100, ratio: 100, label: "Box" },
    { item_packaging_id: 72, level: 2, name: "Carton", size: 600, ratio: 6, label: "Carton",
      min_fill: 400 },
  ],
};

group("part packs (2026-10-11)", () => {
  it("counts a part pack at what it holds and says so", async () => {
    const { partEntry } = await import("@/shared/packing/packing");
    const out = [partEntry(CARTON_600, 2, 500)];
    expect(baseOf(out)).toBe(500);
    expect(describe(out, "NOS")).toBe("1 Carton (500 of 600) = 500 NOS");
    expect(toPayload(out)).toEqual([{ item_packaging_id: 72, level: 2, qty: 1, fill: 500 }]);
  });

  it("puts the remainder in one part pack of the same level", async () => {
    const { greedyWithPart, isPartial } = await import("@/shared/packing/packing");
    const out = greedyWithPart(CARTON_600, 1000);
    expect(baseOf(out)).toBe(1000);
    expect(out.filter(isPartial).map((e) => Number(e.fill))).toEqual([400]);
  });

  it("falls back to whole packs when the remainder is under the minimum", async () => {
    const { greedyWithPart, isPartial } = await import("@/shared/packing/packing");
    const out = greedyWithPart(CARTON_600, 900);   // 300 left, under the 400 floor
    expect(out.some(isPartial)).toBe(false);
    expect(countsOf(out)).toEqual({ 2: 1, 1: 3 });
  });

  it("warns about a pack under its minimum and about two part packs, never blocks", async () => {
    const { packWarnings, partEntry } = await import("@/shared/packing/packing");
    expect(packWarnings([partEntry(CARTON_600, 2, 300)], CARTON_600, "NOS")[0])
      .toMatch(/below the 400 NOS minimum/);
    expect(packWarnings([partEntry(CARTON_600, 2, 500, 2)], CARTON_600, "NOS")[0])
      .toMatch(/2 part-filled Carton/);
  });
});
