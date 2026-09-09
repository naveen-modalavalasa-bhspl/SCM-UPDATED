import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Boxes, ChevronDown, ChevronRight, PackageOpen, Snowflake, Thermometer,
} from "lucide-react";
import { Card, ErrorBanner, Input, Select, StatusPill } from "@/shared/components";
import { MetaGrid, MetaRow } from "../../components/DocumentMeta";
import { listLocations, listStorageTypes, warehouseOptions } from "../../api";
import { fmtQty } from "../../format";
import type { StorageType, WarehouseLocation } from "../../types";

/**
 * The storage locations of one warehouse, drawn as the tree they are.
 *
 * This was a flat table, which is what a list of `whs_warehouse_locations` rows looks
 * like if you forget that `parent_location_id` is the whole point: F1-A1-R1-B2 sorted
 * next to F1-A1-R1-B1 tells you nothing about which end of which floor either of them
 * is on, and the codes are near-identical by design. The nesting IS the floor plan.
 *
 * It is still not a drawing — the table carries no surveyed coordinates (`pos_x`,
 * `pos_y`, footprint), so an invented layout would look authoritative while being
 * fiction. If those columns are ever added, a plan view can sit beside this tree; the
 * data it would need is named here.
 *
 * Everything the panel on the right shows is served (`service.list_locations`): the
 * kind's name off the storage-type master, and the walk down to the location derived
 * from the parent links. A path worked out in the browser would disagree with the
 * server's the first time somebody re-parented a rack.
 */

type Node = WarehouseLocation & { children: Node[] };

/** Nest the flat rows. A row whose parent is missing is shown at the ROOT rather than
 *  dropped — invisible data is worse than misplaced data, the same rule `bin_tree`
 *  follows on the server. Only roots are walked, so a ring in the data cannot make the
 *  render recurse for ever; it simply has no root to be reached from. */
export function toTree(rows: WarehouseLocation[]): Node[] {
  const nodes = new Map<number, Node>(rows.map((row) => [row.id, { ...row, children: [] }]));
  const roots: Node[] = [];
  for (const node of nodes.values()) {
    const parent = node.parent_location_id ? nodes.get(node.parent_location_id) : undefined;
    (parent && parent.id !== node.id ? parent.children : roots).push(node);
  }
  const order = (list: Node[]) => {
    list.sort((a, b) => (a.level ?? 0) - (b.level ?? 0) || a.code.localeCompare(b.code));
    list.forEach((node) => order(node.children));
    return list;
  };
  return order(roots);
}

/** Every location matching the search, plus every ancestor of one, so a hit deep in
 *  the building is still reachable through the branches above it. */
function matching(rows: WarehouseLocation[], term: string): Set<number> | null {
  const needle = term.trim().toLowerCase();
  if (!needle) return null;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const keep = new Set<number>();
  for (const row of rows) {
    const hit =
      row.code.toLowerCase().includes(needle) ||
      (row.name ?? "").toLowerCase().includes(needle) ||
      (row.storage_type_name ?? "").toLowerCase().includes(needle);
    if (!hit) continue;
    let walk: WarehouseLocation | undefined = row;
    while (walk && !keep.has(walk.id)) {
      keep.add(walk.id);
      walk = walk.parent_location_id ? byId.get(walk.parent_location_id) : undefined;
    }
  }
  return keep;
}

function TreeNode({
  node, depth, selectedId, onSelect, visible, openState, setOpen,
}: {
  node: Node;
  depth: number;
  selectedId: number | null;
  onSelect: (row: WarehouseLocation) => void;
  visible: Set<number> | null;
  openState: Record<number, boolean>;
  setOpen: (id: number, open: boolean) => void;
}) {
  if (visible && !visible.has(node.id)) return null;
  const children = node.children.filter((child) => !visible || visible.has(child.id));
  const hasChildren = children.length > 0;
  // A search opens every branch it found; otherwise the top two rungs are open, which
  // is a floor and its lanes — enough to see the shape without scrolling the building.
  const open = visible ? true : openState[node.id] ?? depth < 1;
  const selected = selectedId === node.id;

  return (
    <div>
      <div
        className={`flex min-h-11 items-center gap-1.5 rounded-lg pr-2 transition-colors ${
          selected ? "bg-brand-050" : "hover:bg-content2"
        }`}
        style={{ paddingLeft: `${depth * 18 + 4}px` }}
      >
        <button
          type="button"
          onClick={() => setOpen(node.id, !open)}
          aria-label={hasChildren ? (open ? "Collapse" : "Expand") : "No locations inside"}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted disabled:opacity-30"
          disabled={!hasChildren}
        >
          {hasChildren
            ? open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />
            : <span className="h-4 w-4" />}
        </button>

        <button
          type="button"
          onClick={() => onSelect(node)}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
        >
          {node.is_pickable
            ? <PackageOpen className="h-4 w-4 shrink-0 text-muted" />
            : <Boxes className="h-4 w-4 shrink-0 text-muted" />}
          <span className="shrink-0 font-mono text-xs font-semibold text-ink">{node.code}</span>
          <span className="truncate text-xs text-muted">{node.name ?? ""}</span>
        </button>

        {node.temperature_controlled && (
          <Snowflake className="h-3.5 w-3.5 shrink-0 text-info" aria-label="Cold chain" />
        )}
        <span className="shrink-0 rounded-md bg-content2 px-1.5 py-0.5 text-[11px] font-medium text-muted">
          {node.storage_type_name ?? node.storage_type ?? "—"}
        </span>
        {!node.is_active && (
          <span className="shrink-0 text-[11px] font-semibold text-warn">Inactive</span>
        )}
      </div>

      {open && children.map((child) => (
        <TreeNode
          key={child.id}
          node={child}
          depth={depth + 1}
          selectedId={selectedId}
          onSelect={onSelect}
          visible={visible}
          openState={openState}
          setOpen={setOpen}
        />
      ))}
    </div>
  );
}

