import { describe, expect, it } from "vitest";
import { withAnotherBatch } from "../receiptBatches";
import type { ReceiptItemWrite } from "../types";

const row = (over: Partial<ReceiptItemWrite>): ReceiptItemWrite => ({
  item_id: 5, po_item_id: 11, uom_code: "NOS", is_asset: false, is_serial_tracked: false,
  is_imei_tracked: false, ordered_qty: 100, received_qty: 100 as never, accepted_qty: 100 as never,
  rejected_qty: 0, rate: 12, batch_no: "B1", mfg_date: "2026-01-01", expiry_date: "2028-01-01",
  bin_id: null, remarks: null, serial_numbers: null, imei_numbers: null, ...over,
} as ReceiptItemWrite);

describe("withAnotherBatch (QA-5 BUG_007)", () => {
  it("adds a sibling of the PO line with its own empty batch and dates", () => {
    const out = withAnotherBatch([row({ id: 1 })], 0, 100);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({
      item_id: 5, po_item_id: 11, rate: 12, batch_no: null, mfg_date: null, expiry_date: null,
    });
    expect(out[1].id).toBeUndefined();
  });

  it("opens on what the order line still owes after the rows already on it", () => {
    expect(withAnotherBatch([row({ received_qty: 100 as never })], 0, 100)[1].received_qty).toBe(0);
    expect(withAnotherBatch([row({ received_qty: 60 as never })], 0, 100)[1].received_qty).toBe(40);
  });

  it("is placed under the rows of the same line, not at the end", () => {
    const other = row({ item_id: 9, po_item_id: 12, batch_no: "X" });
    const out = withAnotherBatch([row({ received_qty: 30 as never }), row({ batch_no: "B2", received_qty: 30 as never }), other], 0, 100);
    expect(out.map((l) => l.po_item_id)).toEqual([11, 11, 11, 12]);
    expect(out[2].received_qty).toBe(40);
  });

  it("never carries codes over to the new batch", () => {
    const out = withAnotherBatch([row({ is_serial_tracked: true, serial_numbers: ["S1", "S2"] })], 0, 100);
    expect(out[1].serial_numbers).toBeNull();
    expect(out[0].serial_numbers).toEqual(["S1", "S2"]);
  });

  it("a despatch-note line is then read by quantity on both rows, not by the whole count", () => {
    const counted = [{ level: 1, qty: 10 }] as never;
    const out = withAnotherBatch([row({ despatch_note_item_id: 3, pack_breakdown: counted })], 0, 100);
    expect(out[0].pack_breakdown).toBeNull();
    expect(out[1].pack_breakdown).toBeNull();
  });

  it("does nothing on a row with no item yet", () => {
    const items = [row({ item_id: 0 })];
    expect(withAnotherBatch(items, 0, 100)).toBe(items);
  });
});
