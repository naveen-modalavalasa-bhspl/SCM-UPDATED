import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { useReactToPrint } from "react-to-print";
import {
  Barcode as BarcodeIcon, Check, Layers, Printer, QrCode, Save, Tag, Trash2,
} from "lucide-react";
import { Button, useToast } from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { docLabelsPrinted, issueLabels, receivedLabels } from "../api";
import type { DocLabelRow, DocLabels } from "../types";
import { fmtDate, fmtQty } from "../format";
import {
  FIELDS, SIZE_PRESETS, deletePreset, loadLast, loadPresets, pageCss, printSummary,
  saveLast, savePreset, selectLabels, sheetGrid,
  type CodeKind, type FieldKey, type LabelSettings, type PackScope,
} from "../docLabels";
import { LabelSticker } from "./LabelSticker";
import { shortCode } from "../packPick";

/**
 * Print the labels of ONE document (2026-10-28): every package a posted issue sent,
 * or everything a site acknowledged on a consignment — the whole document or chosen
 * items, as a barcode, a QR or both, at any size, on a thermal roll or an A4 sheet.
 *
 * The rows are served (`issue_labels.py`), so what can be printed is decided by the
 * server: never before posting, never a serial or an IMEI, and at a receiving site
 * only what arrived. This screen decides only how they look. Settings are the
 * viewer's own and live in the browser (`docLabels.ts`).
 */
