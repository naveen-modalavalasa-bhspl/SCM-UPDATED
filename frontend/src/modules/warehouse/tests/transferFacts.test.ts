import { describe, expect, it } from "vitest";
import {
  deliveryWindowIssue, deliveryWindowMissing, dueHint, schedulePending, windowDays,
} from "../components/deliveryWindow";
import { scopeFact, showsVehicleAndSac, smallFacts, tierLabel } from "../components/transferFacts";
import type { TransferContext } from "../types";

const base: TransferContext = { issue_id: 1, issue_no: "WHI0006", kind: "DIRECT" };

describe("the transfer card shows only what applies", () => {
  it("shows the project and hides the department when the project came forward", () => {
    expect(scopeFact({ project_name: "104-MMU", department_name: "Pharmacy" }))
      .toEqual({ kind: "project", value: "104-MMU" });
  });

  it("shows the department and hides the project when only a department came", () => {
    expect(scopeFact({ project_name: " ", department_name: "Pharmacy" }))
      .toEqual({ kind: "department", value: "Pharmacy" });
    expect(scopeFact({})).toBeNull();
  });

  it("leaves vehicle and SAC out for a warehouse or an MDP, keeps them for an LIP", () => {
    expect(showsVehicleAndSac({ destination_needs_vehicle_and_sac: false })).toBe(false);
    expect(showsVehicleAndSac({ destination_needs_vehicle_and_sac: true })).toBe(true);
    // Unknown tier keeps both, as before.
    expect(showsVehicleAndSac({ destination_needs_vehicle_and_sac: null })).toBe(true);
    expect(showsVehicleAndSac(undefined)).toBe(true);
  });

  it("lists the small facts in order, none that do not apply", () => {
    expect(smallFacts({ ...base, project_name: "104-MMU", destination_needs_vehicle_and_sac: false }))
      .toEqual(["scope"]);
    expect(smallFacts({ ...base, destination_needs_vehicle_and_sac: true }))
      .toEqual(["sac", "vehicle"]);
  });

  it("names a tier the way people say it", () => {
    expect(tierLabel("MAIN")).toBe("Main warehouse");
    expect(tierLabel("lip")).toBe("LIP");
    expect(tierLabel(null)).toBeNull();
  });
});

describe("dispatch date and expected delivery", () => {
  it("asks for both dates", () => {
    expect(deliveryWindowMissing(null, null)).toMatch(/dispatch date and the expected delivery/);
    expect(deliveryWindowMissing("2026-11-22", null)).toMatch(/expected delivery date/);
    expect(deliveryWindowMissing(null, "2026-11-25")).toMatch(/dispatch date/);
    expect(deliveryWindowMissing("2026-11-22", "2026-11-25")).toBeNull();
  });

  it("refuses dates before the consignment date, or delivery before dispatch", () => {
    expect(deliveryWindowIssue("2026-11-18", "2026-11-25", "2026-11-19")).toMatch(/dispatch date cannot be before/);
    expect(deliveryWindowIssue("2026-11-22", "2026-11-20", "2026-11-19")).toMatch(/before the dispatch date/);
    expect(deliveryWindowIssue("2026-11-22", "2026-11-25", "2026-11-19")).toBeNull();
  });

  it("counts the days on the road", () => {
    expect(windowDays("2026-11-22", "2026-11-25")).toBe(3);
    expect(windowDays("2026-11-22", "2026-11-22")).toBe(0);
    expect(windowDays("2026-11-25", "2026-11-22")).toBeNull();
  });

  it("reads a date against today, and calls it late only while it is still owed", () => {
    expect(dueHint("2026-11-23", "2026-11-20")).toEqual({ text: "In 3 days", tone: "muted" });
    expect(dueHint("2026-11-20", "2026-11-20", { pending: true })?.text).toBe("Today");
    expect(dueHint("2026-11-18", "2026-11-20", { pending: true })).toEqual({ text: "2 days late", tone: "late" });
    expect(dueHint("2026-11-18", "2026-11-20")).toEqual({ text: "2 days ago", tone: "muted" });
    expect(schedulePending("PACKED")).toEqual({ dispatch: true, delivery: true });
    expect(schedulePending("IN_TRANSIT")).toEqual({ dispatch: false, delivery: true });
    expect(schedulePending("DELIVERED")).toEqual({ dispatch: false, delivery: false });
  });
});
