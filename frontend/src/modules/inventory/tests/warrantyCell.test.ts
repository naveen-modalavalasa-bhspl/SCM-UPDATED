import { describe, expect, it } from "vitest";
import { mergeWarranty } from "../api";
import { lotWarrantySentence, lotWarrantyTone } from "../components/warrantyCell";

const w = (covered: number, expiring = 0, expired = 0, next_end: string | null = null) =>
  ({ covered, active: covered - expiring - expired, expiring, expired, next_end });

describe("warranty on stock balance", () => {
  it("says a lot in one line", () => {
    expect(lotWarrantySentence(w(5), 5)).toBe("All 5 covered");
    expect(lotWarrantySentence(w(3, 1, 1), 5)).toBe("3 of 5 covered · 1 ends within 30 days · 1 expired");
    expect(lotWarrantySentence(w(0), 5)).toBeNull();
    expect(lotWarrantySentence(undefined, 5)).toBeNull();
  });

  it("is coloured by the worst unit", () => {
    expect(lotWarrantyTone(w(3, 1, 1))).toBe("bad");
    expect(lotWarrantyTone(w(3, 1))).toBe("warn");
    expect(lotWarrantyTone(w(3))).toBe("ok");
    expect(lotWarrantyTone(undefined)).toBe("muted");
  });

  it("adds two lots up, keeping the soonest end", () => {
    expect(mergeWarranty(w(2, 0, 0, "2027-05-01"), w(1, 1, 0, "2026-12-01")))
      .toEqual({ covered: 3, active: 2, expiring: 1, expired: 0, next_end: "2026-12-01" });
    expect(mergeWarranty(undefined, w(1))).toEqual(w(1));
  });
});
