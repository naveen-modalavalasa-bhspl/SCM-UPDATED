import { describe, expect, it } from "vitest";
import {
  newReasonRow, reasonProblems, reasonRowsFrom, reasonRowsPayload, reasonTotal,
  withSingleRowFollowingTotal,
} from "../reasonRows";

const row = (reason: string, quantity: string, note = "") =>
  ({ ...newReasonRow(quantity), reason, note });

describe("reason rows", () => {
  it("a lone row is all of it and follows the total", () => {
    expect(withSingleRowFollowingTotal([row("DAMAGED", "")], 12)[0].quantity).toBe("12");
    const two = [row("DAMAGED", "10"), row("EXPIRED", "2")];
    expect(withSingleRowFollowingTotal(two, 99)).toBe(two);
  });

  it("must cover every unit, once per reason", () => {
    expect(reasonProblems([row("DAMAGED", "10"), row("EXPIRED", "2")], 12)).toEqual([]);
    expect(reasonProblems([row("DAMAGED", "10"), row("EXPIRED", "1")], 12)[0])
      .toMatch(/add up to 11 but 12/);
    expect(reasonProblems([row("DAMAGED", "6"), row("DAMAGED", "6")], 12))
      .toContain("Each reason can be on one row only.");
  });

  it("asks what Other means, and a reason for every row", () => {
    expect(reasonProblems([row("OTHER", "")], 5)[0]).toMatch(/what the problem is/);
    expect(reasonProblems([row("", "")], 5)).toContain("Pick a reason for every row.");
  });

  it("sends only complete rows, with trimmed notes", () => {
    expect(reasonRowsPayload([row("DAMAGED", "3", " crushed "), row("", "2")])).toEqual([
      { reason: "DAMAGED", quantity: "3", note: "crushed" }]);
    expect(reasonTotal([row("DAMAGED", "3"), row("EXPIRED", "2.5")])).toBe(5.5);
  });

  it("opens a return raised from an acknowledgement on one blank row for the total", () => {
    const [blank] = reasonRowsFrom([], null, null, 7);
    expect(blank.reason).toBe("");
    expect(blank.quantity).toBe("7");
    const [old] = reasonRowsFrom(undefined, "EXPIRED", "went off", 4);
    expect([old.reason, old.quantity, old.note]).toEqual(["EXPIRED", "4", "went off"]);
  });
});
