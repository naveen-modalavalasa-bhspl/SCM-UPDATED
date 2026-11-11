import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, CalendarX, Check, CheckCircle2, ClipboardList, Layers, MapPin,
  MoreHorizontal, PackageX, Plus, Search, ShieldAlert, StickyNote, Tag, Trash2,
  TrendingDown, XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  Button, Card, ErrorBanner, Field, Input, PageHeader, Select,
} from "@/shared/components";
import { alerts } from "@/modules/alerts";
import { claimError, isAnnouncedGlobally } from "@/shared/api/errors";
import {
  createStockAdjustment, getAuditItems, getAuditLots, getAuditSources, getWarehouses,
} from "../api";
import { WriteOffPicker } from "../components/WriteOffPicker";
import { fmt } from "../auditPick";
import type { AuditItemOption, AuditLot, AuditMode, StockAdjustment } from "../types";

/**
 * New stock audit — a full document form (2026-10-31).
 *
 * A stock audit only ever takes stock OFF. Each line is one batch at one location:
 * the system figure, what was counted, and the shortfall between them. A count above
 * the system figure is refused (the server refuses it too); stock that turns up comes
 * in on a goods receipt. Where the lot carries codes, the write-off names exactly
 * what left — serials / IMEIs one by one, or whole packs plus unit codes — through
 * `WriteOffPicker`. Every audit with a shortfall waits for approval.
 */

const REASONS: { value: string; label: string; hint: string; icon: LucideIcon }[] = [
  { value: "CYCLE_COUNT", label: "Count shortfall", hint: "Periodic count found less on the shelf", icon: ClipboardList },
  { value: "SHORTAGE", label: "Missing", hint: "Lost or unaccounted for", icon: PackageX },
  { value: "DAMAGE", label: "Damaged", hint: "Broken, dented or defective", icon: ShieldAlert },
  { value: "EXPIRY", label: "Expired", hint: "Past shelf life or spoiled", icon: CalendarX },
  { value: "QUALITY_REJECTION", label: "Quality rejected", hint: "Failed a quality check", icon: XCircle },
  { value: "OTHER", label: "Other write-off", hint: "Explain in the remarks", icon: MoreHorizontal },
];

const TRACKING_LABEL: Record<string, string> = {
  SERIAL: "Serial", IMEI: "IMEI", ASSET: "Asset code", CONSUMABLE: "Code", NONE: "By count",
};

interface Draft {
  key: string;
  item: AuditItemOption;
  lot: AuditLot;
  counted: string;
  codes: string[];
  /** What the picked codes cover. */
  picked: number;
  note: string;
  showNote: boolean;
}

type LineState = "uncounted" | "over" | "invalid" | "match" | "needs-codes" | "ready";

function lineOf(d: Draft) {
  const raw = d.counted.trim();
  const counted = Number(raw);
  const system = d.lot.system_qty;
  const coded = d.lot.mode !== "QUANTITY";
  if (raw === "" || Number.isNaN(counted)) return { state: "uncounted" as LineState, shortfall: 0 };
  if (counted < 0) return { state: "invalid" as LineState, shortfall: 0 };
  if (coded && !Number.isInteger(counted)) return { state: "invalid" as LineState, shortfall: 0 };
  if (counted > system + 1e-9) return { state: "over" as LineState, shortfall: 0 };
  const shortfall = Number((system - counted).toFixed(3));
  if (shortfall === 0) return { state: "match" as LineState, shortfall };
  if (coded && Math.abs(d.picked - shortfall) > 1e-9) return { state: "needs-codes" as LineState, shortfall };
  return { state: "ready" as LineState, shortfall };
}

/** "Alpha · 24-inch · M1", or "No brand" for stock booked before brands were. */
const comboLabel = (lot: AuditLot) =>
  [lot.brand_name, lot.variant_name, lot.model_name].filter(Boolean).join(" · ")
  || (lot.brand_id ? `Brand #${lot.brand_id}` : "No brand");

/** One balance: item, batch, location AND brand / variant / model (2026-10-31). */
const lotKey = (itemId: number, lot: AuditLot) =>
  `${itemId}:${lot.batch_id}:${lot.bin_id}:${lot.brand_id}:${lot.variant_id}:${lot.model_id}`;

