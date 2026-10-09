import { describe, expect, it } from "vitest";
import { resolveAcceptedUnits, unitsForAccepted, unitsStillToReject } from "../qcUnits";

/**
 * Which units a QC line is keeping, repaired for pre-seed rows.
 *
 * The picker reads a stored empty list as "every unit rejected", which is
 * right for a line that rejected everything and wrong for a line raised
 * before every kind was seeded — stored with nothing while accepting the
 * whole offered set. The accepted quantity tells the two apart: only a full
 * acceptance is repaired.
 */

describe("resolveAcceptedUnits", () => {
  it("keeps an explicit selection untouched", () => {
    expect(resolveAcceptedUnits(["A", "B"], ["A", "B", "C"], 2))
      .toEqual(["A", "B"]);
  });

  it("repairs a stored-empty line that accepts the whole offered set", () => {
    // QC0013's SIM line: nothing stored, 3 accepted of 3 offered.
    expect(resolveAcceptedUnits([], ["I1", "I2", "I3"], 3))
      .toEqual(["I1", "I2", "I3"]);
  });

  it("repairs a never-touched line the same way", () => {
    expect(resolveAcceptedUnits(null, ["I1", "I2"], 2)).toEqual(["I1", "I2"]);
    expect(resolveAcceptedUnits(undefined, ["I1", "I2"], 2))
      .toEqual(["I1", "I2"]);
  });

  it("leaves a genuinely rejected line rejected", () => {
    expect(resolveAcceptedUnits([], ["I1", "I2", "I3"], 0)).toEqual([]);
    expect(resolveAcceptedUnits(null, ["I1", "I2", "I3"], 0)).toEqual([]);
  });

  it("leaves an inconsistent line alone instead of masking it", () => {
    // Accepted 1 of 3 with nothing stored is a real inconsistency — repairing
    // it to 3 would disagree with the accepted quantity, so the save
    // validation reports it instead.
    expect(resolveAcceptedUnits([], ["I1", "I2", "I3"], 1)).toEqual([]);
  });

  it("leaves lines with nothing offered alone", () => {
    expect(resolveAcceptedUnits([], null, 2)).toEqual([]);
    expect(resolveAcceptedUnits(null, null, 0)).toEqual([]);
    expect(resolveAcceptedUnits(null, [], 2)).toEqual([]);
  });

  it("returns a copy of the offered set, not the set itself", () => {
    const available = ["I1", "I2"];
    const resolved = resolveAcceptedUnits([], available, 2);
    expect(resolved).toEqual(available);
    expect(resolved).not.toBe(available);
  });
});

/**
 * Outward QC: every unit is accepted by default, and a rejected quantity is then
 * picked unit by unit. Moving the numbers never decides which units failed.
 */
describe("unitsForAccepted", () => {
  const offered = ["A", "B", "C", "D", "E"];

  it("accepts every unit while nothing is rejected", () => {
    expect(unitsForAccepted(null, offered, 5, 5)).toEqual(offered);
  });

  it("keeps the set when more are rejected, so the inspector picks which", () => {
    // 2 rejected: still five kept, two still to tick.
    const kept = unitsForAccepted(null, offered, 5, 3);
    expect(kept).toEqual(offered);
    expect(unitsStillToReject(kept.length, 3)).toBe(2);
  });

  it("re-accepts ticked rejects when the rejected quantity comes down", () => {
    // B, C and D were rejected; now only one is.
    expect(unitsForAccepted(["A", "E"], offered, 2, 4)).toEqual(["A", "C", "D", "E"]);
  });

  it("accepts everything again when the line is fully accepted", () => {
    expect(unitsForAccepted(["A"], offered, 1, 5)).toEqual(offered);
  });

  it("leaves a completed pick alone", () => {
    expect(unitsForAccepted(["A", "C", "E"], offered, 3, 3)).toEqual(["A", "C", "E"]);
    expect(unitsStillToReject(3, 3)).toBe(0);
  });
});
