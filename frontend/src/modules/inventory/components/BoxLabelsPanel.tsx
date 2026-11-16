import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useReactToPrint } from "react-to-print";
import { LabelSticker } from "@/modules/warehouse/components/LabelSticker";
import { qrDetailsText, qrLink, type QrContent } from "@/modules/warehouse/docLabels";
import {
  Box, Boxes, Check, CheckCheck, ChevronRight, Layers, MapPin, Package, Printer, Search, Warehouse,
} from "lucide-react";
import { Button, Card, useToast } from "@/shared/components";
import { LoadingRows } from "./PageStates";
import { getBoxLabelFacets, getWarehouses, listBoxLabels, markBoxLabelsPrinted } from "../api";
import type { BoxLabelRow } from "../types";

/**
 * Box labels (2026-10-26) — the print queue of new box codes.
 *
 * 2026-10-27: every pack of a unit-tracked item gets a label — the carton AND each box
 * inside it — listed and printed parent first, children indented under it. A sticker
 * carries BOTH a Code128 barcode (the code, for a scanner gun) and a QR of the pack's
 * details: the item, where it is, what is inside it, its batch, expiry and brand /
 * variant / model.
 *
 * 2026-11-02: the QR carries those details AS TEXT by default, so any phone camera
 * shows them on scan (the signed live link is still one switch away — "Live link" —
 * for a carton whose contents change after printing). And the screen is a cascade:
 * warehouse, then item, then batch, then storage location, then the box codes there —
 * each step offering only what holds labels, with the count beside it
 * (`GET /box-labels/facets`). Batch and location are read off the PACK, so a box
 * moved to another bay is listed where it stands now.
 *
 * An item issued in a container is issued by the BOX, and every box code the system
 * makes lands here: boxed at putaway, old per-piece stock grouped into boxes by the
 * deployment script, a lot re-cut after its Issue container changed, and the part box
 * cut at the issue desk when only some of a box leaves. Pick them, print the sheet,
 * stick them on, mark them printed. A printed label stays listed under "Printed" so a
 * torn sticker can be reprinted.
 */

const REASON: Record<BoxLabelRow["reason"], { label: string; tone: string }> = {
  PUTAWAY: { label: "Putaway", tone: "bg-brand/10 text-brand" },
  CONVERTED: { label: "Old stock boxed", tone: "bg-info-bg text-info" },
  RECODED: { label: "Re-coded", tone: "bg-warn-bg text-warn" },
  PART_BOX: { label: "Part box issued", tone: "bg-content2 text-ink-700 ring-1 ring-line" },
};

const STATUSES = [
  { value: "QUEUED", label: "To print" },
  { value: "PRINTED", label: "Printed" },
  { value: "", label: "All" },
];

const num = (v: number | string | null | undefined) => Number(v ?? 0) || 0;
const qty = (v: number | string | null | undefined) =>
  num(v).toLocaleString("en-IN", { maximumFractionDigits: 3 });
const comboOf = (r: BoxLabelRow) =>
  [r.brand_name, r.variant_name, r.model_name].filter(Boolean).join(" · ");

/** What a label's QR carries: every detail as text (read by any phone camera), or
 *  the public, read-only live page for that pack. */
const qrValueOf = (r: BoxLabelRow, mode: QrContent) => {
  if (mode === "LINK" && r.qr_token) return qrLink(r.qr_token);
  const part = num(r.content_qty) < num(r.pack_size);
  const held = `${qty(r.content_qty)}${part ? ` of ${qty(r.pack_size)}` : ""} ${r.uom_code ?? ""}`.trim();
  return qrDetailsText(r.hu_code, [
    ["Type", `${r.pack_name ?? "Box"} (${held})`],
    ["Item", [r.item_code, r.item_name].filter(Boolean).join(" - ")],
    ["Brand", [r.brand_name, r.variant_name, r.model_name].filter(Boolean).join(" / ")],
    ["Batch", r.batch_no],
    ["Expiry", r.expiry_date],
    ["Holds", r.packs_inside],
    ["Inside", r.parent_code],
    ["Warehouse", r.warehouse_name],
    ["Location", r.bin_code],
    ["Source", r.source_no],
  ]);
};

