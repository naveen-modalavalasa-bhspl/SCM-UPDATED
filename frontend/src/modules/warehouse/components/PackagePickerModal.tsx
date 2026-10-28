import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import {
  Box, Boxes, Check, ChevronDown, Minus, Package, Plus, ScanLine, Sparkles, X,
} from "lucide-react";
import { Button } from "@/shared/components";
import { issueBoxSources } from "../api";
import type { BoxSource } from "../types";
import { fmtQty } from "../format";

/**
 * Pick an issue line's packages, parent first (2026-10-27).
 *
 * An item issued in a container is taken off the shelf the way it stands: the cartons
 * at the line's batch and location, and out of each carton HOW MANY boxes. The boxes
 * are chosen for you — part-opened cartons first, so fewer cartons get broken — and any
 * box can be swapped for another by tapping it. Where the item has two Issue
 * containers (a box and the strip inside it), a box not taken whole offers its strips
 * the same way, so a remainder leaves in the smaller pack.
 *
 * What is checked is the Issue container, nothing else: the line names boxes, and the
 * quantity is what those boxes hold, the last one taken in part when the quantity does
 * not fill it (it leaves as a new part box with its own code — as before).
 *
 * `mode="units"` is the same flow for a serial or IMEI item: the packages narrow the
 * shelf, and then every serial / IMEI is chosen BY HAND, one at a time — tapped or
 * scanned off the unit itself. Nothing is ever selected for the storekeeper: the
 * number on the line must be the number on the handset in his hand. Each is unique,
 * must sit inside a chosen package, and there are never more than the quantity.
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
  const [unitScan, setUnitScan] = useState("");
  const [unitError, setUnitError] = useState<string | null>(null);
  const [scan, setScan] = useState("");
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

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
  const byCode = useMemo(() => new Map(packs.map((p) => [p.code, p])), [packs]);
  const byId = useMemo(() => new Map(packs.map((p) => [p.id, p])), [packs]);

  // Seed once the shelf is read: boxes mode from the line's codes; units mode from
  // the boxes that hold the line's serials, with anything else ticked off.
  useEffect(() => {
    if (!open) return;
    setScan("");
    setOpenGroups({});
    if (mode === "boxes") {
      setPicked(initial);
      return;
    }
    if (!sources.data) return;
    const wanted = new Set(initial);
    const boxes = sources.data.filter((p) => (p.units ?? []).some((u) => wanted.has(u)));
    const tops = boxes.filter((p) => !boxes.some((q) => q.id === p.parent_id));
    setPicked(tops.map((p) => p.code));
    // Only what the storekeeper already chose comes back — never a fill.
    setUnits(initial);
    setUnitScan("");
    setUnitError(null);
  }, [open, sources.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the tree: carton → its Issue packs → (a second Issue level) inside them ----
  const isIssue = (id?: number | null) => id != null && byId.has(id);
  const groups = useMemo(() => {
    const out = new Map<string, { key: string; code: string | null; name: string | null;
      holds: number | null; size: number | null; packs: BoxSource[] }>();
    for (const p of packs) {
      if (isIssue(p.parent_id)) continue;          // inside another Issue pack
      const key = p.parent_id ? String(p.parent_id) : "loose";
      const g = out.get(key) ?? { key, code: p.parent_code ?? null, name: p.parent_pack_name ?? null,
        holds: p.parent_holds ?? null, size: p.parent_size ?? null, packs: [] };
      g.packs.push(p);
      out.set(key, g);
    }
    const list = [...out.values()];
    for (const g of list) g.packs.sort((a, b) => Number(b.part) - Number(a.part) || a.id - b.id);
    // Part-opened cartons first (fewer cartons broken), then the fullest.
    list.sort((a, b) => {
      const openA = a.holds != null && a.size != null && a.holds < a.size ? 0 : 1;
      const openB = b.holds != null && b.size != null && b.holds < b.size ? 0 : 1;
      return openA - openB || (b.packs.length - a.packs.length) || a.key.localeCompare(b.key);
    });
    return list;
  }, [packs]); // eslint-disable-line react-hooks/exhaustive-deps
  const innerOf = (p: BoxSource) => packs.filter((q) => q.parent_id === p.id);
  const free = (p: BoxSource) => !p.held_by || p.held_by_this_issue;
  const coveredByPicked = (p: BoxSource): boolean => {
    let node = p.parent_id ? byId.get(p.parent_id) : undefined;
    while (node) {
      if (picked.includes(node.code)) return true;
      node = node.parent_id ? byId.get(node.parent_id) : undefined;
    }
    return false;
  };

  // What the picks give, in order — whole while the quantity lasts, the last in part.
  const plan = useMemo(() => {
    let rest = quantity;
    return picked.map((code) => {
      const p = byCode.get(code);
      const take = p ? Math.max(0, Math.min(p.holds, rest)) : 0;
      rest -= take;
      return { code, p, take };
    });
  }, [picked, byCode, quantity]);
  const covered = plan.reduce((s, r) => s + r.take, 0);
  const short = Math.max(0, quantity - covered);
  const pct = quantity > 0 ? Math.min(100, Math.round((covered / quantity) * 100)) : 0;
  const packName = (groups[0]?.packs[0]?.pack_name ?? packs[0]?.pack_name ?? "box").toLowerCase();
  const partRow = plan.find((r) => r.p && r.take > 0 && r.take < r.p.holds);

  const summary = useMemo(() => {
    const by = new Map<string, number>();
    for (const r of plan) {
      if (!r.p || r.take <= 0) continue;
      const name = (r.p.pack_name ?? "pack").toLowerCase();
      const label = r.take < r.p.holds ? `part ${name} (${fmtQty(r.take)})` : name;
      by.set(label, (by.get(label) ?? 0) + 1);
    }
    return [...by.entries()].map(([k, n]) => `${n} ${k}`).join(" + ");
  }, [plan]);

  // ---- choosing ----
  const setCount = (list: BoxSource[], n: number) => {
    if (readOnly) return;
    const chosen = list.filter((p) => picked.includes(p.code));
    if (n === chosen.length) return;
    if (n < chosen.length) {
      const drop = new Set(chosen.slice(n).map((p) => p.code));
      setPicked((now) => now.filter((c) => !drop.has(c)));
      return;
    }
    const add = list.filter((p) => free(p) && !picked.includes(p.code) && !coveredByPicked(p))
      .slice(0, n - chosen.length).map((p) => p.code);
    setPicked((now) => [...now, ...add]);
  };
  const toggle = (p: BoxSource) => {
    if (readOnly || !free(p) || coveredByPicked(p)) return;
    setPicked((now) => {
      if (now.includes(p.code)) return now.filter((c) => c !== p.code);
      // Taking a box whole releases any strips already taken out of it.
      const inner = new Set(innerOf(p).map((q) => q.code));
      return [...now.filter((c) => !inner.has(c)), p.code];
    });
  };
  const autoFill = () => {
    if (readOnly) return;
    let rest = quantity;
    const out: string[] = [];
    for (const g of groups) {
      for (const p of g.packs) {
        if (rest <= 0) break;
        if (!free(p)) continue;
        out.push(p.code);
        rest -= p.holds;
      }
      if (rest <= 0) break;
    }
    setPicked(out);
  };
  const addScan = () => {
    const code = scan.trim();
    if (!code) return;
    const p = byCode.get(code);
    if (p) toggle(p);
    else if (!picked.includes(code)) setPicked((now) => [...now, code]);
    setScan("");
  };

  // ---- units mode: the serials inside the chosen packages ----
  const offeredUnits = useMemo(() => {
    if (mode !== "units") return [];
    const out: { code: string; box: string }[] = [];
    for (const r of plan) {
      if (!r.p) continue;
      for (const u of r.p.units ?? []) out.push({ code: u, box: r.p.code });
    }
    return out;
  }, [plan, mode]);
  const need = Math.max(0, Math.floor(quantity));
  const offeredSet = useMemo(() => new Set(offeredUnits.map((u) => u.code)), [offeredUnits]);
  // A serial counts only while its package is still chosen; releasing a box releases
  // whatever was picked out of it.
  const chosenUnits = useMemo(
    () => (mode === "units" ? units.filter((u) => offeredSet.has(u)) : []),
    [units, offeredSet, mode]);
  const toggleUnit = (code: string) => {
    if (readOnly) return;
    setUnitError(null);
    if (chosenUnits.includes(code)) {
      setUnits((now) => now.filter((u) => u !== code));
      return;
    }
    if (chosenUnits.length >= need) {
      setUnitError(`All ${need} ${unitNoun}s are chosen — remove one to swap it.`);
      return;
    }
    setUnits((now) => [...now.filter((u) => offeredSet.has(u)), code]);
  };
  const addUnitScan = () => {
    const code = unitScan.trim();
    setUnitScan("");
    if (!code) return;
    const hit = offeredUnits.find((u) => u.code.toLowerCase() === code.toLowerCase());
    if (!hit) {
      setUnitError(`${code} is not inside the ${packName}es chosen above.`);
      return;
    }
    if (chosenUnits.includes(hit.code)) {
      setUnitError(`${hit.code} is already chosen — each ${unitNoun} once.`);
      return;
    }
    toggleUnit(hit.code);
  };

  const save = () => {
    onSave(mode === "units" ? chosenUnits : picked);
    onClose();
  };

  return (
    <Modal isOpen={open} onOpenChange={(o) => { if (!o) onClose(); }} size="3xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1 border-b border-line/70">
          <span className="flex items-center gap-2 text-base font-semibold text-ink">
            <Boxes className="h-4 w-4 text-brand" aria-hidden /> Pick packages
          </span>
          <span className="text-xs font-normal text-muted">
            {itemLabel} · issued in {packName}
            {mode === "units" ? ` — then the ${unitNoun}s inside them` : ` — one code per ${packName}`}
          </span>
        </ModalHeader>
        <ModalBody className="gap-4 py-4">
          {/* ---- how far the picks go ---- */}
          <div className="rounded-2xl border border-line bg-gradient-to-br from-brand-050/60 via-content1 to-content1 p-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wider text-muted">This line needs</div>
                <div className="text-2xl font-bold tabular text-ink">
                  {fmtQty(quantity)} <span className="text-sm font-semibold text-muted">{uom ?? ""}</span>
                </div>
              </div>
              <div className="text-right">
                <div className="text-[11px] font-bold uppercase tracking-wider text-muted">Packages picked</div>
                <div className={`text-sm font-semibold ${short > 0 ? "text-warn" : "text-ok"}`}>
                  {picked.length
                    ? <>{summary || "—"} = {fmtQty(covered)} {uom ?? ""}</>
                    : mode === "units"
                      ? <>None yet — pick the {packName}es first</>
                      : <>None yet — chosen for you on save</>}
                </div>
              </div>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-content2">
              <div className={`h-full rounded-full transition-all ${pct >= 100 ? "bg-ok" : "bg-brand"}`}
                   style={{ width: `${picked.length ? pct : 0}%` }} />
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px]">
              <span className={short > 0 && picked.length ? "font-semibold text-warn" : "text-muted"}>
                {picked.length && short > 0
                  ? `${fmtQty(short)} ${uom ?? ""} still to cover — add another ${packName}`
                  : partRow
                    ? `The last ${packName} gives ${fmtQty(partRow.take)} — it leaves as a new part ${packName} with its own code`
                    : "Whole packages, exactly as the Issue container says"}
              </span>
              {!readOnly && (
                <button type="button" onClick={autoFill}
                        className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 font-semibold text-brand hover:bg-brand-050">
                  <Sparkles className="h-3.5 w-3.5" /> Auto-select
                </button>
              )}
            </div>
          </div>

          {!readOnly && (
            <label className="flex h-11 items-center gap-2 rounded-xl border border-line bg-content1 px-3 focus-within:border-brand">
              <ScanLine className="h-4 w-4 shrink-0 text-muted" aria-hidden />
              <input value={scan} onChange={(e) => setScan(e.target.value)}
                     onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addScan(); } }}
                     placeholder={`Scan a ${packName} label to add or remove it`}
                     aria-label="Scan a package code"
                     className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
            </label>
          )}

          {/* ---- the cartons, and the boxes in each ---- */}
          {sources.isLoading ? (
            <p className="py-8 text-center text-sm text-muted">Reading the shelf…</p>
          ) : groups.length === 0 ? (
            <div className="grid place-items-center rounded-xl border border-dashed border-line px-4 py-10 text-center">
              <Package className="h-5 w-5 text-muted" aria-hidden />
              <p className="mt-2 text-sm text-muted">No {packName}es of this item at this batch and location.</p>
            </div>
          ) : (
            <ul className="space-y-3">
              {groups.map((g) => {
                const takeable = g.packs.filter((p) => free(p) && !coveredByPicked(p));
                const n = g.packs.filter((p) => picked.includes(p.code)).length;
                const expanded = openGroups[g.key] ?? (n > 0 || groups.length <= 2);
                const openedParent = g.holds != null && g.size != null && g.holds < g.size;
                return (
                  <li key={g.key} className={`overflow-hidden rounded-2xl border transition-colors ${
                    n > 0 ? "border-brand/50 bg-brand-050/30" : "border-line bg-content1"}`}>
                    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-content2 text-brand">
                        {g.code ? <Boxes className="h-5 w-5" /> : <Box className="h-5 w-5" />}
                      </span>
                      <button type="button" className="min-w-0 flex-1 text-left"
                              onClick={() => setOpenGroups((s) => ({ ...s, [g.key]: !expanded }))}>
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-semibold capitalize text-ink">
                            {g.code ? g.name ?? "Pack" : `${packName}es not in a pack`}
                          </span>
                          {openedParent && (
                            <span className="rounded-full bg-warn-bg px-2 py-0.5 text-[10px] font-semibold text-warn">Opened</span>
                          )}
                          <ChevronDown className={`h-4 w-4 shrink-0 text-muted transition-transform ${expanded ? "rotate-180" : ""}`} />
                        </span>
                        {g.code && <span className="mono block truncate text-[11px] text-muted">{g.code}</span>}
                        <span className="block text-[11px] text-muted">
                          {g.packs.length} {packName}{g.packs.length === 1 ? "" : "es"} inside · {takeable.length} free
                        </span>
                      </button>
                      {/* How many Issue packs come out of THIS carton. */}
                      <div className="flex items-center gap-1.5">
                        <button type="button" aria-label={`One fewer ${packName} from ${g.code ?? "here"}`}
                                disabled={readOnly || n === 0} onClick={() => setCount(g.packs, n - 1)}
                                className="grid h-10 w-10 place-items-center rounded-xl border border-line bg-content1 hover:border-brand disabled:opacity-40">
                          <Minus className="h-4 w-4" />
                        </button>
                        <input type="number" min={0} max={takeable.length} value={n}
                               disabled={readOnly}
                               onChange={(e) => setCount(g.packs, Math.max(0, Math.min(takeable.length, Math.floor(Number(e.target.value) || 0))))}
                               aria-label={`${packName}es from ${g.code ?? "here"}`}
                               className="h-10 w-14 rounded-xl border border-line bg-content1 text-center text-base font-bold tabular outline-none focus:border-brand" />
                        <button type="button" aria-label={`One more ${packName} from ${g.code ?? "here"}`}
                                disabled={readOnly || n >= takeable.length} onClick={() => setCount(g.packs, n + 1)}
                                className="grid h-10 w-10 place-items-center rounded-xl border border-line bg-content1 hover:border-brand disabled:opacity-40">
                          <Plus className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                    {expanded && (
                      <div className="grid gap-2 border-t border-line/70 bg-content1/60 p-3 sm:grid-cols-2">
                        {g.packs.map((p) => (
                          <PackChip key={p.id} p={p} picked={picked} plan={plan} readOnly={readOnly}
                                    covered={coveredByPicked(p)} free={free(p)} onToggle={toggle}
                                    inner={innerOf(p)} onInnerCount={(n2) => setCount(innerOf(p), n2)} />
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {plan.some((r) => !r.p) && (
            <div className="flex flex-wrap gap-1.5">
              {plan.filter((r) => !r.p).map((r) => (
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

          {/* ---- units mode: every serial / IMEI chosen by hand ---- */}
          {mode === "units" && picked.length > 0 && (
            <div className="rounded-2xl border border-line bg-content1 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-ink">Choose the {unitNoun}s — one by one</div>
                  <div className="text-[11px] text-muted">
                    Scan each unit, or tap its {unitNoun}. Nothing is chosen for you.
                  </div>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-xs font-bold tabular ${
                  chosenUnits.length === need ? "bg-ok-bg text-ok" : "bg-warn-bg text-warn"}`}>
                  {chosenUnits.length} / {need}
                </span>
              </div>
              {!readOnly && (
                <label className="mb-2 flex h-11 items-center gap-2 rounded-xl border border-line bg-content1 px-3 focus-within:border-brand">
                  <ScanLine className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                  <input value={unitScan} onChange={(e) => { setUnitScan(e.target.value); setUnitError(null); }}
                         onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addUnitScan(); } }}
                         placeholder={chosenUnits.length >= need ? `All ${need} chosen` : `Scan the ${unitNoun} on the unit`}
                         aria-label={`Scan a ${unitNoun}`}
                         disabled={chosenUnits.length >= need}
                         className="min-w-0 flex-1 bg-transparent text-sm outline-none disabled:opacity-50" />
                </label>
              )}
              {unitError && <p className="mb-2 text-xs font-semibold text-bad">{unitError}</p>}
              {chosenUnits.length > 0 && (
                <ol className="mb-3 flex flex-wrap gap-1.5">
                  {chosenUnits.map((code, idx) => (
                    <li key={code} className="mono inline-flex min-h-8 items-center gap-1.5 rounded-lg bg-brand px-2 text-[11px] text-white">
                      <span className="opacity-70">{idx + 1}.</span> {code}
                      {!readOnly && (
                        <button type="button" aria-label={`Remove ${code}`} onClick={() => toggleUnit(code)}
                                className="opacity-80 hover:opacity-100"><X className="h-3 w-3" /></button>
                      )}
                    </li>
                  ))}
                </ol>
              )}
              <div className="text-[11px] font-bold uppercase tracking-wider text-muted">
                Still in the chosen {packName}es
              </div>
              <div className="mt-1.5 flex max-h-56 flex-wrap gap-1.5 overflow-y-auto">
                {offeredUnits.filter((u) => !chosenUnits.includes(u.code)).map((u) => (
                  <button key={u.code} type="button" onClick={() => toggleUnit(u.code)}
                          disabled={readOnly || chosenUnits.length >= need}
                          title={`In ${u.box}`}
                          className="mono inline-flex min-h-8 items-center rounded-lg border border-line bg-content2/50 px-2 text-[11px] text-ink-700 hover:border-brand hover:text-brand disabled:opacity-40">
                    {u.code}
                  </button>
                ))}
                {offeredUnits.length === 0 && (
                  <span className="text-[11px] text-muted">No {unitNoun}s recorded inside these {packName}es.</span>
                )}
                {offeredUnits.length > 0 && offeredUnits.every((u) => chosenUnits.includes(u.code)) && (
                  <span className="text-[11px] text-muted">Every {unitNoun} in these {packName}es is chosen.</span>
                )}
              </div>
            </div>
          )}
        </ModalBody>
        <ModalFooter className="flex flex-wrap items-center justify-between gap-2 border-t border-line/70">
          <div className="flex flex-wrap gap-2">
            {!readOnly && mode === "boxes" && (
              <Button variant="ghost" onClick={() => setPicked([])} disabled={!picked.length}>
                <Sparkles size={14} /> Choose for me on save
              </Button>
            )}
            {mode === "units" && onPickIndividually && (
              <Button variant="ghost" onClick={onPickIndividually}>
                <ScanLine size={14} /> Pick {unitNoun}s one by one
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>{readOnly ? "Close" : "Cancel"}</Button>
            {!readOnly && (
              <Button onClick={save}
                      disabled={mode === "units" && chosenUnits.length === 0}>
                <Check size={14} /> Use these
              </Button>
            )}
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

/** One Issue pack inside a carton: tap to take or release it; a box with a second
 *  Issue level inside it offers those too when it is not taken whole. */
function PackChip({ p, picked, plan, readOnly, covered, free, onToggle, inner, onInnerCount }: {
  p: BoxSource;
  picked: string[];
  plan: { code: string; take: number }[];
  readOnly: boolean;
  covered: boolean;
  free: boolean;
  onToggle: (p: BoxSource) => void;
  inner: BoxSource[];
  onInnerCount: (n: number) => void;
}) {
  const order = picked.indexOf(p.code);
  const on = order >= 0;
  const take = on ? plan[order]?.take ?? 0 : 0;
  const fill = p.size > 0 ? Math.round((p.holds / p.size) * 100) : 100;
  const innerTaken = inner.filter((q) => picked.includes(q.code)).length;
  const innerFree = inner.filter((q) => !q.held_by || q.held_by_this_issue).length;
  const innerName = (inner[0]?.pack_name ?? "pack").toLowerCase();
  return (
    <div className={`rounded-xl border p-2.5 transition-colors ${
      on ? "border-brand bg-brand/[0.06]" : covered ? "border-line bg-content2/40 opacity-60"
        : !free ? "border-line bg-content2/40 opacity-60" : "border-line bg-content1"}`}>
      <button type="button" onClick={() => onToggle(p)} disabled={readOnly || !free || covered}
              aria-pressed={on} className="flex w-full items-start gap-2.5 text-left disabled:cursor-not-allowed">
        <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md border text-[11px] font-bold ${
          on ? "border-brand bg-brand text-white" : "border-line text-transparent"}`}>
          {on ? order + 1 : <Check className="h-3.5 w-3.5" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="mono block truncate text-[12px] font-semibold text-ink" title={p.code}>{p.code}</span>
          <span className="mt-1 flex items-center gap-2 text-[11px] text-muted">
            <span className="h-1 w-14 overflow-hidden rounded-full bg-content2">
              <span className="block h-full rounded-full bg-brand/70" style={{ width: `${fill}%` }} />
            </span>
            {fmtQty(p.holds)} of {fmtQty(p.size)}
            {p.part && <span className="rounded bg-warn-bg px-1.5 font-semibold text-warn">Part</span>}
          </span>
          {on && take > 0 && take < p.holds && (
            <span className="mt-1 block text-[11px] font-semibold text-brand">Gives {fmtQty(take)} — the rest stays</span>
          )}
          {!free && <span className="mt-1 block text-[11px] font-semibold text-warn">Held by {p.held_by}</span>}
          {covered && <span className="mt-1 block text-[11px] text-muted">Inside a box already taken</span>}
        </span>
      </button>
      {/* A second Issue level: strips out of this box, when the box is not taken whole. */}
      {inner.length > 0 && !on && !covered && (
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-line/60 pt-2 text-[11px]">
          <span className="text-muted">or {innerName}s from it</span>
          <span className="flex items-center gap-1">
            <button type="button" aria-label={`One fewer ${innerName}`} disabled={readOnly || innerTaken === 0}
                    onClick={() => onInnerCount(innerTaken - 1)}
                    className="grid h-8 w-8 place-items-center rounded-lg border border-line hover:border-brand disabled:opacity-40">
              <Minus className="h-3.5 w-3.5" />
            </button>
            <span className="w-10 text-center font-bold tabular text-ink">{innerTaken}/{innerFree}</span>
            <button type="button" aria-label={`One more ${innerName}`} disabled={readOnly || innerTaken >= innerFree}
                    onClick={() => onInnerCount(innerTaken + 1)}
                    className="grid h-8 w-8 place-items-center rounded-lg border border-line hover:border-brand disabled:opacity-40">
              <Plus className="h-3.5 w-3.5" />
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
