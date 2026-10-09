import { useQuery } from "@tanstack/react-query";
import { api } from "@/shared/api/client";
import { useAuth } from "@/shared/auth/AuthContext";

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

/**
 * Just the word: "MDP", "LIP", or "Warehouse".
 *
 * Read off `me`, which the app already has before it renders anything, so the header
 * never paints "Warehouse" and then corrects itself — which is what a separate
 * request for it did. It is also the same string the left rail shows, because both
 * come from the one server-side rule (rank first, then field ops).
 */
export function usePointLabel(): string {
  return useAuth().me?.warehouse_label || "Warehouse";
}
