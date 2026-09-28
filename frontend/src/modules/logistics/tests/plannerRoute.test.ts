import { describe, expect, it } from "vitest";
import {
  addStop, destinationsOf, moveStop, placeOf, removeStop, routeOrder, sameOrder, toggleStop,
} from "../components/plannerRoute";
import type { PlanConsignment } from "../transportTypes";

const row = (dispatch_id: number, dest: number, place: string, direct_km: number): PlanConsignment => ({
  dispatch_id, consignment_no: `DSP${dispatch_id}`, destination_warehouse_id: dest,
  destination_name: `AP-104-MMU-${place}-AP39XX0000 - LIP`, destination_place: place,
  latitude: 16, longitude: 80, packages: 2, weight_kg: 10, weight_known: true,
  weight_basis: "WEIGHED", volume_cbm: 0, volume_known: false, volume_basis: null,
  packages_weighed: 2, packages_measured: 0, direct_km,
});

// Badangi carries two consignments; Chataparru and Gundugolanu one each.
const CANDIDATES = [
  row(1, 10, "Badangi", 120), row(2, 10, "Badangi", 120),
  row(3, 20, "Chataparru", 40), row(4, 30, "Gundugolanu", 80),
];

describe("the hand-built route", () => {
  it("reads a stop by its place, the full label only when there is none", () => {
    expect(placeOf(CANDIDATES[0])).toBe("Badangi");
    expect(placeOf({ destination_name: "Central Store" })).toBe("Central Store");
  });

  it("lists one row per place, nearest the origin first", () => {
    const rows = destinationsOf(CANDIDATES);
    expect(rows.map((dest) => dest.place)).toEqual(["Chataparru", "Gundugolanu", "Badangi"]);
    expect(rows[2].dispatch_ids).toEqual([1, 2]);
    expect(rows[2].weight_kg).toBe(20);
  });

  it("adds a place with everything ready for it, in the order it was chosen", () => {
    let state = addStop({ selection: [], order: [] }, 10, CANDIDATES);
    state = addStop(state, 20, CANDIDATES);
    expect(state).toEqual({ selection: [1, 2, 3], order: [10, 20] });
    // Adding it again changes nothing — it is already the first stop.
    expect(addStop(state, 10, CANDIDATES)).toEqual(state);
  });

  it("takes a place off with all its consignments, and a beam toggles it", () => {
    const state = { selection: [1, 2, 3], order: [10, 20] };
    expect(removeStop(state, 10, CANDIDATES)).toEqual({ selection: [3], order: [20] });
    expect(toggleStop(state, 20, CANDIDATES)).toEqual({ selection: [1, 2], order: [10] });
    expect(toggleStop(state, 30, CANDIDATES)).toEqual({ selection: [1, 2, 3, 4], order: [10, 20, 30] });
  });

  it("moves a stop one place and never off either end", () => {
    expect(moveStop([10, 20, 30], 30, -1)).toEqual([10, 30, 20]);
    expect(moveStop([10, 20, 30], 10, -1)).toEqual([10, 20, 30]);
    expect(moveStop([10, 20, 30], 99, 1)).toEqual([10, 20, 30]);
  });

  it("keeps the arranged order and drops a place whose last consignment came off", () => {
    // One Badangi consignment off: the stop stays. Both off: it goes.
    expect(routeOrder([30, 10, 20], [2, 3, 4], CANDIDATES)).toEqual([30, 10, 20]);
    expect(routeOrder([30, 10, 20], [3, 4], CANDIDATES)).toEqual([30, 20]);
    // A consignment put back from elsewhere joins at the end.
    expect(routeOrder([20], [3, 4], CANDIDATES)).toEqual([20, 30]);
  });

  it("compares two orders element by element", () => {
    expect(sameOrder([1, 2], [1, 2])).toBe(true);
    expect(sameOrder([1, 2], [2, 1])).toBe(false);
    expect(sameOrder([1], [1, 2])).toBe(false);
  });
});
