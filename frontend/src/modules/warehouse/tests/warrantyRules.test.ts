import { describe, expect, it } from "vitest";
import { addYears, warrantyTone } from "../components/warrantyRules";

describe("warranty rules", () => {
  it("a year of warranty ends the day before the anniversary", () => {
    expect(addYears("2026-11-20", 1)).toBe("2027-11-19");
    expect(addYears("2026-01-01", 2)).toBe("2027-12-31");
    expect(addYears("2028-02-29", 1)).toBe("2029-02-27");
  });

  it("colours by state", () => {
    expect(warrantyTone("EXPIRED")).toContain("danger");
    expect(warrantyTone("EXPIRING")).toContain("warn");
    expect(warrantyTone("ACTIVE")).toContain("ok");
    expect(warrantyTone(null)).toContain("muted");
  });
});
