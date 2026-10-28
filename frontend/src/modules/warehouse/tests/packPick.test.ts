import { describe, expect, it } from "vitest";
import {
  cartonsTouched, heldMix, indexPacks, judgeScan, pickSentence, planOf, rollUp,
  setStripCount, shortCode, suggestPick, takeStripsUpTo, unitsOf,
} from "../packPick";
import type { BoxSource } from "../types";

/**
 * The package pick, tested without a screen: two cartons of boxes of 100, each box
 * ten strips of 10 — the Paracetamol shelf from the 2026-10-28 screenshot.
 */

let next = 1;
const pack = (over: Partial<BoxSource>): BoxSource => ({
  id: next++, code: `PK-${next}`, pack_name: "Box", holds: 100, size: 100, part: false,
  held_by_this_issue: false, held_by: null, level: 2, parent_id: null, ...over,
});

function shelf(opts: { openedFirst?: boolean } = {}) {
  next = 1;
  const out: BoxSource[] = [];
  const cartons = [
    { id: 900, code: "PK-WH-1549-0000571", holds: opts.openedFirst ? 300 : 1000 },
    { id: 901, code: "PK-WH-1549-0000572", holds: 1000 },
  ];
  for (const c of cartons) {
    const boxes = c.holds / 100;
    for (let b = 0; b < boxes; b += 1) {
      const box = pack({
        code: `${c.code}-B${b}`, parent_id: c.id, parent_code: c.code, parent_pack_name: "Carton",
        parent_holds: c.holds, parent_size: 1000,
      });
      out.push(box);
      for (let s = 0; s < 10; s += 1) {
        out.push(pack({ code: `${box.code}-S${s}`, pack_name: "Strip", holds: 10, size: 10,
          level: 1, parent_id: box.id, units: [`${box.code}-S${s}-U`] }));
      }
    }
  }
  return out;
}

describe("suggestPick", () => {
  it("takes whole boxes, then the remainder as strips out of one box", () => {
    const idx = indexPacks(shelf());
    const pick = suggestPick(idx, 450);
    const rows = planOf(pick, idx, 450);
    expect(rows.reduce((s, r) => s + r.take, 0)).toBe(450);
    expect(pickSentence(rows, idx)).toBe("Take 4 boxes + 5 strips from carton …0571");
    expect(cartonsTouched(rows, idx)).toBe(1);
  });

  it("finishes in the opened carton before breaking a full one", () => {
    const idx = indexPacks(shelf({ openedFirst: true }));
    expect(idx.groups[0].opened).toBe(true);
    const rows = planOf(suggestPick(idx, 250), idx, 250);
    expect(pickSentence(rows, idx)).toBe("Take 2 boxes + 5 strips from carton …0571");
  });

  it("leaves the last strip in part when the quantity does not fill it", () => {
    const idx = indexPacks(shelf());
    const rows = planOf(suggestPick(idx, 103), idx, 103);
    expect(pickSentence(rows, idx)).toBe("Take 1 box + part strip (3) from carton …0571");
  });

  it("skips packs another issue holds", () => {
    const packs = shelf();
    packs[0].held_by = "WHI0009";
    const idx = indexPacks(packs);
    expect(suggestPick(idx, 100)).not.toContain(packs[0].code);
  });
});

describe("rollUp", () => {
  it("turns every strip of a box into the box itself", () => {
    const idx = indexPacks(shelf());
    const box = idx.groups[0].packs[0];
    const strips = idx.inner.get(box.id)!.map((s) => s.code);
    expect(rollUp(strips, idx)).toEqual([box.code]);
  });

  it("leaves a box whose strips are only partly taken", () => {
    const idx = indexPacks(shelf());
    const box = idx.groups[0].packs[0];
    const strips = idx.inner.get(box.id)!.slice(0, 9).map((s) => s.code);
    expect(rollUp(strips, idx)).toEqual(strips);
  });
});

describe("strips", () => {
  it("tapping the j-th strip takes strips up to there, and again gives the last back", () => {
    const idx = indexPacks(shelf());
    const box = idx.groups[0].packs[0];
    const once = takeStripsUpTo([], box, 4, idx);
    expect(once).toHaveLength(5);
    expect(takeStripsUpTo(once, box, 4, idx)).toHaveLength(4);
  });

  it("a stepper on a box taken whole opens it into strips", () => {
    const idx = indexPacks(shelf());
    const box = idx.groups[0].packs[0];
    const out = setStripCount([box.code], box, 9, idx);
    expect(out).not.toContain(box.code);
    expect(out).toHaveLength(9);
    expect(setStripCount(out, box, 10, idx)).toEqual([box.code]);
  });
});

describe("scanning", () => {
  it("refuses a pack inside one already taken, and adds a free one", () => {
    const idx = indexPacks(shelf());
    const box = idx.groups[0].packs[0];
    const strip = idx.inner.get(box.id)![0];
    expect(judgeScan(strip.code, [box.code], idx).tone).toBe("bad");
    const ok = judgeScan(box.code, [], idx);
    expect(ok.tone).toBe("ok");
    expect(ok.next).toEqual([box.code]);
  });

  it("refuses a code that is not on this shelf, changing nothing", () => {
    const idx = indexPacks(shelf());
    const v = judgeScan("NOPE-1", ["x"], idx);
    expect(v.tone).toBe("bad");
    expect(v.next).toEqual(["x"]);
  });
});

describe("words", () => {
  it("shortens a code to what can be found on a carton", () => {
    expect(shortCode("PK-WH-1549-0000593")).toBe("…0593");
  });

  it("says a held mix in pack names, never '45 boxes' for strips", () => {
    expect(heldMix([
      { pack_name: "Box", take: 100, holds: 100 },
      { pack_name: "Strip", take: 10, holds: 10 },
      { pack_name: "Strip", take: 10, holds: 10 },
      { pack_name: "Strip", take: 3, holds: 10 },
    ])).toBe("1 box + 2 strips + part strip (3)");
  });

  it("a box's units include those filed under its strips", () => {
    const idx = indexPacks(shelf());
    const box = idx.groups[0].packs[0];
    expect(unitsOf(box, idx)).toHaveLength(10);
  });
});
