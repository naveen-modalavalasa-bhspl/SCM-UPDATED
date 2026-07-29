import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Switch } from "@heroui/react";
import { ArrowLeft, Pencil, Plus, Printer } from "lucide-react";
import { Button, Can, Card, Field, Input, PageHeader, Select, SubNav } from "@/shared/components";
import { ConfirmModal, ErrorBanner } from "../../components/Feedback";
import { MetaCard, MetaRow } from "../../components/DocumentMeta";
import { BinTree, flattenBins } from "../../components/BinTree";
import { LabelSheet, type LabelSpec } from "../../components/LabelPrint";
import { createBin, deleteBin, getBinTree, getWarehouse, updateBin } from "../../api";
import { fmtQty } from "../../format";
import type { Bin, BinWrite } from "../../types";

/**
 * One warehouse: its details, its bin tree, and the bin labels to stick on the racks.
 *
 * Bins are created *into* the selected node, so building a rack is picking the zone
 * and adding — the old screen made you retype the parent path on every bin, which is
 * where the mismatched `path` values in the data came from.
 */

const BIN_TYPES = [
  { value: "ZONE", label: "Zone" },
  { value: "RACK", label: "Rack" },
  { value: "SHELF", label: "Shelf" },
  { value: "STORAGE", label: "Storage bin" },
  { value: "STAGING", label: "Staging" },
  { value: "QUARANTINE", label: "Quarantine" },
  { value: "DAMAGE", label: "Damage" },
];

const TABS = [
  { key: "bins", label: "Bins" },
  { key: "labels", label: "Bin labels" },
];

export default function WarehouseDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const warehouseId = Number(id);

  const [tab, setTab] = useState("bins");
  const [selected, setSelected] = useState<Bin | null>(null);
  const [editing, setEditing] = useState<Bin | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Bin | null>(null);
  const [draft, setDraft] = useState<BinWrite | null>(null);

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

  const saveBin = useMutation({
    mutationFn: () => (editing ? updateBin(editing.id, draft!) : createBin(draft!)),
    onSuccess: () => {
      invalidate();
      setAdding(false);
      setEditing(null);
      setDraft(null);
    },
  });

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
    setEditing(null);
    setDraft({
      warehouse_id: warehouseId,
      code: "",
      name: "",
      parent_id: parent?.id ?? null,
      // A location hanging off another is a bin by default; a top-level one is a block.
      bin_type: parent ? "BIN" : "BLOCK",
      capacity_qty: null,
      is_active: true,
    });
    setAdding(true);
  };

  const openEdit = (bin: Bin) => {
    setAdding(false);
    setEditing(bin);
    setDraft({
      warehouse_id: warehouseId,
      code: bin.code,
      name: bin.name ?? "",
      parent_id: bin.parent_id ?? null,
      bin_type: bin.bin_type ?? "BIN",
      capacity_qty: bin.capacity_qty ?? null,
      is_active: bin.is_active,
    });
  };

  if (isLoading) return <div className="py-16 text-center text-muted">Loading…</div>;
  if (!warehouse) return <div className="py-16 text-center text-muted">Warehouse not found.</div>;

  return (
    <div>
      <PageHeader
        eyebrow="Warehouse master"
        title={`${warehouse.code} — ${warehouse.name}`}
        actions={
          <>
            <Button variant="ghost" onClick={() => nav("/warehouse/masters/warehouses")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <Can do="master.location.manage">
              <Button variant="subtle" onClick={() => nav("edit")}>
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
                    <Button variant="subtle" onClick={() => openAdd(null)}>
                      <Plus className="h-4 w-4" /> Add zone
                    </Button>
                    <Button onClick={() => openAdd(selected)} disabled={!selected}>
                      <Plus className="h-4 w-4" />
                      {selected ? `Add under ${selected.code}` : "Add under…"}
                    </Button>
                    <Button variant="subtle" onClick={() => selected && openEdit(selected)} disabled={!selected}>
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

      {/* Bin editor */}
      <Modal isOpen={adding || !!editing} onClose={() => { setAdding(false); setEditing(null); }} size="lg">
        <ModalContent>
          <ModalHeader className="font-display text-lg font-bold text-ink">
            {editing ? `Edit ${editing.code}` : "New bin"}
          </ModalHeader>
          <ModalBody>
            <ErrorBanner error={saveBin.error} />
            {draft && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Code">
                  <Input
                    value={draft.code}
                    onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })}
                    placeholder="A-01-03"
                  />
                </Field>
                <Field label="Name">
                  <Input
                    value={draft.name ?? ""}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    placeholder="Aisle A, rack 1, shelf 3"
                  />
                </Field>
                <Field label="Type">
                  <Select
                    value={draft.bin_type}
                    onChange={(v) => setDraft({ ...draft, bin_type: v || "STORAGE" })}
                    options={BIN_TYPES}
                    ariaLabel="Bin type"
                  />
                </Field>
                <Field label="Capacity" hint="In the item's own unit. Leave blank for no limit.">
                  <Input
                    type="number"
                    value={draft.capacity_qty == null ? "" : String(draft.capacity_qty)}
                    onChange={(e) =>
                      setDraft({ ...draft, capacity_qty: e.target.value === "" ? null : Number(e.target.value) })
                    }
                  />
                </Field>
                {/* Pickable is not a switch: stock lives in bins, so whether picking
                    may take from here follows from the type above. A flag that could
                    disagree with the type would just be a second, contradictory answer. */}
                <p className="text-xs text-muted">
                  {["BIN", "COLD_STORAGE_BIN"].includes(draft.bin_type)
                    ? "Picking may take stock from here."
                    : "Structure only — stock is held in the bins underneath this."}
                </p>
                <label className="flex items-center gap-3">
                  <Switch
                    isSelected={draft.is_active}
                    onValueChange={(v) => setDraft({ ...draft, is_active: v })}
                    aria-label="Active"
                  />
                  <span className="text-sm text-body">Active</span>
                </label>
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="subtle" onClick={() => { setAdding(false); setEditing(null); }}>Cancel</Button>
            <Button
              onClick={() => saveBin.mutate()}
              disabled={saveBin.isPending || !draft?.code.trim()}
            >
              {saveBin.isPending ? "Saving…" : "Save bin"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

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
