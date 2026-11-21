import { useRef } from "react";
import {
  AlertTriangle, CalendarRange, CheckCircle2, Download, FileSpreadsheet, FileText, Layers,
  Paperclip, ScanLine, ShieldCheck, ShieldOff, Upload, Wand2, X,
} from "lucide-react";
import {
  entryProblem, hasCard, hasDates, plusYears, todayIso, type WarrantyEntry, type WarrantyMode,
} from "./warrantyDraft";

/**
 * The warranty half of the Serial / IMEI popup (2026-11-21). Presentational only —
 * the popup owns the state. Everything here is one decision away from the rows it
 * describes: choose HOW the warranty is given, then give it.
 */

const fieldCls = "h-9 w-full rounded-lg border border-line bg-content1 px-2 text-sm text-ink outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/20 disabled:bg-content2 disabled:text-muted";
const fmt = (iso?: string | null) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "");

/* ------------------------------------------------------------------ choose ---- */

const MODES: { mode: WarrantyMode; title: string; hint: (qty: number) => string; Icon: typeof Layers }[] = [
  { mode: "BATCH", title: "Whole batch", hint: (q) => `One warranty & card covers all ${q} units`, Icon: Layers },
  { mode: "UNIT", title: "Each piece", hint: () => "Every serial gets its own dates & card", Icon: ScanLine },
  { mode: null, title: "No warranty", hint: () => "Add it later — never blocks the GRN", Icon: ShieldOff },
];