const QR_KEY = "scm.boxLabels.qr";
const readQrMode = (): QrContent => {
  try {
    return window.localStorage.getItem(QR_KEY) === "LINK" ? "LINK" : "DETAILS";
  } catch {
    return "DETAILS";
  }
};

/** A row and every row nested under it, in list order (the list is parent first). */
const familyOf = (rows: BoxLabelRow[], r: BoxLabelRow) => {
  const at = rows.indexOf(r);
  const out = [r];
  for (let i = at + 1; i < rows.length && (rows[i].depth ?? 0) > (r.depth ?? 0); i += 1) {
    out.push(rows[i]);
  }
  return out;
};

export function BoxLabelsPanel({ size, dim, pageStyle }: {
  size: string;
  dim: { w: number; h: number; bar: number };
  pageStyle: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState("QUEUED");
  const [warehouseId, setWarehouseId] = useState("");
  const [itemId, setItemId] = useState("");
  const [batchId, setBatchId] = useState(""); // "" = every batch, "0" = no batch
  const [binId, setBinId] = useState(""); // "" = every location, "0" = none
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Record<number, boolean>>({});
  const [printed, setPrinted] = useState(false);
  const [qrMode, setQrModeState] = useState<QrContent>(readQrMode);
  const setQrMode = (v: QrContent) => {
    setQrModeState(v);
    try {
      window.localStorage.setItem(QR_KEY, v);
    } catch {
      // Storage blocked: the switch still works for this visit.
    }
  };
  const sheetRef = useRef<HTMLDivElement>(null);

  // Each step clears the ones after it, and the selection with them.
  const chooseWarehouse = (v: string) => {
    setWarehouseId(v); setItemId(""); setBatchId(""); setBinId(""); setPicked({});
  };
  const chooseItem = (v: string) => { setItemId(v); setBatchId(""); setBinId(""); setPicked({}); };
  const chooseBatch = (v: string) => { setBatchId(v); setBinId(""); setPicked({}); };
  const chooseBin = (v: string) => { setBinId(v); setPicked({}); };
  const chooseStatus = (v: string) => {
    setStatus(v); setItemId(""); setBatchId(""); setBinId(""); setPicked({});
  };

  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses"], queryFn: getWarehouses });
  const facets = useQuery({
    queryKey: ["box-label-facets", status, warehouseId, itemId, batchId],
    queryFn: () => getBoxLabelFacets({ warehouse_id: warehouseId, status, item_id: itemId, batch_id: batchId }),
    enabled: !!warehouseId,
    placeholderData: keepPreviousData,
  });
  const items = useMemo(() => (warehouseId ? facets.data?.items ?? [] : []), [warehouseId, facets.data]);
  const batches = useMemo(() => (itemId ? facets.data?.batches ?? [] : []), [itemId, facets.data]);
  const locations = useMemo(() => (itemId ? facets.data?.locations ?? [] : []), [itemId, facets.data]);

  // A step with exactly one answer is answered for the storekeeper.
  useEffect(() => {
    if (warehouseId && !itemId && !facets.isPlaceholderData && items.length === 1) {
      setItemId(String(items[0].item_id));
    }
  }, [warehouseId, itemId, items, facets.isPlaceholderData]);
  useEffect(() => {
    if (itemId && batchId === "" && !facets.isPlaceholderData && batches.length === 1) {
      setBatchId(String(batches[0].batch_id));
    }
  }, [itemId, batchId, batches, facets.isPlaceholderData]);
  useEffect(() => {
    if (itemId && binId === "" && !facets.isPlaceholderData && locations.length === 1) {
      setBinId(String(locations[0].bin_id));
    }
  }, [itemId, binId, locations, facets.isPlaceholderData]);

  const ready = !!warehouseId && !!itemId;
  const { data, isLoading } = useQuery({
    queryKey: ["box-labels", status, warehouseId, itemId, batchId, binId, search],
    queryFn: () => listBoxLabels({
      status, warehouse_id: warehouseId, item_id: itemId, batch_id: batchId, bin_id: binId, search,
    }),
    enabled: ready,
  });
  const rows = useMemo(() => (ready ? data?.items ?? [] : []), [ready, data]);
  const selected = useMemo(() => rows.filter((r) => picked[r.id]), [rows, picked]);
  const allPicked = rows.length > 0 && rows.every((r) => picked[r.id]);
  const chosenItem = items.find((i) => String(i.item_id) === itemId);
  const total = (list: { count: number }[]) => list.reduce((a, b) => a + b.count, 0);

  const print = useReactToPrint({
    content: () => sheetRef.current,
    documentTitle: `box-labels-${new Date().toISOString().slice(0, 10)}`,
    pageStyle,
    onAfterPrint: () => setPrinted(true),
  });

  const done = useMutation({
    mutationFn: () => markBoxLabelsPrinted(selected.filter((r) => r.status === "QUEUED").map((r) => r.id)),
    onSuccess: (out) => {
      toast.success(`${out.printed} label${out.printed === 1 ? "" : "s"} marked printed`);
      setPicked({});
      setPrinted(false);
      void qc.invalidateQueries({ queryKey: ["box-labels"] });
      void qc.invalidateQueries({ queryKey: ["box-label-facets"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const queuedPicked = selected.filter((r) => r.status === "QUEUED").length;

  return (
    <div>
      <Card className="mb-4 p-3 sm:p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex rounded-lg bg-content2 p-0.5" role="tablist" aria-label="Label status">
            {STATUSES.map((st) => (
              <button key={st.value || "all"} type="button" role="tab" aria-selected={status === st.value}
                      onClick={() => chooseStatus(st.value)}
                      className={`min-h-9 rounded-md px-3 text-xs font-semibold transition ${
                        status === st.value ? "bg-content1 text-ink shadow-sm" : "text-muted hover:text-ink"}`}>
                {st.label}
              </button>
            ))}
          </div>
          {(warehouseId || search) && (
            <button type="button" className="min-h-9 text-xs font-medium text-brand hover:underline"
                    onClick={() => { chooseWarehouse(""); setSearch(""); }}>
              Start over
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Step n={1} icon={<Warehouse className="h-3.5 w-3.5" />} label="Warehouse" done={!!warehouseId}>
            <StepSelect value={warehouseId} onChange={chooseWarehouse} placeholder="Choose a warehouse"
                        options={warehouses.map((w) => ({ value: String(w.id), label: w.name }))} />
          </Step>
          <Step n={2} icon={<Package className="h-3.5 w-3.5" />} label="Item" done={!!itemId}
                disabled={!warehouseId}>
            <StepSelect
              value={itemId} onChange={chooseItem} disabled={!warehouseId}
              placeholder={!warehouseId ? "Pick the warehouse first"
                : facets.isFetching && !items.length ? "Reading…"
                  : items.length ? `Choose an item (${items.length})` : "No box labels here"}
              options={items.map((i) => ({
                value: String(i.item_id),
                label: `${i.item_name ?? i.item_code ?? `Item ${i.item_id}`}${i.item_code ? ` · ${i.item_code}` : ""} (${i.count})`,
              }))} />
          </Step>
          <Step n={3} icon={<Boxes className="h-3.5 w-3.5" />} label="Batch"
                done={!!itemId && batchId !== ""} disabled={!itemId}>
            <StepSelect
              value={batchId} onChange={chooseBatch} disabled={!itemId} allowEmpty
              placeholder={!itemId ? "Pick the item first" : `Every batch (${total(batches)})`}
              options={batches.map((b) => ({
                value: String(b.batch_id),
                label: `${b.batch_id ? b.batch_no ?? `Batch ${b.batch_id}` : "No batch"}${
                  b.expiry_date ? ` · exp ${b.expiry_date}` : ""} (${b.count})`,
              }))} />
          </Step>
          <Step n={4} icon={<MapPin className="h-3.5 w-3.5" />} label="Storage location"
                done={!!itemId && binId !== ""} disabled={!itemId}>
            <StepSelect
              value={binId} onChange={chooseBin} disabled={!itemId} allowEmpty
              placeholder={!itemId ? "Pick the item first" : `Every location (${total(locations)})`}
              options={locations.map((l) => ({
                value: String(l.bin_id),
                label: `${l.bin_id ? l.bin_code ?? `Location ${l.bin_id}` : "No location"}${
                  l.bin_name && l.bin_name !== l.bin_code ? ` · ${l.bin_name}` : ""} (${l.count})`,
              }))} />
          </Step>
        </div>

        {ready && (
          <label className="relative mt-3 block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
            <input value={search} onChange={(e) => setSearch(e.target.value)}
                   placeholder="Find a box code or issue no. in this list…" aria-label="Search box codes"
                   className="h-11 w-full rounded-lg border border-line bg-content1 pl-9 pr-3 text-sm outline-none focus:border-brand" />
          </label>
        )}
      </Card>

      {printed && queuedPicked > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ok/30 bg-ok/5 px-4 py-3">
          <span className="text-sm text-ink">
            Stuck them on? Mark the <b>{queuedPicked}</b> label{queuedPicked === 1 ? "" : "s"} as printed
            so they leave the queue.
          </span>
          <Button onClick={() => done.mutate()} disabled={done.isPending}>
            <CheckCheck className="h-4 w-4" /> Mark printed
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,440px)_1fr]">
        <Card className="p-3">
          <div className="mb-2 flex items-start justify-between gap-2">
            <h2 className="min-w-0 text-sm font-semibold text-ink">
              Box codes {ready && data && <span className="font-normal text-muted">({data.total})</span>}
              {ready && chosenItem && (
                <span className="block truncate text-xs font-normal text-muted">
                  {chosenItem.item_name}{chosenItem.item_code ? ` · ${chosenItem.item_code}` : ""}
                </span>
              )}
            </h2>
            {rows.length > 0 && (
              <button onClick={() => setPicked(allPicked ? {} : Object.fromEntries(rows.map((r) => [r.id, true])))}
                      className="min-h-9 shrink-0 text-xs font-medium text-brand hover:underline">
                {allPicked ? "Clear all" : `Select all (${rows.length})`}
              </button>
            )}
          </div>
          {!ready ? (
            <div className="grid place-items-center rounded-lg border border-dashed border-line px-4 py-10 text-center">
              <Box className="h-5 w-5 text-muted" aria-hidden />
              <p className="mt-2 max-w-xs text-sm text-muted">
                {!warehouseId
                  ? "Choose a warehouse, then an item — its box codes appear here."
                  : "Choose an item, then narrow by batch and storage location if you need to."}
              </p>
            </div>
          ) : isLoading ? (
            <LoadingRows rows={5} className="p-0" />
          ) : rows.length === 0 ? (
            <div className="grid place-items-center rounded-lg border border-dashed border-line px-4 py-10 text-center">
              <Box className="h-5 w-5 text-muted" aria-hidden />
              <p className="mt-2 text-sm text-muted">
                {status === "QUEUED" ? "Nothing waiting here — every box code has its label." : "No box labels match."}
              </p>
            </div>
          ) : (
            <ul className="max-h-[560px] space-y-1 overflow-y-auto">
              {rows.map((r) => {
                const on = !!picked[r.id];
                const reason = REASON[r.reason] ?? REASON.PUTAWAY;
                const part = num(r.content_qty) < num(r.pack_size);
                const depth = Math.min(r.depth ?? 0, 4);
                const family = familyOf(rows, r);
                return (
                  <li key={r.id} style={{ paddingLeft: `${depth * 18}px` }} className="relative">
                    {depth > 0 && (
                      <ChevronRight className="absolute top-3.5 h-3.5 w-3.5 text-muted"
                                    style={{ left: `${depth * 18 - 15}px` }} aria-hidden />
                    )}
                    <button
                      onClick={() => setPicked((p) => {
                        const next = { ...p };
                        for (const x of family) next[x.id] = !on;
                        return next;
                      })}
                      title={family.length > 1
                        ? `Picks this ${r.pack_name ?? "pack"} and the ${family.length - 1} inside it` : undefined}
                      className={`flex min-h-11 w-full items-start gap-3 rounded-lg border px-3 py-2 text-left ${
                        on ? "border-brand bg-brand/5" : "border-line/70 hover:bg-content2"}`}
                    >
                      <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                        on ? "border-brand bg-brand text-white" : "border-line"}`}>
                        {on && <Check size={13} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="mono truncate text-[13px] font-semibold text-ink" title={r.hu_code}>{r.hu_code}</span>
                          {r.status === "PRINTED" && (
                            <span className="shrink-0 rounded bg-ok/10 px-1.5 text-[10px] font-semibold text-ok">Printed</span>
                          )}
                        </span>
                        {r.packs_inside && (
                          <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-brand">
                            <Layers className="h-3 w-3" aria-hidden /> holds {r.packs_inside}
                          </span>
                        )}
                        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                          <span className={`rounded px-1.5 py-0.5 font-semibold ${reason.tone}`}>{reason.label}</span>
                          <span>
                            {r.pack_name ?? "Box"} · {qty(r.content_qty)}{part ? ` of ${qty(r.pack_size)}` : ""} {r.uom_code ?? ""}
                          </span>
                          {r.source_no && <span className="mono">· {r.source_no}</span>}
                        </span>
                        <span className="block truncate text-[11px] text-muted">
                          {[r.bin_code && `At ${r.bin_code}`, r.batch_no && `Batch ${r.batch_no}`,
                            r.expiry_date && `Exp ${r.expiry_date}`].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink">
              Preview {selected.length > 0 && <span className="text-muted">({selected.length} stickers · {size} mm)</span>}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-0.5 rounded-lg bg-content2 p-0.5 text-xs" role="group"
                   aria-label="What the QR shows when scanned">
                <span className="px-2 text-muted">QR shows</span>
                {([["DETAILS", "All details"], ["LINK", "Live link"]] as const).map(([v, l]) => (
                  <button key={v} type="button" onClick={() => setQrMode(v)} aria-pressed={qrMode === v}
                          className={`min-h-9 rounded-md px-2.5 font-semibold ${
                            qrMode === v ? "bg-content1 text-ink shadow-sm" : "text-muted hover:text-ink"}`}>
                    {l}
                  </button>
                ))}
              </div>
              {queuedPicked > 0 && !printed && (
                <Button variant="ghost" onClick={() => done.mutate()} disabled={done.isPending}>
                  <CheckCheck className="h-4 w-4" /> Mark printed
                </Button>
              )}
              <Button disabled={selected.length === 0} onClick={() => print?.()}>
                <Printer className="h-4 w-4" /> Print {selected.length || ""} label{selected.length === 1 ? "" : "s"}
              </Button>
            </div>
          </div>
          {selected.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line p-8 text-center text-sm text-muted">
              Pick box codes on the left to build a label sheet.
            </p>
          ) : (
            <div ref={sheetRef} className="flex flex-wrap gap-2">
              {selected.map((r) => {
                const part = num(r.content_qty) < num(r.pack_size);
                const combo = comboOf(r);
                // The one sticker drawing, shared with the issue / receipt labels: a QR of
                // this pack's details, and a Code128 of the code for a scanner gun.
                return (
                  <LabelSticker key={r.id} className="label" code={r.hu_code} qrValue={qrValueOf(r, qrMode)}
                                title={r.item_name} w={dim.w} h={dim.h}
                                rows={[
                                  ["Item", r.item_code],
                                  [r.pack_name ?? "Pack", `${qty(r.content_qty)}${part ? ` of ${qty(r.pack_size)}` : ""} ${r.uom_code ?? ""}`],
                                  ["Holds", r.packs_inside],
                                  ["Batch", r.batch_no],
                                  ["Expiry", r.expiry_date],
                                  ["Brand", combo || null],
                                  ["In", r.parent_code],
                                  ["At", r.bin_code],
                                ]} />
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

/** One numbered step of the cascade: greyed until the step before it is answered. */
function Step({ n, icon, label, done, disabled, children }: {
  n: number; icon: ReactNode; label: string; done: boolean; disabled?: boolean; children: ReactNode;
}) {
  return (
    <div className={disabled ? "opacity-60" : undefined}>
      <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-ink-700">
        <span className={`grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold ${
          done ? "bg-brand text-white" : "bg-content2 text-muted ring-1 ring-line"}`}>
          {done ? <Check size={11} /> : n}
        </span>
        <span className="text-muted" aria-hidden>{icon}</span>
        {label}
      </div>
      {children}
    </div>
  );
}

function StepSelect({ value, onChange, options, placeholder, disabled, allowEmpty }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
  placeholder: string; disabled?: boolean; allowEmpty?: boolean;
}) {
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-label={placeholder}
            className="h-11 w-full truncate rounded-lg border border-line bg-content1 px-2.5 text-sm text-ink outline-none focus:border-brand disabled:cursor-not-allowed">
      <option value="" disabled={!allowEmpty}>{placeholder}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
