import { describe, expect, it } from "vitest";
import { fmtDateRange } from "../datetime";

describe("fmtDateRange", () => {
  it("reads a window the way a person says it", () => {
    expect(fmtDateRange("2026-11-22", "2026-11-25")).toBe("22 – 25 Nov 2026");
    expect(fmtDateRange("2026-11-28", "2026-12-02")).toBe("28 Nov – 02 Dec 2026");
    expect(fmtDateRange("2026-12-30", "2027-01-03")).toBe("30 Dec 2026 – 03 Jan 2027");
  });

  it("falls back to one end, or a dash", () => {
    expect(fmtDateRange(null, "2026-11-25")).toBe("by 25 Nov 2026");
    expect(fmtDateRange("2026-11-22", null)).toBe("from 22 Nov 2026");
    expect(fmtDateRange("2026-11-22", "2026-11-22")).toBe("22 Nov 2026");
    expect(fmtDateRange(null, null)).toBe("—");
  });
});
