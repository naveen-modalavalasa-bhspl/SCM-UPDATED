import { describe, expect, it } from "vitest";
import {
  MIN_MODULE_MM, barcodeFit, buildCodeSheetSvg, code128Modules, codesToCsv,
  safeFileName, svgSize,
} from "../codeLabels";
import type { PutawayCodes, PutawayUnitCode } from "../types";

/**
 * The arithmetic behind the code label sheet.
 *
 * The one that matters is `barcodeFit`. BUG_SCM_INV_042 / BUG_SCM_INV_058 were both
 * attempts to squeeze a Code 128 of a 30-41 character item code onto a thermal label,
 * and the option was eventually dropped from Labels & Printing because it could not be
 * done. It is offered again here — sites with linear-only scanners need it — so the
 * check that says when it will not scan is the whole safety of that decision.
 */

describe("barcode fit", () => {
  it("counts the bars a Code 128 actually needs, quiet zones included", () => {
    // 11 modules a character, plus start and check (11 each), the 13-module stop, and
    // 10 modules of quiet zone either side.
    expect(code128Modules(1)).toBe(11 * 3 + 13 + 20);
    expect(code128Modules(36)).toBe(11 * 38 + 13 + 20);
  });

  it("refuses a long asset code on a small label, and says how wide it needs to be", () => {
    const code = "ELCCBL01-GEN-SMS-MFR-0001-1-00042317"; // 36 chars, the live shape
    const small = barcodeFit(code, 38);

    expect(small.ok).toBe(false);
    expect(small.moduleMm).toBeLessThan(MIN_MODULE_MM);
    // The advice has to be actionable: a width that WOULD work.
    expect(barcodeFit(code, small.neededMm).ok).toBe(true);
  });

  it("accepts a short code on the same label", () => {
    // A configured format can be short — the point is the check follows the code, not
    // a guess about item codes in general.
    expect(barcodeFit("AC-0042", 38).ok).toBe(true);
  });
});

const head: PutawayCodes = {
  putaway_id: 58,
  putaway_no: "BHS/NA/2026-27/PUT0029",
  status: "COMPLETED",
  item_id: 7,
  item_code: "304010-FRIDGE-GODREJ-GODREJ-0001",
  item_name: "Godrej 190L refrigerator",
  uom_code: "NOS",
  batch_no: "56321",
  expiry_date: "2026-09-04",
  is_asset: true,
  bin_code: "F1-A1-R1-B3",
  bin_path: "F1 / F1-A1 / F1-A1-R1 / F1-A1-R1-B3",
  lot_no: "LOT/WH982/F1-A1-R1-B3/2026-27/00057",
  warehouse_name: "CENTRAL WAREHOUSE-1",
  is_code_tracked: true,
  code_type: "ASSET",
  total_codes: 2,
  reason: null,
};

const units: PutawayUnitCode[] = [
  { id: 1, code: "FRIDGE-1-00000101", code_type: "ASSET", scope: "UNIT",
    serial_number: "FRIDGE-1-00000101", imei: null, status: "available" },
  { id: 2, code: "=CMD-2", code_type: "ASSET", scope: "UNIT",
    serial_number: null, imei: "35 900 8", status: "available" },
];

describe("the CSV of the codes", () => {
  const csv = codesToCsv(head, units);
  const lines = csv.split("\r\n");

  it("carries every column the label does, so the two cannot disagree", () => {
    expect(lines[0]).toContain("Code");
    expect(lines[0]).toContain("Lot");
    expect(lines[0]).toContain("Bin path");
    // An asset's date is a warranty, not an expiry — the same rule the sticker follows.
    expect(lines[0]).toContain("Warranty");
    expect(lines[1]).toContain("FRIDGE-1-00000101");
    expect(lines[1]).toContain("LOT/WH982/F1-A1-R1-B3/2026-27/00057");
  });

  it("never hands Excel a code to evaluate", () => {
    // A code is text. `=CMD-2` unquoted is a formula, and a configured code format is
    // free to start with any character it likes.
    expect(lines[2]).toMatch(/^"'=CMD-2"/);
  });

  it("quotes a value carrying the separator", () => {
    // "35 900 8" has no comma; the bin path has slashes, not commas — so check the one
    // field that genuinely needs quoting.
    expect(codesToCsv(head, [{ ...units[0], status: "held, partly" }]))
      .toContain('"held, partly"');
  });
});

describe("the exported code sheet", () => {
  const svg = buildCodeSheetSvg(
    [
      { code: "AC-1", svg: '<svg width="80" height="80"><rect/></svg>', width: 80, height: 80 },
      { code: "AC-2", svg: '<svg width="80" height="80"><rect/></svg>', width: 80, height: 80 },
    ],
    { title: "PUT0029 · 2 codes" },
  );

  it("is one self-contained document, not one file per code", () => {
    // A browser refuses a burst of downloads, and a folder of 500 files is not what
    // anybody wanted anyway.
    expect(svg.startsWith("<svg xmlns=")).toBe(true);
    expect(svg).toContain("PUT0029");
    expect(svg.match(/AC-1/g)).toHaveLength(1);
    expect(svg.match(/AC-2/g)).toHaveLength(1);
  });

  it("places each symbol rather than resizing it", () => {
    // A barcode redrawn at the wrong aspect ratio stops scanning, so the nested <svg>
    // keeps its own geometry and only gains a position.
    expect(svg).toMatch(/<svg x="[\d.]+" y="[\d.]+" width="80" height="80">/);
  });

  it("reports a size the canvas can be built at", () => {
    const { width, height } = svgSize(svg);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });
});

describe("file names", () => {
  it("strips the slashes out of a putaway number", () => {
    // `BHS/NA/2026-27/PUT0029` is a perfectly good document number and a completely
    // illegal filename.
    expect(safeFileName("BHS/NA/2026-27/PUT0029")).toBe("BHS-NA-2026-27-PUT0029");
  });
});
