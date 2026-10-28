import { describe, expect, it } from "vitest";
import {
  baseOf, checkFrom, expandPacks, shrinkWithin, splitByCheck, type PackEntry,
} from "@/shared/packing";

/* The supplier's 120 NOS: 2 full cartons of 50 and one part carton holding 20. */
const declared: PackEntry[] = [
  { item_packaging_id: 7, level: 1, name: "cartoon", size: 50, qty: 2, hierarchy: "Cartoon of 50" },
  { item_packaging_id: 7, level: 1, name: "cartoon", size: 50, qty: 1, fill: 20, hierarchy: "Cartoon of 50" },
];

describe("pack-by-pack checks", () => {
  it("expands a breakdown into one row per physical pack", () => {
    const packs = expandPacks(declared);
    expect(packs.map((p) => [p.label, p.carries])).toEqual([
      ["cartoon 1", 50], ["cartoon 2", 50], ["cartoon 3", 20],
    ]);
  });

  it("a missing pack leaves whole; a short pack stays as a part pack", () => {
    const packs = expandPacks(declared);
    const { kept, lost, keptQty, lostQty } = splitByCheck(packs, {
      kept: ["cartoon-1", "cartoon-3"], partial: { "cartoon-1": 5 },
    });
    expect(keptQty).toBe(65);
    expect(lostQty).toBe(55);
    // 1 carton holding 45 + the part carton of 20 kept; carton 2 gone whole, 5 loose short.
    expect(kept.map((e) => [e.level, Number(e.qty), e.fill ?? null])).toEqual([[1, 1, 45], [1, 1, 20]]);
    expect(lost.map((e) => [e.level, Number(e.qty), e.fill ?? null])).toEqual([[1, 1, null], [0, 5, null]]);
    // Never more cartons than the supplier sent, which is the server's rule.
    const cartons = [...kept, ...lost].filter((e) => e.level === 1).reduce((s, e) => s + Number(e.qty), 0);
    expect(cartons).toBeLessThanOrEqual(3);
    expect(baseOf(kept) + baseOf(lost)).toBe(120);
  });

  it("reads a saved verdict back to the same packs", () => {
    const packs = expandPacks(declared);
    const verdict = { kept: ["cartoon-1", "cartoon-3"], partial: { "cartoon-1": 5 } };
    const { kept } = splitByCheck(packs, verdict);
    const back = checkFrom(packs, kept);
    expect(splitByCheck(packs, back).keptQty).toBe(65);
    expect(back.kept).toHaveLength(2);
  });

  it("reads a typed short count as a pack kept short, not as a pack lost", () => {
    const packs = expandPacks(declared);
    // 110 typed: cut down it is 2 cartons + 10 loose.
    const back = checkFrom(packs, shrinkWithin(declared, 110));
    expect(back.kept).toHaveLength(3);
    expect(back.partial).toEqual({ "cartoon-3": 10 });
    expect(splitByCheck(packs, back).keptQty).toBe(110);
  });

  it("loose units are one row and can come short", () => {
    const mixed: PackEntry[] = [...declared, { item_packaging_id: null, level: 0, name: "Loose", size: 1, qty: 6 }];
    const packs = expandPacks(mixed);
    expect(packs.at(-1)?.carries).toBe(6);
    const { keptQty } = splitByCheck(packs, {
      kept: packs.map((p) => p.code), partial: { Loose: 2 },
    });
    expect(keptQty).toBe(124);
  });
});
