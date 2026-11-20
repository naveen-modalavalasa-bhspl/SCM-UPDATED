import { describe, expect, it } from "vitest";
import { codesFree, leftOver, nextTrayNo, trayProblems } from "../components/trayPlan";

const tray = (tray_no: string, quantity: number, codes: string[] = []) => ({ tray_no, quantity, codes });

describe("trays on a pick", () => {
  it("counts what is left to put in a tray", () => {
    expect(leftOver(10, [tray("T-01", 4), tray("T-02", 3.5)])).toBe(2.5);
    expect(leftOver(5, [])).toBe(5);
  });

  it("numbers the next tray in the same shape", () => {
    expect(nextTrayNo([])).toBe("T-01");
    expect(nextTrayNo([tray("T-04", 1), tray("T-09", 1)])).toBe("T-10");
    expect(nextTrayNo([tray("TR7", 1)])).toBe("TR8");
  });

  it("offers a tray only codes no other tray holds", () => {
    const trays = [tray("T-01", 2, ["A"]), tray("T-02", 2, ["B"])];
    expect(codesFree(["A", "B", "C"], trays, 1)).toEqual(["B", "C"]);
  });

  it("says what the save would refuse", () => {
    const problems = trayProblems(5, [tray("T-01", 2, ["A", "B", "C"]), tray("t-01", 4, ["A"])]);
    const text = problems.map((p) => p.message).join(" | ");
    expect(text).toContain("3 codes in a tray of 2");
    expect(text).toContain("listed twice");
    expect(text).toContain("A is already in tray T-01");
    expect(text).toContain("hold 1 more than the pick");
  });
});
