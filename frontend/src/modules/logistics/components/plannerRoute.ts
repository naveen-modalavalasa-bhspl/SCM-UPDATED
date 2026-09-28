import type { PlanConsignment } from "../transportTypes";

/**
 * The hand-built route, as plain data: which consignments are on the truck and in
 * what order it calls at their stocking points. Pure, so the builder, the map beams
 * and the manifest all edit the route through the same five functions.
 *
 * A STOP is a place, never a consignment: adding a place puts every consignment
 * ready for it on the truck, and a place drops off the route when its last one is
 * taken off. `order` is destination warehouse ids, exactly what the planner's
 * `stop_order` takes, and it is always sent in full from the builder — so the route
 * the server measures is the route the person arranged, never a re-optimised one.
 */

export interface RouteState {
  selection: number[];
  order: number[];
}

/** What a person reads a stop by — served by the planner, the full label if not. */
export const placeOf = (row: { destination_place?: string | null; destination_name?: string | null }) =>
  row.destination_place || row.destination_name || "—";

/** One stocking point with consignments ready for it. */
export interface Destination {
  id: number;
  place: string;
  name: string;
  code?: string | null;
  type?: string | null;
  direct_km: number;
  dispatch_ids: number[];
  consignment_nos: string[];
  packages: number;
  weight_kg: number;
}

/** The ready consignments, one row per place, nearest the origin first. */
export function destinationsOf(candidates: PlanConsignment[]): Destination[] {
  const byId = new Map<number, Destination>();
  for (const row of candidates) {
    const entry = byId.get(row.destination_warehouse_id) ?? {
      id: row.destination_warehouse_id, place: placeOf(row), name: row.destination_name,
      code: row.destination_code, type: row.destination_type, direct_km: row.direct_km,
      dispatch_ids: [], consignment_nos: [], packages: 0, weight_kg: 0,
    };
    entry.dispatch_ids.push(row.dispatch_id);
    entry.consignment_nos.push(row.consignment_no);
    entry.packages += row.packages || 0;
    entry.weight_kg += row.weight_kg || 0;
    byId.set(entry.id, entry);
  }
  return [...byId.values()].sort((a, b) => a.direct_km - b.direct_km || a.id - b.id);
}

const idsAt = (destId: number, candidates: PlanConsignment[]) =>
  candidates.filter((row) => row.destination_warehouse_id === destId).map((row) => row.dispatch_id);

/** Call at `destId` next, with everything ready for it. Already on the route: its
 *  left-over consignments join, and its place in the order is kept. */
export function addStop(state: RouteState, destId: number, candidates: PlanConsignment[]): RouteState {
  const ids = idsAt(destId, candidates);
  return {
    selection: [...state.selection, ...ids.filter((id) => !state.selection.includes(id))],
    order: state.order.includes(destId) ? state.order : [...state.order, destId],
  };
}

export function removeStop(state: RouteState, destId: number, candidates: PlanConsignment[]): RouteState {
  const ids = idsAt(destId, candidates);
  return {
    selection: state.selection.filter((id) => !ids.includes(id)),
    order: state.order.filter((id) => id !== destId),
  };
}

/** A map beam is a place: on the route it comes off, off the route it goes on last. */
export function toggleStop(state: RouteState, destId: number, candidates: PlanConsignment[]): RouteState {
  const ids = idsAt(destId, candidates);
  const onRoute = ids.length > 0 && ids.every((id) => state.selection.includes(id));
  return onRoute ? removeStop(state, destId, candidates) : addStop(state, destId, candidates);
}

export function moveStop(order: number[], destId: number, delta: number): number[] {
  const at = order.indexOf(destId);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= order.length) return order;
  const next = [...order];
  [next[at], next[to]] = [next[to], next[at]];
  return next;
}

/**
 * The order actually on the route: the places `order` names that still carry a
 * selected consignment, then any place carrying one that `order` does not name yet
 * (a consignment put back from the manifest), in the order it was selected.
 */
export function routeOrder(order: number[], selection: number[], candidates: PlanConsignment[]): number[] {
  const destOf = new Map(candidates.map((row) => [row.dispatch_id, row.destination_warehouse_id]));
  const carried: number[] = [];
  for (const id of selection) {
    const dest = destOf.get(id);
    if (dest != null && !carried.includes(dest)) carried.push(dest);
  }
  return [...order.filter((dest) => carried.includes(dest)), ...carried.filter((dest) => !order.includes(dest))];
}

export const sameOrder = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);
