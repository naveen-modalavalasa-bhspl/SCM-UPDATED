import type { ConsolidatedTrip, TripStop } from "../transportTypes";

/** What a trip's status is called on screen. The status itself (and its tone) stays
 *  the server's; only the words are softened for the desk. */
export const TRIP_STATUS_WORDS: Record<string, string> = {
  PLANNED: "Planned",
  IN_TRANSIT: "On the road",
  PARTIALLY_DELIVERED: "Delivering",
  DELIVERED: "All stops reached",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

/** A stop or a consignment on a trip. */
export const STOP_STATUS_WORDS: Record<string, string> = {
  PLANNED: "Waiting to load",
  IN_TRANSIT: "On the truck",
  DELIVERED: "Delivered · awaiting sign-off",
  ACKNOWLEDGED: "Signed for",
  CANCELLED: "Cancelled",
};

export type StopMapState = "planned" | "transit" | "delivered" | "acknowledged";

export function stopMapState(status: string): StopMapState {
  if (status === "ACKNOWLEDGED") return "acknowledged";
  if (status === "DELIVERED") return "delivered";
  if (status === "IN_TRANSIT") return "transit";
  return "planned";
}

/** Delivered/signed counts, read off the stops themselves. */
export function tripProgress(trip: Pick<ConsolidatedTrip, "stops">) {
  const total = trip.stops.length;
  const delivered = trip.stops.filter((s) => s.status === "DELIVERED" || s.status === "ACKNOWLEDGED").length;
  const signed = trip.stops.filter((s) => s.status === "ACKNOWLEDGED").length;
  return { total, delivered, signed };
}

/** Which leg the truck is on: 0 is origin → stop 1. Null before it leaves and after
 *  the last stop. */
export function truckLeg(trip: Pick<ConsolidatedTrip, "status" | "stops">): number | null {
  if (!["IN_TRANSIT", "PARTIALLY_DELIVERED"].includes(trip.status)) return null;
  const next = trip.stops.findIndex((s: TripStop) => s.status === "IN_TRANSIT" || s.status === "PLANNED");
  return next < 0 ? null : next;
}

export type TripHeadlineTone = "ok" | "info" | "warn" | "bad" | "neutral";

/** The trip's state in ONE sentence: "Trip delivered", "On the road", read off the
 *  trip and its shipment. Words only; every status is still the server's. */
export function tripHeadline(trip: Pick<ConsolidatedTrip, "status" | "stops"> & {
  shipment?: { status: string } | null;
}): { title: string; detail: string; tone: TripHeadlineTone } {
  const { delivered, signed, total } = tripProgress(trip);
  const shipment = trip.shipment?.status ?? "DRAFT";
  switch (trip.status) {
    case "CANCELLED":
      return { title: "Trip cancelled", detail: "Its consignments went back to the Dispatch queue.", tone: "bad" };
    case "COMPLETED":
      return { title: "Trip completed", detail: `All ${total} drops delivered and signed for.`, tone: "ok" };
    case "DELIVERED":
      return {
        title: "Trip delivered",
        detail: signed === total
          ? `All ${total} drops signed for.`
          : `All ${total} drops reached · ${total - signed} site${total - signed === 1 ? "" : "s"} still to sign.`,
        tone: "ok",
      };
    case "IN_TRANSIT":
    case "PARTIALLY_DELIVERED": {
      const next = trip.stops.find((s) => s.status === "IN_TRANSIT" || s.status === "PLANNED");
      return {
        title: "On the road",
        detail: `${delivered} of ${total} drops reached${next ? ` · heading to stop ${next.sequence}` : ""}.`,
        tone: "info",
      };
    }
    default:
      if (shipment === "DRAFT") {
        return { title: "Planned", detail: "Transport is not arranged yet. Choose the mode and provider on the Dispatch screen.", tone: "neutral" };
      }
      if (shipment === "READY") {
        return { title: "Ready to leave", detail: "The vehicle is booked. Release it at the gate from the shipment.", tone: "info" };
      }
      return { title: "Arranging transport", detail: "Waiting on approval, a price or the carrier's yes.", tone: "warn" };
  }
}