export function DocLabelsDialog({ open, onClose, doc, initialLineIds }: {
  open: boolean;
  onClose: () => void;
  doc: { type: "ISSUE" | "RECEIPT"; id: number } | null;
  /** Open on these items only — the per-item "Print labels". */
  initialLineIds?: number[] | null;
}) {
  const { me } = useAuth();
  const user = String(me?.employee?.id ?? "");
  const toast = useToast();
  const [s, setS] = useState<LabelSettings>(() => loadLast(user));
  const [presets, setPresets] = useState(() => loadPresets(user));
  const [presetName, setPresetName] = useState("");
  const [scope, setScope] = useState<"ALL" | "ITEMS">("ALL");
  const [lineIds, setLineIds] = useState<number[]>([]);
  const [packs, setPacks] = useState<PackScope>("ALL");
  const [units, setUnits] = useState(true);
  const [ask, setAsk] = useState(false);
  const [printedOnce, setPrintedOnce] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);

  const data = useQuery({
    queryKey: ["doc-labels", doc?.type, doc?.id],
    queryFn: () => (doc!.type === "ISSUE" ? issueLabels(doc!.id) : receivedLabels(doc!.id)),
    enabled: open && !!doc,
  });
  const body: DocLabels | undefined = data.data;

  useEffect(() => {
    if (!open) return;
    setAsk(false);
    setPrintedOnce(false);
    setS(loadLast(user));
    setPresets(loadPresets(user));
    if (initialLineIds?.length) {
      setScope("ITEMS");
      setLineIds(initialLineIds);
    } else {
      setScope("ALL");
      setLineIds([]);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) saveLast(user, s); }, [s, open, user]);

  const chosen = useMemo(() => selectLabels(body?.labels ?? [], {
    lineIds: scope === "ITEMS" ? lineIds : null, packs, units, copies: s.copies, parents: s.parents,
  }), [body, scope, lineIds, packs, units, s.copies, s.parents]);
  const hasParents = (body?.labels ?? []).some((r) => r.context);
  const hasUnits = (body?.labels ?? []).some((r) => r.kind === "UNIT");
  const hasNew = (body?.labels ?? []).some((r) => r.new_here);
  const hasInnerIssued = (body?.labels ?? []).some((r) => r.kind === "PACK" && !r.issued && !r.context);

  const print = useReactToPrint({
    content: () => sheetRef.current,
    documentTitle: `labels-${body?.document_no ?? "document"}`,
    pageStyle: pageCss(s),
    onAfterPrint: () => setAsk(true),
  });
  const done = useMutation({
    mutationFn: () => docLabelsPrinted(doc!, {
      label_ids: [...new Set(chosen.map((r) => r.label_id).filter((v): v is number => !!v))],
      printed: chosen.length, reprint: printedOnce,
    }),
    onSuccess: () => {
      toast.success(`${chosen.length} label${chosen.length === 1 ? "" : "s"} recorded as printed`);
      setAsk(false);
      setPrintedOnce(true);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const set = <K extends keyof LabelSettings>(k: K, v: LabelSettings[K]) => setS((now) => ({ ...now, [k]: v }));
  const pickSize = (id: string) => {
    const p = SIZE_PRESETS.find((x) => x.id === id);
    if (p) setS((now) => ({ ...now, sizeId: id, w: p.w, h: p.h, layout: p.layout }));
    else setS((now) => ({ ...now, sizeId: "custom" }));
  };
  const toggleLine = (id: number) =>
    setLineIds((now) => (now.includes(id) ? now.filter((x) => x !== id) : [...now, id]));

  const rowsFor = (r: DocLabelRow): [string, string | null | undefined][] => {
    const f = s.fields;
    const combo = [r.brand_name, r.variant_name, r.model_name].filter(Boolean).join(" · ");
    const out: [string, string | null | undefined][] = [];
    if (f.item_code) out.push(["Item", r.item_code]);
    if (f.pack) {
      out.push(r.kind === "UNIT" ? ["Type", r.pack_name]
        : [r.pack_name ?? "Pack", `${fmtQty(r.qty)}${r.part ? ` of ${fmtQty(r.pack_size)}` : ""} ${r.uom_code ?? ""}`]);
    }
    if (f.inside) out.push(["Holds", r.packs_inside]);
    if (f.batch) out.push(["Batch", r.batch_no]);
    if (f.expiry) out.push(["Expiry", r.expiry_date ? fmtDate(r.expiry_date) : null]);
    if (f.combo) out.push(["Brand", combo || null]);
    if (f.path && r.path?.length) {
      out.push(["Path", r.path.map((p) => `${(p.name ?? "pack").toLowerCase()} ${shortCode(p.code)}`).join(" › ")]);
    }
    if (f.parent) out.push(["In", r.parent_code]);
    if (f.doc) out.push([body?.document_type === "RECEIPT" ? "Recd" : "Issue", body?.document_no]);
    if (f.to) out.push(["To", body?.to_name]);
    if (f.date) out.push(["Date", body?.document_date ? fmtDate(body.document_date) : null]);
    return out;
  };
  const sticker = (r: DocLabelRow, key: string) => (
    <LabelSticker key={key} code={r.code}
                  qrValue={r.qr_token ? `${window.location.origin}/c/${encodeURIComponent(r.qr_token)}` : r.code}
                  title={s.fields.item_name ? r.item_name : null} rows={rowsFor(r)}
                  w={s.w} h={s.h} kind={s.code} barFormat={s.barFormat} font={s.font} />
  );
  const PREVIEW = 24;
  const grid = sheetGrid(s.w, s.h, s.margin, s.gap);
  const title = body
    ? `${body.document_type === "RECEIPT" ? "Received on" : "Issued on"} ${body.document_no}`
    : "Labels";

  return (
    <Modal isOpen={open} onOpenChange={(o) => { if (!o) onClose(); }} size="5xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-0.5 border-b border-line/70">
          <span className="flex items-center gap-2 text-base font-semibold text-ink">
            <Tag className="h-4 w-4 text-brand" aria-hidden /> Print labels
          </span>
          <span className="text-xs font-normal text-muted">
            {title}{body?.to_name ? ` · to ${body.to_name}` : ""}
          </span>
        </ModalHeader>
        <ModalBody className="py-4">
          {data.isLoading ? (
            <p className="py-10 text-center text-sm text-muted">Reading the labels…</p>
          ) : data.isError ? (
            <p className="rounded-xl bg-bad-bg px-4 py-3 text-sm text-bad">{(data.error as Error).message}</p>
          ) : !body?.labels.length ? (
            <p className="py-10 text-center text-sm text-muted">Nothing on this document carries a label.</p>
          ) : (
            <div className="grid gap-5 lg:grid-cols-[20rem_minmax(0,1fr)]">
              {/* ---- the choices ---- */}
              <div className="space-y-5">
                <Group title="What to print">
                  <Segmented value={scope} onChange={(v) => setScope(v as "ALL" | "ITEMS")}
                             options={[["ALL", body.document_type === "RECEIPT" ? "Everything received" : "Whole issue"],
                                       ["ITEMS", "Chosen items"]]} />
                  {scope === "ITEMS" && (
                    <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
                      {body.lines.map((l) => (
                        <li key={l.line_id}>
                          <label className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border border-line px-2.5 hover:border-brand/60">
                            <input type="checkbox" className="h-4 w-4"
                                   checked={lineIds.includes(l.line_id)} onChange={() => toggleLine(l.line_id)} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-semibold text-ink">{l.item_name}</span>
                              <span className="block truncate text-[11px] text-muted">
                                {fmtQty(l.qty)} {l.uom_code ?? ""} · {l.packs + l.inner_packs} pack{l.packs + l.inner_packs === 1 ? "" : "s"}
                                {l.units ? ` · ${l.units} code${l.units === 1 ? "" : "s"}` : ""}
                              </span>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-3 space-y-1.5">
                    <span className="text-[11px] font-semibold text-muted">Packages</span>
                    <Segmented value={packs} onChange={(v) => setPacks(v as PackScope)}
                               options={[["ALL", hasInnerIssued ? "Every level" : "All"],
                                         ...(hasInnerIssued ? [["TOP", "Issued packs only"] as [string, string]] : []),
                                         ...(hasNew ? [["NEW", "New part packs"] as [string, string]] : []),
                                         ["NONE", "None"]]} />
                  </div>
                  {hasParents && packs !== "NONE" && (
                    <label className="mt-2 flex min-h-11 cursor-pointer items-center gap-2.5 text-xs text-ink">
                      <input type="checkbox" className="h-4 w-4" checked={s.parents}
                             onChange={(e) => set("parents", e.target.checked)} />
                      Include parent labels — the carton (and an opened box) on top
                    </label>
                  )}
                  {hasUnits && (
                    <label className="mt-2 flex min-h-11 cursor-pointer items-center gap-2.5 text-xs text-ink">
                      <input type="checkbox" className="h-4 w-4" checked={units} onChange={(e) => setUnits(e.target.checked)} />
                      Asset / consumable codes, one label each
                    </label>
                  )}
                </Group>

                <Group title="Code">
                  <Segmented value={s.code} onChange={(v) => set("code", v as CodeKind)}
                             options={[["BOTH", "Barcode + QR"], ["BARCODE", "Barcode"], ["QR", "QR"]]}
                             icons={{ BARCODE: <BarcodeIcon className="h-3.5 w-3.5" />, QR: <QrCode className="h-3.5 w-3.5" /> }} />
                  {s.code !== "QR" && (
                    <select value={s.barFormat} onChange={(e) => set("barFormat", e.target.value as LabelSettings["barFormat"])}
                            aria-label="Barcode format"
                            className="mt-2 h-10 w-full rounded-lg border border-line bg-content1 px-2 text-xs">
                      <option value="CODE128">Code 128 (any code)</option>
                      <option value="CODE39">Code 39 (older scanners)</option>
                    </select>
                  )}
                </Group>

                <Group title="Size and paper">
                  <select value={s.sizeId} onChange={(e) => pickSize(e.target.value)} aria-label="Label size"
                          className="h-10 w-full rounded-lg border border-line bg-content1 px-2 text-xs">
                    {["Thermal roll", "A4 sheet"].map((g) => (
                      <optgroup key={g} label={g}>
                        {SIZE_PRESETS.filter((p) => p.group === g).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                      </optgroup>
                    ))}
                    <option value="custom">Custom size…</option>
                  </select>
                  {s.sizeId === "custom" && (
                    <div className="mt-2 space-y-2">
                      <div className="flex items-center gap-2 text-xs">
                        <MmInput label="Width" value={s.w} min={15} max={200} onChange={(v) => set("w", v)} />
                        <span className="text-muted">×</span>
                        <MmInput label="Height" value={s.h} min={10} max={280} onChange={(v) => set("h", v)} />
                      </div>
                      <Segmented value={s.layout} onChange={(v) => set("layout", v as LabelSettings["layout"])}
                                 options={[["ROLL", "Thermal roll"], ["SHEET", "A4 sheet"]]} />
                    </div>
                  )}
                  {s.layout === "SHEET" && (
                    <div className="mt-2 flex items-center gap-2 text-xs">
                      <MmInput label="Margin" value={s.margin} max={30} onChange={(v) => set("margin", v)} />
                      <MmInput label="Gap" value={s.gap} max={20} onChange={(v) => set("gap", v)} />
                      <span className="text-[11px] text-muted">{grid.cols} × {grid.rows}</span>
                    </div>
                  )}
                </Group>

                <Group title="On the label">
                  <div className="grid grid-cols-2 gap-x-2">
                    {FIELDS.map(([k, label]) => (
                      <label key={k} className="flex min-h-9 cursor-pointer items-center gap-2 text-xs text-ink">
                        <input type="checkbox" className="h-4 w-4" checked={s.fields[k as FieldKey]}
                               onChange={(e) => set("fields", { ...s.fields, [k]: e.target.checked })} />
                        {label}
                      </label>
                    ))}
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    <span className="text-[11px] font-semibold text-muted">Text</span>
                    <Segmented value={s.font} onChange={(v) => set("font", v as LabelSettings["font"])}
                               options={[["S", "Small"], ["M", "Medium"], ["L", "Large"]]} />
                  </div>
                  <div className="mt-2 flex items-center gap-3 text-xs">
                    <span className="text-[11px] font-semibold text-muted">Copies of each</span>
                    <input type="number" min={1} max={10} value={s.copies} aria-label="Copies of each label"
                           onChange={(e) => set("copies", Math.max(1, Math.min(10, Math.floor(Number(e.target.value) || 1))))}
                           className="h-10 w-16 rounded-lg border border-line bg-content1 px-2 text-center tabular" />
                  </div>
                </Group>

                <Group title="My presets">
                  {presets.length > 0 && (
                    <ul className="mb-2 flex flex-wrap gap-1.5">
                      {presets.map((p) => (
                        <li key={p.name} className="inline-flex items-center rounded-full border border-line bg-content1 text-xs">
                          <button type="button" onClick={() => setS(p.settings)}
                                  className="min-h-9 rounded-l-full px-3 font-semibold text-ink hover:text-brand">{p.name}</button>
                          <button type="button" aria-label={`Delete preset ${p.name}`}
                                  onClick={() => { deletePreset(user, p.name); setPresets(loadPresets(user)); }}
                                  className="grid h-9 w-8 place-items-center rounded-r-full text-muted hover:text-bad">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex gap-2">
                    <input value={presetName} onChange={(e) => setPresetName(e.target.value)}
                           placeholder="e.g. Zebra 50×25" aria-label="Preset name"
                           className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-content1 px-2 text-xs" />
                    <Button variant="ghost" disabled={!presetName.trim()}
                            onClick={() => { savePreset(user, presetName.trim(), s); setPresets(loadPresets(user)); setPresetName(""); }}>
                      <Save className="h-4 w-4" /> Save
                    </Button>
                  </div>
                  <p className="mt-1 text-[11px] text-muted">Saved in this browser, for you only.</p>
                </Group>
              </div>

              {/* ---- the preview, true to size ---- */}
              <div className="min-w-0">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                    <Layers className="h-4 w-4 text-brand" aria-hidden /> {printSummary(chosen.length, s)}
                  </span>
                  <span className="text-[11px] text-muted">{s.w} × {s.h} mm · actual size</span>
                </div>
                {chosen.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-line p-10 text-center text-sm text-muted">
                    Nothing selected — choose items or package levels on the left.
                  </p>
                ) : (
                  <div className="max-h-[60vh] overflow-auto rounded-xl bg-content2/60 p-3">
                    <div className="flex flex-wrap gap-2">
                      {chosen.slice(0, PREVIEW).map((r, i) => (
                        <div key={`${r.key}-${i}`} style={{ marginLeft: `${Math.min(r.depth, 3) * 3}mm` }}>
                          {sticker(r, `${r.key}-${i}`)}
                        </div>
                      ))}
                    </div>
                    {chosen.length > PREVIEW && (
                      <p className="mt-2 text-center text-[11px] text-muted">…and {chosen.length - PREVIEW} more, printed in the same order</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* The print run: every chosen label, off screen. */}
          <div aria-hidden style={{ position: "absolute", left: -100000, top: 0 }}>
            <div ref={sheetRef} className="doc-label-sheet">
              {chosen.map((r, i) => sticker(r, `p-${r.key}-${i}`))}
            </div>
          </div>
        </ModalBody>
        <ModalFooter className="flex flex-wrap items-center justify-between gap-2 border-t border-line/70">
          {ask ? (
            <div className="flex flex-1 flex-wrap items-center justify-between gap-2 rounded-xl bg-content2 px-3 py-2">
              <span className="text-sm text-ink">Did the {chosen.length} labels print correctly?</span>
              <span className="flex gap-2">
                <Button variant="ghost" onClick={() => setAsk(false)}>No — try again</Button>
                <Button onClick={() => done.mutate()} disabled={done.isPending}>
                  <Check className="h-4 w-4" /> Yes, record them
                </Button>
              </span>
            </div>
          ) : (
            <>
              <span className="text-xs text-muted">
                {printedOnce ? "Recorded. Printing again is recorded as a reprint." : "Labels print in pick order — each pack, then what is inside it."}
              </span>
              <span className="flex gap-2">
                <Button variant="ghost" onClick={onClose}>Close</Button>
                <Button onClick={() => print?.()} disabled={chosen.length === 0}>
                  <Printer className="h-4 w-4" /> Print {chosen.length || ""}
                </Button>
              </span>
            </>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-muted">{title}</h3>
      {children}
    </section>
  );
}

function Segmented({ value, onChange, options, icons }: {
  value: string; onChange: (v: string) => void; options: [string, string][];
  icons?: Record<string, ReactNode>;
}) {
  return (
    <div role="radiogroup" className="flex flex-wrap gap-1 rounded-xl bg-content2 p-1">
      {options.map(([v, label]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}
                className={`inline-flex min-h-9 flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-lg px-2.5 text-xs font-semibold transition-colors ${
                  value === v ? "bg-content1 text-brand shadow-sm" : "text-muted hover:text-ink"}`}>
          {icons?.[v]}{label}
        </button>
      ))}
    </div>
  );
}

function MmInput({ label, value, min = 0, max, onChange }: {
  label: string; value: number; min?: number; max: number; onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-1">
      <span className="text-[11px] text-muted">{label}</span>
      <input type="number" min={min} max={max} value={value} aria-label={`${label} in mm`}
             onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || 0)))}
             className="h-10 w-16 rounded-lg border border-line bg-content1 px-2 text-center tabular" />
      <span className="text-[11px] text-muted">mm</span>
    </label>
  );
}
