import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle, ArrowLeft, Box, Boxes, Check, ChevronDown, ChevronRight, Home, Info, Lock,
  Minus, Package, RotateCcw, ScanLine, Search, Sparkles, X,
} from "lucide-react";
import { Button } from "@/shared/components";
import { issueBoxSources } from "../api";
import type { BoxSource } from "../types";
import { fmtQty } from "../format";
import {
  buildTree, cartonsTouched, clearInside, coveredBy, indexPacks, isFree, judgeScan, mixOf,
  nearestPacks, nodeHolds, nodeTaken, packNoun, pickSentence, planOf, plural, rollUp,
  shortCode, suggestPick, takeAllInside, trailTo, type PackTree, type PlanRow, type TreeNode,
} from "../packPick";

/**
 * Pick an issue line's packages — one level at a time (2026-10-28).
 *
 * The shelf opens at its top packs only — the cartons. Opening one slides a new sheet
 * over it with the boxes inside; opening a box shows its strips; and so on, as deep as
 * the item's ladder goes. SELECTING runs parent to child: you open your way down to
 * what you want. SAVING runs child to parent: the line stores the packs chosen, and
 * the sentence at the top rolls them back up — "Take 4 boxes + 5 strips from carton
 * …0572". Ten strips of a box roll up into the box (`rollUp`, any depth).
 *
 * Any Issue level can be ticked (a whole box, or strips out of one). A pack that is not
 * an Issue container — the carton here — only OPENS, and says so; its "Take everything"
 * takes the Issue packs inside it.
 *
 * The sheets are drawn inside ONE dialog (decided 2026-10-28): real modal-on-modal
 * stacking breaks focus, scroll and the phone back button. Each level pushes a history
 * entry, so the phone's back button closes one level, and on a phone the dialog is a
 * full-screen sheet.
 *
 * `mode="units"` (serial / IMEI): the same sheets with one more level at the bottom —
 * the units themselves, chosen BY HAND, one at a time, tapped or scanned. Nothing is
 * ever selected for the storekeeper: the number on the line must be the number on the
 * handset in his hand. Each is unique, and there are never more than the quantity.
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
  const [trail, setTrail] = useState<string[]>([]);
  const [scan, setScan] = useState("");
  const [verdict, setVerdict] = useState<{ tone: "ok" | "bad"; text: string; n: number } | null>(null);
  const [showCodes, setShowCodes] = useState(false);
  const [filter, setFilter] = useState("");
  const seeded = useRef(false);
  const narrow = useNarrow();
  const units_ = mode === "units";

  const sources = useQuery({
    queryKey: ["issue-box-sources", warehouseId, itemId, batchId, binId, issueId, mode],
    queryFn: () => issueBoxSources({
      warehouse_id: Number(warehouseId), item_id: Number(itemId),
      batch_id: batchId || undefined, bin_id: binId || undefined,
      issue_id: issueId || undefined, with_units: units_ || undefined,
    }),
    enabled: open && !!warehouseId && !!itemId,
  });
  const packs = useMemo(() => sources.data ?? [], [sources.data]);
  const idx = useMemo(() => indexPacks(packs), [packs]);
  const tree = useMemo(() => buildTree(packs), [packs]);
  const suggestion = useMemo(() => suggestPick(idx, quantity), [idx, quantity]);

  // ---- seed once per opening: what the line already names, else the suggestion ----
  useEffect(() => {
    if (!open) return;
    seeded.current = false;
    setScan("");
    setVerdict(null);
    setShowCodes(false);
    setFilter("");
    setTrail([]);
    trailRef.current = [];
    if (!units_ && initial.length) {
      setPicked(initial);
      seeded.current = true;
    }
    if (units_) setUnits(initial);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open || !sources.data || seeded.current) return;
    seeded.current = true;
    if (!units_) setPicked(readOnly ? [] : suggestion);
  }, [open, sources.data, suggestion]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- one history entry per level: the phone's back button closes one level ----
  // `trailRef` is the trail as intended, written BEFORE history moves, so a popstate
  // (the phone's back button, or our own history.go) only ever shortens it to the
  // level the entry it landed on was pushed at. Every entry this dialog pushes is
  // taken back off when it closes: the page's history is left as it was found.
  const trailRef = useRef<string[]>([]);
  useEffect(() => {
    if (!open) return;
    const onPop = (e: PopStateEvent) => {
      const level = (e.state as { pickerLevel?: number } | null)?.pickerLevel ?? 0;
      const next = trailRef.current.slice(0, Math.min(level, trailRef.current.length));
      trailRef.current = next;
      setTrail(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [open]);
  const applyTrail = (next: string[]) => {
    const depth = trailRef.current.length;
    trailRef.current = next;
    setTrail(next);
    setFilter("");
    try {
      if (next.length > depth) {
        for (let level = depth + 1; level <= next.length; level += 1) {
          window.history.pushState({ ...(window.history.state ?? {}), pickerLevel: level }, "");
        }
      } else if (next.length < depth) {
        window.history.go(-(depth - next.length));
      }
    } catch { /* history unavailable: the trail still moves */ }
  };
  const goInto = (code: string) => applyTrail([...trailRef.current, code]);
  const goTo = (level: number) => applyTrail(trailRef.current.slice(0, level));
  const close = useCallback(() => {
    const depth = trailRef.current.length;
    trailRef.current = [];
    setTrail([]);
    if (depth > 0) { try { window.history.go(-depth); } catch { /* ignore */ } }
    onClose();
  }, [onClose]);

  // ---- the plan ----
  const rows = useMemo(() => planOf(picked, idx, quantity), [picked, idx, quantity]);
  const covered = rows.reduce((s, r) => s + r.take, 0);
  const short = Math.max(0, quantity - covered);
  const pct = quantity > 0 ? Math.min(100, Math.round((covered / quantity) * 100)) : 0;
  const complete = short < 1e-6 && rows.some((r) => r.take > 0);
  const packName = packNoun(packs[0], "box");
  const mix = mixOf(rows);
  const cartons = cartonsTouched(rows, idx);
  const isSuggested = picked.length === suggestion.length && picked.every((c, i) => c === suggestion[i]);
  const suggestedCartons = cartonsTouched(planOf(suggestion, idx, quantity), idx);
  const canCoverMore = short > 1e-6 && packs.some((p) => isFree(p) && !picked.includes(p.code)
    && !coveredBy(p, picked, idx));
  const unit = uom ?? "";

  // ---- units: every serial / IMEI, and the pack each sits in ----
  const need = Math.max(0, Math.floor(quantity));
  const unitHome = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of packs) for (const u of p.units ?? []) if (!m.has(u)) m.set(u, p.code);
    return m;
  }, [packs]);
  // Every unit under each node, worked out once bottom-up.
  const unitsUnder = useMemo(() => {
    const own = new Map<string, string[]>();
    for (const [u, home] of unitHome) own.set(home, [...(own.get(home) ?? []), u]);
    const out = new Map<string, string[]>();
    const walk = (code: string): string[] => {
      const list = [...(own.get(code) ?? [])];
      for (const k of tree.nodes.get(code)?.children ?? []) list.push(...walk(k));
      out.set(code, list);
      return list;
    };
    tree.roots.forEach(walk);
    return out;
  }, [tree, unitHome]);
  const unitsIn = useCallback((code: string): string[] => unitsUnder.get(code) ?? [], [unitsUnder]);
  const chosenUnits = useMemo(() => units.filter((u) => unitHome.has(u) || initial.includes(u)), [units, unitHome, initial]);
  const fullUnits = chosenUnits.length >= need;
  const toggleUnit = (code: string) => {
    if (readOnly) return;
    if (chosenUnits.includes(code)) { setUnits((now) => now.filter((u) => u !== code)); return; }
    if (fullUnits) {
      setVerdict({ tone: "bad", text: `All ${need} ${plural(unitNoun, need)} are chosen — remove one to swap it.`, n: Date.now() });
      return;
    }
    setUnits((now) => [...now, code]);
  };

  // ---- what the pick will do, said before the press ----
  const notes = useMemo(() => {
    if (units_) return [];
    const out: { key: string; text: string; action?: "suggest"; tone?: "warn" }[] = [];
    for (const [boxId, strips] of idx.inner) {
      const box = idx.byId.get(boxId);
      if (!box || picked.includes(box.code)) continue;
      const taken = strips.filter((s) => picked.includes(s.code)).length;
      if (taken > 0) {
        const name = packNoun(strips[0], "strip");
        out.push({ key: `open-${boxId}`, text: `${packNoun(box)} ${shortCode(box.code)} is opened — ${taken} ${plural(name, taken)} leave, ${strips.length - taken} stay in it.` });
      }
    }
    const part = rows.find((r) => r.p && r.take > 0 && r.take < r.p.holds - 1e-6);
    if (part?.p) {
      const name = packNoun(part.p);
      out.push({ key: "part", text: `${name} ${shortCode(part.code)} gives ${fmtQty(part.take)} ${unit} — that leaves as a new part ${name} with its own code; ${fmtQty(part.p.holds - part.take)} stay in ${shortCode(part.code)}.` });
    }
    if (!readOnly && cartons > suggestedCartons && suggestion.length) {
      out.push({ key: "cartons", action: "suggest", text: `This pick opens ${cartons} cartons — the suggestion covers it from ${suggestedCartons}.` });
    }
    if (short > 1e-6 && !canCoverMore && rows.length) {
      out.push({ key: "short", tone: "warn", text: `This batch and location hold only ${fmtQty(covered)} ${unit} for this line — the other ${fmtQty(short)} cannot come from here.` });
    }
    return out;
  }, [units_, idx, picked, rows, cartons, suggestedCartons, suggestion.length, short, canCoverMore, covered, unit, readOnly]);

  // ---- choosing ----
  const commit = (next: string[]) => { if (!readOnly) setPicked(rollUp(next, idx)); };
  const toggle = (p: BoxSource) => {
    if (readOnly || !isFree(p) || coveredBy(p, picked, idx)) return;
    if (picked.includes(p.code)) return commit(picked.filter((c) => c !== p.code));
    // Taking a pack whole releases anything already taken out of it.
    const inside = new Set(packsUnder(tree, p.code));
    commit([...picked.filter((c) => !inside.has(c)), p.code]);
  };
  const doScan = () => {
    const code = scan.trim();
    setScan("");
    if (!code) return;
    if (units_) {
      const hit = [...unitHome.keys()].find((u) => u.toLowerCase() === code.toLowerCase());
      if (!hit) return setVerdict({ tone: "bad", text: `${code} is not a ${unitNoun} at this batch and location.`, n: Date.now() });
      if (chosenUnits.includes(hit)) return setVerdict({ tone: "bad", text: `${hit} is already chosen — each ${unitNoun} once.`, n: Date.now() });
      if (fullUnits) return setVerdict({ tone: "bad", text: `All ${need} are chosen — remove one to swap it.`, n: Date.now() });
      setUnits((now) => [...now, hit]);
      return setVerdict({ tone: "ok", text: `Added ${hit}`, n: Date.now() });
    }
    // A carton (not an Issue pack) opens; any Issue pack is added or removed.
    const node = [...tree.nodes.values()].find((n) => n.code.toLowerCase() === code.toLowerCase());
    if (node && !node.pack && node.children.length) {
      applyTrail(trailTo(tree, node.code).map((n) => n.code));
      return setVerdict({ tone: "ok", text: `Opened ${packNoun({ pack_name: node.name })} ${shortCode(node.code)}`, n: Date.now() });
    }
    const v = judgeScan(code, picked, idx);
    setVerdict({ tone: v.tone, text: v.text, n: Date.now() });
    if (v.tone === "ok") commit(v.next);
  };

  const save = () => {
    onSave(units_ ? chosenUnits : picked);
    close();
  };

  // ---- the sheet on top ----
  const current = trail.length ? tree.nodes.get(trail[trail.length - 1]) ?? null : null;
  const crumbs = current ? trailTo(tree, current.code) : [];
  const children = (current ? current.children : tree.roots).map((c) => tree.nodes.get(c)!);
  const ownUnits = units_ && current?.pack ? (current.pack.units ?? []) : [];
  const shownUnits = ownUnits.filter((u) => !filter || u.toLowerCase().includes(filter.toLowerCase()));
  const visibleChildren = units_ ? children.filter((n) => unitsIn(n.code).length > 0) : children;
  const leafGrid = !units_ && visibleChildren.length > 0 && visibleChildren.every((n) => n.children.length === 0 && n.pack);

  return (
    <Modal isOpen={open} onOpenChange={(o) => { if (!o) close(); }} size={narrow ? "full" : "4xl"}
           scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-2 border-b border-line/70 pb-3">
          <span className="flex items-center gap-2 text-base font-semibold text-ink">
            <Boxes className="h-4 w-4 text-brand" aria-hidden />
            {units_ ? `Pick the ${plural(unitNoun, 2)}` : "Pick packages"}
            <span className="ml-auto truncate text-xs font-normal text-muted">{itemLabel}</span>
          </span>
          {/* The answer, always on top, at every level. */}
          <div className="rounded-xl border border-line bg-gradient-to-br from-brand-050/60 via-content1 to-content1 px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="min-w-0 flex-1 text-sm font-semibold leading-snug text-ink first-letter:uppercase">
                {sources.isLoading ? "Reading the shelf…"
                  : units_ ? `${chosenUnits.length} of ${need} ${plural(unitNoun, need)} chosen — by hand, one at a time`
                    : pickSentence(rows, idx)}
              </p>
              {!units_ && !readOnly && (isSuggested && picked.length ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-brand/10 px-2.5 py-1 text-[11px] font-semibold text-brand">
                  <Sparkles className="h-3.5 w-3.5" aria-hidden /> Suggested
                </span>
              ) : suggestion.length > 0 && (
                <button type="button" onClick={() => setPicked(suggestion)}
                        className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-brand hover:bg-brand-050">
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reset to suggestion
                </button>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-content2">
                <motion.div className={`h-full rounded-full ${(units_ ? fullUnits : complete) ? "bg-ok" : "bg-brand"}`}
                            initial={false}
                            animate={{ width: `${units_ ? (need ? Math.min(100, (chosenUnits.length / need) * 100) : 0) : (rows.length ? pct : 0)}%` }}
                            transition={{ duration: 0.2 }} />
              </div>
              <span className={`text-[11px] font-semibold tabular ${(units_ ? fullUnits : complete) ? "text-ok" : "text-muted"}`}>
                {units_ ? `${chosenUnits.length} / ${need}` : `${fmtQty(covered)} / ${fmtQty(quantity)} ${unit}`}
              </span>
            </div>
          </div>
          {/* Where you are. Every crumb goes back to its level. */}
          <nav aria-label="Where you are" className="flex flex-wrap items-center gap-1 text-xs">
            <button type="button" onClick={() => goTo(0)} disabled={!trail.length}
                    className={`inline-flex min-h-9 items-center gap-1 rounded-lg px-2 font-semibold ${
                      trail.length ? "text-brand hover:bg-brand-050" : "text-ink"}`}>
              <Home className="h-3.5 w-3.5" aria-hidden /> Shelf
            </button>
            {crumbs.map((n, i) => (
              <span key={n.code} className="inline-flex items-center gap-1">
                <ChevronRight className="h-3.5 w-3.5 text-muted" aria-hidden />
                <button type="button" onClick={() => goTo(i + 1)} disabled={i === crumbs.length - 1}
                        title={n.code}
                        className={`inline-flex min-h-9 items-center rounded-lg px-2 font-semibold capitalize ${
                          i === crumbs.length - 1 ? "text-ink" : "text-brand hover:bg-brand-050"}`}>
                  {packNoun({ pack_name: n.name })} <span className="mono ml-1 normal-case">{shortCode(n.code)}</span>
                </button>
              </span>
            ))}
          </nav>
        </ModalHeader>

        <ModalBody className="gap-3 py-3">
          {!readOnly && (
            <div>
              <label className="flex h-12 items-center gap-2 rounded-xl border border-line bg-content1 px-3 focus-within:border-brand">
                <ScanLine className="h-5 w-5 shrink-0 text-brand" aria-hidden />
                <input value={scan} onChange={(e) => setScan(e.target.value)} autoFocus={!narrow}
                       onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); doScan(); } }}
                       placeholder={units_ ? `Scan the ${unitNoun} on the unit` : `Scan any label — a ${packName} or strip adds it, a carton opens it`}
                       aria-label="Scan a code" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
              </label>
              {verdict && (
                <motion.p key={verdict.n} role="status" initial={{ opacity: 0, x: 0 }}
                          animate={verdict.tone === "bad" ? { opacity: 1, x: [0, -6, 6, -4, 4, 0] } : { opacity: 1 }}
                          transition={{ duration: 0.3 }}
                          className={`mt-1.5 flex items-center gap-1.5 text-xs font-semibold ${verdict.tone === "ok" ? "text-ok" : "text-bad"}`}>
                  {verdict.tone === "ok" ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                  {verdict.text}
                </motion.p>
              )}
            </div>
          )}

          {notes.length > 0 && trail.length === 0 && (
            <ul className="space-y-1.5">
              {notes.map((n) => (
                <li key={n.key} className="flex items-start gap-2 rounded-xl bg-warn-bg/60 px-3 py-2 text-xs text-ink-700">
                  {n.tone === "warn" ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
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

          {sources.isLoading ? (
            <div className="grid gap-3 sm:grid-cols-2" aria-hidden>
              {[0, 1, 2, 3].map((i) => <div key={i} className="h-28 animate-pulse rounded-2xl bg-content2" />)}
            </div>
          ) : tree.roots.length === 0 ? (
            <div className="grid place-items-center rounded-xl border border-dashed border-line px-4 py-10 text-center">
              <Package className="h-5 w-5 text-muted" aria-hidden />
              <p className="mt-2 text-sm text-muted">No {plural(packName, 2)} of this item at this batch and location.</p>
            </div>
          ) : (
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={current?.code ?? "__shelf"}
                          initial={{ opacity: 0, x: 28 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -28 }}
                          transition={{ duration: 0.18, ease: "easeOut" }}
                          className="space-y-3">
                {/* What the open pack is, and the two things you can do with all of it. */}
                {current && (
                  <LevelHeader node={current} tree={tree} rows={rows} picked={picked} idx={idx} readOnly={readOnly}
                               units={units_} unitsHere={unitsIn(current.code)} chosenUnits={chosenUnits}
                               onTakeAll={() => commit(takeAllInside(picked, tree, current.code, idx))}
                               onClear={() => commit(clearInside(picked, tree, current.code))}
                               onToggle={() => current.pack && toggle(current.pack)} />
                )}

                {visibleChildren.length > 0 && (
                  leafGrid ? (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
                      {visibleChildren.map((n) => (
                        <LeafTile key={n.code} node={n} picked={picked} rows={rows} idx={idx} readOnly={readOnly}
                                  onToggle={() => n.pack && toggle(n.pack)} />
                      ))}
                    </div>
                  ) : (
                    <div className="grid gap-2.5 sm:grid-cols-2">
                      {visibleChildren.map((n) => (
                        <NodeCard key={n.code} node={n} tree={tree} rows={rows} picked={picked} idx={idx}
                                  readOnly={readOnly} units={units_} unitsHere={units_ ? unitsIn(n.code) : []}
                                  chosenUnits={chosenUnits} unit={unit}
                                  onOpen={() => goInto(n.code)} onToggle={() => n.pack && toggle(n.pack)} />
                      ))}
                    </div>
                  )
                )}

                {/* The last level of a serial / IMEI line: the units themselves. */}
                {units_ && ownUnits.length > 0 && (
                  <section className="rounded-2xl border border-line bg-content1 p-3">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-muted">
                        {plural(unitNoun, 2)} in this {packNoun({ pack_name: current?.name })} · tap each one
                      </span>
                      {ownUnits.length > 20 && (
                        <label className="flex h-9 items-center gap-1.5 rounded-lg border border-line px-2 focus-within:border-brand">
                          <Search className="h-3.5 w-3.5 text-muted" aria-hidden />
                          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find"
                                 aria-label={`Find a ${unitNoun}`} className="w-32 bg-transparent text-xs outline-none" />
                        </label>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {shownUnits.map((u) => {
                        const on = chosenUnits.includes(u);
                        return (
                          <button key={u} type="button" onClick={() => toggleUnit(u)} aria-pressed={on}
                                  disabled={readOnly || (!on && fullUnits)}
                                  className={`mono inline-flex min-h-10 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] transition-colors disabled:opacity-40 ${
                                    on ? "border-brand bg-brand text-white" : "border-line bg-content2/50 text-ink-700 hover:border-brand hover:text-brand"}`}>
                            {on && <span className="text-[10px] opacity-80">{chosenUnits.indexOf(u) + 1}.</span>}
                            {u}
                          </button>
                        );
                      })}
                      {shownUnits.length === 0 && <span className="text-xs text-muted">Nothing matches.</span>}
                    </div>
                  </section>
                )}
              </motion.div>
            </AnimatePresence>
          )}

          {/* Chosen serials, always reachable, whatever level is open. */}
          {units_ && chosenUnits.length > 0 && (
            <ol className="flex flex-wrap gap-1.5 border-t border-line/60 pt-3">
              {chosenUnits.map((code, i) => (
                <li key={code} className="mono inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-brand px-2.5 text-[12px] text-white">
                  <span className="opacity-70">{i + 1}.</span> {code}
                  {!readOnly && (
                    <button type="button" aria-label={`Remove ${code}`} onClick={() => toggleUnit(code)}
                            className="grid h-6 w-6 place-items-center rounded opacity-80 hover:bg-white/15 hover:opacity-100">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ol>
          )}

          {!units_ && rows.some((r) => !r.p) && (
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
          {!units_ && picked.length > 0 && trail.length === 0 && (
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
        </ModalBody>

        <ModalFooter className="flex flex-wrap items-center justify-between gap-3 border-t border-line/70">
          <div className="min-w-0 text-sm text-muted">
            {units_ ? (
              chosenUnits.length ? <><b className="text-ink">{chosenUnits.length} of {need}</b> {plural(unitNoun, need)}</>
                : onPickIndividually ? (
                  <button type="button" onClick={onPickIndividually}
                          className="inline-flex min-h-9 items-center gap-1 font-semibold text-brand hover:underline">
                    <ScanLine className="h-4 w-4" /> Skip packages — pick from every {unitNoun}
                  </button>
                ) : null
            ) : rows.some((r) => r.take > 0) ? (
              <><b className="text-ink">{mix}</b> · {fmtQty(covered)} {unit}
                {cartons > 0 && tree.roots.some((c) => !tree.nodes.get(c)?.pack) && <> · {cartons} {plural("carton", cartons)}</>}</>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {trail.length > 0 && (
              <Button variant="ghost" onClick={() => goTo(trail.length - 1)}><ArrowLeft size={14} /> Back</Button>
            )}
            <Button variant="ghost" onClick={close}>{readOnly ? "Close" : "Cancel"}</Button>
            {!readOnly && (units_ ? (
              <Button onClick={save} disabled={chosenUnits.length === 0}>
                <Check size={14} /> {chosenUnits.length < need ? `Use these ${chosenUnits.length}` : "Use these"}
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

/** Every pack code under a node (not the node). */
function packsUnder(tree: PackTree, code: string): string[] {
  const out: string[] = [];
  const walk = (c: string) => {
    for (const k of tree.nodes.get(c)?.children ?? []) { out.push(k); walk(k); }
  };
  walk(code);
  return out;
}

function useNarrow() {
  const query = "(max-width: 639px)";
  const read = () => { try { return window.matchMedia(query).matches; } catch { return false; } };
  const [narrow, setNarrow] = useState(read);
  useEffect(() => {
    let mq: MediaQueryList | null = null;
    try { mq = window.matchMedia(query); } catch { return undefined; }
    const on = () => setNarrow(mq!.matches);
    mq.addEventListener?.("change", on);
    return () => mq?.removeEventListener?.("change", on);
  }, []);
  return narrow;
}

const HATCH = { backgroundImage: "repeating-linear-gradient(135deg, rgb(148 163 184 / .45) 0 3px, transparent 3px 6px)" };

/** The mark beside a pack: all of it, some of it, or none — and a lock when it cannot be ticked. */
function StateMark({ state, order, locked }: { state: "all" | "some" | "none"; order?: number; locked?: boolean }) {
  if (locked) {
    return <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-line text-muted"><Lock className="h-3 w-3" /></span>;
  }
  return (
    <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-md border text-[11px] font-bold ${
      state === "all" ? "border-brand bg-brand text-white"
        : state === "some" ? "border-brand bg-brand/15 text-brand" : "border-line text-transparent"}`}>
      {state === "all" ? (order ? order : <Check className="h-3.5 w-3.5" />)
        : state === "some" ? <Minus className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
    </span>
  );
}

/** A pack you can open — a carton, a box with strips — or tick, or both. */
function NodeCard({ node, tree, rows, picked, idx, readOnly, units, unitsHere, chosenUnits, unit, onOpen, onToggle }: {
  node: TreeNode; tree: PackTree; rows: PlanRow[]; picked: string[]; idx: ReturnType<typeof indexPacks>;
  readOnly: boolean; units: boolean; unitsHere: string[]; chosenUnits: string[]; unit: string;
  onOpen: () => void; onToggle: () => void;
}) {
  const name = packNoun({ pack_name: node.name });
  const holds = nodeHolds(tree, node.code);
  const { qty, state } = nodeTaken(tree, node.code, rows);
  const p = node.pack;
  const free = !p || isFree(p);
  const coveredHere = !!p && coveredBy(p, picked, idx);
  const order = p ? picked.indexOf(p.code) + 1 : 0;
  const opens = node.children.length > 0 || (units && unitsHere.length > 0);
  const inside = nearestPacks(tree, node.code);
  const innerName = packNoun(inside[0], "pack");
  const chosenInside = inside.filter((q) => nodeTaken(tree, q.code, rows).state !== "none").length;
  const unitsChosen = units ? unitsHere.filter((u) => chosenUnits.includes(u)).length : 0;
  const tickable = !!p && !units && !readOnly && free && !coveredHere;
  const pctFill = holds > 0 ? Math.round(((units ? unitsChosen / Math.max(1, unitsHere.length) * holds : qty) / holds) * 100) : 0;

  return (
    <div className={`group relative overflow-hidden rounded-2xl border transition-all ${
      state === "all" ? "border-brand bg-brand/[0.05]" : state === "some" ? "border-brand/50 bg-content1"
        : !free ? "border-line bg-content2/40" : "border-line bg-content1 hover:border-brand/50 hover:shadow-sm"}`}
         style={!free ? HATCH : undefined}>
      <div className="flex items-start gap-3 p-3">
        {p && !units ? (
          <button type="button" onClick={onToggle} disabled={!tickable} aria-pressed={state === "all"}
                  aria-label={`Take ${name} ${node.code} whole`}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-xl hover:bg-brand-050 disabled:cursor-not-allowed">
            <StateMark state={state} order={state === "all" && order > 0 ? order : undefined} locked={!free} />
          </button>
        ) : (
          <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${
            state !== "none" || unitsChosen ? "bg-brand/10 text-brand" : "bg-content2 text-muted"}`}>
            {node.children.length ? <Boxes className="h-5 w-5" /> : <Box className="h-5 w-5" />}
          </span>
        )}
        <button type="button" onClick={opens ? onOpen : tickable ? onToggle : undefined}
                disabled={!opens && !tickable} title={node.code}
                className="min-w-0 flex-1 text-left disabled:cursor-default">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold capitalize text-ink">{name}</span>
            <span className="mono truncate text-[12px] text-muted">{shortCode(node.code)}</span>
            {p?.part && <span className="rounded-full bg-warn-bg px-1.5 py-0.5 text-[10px] font-semibold text-warn">Part</span>}
          </span>
          <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-content2">
            <motion.span className={`block h-full rounded-full ${state === "all" ? "bg-brand" : "bg-brand/60"}`}
                         initial={false} animate={{ width: `${Math.min(100, pctFill)}%` }} transition={{ duration: 0.2 }} />
          </span>
          <span className="mt-1.5 block text-[11px] text-muted">
            {!free ? <span className="font-semibold text-warn">Held by {p?.held_by}</span>
              : coveredHere ? "Inside a pack already taken"
                : units ? <>{unitsChosen} of {unitsHere.length} chosen</>
                  : state === "all" ? <span className="font-semibold text-brand">Whole {name} · {fmtQty(qty)} {unit}</span>
                    : state === "some" ? <span className="font-semibold text-brand">{chosenInside} {plural(innerName, chosenInside)} · {fmtQty(qty)} of {fmtQty(holds)} {unit}</span>
                      : <>{inside.length ? `${inside.length} ${plural(innerName, inside.length)} · ` : ""}{fmtQty(holds)} {unit}</>}
          </span>
          {!p && !units && (
            <span className="mt-1 block text-[10px] text-muted">Not an issue container — opens only</span>
          )}
        </button>
        {opens && (
          <button type="button" onClick={onOpen} aria-label={`Open ${name} ${node.code}`}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-line text-muted transition-colors group-hover:border-brand group-hover:text-brand">
            <ChevronRight className="h-5 w-5" />
          </button>
        )}
      </div>
    </div>
  );
}

/** The last level of a box line: strips as compact tiles — tap to take or give back. */
function LeafTile({ node, picked, rows, idx, readOnly, onToggle }: {
  node: TreeNode; picked: string[]; rows: PlanRow[]; idx: ReturnType<typeof indexPacks>;
  readOnly: boolean; onToggle: () => void;
}) {
  const p = node.pack!;
  const free = isFree(p);
  const coveredHere = coveredBy(p, picked, idx);
  const order = picked.indexOf(p.code);
  const on = order >= 0 || coveredHere;
  const row = order >= 0 ? rows[order] : undefined;
  const part = row && row.take > 0 && row.take < p.holds - 1e-6 ? row.take : null;
  return (
    <button type="button" onClick={onToggle} disabled={readOnly || !free || coveredHere}
            aria-pressed={on} title={`${p.code} · ${fmtQty(p.holds)}`}
            style={!free ? HATCH : undefined}
            className={`flex min-h-16 flex-col items-start justify-between rounded-xl border p-2.5 text-left transition-colors disabled:cursor-not-allowed ${
              on ? (part != null ? "border-warn bg-warn/10" : "border-brand bg-brand/[0.08]")
                : !free ? "border-line bg-content2/40" : "border-line bg-content1 hover:border-brand/60"}`}>
      <span className="flex w-full items-center justify-between gap-1">
        <span className="mono truncate text-[12px] font-semibold text-ink">{shortCode(p.code)}</span>
        <StateMark state={on ? "all" : "none"} order={order >= 0 ? order + 1 : undefined} locked={!free} />
      </span>
      <span className="text-[11px] text-muted">
        {!free ? `Held by ${p.held_by}` : part != null ? <b className="text-warn">gives {fmtQty(part)}</b>
          : `${fmtQty(p.holds)}${p.part ? ` of ${fmtQty(p.size)}` : ""}`}
      </span>
    </button>
  );
}

/** The open pack itself: what it is, what the line takes of it, and the bulk actions. */
function LevelHeader({ node, tree, rows, picked, idx, readOnly, units, unitsHere, chosenUnits, onTakeAll, onClear, onToggle }: {
  node: TreeNode; tree: PackTree; rows: PlanRow[]; picked: string[]; idx: ReturnType<typeof indexPacks>;
  readOnly: boolean; units: boolean; unitsHere: string[]; chosenUnits: string[];
  onTakeAll: () => void; onClear: () => void; onToggle: () => void;
}) {
  const name = packNoun({ pack_name: node.name });
  const { qty, state } = nodeTaken(tree, node.code, rows);
  const holds = nodeHolds(tree, node.code);
  const p = node.pack;
  const coveredHere = !!p && coveredBy(p, picked, idx);
  const inside = nearestPacks(tree, node.code);
  const innerName = packNoun(inside[0], "pack");
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-content2/40 px-3 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold capitalize text-ink">
          Inside {name} <span className="mono normal-case text-muted">{shortCode(node.code)}</span>
        </span>
        <span className="text-[11px] text-muted">
          {units
            ? `${unitsHere.filter((u) => chosenUnits.includes(u)).length} of ${unitsHere.length} chosen here`
            : `${inside.length} ${plural(innerName, inside.length)} · taking ${fmtQty(qty)} of ${fmtQty(holds)}`}
          {!p && !units && " · not an issue container, opens only"}
        </span>
      </span>
      {!readOnly && !units && (
        <span className="flex flex-wrap items-center gap-1.5">
          {p && !coveredHere && isFree(p) && (
            <button type="button" onClick={onToggle}
                    className={`min-h-10 rounded-lg px-3 text-xs font-semibold ${state === "all" && picked.includes(p.code)
                      ? "bg-brand text-white" : "border border-brand/40 text-brand hover:bg-brand-050"}`}>
              {state === "all" && picked.includes(p.code) ? `Whole ${name} taken` : `Take the whole ${name}`}
            </button>
          )}
          {!p && inside.length > 0 && (
            <button type="button" onClick={onTakeAll} disabled={state === "all"}
                    className="min-h-10 rounded-lg border border-brand/40 px-3 text-xs font-semibold text-brand hover:bg-brand-050 disabled:opacity-40">
              Take everything inside
            </button>
          )}
          <button type="button" onClick={onClear} disabled={state === "none"}
                  className="min-h-10 rounded-lg px-3 text-xs font-semibold text-muted hover:bg-content2 disabled:opacity-40">
            Clear
          </button>
        </span>
      )}
    </div>
  );
}
