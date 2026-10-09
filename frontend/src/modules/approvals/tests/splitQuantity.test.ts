import { describe, expect, it } from "vitest";
import { splitQuantity } from "../pages/ConsolidationPage";

describe("splitQuantity", () => {
  it("splits an even total evenly", () => {
    expect(splitQuantity(45, [10, 10, 10, 10, 10])).toEqual([9, 9, 9, 9, 9]);
  });

  it("hands the leftover units out one at a time, never a fraction", () => {
    const shares = splitQuantity(43, [10, 10, 10, 10, 10]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(43);
    expect(shares.filter((s) => s === 9)).toHaveLength(3);
    expect(shares.filter((s) => s === 8)).toHaveLength(2);
  });

  it("weights the split by what each indent asked for", () => {
    expect(splitQuantity(50, [60, 40])).toEqual([30, 20]);
  });

  it("gives the whole total to the only requester left", () => {
    expect(splitQuantity(45, [10])).toEqual([45]);
  });

  it("splits a fractional total without losing any of it", () => {
    const shares = splitQuantity(43.5, [10, 10, 10]);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(43.5, 3);
  });

  it("allocates nothing when there is nothing to give or nobody to give it to", () => {
    expect(splitQuantity(0, [10, 10])).toEqual([0, 0]);
    expect(splitQuantity(10, [0, 0])).toEqual([0, 0]);
    expect(splitQuantity(10, [])).toEqual([]);
  });
});
