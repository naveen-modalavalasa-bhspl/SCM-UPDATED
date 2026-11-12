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
  });
  it("never lets a quantity start with a point — SCM_0156", () => {
    expect(sanitizeQuantityInput(".5")).toBe("0.5");
    expect(sanitizeQuantityInput(".")).toBe("0.");
    expect(sanitizeQuantityInput(".5", 0)).toBe("");
  });
  it("whole-unit units take no fraction at all", () => {
    expect(sanitizeQuantityInput("5.7", 0)).toBe("5");
    expect(sanitizeQuantityInput("5.", 0)).toBe("5");
  });
});

import { acceptsQuantityEdit, leadingZeroFix, quantityProblem } from "../quantity";

describe("acceptsQuantityEdit (keystroke block)", () => {
  it("refuses letters, signs and a second point", () => {
    expect(acceptsQuantityEdit("5", 1, 1, "e")).toBe(false);
    expect(acceptsQuantityEdit("5", 1, 1, "-")).toBe(false);
    expect(acceptsQuantityEdit("5.1", 3, 3, ".")).toBe(false);
  });
  it("refuses the point and any fraction for a whole-unit unit", () => {
    expect(acceptsQuantityEdit("5", 1, 1, ".", 0)).toBe(false);
    expect(acceptsQuantityEdit("5", 1, 1, "7", 0)).toBe(true);
  });
  it("refuses a digit past the unit places, but allows replacing a selection", () => {
    expect(acceptsQuantityEdit("1.25", 4, 4, "5", 2)).toBe(false);
    expect(acceptsQuantityEdit("1.25", 3, 4, "7", 2)).toBe(true);
  });
});

describe("quantityProblem (validation net)", () => {
  it("rejects fractions of a whole-unit unit", () => {
    expect(quantityProblem("2.5", { decimals: 0, unit: "NOS", max: 10 })).toMatch(/whole/);
    expect(quantityProblem("2", { decimals: 0, max: 10 })).toBeNull();
  });
  it("enforces the places, minimum and maximum of the unit", () => {
    expect(quantityProblem("1.234", { decimals: 2 })).toMatch(/up to 2 decimal places/);
    expect(quantityProblem("1", { min: 2 })).toMatch(/less than 2/);
    expect(quantityProblem("11", { max: 10, unit: "KG" })).toMatch(/more than 10 KG/);
    expect(quantityProblem("10", { max: 10 })).toBeNull();
  });
});

describe("a leading point (SCM_0156)", () => {
  it("is refused as typed, and the box is offered 0. instead", () => {
    expect(acceptsQuantityEdit("", 0, 0, ".")).toBe(false);
    expect(leadingZeroFix(".")).toBe("0.");
    expect(leadingZeroFix(".5")).toBe("0.5");
  });
  it("is no fix for a whole-unit unit, or for anything else that is wrong", () => {
    expect(leadingZeroFix(".", 0)).toBeNull();
    expect(leadingZeroFix("5.")).toBeNull();
    expect(leadingZeroFix(".a")).toBeNull();
  });
  it("is explained in words when it is already in a box", () => {
    expect(quantityProblem(".5", { unit: "KG" })).toMatch(/write 0\.5, not \.5/);
    expect(quantityProblem("0.5", { unit: "KG" })).toBeNull();
  });
});