export function WarrantyModeChooser({ mode, chosen, qty, disabled, onChoose }: {
  mode: WarrantyMode; chosen: boolean; qty: number; disabled?: boolean;
  onChoose: (mode: WarrantyMode) => void;
}) {
  // Asked big once; after that a one-line switch, so the rows keep the room.
  if (chosen) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-bold text-ink">
          <ShieldCheck className="h-4 w-4 text-brand" aria-hidden /> Warranty
        </span>
        <div className="inline-flex rounded-xl bg-content2 p-0.5 ring-1 ring-line" role="radiogroup" aria-label="How the warranty is given">
          {MODES.map(({ mode: m, title, hint, Icon }) => {
            const on = mode === m;
            return (
              <button key={String(m)} type="button" role="radio" aria-checked={on} disabled={disabled}
                      title={hint(qty)} onClick={() => onChoose(m)}
                      className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-60 ${
                        on ? "bg-brand text-white shadow-sm" : "text-ink-700 hover:bg-content1"}`}>
                <Icon className="h-3.5 w-3.5" aria-hidden /> {title}
              </button>
            );
          })}
        </div>
        <span className="text-[11px] text-muted">
          {mode === "BATCH" ? `One warranty covers all ${qty} units.`
            : mode === "UNIT" ? "Each serial has its own — columns on every row below."
            : "Add it whenever the card arrives — the GRN is never held for it."}
        </span>
      </div>
    );
  }
  return (
    <div className={`rounded-2xl border p-3 transition-colors ${chosen ? "border-line/80 bg-content2/30" : "border-warn/50 bg-warn-bg/30"}`}>
      <div className="mb-2 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-brand" aria-hidden />
        <span className="text-xs font-bold text-ink">How does this batch come with warranty?</span>
        {!chosen && <span className="text-[11px] font-medium text-warn">Choose one to start</span>}
      </div>
      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="How the warranty is given">
        {MODES.map(({ mode: m, title, hint, Icon }) => {
          const on = chosen && mode === m;
          return (
            <button key={String(m)} type="button" role="radio" aria-checked={on} disabled={disabled}
                    onClick={() => onChoose(m)}
                    className={`group flex min-h-14 items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-all active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 ${
                      on ? "border-brand bg-brand-050 shadow-sm ring-1 ring-brand/30" : "border-line bg-content1 hover:border-brand/40"}`}>
              <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg ${on ? "bg-brand text-white" : "bg-content2 text-ink-700 group-hover:text-brand"}`}>
                <Icon className="h-4 w-4" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-bold text-ink">{title}</span>
                <span className="block text-[11px] leading-snug text-muted">{hint(qty)}</span>
              </span>
              {on && <CheckCircle2 className="ml-auto h-4 w-4 shrink-0 text-brand" aria-hidden />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** "Switching replaces the 23 per-piece warranties" — asked inline, never a browser box. */
export function SwitchConfirm({ count, to, onYes, onNo }: {
  count: number; to: WarrantyMode; onYes: () => void; onNo: () => void;
}) {
  return (
    <div role="alertdialog" className="flex flex-wrap items-center gap-2 rounded-xl border border-warn/50 bg-warn-bg/60 px-3 py-2 text-xs">
      <AlertTriangle className="h-4 w-4 shrink-0 text-warn" aria-hidden />
      <span className="min-w-0 flex-1 font-medium text-ink">
        {to === "BATCH" ? "One warranty for the whole batch" : "No warranty"} replaces the {count} per-piece
        warrant{count === 1 ? "y" : "ies"} entered on this line.
      </span>
      <button type="button" onClick={onNo} className="min-h-8 rounded-lg px-2.5 font-semibold text-ink-700 hover:bg-content1">Keep each piece</button>
      <button type="button" onClick={onYes} className="min-h-8 rounded-lg bg-warn px-2.5 font-bold text-white hover:bg-warn/90">Replace them</button>
    </div>
  );
}

/* ------------------------------------------------------------------- dates ---- */

function YearChips({ start, end, onPick, disabled }: {
  start: string; end: string; onPick: (end: string, start: string) => void; disabled?: boolean;
}) {
  const from = start || todayIso();
  return (
    <div className="flex gap-1" role="group" aria-label="Warranty length">
      {[1, 2, 3, 5].map((y) => {
        const value = plusYears(from, y);
        const on = !!start && end === value;
        return (
          <button key={y} type="button" disabled={disabled} onClick={() => onPick(value, from)}
                  className={`min-h-9 min-w-10 rounded-lg border px-2 text-[11px] font-bold transition-colors ${
                    on ? "border-brand bg-brand-050 text-brand" : "border-line bg-content1 text-ink-700 hover:border-brand/40"}`}>
            {y} yr
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------- cards ---- */

/** A card picked here (not uploaded yet) or filed on the GRN, with a way to change it. */
export function CardChip({ entry, onPick, onClear, disabled, compact = false }: {
  entry: WarrantyEntry; onPick: () => void; onClear: () => void; disabled?: boolean; compact?: boolean;
}) {
  const name = entry.file?.name ?? entry.documentName ?? (entry.attachmentId ? "Card on file" : null);
  if (name) {
    return (
      <span className={`inline-flex max-w-full items-center gap-1 rounded-lg border px-1.5 ${compact ? "h-9" : "h-9"} ${
        entry.file ? "border-brand/30 bg-brand-050/60 text-brand" : "border-ok/30 bg-ok-bg/60 text-ok"}`}
            title={entry.file ? `${name} — uploads when you save` : name}>
        <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <button type="button" onClick={onPick} disabled={disabled}
                className="min-w-0 truncate text-[11px] font-semibold hover:underline">{name}</button>
        {!disabled && (
          <button type="button" onClick={onClear} aria-label={`Remove card ${name}`}
                  className="rounded p-0.5 hover:bg-black/5"><X className="h-3 w-3" aria-hidden /></button>
        )}
      </span>
    );
  }
  return (
    <button type="button" onClick={onPick} disabled={disabled}
            title={entry.fileHint ? `The sheet names ${entry.fileHint} — attach it with "Card files"` : "Upload the card — PDF or photo"}
            className={`inline-flex h-9 items-center gap-1 rounded-lg border border-dashed px-2 text-[11px] font-semibold transition-colors disabled:opacity-50 ${
              entry.fileHint ? "border-warn/50 text-warn" : "border-line text-muted hover:border-brand/50 hover:text-brand"}`}>
      <Upload className="h-3.5 w-3.5" aria-hidden />
      {compact ? (entry.fileHint ? "Needs file" : "Card") : "Upload card"}
    </button>
  );
}

/* ------------------------------------------------------------------- batch ---- */

export function BatchWarrantyForm({ entry, qty, onChange, onPickCard, disabled }: {
  entry: WarrantyEntry; qty: number; onChange: (patch: Partial<WarrantyEntry>) => void;
  onPickCard: () => void; disabled?: boolean;
}) {
  const problem = entryProblem(entry);
  return (
    <div className={`rounded-2xl border px-3 py-3 ${problem ? "border-bad/40 bg-bad-bg/20" : hasDates(entry) ? "border-ok/30 bg-ok-bg/20" : "border-line/80"}`}>
      <div className="grid items-end gap-x-3 gap-y-2 md:grid-cols-[9.5rem_9.5rem_auto_1fr_auto]">
        <label className="text-[11px] font-semibold text-muted">Starts
          <input type="date" value={entry.start} disabled={disabled} className={fieldCls}
                 onChange={(e) => onChange({ start: e.target.value })} aria-label="Batch warranty starts" />
        </label>
        <label className="text-[11px] font-semibold text-muted">Ends
          <input type="date" value={entry.end} min={entry.start || undefined} disabled={disabled} className={fieldCls}
                 onChange={(e) => onChange({ end: e.target.value })} aria-label="Batch warranty ends" />
        </label>
        <YearChips start={entry.start} end={entry.end} disabled={disabled}
                   onPick={(end, start) => onChange({ start, end })} />
        <label className="text-[11px] font-semibold text-muted">Card no. <span className="font-normal">(optional)</span>
          <input value={entry.cardNo} maxLength={100} disabled={disabled} className={fieldCls}
                 placeholder="As printed on the card" onChange={(e) => onChange({ cardNo: e.target.value })} />
        </label>
        <div>
          <CardChip entry={entry} onPick={onPickCard} disabled={disabled}
                    onClear={() => onChange({ file: null, attachmentId: null, documentName: null })} />
        </div>
      </div>
      <p className={`mt-2 flex items-center gap-1.5 text-[11px] font-medium ${problem ? "text-bad" : hasDates(entry) ? "text-ok" : "text-muted"}`}>
        {problem ? <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> : <CalendarRange className="h-3.5 w-3.5" aria-hidden />}
        {problem ?? (hasDates(entry)
          ? `Covers all ${qty} units · ${fmt(entry.start)} – ${fmt(entry.end)}${hasCard(entry) ? " · card attached" : " · no card yet"}`
          : `Give the start and end — it then covers all ${qty} units of this batch.`)}
      </p>
    </div>
  );
}

/* -------------------------------------------------------------- per piece ---- */

/** Fill the rows still without dates in one press; then each row only needs its card. */
export function FillEmptyBar({ draft, empty, onDraft, onApply, disabled }: {
  draft: WarrantyEntry; empty: number; onDraft: (patch: Partial<WarrantyEntry>) => void;
  onApply: () => void; disabled?: boolean;
}) {
  const ok = hasDates(draft) && !entryProblem(draft);
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-xl border border-line/80 bg-content2/40 px-3 py-2">
      <Wand2 className="mb-2.5 h-4 w-4 text-brand" aria-hidden />
      <label className="text-[11px] font-semibold text-muted">Starts
        <input type="date" value={draft.start} disabled={disabled} className={`${fieldCls} w-36`}
               onChange={(e) => onDraft({ start: e.target.value })} aria-label="Fill: warranty starts" />
      </label>
      <label className="text-[11px] font-semibold text-muted">Ends
        <input type="date" value={draft.end} min={draft.start || undefined} disabled={disabled} className={`${fieldCls} w-36`}
               onChange={(e) => onDraft({ end: e.target.value })} aria-label="Fill: warranty ends" />
      </label>
      <YearChips start={draft.start} end={draft.end} disabled={disabled} onPick={(end, start) => onDraft({ start, end })} />
      <button type="button" onClick={onApply} disabled={disabled || !ok || empty === 0}
              className="ml-auto inline-flex min-h-9 items-center gap-1.5 rounded-xl bg-brand px-3 text-xs font-bold text-white shadow-sm transition-all hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-40">
        <CalendarRange className="h-4 w-4" aria-hidden />
        {empty ? `Apply to the ${empty} row${empty === 1 ? "" : "s"} without dates` : "Every row has dates"}
      </button>
    </div>
  );
}

/** Excel template + upload, and many card files at once. */
export function BulkWarrantyBar({ onTemplate, onSheet, onCards, disabled, sheetLabel }: {
  onTemplate: () => void; onSheet: (file: File) => void; onCards: (files: File[]) => void;
  disabled?: boolean; sheetLabel: string;
}) {
  const sheetRef = useRef<HTMLInputElement>(null);
  const cardsRef = useRef<HTMLInputElement>(null);
  const btn = "inline-flex min-h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-semibold transition-colors disabled:opacity-50";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={onTemplate} className={`${btn} border-line bg-content1 text-ink-700 hover:border-brand/40 hover:text-brand`}>
        <Download className="h-4 w-4" aria-hidden /> Excel template
      </button>
      <button type="button" onClick={() => sheetRef.current?.click()} disabled={disabled}
              className={`${btn} border-ok/40 bg-ok-bg/40 text-ok hover:bg-ok-bg`}>
        <FileSpreadsheet className="h-4 w-4" aria-hidden /> {sheetLabel}
      </button>
      <button type="button" onClick={() => cardsRef.current?.click()} disabled={disabled}
              className={`${btn} border-brand/30 bg-brand-050/50 text-brand hover:bg-brand-050`}>
        <Paperclip className="h-4 w-4" aria-hidden /> Card files
      </button>
      <span className="text-[11px] text-muted">Name each card after its serial (SN0001.pdf), or list file names in the sheet.</span>
      <input ref={sheetRef} type="file" className="hidden" accept=".xlsx,.xls,.csv"
             onChange={(e) => { const f = e.target.files?.[0]; if (f) onSheet(f); e.target.value = ""; }} />
      <input ref={cardsRef} type="file" className="hidden" multiple accept="application/pdf,image/*"
             onChange={(e) => { const fs = [...(e.target.files ?? [])]; if (fs.length) onCards(fs); e.target.value = ""; }} />
    </div>
  );
}

/** What the last sheet or card upload did — the problems in full, so the file can be fixed. */
export function ImportReport({ tone, title, lines, onClose }: {
  tone: "ok" | "bad" | "warn"; title: string; lines: string[]; onClose: () => void;
}) {
  const cls = tone === "ok" ? "border-ok/40 bg-ok-bg/50 text-ok" : tone === "warn" ? "border-warn/40 bg-warn-bg/50 text-warn" : "border-bad/40 bg-bad-bg/50 text-bad";
  return (
    <div role="status" className={`rounded-xl border px-3 py-2 text-xs ${cls}`}>
      <div className="flex items-start gap-2">
        {tone === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
        <span className="min-w-0 flex-1 font-bold">{title}</span>
        <button type="button" onClick={onClose} aria-label="Dismiss" className="rounded p-0.5 hover:bg-black/5"><X className="h-3.5 w-3.5" aria-hidden /></button>
      </div>
      {lines.length > 0 && (
        <ul className="ml-6 mt-1 max-h-32 list-disc space-y-0.5 overflow-y-auto font-medium text-ink-700">
          {lines.slice(0, 50).map((line) => <li key={line}>{line}</li>)}
          {lines.length > 50 && <li>…and {lines.length - 50} more.</li>}
        </ul>
      )}
    </div>
  );
}

/** One unit's warranty cells in the row: starts, ends, card no., card. */
export function RowWarrantyCells({ entry, unit, onChange, onPickCard, disabled }: {
  entry: WarrantyEntry; unit: number; onChange: (patch: Partial<WarrantyEntry>) => void;
  onPickCard: () => void; disabled?: boolean;
}) {
  const problem = entryProblem(entry);
  const bad = (field: "start" | "end") => !!problem && (field === "end" ? !entry.end || entry.end < entry.start : !entry.start);
  return (
    <>
      <div className="px-1.5 py-1.5">
        <input type="date" value={entry.start} disabled={disabled} aria-label={`Warranty starts, unit ${unit}`}
               onChange={(e) => onChange({ start: e.target.value })}
               className={`${fieldCls} px-1.5 ${bad("start") ? "border-bad" : ""}`} />
      </div>
      <div className="px-1.5 py-1.5">
        <input type="date" value={entry.end} min={entry.start || undefined} disabled={disabled}
               aria-label={`Warranty ends, unit ${unit}`} onChange={(e) => onChange({ end: e.target.value })}
               className={`${fieldCls} px-1.5 ${bad("end") ? "border-bad" : ""}`} />
      </div>
      <div className="px-1.5 py-1.5">
        <input value={entry.cardNo} maxLength={100} disabled={disabled} placeholder="Card no."
               aria-label={`Warranty card no., unit ${unit}`} onChange={(e) => onChange({ cardNo: e.target.value })}
               className={fieldCls} />
      </div>
      <div className="min-w-0 px-1.5 py-1.5">
        <CardChip compact entry={entry} onPick={onPickCard} disabled={disabled}
                  onClear={() => onChange({ file: null, attachmentId: null, documentName: null })} />
      </div>
    </>
  );
}
