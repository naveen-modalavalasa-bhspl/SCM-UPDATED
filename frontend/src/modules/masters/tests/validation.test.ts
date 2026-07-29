import { describe, expect, it } from "vitest";
import { validateForm, type FormField } from "../components/MasterCrud";

/** The backend validates everything regardless. These rules exist so the user fixes
 *  a typo in the field they typed it in, rather than reading a 422 about the row. */
describe("master form validation", () => {
  const code: FormField = {
    key: "code", label: "Code", required: true, maxLength: 10,
    pattern: /^[A-Za-z0-9]+$/,
    patternMessage: "Use letters and numbers only, no spaces or symbols",
  };

  it("passes a well-formed value", () => {
    expect(validateForm([code], { code: "DOLO" })).toEqual({});
  });

  it("names the field that is missing", () => {
    expect(validateForm([code], { code: "" })).toEqual({ code: "Code is required" });
  });

  it("treats whitespace as missing", () => {
    expect(validateForm([code], { code: "   " })).toEqual({ code: "Code is required" });
  });

  it("reports the pattern in words, not as a regex", () => {
    expect(validateForm([code], { code: "DO LO" }).code)
      .toBe("Use letters and numbers only, no spaces or symbols");
  });

  it("enforces maxLength", () => {
    expect(validateForm([code], { code: "ABCDEFGHIJK" }).code)
      .toBe("Code cannot be longer than 10 characters");
  });

  it("checks a number's range", () => {
    const rate: FormField = { key: "cgst_rate", label: "CGST %", type: "number", min: 0, max: 100 };
    expect(validateForm([rate], { cgst_rate: 120 }).cgst_rate)
      .toBe("CGST % cannot be above 100");
    expect(validateForm([rate], { cgst_rate: -1 }).cgst_rate)
      .toBe("CGST % cannot be below 0");
    expect(validateForm([rate], { cgst_rate: 18 })).toEqual({});
  });

  it("skips every rule when an optional field is left blank", () => {
    const optional: FormField = {
      key: "email", label: "Email", pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
      patternMessage: "That does not look like an email address",
    };
    expect(validateForm([optional], { email: "" })).toEqual({});
    expect(validateForm([optional], { email: "nope" }).email)
      .toBe("That does not look like an email address");
  });

  it("runs a custom rule that reads the rest of the form", () => {
    // CGST + SGST is the within-state route and IGST the across-state one. They must
    // total the same, or the same sale is taxed differently by destination.
    const igst: FormField = {
      key: "igst_rate", label: "IGST %", type: "number",
      validate: (value, all) => {
        const split = Number(all.cgst_rate ?? 0) + Number(all.sgst_rate ?? 0);
        const rate = Number(value ?? 0);
        return rate && Math.abs(split - rate) > 0.001
          ? `CGST + SGST is ${split}%, which must equal IGST` : null;
      },
    };
    const form = { cgst_rate: 6, sgst_rate: 6, igst_rate: 18 };
    expect(validateForm([igst], form).igst_rate)
      .toBe("CGST + SGST is 12%, which must equal IGST");
    expect(validateForm([igst], { ...form, igst_rate: 12 })).toEqual({});
  });

  it("requires at least one choice in a required multiselect", () => {
    const manufacturers: FormField = {
      key: "manufacturer_ids", label: "Manufacturers", type: "multiselect",
      required: true,
    };
    expect(validateForm([manufacturers], { manufacturer_ids: [] }).manufacturer_ids)
      .toBe("Manufacturers is required");
    expect(validateForm([manufacturers], { manufacturer_ids: [1, 2] })).toEqual({});
  });

  it("leaves switches alone: a false switch is an answer, not a blank", () => {
    const active: FormField = { key: "is_active", label: "Active", type: "switch" };
    expect(validateForm([active], { is_active: false })).toEqual({});
  });
});
