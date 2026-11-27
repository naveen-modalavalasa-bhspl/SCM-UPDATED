import { describe, expect, it } from "vitest";
import { codesTakenElsewhere, fillsCodesItself, topUpCodes } from "../issueSplits";
import type { IssueItemWrite } from "../types";

const line = (over: Partial<IssueItemWrite>): IssueItemWrite =>
  ({ item_id: 7, issued_qty: 0, requested_qty: 0, serial_numbers: [], ...over } as IssueItemWrite);

describe("topUpCodes (QA-5 BUG_003 / BUG_009)", () => {
  const shelf = ["A1", "A2", "A3", "A4", "A5", "A6"];

  it("fills a pick to its quantity, oldest first", () => {
    expect(topUpCodes([], 3, shelf, new Set())).toEqual(["A1", "A2", "A3"]);
  });

  it("a second batch given a PART quantity is filled to exactly that part", () => {
    // Batch two holds six, the storekeeper takes two of them.
    expect(topUpCodes([], 2, ["B1", "B2", "B3", "B4", "B5", "B6"], new Set())).toEqual(["B1", "B2"]);
  });

  it("keeps codes the storekeeper swapped in by hand and only adds the rest", () => {
    expect(topUpCodes(["A5"], 3, shelf, new Set())).toEqual(["A5", "A1", "A2"]);
  });

  it("never hands out a code another pick of the item already holds", () => {
    expect(topUpCodes([], 3, shelf, new Set(["A1", "A2"]))).toEqual(["A3", "A4", "A5"]);
  });

  it("drops a held code that another pick has since claimed, and refills", () => {
    expect(topUpCodes(["A1", "A2"], 2, shelf, new Set(["A1"]))).toEqual(["A2", "A3"]);
  });

  it("never goes past the quantity, and stops short when the shelf does", () => {
    expect(topUpCodes(["A1", "A2", "A3"], 2, shelf, new Set())).toEqual(["A1", "A2"]);
    expect(topUpCodes([], 10, ["A1", "A2"], new Set())).toEqual(["A1", "A2"]);
    expect(topUpCodes(["A1"], 0, shelf, new Set())).toEqual([]);
  });

  it("ignores duplicates and blanks in what the shelf returned", () => {
    expect(topUpCodes([], 3, ["A1", "", "A1", "A2", "A3"], new Set())).toEqual(["A1", "A2", "A3"]);
  });
});

describe("codesTakenElsewhere", () => {
  it("collects the codes held by OTHER picks of the same item only", () => {
    const lines = [
      line({ serial_numbers: ["A1", "A2"] }),
      line({ serial_numbers: ["B1"] }),
      line({ item_id: 9, serial_numbers: ["Z1"] }),
    ];
    expect([...codesTakenElsewhere(lines, 1)]).toEqual(["A1", "A2"]);
    expect([...codesTakenElsewhere(lines, 0)]).toEqual(["B1"]);
  });
});

describe("fillsCodesItself", () => {
  it("fills asset and consumable codes, never serials or IMEIs", () => {
    expect(fillsCodesItself({ tracking_type: "ASSET" })).toBe(true);
    expect(fillsCodesItself({ tracking_type: "CONSUMABLE" })).toBe(true);
    expect(fillsCodesItself({ tracking_type: "SERIAL" })).toBe(false);
    expect(fillsCodesItself({ tracking_type: "IMEI" })).toBe(false);
  });
});
