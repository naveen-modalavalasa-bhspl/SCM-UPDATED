import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Checkbox, Chip } from "@heroui/react";
import { Package, Trash2 } from "lucide-react";
import { Button, Can, Card, Field, Input, PageHeader, Select, StatusPill } from "@/shared/components";
import { ErrorBanner } from "../components/Feedback";
import { Section } from "../components/DocumentMeta";
import { LabelSheet, type LabelSpec } from "../components/LabelPrint";
import { Lookup } from "../components/Lookup";
import { addPackage, deletePackage, getDispatch, listDispatches } from "../api";
import { fmtQty } from "../format";

/**
 * The packing bench: box a dispatch up and print the labels.
 *
 * Lines are assigned to a package as they are boxed, so `out_dispatch_items.
 * package_id` records which carton a given item actually went into — the thing an
 * "it arrived short" call needs and the thing the old screen, which printed one
 * label per dispatch, could never answer.
 *
 * Package labels are QR rather than linear barcode: they carry the package number
 * and the dispatch together, and a phone camera can read them off a carton.
 */

const PACKAGE_TYPES = [
  { value: "BOX", label: "Box" },
  { value: "CARTON", label: "Carton" },
  { value: "PALLET", label: "Pallet" },
  { value: "DRUM", label: "Drum" },
  { value: "CRATE", label: "Crate" },
  { value: "BAG", label: "Bag" },
];

