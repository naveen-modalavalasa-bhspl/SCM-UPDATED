import { describe, expect, it } from "vitest";
import { overCap, type DraftLine } from "../components/LinePicker";

/** A line with a ceiling may be lowered or left, never raised (2026-11-03). */
const line = (quantity: string, original_quantity?: string): DraftLine =>
  ({ item_id: 1, quantity, original_quantity });

describe("overCap", () => {
  it("lets a line come down or stay", () => {
    expect(overCap(line("7", "10"))).toBe(false);
    expect(overCap(line("10", "10"))).toBe(false);
  });
  it("refuses a line raised past what was asked", () => {
    expect(overCap(line("11", "10"))).toBe(true);
  });
  it("leaves a line with no ceiling (a hand-made draft) free", () => {
    expect(overCap(line("500"))).toBe(false);
  });
  it("can be switched off for a caller that does not cap", () => {
    expect(overCap(line("11", "10"), false)).toBe(false);
  });
});
