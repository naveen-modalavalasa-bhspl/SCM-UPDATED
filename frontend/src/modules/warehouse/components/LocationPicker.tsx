import { Field, Select } from "@/shared/components";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, CornerDownRight, MapPin } from "lucide-react";
import { getBinTree } from "../api";
import type { Bin } from "../types";
import { humanise } from "../format";

/**
 * Walk a warehouse's storage hierarchy one level at a time: block → floor → lane →
 * rack → shelf → bin, or whatever levels that warehouse was actually configured with.
 *
 * Nothing here is hardcoded to a fixed set of levels. The tree comes back nested from
 * `GET /warehouses/{id}/bins` and a dropdown is drawn for each level that has
 * something to choose from, so a three-level warehouse shows three dropdowns and a
 * six-level one shows six.
 *
 * **`allowAnyLevel` lets the goods be put down where they are actually put down.**
 * The picker used to refuse anything above a bin — stop at a rack and the selection
 * silently cleared — on the grounds that a rack is somewhere you walk past. That is
 * true of a warehouse whose master data is finished, and false of every real floor:
 * a pallet of cable drums goes at the end of lane A, a delivery arrives before its
 * bay has been built, a cold room is one space and not a grid of bays. Refusing did
 * not stop any of it happening; it only stopped the system being told, and stock
 * nobody wrote down is worse than stock in the wrong shape of location. So the level
 * is a choice, stated plainly, and the screen says which rung was chosen and what
 * sits below it rather than quietly discarding the answer.
 *
 * Left off (the default), only a stock-holding bin is reported — which is right for
 * every caller that genuinely needs one.
 */
export function LocationPicker({
  warehouseId,
  value,
  onChange,
  disabled,
  allowAnyLevel = false,
}: {
  warehouseId: number;
  value: number | "";
  onChange: (binId: number | "") => void;
  disabled?: boolean;
  /** Report whatever rung is chosen, not only a bin. See the note above. */
  allowAnyLevel?: boolean;
}) {
  const { data: tree = [], isLoading } = useQuery({
    queryKey: ["wh-bin-tree", warehouseId],
    queryFn: () => getBinTree(warehouseId),
  });

  /** The ids chosen so far, outermost first. The dropdowns are drawn from this. */
  const [path, setPath] = useState<number[]>([]);

  const index = useMemo(() => {
    const map = new Map<number, { node: Bin; parentId: number | null }>();
    const walk = (nodes: Bin[], parentId: number | null) => {
      for (const node of nodes) {
        map.set(node.id, { node, parentId });
        walk(node.children ?? [], node.id);
      }
    };
    walk(tree, null);
    return map;
  }, [tree]);

  // A location can also arrive from outside — a scan, a suggested-bin chip, the
  // task's own suggestion. When it does, the dropdowns jump to that location's
  // ancestry so the picker always shows where the current selection actually sits.
  useEffect(() => {
    if (value === "" || path[path.length - 1] === Number(value)) return;
    const chain: number[] = [];
    let cursor = index.get(Number(value));
    while (cursor) {
      chain.unshift(cursor.node.id);
      cursor = cursor.parentId == null ? undefined : index.get(cursor.parentId);
    }
    if (chain.length) setPath(chain);
  }, [value, index, path]);

  /** One row per level: the options at that depth, and what is chosen there. */
  const rows: { options: Bin[]; selected: number | "" }[] = [];
  let options = tree;
  for (let depth = 0; options.length > 0; depth += 1) {
    const chosen = path[depth];
    const node = chosen == null ? undefined : index.get(chosen)?.node;
    rows.push({ options, selected: node?.id ?? "" });
    if (!node) break;
    options = node.children ?? [];
  }

  /** Choosing at one level drops everything chosen below it. */
  const pick = (depth: number, raw: string) => {
    const next = raw ? [...path.slice(0, depth), Number(raw)] : path.slice(0, depth);
    setPath(next);
    const leaf = next.length ? index.get(next[next.length - 1])?.node : undefined;
    if (!leaf) return onChange("");
    onChange(allowAnyLevel || leaf.is_pickable ? leaf.id : "");
  };

  if (isLoading) return <div className="text-sm text-muted">Loading locations…</div>;
  if (tree.length === 0) {
    return (
      <div className="rounded-lg border border-line bg-content2 px-3 py-2 text-sm text-muted">
        This warehouse has no storage locations configured. Add them under Masters &gt;
        Locations, or stock it in bulk.
      </div>
    );
  }

  const chosen = path.length ? index.get(path[path.length - 1])?.node : undefined;
  const below = chosen?.children ?? [];
  const level = humanise(chosen?.bin_type ?? "location");

  return (
    <div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row, depth) => (
          <Field
            key={depth}
            // The level names itself from its storage type, so the labels read
            // Block / Floor / Lane rather than "Level 1".
            label={humanise(row.options[0]?.bin_type ?? `Level ${depth + 1}`)}
          >
            <Select
              value={row.selected}
              onChange={(id) => pick(depth, id)}
              isDisabled={disabled}
              placeholder="Choose…"
              options={row.options.map((node) => ({
                value: node.id,
                label: node.name && node.name !== node.code
                  ? `${node.code} — ${node.name}`
                  : node.code,
              }))}
            />
          </Field>
        ))}
      </div>

      {chosen && (
        <div className="mt-3 rounded-lg border border-line/70 bg-content2/50 px-3 py-2">
          {/* The whole walk, always. A bin code alone is not a place a person can be
            * sent to; the route to it is what somebody reads on the way there. */}
          <div className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs">
            <MapPin className="mr-0.5 h-3.5 w-3.5 shrink-0 text-brand" aria-hidden />
            {path.map((id, position) => {
              const node = index.get(id)?.node;
              const last = position === path.length - 1;
              return (
                <span key={id} className="flex items-center gap-1">
                  <span
                    className={last ? "font-mono font-semibold text-ink" : "font-mono text-muted"}
                    title={node?.name ?? undefined}
                  >
                    {node?.code ?? "?"}
                  </span>
                  {!last && <ChevronRight className="h-3 w-3 shrink-0 text-muted/60" aria-hidden />}
                </span>
              );
            })}
          </div>

          {/* What was actually chosen, in the warehouse's own vocabulary — and, when
            * it is not a bin, what would be one level further in. Neither a refusal
            * nor a silent acceptance: a statement the storekeeper can act on. */}
          <div className="mt-1.5 text-[11px] leading-5">
            {chosen.is_pickable ? (
              <span className="text-ok">
                Placing into <b>{level.toLowerCase()}</b> {chosen.name || chosen.code}.
              </span>
            ) : allowAnyLevel ? (
              <span className="text-ink">
                Placing at <b>{level.toLowerCase()}</b> level — the stock is recorded
                here, not in a bay below it.
                {below.length > 0 && (
                  <>
                    {" "}
                    <span className="text-muted">
                      <CornerDownRight className="mr-0.5 inline h-3 w-3" aria-hidden />
                      {below.length} {below.length === 1 ? "location" : "locations"} sit
                      inside it — choose one below if the goods go into a bay.
                    </span>
                  </>
                )}
              </span>
            ) : (
              <span className="text-warn">
                Keep going — a {level.toLowerCase()} does not hold stock here.
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
