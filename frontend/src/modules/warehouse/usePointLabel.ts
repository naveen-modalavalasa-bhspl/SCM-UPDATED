import { useQuery } from "@tanstack/react-query";
import { api } from "@/shared/api/client";

/**
 * What this login calls the place it works out of.
 *
 * Somebody holding an MDP does not call it a warehouse, and a screen that insists
 * otherwise reads as somebody else's software. The type comes from the point tagged
 * to their position, so the label can never disagree with the tier the classifier
 * reads — and anyone without a stocking point of their own still sees "Warehouse".
 *
 * Cached for the session: a person's own point does not change while they work.
 */
export interface MyPoint {
  primary_warehouse_id?: number | null;
  warehouse_ids: number[];
  point_type?: string | null;
  point_name?: string | null;
  point_label: string;
}

export function useMyPoint() {
  return useQuery({
    queryKey: ["stocking-points", "mine"],
    queryFn: () => api.get<MyPoint>("/api/stocking-points/mine").then((r) => r.data),
    staleTime: 30 * 60_000,
  });
}

/** Just the word: "MDP", "LIP", or "Warehouse". Never blank while loading. */
export function usePointLabel(): string {
  return useMyPoint().data?.point_label || "Warehouse";
}
