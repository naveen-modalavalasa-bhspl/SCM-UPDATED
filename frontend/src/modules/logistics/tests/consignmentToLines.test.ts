import { describe, expect, it } from "vitest";
import {
  headerFromConsignment, linesFromConsignment, manifestLines,
} from "../components/consignmentToLines";
import type { ConsignmentDetail } from "../transportTypes";

const base = {
  id: 7,
  dispatch_no: "CN/2026/0007",
  dispatch_type: "TRANSFER",
  dispatch_date: "2026-08-16",
  status: "PACKED",
  warehouse_id: 3,
  warehouse_name: "Central WH",
  destination_office_name: "Kurnool LIP",
  delivery_address: "Site gate, Kurnool",
  contact_person: "Ravi",
  contact_phone: "9000000000",
  ref_type: "ISSUE",
  ref_id: 55,
  ref_no: "MI/2026/0055",
  total_items: 2,
  total_qty: 12,
  total_packages: 2,
  total_weight_kg: 30,
  created_at: "2026-08-16T04:00:00",
} as unknown as ConsignmentDetail;

const consignment = (over: Partial<ConsignmentDetail>): ConsignmentDetail =>
  ({ ...base, items: [], packages: [], ...over }) as ConsignmentDetail;

describe("a packed consignment, turned into transport lines", () => {
  it("gives one manifest line per item per carton, however it was picked", () => {
    // The failing shape: a serial-tracked item records one picked row per unit, so
    // twelve vacutainers in one box arrived as twelve identical "1 NOS" lines.
    const doc = consignment({
      packages: [
        { id: 1, package_no: "P1", package_type: "CARTON", weight_kg: 6,
          length_cm: null, width_cm: null, height_cm: null, is_fragile: false },
      ],
      items: Array.from({ length: 12 }, (_, n) => ({
        id: 20 + n, line_no: n + 1, package_id: 1, item_id: 501,
        item_name: "K2 EDTA Vacutainer Lavender 2 ml", uom_code: "NOS", quantity: 1,
      })) as ConsignmentDetail["items"],
    });

    const lines = linesFromConsignment(doc);

    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(12);
    expect(lines[0].package_count).toBe(1);
    expect(lines[0].weight_kg).toBe(6);
  });

  it("keeps one item in two cartons as two lines", () => {
    // The box owns the weight, so the same item split across two of them stays two
    // lines — merging those would price a two-carton load as one.
    const doc = consignment({
      packages: [
        { id: 1, package_no: "P1", package_type: "CARTON", weight_kg: 6,
          length_cm: null, width_cm: null, height_cm: null, is_fragile: false },
        { id: 2, package_no: "P2", package_type: "CARTON", weight_kg: 4,
          length_cm: null, width_cm: null, height_cm: null, is_fragile: false },
      ],
      items: [
        { id: 31, line_no: 1, package_id: 1, item_id: 501, item_name: "Vacutainer",
          uom_code: "NOS", quantity: 8 },
        { id: 32, line_no: 2, package_id: 2, item_id: 501, item_name: "Vacutainer",
          uom_code: "NOS", quantity: 4 },
      ] as ConsignmentDetail["items"],
    });

    const lines = linesFromConsignment(doc);

    expect(lines).toHaveLength(2);
    expect(lines.reduce((sum, line) => sum + (line.package_count ?? 0), 0)).toBe(2);
  });

  it("keeps two batches of one item in one carton apart", () => {
    // The batch is on the line's remarks and is what a receiving site reconciles
    // against, so merging across batches would lose it.
    const doc = consignment({
      packages: [
        { id: 1, package_no: "P1", package_type: "CARTON", weight_kg: 6,
          length_cm: null, width_cm: null, height_cm: null, is_fragile: false },
      ],
      items: [
        { id: 41, line_no: 1, package_id: 1, item_id: 501, item_name: "Vacutainer",
          uom_code: "NOS", quantity: 5, batch_no: "B1" },
        { id: 42, line_no: 2, package_id: 1, item_id: 501, item_name: "Vacutainer",
          uom_code: "NOS", quantity: 7, batch_no: "B2" },
      ] as ConsignmentDetail["items"],
    });

    const lines = linesFromConsignment(doc);

    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.remarks)).toEqual(["Batch B1", "Batch B2"]);
    // Still one box between them.
    expect(lines.reduce((sum, line) => sum + (line.package_count ?? 0), 0)).toBe(1);
  });

  it("counts a carton once however many lines are packed in it", () => {
    const doc = consignment({
      packages: [
        { id: 1, package_no: "P1", package_type: "CARTON", weight_kg: 18,
          length_cm: 40, width_cm: 30, height_cm: 20, is_fragile: true },
        { id: 2, package_no: "P2", package_type: "CARTON", weight_kg: 12,
          length_cm: null, width_cm: null, height_cm: null, is_fragile: false },
      ],
      items: [
        { id: 11, line_no: 1, package_id: 1, item_id: 101, item_name: "Gloves",
          uom_code: "BOX", quantity: 5 },
        { id: 12, line_no: 2, package_id: 1, item_id: 102, item_name: "Masks",
          uom_code: "BOX", quantity: 4 },
        { id: 13, line_no: 3, package_id: 2, item_id: 103, item_name: "Syringes",
          uom_code: "BOX", quantity: 3 },
      ] as ConsignmentDetail["items"],
    });

    const lines = linesFromConsignment(doc);

    expect(lines).toHaveLength(3);
    // Two cartons, three lines: the totals a carrier prices off must say two.
    expect(lines.reduce((sum, line) => sum + (line.package_count ?? 0), 0)).toBe(2);
    expect(lines[0].package_count).toBe(1);
    expect(lines[0].weight_kg).toBe(18);
    expect(lines[0].is_fragile).toBe(true);
    // Second line rides in the same carton — no count, no weight, or the shipment
    // would be priced as 48kg across three boxes.
    expect(lines[1].package_count).toBe(0);
    expect(lines[1].weight_kg).toBeNull();
    // …but it still knows it is in a fragile box.
    expect(lines[1].is_fragile).toBe(true);
    expect(lines[2].package_count).toBe(1);
    expect(lines[2].weight_kg).toBe(12);
  });

  it("puts unmapped cartons on the first line rather than losing them", () => {
    // An older consignment recorded packages but never said which line went where.
    const doc = consignment({
      packages: [
        { id: 1, package_no: "P1", weight_kg: 10, is_fragile: false } as never,
        { id: 2, package_no: "P2", weight_kg: 6, is_fragile: true } as never,
      ],
      items: [
        { id: 11, line_no: 1, item_id: 101, item_name: "Gloves", quantity: 5 },
        { id: 12, line_no: 2, item_id: 102, item_name: "Masks", quantity: 4 },
      ] as ConsignmentDetail["items"],
    });

    const lines = linesFromConsignment(doc);

    // A zero-package request is one no carrier will quote, so the load lands whole.
    expect(lines[0].package_count).toBe(2);
    expect(lines[0].weight_kg).toBe(16);
    expect(lines[0].is_fragile).toBe(true);
    expect(lines[1].package_count).toBe(0);
  });

  it("carries no packages when the warehouse recorded none", () => {
    const doc = consignment({
      items: [
        { id: 11, line_no: 1, item_id: 101, item_name: "Gloves", quantity: 5 },
      ] as ConsignmentDetail["items"],
    });
    expect(linesFromConsignment(doc)[0].package_count).toBe(0);
  });

  it("links the transport request back to the consignment and its indent", () => {
    const doc = consignment({
      items: [
        { id: 11, line_no: 1, item_id: 101, item_name: "Gloves", quantity: 5,
          indent_id: 42, indent_no: "IND/2026/0042" },
      ] as ConsignmentDetail["items"],
    });

    const header = headerFromConsignment(doc);

    expect(header.dispatch_id).toBe(7);
    expect(header.consignment_no).toBe("CN/2026/0007");
    expect(header.source_type).toBe("CONSIGNMENT");
    // ref_type ISSUE means the material issue it was picked against.
    expect(header.issue_id).toBe(55);
    expect(header.indent_no).toBe("IND/2026/0042");
    expect(header.to_location_name).toBe("Kurnool LIP");
    expect(header.from_warehouse_id).toBe(3);
    expect(header.contact_phone).toBe("9000000000");
  });

  it("does not claim an issue id when the consignment came from something else", () => {
    const header = headerFromConsignment(consignment({ ref_type: "STO", ref_id: 9 }));
    expect(header.issue_id).toBeNull();
  });
});

