import { describe, expect, it } from "vitest";
import {
  newRejectionRow, rejectedSerials, rejectedTotal, rejectionPayload, rejectionProblems,
  type RejectionReason,
} from "./receiptRejections";

const reasons: RejectionReason[] = [
  { value: "EXPIRED", label: "Expired", needs_comment: false, claims_carrier: false },
  { value: "OTHER", label: "Other", needs_comment: true, claims_carrier: false },
];
const row = (reason: string, quantity: string, comment = "") =>
  ({ ...newRejectionRow(), reason, quantity, comment });

describe("receipt rejections", () => {
  it("totals across reasons", () => {
    expect(rejectedTotal([row("EXPIRED", "2"), row("OTHER", "10.5", "x")])).toBe(12.5);
    expect(rejectedTotal(undefined)).toBe(0);
  });
  it("ignores untouched rows but flags half-filled ones", () => {
    expect(rejectionProblems([newRejectionRow()], 5, reasons)).toEqual([]);
    expect(rejectionProblems([row("EXPIRED", "")], 5, reasons)).toHaveLength(1);
    expect(rejectionProblems([row("", "2")], 5, reasons)).toHaveLength(1);
  });
  it("requires a comment for Other and caps at max", () => {
    expect(rejectionProblems([row("OTHER", "1")], 5, reasons)[0]).toMatch(/Other/);
    expect(rejectionProblems([row("EXPIRED", "6")], 5, reasons)[0]).toMatch(/Only 5/);
  });
  it("sends only complete rows, trimmed", () => {
    expect(rejectionPayload([row("EXPIRED", "2", " old "), row("", "3"), newRejectionRow()]))
      .toEqual([{ reason: "EXPIRED", quantity: 2, comment: "old" }]);
  });
  it("asks coded goods for one serial number per unit turned away", () => {
    const named = { ...row("EXPIRED", "2"), serials: ["A", "B"] };
    expect(rejectionProblems([row("EXPIRED", "2")], 5, reasons, true)[0]).toMatch(/serial numbers/);
    expect(rejectionProblems([{ ...row("EXPIRED", "2"), serials: ["A"] }], 5, reasons, true)).toHaveLength(1);
    expect(rejectionProblems([named], 5, reasons, true)).toEqual([]);
    expect(rejectionProblems([row("EXPIRED", "2")], 5, reasons, false)).toEqual([]);
  });
  it("sends the chosen serial numbers and lists them for the accepted side to skip", () => {
    const named = { ...row("EXPIRED", "2"), serials: ["A", "B"] };
    expect(rejectionPayload([named])).toEqual([{ reason: "EXPIRED", quantity: 2, serial_numbers: ["A", "B"] }]);
    expect(rejectedSerials([named, { ...row("OTHER", "1", "x"), serials: ["C"] }])).toEqual(["A", "B", "C"]);
  });
});
