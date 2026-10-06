import { describe, expect, it } from "vitest";
import { paidPercent, todayISO } from "../paymentRules";

describe("paymentRules", () => {
  it("reads how much of an order has gone out, clamped to 0–100", () => {
    expect(paidPercent({ paid: 300, total_amount: 1000 })).toBe(30);
    expect(paidPercent({ paid: 0, total_amount: 0 })).toBe(0);
    expect(paidPercent({ paid: 1200, total_amount: 1000 })).toBe(100);
  });

  it("formats today as a date-input value", () => {
    expect(todayISO(new Date(2026, 9, 6, 23, 30))).toBe("2026-10-06");
  });
});