describe("a shipment already raised, read as a manifest", () => {
  // TR/2026-27/00011 as it actually stands: ten vacutainers and two mice picked one
  // row per serial into a single box. The first row carries the carton and the
  // weight, the rest carry nothing.
  const stored = [
    ...Array.from({ length: 10 }, (_, n) => ({
      id: 100 + n, line_no: n + 1, item_id: 7, item_code: "VAC",
      item_name: "K2 EDTA Vacutainer Lavender 2 ml", uom_code: "NOS",
      quantity: 1, delivered_qty: 0, package_count: n === 0 ? 1 : 0,
      package_type: n === 0 ? "BOX" : null, weight_kg: n === 0 ? 6 : null,
      is_fragile: false, remarks: "Batch EDTA26G118",
    })),
    ...Array.from({ length: 2 }, (_, n) => ({
      id: 200 + n, line_no: 11 + n, item_id: 69, item_code: "MOU",
      item_name: "Wireless Mouse", uom_code: "NOS",
      quantity: 1, delivered_qty: 0, package_count: 0,
      package_type: null, weight_kg: null, is_fragile: false,
      remarks: "Batch 08-2026",
    })),
  ] as Parameters<typeof manifestLines>[0];

  it("collapses the per-unit rows to one line per item", () => {
    const lines = manifestLines(stored);

    expect(lines).toHaveLength(2);
    expect(lines[0].item_name).toBe("K2 EDTA Vacutainer Lavender 2 ml");
    expect(lines[0].quantity).toBe(10);
    expect(lines[1].item_name).toBe("Wireless Mouse");
    expect(lines[1].quantity).toBe(2);
  });

  it("keeps the carton count and the weight the shipment actually carries", () => {
    const lines = manifestLines(stored);

    // One box, six kilos — taken from the row that opened the carton, not lost
    // because eleven siblings said nothing.
    expect(lines.reduce((sum, line) => sum + line.package_count, 0)).toBe(1);
    expect(lines[0].weight_kg).toBe(6);
  });

  it("leaves a shipment picked one row per item alone", () => {
    const plain = [
      { id: 1, line_no: 1, item_id: 7, item_name: "Gloves", quantity: 5,
        delivered_qty: 0, package_count: 1, weight_kg: 3, is_fragile: false },
      { id: 2, line_no: 2, item_id: 8, item_name: "Masks", quantity: 4,
        delivered_qty: 0, package_count: 1, weight_kg: 2, is_fragile: false },
    ] as Parameters<typeof manifestLines>[0];

    expect(manifestLines(plain)).toHaveLength(2);
  });
});
