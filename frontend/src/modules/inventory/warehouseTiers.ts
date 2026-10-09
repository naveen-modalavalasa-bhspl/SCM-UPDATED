/**
 * Which tier a stocking point sits on, and what that means for a picker.
 *
 * NEW 2026-08-22. A LIP (Local Inventory Point) and an MDP (Material Distribution
 * Point) are rungs on the DISTRIBUTION chain: stock reaches them, it is not filled
 * from them. Every other type is the warehouse itself. Issuing back out of a chain
 * point is legal and occasionally right — a point holding spare covers a neighbour —
 * but it is roughly one case in a hundred, and both allocation screens were proposing
 * it by default because they sorted the points by quantity and nothing else. An item
 * with five units parked at one LIP and nothing in any warehouse opened with that LIP
 * selected, five already typed in, and five units quietly kept off the material
 * request.
 *
 * Mirror of `_CHAIN_TYPES` in `backend/app/modules/inventory/allocations.py`, which
 * draws the same line for `main_available_qty`. Kept in one file because the two
 * screens that need it — the Fulfilment Desk's batch view and the single-indent
 * allocation page — are the two that were wrong in the same way, and a second copy is
 * how they would drift apart again.
 */

/** `whs_warehouses.warehouse_type` values that are distribution rungs. */
export const CHAIN_TYPES = new Set(["LIP", "MDP"]);

export const isChainPoint = (point: { warehouse_type?: string | null }) =>
  CHAIN_TYPES.has((point.warehouse_type ?? "").toUpperCase());

/** Warehouses first, distribution points after. Order within each group is left
 *  exactly as the caller had it — the backend already sorts by what is on the shelf,
 *  and this only decides which group comes first. */
export const orderPoints = <T extends { warehouse_type?: string | null }>(points: T[]): T[] => [
  ...points.filter((p) => !isChainPoint(p)),
  ...points.filter(isChainPoint),
];
