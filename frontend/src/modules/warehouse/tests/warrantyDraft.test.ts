import { describe, expect, it } from "vitest";
import {
  covered, draftFromServer, emptyEntry, entryProblem, matchCards, plusYears, toPayload, unitCodes,
} from "../components/warrantyDraft";
import { checkSheet, readDate } from "../components/warrantyExcel";

const entry = (start = "", end = "", cardNo = "") => ({ ...emptyEntry(), start, end, cardNo });

describe("a GRN line's warranty draft", () => {
  it("a year of warranty ends the day before the anniversary", () => {
    expect(plusYears("2026-11-21", 1)).toBe("2027-11-20");
    expect(plusYears("2028-02-29", 1)).toBe("2029-02-27");
  });

  it("an entry is both dates or neither, and never ends before it starts", () => {
    expect(entryProblem(entry())).toBeNull();
    expect(entryProblem(entry("2026-01-01"))).toMatch(/end date/);
    expect(entryProblem(entry("", "", "C-1"))).toMatch(/start and end/);
    expect(entryProblem(entry("2026-02-01", "2026-01-01"))).toMatch(/before it starts/);
    expect(entryProblem(entry("2026-01-01", "2027-01-01"))).toBeNull();
  });

  it("counts a batch warranty for every unit, a per-piece one per unit", () => {
    const codes = ["A", "B", "C"];
    expect(covered({ mode: "BATCH", batch: entry("2026-01-01", "2027-01-01"), units: {} }, codes)).toBe(3);
    expect(covered({ mode: "UNIT", batch: entry(), units: { A: entry("2026-01-01", "2027-01-01"), B: entry("2026-01-01") } }, codes)).toBe(1);
    expect(covered({ mode: null, batch: entry(), units: {} }, codes)).toBe(0);
  });

  it("builds the save payload, dropping units no longer on the line", () => {
    const file = new File(["x"], "A.pdf");
    const draft = { mode: "UNIT" as const, batch: entry(), units: {
      A: { ...entry("2026-01-01", "2027-01-01", "C1"), file }, Z: entry("2026-01-01", "2027-01-01") } };
    expect(toPayload(draft, ["A", "B"], new Map([[file, 7]]))).toEqual({
      mode: "UNIT", units: [{ code: "A", start_date: "2026-01-01", end_date: "2027-01-01", card_no: "C1", attachment_id: 7 }],
    });
  });

  it("reads a saved line: only a unit's OWN warranty is a unit entry", () => {
    const w = { id: 1, start_date: "2026-01-01", end_date: "2027-01-01", status: "ACTIVE" as const, status_text: "" };
    const draft = draftFromServer({ receipt_item_id: 1, item_id: 1, covered: 2, total: 2, mode: "BATCH", batch: w,
      units: [{ code: "A", warranty: w, source: "BATCH" }, { code: "B", warranty: { ...w, card_no: "OWN" }, source: "UNIT" }] });
    expect(draft.mode).toBe("BATCH");
    expect(Object.keys(draft.units)).toEqual(["B"]);
  });

  it("pairs serial and IMEI into one code per unit", () => {
    expect(unitCodes(["S1", ""], ["I1", "I2"])).toEqual(["S1", "I2"]);
  });

  it("matches card files: named in the sheet, then by the code in the file name", () => {
    const f = (n: string) => new File(["x"], n);
    const files = [f("card-for-B.PDF"), f("SN-1.jpg"), f("SN-12.pdf"), f("other.pdf")];
    const { matched, unmatched } = matchCards(files, ["A", "SN-1", "SN-12"], { A: "card-for-B.pdf" });
    expect(matched.get("A")?.name).toBe("card-for-B.PDF");
    expect(matched.get("SN-1")?.name).toBe("SN-1.jpg");
    expect(matched.get("SN-12")?.name).toBe("SN-12.pdf");
    expect(unmatched.map((x) => x.name)).toEqual(["other.pdf"]);
  });
});

describe("the warranty spreadsheet", () => {
  it("reads every way a date is written", () => {
    expect(readDate("21-11-2026")).toBe("2026-11-21");
    expect(readDate("21/11/2026")).toBe("2026-11-21");
    expect(readDate("2026-11-21")).toBe("2026-11-21");
    expect(readDate(new Date(2026, 10, 21))).toBe("2026-11-21");
    expect(readDate("")).toBe("");
    expect(readDate("31-02-2026")).toBeNull();
    expect(readDate("soon")).toBeNull();
  });

  const opts = { qty: 2, trackSerial: true, trackImei: false, takenElsewhere: new Set(["sn-x"]) };
  const row = (serial: string, start = "", end = "") => ({
    "Unit": 1, "Serial number": serial, "Warranty start (DD-MM-YYYY)": start, "Warranty end (DD-MM-YYYY)": end });

  it("takes a good sheet whole", () => {
    const out = checkSheet([row("SN-1", "01-01-2026", "31-12-2027"), row("SN-2")], opts);
    expect(out.problems).toEqual([]);
    expect(out.rows.map((r) => [r.serial, r.entry.start, r.entry.end])).toEqual([
      ["SN-1", "2026-01-01", "2027-12-31"], ["SN-2", "", ""]]);
  });

  it("refuses the wrong number of rows, repeats, clashes and bad dates — naming each", () => {
    const out = checkSheet([row("SN-1", "01-01-2026"), row("SN-1"), row("SN-X", "02-01-2026", "01-01-2026")], opts);
    const text = out.problems.join(" | ");
    expect(text).toMatch(/3 unit rows, but 2 units were received/);
    expect(text).toMatch(/Row 2: give the warranty end date too/);
    expect(text).toMatch(/Row 3: serial number SN-1 is also on row 2/);
    expect(text).toMatch(/Row 4: serial number SN-X is already on another line/);
    expect(text).toMatch(/Row 4: the warranty ends before it starts/);
  });
});