export default function OutwardLabelling() {
  const qc = useQueryClient();
  const [dispatchId, setDispatchId] = useState<number | "">("");
  const [selected, setSelected] = useState<number[]>([]);
  const [draft, setDraft] = useState({
    package_type: "BOX",
    weight_kg: "",
    length_cm: "",
    width_cm: "",
    height_cm: "",
    is_fragile: false,
    is_temp_controlled: false,
  });

  const { data: doc, isLoading, error } = useQuery({
    queryKey: ["wh-dispatch", String(dispatchId)],
    queryFn: () => getDispatch(Number(dispatchId)),
    enabled: dispatchId !== "",
  });

  const pack = useMutation({
    mutationFn: () =>
      addPackage(Number(dispatchId), {
        package_type: draft.package_type,
        weight_kg: draft.weight_kg === "" ? null : Number(draft.weight_kg),
        length_cm: draft.length_cm === "" ? null : Number(draft.length_cm),
        width_cm: draft.width_cm === "" ? null : Number(draft.width_cm),
        height_cm: draft.height_cm === "" ? null : Number(draft.height_cm),
        is_fragile: draft.is_fragile,
        is_temp_controlled: draft.is_temp_controlled,
        item_ids: selected,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-dispatch", String(dispatchId)] });
      setSelected([]);
      setDraft((d) => ({ ...d, weight_kg: "", length_cm: "", width_cm: "", height_cm: "" }));
    },
  });

  const unpack = useMutation({
    mutationFn: (packageId: number) => deletePackage(Number(dispatchId), packageId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wh-dispatch", String(dispatchId)] }),
  });

  const packages = doc?.packages ?? [];
  const lines = doc?.items ?? [];
  const unpacked = lines.filter((l) => !l.package_id);

  const labels: LabelSpec[] = packages.map((p) => ({
    code: `${doc?.dispatch_no}|${p.package_no}`,
    title: p.package_no,
    subtitle: `${doc?.dispatch_no} → ${doc?.to_warehouse_name ?? doc?.customer_name ?? doc?.vendor_name ?? ""}`,
    kind: "qr",
    meta: [
      { label: "Type", value: p.package_type ?? "—" },
      { label: "Weight", value: p.weight_kg ? `${fmtQty(p.weight_kg)} kg` : "—" },
      ...(p.is_fragile ? [{ label: "Handling", value: "FRAGILE" }] : []),
      ...(p.is_temp_controlled ? [{ label: "Storage", value: "COLD CHAIN" }] : []),
    ],
  }));

  return (
    <div>
      <PageHeader eyebrow="Warehouse" title="Outward labelling" />

      <Card className="mb-4 p-3">
        <div className="max-w-md">
          <Lookup
            name="dispatches-open"
            load={async () => {
              const page = await listDispatches({ size: 100 });
              return page.items
                .filter((d) => ["APPROVED", "PACKED"].includes(d.status))
                .map((d) => ({
                  id: d.id,
                  code: d.dispatch_no,
                  name: d.to_warehouse_name ?? d.customer_name ?? d.vendor_name ?? "—",
                }));
            }}
            value={dispatchId}
            onChange={setDispatchId}
            placeholder="Pick a dispatch to pack"
          />
        </div>
      </Card>

      <ErrorBanner error={error ?? pack.error ?? unpack.error} />

      {dispatchId === "" ? (
        <Card className="px-6 py-14 text-center text-sm text-muted">
          Pick an approved dispatch above to start packing it.
        </Card>
      ) : isLoading ? (
        <div className="py-16 text-center text-muted">Loading…</div>
      ) : (
        <>
          <Section title={`${doc?.dispatch_no} — unpacked lines`} hint="Tick what goes in the next package.">
            {unpacked.length === 0 ? (
              <p className="text-sm text-ok">Everything on this dispatch is packed.</p>
            ) : (
              <ul className="space-y-2">
                {unpacked.map((l) => (
                  <li
                    key={l.id}
                    className="flex min-h-11 items-center gap-3 rounded-xl border border-line/70 bg-content1 px-3 py-2"
                  >
                    <Checkbox
                      isSelected={selected.includes(l.id)}
                      onValueChange={(on) =>
                        setSelected((s) => (on ? [...s, l.id] : s.filter((x) => x !== l.id)))
                      }
                      aria-label={`Select ${l.item_code ?? l.item_id}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-xs font-semibold text-ink">{l.item_code ?? "—"}</div>
                      <div className="truncate text-xs text-muted">{l.item_name ?? "—"}</div>
                    </div>
                    <span className="shrink-0 tabular text-sm text-ink">
                      {fmtQty(l.quantity)} {l.uom_code ?? ""}
                    </span>
                    {l.serial_no && (
                      <Chip size="sm" variant="flat" className="hidden sm:flex">{l.serial_no}</Chip>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section
            title="New package"
            actions={
              <Can do="issue.issue">
                <Button onClick={() => pack.mutate()} disabled={pack.isPending || selected.length === 0}>
                  <Package className="h-4 w-4" />
                  {pack.isPending ? "Packing…" : `Pack ${selected.length} line${selected.length === 1 ? "" : "s"}`}
                </Button>
              </Can>
            }
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Type">
                <Select
                  value={draft.package_type}
                  onChange={(v) => setDraft((d) => ({ ...d, package_type: v }))}
                  options={PACKAGE_TYPES}
                  ariaLabel="Package type"
                />
              </Field>
              <Field label="Weight (kg)">
                <Input type="number" value={draft.weight_kg}
                       onChange={(e) => setDraft((d) => ({ ...d, weight_kg: e.target.value }))} />
              </Field>
              <Field label="Length (cm)">
                <Input type="number" value={draft.length_cm}
                       onChange={(e) => setDraft((d) => ({ ...d, length_cm: e.target.value }))} />
              </Field>
              <Field label="Width (cm)">
                <Input type="number" value={draft.width_cm}
                       onChange={(e) => setDraft((d) => ({ ...d, width_cm: e.target.value }))} />
              </Field>
              <Field label="Height (cm)">
                <Input type="number" value={draft.height_cm}
                       onChange={(e) => setDraft((d) => ({ ...d, height_cm: e.target.value }))} />
              </Field>
              <label className="flex items-center gap-3 pt-6">
                <Checkbox
                  isSelected={draft.is_fragile}
                  onValueChange={(v) => setDraft((d) => ({ ...d, is_fragile: v }))}
                  aria-label="Fragile"
                />
                <span className="text-sm text-body">Fragile</span>
              </label>
              <label className="flex items-center gap-3 pt-6">
                <Checkbox
                  isSelected={draft.is_temp_controlled}
                  onValueChange={(v) => setDraft((d) => ({ ...d, is_temp_controlled: v }))}
                  aria-label="Temperature controlled"
                />
                <span className="text-sm text-body">Cold chain</span>
              </label>
            </div>
          </Section>

          <Section title={`Packages (${packages.length})`}>
            {packages.length === 0 ? (
              <p className="text-sm text-muted">Nothing packed yet.</p>
            ) : (
              <ul className="space-y-2">
                {packages.map((p) => {
                  const contents = lines.filter((l) => l.package_id === p.id);
                  return (
                    <li key={p.id} className="rounded-xl border border-line/70 bg-content1 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-ink">{p.package_no}</span>
                        <Chip size="sm" variant="flat">{p.package_type ?? "—"}</Chip>
                        {p.weight_kg && <Chip size="sm" variant="flat">{fmtQty(p.weight_kg)} kg</Chip>}
                        {p.is_fragile && <Chip size="sm" variant="flat" color="warning">Fragile</Chip>}
                        {p.is_temp_controlled && <Chip size="sm" variant="flat" color="primary">Cold chain</Chip>}
                        <StatusPill status={p.status} />
                        <span className="flex-1" />
                        <Can do="issue.issue">
                          <button
                            type="button"
                            aria-label={`Unpack ${p.package_no}`}
                            onClick={() => unpack.mutate(p.id)}
                            className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:text-bad"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </Can>
                      </div>
                      <div className="mt-2 text-xs text-muted">
                        {contents.length === 0
                          ? "Empty"
                          : contents.map((c) => `${c.item_code ?? c.item_id} × ${fmtQty(c.quantity)}`).join(", ")}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section title="Labels">
            <LabelSheet labels={labels} title="package labels" emptyHint="Pack something to get labels." />
          </Section>
        </>
      )}
    </div>
  );
}
