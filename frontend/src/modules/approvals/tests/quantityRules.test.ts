import { describe, expect, it } from "vitest";
import {
  acceptsQuantityInput, allowedRange, approvalCeiling, formatQuantity, quantityDecimals,
  quantityError, wasReducedBelow,
} from "../quantityRules";
import type { ApprovalIndentLine } from "../types";

const line = (over: Partial<ApprovalIndentLine> = {}): ApprovalIndentLine => ({
  id: 1, item_id: 9, item_code: "PEP", item_name: "Pepsi", uom_code: "EA",
  requested_quantity: 5, approved_quantity: 5, max_quantity: 5, ...over,
});

describe("approvalCeiling", () => {
  it("caps the first approver at the requested quantity", () => {
    expect(approvalCeiling(line())).toBe(5);
  });

  it("caps a later approver at what the level below approved", () => {
    expect(approvalCeiling(line({ max_quantity: 3, approved_quantity: 3 }))).toBe(3);
  });

  it("falls back to the request when the server sent no ceiling", () => {
    expect(approvalCeiling(line({ max_quantity: undefined as never }))).toBe(5);
  });

  it("keeps a zero ceiling — a level below may approve nothing", () => {
    expect(approvalCeiling(line({ max_quantity: 0 }))).toBe(0);
  });

  it("walks the storekeeper → OE → DM → RM ladder down, never back up", () => {
    // 20 raised, cut to 10 by the OE, then to 6 by the DM: each rung is capped by
    // the rung below it, so the RM sees 6 and can only go lower.
    const rungs = [20, 10, 6].map((max) =>
      approvalCeiling(line({ requested_quantity: 20, max_quantity: max })));
    expect(rungs).toEqual([20, 10, 6]);
    expect(quantityError(line({ requested_quantity: 20, max_quantity: 6 }), "10"))
      .toMatch(/can't approve more than 6 EA/);
    expect(quantityError(line({ requested_quantity: 20, max_quantity: 6 }), "4")).toBeNull();
  });
});

describe("wasReducedBelow", () => {
  it("is false at the first level and true once someone has cut the line", () => {
    expect(wasReducedBelow(line())).toBe(false);
    expect(wasReducedBelow(line({ max_quantity: 3 }))).toBe(true);
  });
});

describe("allowedRange", () => {
  it("reads as the range a non-technical approver is allowed to type", () => {
    expect(allowedRange(line({ max_quantity: 15 }))).toBe("0 to 15 EA");
    expect(allowedRange(line({ max_quantity: 15, uom_code: null }))).toBe("0 to 15");
  });
});

describe("quantityError", () => {
  it("passes a value inside the ceiling", () => {
    expect(quantityError(line(), "3")).toBeNull();
    expect(quantityError(line(), "0")).toBeNull();
    expect(quantityError(line(), "5")).toBeNull();
    expect(quantityError(line({ uom_code: "KG", uom_decimals: 3 }), "4.125")).toBeNull();
  });

  it("names the cap when the entry is too high", () => {
    expect(quantityError(line({ max_quantity: 15 }), "16"))
      .toBe("You can't approve more than 15 EA.");
  });

  it("caps against the level below, not the original request", () => {
    expect(quantityError(line({ max_quantity: 3 }), "5")).toMatch(/more than 3 EA/);
  });

  it("explains a negative instead of refusing the minus key", () => {
    expect(quantityError(line({ max_quantity: 15 }), "-1"))
      .toBe("Cannot enter a negative number.");
    expect(quantityError(line(), "-")).toBe("Cannot enter a negative number.");
  });

  it("explains blank and non-numeric input", () => {
    expect(quantityError(line({ max_quantity: 15 }), ""))
      .toBe("Enter a quantity from 0 to 15 EA. Enter 0 to reject this item.");
    expect(quantityError(line(), undefined)).toMatch(/Enter a quantity from 0 to 5 EA/);
    expect(quantityError(line(), "abc")).toMatch(/Enter a valid number/);
    expect(quantityError(line(), "1e3")).toMatch(/Enter a valid number/);
  });

  it("rejects a decimal finer than the database can store", () => {
    expect(quantityError(line({ uom_code: "KG", uom_decimals: 3 }), "1.2345"))
      .toBe("Use up to 3 decimal places (for example 1.5).");
  });

  it("uses authoritative UOM precision and rejects fractions for NOS", () => {
    const nos = line({ uom_code: "NOS", uom_decimals: 0 });
    expect(quantityDecimals(nos)).toBe(0);
    expect(acceptsQuantityInput(nos, "10")).toBe(true);
    expect(acceptsQuantityInput(nos, "10.5")).toBe(false);
    expect(acceptsQuantityInput(nos, "abc")).toBe(false);
    expect(quantityError(nos, "4.5")).toBe(
      "NOS accepts whole numbers only (for example 1 or 10).",
    );
  });

  it("allows decimals only to the precision configured by a measured UOM", () => {
    const litres = line({ uom_code: "LTR", uom_decimals: 2 });
    expect(acceptsQuantityInput(litres, "1.25")).toBe(true);
    expect(acceptsQuantityInput(litres, "1.256")).toBe(false);
    expect(acceptsQuantityInput(litres, "one")).toBe(false);
    expect(quantityError(litres, "1.25")).toBeNull();
    expect(quantityError(litres, "1.256")).toBe("Use up to 2 decimal places (for example 1.5).");
  });

  it("falls back safely for older API responses", () => {
    expect(quantityDecimals(line({ uom_code: "UOM-NOS", uom_decimals: undefined }))).toBe(0);
    expect(quantityDecimals(line({ uom_code: "KG", uom_decimals: undefined }))).toBe(3);
  });
});

describe("formatQuantity", () => {
  it("drops the stored trailing zeros", () => {
    expect(formatQuantity(5)).toBe("5");
    expect(formatQuantity(4.5)).toBe("4.5");
    expect(formatQuantity(-2)).toBe("-2");
  });
});
