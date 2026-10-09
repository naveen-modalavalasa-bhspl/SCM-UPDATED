import { ChevronRight, MapPin } from "lucide-react";
import type { LocationStep } from "../types";

/**
 * Where a location actually IS, drawn as the walk down to it.
 *
 * A bin code is not a place. `F1-A1-R1-B2` and `F1-A1-R2-B2` are one character apart
 * and thirty metres apart, and a storekeeper reading either of them out of a dropdown
 * has been handed a memory test rather than a destination. So every screen that names
 * a storage location draws the whole hierarchy the warehouse was configured with —
 * floor, lane, rack, shelf, bin, or whatever levels that site actually uses.
 *
 * The steps are SERVED (`bin_steps` on a stock source, `steps` on a location option).
 * Nothing here splits a code on hyphens to guess at a hierarchy: the tree lives in
 * `whs_warehouse_locations` and a screen inventing one would be wrong the first time
 * somebody re-parented a rack.
 *
 * `path` is the same answer already joined into a string, for the rows that arrive
 * with no steps on them. One of the two is always enough.
 */
export function LocationTrail({
  steps,
  path,
  code,
  size = "sm",
  className = "",
}: {
  steps?: LocationStep[] | null;
  path?: string | null;
  /** Drawn on its own when neither the steps nor the path made it back. */
  code?: string | null;
  size?: "sm" | "xs";
  className?: string;
}) {
  const rungs: string[] = steps?.length
    ? steps.map((step) => step.code)
    : path
      ? path.split("/").map((part) => part.trim()).filter(Boolean)
      : code
        ? [code]
        : [];

  if (rungs.length === 0) return null;

  const text = size === "xs" ? "text-[10px]" : "text-[11px]";
  const leaf = rungs[rungs.length - 1];
  const above = rungs.slice(0, -1);

  return (
    <div
      className={`flex flex-wrap items-center gap-x-0.5 gap-y-0.5 ${text} ${className}`}
      // One string for a screen reader and for the tooltip: the chevrons are
      // decoration, and reading "F1 chevron F1-A1 chevron" aloud helps nobody.
      title={rungs.join(" / ")}
    >
      <MapPin className="mr-0.5 h-3 w-3 shrink-0 text-brand" aria-hidden />
      {above.map((rung, position) => (
        <span key={`${rung}-${position}`} className="flex items-center gap-0.5">
          <span className="font-mono text-muted">{rung}</span>
          <ChevronRight className="h-3 w-3 shrink-0 text-muted/60" aria-hidden />
        </span>
      ))}
      {/* The bin itself in full contrast: it is the one rung somebody has to match
        * against a label on a shelf, and the rest is the route to it. */}
      <span className="font-mono font-semibold text-ink">{leaf}</span>
    </div>
  );
}

/**
 * The same walk, for the levels ABOVE a location — used where the leaf is already
 * printed beside it and repeating it would read as two different places.
 */
export function LocationContext({
  steps,
  path,
  className = "",
}: {
  steps?: LocationStep[] | null;
  path?: string | null;
  className?: string;
}) {
  const rungs: string[] = steps?.length
    ? steps.map((step) => step.name || step.code)
    : path
      ? path.split("/").map((part) => part.trim()).filter(Boolean)
      : [];
  const above = rungs.slice(0, -1);
  if (above.length === 0) return null;
  return (
    <span className={`text-[10px] text-muted ${className}`} title={above.join(" / ")}>
      {above.join(" › ")}
    </span>
  );
}
