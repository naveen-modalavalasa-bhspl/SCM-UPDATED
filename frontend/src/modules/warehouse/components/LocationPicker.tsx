import { Select } from "./compat";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Field } from "@/shared/components";
import { getBinTree } from "../api";
import type { Bin } from "../types";
import { humanise } from "../format";

/**
 * Walk a warehouse's storage hierarchy one level at a time: block → floor → lane →
 * rack → shelf → bin, or whatever levels that warehouse was actually configured with.
 *
 * Nothing here is hardcoded to a fixed set of levels. The tree comes back nested from
 * `GET /warehouses/{id}/bins` and a dropdown is drawn for each level that has something
 * to choose from, so a three-level warehouse shows three dropdowns and a six-level one
 * shows six.
 *
 * `onChange` only ever reports a stock-holding location (`is_pickable`). Stopping half
 * way down at a rack clears it, because a rack is somewhere you walk past on the way to
 * a bin, not somewhere stock is counted.
 */
export function LocationPicker({
  warehouseId,
  value,
  onChange,
  disabled,
}: {
  warehouseId: number;
  value: number | "";
  onChange: (binId: number | "") => void;
  disabled?: boolean;
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

  // A bin can also arrive from outside — a scan, a suggested-bin chip, the task's own
  // suggestion. When it does, the dropdowns jump to that bin's ancestry so the picker
  // always shows where the current selection actually sits.
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
    onChange(leaf?.is_pickable ? leaf.id : "");
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

      {path.length > 0 && (
        <div className="mt-3 text-xs text-muted">
          <span className="font-mono text-ink">
            {path.map((id) => index.get(id)?.node.code ?? "?").join(" / ")}
          </span>
          {chosen && !chosen.is_pickable && (
            <span className="ml-2 text-warn">
              — keep going, {humanise(chosen.bin_type ?? "this").toLowerCase()} does not
              hold stock.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
