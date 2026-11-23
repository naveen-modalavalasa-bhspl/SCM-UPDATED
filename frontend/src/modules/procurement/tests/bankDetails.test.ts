import { describe, expect, it } from "vitest";
import {
  accountProblem, bankFromIfsc, confirmProblem, ifscProblem, maskAccount, sameStateFromGstin,
} from "../bankDetails";

describe("supplier bank details and GST state", () => {
  it("checks an IFSC code", () => {
    expect(ifscProblem("sbin 0001234")).toBeNull();
    expect(ifscProblem("")).toBe("Required.");
    expect(ifscProblem("SBIN1001234")).toMatch(/4 letters, a 0/);
    expect(bankFromIfsc("hdfc0000123")).toBe("HDFC Bank");
  });

  it("checks an account number and its confirmation", () => {
    expect(accountProblem("1234 5678 901")).toBeNull();
    expect(accountProblem("12345")).toBe("9 to 18 digits.");
    expect(accountProblem("12AB45678")).toBe("Digits only.");
    expect(confirmProblem("123456789", "123 456 789")).toBeNull();
    expect(confirmProblem("123456789", "123456780")).toMatch(/Does not match/);
    expect(maskAccount("123456789012")).toBe("••••••••9012");
  });

  it("works out 'same state' from the two GSTINs, IGST when either is missing", () => {
    expect(sameStateFromGstin("37", "37AABCU9603R1ZM")).toBe(true);
    expect(sameStateFromGstin("37", "29AABCU9603R1ZM")).toBe(false);
    expect(sameStateFromGstin("37", "")).toBe(false);
    expect(sameStateFromGstin(null, "37AABCU9603R1ZM")).toBe(false);
  });
});
