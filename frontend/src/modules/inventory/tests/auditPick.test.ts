import { describe, expect, it } from "vitest";
import {
  codesOf, covered, emptyPick, findCode, packBlocked, pickFromCodes, pickedTotal,
  suggestPick, togglePack, toggleUnit, unitBlocked,
} from "../auditPick";
import type { AuditPack, AuditSources, AuditUnit } from "../types";

// The shelf: a carton (10) holding two boxes of 5, every unit coded, plus 2 loose.
const pack = (id: number, code: string, holds: number, parent: number | null,
              extra: Partial<AuditPack> = {}): AuditPack => ({
  id, code, name: parent ? "Box" : "Carton", level: parent ? 1 : 2, holds, size: holds,
  parent_id: parent, held_by: null, selectable: true, ...extra,
});
const unit = (id: number, packId: number | null, extra: Partial<AuditUnit> = {}): AuditUnit => ({
  id, code: `A${id}`, alt: `S${id}`, pack_id: packId, held_by: null, selectable: true, ...extra,
});

const shelf = (mode: AuditSources["mode"] = "CODES"): AuditSources => ({
  mode, tracking: mode === "UNITS" ? "SERIAL" : "ASSET", system_qty: 12, truncated: false,
  mixed: false,
  packs: [pack(1, "CAR-1", 10, null), pack(2, "BOX-A", 5, 1), pack(3, "BOX-B", 5, 1)],
  units: [
    ...[1, 2, 3, 4, 5].map((i) => unit(i, 2)),
    ...[6, 7, 8, 9, 10].map((i) => unit(i, 3)),
    unit(11, null), unit(12, null),
  ],
});

describe("a write-off pick", () => {
  it("counts a whole pack as everything inside it", () => {
    const s = shelf();
    const pick = togglePack(emptyPick(), s.packs[1], s);
    expect(pickedTotal(pick, s)).toBe(5);
    expect([...covered(pick, s).units].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("never lets a unit inside a picked pack be picked again", () => {
    const s = shelf();
    const pick = togglePack(emptyPick(), s.packs[1], s);
    expect(unitBlocked(s.units[0], pick, s, 7)).toBe("Inside a pack you picked");
    expect(unitBlocked(s.units[10], pick, s, 7)).toBeNull();
  });

  it("replaces units already picked inside a pack when the pack is taken whole", () => {
    const s = shelf();
    let pick = toggleUnit(emptyPick(), s.units[0]);
    pick = togglePack(pick, s.packs[1], s);
    expect(pick.unitIds.size).toBe(0);
    expect(pickedTotal(pick, s)).toBe(5);
  });

  it("refuses a pack bigger than what is left to pick", () => {
    const s = shelf();
    expect(packBlocked(s.packs[0], emptyPick(), s, 7)).toMatch(/Holds more than the 7/);
    expect(packBlocked(s.packs[1], emptyPick(), s, 7)).toBeNull();
  });

  it("refuses a held pack, and a pack inside one already picked", () => {
    const s = shelf();
    s.packs[2] = { ...s.packs[2], selectable: false, held_by: "WHI0009" };
    expect(packBlocked(s.packs[2], emptyPick(), s, 7)).toBe("Held — WHI0009");
    const all = togglePack(emptyPick(), s.packs[0], s);
    expect(packBlocked(s.packs[1], all, s, 12)).toBe("Inside a pack you picked");
  });

  it("stops at the shortfall", () => {
    const s = shelf();
    const pick = toggleUnit(toggleUnit(emptyPick(), s.units[10]), s.units[11]);
    expect(unitBlocked(s.units[0], pick, s, 2)).toBe("The shortfall is covered");
  });
});

describe("suggestPick", () => {
  it("takes whole packs first, then loose units, to exactly the shortfall", () => {
    const s = shelf();
    const pick = suggestPick(s, 7);
    expect(pickedTotal(pick, s)).toBe(7);
    expect(codesOf(pick, s)).toEqual(["BOX-A", "A11", "A12"]);
  });

  it("takes the whole carton when the shortfall is all of it", () => {
    const s = shelf();
    expect(codesOf(suggestPick(s, 10), s)).toEqual(["CAR-1"]);
  });

  it("never suggests serials or IMEIs — those are picked by hand", () => {
    const s = shelf("UNITS");
    expect(pickedTotal(suggestPick(s, 3), s)).toBe(0);
  });
});

describe("codes in and out", () => {
  it("reads a saved line's codes back, a unit by either of its codes", () => {
    const s = shelf();
    const pick = pickFromCodes(["BOX-B", "S11"], s);
    expect([...pick.packIds]).toEqual([3]);
    expect([...pick.unitIds]).toEqual([11]);
  });

  it("finds a scanned pack or unit, and nothing for a stranger", () => {
    const s = shelf();
    expect(findCode("BOX-A", s)).toEqual({ pack: s.packs[1] });
    expect(findCode("S12", s)).toEqual({ unit: s.units[11] });
    expect(findCode("NOPE", s)).toBeNull();
  });
});
