import { describe, expect, it } from "vitest";
import { daysUntil, fmtMoneyShort, fmtQty, fmtSerialSuffix, humanise, normaliseStatus, num, percent } from "../format";

describe("warehouse formatting", () => {
  it("normalises the schema's lower_snake putaway statuses to the pill vocabulary", () => {
    // `whs_warehouse_items.status` is lower_snake while every other document is
    // UPPER_SNAKE; StatusPill keys off the upper form.
    expect(normaliseStatus("in_progress")).toBe("IN_PROGRESS");
    expect(normaliseStatus("COMPLETED")).toBe("COMPLETED");
    expect(normaliseStatus("system directed")).toBe("SYSTEM_DIRECTED");
    expect(normaliseStatus(null)).toBe("");
  });

  it("reads an enum back as prose", () => {
    expect(humanise("QC_PASSED")).toBe("Qc passed");
    expect(humanise(null)).toBe("—");
  });

  it("never divides by zero — an empty warehouse is 0%, not NaN%", () => {
    expect(percent(0, 0)).toBe(0);
    expect(percent(3, 4)).toBe(75);
  });

  it("coerces the API's decimal strings to numbers", () => {
    // MySQL DECIMAL columns arrive as strings over JSON.
    expect(num("12.500")).toBe(12.5);
    expect(num(null)).toBe(0);
    expect(num("not a number")).toBe(0);
  });

  it("shows every quantity at two decimals, so a column lines up", () => {
    expect(fmtQty("12.500")).toBe("12.50");
    expect(fmtQty(0)).toBe("0.00");
  });

  it("shows only the meaningful final serial segment on public package labels", () => {
    expect(fmtSerialSuffix("304040-WATER-CAN-SUPREME-SUPREME-0001-1-00003601")).toBe("3601");
    expect(fmtSerialSuffix("ITEM-00000000")).toBe("0");
    expect(fmtSerialSuffix("MANUFACTURER-SN-A19")).toBe("A19");
    expect(fmtSerialSuffix("00003601")).toBe("00003601");
    expect(fmtSerialSuffix(null)).toBeNull();
  });

  it("shortens money for a KPI tile", () => {
    expect(fmtMoneyShort(1_240_000)).toBe("12.40 L");
    expect(fmtMoneyShort(25_000_000)).toBe("2.50 Cr");
    expect(fmtMoneyShort(950)).toBe("950");
  });

  it("counts a past date as negative days, which is what 'late' reads", () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect(daysUntil(yesterday)).toBeLessThanOrEqual(0);
    expect(daysUntil(null)).toBeNull();
  });
});
