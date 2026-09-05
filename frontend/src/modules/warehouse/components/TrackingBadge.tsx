import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Barcode, Hash, Package, QrCode, Tag } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { trackingTypes } from "../api";
import type { TrackingType, TrackingTypeMeta } from "../types";

/**
 * What a storekeeper is being asked to read off the goods, said once, in colour.
 *
 * Serials, IMEIs, asset tags and consumable lot codes used to arrive in one
 * undifferentiated column of monospace strings. They look alike — fifteen
 * characters of upper case and digits — so the only way to tell an IMEI from an
 * asset tag was to know the item, and a storekeeper holding a handset could not
 * tell which of its two printed numbers the line wanted. The badge answers that
 * before he starts scanning.
 *
 * **The words are SERVED**, never written here: `trackingTypes()` reads the
 * backend's `TRACKING_META`, the same rule the logistics ledger follows for
 * `ACTIVITY_META`. Only the colour and the icon are the screen's, because those are
 * presentation and there is nowhere sensible to keep them on the server. Until the
 * catalogue lands the badge shows the raw code rather than a second copy of the
 * wording — a blank badge and a duplicated one are both worse than a plain one.
 */

/** One shared query. Every row on a document renders a badge, and the catalogue is
 *  five constant rows — fetching it per badge would be a request per line. */
export function useTrackingMeta() {
  const { data } = useQuery({
    queryKey: ["wh-tracking-types"],
    queryFn: trackingTypes,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  // Memoised on the served rows, so callers can put the lookup in a dependency list
  // and have their own memos recompute exactly once — when the catalogue lands. A
  // fresh closure per render would either thrash them or, if left out of the deps,
  // freeze the first render's wording in place, which is how every message came out
  // saying "unit" instead of "asset tag".
  return useMemo(() => {
    const byCode = new Map((data ?? []).map((row) => [row.code, row]));
    return (code?: TrackingType | null): TrackingTypeMeta | null =>
      (code ? byCode.get(code) ?? null : null);
  }, [data]);
}

/** Colour and icon per kind. Categorical, not a severity ramp: nothing here is
 *  better or worse than anything else, so the hues only have to stay apart from one
 *  another and from the status pills, in both themes. */
const LOOK: Record<TrackingType, { icon: LucideIcon; chip: string; dot: string }> = {
  SERIAL: {
    icon: Barcode,
    chip: "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-400/40 dark:bg-blue-400/10 dark:text-blue-300",
    dot: "bg-blue-500",
  },
  IMEI: {
    icon: Hash,
    chip: "border-cyan-300 bg-cyan-50 text-cyan-700 dark:border-cyan-400/40 dark:bg-cyan-400/10 dark:text-cyan-300",
    dot: "bg-cyan-500",
  },
  ASSET: {
    icon: Tag,
    chip: "border-purple-300 bg-purple-50 text-purple-700 dark:border-purple-400/40 dark:bg-purple-400/10 dark:text-purple-300",
    dot: "bg-purple-500",
  },
  CONSUMABLE: {
    icon: Package,
    chip: "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  NONE: {
    icon: QrCode,
    chip: "border-line bg-content2 text-muted",
    dot: "bg-muted",
  },
};

export function TrackingBadge({
  type,
  meta,
  size = "md",
  className = "",
}: {
  type?: TrackingType | null;
  /** The served row, from `useTrackingMeta()`. Absent while the catalogue loads. */
  meta?: TrackingTypeMeta | null;
  size?: "sm" | "md";
  className?: string;
}) {
  if (!type) return null;
  const look = LOOK[type] ?? LOOK.NONE;
  const Icon = look.icon;
  return (
    <span
      title={meta?.hint}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border font-semibold uppercase tracking-wide ${
        size === "sm" ? "px-1.5 py-0 text-[10px]" : "px-2 py-0.5 text-[11px]"
      } ${look.chip} ${className}`}
    >
      <Icon className={size === "sm" ? "h-2.5 w-2.5" : "h-3 w-3"} aria-hidden />
      {meta?.label ?? type}
    </span>
  );
}

/** The dot alone, for dense places a full chip will not fit — a picker's type
 *  column, where the same word would repeat down every row. */
export function TrackingDot({ type }: { type?: TrackingType | null }) {
  if (!type) return null;
  return <span className={`inline-block h-2 w-2 rounded-full ${(LOOK[type] ?? LOOK.NONE).dot}`} aria-hidden />;
}
