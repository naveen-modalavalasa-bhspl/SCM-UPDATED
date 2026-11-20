import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import {
  CalendarRange, Camera, CheckCircle2, FileText, ShieldAlert, ShieldCheck, Trash2, Upload,
} from "lucide-react";
import { Button, Input, errorMessage, useToast } from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import {
  downloadWarrantyDocument, receiptWarranties, removeReceiptWarranty, saveReceiptWarranty,
} from "../api";
import type { ReceiptWarranties, UnitWarranty, WarrantyLine } from "../types";
import { warrantyTone, addYears, coverSentence } from "./warrantyRules";

/**
 * Warranty per received unit (MoM 2026-11-18, point 25).
 *
 * One row per serial / IMEI-tracked line of a saved GRN, saying how many of its units
 * have a warranty card. "Add warranty" opens the units of that line: tick the ones a
 * card covers (or press "Same warranty for all"), give the dates and the card, save.
 * A missing warranty never stops the GRN — the card often arrives after the goods,
 * so it can be added at any time until the GRN is cancelled.
 */
export function GrnWarrantyPanel({ receiptId, canEdit }: { receiptId: number; canEdit: boolean }) {
  const { data } = useQuery({
    queryKey: ["wh-receipt-warranties", receiptId],
    queryFn: () => receiptWarranties(receiptId),
  });
  const [openLine, setOpenLine] = useState<number | null>(null);
  if (!data || data.total === 0 && data.lines.length === 0) return null;
  const editable = canEdit && data.editable;
  const complete = data.total > 0 && data.covered >= data.total;
  const pct = data.total ? Math.round((data.covered / data.total) * 100) : 0;
  const line = data.lines.find((l) => l.receipt_item_id === openLine) ?? null;

  return (
    <section aria-label="Warranty cards" className="overflow-hidden rounded-2xl border border-line/80 bg-content1">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 bg-content2/40 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className={`grid h-9 w-9 place-items-center rounded-xl ${complete ? "bg-ok-bg text-ok" : "bg-warn-bg text-warn"}`}>
            {complete ? <ShieldCheck className="h-5 w-5" aria-hidden /> : <ShieldAlert className="h-5 w-5" aria-hidden />}
          </span>
          <div>
            <h2 className="font-display text-[15px] font-bold text-ink">Warranty cards</h2>
            <p className="text-xs text-muted">
              {complete ? "Every serial on this GRN has its warranty."
                : "Optional — the GRN goes ahead without them. Add each card whenever it arrives."}
            </p>
          </div>
        </div>
        <div className="min-w-[12rem] flex-1 sm:max-w-xs">
          <div className="mb-1 flex justify-between text-xs font-semibold">
            <span className={complete ? "text-ok" : "text-warn"}>
              Warranty added for {data.covered} of {data.total}
            </span>
            <span className="tabular-nums text-muted">{pct}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-content3">
            <div className={`h-full rounded-full transition-all ${complete ? "bg-ok" : "bg-warn"}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
      </header>

      <ul className="divide-y divide-line/60">
        {data.lines.map((l) => {
          const done = l.total > 0 && l.covered >= l.total;
          const soon = l.units.filter((u) => u.warranty && u.warranty.status !== "ACTIVE").length;
          return (
            <li key={l.receipt_item_id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-ink">{l.item_name ?? l.item_code}</div>
                <div className="truncate text-[11px] text-muted">
                  {[l.item_code, l.batch_no && `batch ${l.batch_no}`, `line ${l.line_no ?? ""}`].filter(Boolean).join(" · ")}
                </div>
              </div>
              {soon > 0 && (
                <span className="rounded-full bg-warn-bg px-2 py-0.5 text-[11px] font-semibold text-warn">
                  {soon} ending or ended
                </span>
              )}
              <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold tabular-nums ${
                done ? "bg-ok-bg text-ok" : l.covered ? "bg-warn-bg text-warn" : "bg-content3 text-muted"}`}>
                {done && <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />} {l.covered} / {l.total}
              </span>
              <Button variant={done || !editable ? "ghost" : "primary"} className="min-h-11"
                      onClick={() => setOpenLine(l.receipt_item_id)} disabled={l.total === 0}
                      title={l.total === 0 ? "Scan the serials on this line first" : undefined}>
                {l.total === 0 ? "No serials yet" : !editable ? "View" : done ? "View / change" : "Add warranty"}
              </Button>
            </li>
          );
        })}
      </ul>

      {line && (
        <WarrantyDialog receiptId={receiptId} line={line} data={data} editable={editable}
                        onClose={() => setOpenLine(null)} />
      )}
    </section>
  );
}