/** The walk down to a location, one crumb per rung. Read off `path`/`path_names`,
 *  which the server derives from the parent links — so what is drawn here and what the
 *  save enforces are the same ancestry. */
function Trail({ location }: { location: WarehouseLocation }) {
  const codes = (location.path ?? location.code).split(" / ");
  const names = (location.path_names ?? location.name ?? location.code).split(" / ");
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px]">
      {codes.map((code, index) => (
        <span key={`${code}-${index}`} className="flex items-center gap-1">
          {index > 0 && <span className="text-muted">/</span>}
          <span
            className={index === codes.length - 1 ? "font-semibold text-ink" : "text-muted"}
            title={names[index]}
          >
            {code}
          </span>
        </span>
      ))}
    </div>
  );
}

const cm = (value: number | null | undefined) =>
  value == null ? "—" : `${Number(value)} cm`;

/** A titled group inside the detail panel. Deliberately not `DocumentMeta.Section`,
 *  which is itself a Card — nesting cards three deep reads as clutter, and this panel
 *  is one card with several groups in it. */
function Block({ title, hint, children }: {
  title: string; hint?: string; children: React.ReactNode;
}) {
  return (
    <div className="mt-4 border-t border-line pt-3 first:mt-0 first:border-0 first:pt-0">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        {title}
      </div>
      {hint && <p className="mb-1.5 mt-0.5 text-[11px] text-muted">{hint}</p>}
      <div className="mt-2">{children}</div>
    </div>
  );
}

