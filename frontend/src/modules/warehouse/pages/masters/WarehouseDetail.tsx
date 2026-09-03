import { Button, Can, Card, ConfirmModal, ErrorBanner, PageHeader, SubNav } from "@/shared/components";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Pencil, Plus, Printer } from "lucide-react";
import { MetaCard, MetaRow } from "../../components/DocumentMeta";
import { BinTree, flattenBins } from "../../components/BinTree";
import { LabelSheet, type LabelSpec } from "../../components/LabelPrint";
import { deleteBin, getBinTree, getWarehouse } from "../../api";
import { fmtQty } from "../../format";
import type { Bin } from "../../types";
import { usePointLabel } from "../../usePointLabel";

/**
 * One warehouse: its details, its bin tree, and the bin labels to stick on the racks.
 *
 * Bins are created *into* the selected node, so building a rack is picking the zone
 * and adding — the old screen made you retype the parent path on every bin, which is
 * where the mismatched `path` values in the data came from.
 */

const TABS = [
  { key: "bins", label: "Bins" },
  { key: "labels", label: "Bin labels" },
];

export default function WarehouseDetail() {
  const label = usePointLabel();
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const warehouseId = Number(id);

  const [tab, setTab] = useState("bins");
  const [selected, setSelected] = useState<Bin | null>(null);
  const [removing, setRemoving] = useState<Bin | null>(null);

  const { data: warehouse, isLoading } = useQuery({
    queryKey: ["wh-warehouse", id],
    queryFn: () => getWarehouse(warehouseId),
  });

  const { data: bins = [], error } = useQuery({
    queryKey: ["wh-bins", id],
    queryFn: () => getBinTree(warehouseId),
    enabled: !!warehouse?.is_bin_managed,
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

  const labels: LabelSpec[] = flat
    .filter((b) => b.is_active)
    .map((b) => ({
      code: b.code,
      title: b.code,
      subtitle: b.name ?? warehouse?.name,
      kind: "barcode",
      meta: [
        { label: "Path", value: b.path ?? "—" },
        ...(b.capacity_qty ? [{ label: "Capacity", value: fmtQty(b.capacity_qty) }] : []),
      ],
    }));

  const openAdd = (parent: Bin | null) => {
    if (parent) {
      nav(`bins/new?parent_id=${parent.id}`);
    } else {
      nav("bins/new");
    }
  };

  const openEdit = (bin: Bin) => {
    nav(`bins/${bin.id}/edit`);
  };

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
        <MetaRow label="Bins" value={warehouse.is_bin_managed ? flat.length : "—"} />
        <MetaRow label="Address" value={warehouse.address} />
      </MetaCard>

      {!warehouse.is_bin_managed ? (
        <Card className="px-6 py-10 text-center text-sm text-muted">
          This is a bulk warehouse — stock is not tracked per bin, so there is no bin tree.
          Turn on <span className="font-semibold text-body">Bin managed</span> to build one.
        </Card>
      ) : (
        <>
          <SubNav label="Warehouse detail" items={TABS} value={tab} onChange={setTab} />
          <ErrorBanner error={error} />

          {tab === "bins" ? (
            <Card className="p-4 sm:p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-display text-base font-bold text-ink">Bin tree</h2>
                <Can do="master.location.manage">
                  <div className="flex flex-wrap gap-2">
                    <Button variant="soft" onClick={() => openAdd(null)}>
                      <Plus className="h-4 w-4" /> Add zone
                    </Button>
                    <Button onClick={() => openAdd(selected)} disabled={!selected}>
                      <Plus className="h-4 w-4" />
                      {selected ? `Add under ${selected.code}` : "Add under…"}
                    </Button>
                    <Button variant="soft" onClick={() => selected && openEdit(selected)} disabled={!selected}>
                      <Pencil className="h-4 w-4" /> Edit
                    </Button>
                    <Button variant="danger" onClick={() => setRemoving(selected)} disabled={!selected}>
                      Remove
                    </Button>
                  </div>
                </Can>
              </div>

              <BinTree bins={bins} selectedId={selected?.id} onSelect={setSelected} />
            </Card>
          ) : (
            <Card className="p-4 sm:p-5">
              <div className="mb-3 flex items-center gap-2 text-sm text-muted">
                <Printer className="h-4 w-4" /> One label per active bin, barcode encoded with the bin code.
              </div>
              <LabelSheet labels={labels} title="bin labels" emptyHint="This warehouse has no active bins." />
            </Card>
          )}
        </>
      )}

      <ConfirmModal
        isOpen={!!removing}
        title={`Remove ${removing?.code ?? "bin"}?`}
        message="A bin that holds stock, or that has children, cannot be removed — deactivate it instead."
        confirmLabel="Remove bin"
        danger
        busy={removeBin.isPending}
        error={removeBin.error}
        onConfirm={() => removing && removeBin.mutate(removing)}
        onClose={() => setRemoving(null)}
      />
    </div>
  );
}
