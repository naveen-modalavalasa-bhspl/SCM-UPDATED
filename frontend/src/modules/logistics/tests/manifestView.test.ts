import { describe, expect, it } from "vitest";
import type { TRItem } from "../transportTypes";
import {
  loadShares, placeName, shareLabel, splitDocNo, stopLines,
} from "../components/manifestView";

function line(over: Partial<TRItem>): TRItem {
  return {
    id: 1, line_no: 1, quantity: 1, delivered_qty: 0, package_count: 0,
    is_fragile: false, ...over,
  };
}

describe("manifestView", () => {
  it("reads a trip's lines as stops, in delivery order", () => {
    const stops = stopLines([
      line({
        id: 2, item_code: "BHS/104/2026-27/CON0006",
        remarks: "Stop 2: AP-104-MMU-Chataparru Phc-AP39TL9184 - LIP · indent BHS/104/2026-27/IND0081",
      }),
      line({
        id: 1, item_code: "DSP/2026-27/00023",
        remarks: "Stop 1: AP-104-MMU-Badangi-AP39UH4792 - LIP",
      }),
    ]);
    expect(stops?.map((stop) => stop.sequence)).toEqual([1, 2]);
    expect(stops?.[0]).toMatchObject({ place: "Badangi", indentNo: null });
    expect(stops?.[1]).toMatchObject({
      place: "Chataparru",
      consignmentNo: "BHS/104/2026-27/CON0006",
      indentNo: "BHS/104/2026-27/IND0081",
    });
  });

  it("draws items as items when any line is not a stop", () => {
    expect(stopLines([
      line({ remarks: "Stop 1: Somewhere" }),
      line({ id: 2, remarks: "Batch B12" }),
    ])).toBeNull();
  });

  it("keeps a non-MMU name, less its rung", () => {
    expect(placeName("Central Warehouse Vijayawada - MAIN")).toBe("Central Warehouse Vijayawada");
  });

  it("quiets the shared prefix of a document number", () => {
    expect(splitDocNo("BHS/104/2026-27/CON0005")).toEqual({
      prefix: "BHS/104/2026-27/", tail: "CON0005",
    });
    expect(splitDocNo("CON0005")).toEqual({ prefix: "", tail: "CON0005" });
  });

  it("splits by quantity only when every line shares a unit", () => {
    const lines = [
      line({ quantity: 3, package_count: 1 }),
      line({ id: 2, quantity: 1, package_count: 3 }),
    ];
    expect(loadShares(lines, true)).toEqual({ basis: "quantity", shares: [0.75, 0.25] });
    expect(loadShares(lines, false)).toEqual({ basis: "packages", shares: [0.25, 0.75] });
    expect(loadShares([line({})], true)).toBeNull();
  });

  it("never prints a sliver as 0%", () => {
    expect(shareLabel(4 / 1030)).toBe("<1%");
    expect(shareLabel(0.971)).toBe("97%");
  });
});
