import { describe, expect, it } from "vitest";
import { sanitizeQuantityInput } from "../quantity";

describe("sanitizeQuantityInput", () => {
  it("drops letters and symbols as they are typed or pasted", () => {
    expect(sanitizeQuantityInput("abc")).toBe("");
    expect(sanitizeQuantityInput("1e5")).toBe("15");
    expect(sanitizeQuantityInput("-5")).toBe("5");
    expect(sanitizeQuantityInput("12 NOS")).toBe("12");
    expect(sanitizeQuantityInput("1,000")).toBe("1000");
  });
  it("keeps one decimal point and cuts the fraction to the unit's places", () => {
    expect(sanitizeQuantityInput("1.2.3")).toBe("1.23");
    expect(sanitizeQuantityInput("5.12345")).toBe("5.123");
    expect(sanitizeQuantityInput("5.12345", 2)).toBe("5.12");
  });
  it("lets a half-typed number exist", () => {
    expect(sanitizeQuantityInput("")).toBe("");
    expect(sanitizeQuantityInput("5.")).toBe("5.");
    expect(sanitizeQuantityInput(".5")).toBe(".5");
  });
  it("whole-unit units take no fraction at all", () => {
    expect(sanitizeQuantityInput("5.7", 0)).toBe("5");
    expect(sanitizeQuantityInput("5.", 0)).toBe("5");
  });
});
