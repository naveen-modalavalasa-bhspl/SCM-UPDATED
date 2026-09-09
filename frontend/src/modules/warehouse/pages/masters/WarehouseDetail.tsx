import {
  Button, Can, Card, ConfirmModal, ErrorBanner, Input, PageHeader, SubNav,
} from "@/shared/components";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Layers, PackageOpen, Pencil, Plus, Printer, Snowflake, Trash2,
} from "lucide-react";
import { MetaCard, MetaRow } from "../../components/DocumentMeta";
import { BinTree, flattenBins } from "../../components/BinTree";
import { LabelSheet, type LabelSpec } from "../../components/LabelPrint";
import { deleteBin, getBinTree, getWarehouse, listStorageTypes } from "../../api";
import { fmtQty } from "../../format";
import { byRung, parentTypesOf, typeOfLocation } from "../../storageTypes";
import type { Bin } from "../../types";
import { usePointLabel } from "../../usePointLabel";

/**
 * One warehouse: its details, the storage locations inside it, and the labels to stick
 * on the racks.
 *
 * Locations are created *into* the selected node, so building a rack is picking the
 * lane and adding — the old screen made you retype the parent path on every bin, which
 * is where the mismatched `path` values in the data came from.
 *
 * What a location may BE, and what it may sit inside, is the storage-type master
 * (Warehouse > Masters > Storage types). This screen reads it in two places: the
 * breakdown strip counts the tree by kind, and the panel beside the tree tells the
 * storekeeper what "Add under this" is about to offer — so the Add button is not a
 * door somebody walks through to find out.
 */

const TABS = [
  { key: "bins", label: "Storage locations" },
  { key: "labels", label: "Location labels" },
];

/** Every location matching the search, plus its ancestors, so a hit deep in the
 *  building stays reachable through the branches above it. */
function filterTree(rows: Bin[], term: string): Bin[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return rows;
  const walk = (nodes: Bin[]): Bin[] =>
    nodes.reduce<Bin[]>((kept, node) => {
      const children = walk(node.children ?? []);
      const hit =
        node.code.toLowerCase().includes(needle) ||
        (node.name ?? "").toLowerCase().includes(needle) ||
        (node.storage_type_name ?? "").toLowerCase().includes(needle);
      if (hit || children.length) kept.push({ ...node, children });
      return kept;
    }, []);
  return walk(rows);
}

