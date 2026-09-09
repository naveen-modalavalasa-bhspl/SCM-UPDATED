import type { Bin, StorageType } from "./types";

/**
 * What the storage-type master means for a form.
 *
 * The kinds of storage location used to be a `BIN_TYPES` array in `BinForm.tsx` and a
 * `defaultChildType` ladder beside it that guessed a child's kind from its parent's.
 * Neither constrained anything — a floor could be filed under a bin — and neither
 * matched the backend's own enum for long. The kinds are a master now, so every answer
 * this file gives comes off the served rows.
 *
 * Kept out of the components on purpose: the location form and the storage-type master
 * screen both need the same reading of the same rows, and a rule that lives in a
 * component is a rule the other screen quietly reimplements.
 */

/** Deepest-last: floor, lane, rack, shelf, bin — never alphabetical. */
export const byRung = (types: StorageType[]): StorageType[] =>
  [...types].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name),
  );

export const activeTypes = (types: StorageType[]): StorageType[] =>
  byRung(types.filter((t) => t.is_active));

/** The kind a location IS. By id, then by code — a location written before the master
 *  existed carries only the code, and it still has to render as something. */
export const typeOfLocation = (
  location: Pick<Bin, "storage_type_id" | "bin_type"> | null | undefined,
  types: StorageType[],
): StorageType | null => {
  if (!location) return null;
  if (location.storage_type_id != null) {
    const byId = types.find((t) => t.id === Number(location.storage_type_id));
    if (byId) return byId;
  }
  const code = (location.bin_type ?? "").toUpperCase();
  return types.find((t) => (t.code ?? "").toUpperCase() === code) ?? null;
};

/** The kinds a location of this kind may sit inside, in rung order. */
export const parentTypesOf = (
  type: StorageType | null | undefined,
  types: StorageType[],
): StorageType[] =>
  !type ? [] : byRung(types.filter((t) => type.parent_type_ids.includes(t.id)));

/**
 * Which existing locations this kind may hang off.
 *
 * A location whose kind is not on the list is not offered — that is the whole point of
 * the master: the storekeeper picks a rack because only racks are rackable, rather than
 * scrolling nine hundred rows and hoping. A kind with NO parents configured is not
 * constrained (the master starts empty for a kind somebody has just added, and
 * offering nothing would make a new rung unusable).
 */
export const eligibleParents = (
  locations: Bin[],
  type: StorageType | null | undefined,
  types: StorageType[],
  selfId?: number | null,
): Bin[] => {
  const others = locations.filter((row) => row.id !== selfId);
  if (!type || type.parent_type_ids.length === 0) return others;
  const allowed = new Set(type.parent_type_ids);
  return others.filter((row) => {
    const kind = typeOfLocation(row, types);
    return kind != null && allowed.has(kind.id);
  });
};

/** May a location of this kind stand at the root of the warehouse? */
export const canStandAlone = (type: StorageType | null | undefined): boolean =>
  !type || type.parent_type_ids.length === 0 || !!type.allow_top_level;

/** Does this kind want a temperature band on the form? */
export const isColdChain = (type: StorageType | null | undefined): boolean =>
  !!type?.is_temperature_controlled;

/**
 * The kind to pre-select for a new location being added under `parent`.
 *
 * The first kind, in rung order, that says it may sit inside the parent's kind — so
 * "Add under Rack 1" opens on Shelf and "Add under Shelf 3" opens on Storage bin,
 * derived from the master instead of the old hardcoded ladder. Nothing configured for
 * that parent falls back to the shallowest kind rather than to a guess.
 */
export const defaultChildType = (
  parent: Bin | null,
  types: StorageType[],
): StorageType | null => {
  const live = activeTypes(types);
  if (live.length === 0) return null;
  if (!parent) return live.find((t) => canStandAlone(t)) ?? live[0];
  const parentType = typeOfLocation(parent, types);
  if (!parentType) return live[0];
  return (
    live.find((t) => t.parent_type_ids.includes(parentType.id)) ?? live[live.length - 1]
  );
};
