import { describe, expect, it } from "vitest";
import {
  activeTypes, byRung, canStandAlone, defaultChildType, eligibleParents, isColdChain,
  parentTypesOf, typeOfLocation,
} from "../storageTypes";
import type { Bin, StorageType } from "../types";

/**
 * What the storage-type master means for the location form.
 *
 * The kinds of location, and which kind may sit inside which, were an array and a
 * `defaultChildType` ladder hardcoded in `BinForm.tsx` — a ladder that only guessed a
 * child's kind and constrained nothing, so a floor could be filed under a bin. These
 * tests are the rules that replaced it, read off served rows.
 */

const type = (
  id: number,
  code: string,
  name: string,
  sort_order: number,
  parents: number[] = [],
  extra: Partial<StorageType> = {},
): StorageType => ({
  id,
  code,
  name,
  description: null,
  sort_order,
  is_pickable: false,
  is_temperature_controlled: false,
  allow_top_level: parents.length === 0,
  is_active: true,
  parent_type_ids: parents,
  parent_type_codes: [],
  parent_type_names: [],
  location_count: 0,
  ...extra,
});

const FLOOR = type(1, "FLOOR", "Floor", 20, [], { allow_top_level: true });
const LANE = type(2, "LANE", "Lane / aisle", 30, [1]);
const RACK = type(3, "RACK", "Rack", 40, [2]);
const SHELF = type(4, "SHELF", "Shelf", 50, [3]);
const BIN = type(5, "BIN", "Storage bin", 60, [3, 4], { is_pickable: true });
const COLD_ROOM = type(6, "COLD_ROOM", "Cold room", 35, [1], {
  is_temperature_controlled: true, allow_top_level: true,
});
const RETIRED = type(7, "PALLET", "Pallet position", 55, [3], { is_active: false });

const TYPES = [BIN, RACK, FLOOR, SHELF, LANE, COLD_ROOM, RETIRED];

const location = (id: number, code: string, kind: StorageType): Bin => ({
  id,
  warehouse_id: 1,
  code,
  bin_type: kind.code,
  storage_type_id: kind.id,
  is_pickable: kind.is_pickable,
  is_active: true,
} as Bin);

const floor = location(10, "F1", FLOOR);
const lane = location(11, "F1-A1", LANE);
const rackOne = location(12, "F1-A1-R1", RACK);
const shelf = location(13, "F1-A1-R1-S1", SHELF);
const bay = location(14, "F1-A1-R1-S1-B1", BIN);
const LOCATIONS = [floor, lane, rackOne, shelf, bay];

describe("reading the master", () => {
  it("orders kinds by their rung, never alphabetically", () => {
    // Alphabetically a Bin comes before a Floor, which reads as a building with the
    // bays at the top of it.
    expect(byRung(TYPES).map((row) => row.code)).toEqual([
      "FLOOR", "LANE", "COLD_ROOM", "RACK", "SHELF", "PALLET", "BIN",
    ]);
  });

  it("leaves a switched-off kind out of what a form may choose", () => {
    expect(activeTypes(TYPES).map((row) => row.code)).not.toContain("PALLET");
  });

  it("names a location's kind by id, and falls back to its code", () => {
    expect(typeOfLocation(bay, TYPES)).toBe(BIN);
    // A location written before the master existed carries only the code, and it still
    // has to render as something.
    expect(typeOfLocation({ storage_type_id: null, bin_type: "rack" }, TYPES)).toBe(RACK);
    expect(typeOfLocation({ storage_type_id: 999, bin_type: "SHELF" }, TYPES)).toBe(SHELF);
    expect(typeOfLocation({ storage_type_id: null, bin_type: "CUPBOARD" }, TYPES)).toBeNull();
  });
});

describe("the parent type follows from the type", () => {
  it("states which kinds may hold this one, in rung order", () => {
    expect(parentTypesOf(BIN, TYPES).map((row) => row.name)).toEqual(["Rack", "Shelf"]);
    expect(parentTypesOf(FLOOR, TYPES)).toEqual([]);
  });

  it("offers only locations of those kinds as a parent", () => {
    // The whole point: a bin is filed on a rack or a shelf, so the storekeeper is not
    // scrolling nine hundred rows deciding for himself.
    expect(eligibleParents(LOCATIONS, BIN, TYPES).map((row) => row.code))
      .toEqual(["F1-A1-R1", "F1-A1-R1-S1"]);
    expect(eligibleParents(LOCATIONS, SHELF, TYPES).map((row) => row.code))
      .toEqual(["F1-A1-R1"]);
    expect(eligibleParents(LOCATIONS, LANE, TYPES).map((row) => row.code))
      .toEqual(["F1"]);
  });

  it("never offers a location as its own parent", () => {
    expect(eligibleParents(LOCATIONS, SHELF, TYPES, rackOne.id)).toEqual([]);
  });

  it("does not constrain a kind nobody has configured yet", () => {
    // The master starts empty for a kind somebody has just added; offering nothing
    // would make a new rung unusable on the day it is created.
    const fresh = type(8, "CARTON_BAY", "Carton bay", 61, []);
    expect(eligibleParents(LOCATIONS, fresh, TYPES).length).toBe(LOCATIONS.length);
  });

  it("says whether a kind may stand at the top of a warehouse", () => {
    expect(canStandAlone(FLOOR)).toBe(true);
    expect(canStandAlone(COLD_ROOM)).toBe(true);   // hangs off a floor AND stands alone
    expect(canStandAlone(SHELF)).toBe(false);      // a shelf on its own is unreachable
  });
});

describe("what the form asks for", () => {
  it("asks for a temperature band because the kind is cold chain", () => {
    expect(isColdChain(COLD_ROOM)).toBe(true);
    expect(isColdChain(RACK)).toBe(false);
  });

  it("opens 'add under this' on the first kind that may sit inside it", () => {
    expect(defaultChildType(rackOne, TYPES)?.code).toBe("SHELF");
    expect(defaultChildType(lane, TYPES)?.code).toBe("RACK");
    expect(defaultChildType(floor, TYPES)?.code).toBe("LANE");
    // Nothing to hang off: the shallowest kind that may stand on its own.
    expect(defaultChildType(null, TYPES)?.code).toBe("FLOOR");
  });
});
