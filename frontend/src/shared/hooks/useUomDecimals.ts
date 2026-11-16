import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";

/** What the server falls back to for a unit nobody has classified. */
export const DEFAULT_UOM_DECIMALS = 3;

type DecimalsMap = Record<string, number>;

/** Look a unit up the way the server does: exact code, then code folded, then name. */
export function decimalsOf(map: DecimalsMap | undefined, code: string | null | undefined): number {
  const key = (code ?? "").trim();
  if (!map || !key) return DEFAULT_UOM_DECIMALS;
  return map[key] ?? map[key.toLowerCase()] ?? DEFAULT_UOM_DECIMALS;
}

/**
 * Places each unit allows — the UOM type's "Allows decimal" — for any quantity box.
 *
 * One cached read for the whole app (about thirty units), so a screen only needs the
 * `uom_code` it already has; no API has to be widened to carry decimals per line.
 * Until it arrives, and for a unit not in the map, the answer is the stored three —
 * the same fallback the server uses — and the server still refuses what the unit
 * cannot hold. Vendor portals read their own copy, because a vendor token is not
 * accepted by the staff API.
 */
export function useUomDecimals(): (code: string | null | undefined) => number {
  const vendor = typeof location !== "undefined"
    && (location.pathname.startsWith("/supplier") || location.pathname.startsWith("/carrier"));
  const query = useQuery({
    queryKey: ["uom", "decimals", vendor ? "vendor" : "staff"],
    queryFn: () => api.get<DecimalsMap>(vendor ? "/api/supplier/uom-decimals" : "/api/uom-decimals")
      .then((r) => r.data),
    staleTime: 10 * 60 * 1000,
  });
  return (code) => decimalsOf(query.data, code);
}
