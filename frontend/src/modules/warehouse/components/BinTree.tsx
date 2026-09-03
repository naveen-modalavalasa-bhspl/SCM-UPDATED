import { useState } from "react";
import { Boxes, ChevronDown, ChevronRight, PackageOpen } from "lucide-react";
import { Chip } from "@heroui/react";
import { fmtQty, percent } from "../format";
import { CapacityBadge, volume } from "./CapacityMeter";
import type { Bin } from "../types";

/**
 * The bin hierarchy of one warehouse.
 *
 * `whs_bins` nests through `parent_id`, so a zone, a rack and a shelf are the same
 * row type at different levels — the tree renders one component recursively rather
 * than modelling three tiers it would then have to keep in step with the schema.
 *
 * Occupancy is shown only when the backend sent it; a warehouse with
 * `is_bin_managed = false` has no per-bin numbers and gets no misleading 0%.
 */

function Node({
  bin,
  depth,
  selectedId,
  onSelect,
}: {
  bin: Bin;
  depth: number;
  selectedId?: number | null;
  onSelect?: (bin: Bin) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const children = bin.children ?? [];
  const hasChildren = children.length > 0;
  const used = bin.occupied_qty;
  const fill = used != null && bin.capacity_qty ? percent(used, bin.capacity_qty) : null;
  const selected = selectedId === bin.id;
  // Volume is the figure the put-away and issue screens work in, and the tree rolls
  // the bins under a rack up into it — so a zone with a capacity reports its own fill,
  // not a blank. The handling-unit limit rolls up the same way and is shown beside it:
  // a bay at its stated pallet limit is full whatever its cube says, and a tree that
  // only draws the cube sends a storekeeper to a bay with no slot left in it.
  const hasVolume = bin.capacity_volume != null && bin.capacity_volume > 0;
  const hasUnits = bin.capacity_units != null && bin.capacity_units > 0;

  return (
    <div>
      <div
        className={`flex min-h-11 items-center gap-2 rounded-lg pr-2 transition-colors ${
          selected ? "bg-brand-050" : "hover:bg-content2"
        }`}
        style={{ paddingLeft: `${depth * 18 + 4}px` }}
      >
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={hasChildren ? (open ? "Collapse" : "Expand") : "No children"}
          className="inline-flex h-8 w-8 items-center justify-center rounded text-muted disabled:opacity-30"
          disabled={!hasChildren}
        >
          {hasChildren ? (
            open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />
          ) : (
            <span className="h-4 w-4" />
          )}
        </button>

        <button
          type="button"
          onClick={() => onSelect?.(bin)}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
        >
          {hasChildren ? (
            <Boxes className="h-4 w-4 shrink-0 text-muted" />
          ) : (
            <PackageOpen className="h-4 w-4 shrink-0 text-muted" />
          )}
          <span className="truncate font-mono text-xs font-semibold text-ink">{bin.code}</span>
          {bin.name && <span className="truncate text-xs text-muted">{bin.name}</span>}
        </button>

        {!bin.is_active && (
          <Chip size="sm" variant="flat" color="default">Inactive</Chip>
        )}
        {!bin.is_pickable && bin.is_active && (
          <Chip size="sm" variant="flat" color="warning">No pick</Chip>
        )}
        {(hasVolume || hasUnits) && (
          <span
            className="shrink-0"
            title={
              (hasVolume
                ? `${volume(bin.occupied_volume)} of ${volume(bin.capacity_volume)} used`
                : "") +
              (hasVolume && hasUnits ? " · " : "") +
              (hasUnits
                ? `${bin.occupied_units ?? 0} of ${bin.capacity_units} handling units`
                : "")
            }
          >
            <CapacityBadge
              capacity={bin.capacity_volume}
              occupied={bin.occupied_volume}
              status={bin.capacity_status}
              units={bin.occupied_units}
              capacityUnits={bin.capacity_units}
            />
          </span>
        )}
        {fill != null && (
          <span
            className={`shrink-0 text-xs font-semibold tabular ${
              fill >= 90 ? "text-bad" : fill >= 70 ? "text-warn" : "text-muted"
            }`}
            title={`${fmtQty(used)} of ${fmtQty(bin.capacity_qty)}`}
          >
            {fill}%
          </span>
        )}
      </div>

      {open &&
        children.map((child) => (
          <Node key={child.id} bin={child} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} />
        ))}
    </div>
  );
}

export function BinTree({
  bins,
  selectedId,
  onSelect,
  empty = "This warehouse has no bins yet.",
}: {
  bins: Bin[];
  selectedId?: number | null;
  onSelect?: (bin: Bin) => void;
  empty?: string;
}) {
  if (bins.length === 0) {
    return <div className="py-10 text-center text-sm text-muted">{empty}</div>;
  }
  return (
    <div className="space-y-0.5">
      {bins.map((bin) => (
        <Node key={bin.id} bin={bin} depth={0} selectedId={selectedId} onSelect={onSelect} />
      ))}
    </div>
  );
}

/** Flattens the tree for a picker/dropdown, keeping the path as the label. */
export function flattenBins(bins: Bin[]): Bin[] {
  const out: Bin[] = [];
  const walk = (rows: Bin[]) => {
    for (const b of rows) {
      out.push(b);
      if (b.children?.length) walk(b.children);
    }
  };
  walk(bins);
  return out;
}