function WarrantyDialog({ receiptId, line, data, editable, onClose }: {
  receiptId: number; line: WarrantyLine; data: ReceiptWarranties; editable: boolean; onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const missing = useMemo(() => line.units.filter((u) => !u.warranty).map((u) => u.code), [line]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(missing));
  const today = new Date().toISOString().slice(0, 10);
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(addYears(today, 1));
  const [cardNo, setCardNo] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [existingDoc, setExistingDoc] = useState<number | null>(null);
  useEffect(() => { if (file) setExistingDoc(null); }, [file]);

  const badDates = !!start && !!end && end < start;
  const hasDoc = !!file || !!existingDoc;
  const blockReason = !picked.size ? "Tick the units this card covers."
    : !start || !end ? "Give the start and end date."
    : badDates ? "The warranty cannot end before it starts."
    : !hasDoc ? "Attach the warranty card — a PDF or a photo." : null;

  const refresh = (next: ReceiptWarranties) => qc.setQueryData(["wh-receipt-warranties", receiptId], next);
  const save = useMutation({
    mutationFn: (codes: string[]) => saveReceiptWarranty(receiptId, {
      receipt_item_id: line.receipt_item_id, codes, start_date: start, end_date: end,
      card_no: cardNo.trim() || null, file, attachment_id: existingDoc,
    }),
    onSuccess: (next, codes) => {
      refresh(next);
      toast.success(`Warranty saved for ${codes.length} unit${codes.length === 1 ? "" : "s"}.`);
      const left = next.lines.find((l) => l.receipt_item_id === line.receipt_item_id);
      const open = left?.units.filter((u) => !u.warranty).map((u) => u.code) ?? [];
      setPicked(new Set(open));
      setFile(null); setCardNo("");
      if (!open.length) onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (w: UnitWarranty) => removeReceiptWarranty(receiptId, w.id),
    onSuccess: (next) => { refresh(next); toast.success("Warranty removed."); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const view = async (attachmentId: number) => {
    const blob = await downloadWarrantyDocument(receiptId, attachmentId);
    window.open(URL.createObjectURL(blob), "_blank", "noopener");
  };
  const toggle = (code: string) => setPicked((cur) => {
    const next = new Set(cur);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  });
  const all = line.units.map((u) => u.code);

  return (
    <Modal isOpen onClose={onClose} size="3xl" backdrop="blur" scrollBehavior="inside"
           classNames={{ base: "rounded-3xl border border-line/80 shadow-2xl bg-content1 overflow-hidden",
                         backdrop: "bg-black/50 backdrop-blur-sm" }}>
      <ModalContent>
        <div className="h-1.5 w-full bg-gradient-to-r from-ok via-brand to-indigo-600" />
        <ModalHeader className="flex flex-col gap-1 border-b border-line/60 px-6 pb-4 pt-5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">Warranty · {data.grn_no}</span>
          <span className="font-display text-lg font-bold text-ink">{line.item_name ?? line.item_code}</span>
          <span className="text-xs font-normal text-muted">
            {line.covered} of {line.total} units have a warranty{line.batch_no ? ` · batch ${line.batch_no}` : ""}
          </span>
        </ModalHeader>
        <ModalBody className="grid gap-5 px-6 py-4 md:grid-cols-[1fr_17rem]">
          <div className="min-w-0">
            {editable && (
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                <span className="font-semibold text-ink">{picked.size} ticked</span>
                <button type="button" className="min-h-9 rounded-lg px-2 font-semibold text-brand hover:bg-brand/5"
                        onClick={() => setPicked(new Set(missing))}>Only those without one ({missing.length})</button>
                <button type="button" className="min-h-9 rounded-lg px-2 font-semibold text-brand hover:bg-brand/5"
                        onClick={() => setPicked(new Set(all))}>All {all.length}</button>
                <button type="button" className="min-h-9 rounded-lg px-2 font-semibold text-muted hover:bg-content3"
                        onClick={() => setPicked(new Set())}>None</button>
              </div>
            )}
            <ul className="max-h-[22rem] divide-y divide-line/60 overflow-y-auto rounded-xl border border-line/70">
              {line.units.map((unit) => {
                const w = unit.warranty;
                const tone = warrantyTone(w?.status);
                return (
                  <li key={unit.code} className={`flex items-center gap-3 px-3 py-2 ${picked.has(unit.code) ? "bg-brand-050/50" : ""}`}>
                    {editable && (
                      <input type="checkbox" className="h-5 w-5 shrink-0 accent-[var(--color-brand)]"
                             aria-label={`Include ${unit.code}`} checked={picked.has(unit.code)}
                             onChange={() => toggle(unit.code)} />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[13px] font-semibold text-ink">{unit.serial_number ?? unit.imei}</div>
                      {unit.serial_number && unit.imei && <div className="truncate font-mono text-[11px] text-muted">IMEI {unit.imei}</div>}
                    </div>
                    {w ? (
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}
                              title={coverSentence(w)}>
                          till {fmtDate(w.end_date)} · {w.status_text}
                        </span>
                        {w.attachment_id && (
                          <button type="button" aria-label="Open the warranty card" title={w.document_name ?? "Warranty card"}
                                  className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-content3 hover:text-ink"
                                  onClick={() => void view(w.attachment_id!)}>
                            <FileText className="h-4 w-4" aria-hidden />
                          </button>
                        )}
                        {editable && (
                          <button type="button" aria-label={`Remove the warranty of ${unit.code}`}
                                  className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-danger-bg hover:text-danger"
                                  onClick={() => remove.mutate(w)} disabled={remove.isPending}>
                            <Trash2 className="h-4 w-4" aria-hidden />
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="shrink-0 rounded-full bg-content3 px-2 py-0.5 text-[11px] font-semibold text-muted">No warranty</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          {editable ? (
            <div className="space-y-3">
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
                  <CalendarRange className="h-3.5 w-3.5" aria-hidden /> Warranty period
                </div>
                <label className="block text-xs font-medium text-body">Starts
                  <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Warranty starts" />
                </label>
                <label className="mt-2 block text-xs font-medium text-body">Ends
                  <Input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} aria-label="Warranty ends" />
                </label>
                <div className="mt-1.5 flex gap-1.5">
                  {[1, 2, 3].map((years) => (
                    <button key={years} type="button" onClick={() => setEnd(addYears(start || today, years))}
                            className={`min-h-9 flex-1 rounded-lg border text-xs font-semibold ${
                              end === addYears(start || today, years) ? "border-brand bg-brand-050 text-brand" : "border-line text-body hover:border-brand/40"}`}>
                      {years} yr
                    </button>
                  ))}
                </div>
                {badDates && <p className="mt-1 text-xs font-semibold text-danger">Cannot end before it starts.</p>}
              </div>
              <label className="block text-xs font-medium text-body">Warranty card no. <span className="text-muted">(optional)</span>
                <Input value={cardNo} maxLength={100} onChange={(e) => setCardNo(e.target.value)} placeholder="As printed on the card" />
              </label>
              <div>
                <div className="mb-1 text-xs font-medium text-body">Warranty card</div>
                <input ref={fileInput} type="file" accept="application/pdf,image/*" className="hidden"
                       onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                <button type="button" onClick={() => fileInput.current?.click()}
                        className={`flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-dashed px-3 text-xs font-semibold ${
                          file ? "border-ok/40 bg-ok-bg/40 text-ok" : "border-brand/40 text-brand hover:bg-brand/5"}`}>
                  {file ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <><Upload className="h-4 w-4" aria-hidden /><Camera className="h-4 w-4" aria-hidden /></>}
                  <span className="truncate">{file ? file.name : "Upload the card — PDF or photo"}</span>
                </button>
                {data.documents.length > 0 && !file && (
                  <select className="mt-2 min-h-11 w-full rounded-xl border border-line bg-content1 px-2 text-xs"
                          aria-label="Or use a card already on this GRN"
                          value={existingDoc ?? ""} onChange={(e) => setExistingDoc(e.target.value ? Number(e.target.value) : null)}>
                    <option value="">…or use a card already on this GRN</option>
                    {data.documents.map((d) => <option key={d.id} value={d.id}>{d.file_name}</option>)}
                  </select>
                )}
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted">Warranties on this GRN can no longer be changed.</p>
          )}
        </ModalBody>
        <ModalFooter className="flex flex-wrap items-center gap-3 border-t border-line/70 bg-content2/30 px-6 py-3.5">
          <p className="min-w-0 flex-1 text-xs text-muted">{editable ? blockReason ?? `Ready — ${picked.size} unit${picked.size === 1 ? "" : "s"} get this warranty.` : ""}</p>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {editable && (
            <>
              <Button variant="ghost" disabled={!!blockReason && blockReason !== "Tick the units this card covers." || save.isPending}
                      onClick={() => { setPicked(new Set(all)); save.mutate(all); }}
                      title="One card for every unit on this line">
                Same warranty for all {all.length}
              </Button>
              <Button disabled={!!blockReason || save.isPending} onClick={() => save.mutate([...picked])}>
                {save.isPending ? "Saving…" : `Save for ${picked.size} unit${picked.size === 1 ? "" : "s"}`}
              </Button>
            </>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
