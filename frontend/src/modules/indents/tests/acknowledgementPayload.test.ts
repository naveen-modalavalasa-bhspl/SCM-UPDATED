import { describe, expect, it } from "vitest";
import { acknowledgementPayload } from "../pages/AcknowledgementDetailPage";
import type { AcknowledgementLine } from "../types";

const base = {
  indent_item_id: 7, dispatched_quantity: 10, received_quantity: 0, rejected_quantity: 0,
  approved_quantity: 10,
} as unknown as AcknowledgementLine;

describe("acknowledgementPayload: received and returned are one number", () => {
  it("returns whatever was sent and not received, with no reason", () => {
    const [line] = acknowledgementPayload([base], { "line-7": "8" });
    expect(line.received_quantity).toBe(8);
    expect(line.rejections).toEqual([{ quantity: 2 }]);
  });

  it("sends no rejection when everything was received", () => {
    const [line] = acknowledgementPayload([base], { "line-7": "10" });
    expect(line.received_quantity).toBe(10);
    expect(line.rejections).toBeUndefined();
  });

  it("keeps a line that is returned whole", () => {
    const lines = acknowledgementPayload([base], { "line-7": "0" });
    expect(lines).toHaveLength(1);
    expect(lines[0].received_quantity).toBe(0);
    expect(lines[0].rejections).toEqual([{ quantity: 10 }]);
  });

  it("never lets received run past what was sent", () => {
    const [line] = acknowledgementPayload([base], { "line-7": "25" });
    expect(line.received_quantity).toBe(10);
    expect(line.rejections).toBeUndefined();
  });

  it("names the units that go back: the ones not matched as received", () => {
    const coded = { ...base, serial_numbers: ["A", "B", "C", "D"] } as unknown as AcknowledgementLine;
    const [line] = acknowledgementPayload(
      [{ ...coded, dispatched_quantity: 4, approved_quantity: 4 } as unknown as AcknowledgementLine],
      { "line-7": "3" }, {}, { "line-7": ["A", "B", "D"] });
    expect(line.received_quantity).toBe(3);
    expect(line.rejections).toEqual([{ quantity: 1, serial_numbers: ["C"] }]);
  });

  it("counts a line sent in packages package by package", () => {
    const packed = {
      ...base,
      package_quantities: [
        { dispatch_id: 1, package_id: 5, quantity: 6 },
        { dispatch_id: 1, package_id: 6, quantity: 4 },
      ],
    } as unknown as AcknowledgementLine;
    const [line] = acknowledgementPayload([packed], {
      "line-7-dispatch-1-package-5": "6",
      "line-7-dispatch-1-package-6": "1",
    });
    expect(line.received_quantity).toBe(7);
    expect(line.rejections).toEqual([{ quantity: 3 }]);
  });
});
