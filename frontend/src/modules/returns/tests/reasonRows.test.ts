import { describe, expect, it } from "vitest";
import {
  lineReasonsFrom, newReasonRow, reasonProblems, reasonRowsFrom, reasonRowsPayload, reasonTotal,
  summariseReasons,
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

describe("reasons per item (SCM_0129)", () => {
  it("adds the whole return's reasons up over its items, most units first", () => {
    expect(summariseReasons([
      { reason: "EXPIRED", quantity: "2" },
      { reason: "DAMAGED", quantity: 3 },
      { reason: "DAMAGED", quantity: "4" },
      { reason: "", quantity: "9" },
    ], (r) => r.toLowerCase())).toEqual([
      { reason: "DAMAGED", label: "damaged", quantity: 7 },
      { reason: "EXPIRED", label: "expired", quantity: 2 },
    ]);
  });

  it("puts reasons given per item back on their own lines", () => {
    const { perLine, legacy } = lineReasonsFrom(
      [{ reason: "DAMAGED", quantity: 3, item_id: 1 },
       { reason: "EXPIRED", quantity: 2, item_id: 1 },
       { reason: "WRONG_ITEM", quantity: 4, item_id: 2 }],
      "DAMAGED", null,
      [{ item_id: 1, quantity: "5" }, { item_id: 2, quantity: "4" }]);
    expect(legacy).toEqual([]);
    expect(perLine[0].map((r) => [r.reason, r.quantity])).toEqual([["DAMAGED", "3"], ["EXPIRED", "2"]]);
    expect(perLine[1].map((r) => r.reason)).toEqual(["WRONG_ITEM"]);
  });

  it("opens every line on an older return's one reason", () => {
    const { perLine } = lineReasonsFrom(undefined, "EXPIRED", "past date",
      [{ item_id: 1, quantity: "5" }, { item_id: 2, quantity: 1 }]);
    expect(perLine.map((rows) => [rows[0].reason, rows[0].note, rows[0].quantity]))
      .toEqual([["EXPIRED", "past date", "5"], ["EXPIRED", "past date", "1"]]);
  });

  it("never guesses which unit an older multi-reason return meant", () => {
    const old = [{ reason: "DAMAGED", quantity: 3 }, { reason: "EXPIRED", quantity: 2 }];
    const many = lineReasonsFrom(old, "DAMAGED", null,
      [{ item_id: 1, quantity: 2 }, { item_id: 2, quantity: 3 }]);
    expect(many.legacy).toEqual(old);
    expect(many.perLine.every((rows) => rows.length === 1 && !rows[0].reason)).toBe(true);
    // One line: the old split IS that line's.
    const one = lineReasonsFrom(old, "DAMAGED", null, [{ item_id: 1, quantity: 5 }]);
    expect(one.legacy).toEqual([]);
    expect(one.perLine[0].map((r) => r.reason)).toEqual(["DAMAGED", "EXPIRED"]);
  });
});
