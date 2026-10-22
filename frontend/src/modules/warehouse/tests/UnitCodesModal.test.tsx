import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { UnitCodesModal, type UnitCodeGroup } from "../components/UnitCodesModal";

/** A valid IMEI (its 15th digit is the Luhn check digit of the first 14). */
const IMEI_A = "490154203237518";
const IMEI_B = "356938035643809";

function open(groups: UnitCodeGroup[], { serial = true, imei = true } = {}) {
  const onSave = vi.fn();
  render(
    <UnitCodesModal isOpen onClose={() => {}} onSave={onSave} itemName="Handset"
                    itemCode="PH-0001" uom="NOS" trackSerial={serial} trackImei={imei}
                    groups={groups} focusIndex={groups[0].index} />,
  );
  return onSave;
}

const scan = (value: string) => {
  const box = screen.getByLabelText("Scan a code");
  fireEvent.change(box, { target: { value } });
  fireEvent.keyDown(box, { key: "Enter" });
};

const line = (index: number, qty: number, extra: Partial<UnitCodeGroup> = {}): UnitCodeGroup =>
  ({ index, qty, serials: [], imeis: [], batchNo: "B1", ...extra });

describe("serial & IMEI capture, one row per unit", () => {
  it("fills each scan into the next empty cell — serial then IMEI of the same unit", () => {
    const onSave = open([line(0, 2)]);
    scan("SN-1"); scan(IMEI_A); scan("SN-2"); scan(IMEI_B);
    expect((screen.getByLabelText("Serial, unit 2") as HTMLInputElement).value).toBe("SN-2");
    expect((screen.getByLabelText("IMEI, unit 1") as HTMLInputElement).value).toBe(IMEI_A);
    fireEvent.click(screen.getByRole("button", { name: /Save 2 of 2/ }));
    expect(onSave).toHaveBeenCalledWith([
      { index: 0, serial_numbers: ["SN-1", "SN-2"], imei_numbers: [IMEI_A, IMEI_B] },
    ]);
  });

  it("refuses a code already scanned, on any line of the same item", () => {
    open([line(0, 1), line(3, 1, { batchNo: "B2", packLabel: "Box of 20" })], { imei: false });
    scan("SN-1");
    scan("SN-1");
    expect(screen.getByText(/SN-1 is already scanned \(line 1, unit 1\)/)).toBeTruthy();
    // The second line's tab took nothing.
    expect(screen.getByText(/Batch B2/)).toBeTruthy();
  });

  it("will not save a handset with a serial and no IMEI", () => {
    open([line(0, 2)]);
    fireEvent.change(screen.getByLabelText("Serial, unit 1"), { target: { value: "SN-1" } });
    expect(screen.getByText(/Needs its IMEI too/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Save 0 of 2/ })).toBeDisabled();
  });

  it("pairs two pasted columns row by row", () => {
    const onSave = open([line(0, 2)]);
    fireEvent.paste(screen.getByLabelText("Serial, unit 1"), {
      clipboardData: { getData: () => `SN-1\t${IMEI_A}\nSN-2\t${IMEI_B}` },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save 2 of 2/ }));
    expect(onSave.mock.calls[0][0][0].imei_numbers).toEqual([IMEI_A, IMEI_B]);
  });

  it("fills a pasted list into the empty units, spilling onto the item's next line", () => {
    const onSave = open([line(0, 2), line(1, 2, { batchNo: "B2" })], { imei: false });
    fireEvent.change(screen.getByLabelText("Bulk serials"),
                     { target: { value: "S1\nS2, S3 S4" } });
    expect(screen.getByText(/4 serials found/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Add 4 pasted/ }));
    fireEvent.click(screen.getByRole("button", { name: /Save 4 of 4/ }));
    expect(onSave).toHaveBeenCalledWith([
      { index: 0, serial_numbers: ["S1", "S2"], imei_numbers: null },
      { index: 1, serial_numbers: ["S3", "S4"], imei_numbers: null },
    ]);
  });

  it("refuses a list longer than the units left, without applying any of it", () => {
    open([line(0, 2)], { imei: false });
    fireEvent.change(screen.getByLabelText("Bulk serials"), { target: { value: "S1 S2 S3" } });
    expect(screen.getByText(/3 in your list, but only 2 units still need a code/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add 3 pasted/ })).toBeDisabled();
    expect((screen.getByLabelText("Serial, unit 1") as HTMLInputElement).value).toBe("");
  });

  it("reads a pasted list of pairs as each unit's serial and IMEI", () => {
    const onSave = open([line(0, 2)]);
    fireEvent.change(screen.getByLabelText("Bulk serial & IMEI pairs"),
                     { target: { value: `SN-1 ${IMEI_A}\nSN-2,${IMEI_B}` } });
    fireEvent.click(screen.getByRole("button", { name: /Add 2 pasted/ }));
    fireEvent.click(screen.getByRole("button", { name: /Save 2 of 2/ }));
    expect(onSave.mock.calls[0][0][0]).toEqual(
      { index: 0, serial_numbers: ["SN-1", "SN-2"], imei_numbers: [IMEI_A, IMEI_B] });
  });

  it("takes a whole list pasted into the scan box, as the GRN popup does", () => {
    open([line(0, 3)], { imei: false });
    fireEvent.paste(screen.getByLabelText("Scan a code"), {
      clipboardData: { getData: () => "A1\nA2\nA3" },
    });
    expect(screen.getByText(/Added 3 serials/)).toBeTruthy();
    expect((screen.getByLabelText("Serial, unit 3") as HTMLInputElement).value).toBe("A3");
  });

  it("warns, never blocks, on an IMEI whose check digit is wrong", () => {
    open([line(0, 1)], { serial: false });
    scan("490154203237519");
    expect(screen.getAllByText(/Check digit does not match/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Save 1 of 1/ })).not.toBeDisabled();
  });
});
