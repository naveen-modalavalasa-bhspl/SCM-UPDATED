import { useQuery } from "@tanstack/react-query";
import { api } from "@/shared/api/client";
import type { PackEntry, PackHierarchy } from "./packing";

/** Every pack hierarchy of these items, in one call (`GET /api/pack-options`). */
export async function fetchPackOptions(itemIds: number[]):
  Promise<Record<number, PackHierarchy[]>> {
  const ids = [...new Set(itemIds.filter(Boolean))].sort((a, b) => a - b);
  if (!ids.length) return {};
  const { data } = await api.get<{ items: { item_id: number; hierarchies: PackHierarchy[] }[] }>(
    "/api/pack-options", { params: { item_ids: ids.join(",") } });
  return Object.fromEntries(data.items.map((row) => [row.item_id, row.hierarchies]));
}

/** The pack hierarchies of every item on a document, keyed by item id. Cached per
 *  set of items, so a fifty-line document asks once. */
export function usePackOptions(itemIds: number[], enabled = true) {
  const ids = [...new Set(itemIds.filter(Boolean))].sort((a, b) => a - b);
  return useQuery({
    queryKey: ["pack-options", ids.join(",")],
    queryFn: () => fetchPackOptions(ids),
    enabled: enabled && ids.length > 0,
    staleTime: 5 * 60 * 1000,
  });
}

/** Only the hierarchies that actually have a pack level — a "Loose" ladder offers
 *  nothing to choose. */
export function packable(list: PackHierarchy[] | undefined): PackHierarchy[] {
  return (list ?? []).filter((h) => h.levels.length > 1);
}

export interface PackSummary {
  stock_id: number;
  packs: PackEntry[];
  loose_qty: number;
  pack_text?: string | null;
  unreconciled: boolean;
  /** Part packs here, and how many are under their level's minimum (2026-10-11). */
  part_packs?: number;
  below_min?: number;
}

/** How each of these stock rows is packed, keyed by `stk_balance` id. Any screen
 *  listing stock rows reads it — over HTTP, so a module earlier in the chain than the
 *  warehouse (inventory) can show packs without importing the warehouse module. */
export function usePackSummary(stockIds: number[], enabled = true) {
  const ids = [...new Set(stockIds.filter((id) => id > 0))].sort((a, b) => a - b);
  return useQuery({
    queryKey: ["pack-summary", ids.join(",")],
    queryFn: async () => {
      const { data } = await api.post<{ items: PackSummary[] }>(
        "/api/warehouse/packs/summary", { stock_ids: ids });
      return Object.fromEntries(data.items.map((row) => [row.stock_id, row])) as
        Record<number, PackSummary>;
    },
    enabled: enabled && ids.length > 0,
    staleTime: 30 * 1000,
  });
}