export default function WarehouseDetail() {
  const label = usePointLabel();
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const warehouseId = Number(id);

  const [tab, setTab] = useState("bins");
  const [selected, setSelected] = useState<Bin | null>(null);
  const [removing, setRemoving] = useState<Bin | null>(null);
  const [search, setSearch] = useState("");

  const { data: warehouse, isLoading } = useQuery({
    queryKey: ["wh-warehouse", id],
    queryFn: () => getWarehouse(warehouseId),
  });

  const { data: bins = [], error } = useQuery({
    queryKey: ["wh-bins", id],
    queryFn: () => getBinTree(warehouseId),
    enabled: !!warehouse?.is_bin_managed,
  });

  const { data: storageTypes = [] } = useQuery({
    queryKey: ["wh-storage-types"],
    queryFn: listStorageTypes,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["wh-bins", id] });

  const removeBin = useMutation({
    mutationFn: (bin: Bin) => deleteBin(bin.id),
    onSuccess: () => {
      invalidate();
      setRemoving(null);
      setSelected(null);
    },
  });

  const flat = useMemo(() => flattenBins(bins), [bins]);
  const shown = useMemo(() => filterTree(bins, search), [bins, search]);

  /** The tree counted by kind, in rung order — 1 floor, 2 lanes, 6 racks, 12 bays.
   *  A bare "27 bins" on a building made of five different things says nothing. */
  const breakdown = useMemo(() => {
    const counts = new Map<number, number>();
    let unknown = 0;
    for (const row of flat) {
      const kind = typeOfLocation(row, storageTypes);
      if (!kind) { unknown += 1; continue; }
      counts.set(kind.id, (counts.get(kind.id) ?? 0) + 1);
    }
    const rows = byRung(storageTypes.filter((kind) => counts.has(kind.id)))
      .map((kind) => ({ kind, count: counts.get(kind.id) ?? 0 }));
    return { rows, unknown };
  }, [flat, storageTypes]);

  const holdingStock = flat.filter((row) => row.is_pickable).length;
  const coldChain = flat.filter((row) => row.temperature_controlled).length;

  const selectedKind = typeOfLocation(selected, storageTypes);
  /** What "Add under this" will offer once it opens. Said here so the button is not a
   *  door somebody walks through to find out it leads nowhere. */
  const childKinds = useMemo(
    () => (selectedKind
      ? byRung(storageTypes.filter(
          (kind) => kind.is_active && kind.parent_type_ids.includes(selectedKind.id)))
      : []),
    [selectedKind, storageTypes],
  );

  const labels: LabelSpec[] = flat
    .filter((b) => b.is_active)
    .map((b) => ({
      code: b.code,
      title: b.code,
      subtitle: b.name ?? warehouse?.name,
      kind: "barcode",
      meta: [
        { label: "Path", value: b.path ?? "—" },
        ...(b.storage_type_name ? [{ label: "Type", value: b.storage_type_name }] : []),
        ...(b.capacity_qty ? [{ label: "Capacity", value: fmtQty(b.capacity_qty) }] : []),
      ],
    }));

  const openAdd = (parent: Bin | null) =>
    nav(parent ? `bins/new?parent_id=${parent.id}` : "bins/new");

  if (isLoading) return <div className="py-16 text-center text-muted">Loading…</div>;
  if (!warehouse) return <div className="py-16 text-center text-muted">Warehouse not found.</div>;

  return (
    <div>
      <PageHeader
        eyebrow={`${label} master`}
        title={`${warehouse.code} — ${warehouse.name}`}
        actions={
          <>
            <Button variant="ghost" onClick={() => nav("/warehouse/masters/warehouses")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <Can do="master.location.manage">
              <Button onClick={() => nav("edit")}>
                <Pencil className="h-4 w-4" /> Edit
              </Button>
            </Can>
          </>
        }
      />

      <MetaCard title="Details">
        <MetaRow label="Type" value={warehouse.warehouse_type} />
        <MetaRow label="Facility" value={warehouse.facility_name} />
        <MetaRow label="Office" value={warehouse.office_name} />
        <MetaRow label="In charge" value={warehouse.incharge_name} />
        <MetaRow label="Storage" value={warehouse.is_bin_managed ? "Bin managed" : "Bulk"} />
        <MetaRow label="Status" value={warehouse.is_active ? "Active" : "Inactive"} />
        <MetaRow label="Locations" value={warehouse.is_bin_managed ? flat.length : "—"} />
        <MetaRow label="Address" value={warehouse.address} />
      </MetaCard>

      {!warehouse.is_bin_managed ? (
        <Card className="px-6 py-10 text-center text-sm text-muted">
          This is a bulk warehouse — stock is not tracked per location, so there is no
          tree. Turn on <span className="font-semibold text-body">Bin managed</span> to
          build one.
        </Card>
      ) : (
        <>
          <SubNav label="Warehouse detail" items={TABS} value={tab} onChange={setTab} />
          <ErrorBanner error={error} />

          {tab === "bins" ? (
            <>
              {/* What this building is actually made of, by kind. */}
              {flat.length > 0 && (
                <Card className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
                  {breakdown.rows.map(({ kind, count }) => (
                    <span key={kind.id} className="flex items-baseline gap-1.5">
                      <span className="font-display text-lg font-bold tabular text-ink">
                        {count}
                      </span>
                      <span className="text-xs text-muted">
                        {kind.name}
                        {count === 1 ? "" : "s"}
                      </span>
                    </span>
                  ))}
                  {breakdown.unknown > 0 && (
                    <span className="flex items-baseline gap-1.5">
                      <span className="font-display text-lg font-bold tabular text-warn">
                        {breakdown.unknown}
                      </span>
                      <span className="text-xs text-warn">of an unknown type</span>
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-4 text-xs text-muted">
                    <span className="flex items-center gap-1.5">
                      <PackageOpen className="h-3.5 w-3.5" />
                      {holdingStock} hold stock
                    </span>
                    {coldChain > 0 && (
                      <span className="flex items-center gap-1.5 text-info">
                        <Snowflake className="h-3.5 w-3.5" />
                        {coldChain} cold chain
                      </span>
                    )}
                  </span>
                </Card>
              )}

              <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_300px]">
                <Card className="p-4 sm:p-5">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h2 className="font-display text-base font-bold text-ink">
                      Storage locations
                    </h2>
                    <Can do="master.location.manage">
                      <div className="flex flex-wrap gap-2">
                        <Button variant="soft" onClick={() => openAdd(null)}>
                          <Plus className="h-4 w-4" /> Add top level
                        </Button>
                        <Button onClick={() => openAdd(selected)} disabled={!selected}>
                          <Plus className="h-4 w-4" />
                          {selected ? `Add under ${selected.code}` : "Add under…"}
                        </Button>
                      </div>
                    </Can>
                  </div>

                  {flat.length > 8 && (
                    <div className="mb-3">
                      <Input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Find a code, a name or a type"
                        aria-label="Search storage locations"
                      />
                    </div>
                  )}

                  <BinTree
                    bins={shown}
                    selectedId={selected?.id}
                    onSelect={setSelected}
                    empty={
                      search
                        ? "Nothing here matches that."
                        : "This warehouse has no storage locations yet. Add a top-level one to start."
                    }
                  />
                </Card>

                {/* The selected location, and what may be built under it. The buttons
                    above act on this row, so it says which row that is. */}
                <Card className="h-fit p-4">
                  {selected ? (
                    <>
                      <div className="text-[11px] text-muted">{selected.path ?? selected.code}</div>
                      <div className="mt-0.5 font-mono text-sm font-bold text-ink">
                        {selected.code}
                      </div>
                      <div className="text-sm text-body">{selected.name ?? "—"}</div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <span className="rounded-md bg-content2 px-2 py-0.5 text-[11px] font-medium text-body">
                          {selected.storage_type_name ?? selected.bin_type ?? "No type"}
                        </span>
                        {selected.is_pickable ? (
                          <span className="rounded-md bg-ok-bg px-2 py-0.5 text-[11px] font-medium text-ok">
                            Holds stock
                          </span>
                        ) : (
                          <span className="rounded-md bg-content2 px-2 py-0.5 text-[11px] font-medium text-muted">
                            Structure
                          </span>
                        )}
                        {selected.temperature_controlled && (
                          <span className="flex items-center gap-1 rounded-md bg-info-bg px-2 py-0.5 text-[11px] font-medium text-info">
                            <Snowflake className="h-3 w-3" /> Cold chain
                          </span>
                        )}
                      </div>

                      <dl className="mt-3 space-y-1.5 border-t border-line pt-3 text-xs">
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted">Inside this</dt>
                          <dd className="tabular text-ink">
                            {selected.children?.length ?? 0}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted">Volume</dt>
                          <dd className="tabular text-ink">
                            {fmtQty(selected.capacity_volume)}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted">Sits inside</dt>
                          <dd className="text-right text-ink">
                            {parentTypesOf(selectedKind, storageTypes)
                              .map((kind) => kind.name).join(", ") || "Top level"}
                          </dd>
                        </div>
                      </dl>

                      <div className="mt-3 rounded-lg bg-content2 px-2.5 py-2 text-[11px] leading-relaxed text-muted">
                        {childKinds.length ? (
                          <>
                            Add under this and it can be a{" "}
                            <span className="font-semibold text-body">
                              {childKinds.map((kind) => kind.name.toLowerCase()).join(", ")}
                            </span>
                            .
                          </>
                        ) : (
                          <>
                            Nothing is configured to sit inside a{" "}
                            {(selectedKind?.name ?? "location").toLowerCase()}. Set that
                            on Storage types.
                          </>
                        )}
                      </div>

                      <Can do="master.location.manage">
                        <div className="mt-3 flex gap-2">
                          <Button
                            variant="soft"
                            className="flex-1"
                            onClick={() => nav(`bins/${selected.id}/edit`)}
                          >
                            <Pencil className="h-4 w-4" /> Edit
                          </Button>
                          <Button variant="danger" onClick={() => setRemoving(selected)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </Can>
                    </>
                  ) : (
                    <div className="py-6 text-center">
                      <Layers className="mx-auto h-6 w-6 text-muted/60" />
                      <p className="mt-2 text-xs leading-relaxed text-muted">
                        Pick a location to see what it is, what sits inside it, and what
                        you may add under it.
                      </p>
                    </div>
                  )}
                </Card>
              </div>
            </>
          ) : (
            <Card className="p-4 sm:p-5">
              <div className="mb-3 flex items-center gap-2 text-sm text-muted">
                <Printer className="h-4 w-4" /> One label per active location, barcode
                encoded with its code.
              </div>
              <LabelSheet
                labels={labels}
                title="location labels"
                emptyHint="This warehouse has no active storage locations."
              />
            </Card>
          )}
        </>
      )}

      <ConfirmModal
        isOpen={!!removing}
        title={`Remove ${removing?.code ?? "location"}?`}
        message="A location that holds stock, or that has locations inside it, cannot be removed — deactivate it instead."
        confirmLabel="Remove location"
        danger
        busy={removeBin.isPending}
        error={removeBin.error}
        onConfirm={() => removing && removeBin.mutate(removing)}
        onClose={() => setRemoving(null)}
      />
    </div>
  );
}
