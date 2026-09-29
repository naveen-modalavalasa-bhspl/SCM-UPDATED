import { describe, expect, it } from "vitest";
import { tripProgressText, tripStopLabel } from "../components/tripLeg";
import type { RaiserTracking } from "../types";

const leg = (patch: Partial<RaiserTracking>): RaiserTracking => ({
  tr_id: 1, tr_no: "TR0001", status: "IN_TRANSIT", mode: "THIRD_PARTY", events: [],
  trip_no: "TRIP-0001", stop_sequence: 2, total_stops: 3, stop_name: "Ongole LIP",
  ...patch,
});

describe("a consignment on a shared truck, told from its own stop", () => {
  it("names the stop and how many drops come first", () => {
    expect(tripStopLabel(leg({}))).toBe("Stop 2 of 3 · Ongole LIP");
    expect(tripProgressText(leg({ stops_before_yours: 1, next_stop_name: "Guntur" })))
      .toBe("On the road — 1 stop before yours (next: Guntur)");
    expect(tripProgressText(leg({ stops_before_yours: 0 }))).toBe("On the road — your stop is next");
  });

  it("reads delivered from the stop even while the truck runs on", () => {
    expect(tripProgressText(leg({ status: "DELIVERED", shipment_status: "IN_TRANSIT" })))
      .toMatch(/^Put down at your stop/);
    expect(tripProgressText(leg({ status: "ACKNOWLEDGED" }))).toBe("Signed for at your stop");
  });

  it("before the truck leaves, says it is planned", () => {
    expect(tripProgressText(leg({ status: "QUOTING" }))).toMatch(/^Planned on a shared truck/);
  });
});