export default function FloorPlan() {
  const [warehouse, setWarehouse] = useState("");
  const [selected, setSelected] = useState<WarehouseLocation | null>(null);
  const [search, setSearch] = useState("");
  const [openState, setOpenState] = useState<Record<number, boolean>>({});

  const { data: houses = [] } = useQuery({
    queryKey: ["wh-lookup", "warehouses", ""],
    queryFn: () => warehouseOptions(),
    staleTime: 5 * 60_000,
  });

  const warehouseId = warehouse ? Number(warehouse) : houses[0]?.id;

  const { data: locations = [], isLoading, error } = useQuery({
    queryKey: ["wh-locations", warehouseId],
    queryFn: () => listLocations(warehouseId as number),
    enabled: !!warehouseId,
  });

  const { data: storageTypes = [] } = useQuery({
    queryKey: ["wh-storage-types"],
    queryFn: listStorageTypes,
  });
  const kind: StorageType | undefined = storageTypes.find(
    (row) => selected != null && row.id === Number(selected.storage_type_id),
  );

  const tree = useMemo(() => toTree(locations), [locations]);
  const visible = useMemo(() => matching(locations, search), [locations, search]);

  const setOpen = (id: number, open: boolean) =>
    setOpenState((held) => ({ ...held, [id]: open }));

  return (
    <div>
      <Card className="mb-4 p-3">
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="sm:w-80">
            <Select
              value={warehouse || String(warehouseId ?? "")}
              onChange={(value) => { setWarehouse(value); setSelected(null); }}
              ariaLabel="Warehouse"
              placeholder="Warehouse"
              options={houses.map((w) => ({
                value: w.id,
                label: w.code ? `${w.code} — ${w.name}` : w.name,
              }))}
            />
          </div>
          <div className="flex-1">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Find a code, a name or a type"
              aria-label="Search locations"
            />
          </div>
        </div>
      </Card>

      <ErrorBanner error={error} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
        <Card className="p-3">
          <div className="mb-2 flex items-baseline justify-between gap-2 px-1">
            <h2 className="font-display text-base font-bold text-ink">Storage locations</h2>
            <span className="text-[11px] text-muted">
              {locations.length} location{locations.length === 1 ? "" : "s"}
            </span>
          </div>
          {isLoading ? (
            <div className="py-16 text-center text-sm text-muted">Loading…</div>
          ) : tree.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted">
              This warehouse has no storage locations yet.
            </div>
          ) : (
            <div className="space-y-0.5">
              {tree.map((node) => (
                <TreeNode
                  key={node.id}
                  node={node}
                  depth={0}
                  selectedId={selected?.id ?? null}
                  onSelect={setSelected}
                  visible={visible}
                  openState={openState}
                  setOpen={setOpen}
                />
              ))}
            </div>
          )}
        </Card>

        <Card className="p-4">
          {selected ? (
            <>
              <div className="mb-3">
                <Trail location={selected} />
                <h2 className="mt-1 font-display text-base font-bold text-ink">
                  {selected.code}
                </h2>
                <div className="mt-0.5 flex flex-wrap items-center gap-2">
                  <span className="text-sm text-body">{selected.name ?? "—"}</span>
                  <StatusPill status={selected.is_active ? "APPROVED" : "CLOSED"} />
                </div>
              </div>

              <Block title="Where it sits">
                <MetaGrid columns={2}>
                  <MetaRow
                    label="Storage type"
                    value={selected.storage_type_name ?? selected.storage_type}
                  />
                  <MetaRow
                    label="Holds stock"
                    value={selected.is_pickable ? "Yes — picked from here" : "No — structure"}
                  />
                  <MetaRow
                    label="Sits inside"
                    value={
                      selected.parent_code
                        ? `${selected.parent_code}${
                            selected.parent_name && selected.parent_name !== selected.parent_code
                              ? ` — ${selected.parent_name}`
                              : ""
                          }`
                        : "Top level"
                    }
                  />
                  <MetaRow label="Depth" value={`Level ${selected.level ?? 1}`} />
                  <MetaRow
                    label="Inside this"
                    value={
                      selected.child_count
                        ? `${selected.child_count} location${selected.child_count === 1 ? "" : "s"}`
                        : "Nothing"
                    }
                  />
                  <MetaRow
                    label="Parent type"
                    value={kind?.parent_type_names.join(", ") || "Top level only"}
                  />
                </MetaGrid>
              </Block>

              <Block title="Identity">
                <MetaGrid columns={2}>
                  <MetaRow label="Barcode" value={selected.barcode} />
                  <MetaRow label="Floor level" value={selected.floor_level} />
                  <MetaRow label="Shelf level" value={selected.shelf_level} />
                  <MetaRow
                    label="Aisle width"
                    value={selected.aisle_width_meters ? `${selected.aisle_width_meters} m` : "—"}
                  />
                  <div className="col-span-2">
                    <MetaRow label="Description" value={selected.description} />
                  </div>
                </MetaGrid>
              </Block>

              <Block
                title="Capacity"
                hint="What a putaway into this location is checked against."
              >
                <MetaGrid columns={2}>
                  <MetaRow label="Volume" value={fmtQty(selected.capacity_volume)} />
                  <MetaRow label="Weight capacity" value={fmtQty(selected.capacity_weight)} />
                  <MetaRow
                    label="Maximum load"
                    value={
                      selected.max_weight_capacity
                        ? `${selected.max_weight_capacity} kg`
                        : "—"
                    }
                  />
                  <MetaRow
                    label="Handling units"
                    value={selected.max_handling_units ?? "—"}
                  />
                  <MetaRow
                    label="Usable share"
                    value={
                      selected.fill_efficiency_pct ? `${selected.fill_efficiency_pct}%` : "All of it"
                    }
                  />
                  <MetaRow
                    label="Opening"
                    value={
                      selected.length_cm && selected.width_cm && selected.height_cm
                        ? `${selected.length_cm} × ${selected.width_cm} × ${selected.height_cm} cm`
                        : "Not measured"
                    }
                  />
                  <MetaRow label="Height" value={cm(selected.height_cm)} />
                  <MetaRow label="Depth" value={cm(selected.length_cm)} />
                </MetaGrid>
              </Block>

              {selected.temperature_controlled && (
                <Block title="Cold chain">
                  <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-info">
                    <Thermometer className="h-3 w-3" /> Temperature controlled
                  </div>
                  <MetaGrid columns={2}>
                    <MetaRow
                      label="Target"
                      value={
                        selected.target_temperature_celsius != null
                          ? `${selected.target_temperature_celsius} °C`
                          : "—"
                      }
                    />
                    <MetaRow
                      label="Allowed band"
                      value={`${selected.min_temperature_celsius ?? "—"} °C to ${
                        selected.max_temperature_celsius ?? "—"
                      } °C`}
                    />
                    <MetaRow
                      label="Humidity"
                      value={
                        selected.humidity_percentage != null
                          ? `${selected.humidity_percentage}%`
                          : "—"
                      }
                    />
                  </MetaGrid>
                </Block>
              )}
            </>
          ) : (
            <p className="text-sm leading-relaxed text-muted">
              Pick a location in the tree to see everything about it — what kind it is,
              where it sits in the building, and what a putaway into it is checked
              against.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
