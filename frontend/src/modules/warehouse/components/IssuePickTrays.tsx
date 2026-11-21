import { useEffect, useMemo, useState } from "react";
import { Inbox, Plus, ScanLine, Trash2 } from "lucide-react";
import { SerialNumbersModal } from "./SerialNumbersModal";
import { Button, errorMessage } from "@/shared/components";
import type { IssueTray } from "../types";
import { num } from "../format";

/** "2", "2.5" — never "2.00": a tray count is said the way a storekeeper says it. */
const fmtQty = (v: number) => Number(num(v).toFixed(3)).toLocaleString("en-IN");
import { codesFree, leftOver, nextTrayNo, trayProblems } from "./trayPlan";

/**
 * Trays on one pick (MoM 2026-11-18, point 14) — the last step of a pick, after the
 * quantity and the lot: which tray it goes into, how much, and which codes.
 *
 * Each tray is a row: the tray number (typed, or scanned — a scanner types and presses
 * Enter), how much goes in, and the codes inside it as chips, picked from the pick's
 * own codes that no other tray holds yet. "Add tray" opens the next one already
 * numbered and holding whatever is left. A bar says how much of the pick is in trays.
 *
 * `mode`: "draft" edits straight into the document (saved with it); "direct" is an
 * approved issue, whose serials are scanned after approval — edits are held here and
 * saved with their own button; "view" only shows them.
 */
