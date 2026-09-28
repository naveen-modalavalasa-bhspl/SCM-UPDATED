import type { RaiserTracking } from "../types";

/**
 * The raiser's words for a consignment riding a multi-drop trip — one place, so the
 * indent card, the stepper and the acknowledgement screen say the same thing.
 *
 * Everything here is read off what `/api/transport/for-indent` serves for THEIR stop
 * (`transport.trip_raiser_view`): the leg's `status` is already their consignment's,
 * not the truck's, so a stop put down while the truck runs on reads delivered.
 */

export function isTripLeg(leg: RaiserTracking | undefined | null): boolean {
  return Boolean(leg?.trip_no);
}

/** "Stop 2 of 3 · Ongole LIP" */
export function tripStopLabel(leg: RaiserTracking): string {
  const where = leg.stop_name ? ` · ${leg.stop_name}` : "";
  if (leg.stop_sequence && leg.total_stops) return `Stop ${leg.stop_sequence} of ${leg.total_stops}${where}`;
  return leg.stop_name ?? "";
}

/** Where the truck is, told from this stop. */
export function tripProgressText(leg: RaiserTracking): string {
  const status = String(leg.status ?? "").toUpperCase();
  if (status === "ACKNOWLEDGED" || leg.acknowledged_at) return "Signed for at your stop";
  if (status === "DELIVERED") {
    return leg.stop_received_by_name
      ? `Put down at your stop, received by ${leg.stop_received_by_name} — sign when you have counted it`
      : "Put down at your stop — sign when you have counted it";
  }
  if (status === "IN_TRANSIT") {
    const ahead = leg.stops_before_yours ?? 0;
    if (ahead <= 0) return "On the road — your stop is next";
    return `On the road — ${ahead} stop${ahead === 1 ? "" : "s"} before yours${leg.next_stop_name ? ` (next: ${leg.next_stop_name})` : ""}`;
  }
  return "Planned on a shared truck — waiting to leave the warehouse";
}
