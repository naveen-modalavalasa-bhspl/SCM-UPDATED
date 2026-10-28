import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { motion } from "framer-motion";
import {
  AlertTriangle, ArrowLeft, ArrowRight, Box, Boxes, Check, ChevronDown, Info, Minus,
  Package, Plus, RotateCcw, ScanLine, Search, Sparkles, X,
} from "lucide-react";
import { Button } from "@/shared/components";
import { issueBoxSources } from "../api";
import type { BoxSource } from "../types";
import { fmtQty } from "../format";
import {
  cartonsTouched, coveredBy, groupLabel, indexPacks, isFree, judgeScan, mixOf, packNoun,
  pickSentence, planOf, plural, rollUp, setStripCount, shortCode, suggestPick,
  takeStripsUpTo, unitsOf, type PackGroup, type PackIndex, type PlanRow,
} from "../packPick";

/**
 * Pick an issue line's packages (2026-10-27, redrawn 2026-10-28).
 *
 * The screen answers one question — what do I take off this shelf — in a sentence at
 * the top, and opens with the answer already filled in: cartons already opened first,
 * whole packs while they fit, the remainder out of one box. The storekeeper reviews
 * and swaps; most days they press one button. The rules are `packPick.ts`.
 *
 * Each carton is drawn as a grid of its boxes, each box a bar of the strips inside it
 * (when the item has a second Issue level). Tap a box to take it whole, tap a strip to
 * take the strips up to there. Ten strips of ten is one box: `rollUp` turns them back
 * into the box, so a carton never reads "0" while its boxes have been emptied.
 *
 * What is checked is the Issue container, nothing else: the line names packs, and the
 * quantity is what those packs hold, the last one taken in part when the quantity does
 * not fill it (it leaves as a new part pack with its own code).
 *
 * `mode="units"` is the same flow for a serial or IMEI item, in two steps: the packages
 * narrow the shelf (suggested, like boxes), and then every serial / IMEI is chosen BY
 * HAND, one at a time — tapped or scanned off the unit itself. Nothing is ever
 * selected for the storekeeper: the number on the line must be the number on the
 * handset in his hand. Each is unique, must sit inside a chosen package, and there are
 * never more than the quantity.
 */