export function IssuePickTrays({ trays, issued, codes, uom, codeWord = "code", itemLabel = "", mode, onChange, onSave }: {
  trays?: IssueTray[] | null;
  issued: number;
  /** The pick's own codes — what a tray may hold. */
  codes: string[];
  uom?: string | null;
  codeWord?: string;
  /** The item, for the code picker's heading. */
  itemLabel?: string;
  mode: "draft" | "direct" | "view";
  onChange?: (trays: IssueTray[] | null) => void;
  onSave?: (trays: IssueTray[]) => Promise<unknown>;
}) {
  const saved = useMemo(() => trays ?? [], [trays]);
  const [local, setLocal] = useState<IssueTray[]>(saved);
  const [open, setOpen] = useState(saved.length > 0);
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [choosing, setChoosing] = useState<number | null>(null);
  useEffect(() => { setLocal(saved); if (saved.length) setOpen(true); }, [saved]);

  const list = mode === "direct" ? local : saved;
  const dirty = mode === "direct" && JSON.stringify(local) !== JSON.stringify(saved);
  const write = (next: IssueTray[]) => {
    if (mode === "direct") setLocal(next);
    else onChange?.(next.length ? next : null);
  };
  const patch = (index: number, change: Partial<IssueTray>) =>
    write(list.map((t, i) => (i === index ? { ...t, ...change } : t)));
  const left = leftOver(issued, list);
  const problems = trayProblems(issued, list);
  const pct = issued > 0 ? Math.min(100, Math.round(((issued - Math.max(left, 0)) / issued) * 100)) : 0;
  const editable = mode !== "view";

  if (!open && !list.length) {
    if (!editable || issued <= 0) return null;
    return (
      <button type="button" onClick={() => { setOpen(true); write([{ tray_no: nextTrayNo([]), quantity: issued, codes: [] }]); }}
              className="mt-1.5 inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-dashed border-line px-2.5 text-[11px] font-semibold text-muted hover:border-brand/40 hover:text-brand">
        <Inbox className="h-3.5 w-3.5" aria-hidden /> Put into trays
      </button>
    );
  }

  return (
    <div className="mt-1.5 rounded-lg border border-line/60 bg-content1/70 px-2 py-1.5" aria-label="Trays">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-brand">
          <Inbox className="h-3.5 w-3.5" aria-hidden /> Trays
        </span>
        <div className="h-1.5 min-w-[5rem] flex-1 overflow-hidden rounded-full bg-content3">
          <div className={`h-full rounded-full ${left === 0 ? "bg-ok" : left < 0 ? "bg-bad" : "bg-warn"}`} style={{ width: `${pct}%` }} />
        </div>
        <span className={`text-[11px] font-semibold tabular ${left === 0 ? "text-ok" : left < 0 ? "text-bad" : "text-warn"}`}>
          {left === 0 ? `All ${fmtQty(issued)} in trays`
            : left > 0 ? `${fmtQty(left)} ${uom ?? ""} not in a tray yet`
            : `${fmtQty(-left)} too many in trays`}
        </span>
      </div>

      <ul className="space-y-1">
        {list.map((tray, index) => {
          const rowProblem = problems.find((p) => p.index === index);
          return (
            <li key={index} className={`rounded-lg border px-2 py-1.5 ${rowProblem ? "border-bad/30 bg-bad-bg/20" : "border-line/50"}`}>
              <div className="flex flex-wrap items-center gap-1.5">
                {/* Wide enough for a real tray label ("TRAY-WH1-0042") and a 44 px tap target. */}
                <label className="flex min-w-0 flex-1 basis-56 items-center gap-1.5 text-[11px] font-semibold text-muted sm:flex-none">
                  Tray
                  <span className="relative min-w-0 flex-1">
                    <ScanLine className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
                    <input value={tray.tray_no} disabled={!editable} maxLength={60}
                           aria-label={`Tray number ${index + 1}`} placeholder="Scan or type"
                           onChange={(e) => patch(index, { tray_no: e.target.value })}
                           onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
                           className="mono h-10 w-full min-w-[12rem] rounded-lg border border-line bg-content1 pl-8 pr-2 text-sm font-semibold text-ink outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/20 disabled:bg-content2 sm:w-64" />
                  </span>
                </label>
                <label className="flex items-center gap-1.5 text-[11px] font-semibold text-muted">
                  Qty
                  <input type="number" min={0} step="any" value={tray.quantity} disabled={!editable}
                         aria-label={`Quantity in tray ${tray.tray_no || index + 1}`}
                         onChange={(e) => patch(index, { quantity: num(e.target.value) })}
                         className="h-10 w-28 rounded-lg border border-line bg-content1 px-2 text-right text-sm font-semibold tabular text-ink outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/20 disabled:bg-content2" />
                  {uom && <span className="text-[10px] text-muted">{uom}</span>}
                </label>
                {codes.length > 0 && (() => {
                  // A summary, never the list: the codes themselves are chosen and
                  // reviewed in the picker, so a tray of 50 stays one row tall.
                  const want = Math.floor(num(tray.quantity));
                  const have = tray.codes.length;
                  const full = want > 0 && have === want;
                  return (
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                      <button type="button" onClick={() => setChoosing(index)}
                              disabled={!editable && have === 0}
                              title={tray.codes.join(", ") || undefined}
                              className={`inline-flex min-h-10 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-colors disabled:opacity-50 ${
                                full ? "border-ok/40 bg-ok-bg/50 text-ok hover:border-ok"
                                  : have ? "border-warn/40 bg-warn-bg/40 text-warn hover:border-warn"
                                  : "border-brand/30 text-brand hover:bg-brand/5"}`}>
                        <ScanLine className="h-4 w-4" aria-hidden />
                        {editable ? (have ? `Change ${codeWord}s` : `Pick ${codeWord}s`) : `View ${codeWord}s`}
                        <span className="tabular">{have}/{fmtQty(want)}</span>
                      </button>
                      {have > 0 && (
                        <span className="mono min-w-0 truncate text-[11px] text-muted" title={tray.codes.join(", ")}>
                          {tray.codes.slice(0, 2).join(", ")}{have > 2 ? ` +${have - 2} more` : ""}
                        </span>
                      )}
                    </div>
                  );
                })()}
                {editable && (
                  <button type="button" aria-label={`Remove tray ${tray.tray_no || index + 1}`}
                          onClick={() => { setChoosing(null); write(list.filter((_, i) => i !== index)); }}
                          className="ml-auto inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted hover:bg-bad-bg hover:text-bad">
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              </div>
              {rowProblem && <p className="mt-0.5 text-[10px] font-semibold text-bad">{rowProblem.message}</p>}
            </li>
          );
        })}
      </ul>
      {problems.filter((p) => p.index === null).map((p) => (
        <p key={p.message} className="mt-1 text-[10px] font-semibold text-bad">{p.message}</p>
      ))}

      {editable && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <button type="button" disabled={left <= 0}
                  onClick={() => write([...list, { tray_no: nextTrayNo(list), quantity: Math.max(left, 0), codes: [] }])}
                  className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[11px] font-semibold text-brand hover:bg-brand/5 disabled:text-muted">
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add tray{left > 0 ? ` for the ${fmtQty(left)} left` : ""}
          </button>
          {mode === "direct" && (
            <Button className="ml-auto" disabled={!dirty || saving || problems.length > 0}
                    onClick={async () => {
                      setSaving(true); setSaveNote(null);
                      try {
                        await onSave?.(local);
                        setSaveNote({ ok: true, text: `Saved — ${local.map((t) => t.tray_no).join(", ") || "no trays"}.` });
                      } catch (error) {
                        setSaveNote({ ok: false, text: errorMessage(error) });
                      } finally { setSaving(false); }
                    }}>
              {saving ? "Saving…" : dirty ? "Save trays" : "Trays saved"}
            </Button>
          )}
          {saveNote && (
            <p role="status" className={`basis-full text-[11px] font-semibold ${saveNote.ok ? "text-ok" : "text-bad"}`}>{saveNote.text}</p>
          )}
        </div>
      )}
      {/* The codes going into one tray — the same picker QC and the consignment use:
        * this tray's codes ticked, plus every code of the pick no OTHER tray holds,
        * capped at the tray's quantity. */}
      {choosing !== null && list[choosing] && (
        <SerialNumbersModal
          isOpen
          onClose={() => setChoosing(null)}
          pickMode="select"
          noun={codeWord}
          readOnly={!editable}
          itemLabel={`Tray ${list[choosing].tray_no || choosing + 1}${itemLabel ? ` · ${itemLabel}` : ""}`}
          // Exactly the tray's quantity — or every code still on offer, when the pick
          // holds fewer than that (the rest are assigned on save).
          quantity={Math.min(Math.floor(num(list[choosing].quantity)), codesFree(codes, list, choosing).length)}
          available={codesFree(codes, list, choosing)}
          initial={list[choosing].codes}
          onSave={(picked) => {
            patch(choosing, { codes: picked.slice(0, Math.floor(num(list[choosing].quantity))) });
            setChoosing(null);
          }}
        />
      )}
    </div>
  );
}
