import { describe, expect, it } from "vitest";
import { acknowledgementPayload } from "../pages/AcknowledgementDetailPage";
import { newRejectionRow } from "../receiptRejections";
import type { AcknowledgementLine } from "../types";

const base = {
  indent_item_id: 7, dispatched_quantity: 10, received_quantity: 0, rejected_quantity: 0,
  approved_quantity: 10,
} as unknown as AcknowledgementLine;

const rows = (reason: string, quantity: string, serials: string[] = []) =>
  [{ ...newRejectionRow(), reason, quantity, serials }];

describe("acknowledgementPayload with rejections", () => {
  it("sends what was accepted and what was turned away, with the units", () => {
    const [line] = acknowledgementPayload([base], { "line-7": "8" }, {},
      { "line-7": rows("EXPIRED", "2", ["A", "B"]) });
    expect(line.received_quantity).toBe(8);
    expect(line.rejections).toEqual([{ reason: "EXPIRED", quantity: 2, serial_numbers: ["A", "B"] }]);
  });

  it("keeps a line that is turned away whole", () => {
    const lines = acknowledgementPayload([base], { "line-7": "0" }, {},
      { "line-7": rows("DAMAGED", "10") });
    expect(lines).toHaveLength(1);
    expect(lines[0].received_quantity).toBe(0);
  });

  it("drops a line with nothing accepted and nothing turned away", () => {
    expect(acknowledgementPayload([base], { "line-7": "0" })).toEqual([]);
  });

  it("on a line counted by package, takes what is turned away off what arrived", () => {
    const packed = {
      ...base,
      package_quantities: [{
        dispatch_id: 1, package_id: 5, quantity: 10,
        box_codes: [{ code: "BX-1", quantity: 10 }],
      }],
    } as unknown as AcknowledgementLine;
    const key = "line-7-dispatch-1-package-5";
    const [line] = acknowledgementPayload([packed], { [key]: "10" }, {},
      { [key]: rows("LEAKED_SPILLED", "3") });
    expect(line.received_quantity).toBe(7);
    expect(line.rejections?.[0].quantity).toBe(3);
  });
});
