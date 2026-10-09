import { describe, expect, it } from "vitest";

import {
  comparableVehicleNumber, displayUom, splitDeliveryOffice,
} from "../displayFormat";

describe("indent display formatting", () => {
  it.each([
    ["uom-ml", "ml"],
    ["UOM-NOS", "NOS"],
    ["uom_nos", "nos"],
    ["ml", "ml"],
    [null, ""],
  ])("shows %s as the short UOM code", (value, expected) => {
    expect(displayUom(value)).toBe(expected);
  });

  it("separates a vehicle suffix from the delivery office", () => {
    expect(splitDeliveryOffice(
      "AP-104-MMU-Phc Thambalavaripalli-AP39TL9566",
    )).toEqual({
      officeName: "AP-104-MMU-Phc Thambalavaripalli",
      vehicleNumber: "AP39TL9566",
    });
  });

  it("uses the saved vehicle and does not split an unrelated office suffix", () => {
    expect(splitDeliveryOffice("Main Office-AP39TL9566", "TS09-XX-1000")).toEqual({
      officeName: "Main Office-AP39TL9566",
      vehicleNumber: "TS09-XX-1000",
    });
  });

  it("matches registrations regardless of display punctuation", () => {
    expect(comparableVehicleNumber("AP39-TL-9566"))
      .toBe(comparableVehicleNumber("AP39TL9566"));
  });
});
