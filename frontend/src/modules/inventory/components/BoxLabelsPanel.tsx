import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useReactToPrint } from "react-to-print";
import { QRCodeSVG } from "qrcode.react";
import Barcode from "react-barcode";
import { Box, Check, CheckCheck, ChevronRight, Layers, Printer } from "lucide-react";
import { Button, Card, useToast } from "@/shared/components";
import { FilterBar, FilterSelect } from "./FilterBar";
import { LoadingRows } from "./PageStates";
import { getWarehouses, listBoxLabels, markBoxLabelsPrinted } from "../api";
import type { BoxLabelRow } from "../types";

/**
 * Box labels (2026-10-26) — the print queue of new box codes.
 *
 * 2026-10-27: every pack of a unit-tracked item gets a label — the carton AND each box
 * inside it — listed and printed parent first, children indented under it. A sticker
 * carries BOTH a Code128 barcode (the code, for a scanner gun) and a QR that opens the
 * pack's live details on any phone: the item, where it is now, what is inside it, its
 * batch, expiry and brand / variant / model. The QR holds a signed link, never the
 * details themselves, so a carton opened yesterday reads what is left in it today.
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
/** Where a label's QR points: the public, read-only live page for that pack. */
const qrUrl = (r: BoxLabelRow) =>
  r.qr_token ? `${window.location.origin}/c/${encodeURIComponent(r.qr_token)}` : r.hu_code;
const comboOf = (r: BoxLabelRow) =>
  [r.brand_name, r.variant_name, r.model_name].filter(Boolean).join(" · ");
/** A row and every row nested under it, in list order (the list is parent first). */
const familyOf = (rows: BoxLabelRow[], r: BoxLabelRow) => {
  const at = rows.indexOf(r);
  const out = [r];
  for (let i = at + 1; i < rows.length && (rows[i].depth ?? 0) > (r.depth ?? 0); i += 1) {
    out.push(rows[i]);
  }
  return out;
};
const qty = (v: number | string | null | undefined) =>
  num(v).toLocaleString("en-IN", { maximumFractionDigits: 3 });

export function BoxLabelsPanel({ size, dim, pageStyle }: {
  size: string;
  dim: { w: number; h: number; bar: number };
  pageStyle: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState("QUEUED");
  const [warehouseId, setWarehouseId] = useState("");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Record<number, boolean>>({});
  const [printed, setPrinted] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);

  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses"], queryFn: getWarehouses });
  const { data, isLoading } = useQuery({
    queryKey: ["box-labels", status, warehouseId, search],
    queryFn: () => listBoxLabels({ status, warehouse_id: warehouseId, search }),
  });
  const rows = data?.items ?? [];
  const selected = useMemo(() => rows.filter((r) => picked[r.id]), [rows, picked]);
  const allPicked = rows.length > 0 && rows.every((r) => picked[r.id]);

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
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const queuedPicked = selected.filter((r) => r.status === "QUEUED").length;

  return (
    <div>
      <FilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search box code, item or issue…"
        onClear={() => { setSearch(""); setWarehouseId(""); setStatus("QUEUED"); }}
        active={[search, warehouseId, status !== "QUEUED" ? status || "all" : ""].filter(Boolean).length}
      >
        <FilterSelect value={status} onChange={setStatus} placeholder="Status"
                      options={STATUSES} allowEmpty={false} />
        <FilterSelect value={warehouseId} onChange={setWarehouseId} placeholder="All warehouses"
                      options={warehouses.map((w) => ({ value: w.id, label: w.name }))} />
      </FilterBar>

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
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink">
              Box codes {data && <span className="font-normal text-muted">({data.total})</span>}
            </h2>
            <div className="flex items-center gap-3">
              {rows.length > 0 && (
                <button onClick={() => setPicked(allPicked ? {} : Object.fromEntries(rows.map((r) => [r.id, true])))}
                        className="text-xs font-medium text-brand hover:underline">
                  {allPicked ? "Clear all" : `Select all (${rows.length})`}
                </button>
              )}
            </div>
          </div>
          {isLoading ? (
            <LoadingRows rows={5} className="p-0" />
          ) : rows.length === 0 ? (
            <div className="grid place-items-center rounded-lg border border-dashed border-line px-4 py-10 text-center">
              <Box className="h-5 w-5 text-muted" aria-hidden />
              <p className="mt-2 text-sm text-muted">
                {status === "QUEUED" ? "Nothing waiting — every box code has its label." : "No box labels match."}
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
                        <span className="block truncate text-xs text-ink-700">{r.item_name}</span>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                          <span className={`rounded px-1.5 py-0.5 font-semibold ${reason.tone}`}>{reason.label}</span>
                          <span>
                            {r.pack_name ?? "Box"} · {qty(r.content_qty)}{part ? ` of ${qty(r.pack_size)}` : ""} {r.uom_code ?? ""}
                          </span>
                          {r.source_no && <span className="mono">· {r.source_no}</span>}
                        </span>
                        <span className="block truncate text-[11px] text-muted">
                          {[r.warehouse_name, r.bin_code, r.batch_no && `Batch ${r.batch_no}`].filter(Boolean).join(" · ")}
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
            <div className="flex gap-2">
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
                const small = dim.w <= 50;
                return (
                  <div key={r.id}
                       className="label flex flex-col overflow-hidden rounded border border-line bg-white p-1.5 text-black"
                       style={{ width: `${dim.w}mm`, height: `${dim.h}mm` }}>
                    <div className="flex min-h-0 flex-1 gap-1.5">
                      {/* The QR opens this pack's live details on any phone. */}
                      <QRCodeSVG value={qrUrl(r)} size={dim.bar * 2.4} level="M"
                                 className="block h-full max-h-full w-auto shrink-0" />
                      <div className="min-w-0 flex-1 leading-tight">
                        <div className={`truncate font-bold ${small ? "text-[6.5px]" : "text-[8px]"}`}>{r.item_name}</div>
                        <div className={`mt-0.5 space-y-[1px] ${small ? "text-[5px]" : "text-[6px]"}`}>
                          {[
                            ["Item", r.item_code],
                            [r.pack_name ?? "Pack", `${qty(r.content_qty)}${part ? ` of ${qty(r.pack_size)}` : ""} ${r.uom_code ?? ""}`],
                            ["Holds", r.packs_inside],
                            ["Batch", r.batch_no],
                            ["Expiry", r.expiry_date],
                            ["Brand", combo || null],
                            ["In", r.parent_code],
                          ].map(([label, value]) => (value ? (
                            <div key={label} className="flex gap-1 leading-none">
                              <span className="shrink-0 font-semibold uppercase">{label}</span>
                              <span className="truncate font-mono">{value}</span>
                            </div>
                          ) : null))}
                        </div>
                      </div>
                    </div>
                    {/* Code128 of the code itself, for a scanner gun, scaled to the label. */}
                    <div className="mt-0.5 flex h-[22%] w-full items-center justify-center overflow-hidden [&_svg]:h-full [&_svg]:max-w-full">
                      <Barcode value={r.hu_code} format="CODE128" width={1} height={40} margin={0}
                               displayValue={false} background="#ffffff" />
                    </div>
                    <div className="w-full truncate text-center font-mono text-[7px] font-bold leading-none">
                      {r.hu_code}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