export function PackagePickerModal({
  open, onClose, onSave, onPickIndividually, itemLabel, warehouseId, itemId, batchId, binId,
  issueId, quantity, initial, readOnly = false, uom, mode = "boxes", unitNoun = "serial",
}: {
  open: boolean;
  onClose: () => void;
  /** The box codes in order (boxes), or the serials / IMEIs chosen (units). */
  onSave: (codes: string[]) => void;
  /** Units mode: leave the packages and pick serials one by one instead. */
  onPickIndividually?: () => void;
  itemLabel: string;
  warehouseId?: number | null;
  itemId?: number | null;
  batchId?: number | null;
  binId?: number | null;
  issueId?: number | null;
  quantity: number;
  initial: string[];
  readOnly?: boolean;
  uom?: string | null;
  mode?: "boxes" | "units";
  unitNoun?: string;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [units, setUnits] = useState<string[]>([]);
  const [step, setStep] = useState<"packs" | "units">("packs");
  const [scan, setScan] = useState("");
  const [verdict, setVerdict] = useState<{ tone: "ok" | "bad"; text: string; n: number } | null>(null);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [showCodes, setShowCodes] = useState(false);
  const seeded = useRef(false);

  const sources = useQuery({
    queryKey: ["issue-box-sources", warehouseId, itemId, batchId, binId, issueId, mode],
    queryFn: () => issueBoxSources({
      warehouse_id: Number(warehouseId), item_id: Number(itemId),
      batch_id: batchId || undefined, bin_id: binId || undefined,
      issue_id: issueId || undefined, with_units: mode === "units" || undefined,
    }),
    enabled: open && !!warehouseId && !!itemId,
  });
  const packs = useMemo(() => sources.data ?? [], [sources.data]);
  const idx = useMemo(() => indexPacks(packs), [packs]);
  const suggestion = useMemo(() => suggestPick(idx, quantity), [idx, quantity]);

  // Seed once per opening: what the line already names, else the suggestion.
  useEffect(() => {
    if (!open) return;
    seeded.current = false;
    setScan("");
    setVerdict(null);
    setOpenGroups({});
    setShowCodes(false);
    setStep(mode === "units" && initial.length ? "units" : "packs");
    if (mode === "boxes" && initial.length) {
      setPicked(initial);
      seeded.current = true;
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open || !sources.data || seeded.current) return;
    seeded.current = true;
    if (mode === "units") {
      // Only what the storekeeper already chose comes back — never a fill.
      setUnits(initial);
      if (initial.length) {
        const wanted = new Set(initial);
        const holding = sources.data.filter((p) => unitsOf(p, idx).some((u) => wanted.has(u)));
        setPicked(holding.filter((p) => !holding.some((q) => q.id === p.parent_id)).map((p) => p.code));
        return;
      }
    }
    setPicked(readOnly ? [] : suggestion);
  }, [open, sources.data, idx, suggestion]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => planOf(picked, idx, quantity), [picked, idx, quantity]);
  const covered = rows.reduce((s, r) => s + r.take, 0);
  const short = Math.max(0, quantity - covered);
  const pct = quantity > 0 ? Math.min(100, Math.round((covered / quantity) * 100)) : 0;
  const complete = short < 1e-6 && rows.some((r) => r.take > 0);
  const firstPack = idx.groups[0]?.packs[0] ?? packs[0];
  const packName = packNoun(firstPack, "box");
  const sentence = pickSentence(rows, idx);
  const mix = mixOf(rows);
  const cartons = cartonsTouched(rows, idx);
  const isSuggested = picked.length === suggestion.length && picked.every((c, i) => c === suggestion[i]);
  const suggestedCartons = cartonsTouched(planOf(suggestion, idx, quantity), idx);
  const canCoverMore = short > 1e-6 && packs.some((p) => isFree(p) && !picked.includes(p.code)
    && !coveredBy(p, picked, idx));
  const unit = uom ?? "";

  // ---- what the pick will do, said before the press ----
  const notes = useMemo(() => {
    const out: { key: string; text: string; action?: "suggest" }[] = [];
    for (const [boxId, strips] of idx.inner) {
      const box = idx.byId.get(boxId);
      if (!box || picked.includes(box.code)) continue;
      const taken = strips.filter((s) => picked.includes(s.code)).length;
      if (taken > 0) {
        const name = packNoun(strips[0], "strip");
        out.push({ key: `open-${boxId}`, text: `${packNoun(box)} ${shortCode(box.code)} is opened — ${taken} ${plural(name, taken)} leave, ${strips.length - taken} stay on the shelf in it.` });
      }
    }
    const part = rows.find((r) => r.p && r.take > 0 && r.take < r.p.holds - 1e-6);
    if (part?.p) {
      const name = packNoun(part.p);
      out.push({ key: "part", text: `${name} ${shortCode(part.code)} gives ${fmtQty(part.take)} ${unit} — that leaves as a new part ${name} with its own code; ${fmtQty(part.p.holds - part.take)} stay under ${shortCode(part.code)}.` });
    }
    if (!readOnly && cartons > suggestedCartons && suggestion.length) {
      out.push({ key: "cartons", action: "suggest", text: `This pick opens ${cartons} cartons — the suggestion covers it from ${suggestedCartons}.` });
    }
    if (short > 1e-6 && !canCoverMore && rows.length) {
      out.push({ key: "short", text: `This batch and location hold only ${fmtQty(covered)} ${unit} for this line — the other ${fmtQty(short)} cannot come from here.` });
    }
    return out;
  }, [idx, picked, rows, cartons, suggestedCartons, suggestion.length, short, canCoverMore, covered, unit, readOnly]);

  // ---- choosing ----
  const commit = (next: string[]) => { if (!readOnly) setPicked(rollUp(next, idx)); };
  const toggle = (p: BoxSource) => {
    if (readOnly || !isFree(p) || coveredBy(p, picked, idx)) return;
    if (picked.includes(p.code)) return commit(picked.filter((c) => c !== p.code));
    // Taking a box whole releases any strips already taken out of it.
    const inner = new Set((idx.inner.get(p.id) ?? []).map((q) => q.code));
    commit([...picked.filter((c) => !inner.has(c)), p.code]);
  };
  const setWhole = (g: PackGroup, n: number) => {
    const chosen = g.packs.filter((p) => picked.includes(p.code));
    if (n === chosen.length) return;
    if (n < chosen.length) {
      const drop = new Set(chosen.slice(n).map((p) => p.code));
      return commit(picked.filter((c) => !drop.has(c)));
    }
    const add = g.packs.filter((p) => isFree(p) && !picked.includes(p.code))
      .slice(0, n - chosen.length);
    const inner = new Set(add.flatMap((p) => (idx.inner.get(p.id) ?? []).map((q) => q.code)));
    commit([...picked.filter((c) => !inner.has(c)), ...add.map((p) => p.code)]);
  };
  const doScan = () => {
    const code = scan.trim();
    setScan("");
    if (!code) return;
    const v = judgeScan(code, picked, idx);
    setVerdict({ tone: v.tone, text: v.text, n: Date.now() });
    if (v.tone === "ok") commit(v.next);
  };

  // ---- units mode: the serials inside the chosen packages ----
  const need = Math.max(0, Math.floor(quantity));
  const offered = useMemo(() => {
    if (mode !== "units") return [] as { code: string; box: string }[];
    const out: { code: string; box: string }[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      if (!r.p) continue;
      for (const u of unitsOf(r.p, idx)) {
        if (seen.has(u)) continue;
        seen.add(u);
        out.push({ code: u, box: r.p.code });
      }
    }
    return out;
  }, [rows, idx, mode]);
  const offeredSet = useMemo(() => new Set(offered.map((u) => u.code)), [offered]);
  // A serial counts only while its package is still chosen; releasing a box releases
  // whatever was picked out of it.
  const chosenUnits = useMemo(() => units.filter((u) => offeredSet.has(u)), [units, offeredSet]);

  const save = () => {
    onSave(mode === "units" ? chosenUnits : picked);
    onClose();
  };
  const inUnits = mode === "units" && step === "units";

  return (
    <Modal isOpen={open} onOpenChange={(o) => { if (!o) onClose(); }} size="4xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1 border-b border-line/70">
          <span className="flex items-center gap-2 text-base font-semibold text-ink">
            <Boxes className="h-4 w-4 text-brand" aria-hidden />
            {mode === "units" ? `Pick the ${unitNoun}s` : "Pick packages"}
          </span>
          <span className="truncate text-xs font-normal text-muted">{itemLabel}</span>
          {mode === "units" && (
            <ol className="mt-2 flex items-center gap-2 text-xs" aria-label="Steps">
              <StepChip n={1} on={step === "packs"} done={picked.length > 0}
                        label="Packages" hint={mix || "narrow the shelf"} onClick={() => setStep("packs")} />
              <ArrowRight className="h-3.5 w-3.5 text-muted" aria-hidden />
              <StepChip n={2} on={step === "units"} done={need > 0 && chosenUnits.length === need}
                        label={`${unitNoun[0].toUpperCase()}${unitNoun.slice(1)}s`}
                        hint={`${chosenUnits.length} / ${need}`}
                        onClick={() => picked.length && setStep("units")} disabled={!picked.length} />
            </ol>
          )}
        </ModalHeader>

        <ModalBody className="gap-4 py-4">
          {inUnits ? (
            <UnitsStep need={need} unitNoun={unitNoun} offered={offered} chosen={chosenUnits}
                       readOnly={readOnly} packName={packName}
                       onChange={(next) => setUnits(next)} />
          ) : (
            <>
              {/* ---- the answer, in one sentence ---- */}
              <section className="rounded-2xl border border-line bg-gradient-to-br from-brand-050/60 via-content1 to-content1 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-lg font-semibold leading-snug text-ink first-letter:uppercase">
                      {sources.isLoading ? "Reading the shelf…" : sentence}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      <span className={`font-semibold tabular ${complete ? "text-ok" : "text-warn"}`}>
                        {fmtQty(covered)} of {fmtQty(quantity)} {unit}
                      </span>
                      {complete && <> · <Check className="inline h-3.5 w-3.5 text-ok" aria-hidden /> complete</>}
                      {!complete && short > 0 && rows.length > 0 && <> · {fmtQty(short)} {unit} to go</>}
                    </p>
                  </div>
                  {!readOnly && (
                    isSuggested && picked.length ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-brand/10 px-2.5 py-1 text-[11px] font-semibold text-brand">
                        <Sparkles className="h-3.5 w-3.5" aria-hidden /> Suggested · fewest cartons opened
                      </span>
                    ) : suggestion.length > 0 && (
                      <button type="button" onClick={() => setPicked(suggestion)}
                              className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-brand hover:bg-brand-050">
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reset to suggestion
                      </button>
                    )
                  )}
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-content2">
                  <motion.div className={`h-full rounded-full ${complete ? "bg-ok" : "bg-brand"}`}
                              initial={false} animate={{ width: `${rows.length ? pct : 0}%` }}
                              transition={{ duration: 0.2 }} />
                </div>
              </section>

              {/* ---- scanning, the floor's own way in ---- */}
              {!readOnly && (
                <div>
                  <label className="flex h-12 items-center gap-2 rounded-xl border border-line bg-content1 px-3 focus-within:border-brand">
                    <ScanLine className="h-5 w-5 shrink-0 text-brand" aria-hidden />
                    <input value={scan} onChange={(e) => setScan(e.target.value)}
                           onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); doScan(); } }}
                           placeholder={`Scan a ${packName} label to add or remove it`}
                           aria-label="Scan a package code"
                           className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
                  </label>
                  {verdict && (
                    <motion.p key={verdict.n} role="status"
                              initial={{ opacity: 0, x: 0 }}
                              animate={verdict.tone === "bad" ? { opacity: 1, x: [0, -6, 6, -4, 4, 0] } : { opacity: 1 }}
                              transition={{ duration: 0.3 }}
                              className={`mt-1.5 flex items-center gap-1.5 text-xs font-semibold ${verdict.tone === "ok" ? "text-ok" : "text-bad"}`}>
                      {verdict.tone === "ok" ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                      {verdict.text}
                    </motion.p>
                  )}
                </div>
              )}

              {/* ---- what the pick will do ---- */}
              {notes.length > 0 && (
                <ul className="space-y-1.5">
                  {notes.map((n) => (
                    <li key={n.key} className="flex items-start gap-2 rounded-xl bg-warn-bg/60 px-3 py-2 text-xs text-ink-700">
                      {n.key === "short" ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
                        : <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />}
                      <span className="flex-1 first-letter:uppercase">{n.text}</span>
                      {n.action === "suggest" && (
                        <button type="button" onClick={() => setPicked(suggestion)}
                                className="shrink-0 font-semibold text-brand hover:underline">Use the suggestion</button>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {/* ---- the cartons ---- */}
              {sources.isLoading ? (
                <div className="space-y-3" aria-hidden>
                  {[0, 1].map((i) => <div key={i} className="h-28 animate-pulse rounded-2xl bg-content2" />)}
                </div>
              ) : idx.groups.length === 0 ? (
                <div className="grid place-items-center rounded-xl border border-dashed border-line px-4 py-10 text-center">
                  <Package className="h-5 w-5 text-muted" aria-hidden />
                  <p className="mt-2 text-sm text-muted">No {plural(packName, 2)} of this item at this batch and location.</p>
                </div>
              ) : (
                <ul className="space-y-3">
                  {idx.groups.map((g) => {
                    const touched = rows.some((r) => r.p && r.take > 0 && idx.groupOf.get(r.code) === g.key);
                    const expanded = openGroups[g.key] ?? (touched || idx.groups.length <= 2);
                    return (
                      <CartonSection key={g.key} g={g} idx={idx} picked={picked} rows={rows}
                                     readOnly={readOnly} expanded={expanded}
                                     onExpand={() => setOpenGroups((s) => ({ ...s, [g.key]: !expanded }))}
                                     onWhole={(n) => setWhole(g, n)} onToggle={toggle}
                                     onStripTap={(box, j) => commit(takeStripsUpTo(picked, box, j, idx))}
                                     onStrips={(box, n) => commit(setStripCount(picked, box, n, idx))} />
                    );
                  })}
                </ul>
              )}

              {/* ---- codes named that are not on this shelf, and the codes themselves ---- */}
              {rows.some((r) => !r.p) && (
                <div className="flex flex-wrap gap-1.5">
                  {rows.filter((r) => !r.p).map((r) => (
                    <span key={r.code} className="mono inline-flex items-center gap-1 rounded-full border border-line bg-content2 px-2.5 py-1 text-[11px] text-ink-700">
                      {r.code} · checked on save
                      {!readOnly && (
                        <button type="button" aria-label={`Remove ${r.code}`}
                                onClick={() => setPicked((now) => now.filter((c) => c !== r.code))}
                                className="text-muted hover:text-bad"><X className="h-3 w-3" /></button>
                      )}
                    </span>
                  ))}
                </div>
              )}
              {picked.length > 0 && (
                <div>
                  <button type="button" onClick={() => setShowCodes((s) => !s)}
                          className="inline-flex min-h-9 items-center gap-1 text-xs font-semibold text-muted hover:text-ink">
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showCodes ? "rotate-180" : ""}`} />
                    {showCodes ? "Hide" : "Show"} the {picked.length} code{picked.length === 1 ? "" : "s"}
                  </button>
                  {showCodes && (
                    <ol className="mt-1.5 flex flex-wrap gap-1.5">
                      {rows.map((r, i) => (
                        <li key={r.code} className="mono rounded-md bg-content2 px-2 py-1 text-[11px] text-ink-700" title={r.p ? packNoun(r.p) : undefined}>
                          <span className="text-muted">{i + 1}.</span> {r.code}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              )}
            </>
          )}
        </ModalBody>

        <ModalFooter className="flex flex-wrap items-center justify-between gap-3 border-t border-line/70">
          <div className="min-w-0 text-sm">
            {inUnits ? (
              <span className="text-muted">
                <span className="font-semibold text-ink">{chosenUnits.length} of {need}</span> {plural(unitNoun, need)} chosen
                {mix && <> · from {mix}</>}
              </span>
            ) : rows.some((r) => r.take > 0) ? (
              <span className="text-muted">
                <span className="font-semibold text-ink">{mix}</span> · {fmtQty(covered)} {unit}
                {cartons > 0 && idx.groups.some((g) => g.code) && <> · {cartons} {plural("carton", cartons)}</>}
              </span>
            ) : mode === "units" && onPickIndividually ? (
              <button type="button" onClick={onPickIndividually}
                      className="inline-flex min-h-9 items-center gap-1 font-semibold text-brand hover:underline">
                <ScanLine className="h-4 w-4" /> Skip packages — pick from every {unitNoun}
              </button>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {mode === "units" && onPickIndividually && rows.some((r) => r.take > 0) && !inUnits && (
              <Button variant="ghost" onClick={onPickIndividually}>Skip packages</Button>
            )}
            {inUnits && <Button variant="ghost" onClick={() => setStep("packs")}><ArrowLeft size={14} /> Packages</Button>}
            <Button variant="ghost" onClick={onClose}>{readOnly ? "Close" : "Cancel"}</Button>
            {!readOnly && (mode === "units" && !inUnits ? (
              <Button onClick={() => setStep("units")} disabled={!picked.length}>
                Next: choose {plural(unitNoun, 2)} <ArrowRight size={14} />
              </Button>
            ) : mode === "units" ? (
              <Button onClick={save} disabled={chosenUnits.length === 0}>
                <Check size={14} />
                {chosenUnits.length < need ? `Use these ${chosenUnits.length}` : "Use these"}
              </Button>
            ) : canCoverMore && rows.length > 0 ? (
              <Button disabled>Still need {fmtQty(short)} {unit}</Button>
            ) : (
              <Button onClick={save} disabled={!picked.length && packs.length > 0}>
                <Check size={14} /> Confirm pick
              </Button>
            ))}
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function StepChip({ n, on, done, label, hint, onClick, disabled }: {
  n: number; on: boolean; done: boolean; label: string; hint: string;
  onClick: () => void; disabled?: boolean;
}) {
  return (
    <li>
      <button type="button" onClick={onClick} disabled={disabled} aria-current={on ? "step" : undefined}
              className={`inline-flex min-h-9 items-center gap-2 rounded-full border px-3 transition-colors disabled:opacity-50 ${
                on ? "border-brand bg-brand/10 text-brand" : "border-line text-muted hover:border-brand/60"}`}>
        <span className={`grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold ${
          done ? "bg-ok text-white" : on ? "bg-brand text-white" : "bg-content2 text-muted"}`}>
          {done ? <Check className="h-3 w-3" /> : n}
        </span>
        <span className="font-semibold">{label}</span>
        <span className="text-[11px] opacity-80">{hint}</span>
      </button>
    </li>
  );
}

/** One carton: what it gives, a stepper of whole boxes, and its boxes as a grid. */
function CartonSection({ g, idx, picked, rows, readOnly, expanded, onExpand, onWhole, onToggle, onStripTap, onStrips }: {
  g: PackGroup; idx: PackIndex; picked: string[]; rows: PlanRow[]; readOnly: boolean;
  expanded: boolean; onExpand: () => void; onWhole: (n: number) => void;
  onToggle: (p: BoxSource) => void; onStripTap: (box: BoxSource, j: number) => void;
  onStrips: (box: BoxSource, n: number) => void;
}) {
  const mine = rows.filter((r) => r.p && r.take > 0 && idx.groupOf.get(r.code) === g.key);
  const gives = mixOf(mine);
  const whole = g.packs.filter((p) => picked.includes(p.code)).length;
  const free = g.packs.filter(isFree).length;
  const name = packNoun(g.packs[0], "box");
  return (
    <li className={`overflow-hidden rounded-2xl border transition-colors ${
      mine.length ? "border-brand/50 bg-brand-050/30" : "border-line bg-content1"}`}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-content2 text-brand">
          {g.code ? <Boxes className="h-5 w-5" /> : <Box className="h-5 w-5" />}
        </span>
        <button type="button" onClick={onExpand} aria-expanded={expanded} className="min-w-0 flex-1 text-left">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-ink first-letter:uppercase" title={g.code ?? undefined}>
              {groupLabel(g)}
            </span>
            {g.code && (
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                g.opened ? "bg-warn-bg text-warn" : "bg-content2 text-muted"}`}>
                {g.opened ? "Opened" : "Full"}
              </span>
            )}
            <ChevronDown className={`h-4 w-4 shrink-0 text-muted transition-transform ${expanded ? "rotate-180" : ""}`} />
          </span>
          <span className="mt-0.5 block text-xs">
            {gives
              ? <span className="font-semibold text-brand">Giving {gives}</span>
              : <span className="text-muted">{g.packs.length} {plural(name, g.packs.length)} · {free} free</span>}
          </span>
        </button>
        {!readOnly && (
          <div className="flex items-center gap-1.5">
            <span className="mr-1 text-[11px] text-muted">Whole {plural(name, 2)}</span>
            <IconStep label={`One fewer ${name}`} disabled={whole === 0} onClick={() => onWhole(whole - 1)}><Minus className="h-4 w-4" /></IconStep>
            <span className="w-8 text-center text-base font-bold tabular text-ink">{whole}</span>
            <IconStep label={`One more ${name}`} disabled={whole >= free} onClick={() => onWhole(whole + 1)}><Plus className="h-4 w-4" /></IconStep>
          </div>
        )}
      </div>
      {expanded && (
        <div className="grid grid-cols-2 gap-2 border-t border-line/70 bg-content1/60 p-3 sm:grid-cols-3 md:grid-cols-4">
          {g.packs.map((p) => (
            <BoxTile key={p.id} p={p} idx={idx} picked={picked} rows={rows} readOnly={readOnly}
                     onToggle={onToggle} onStripTap={(j) => onStripTap(p, j)} onStrips={(n) => onStrips(p, n)} />
          ))}
        </div>
      )}
    </li>
  );
}

function IconStep({ label, disabled, onClick, children }: {
  label: string; disabled?: boolean; onClick: () => void; children: ReactNode;
}) {
  return (
    <button type="button" aria-label={label} disabled={disabled} onClick={onClick}
            className="grid h-11 w-11 place-items-center rounded-xl border border-line bg-content1 hover:border-brand disabled:opacity-40">
      {children}
    </button>
  );
}

const HATCH = { backgroundImage: "repeating-linear-gradient(135deg, rgb(148 163 184 / .45) 0 3px, transparent 3px 6px)" };

/** One box: tap to take it whole; its strips as a bar, tap one to take up to there. */
function BoxTile({ p, idx, picked, rows, readOnly, onToggle, onStripTap, onStrips }: {
  p: BoxSource; idx: PackIndex; picked: string[]; rows: PlanRow[]; readOnly: boolean;
  onToggle: (p: BoxSource) => void; onStripTap: (j: number) => void; onStrips: (n: number) => void;
}) {
  const free = isFree(p);
  const order = picked.indexOf(p.code);
  const whole = order >= 0;
  const row = whole ? rows[order] : undefined;
  const partTake = row && row.take > 0 && row.take < p.holds - 1e-6 ? row.take : null;
  const strips = idx.inner.get(p.id) ?? [];
  const stripName = packNoun(strips[0], "strip");
  const freeStrips = strips.filter(isFree);
  const stripsTaken = whole ? freeStrips.length : strips.filter((s) => picked.includes(s.code)).length;
  const stripRow = (s: BoxSource) => rows.find((r) => r.code === s.code);
  const name = packNoun(p);

  const status = !free ? <span className="text-warn">Held by {p.held_by}</span>
    : partTake != null ? <span className="text-warn">Gives {fmtQty(partTake)} — the rest stays</span>
      : whole ? <span className="text-brand">Whole {name}</span>
        : stripsTaken > 0 ? <span className="text-brand">{stripsTaken} of {strips.length} {plural(stripName, strips.length)}</span>
          : <span className="text-muted">{fmtQty(p.holds)} of {fmtQty(p.size)}{p.part ? " · part" : ""}</span>;

  return (
    <div className={`rounded-xl border p-2.5 transition-colors ${
      whole ? "border-brand bg-brand/[0.06]" : stripsTaken > 0 ? "border-brand/50 bg-content1"
        : !free ? "border-line bg-content2/40" : "border-line bg-content1 hover:border-brand/50"}`}>
      <button type="button" onClick={() => onToggle(p)} disabled={readOnly || !free}
              aria-pressed={whole} title={p.code}
              className="flex min-h-11 w-full items-center gap-2 text-left disabled:cursor-not-allowed">
        <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-md border text-[11px] font-bold ${
          whole ? "border-brand bg-brand text-white" : "border-line text-transparent"}`}>
          {whole ? order + 1 : <Check className="h-3.5 w-3.5" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="mono block truncate text-[13px] font-semibold text-ink">{shortCode(p.code)}</span>
          <span className="block truncate text-[11px] font-medium">{status}</span>
        </span>
      </button>

      {/* The strips inside, or the box's own fill when it has no inner level. */}
      <div className="mt-2 flex h-6 gap-[2px]" role={strips.length ? "group" : undefined}
           aria-label={strips.length ? `${plural(stripName, 2)} in ${shortCode(p.code)}` : undefined}>
        {strips.length ? strips.map((s, j) => {
          const sFree = isFree(s);
          const taken = whole || picked.includes(s.code);
          const sRow = stripRow(s);
          const part = !whole && sRow && sRow.take > 0 && sRow.take < s.holds - 1e-6;
          return (
            <button key={s.id} type="button" title={`${s.code} · ${fmtQty(s.holds)}`}
                    aria-label={`${stripName} ${j + 1}${taken ? ", taken" : ""}`}
                    disabled={readOnly || !free || !sFree}
                    onClick={() => onStripTap(j)}
                    style={!sFree ? HATCH : undefined}
                    className={`flex-1 rounded-[3px] transition-colors first:rounded-l-md last:rounded-r-md disabled:cursor-not-allowed ${
                      !sFree ? "bg-content2" : part ? "bg-warn" : taken ? (whole && partTake != null ? "bg-warn/80" : "bg-brand")
                        : "bg-content2 hover:bg-brand/30"}`} />
          );
        }) : (
          <div className="relative flex-1 overflow-hidden rounded-md bg-content2" style={!free ? HATCH : undefined}>
            <div className={`absolute inset-y-0 left-0 ${partTake != null ? "bg-warn" : whole ? "bg-brand" : "bg-brand/25"}`}
                 style={{ width: `${Math.round(((whole ? (row?.take ?? p.holds) : p.holds) / (p.size || 1)) * 100)}%` }} />
          </div>
        )}
      </div>

      {strips.length > 0 && free && !readOnly && (
        <div className="mt-2 flex items-center justify-between gap-1 text-[11px]">
          <span className="text-muted">{plural(stripName, 2)}</span>
          <span className="flex items-center gap-1">
            <button type="button" aria-label={`One fewer ${stripName}`} disabled={stripsTaken === 0}
                    onClick={() => onStrips(stripsTaken - 1)}
                    className="grid h-9 w-9 place-items-center rounded-lg border border-line hover:border-brand disabled:opacity-40">
              <Minus className="h-3.5 w-3.5" />
            </button>
            <span className="w-11 text-center font-bold tabular text-ink">{stripsTaken}/{freeStrips.length}</span>
            <button type="button" aria-label={`One more ${stripName}`} disabled={stripsTaken >= freeStrips.length}
                    onClick={() => onStrips(stripsTaken + 1)}
                    className="grid h-9 w-9 place-items-center rounded-lg border border-line hover:border-brand disabled:opacity-40">
              <Plus className="h-3.5 w-3.5" />
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

/** Step 2 of a serial / IMEI line: every number chosen by hand. Never a fill. */
function UnitsStep({ need, unitNoun, offered, chosen, readOnly, packName, onChange }: {
  need: number; unitNoun: string; offered: { code: string; box: string }[]; chosen: string[];
  readOnly: boolean; packName: string; onChange: (next: string[]) => void;
}) {
  const [scan, setScan] = useState("");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<{ text: string; n: number } | null>(null);
  const full = chosen.length >= need;
  const fail = (text: string) => setError({ text, n: Date.now() });

  const toggle = (code: string) => {
    if (readOnly) return;
    setError(null);
    if (chosen.includes(code)) return onChange(chosen.filter((u) => u !== code));
    if (full) return fail(`All ${need} ${plural(unitNoun, need)} are chosen — remove one to swap it.`);
    onChange([...chosen, code]);
  };
  const addScan = () => {
    const code = scan.trim();
    setScan("");
    if (!code) return;
    const hit = offered.find((u) => u.code.toLowerCase() === code.toLowerCase());
    if (!hit) return fail(`${code} is not inside the ${plural(packName, 2)} chosen in step 1.`);
    if (chosen.includes(hit.code)) return fail(`${hit.code} is already chosen — each ${unitNoun} once.`);
    toggle(hit.code);
  };

  const left = offered.filter((u) => !chosen.includes(u.code)
    && (!filter || u.code.toLowerCase().includes(filter.toLowerCase())));
  const byBox = new Map<string, string[]>();
  for (const u of left) byBox.set(u.box, [...(byBox.get(u.box) ?? []), u.code]);
  const pct = need ? Math.min(1, chosen.length / need) : 0;

  return (
    <div className="space-y-4">
      <section className="flex items-center gap-4 rounded-2xl border border-line bg-gradient-to-br from-brand-050/60 via-content1 to-content1 p-4">
        <svg viewBox="0 0 44 44" className="h-16 w-16 shrink-0 -rotate-90" aria-hidden>
          <circle cx="22" cy="22" r="19" fill="none" strokeWidth="5" className="stroke-content2" />
          <motion.circle cx="22" cy="22" r="19" fill="none" strokeWidth="5" strokeLinecap="round"
                         className={full ? "stroke-ok" : "stroke-brand"}
                         strokeDasharray={2 * Math.PI * 19}
                         initial={false} animate={{ strokeDashoffset: 2 * Math.PI * 19 * (1 - pct) }}
                         transition={{ duration: 0.25 }} />
        </svg>
        <div className="min-w-0">
          <p className="text-lg font-semibold text-ink tabular">{chosen.length} of {need} {plural(unitNoun, need)}</p>
          <p className="text-xs text-muted">
            {full ? "Every one is chosen." : `Scan each unit, or tap its ${unitNoun} below. Nothing is chosen for you.`}
          </p>
        </div>
      </section>

      {!readOnly && (
        <div>
          <label className="flex h-12 items-center gap-2 rounded-xl border border-line bg-content1 px-3 focus-within:border-brand">
            <ScanLine className="h-5 w-5 shrink-0 text-brand" aria-hidden />
            <input value={scan} autoFocus
                   onChange={(e) => { setScan(e.target.value); setError(null); }}
                   onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addScan(); } }}
                   placeholder={full ? `All ${need} chosen` : `Scan the ${unitNoun} on the unit`}
                   aria-label={`Scan a ${unitNoun}`} disabled={full}
                   className="min-w-0 flex-1 bg-transparent text-sm outline-none disabled:opacity-50" />
          </label>
          {error && (
            <motion.p key={error.n} role="alert" initial={{ x: 0 }} animate={{ x: [0, -6, 6, -4, 4, 0] }}
                      transition={{ duration: 0.3 }}
                      className="mt-1.5 flex items-center gap-1.5 text-xs font-semibold text-bad">
              <X className="h-3.5 w-3.5" /> {error.text}
            </motion.p>
          )}
        </div>
      )}

      {chosen.length > 0 && (
        <ol className="flex flex-wrap gap-1.5">
          {chosen.map((code, i) => (
            <li key={code} className="mono inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-brand px-2.5 text-[12px] text-white">
              <span className="opacity-70">{i + 1}.</span> {code}
              {!readOnly && (
                <button type="button" aria-label={`Remove ${code}`} onClick={() => toggle(code)}
                        className="grid h-6 w-6 place-items-center rounded opacity-80 hover:bg-white/15 hover:opacity-100">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ol>
      )}

      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted">
            Still in the chosen {plural(packName, 2)}
          </span>
          {offered.length > 20 && (
            <label className="flex h-9 items-center gap-1.5 rounded-lg border border-line px-2 focus-within:border-brand">
              <Search className="h-3.5 w-3.5 text-muted" aria-hidden />
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find"
                     aria-label={`Find a ${unitNoun}`} className="w-32 bg-transparent text-xs outline-none" />
            </label>
          )}
        </div>
        {offered.length === 0 ? (
          <p className="text-xs text-muted">No {plural(unitNoun, 2)} recorded inside these {plural(packName, 2)}.</p>
        ) : left.length === 0 ? (
          <p className="text-xs text-muted">{filter ? "Nothing matches." : `Every ${unitNoun} in these ${plural(packName, 2)} is chosen.`}</p>
        ) : (
          <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
            {[...byBox.entries()].map(([box, codes]) => (
              <div key={box}>
                <div className="mono mb-1 text-[11px] font-semibold text-muted" title={box}>
                  {packName} {shortCode(box)} · {codes.length} left
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {codes.map((code) => (
                    <button key={code} type="button" onClick={() => toggle(code)}
                            disabled={readOnly || full}
                            className="mono inline-flex min-h-9 items-center rounded-lg border border-line bg-content2/50 px-2.5 text-[12px] text-ink-700 hover:border-brand hover:text-brand disabled:opacity-40">
                      {code}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