/** The physical shelf spot — units and packs carry no brand, so brands share these. */
const spotKey = (itemId: number, lot: AuditLot) => `${itemId}:${lot.batch_id}:${lot.bin_id}`;

const lotLabel = (lot: AuditLot) => [
  lot.batch_no ? `Batch ${lot.batch_no}` : "No batch",
  lot.bin_code ?? "No location",
  comboLabel(lot),
].join(" · ");

const BrandChip = ({ lot }: { lot: AuditLot }) => (
  <span className={`inline-flex max-w-full items-center gap-1 truncate rounded-full px-2 py-0.5 text-[10px] font-semibold ${
    lot.brand_id ? "bg-brand/10 text-brand" : "bg-content2 text-muted"}`} title={comboLabel(lot)}>
    <Tag className="h-3 w-3 shrink-0" />{comboLabel(lot)}
  </span>
);

const ModeBadge = ({ mode, tracking }: { mode: AuditMode; tracking: string }) => (
  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
    mode === "QUANTITY" ? "bg-content2 text-muted" : "bg-info-bg text-info"}`}>
    {mode === "QUANTITY" ? <Layers className="h-3 w-3" /> : <Tag className="h-3 w-3" />}
    {TRACKING_LABEL[tracking] ?? tracking}
  </span>
);

const COLS = "md:grid-cols-[2rem_minmax(13rem,2fr)_minmax(10rem,1.2fr)_5.5rem_7.5rem_6rem_minmax(11rem,1.3fr)_2.75rem]";

export default function StockAuditFormPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [warehouseId, setWarehouseId] = useState("");
  const [reason, setReason] = useState("CYCLE_COUNT");
  const [remarks, setRemarks] = useState("");
  const [lines, setLines] = useState<Draft[]>([]);
  const [pickerKey, setPickerKey] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses"], queryFn: getWarehouses });
  const wh = Number(warehouseId) || 0;

  const patch = (key: string, change: Partial<Draft>) =>
    setLines((cur) => cur.map((l) => (l.key === key ? { ...l, ...change } : l)));

  const addLots = (item: AuditItemOption, lots: AuditLot[]) => setLines((cur) => {
    const have = new Set(cur.map((l) => l.key));
    const fresh = lots
      .map((lot) => ({ key: lotKey(item.item_id, lot), lot }))
      .filter(({ key }) => !have.has(key))
      .map(({ key, lot }) => ({ key, item, lot, counted: "", codes: [], picked: 0, note: "", showNote: false }));
    return [...cur, ...fresh];
  });

  const states = lines.map((l) => ({ line: l, ...lineOf(l) }));
  const counted = states.filter((s) => s.state !== "uncounted");
  const short = states.filter((s) => s.shortfall > 0 && s.state !== "over" && s.state !== "invalid");
  const unitsOff = short.reduce((sum, s) => sum + s.shortfall, 0);
  const needCodes = states.filter((s) => s.state === "needs-codes");
  const problems = states.filter((s) => s.state === "over" || s.state === "invalid");
  const uncounted = states.filter((s) => s.state === "uncounted");
  const blockers = [
    !wh && "Choose the warehouse being audited.",
    !lines.length && "Add at least one item to count.",
    uncounted.length > 0 && `Count ${uncounted.length} line${uncounted.length === 1 ? "" : "s"}, or remove ${uncounted.length === 1 ? "it" : "them"}.`,
    problems.length > 0 && `${problems.length} count${problems.length === 1 ? " is" : "s are"} above the system figure or not a valid number.`,
    needCodes.length > 0 && `Pick the codes for ${needCodes.length} write-off${needCodes.length === 1 ? "" : "s"}.`,
  ].filter(Boolean) as string[];
  const ready = blockers.length === 0;

  const submit = useMutation({
    mutationFn: () => createStockAdjustment({
      warehouse_id: wh,
      reason,
      remarks: remarks.trim() || null,
      items: states.map(({ line, shortfall }) => ({
        item_id: line.item.item_id,
        batch_id: line.lot.batch_id,
        bin_id: line.lot.bin_id,
        brand_id: line.lot.brand_id,
        variant_id: line.lot.variant_id,
        model_id: line.lot.model_id,
        physical_qty: Number(line.counted),
        serial_numbers: shortfall > 0 && line.lot.mode !== "QUANTITY" ? line.codes : [],
        remarks: line.note.trim() || undefined,
      })),
    }),
    // SCM_0119: the submit always says how it ended — a success naming the document
    // and what happens next, or a failure that stays on screen until it is read.
    onSuccess: (saved: StockAdjustment) => {
      if (saved.status === "APPROVED") {
        void alerts.success("stock.audit.recorded", { number: saved.adjustment_no });
      } else {
        void alerts.success("stock.audit.submitted", {
          number: saved.adjustment_no,
          qty: `${fmt(unitsOff)} unit${unitsOff === 1 ? "" : "s"} across ${short.length} line${short.length === 1 ? "" : "s"}`,
        });
      }
      void qc.invalidateQueries({ queryKey: ["stock-adjustments"] });
      nav(`/inventory/adjustments?review=${saved.id}`);
    },
    onError: (error) => {
      // A dropped connection or an expired session already has its own dialog.
      if (isAnnouncedGlobally(error)) return;
      claimError(error);
      void alerts.error("stock.audit.failed", {
        reason: (error as Error)?.message || "The server did not accept this audit.",
      });
    },
  });

  const onSubmit = () => {
    setTouched(true);
    if (!ready) {
      void alerts.warning("stock.audit.incomplete", { reason: blockers.join(" ") });
      return;
    }
    submit.mutate();
  };

  const pickerLine = lines.find((l) => l.key === pickerKey) ?? null;
  const pickerShortfall = pickerLine ? lineOf(pickerLine).shortfall : 0;
  const sources = useQuery({
    queryKey: ["audit-sources", wh, pickerLine?.key],
    queryFn: () => getAuditSources(wh, pickerLine!.item.item_id, pickerLine!.lot.batch_id,
      pickerLine!.lot.bin_id, {
        brand_id: pickerLine!.lot.brand_id, variant_id: pickerLine!.lot.variant_id,
        model_id: pickerLine!.lot.model_id,
      }),
    enabled: !!pickerLine && wh > 0,
    staleTime: 0,
  });
  // Codes carry no brand: two brands at one batch and location share one pool, and a
  // code picked on the other brand's line is not this line's to pick (the server
  // refuses the same code twice on one audit).
  const pickerSources = useMemo(() => {
    if (!sources.data || !pickerLine) return sources.data;
    const spot = spotKey(pickerLine.item.item_id, pickerLine.lot);
    const taken = new Map<string, string>();
    for (const l of lines) {
      if (l.key === pickerLine.key || spotKey(l.item.item_id, l.lot) !== spot) continue;
      for (const code of l.codes) taken.set(code, comboLabel(l.lot));
    }
    if (!taken.size) return sources.data;
    return {
      ...sources.data,
      packs: sources.data.packs.map((p) => (taken.has(p.code)
        ? { ...p, selectable: false, held_by: `Picked on the ${taken.get(p.code)} line` } : p)),
      units: sources.data.units.map((u) => (taken.has(u.code)
        ? { ...u, selectable: false, held_by: `Picked on the ${taken.get(u.code)} line` } : u)),
    };
  }, [sources.data, pickerLine, lines]);

  const reasonMeta = REASONS.find((r) => r.value === reason)!;

  return (
    <div className="pb-24 md:pb-6">
      <PageHeader
        eyebrow="Inventory"
        title="New stock audit"
        back={{ to: "/inventory/adjustments", label: "Back to Stock audits" }}
      />

      <div className="mb-4 flex items-start gap-3 rounded-2xl border border-bad/20 bg-gradient-to-r from-bad-bg/70 to-content1 px-4 py-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-bad text-white"><TrendingDown className="h-4 w-4" /></span>
        <div className="text-sm">
          <p className="font-semibold text-ink">A stock audit only records what is short.</p>
          <p className="text-muted">
            Count each batch and location. Anything missing, damaged or expired is written off — naming
            the exact serials, IMEIs, packs or codes where the stock carries them. Stock found on the
            shelf but not in the system comes in on a goods receipt, never on an audit.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          {/* ── Audit details ───────────────────────────────────────────── */}
          <Card className="p-5">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted">Audit details</h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Warehouse" required
                     hint={lines.length ? "Remove the lines below to change the warehouse." : "The point whose shelves are being counted."}>
                <Select ariaLabel="Warehouse" value={warehouseId}
                        isDisabled={lines.length > 0}
                        placeholder="Choose a warehouse"
                        options={(warehouses as any[]).map((w) => ({ value: String(w.id), label: w.name }))}
                        onChange={(v) => setWarehouseId(v || "")} />
              </Field>
              <Field label="Remarks" hint="Auditor, reference memo, shift — anything an approver should know.">
                <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Optional" />
              </Field>
            </div>

            <p className="mb-2 mt-5 text-sm font-medium text-body">Why stock is being written off</p>
            <div role="radiogroup" aria-label="Write-off reason" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {REASONS.map(({ value, label, hint, icon: Icon }) => {
                const active = value === reason;
                return (
                  <button key={value} type="button" role="radio" aria-checked={active}
                          onClick={() => setReason(value)}
                          className={`flex min-h-[58px] items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition ${
                            active ? "border-bad bg-bad-bg/60 ring-1 ring-bad/30" : "border-line bg-content1 hover:border-bad/40"}`}>
                    <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${active ? "bg-bad text-white" : "bg-content2 text-muted"}`}>
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span className={`block truncate text-sm font-semibold ${active ? "text-bad" : "text-ink"}`}>{label}</span>
                      <span className="block truncate text-[11px] text-muted">{hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </Card>

          {/* ── The count ───────────────────────────────────────────────── */}
          {/* No overflow-hidden: the add-a-line search opens a results panel inside
              this card, and clipping the card clipped the results. */}
          <Card className="p-0">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
                Count <span className="ml-1 rounded-full bg-content2 px-2 py-0.5 text-[11px] text-ink-700">{lines.length} line{lines.length === 1 ? "" : "s"}</span>
              </h2>
              {lines.length > 0 && (
                <button type="button" className="text-xs font-semibold text-brand hover:underline"
                        onClick={() => setLines((cur) => cur.map((l) => (l.counted === "" ? { ...l, counted: String(l.lot.system_qty) } : l)))}>
                  Mark uncounted lines as matching
                </button>
              )}
            </div>

            {lines.length > 0 && (
              <div className="overflow-x-auto custom-scrollbar">
                <div className="min-w-[760px]">
                  <div className={`hidden gap-3 border-b border-line bg-content2/50 px-5 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted md:grid ${COLS}`}>
                    <span>#</span><span>Item</span><span>Batch · location</span>
                    <span className="text-right">System</span><span>Counted</span>
                    <span className="text-right">Shortfall</span><span>Write-off</span><span />
                  </div>

                  <div className="divide-y divide-line">
                    {states.map(({ line, state, shortfall }, index) => {
                      const over = state === "over";
                      const invalid = state === "invalid";
                      return (
                        <div key={line.key} className={`px-5 py-3 ${over || invalid ? "bg-bad-bg/30" : ""}`}>
                          <div className={`grid grid-cols-2 items-center gap-x-3 gap-y-2 md:gap-3 ${COLS}`}>
                            <span className="hidden text-xs font-semibold text-muted md:block">{index + 1}</span>
                            <div className="col-span-2 min-w-0 md:col-span-1">
                              <p className="truncate text-sm font-semibold text-ink" title={line.item.item_name ?? ""}>{line.item.item_name}</p>
                              <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                                <span className="font-mono text-[11px] text-muted">{line.item.item_code}</span>
                                <ModeBadge mode={line.lot.mode} tracking={line.lot.tracking} />
                              </div>
                            </div>
                            <div className="col-span-2 min-w-0 text-xs md:col-span-1">
                              <p className="flex items-center gap-1 truncate font-medium text-ink"><Layers className="h-3 w-3 shrink-0 text-muted" />{line.lot.batch_no ?? "No batch"}</p>
                              <p className="flex items-center gap-1 truncate text-muted"><MapPin className="h-3 w-3 shrink-0" />{line.lot.bin_code ?? "No location"}</p>
                              {line.lot.expiry_date && <p className="text-[11px] text-muted">Exp {line.lot.expiry_date}</p>}
                              <div className="mt-1"><BrandChip lot={line.lot} /></div>
                            </div>
                            <div className="md:text-right">
                              <span className="text-[10px] font-semibold uppercase text-muted md:hidden">System </span>
                              <span className="tabular text-sm font-semibold text-ink">{fmt(line.lot.system_qty)}</span>
                              <span className="ml-1 text-[11px] text-muted">{line.item.uom_code}</span>
                            </div>
                            <div>
                              <span className="text-[10px] font-semibold uppercase text-muted md:hidden">Counted</span>
                              <Input type="number" min={0} max={line.lot.system_qty}
                                data-uom={line.item.uom_code ?? ""}
                                     step={line.lot.mode === "QUANTITY" ? "any" : 1}
                                     value={line.counted} isInvalid={over || invalid}
                                     aria-label={`Counted ${line.item.item_code}`}
                                     placeholder={fmt(line.lot.system_qty)}
                                     onChange={(e) => patch(line.key, { counted: e.target.value })} />
                            </div>
                            <div className="md:text-right">
                              <span className="text-[10px] font-semibold uppercase text-muted md:hidden">Shortfall </span>
                              {state === "uncounted" ? <span className="text-sm text-muted">—</span>
                                : over ? <span className="rounded-full bg-bad-bg px-2 py-0.5 text-xs font-bold text-bad">Over</span>
                                : invalid ? <span className="rounded-full bg-bad-bg px-2 py-0.5 text-xs font-bold text-bad">Invalid</span>
                                : shortfall === 0 ? <span className="rounded-full bg-ok-bg px-2 py-0.5 text-xs font-bold text-ok">0</span>
                                : <span className="tabular rounded-full bg-bad-bg px-2 py-0.5 text-xs font-bold text-bad">−{fmt(shortfall)}</span>}
                            </div>
                            <div className="col-span-2 md:col-span-1">
                              {state === "uncounted" || over || invalid ? (
                                <span className="text-xs text-muted">{over ? "Above system stock" : invalid ? (line.lot.mode !== "QUANTITY" ? "Whole units only" : "Not a valid count") : "Enter the count"}</span>
                              ) : state === "match" ? (
                                <span className="inline-flex items-center gap-1 text-xs font-semibold text-ok"><CheckCircle2 className="h-3.5 w-3.5" /> Matches the system</span>
                              ) : line.lot.mode === "QUANTITY" ? (
                                <span className="text-xs text-muted">By count — this lot carries no codes</span>
                              ) : (
                                <button type="button" onClick={() => setPickerKey(line.key)}
                                        className={`inline-flex min-h-9 w-full items-center justify-between gap-2 rounded-lg border px-2.5 text-xs font-semibold transition ${
                                          state === "ready" ? "border-ok/40 bg-ok-bg text-ok hover:border-ok"
                                            : "border-warn/50 bg-warn-bg text-warn hover:border-warn"}`}>
                                  <span className="inline-flex items-center gap-1.5">
                                    {state === "ready" ? <Check className="h-3.5 w-3.5" /> : <Tag className="h-3.5 w-3.5" />}
                                    {state === "ready"
                                      ? `${line.codes.length} code${line.codes.length === 1 ? "" : "s"} · ${fmt(line.picked)} picked`
                                      : line.picked > 0 ? `Picked ${fmt(line.picked)} of ${fmt(shortfall)} — fix` : `Pick ${fmt(shortfall)} to write off`}
                                  </span>
                                  <span className="text-[10px] uppercase opacity-70">{state === "ready" ? "Change" : "Open"}</span>
                                </button>
                              )}
                            </div>
                            <div className="col-span-2 flex justify-end gap-1 md:col-span-1">
                              <button type="button" aria-label="Add a note" title="Note"
                                      onClick={() => patch(line.key, { showNote: !line.showNote })}
                                      className={`grid h-9 w-9 place-items-center rounded-lg hover:bg-content2 ${line.note ? "text-brand" : "text-muted"}`}>
                                <StickyNote className="h-4 w-4" />
                              </button>
                              <button type="button" aria-label="Remove line"
                                      onClick={() => setLines((cur) => cur.filter((l) => l.key !== line.key))}
                                      className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-bad-bg hover:text-bad">
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          </div>
                          {over && (
                            <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-bad">
                              <AlertTriangle className="h-3.5 w-3.5" />
                              Counted {line.counted}, but the system holds {fmt(line.lot.system_qty)}. An audit only records a shortfall — receive extra stock on a goods receipt.
                            </p>
                          )}
                          {line.showNote && (
                            <div className="mt-2 md:ml-[2.75rem]">
                              <Input value={line.note} placeholder="What happened to this stock? (optional)"
                                     onChange={(e) => patch(line.key, { note: e.target.value })} />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            <AddLineBar warehouseId={wh} existing={new Set(lines.map((l) => l.key))} onAdd={addLots} />
          </Card>
        </div>

        {/* ── Summary rail ────────────────────────────────────────────────── */}
        <aside className="min-w-0 xl:sticky xl:top-[7.5rem]">
          <Card className="overflow-hidden p-0">
            <div className="border-b border-line bg-content2/40 px-4 py-3">
              <h2 className="text-[15px] font-bold text-ink">Audit summary</h2>
              <p className="mt-0.5 truncate text-xs text-muted">
                {(warehouses as any[]).find((w) => String(w.id) === warehouseId)?.name ?? "No warehouse chosen"} · {reasonMeta.label}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-px bg-line">
              {[
                { label: "Lines counted", value: `${counted.length}/${lines.length}` },
                { label: "Lines short", value: String(short.length), tone: short.length ? "text-bad" : "text-ink" },
                { label: "To write off", value: fmt(unitsOff), tone: unitsOff ? "text-bad" : "text-ink" },
                { label: "Codes to pick", value: String(needCodes.length), tone: needCodes.length ? "text-warn" : "text-ink" },
              ].map((k) => (
                <div key={k.label} className="bg-content1 px-4 py-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">{k.label}</p>
                  <p className={`tabular text-xl font-bold ${k.tone ?? "text-ink"}`}>{k.value}</p>
                </div>
              ))}
            </div>
            <div className="space-y-3 px-4 py-4">
              {ready ? (
                <p className="flex items-start gap-2 rounded-lg bg-ok-bg px-3 py-2 text-xs font-medium text-ok">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  {unitsOff > 0 ? `Ready. ${fmt(unitsOff)} will be written off once an approver signs.` : "Ready. Every line matches — recorded with nothing to write off."}
                </p>
              ) : (touched || lines.length > 0) && (
                <ul className="space-y-1.5 rounded-lg bg-warn-bg px-3 py-2 text-xs text-warn">
                  {blockers.map((b) => <li key={b} className="flex gap-1.5"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{b}</li>)}
                </ul>
              )}
              <ErrorBanner error={submit.error} />
              <Button className="w-full" disabled={submit.isPending}
                      onClick={onSubmit}>
                {submit.isPending ? "Submitting…" : unitsOff > 0 ? "Submit for approval" : "Record audit"}
              </Button>
              <Button variant="ghost" className="w-full" onClick={() => nav("/inventory/adjustments")}>Cancel</Button>
            </div>
          </Card>
        </aside>
      </div>

      <WriteOffPicker
        open={!!pickerLine}
        onClose={() => setPickerKey(null)}
        title={pickerLine ? `${pickerLine.item.item_code} — write off ${fmt(pickerShortfall)}` : ""}
        subtitle={pickerLine ? `${pickerLine.item.item_name ?? ""} · ${lotLabel(pickerLine.lot)}` : ""}
        shortfall={pickerShortfall}
        uom={pickerLine?.item.uom_code ?? null}
        sources={pickerSources}
        loading={sources.isLoading}
        note={pickerLine && sources.data?.mixed
          ? `More than one brand stands at this batch and location, and its codes carry no brand. Pick the ${comboLabel(pickerLine.lot)} units.`
          : null}
        initialCodes={pickerLine?.codes ?? []}
        onDone={(codes, total) => {
          if (pickerLine) patch(pickerLine.key, { codes, picked: total });
          setPickerKey(null);
        }}
      />
    </div>
  );
}

/** The bar under the table: find an item this point holds, then add one lot or all. */
function AddLineBar({ warehouseId, existing, onAdd }: {
  warehouseId: number;
  existing: Set<string>;
  onAdd: (item: AuditItemOption, lots: AuditLot[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [item, setItem] = useState<AuditItemOption | null>(null);
  const [openList, setOpenList] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpenList(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const items = useQuery({
    queryKey: ["audit-items", warehouseId, debounced],
    queryFn: () => getAuditItems(warehouseId, debounced),
    enabled: warehouseId > 0,
  });
  const lots = useQuery({
    queryKey: ["audit-lots", warehouseId, item?.item_id],
    queryFn: () => getAuditLots(warehouseId, item!.item_id),
    enabled: warehouseId > 0 && !!item,
  });
  const keyOf = (lot: AuditLot) => (item ? lotKey(item.item_id, lot) : "");
  const free = useMemo(() => (lots.data ?? []).filter((lot) => !existing.has(keyOf(lot))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lots.data, existing, item]);

  const results = items.data ?? [];
  // Keep the highlighted row on screen as the arrow keys walk the list.
  useEffect(() => { setActive(0); }, [debounced, openList]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (row: AuditItemOption) => { setItem(row); setOpenList(false); setSearch(""); };

  if (!warehouseId) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-b-2xl border-t border-line bg-content2/30 px-5 py-8 text-center">
        <span className="grid h-11 w-11 place-items-center rounded-2xl bg-brand/10 text-brand"><Search className="h-5 w-5" /></span>
        <p className="text-sm font-semibold text-ink">Choose the warehouse first</p>
        <p className="text-xs text-muted">The items you can count are the ones it holds.</p>
      </div>
    );
  }

  return (
    <div className="rounded-b-2xl border-t border-line bg-gradient-to-b from-content2/40 to-content1 px-5 py-4">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand text-white"><Plus className="h-4 w-4" /></span>
        <div>
          <p className="text-sm font-semibold text-ink">Add a line</p>
          <p className="text-[11px] text-muted">Search an item this warehouse holds, then pick its batch, location and brand.</p>
        </div>
      </div>

      <div ref={boxRef}
           className={`rounded-xl border bg-content1 transition-shadow ${
             openList ? "border-brand shadow-lg ring-4 ring-brand/10" : "border-line hover:border-brand/50"}`}>
        <div className="relative">
          <Search className={`pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 ${openList ? "text-brand" : "text-muted"}`} aria-hidden />
          <input
            value={item && !openList ? `${item.item_code} — ${item.item_name}` : search}
            onFocus={() => { setOpenList(true); if (item) setSearch(""); }}
            onChange={(e) => { setSearch(e.target.value); setOpenList(true); setItem(null); }}
            onKeyDown={(e) => {
              if (!openList) return;
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              else if (e.key === "Enter" && results[active]) { e.preventDefault(); choose(results[active]); }
              else if (e.key === "Escape") { setOpenList(false); (e.target as HTMLInputElement).blur(); }
            }}
            placeholder="Search by item name or code"
            aria-label="Search an item"
            aria-expanded={openList}
            role="combobox"
            className="h-12 w-full rounded-xl bg-transparent pl-10 pr-24 text-sm outline-none"
          />
          {openList && (
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-md bg-content2 px-2 py-0.5 text-[10px] font-semibold text-muted">
              {items.isFetching ? "Searching…" : `${results.length} in stock`}
            </span>
          )}
        </div>

        {/* In the flow, not floating: it pushes the card taller, so no container can
            ever clip it. */}
        {openList && (
          <div className="border-t border-line">
            <div ref={listRef} role="listbox" className="max-h-80 overflow-auto p-1.5">
              {items.isLoading ? (
                [0, 1, 2].map((k) => <div key={k} className="m-1 h-12 animate-pulse rounded-lg bg-content2" />)
              ) : results.length === 0 ? (
                <div className="flex flex-col items-center gap-1 px-3 py-6 text-center">
                  <p className="text-sm font-semibold text-ink">No item in stock here matches “{search}”</p>
                  <p className="text-xs text-muted">An audit only counts what this warehouse holds.</p>
                </div>
              ) : results.map((row, i) => (
                <button key={row.item_id} type="button" role="option" aria-selected={i === active}
                        data-row={i}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => choose(row)}
                        className={`flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                          i === active ? "bg-brand/10" : "hover:bg-content2"}`}>
                  <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[10px] font-bold ${
                    row.tracking === "SERIAL" || row.tracking === "IMEI" ? "bg-info-bg text-info"
                      : row.tracking === "ASSET" ? "bg-warn-bg text-warn" : "bg-ok-bg text-ok"}`}>
                    {row.tracking === "SERIAL" ? "SN" : row.tracking === "IMEI" ? "IM" : row.tracking === "ASSET" ? "AS" : "CN"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink"><Highlight text={row.item_name ?? ""} query={search} /></span>
                    <span className="flex items-center gap-2 font-mono text-[11px] text-muted">
                      <Highlight text={row.item_code ?? ""} query={search} />
                      <span className="font-sans">· {TRACKING_LABEL[row.tracking]}</span>
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="tabular block text-sm font-bold text-ink">{fmt(row.system_qty)}</span>
                    <span className="block text-[10px] text-muted">{row.uom_code} on hand</span>
                  </span>
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between gap-2 rounded-b-xl border-t border-line bg-content2/40 px-3 py-1.5 text-[10px] text-muted">
              <span><kbd className="rounded border border-line bg-content1 px-1">↑</kbd> <kbd className="rounded border border-line bg-content1 px-1">↓</kbd> to move · <kbd className="rounded border border-line bg-content1 px-1">Enter</kbd> to choose · <kbd className="rounded border border-line bg-content1 px-1">Esc</kbd> to close</span>
              <span className="hidden sm:inline">Items with stock at this warehouse only</span>
            </div>
          </div>
        )}
      </div>

      {item && (
        <div className="mt-3 overflow-hidden rounded-xl border border-line bg-content1">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
            <p className="text-xs font-semibold text-ink">Batches, locations and brands of {item.item_code}</p>
            {free.length > 1 && (
              <Button variant="soft" className="ml-auto" onClick={() => { onAdd(item, free); setItem(null); }}>
                <Plus className="h-4 w-4" /> Count all {free.length}
              </Button>
            )}
          </div>
          {lots.isLoading ? (
            <p className="px-3 py-3 text-sm text-muted">Reading the shelf…</p>
          ) : free.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted">Every batch, location and brand of this item is already on the audit.</p>
          ) : (
            <div className="divide-y divide-line">
              {free.map((lot) => (
                <div key={keyOf(lot)} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1 text-xs">
                    <p className="flex items-center gap-1.5 font-semibold text-ink">
                      <Layers className="h-3 w-3 text-muted" />{lot.batch_no ?? "No batch"}
                      {lot.expiry_date && <span className="font-normal text-muted">· Exp {lot.expiry_date}</span>}
                    </p>
                    <p className="flex items-center gap-1.5 text-muted"><MapPin className="h-3 w-3" />{lot.bin_code ?? "No location"}</p>
                    <div className="mt-1"><BrandChip lot={lot} /></div>
                  </div>
                  <ModeBadge mode={lot.mode} tracking={lot.tracking} />
                  <span className="tabular w-20 text-right text-sm font-semibold text-ink">{fmt(lot.system_qty)}</span>
                  <Button variant="subtle" onClick={() => { onAdd(item, [lot]); if (free.length === 1) setItem(null); }}>
                    <Plus className="h-4 w-4" /> Add
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The part of `text` the search matched, marked — so a storekeeper sees WHY it matched. */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded bg-brand/20 px-0.5 text-inherit">{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}
