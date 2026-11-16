import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box, Check, ChevronDown, ChevronRight, Lock, ScanLine, Sparkles, X,
} from "lucide-react";
import { Button } from "@/shared/components";
import { DetailSheet } from "./DetailSheet";
import {
  childrenOf, codesOf, emptyPick, findCode, fmt, packBlocked, pickFromCodes, pickedTotal,
  suggestPick, toggleUnit, togglePack, unitBlocked, covered, type Pick,
} from "../auditPick";
import type { AuditPack, AuditSources, AuditUnit } from "../types";

/** How many units one group draws before asking for a search (lots can hold 5,000). */
const SHOW_PER_GROUP = 120;

const unitWord = (tracking: string, n: number) => {
  const word = tracking === "SERIAL" ? "serial" : tracking === "IMEI" ? "IMEI"
    : tracking === "ASSET" ? "asset code" : "code";
  return n === 1 ? word : `${word}s`;
};

/**
 * Pick exactly what a write-off line takes off the shelf (2026-10-31).
 *
 * UNITS lots (serial / IMEI) pick unit by unit, grouped under the pack each sits in.
 * CODES lots pick whole packs — carton, box, strip — and single codes for what is
 * smaller than a pack. "Done" only lights when the pick covers the shortfall exactly;
 * the server checks the same thing again when the audit is raised.
 */
export function WriteOffPicker({
  open, onClose, onDone, title, subtitle, shortfall, uom, sources, loading, initialCodes, note,
}: {
  open: boolean;
  onClose: () => void;
  onDone: (codes: string[], total: number) => void;
  title: string;
  subtitle: string;
  shortfall: number;
  uom: string | null;
  sources: AuditSources | undefined;
  loading: boolean;
  initialCodes: string[];
  /** Said above the list — e.g. that brands share this spot's codes. */
  note?: string | null;
}) {
  const [pick, setPick] = useState<Pick>(emptyPick());
  const [query, setQuery] = useState("");
  const [scanNote, setScanNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const scanRef = useRef<HTMLInputElement>(null);

  // Seeded once per opening, from the line's saved codes.
  useEffect(() => {
    if (!open || !sources) return;
    setPick(pickFromCodes(initialCodes, sources));
    setQuery("");
    setScanNote(null);
    setExpanded(new Set(sources.packs.filter((p) => p.parent_id == null).map((p) => p.id)));
    setTimeout(() => scanRef.current?.focus(), 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sources]);

  const total = sources ? pickedTotal(pick, sources) : 0;
  const left = shortfall - total;
  const exact = !!sources && Math.abs(left) < 1e-9 && total > 0;
  const mode = sources?.mode ?? "QUANTITY";
  const tracking = sources?.tracking ?? "NONE";
  const children = useMemo(() => childrenOf(sources?.packs ?? []), [sources]);
  const inside = useMemo(() => (sources ? covered(pick, sources) : { packs: new Set<number>(), units: new Set<number>() }),
    [pick, sources]);
  const unitsByPack = useMemo(() => {
    const out = new Map<number | null, AuditUnit[]>();
    for (const u of sources?.units ?? []) {
      const list = out.get(u.pack_id) ?? [];
      list.push(u);
      out.set(u.pack_id, list);
    }
    return out;
  }, [sources]);

  const q = query.trim().toLowerCase();
  const matches = (u: AuditUnit) => !q || u.code.toLowerCase().includes(q)
    || (u.alt ?? "").toLowerCase().includes(q);

  const scan = () => {
    if (!sources) return;
    const hit = findCode(query, sources);
    if (!hit) {
      setScanNote({ ok: false, text: `${query.trim()} is not a pack or code of this batch and location.` });
      return;
    }
    if ("pack" in hit) {
      if (mode !== "CODES") {
        setScanNote({ ok: false, text: `${hit.pack.code} is a pack — pick its ${unitWord(tracking, 2)} one by one.` });
        return;
      }
      const why = packBlocked(hit.pack, pick, sources, shortfall);
      if (why && !pick.packIds.has(hit.pack.id)) { setScanNote({ ok: false, text: `${hit.pack.code}: ${why}.` }); return; }
      setPick(togglePack(pick, hit.pack, sources));
      setScanNote({ ok: true, text: `${pick.packIds.has(hit.pack.id) ? "Removed" : "Added"} ${hit.pack.name ?? "pack"} ${hit.pack.code}.` });
    } else {
      const why = unitBlocked(hit.unit, pick, sources, shortfall);
      if (why && !pick.unitIds.has(hit.unit.id)) { setScanNote({ ok: false, text: `${hit.unit.code}: ${why}.` }); return; }
      setPick(toggleUnit(pick, hit.unit));
      setScanNote({ ok: true, text: `${pick.unitIds.has(hit.unit.id) ? "Removed" : "Added"} ${hit.unit.code}.` });
    }
    setQuery("");
  };

  const toggleOpen = (id: number) => setExpanded((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const UnitRow = ({ unit }: { unit: AuditUnit }) => {
    if (!sources) return null;
    const on = pick.unitIds.has(unit.id);
    const viaPack = inside.units.has(unit.id);
    const why = unitBlocked(unit, pick, sources, shortfall);
    const disabled = !on && !!why;
    return (
      <label className={`flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition ${
        on || viaPack ? "bg-bad-bg/60" : disabled ? "opacity-50" : "hover:bg-content2"} ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
        title={why ?? undefined}>
        <input type="checkbox" className="h-4 w-4 accent-[var(--color-bad)]"
               checked={on || viaPack} disabled={disabled || viaPack}
               onChange={() => setPick(toggleUnit(pick, unit))} />
        <span className="font-mono font-semibold text-ink">{unit.code}</span>
        {unit.alt && <span className="truncate font-mono text-xs text-muted">{unit.alt}</span>}
        {unit.held_by && <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-warn"><Lock className="h-3 w-3" /> {unit.held_by}</span>}
      </label>
    );
  };

  const UnitList = ({ units }: { units: AuditUnit[] }) => {
    const shown = units.filter(matches);
    return (
      <div className="space-y-0.5">
        {shown.slice(0, SHOW_PER_GROUP).map((u) => <UnitRow key={u.id} unit={u} />)}
        {shown.length > SHOW_PER_GROUP && (
          <p className="px-2.5 py-1 text-xs text-muted">
            Showing {SHOW_PER_GROUP} of {shown.length} — scan or type to find the rest.
          </p>
        )}
      </div>
    );
  };

  const PackNode = ({ pack, depth }: { pack: AuditPack; depth: number }) => {
    if (!sources) return null;
    const kids = children.get(pack.id) ?? [];
    const units = unitsByPack.get(pack.id) ?? [];
    const on = pick.packIds.has(pack.id);
    const viaParent = inside.packs.has(pack.id);
    const why = mode === "CODES" ? packBlocked(pack, pick, sources, shortfall) : null;
    const open = expanded.has(pack.id) || !!q;
    const pickedInside = units.filter((u) => pick.unitIds.has(u.id)).length;
    const part = pack.holds < pack.size;
    return (
      <div className={depth ? "ml-4 border-l border-line pl-3" : ""}>
        <div className={`flex min-h-11 items-center gap-2 rounded-lg px-2 py-1.5 ${on || viaParent ? "bg-bad-bg/70" : "hover:bg-content2"}`}>
          <button type="button" onClick={() => toggleOpen(pack.id)} aria-label={open ? "Collapse" : "Expand"}
                  className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-content3">
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          {mode === "CODES" && (
            <input type="checkbox" className="h-4 w-4 accent-[var(--color-bad)]"
                   checked={on || viaParent} disabled={viaParent || (!on && !!why)}
                   title={why ?? (on ? "Taken whole" : "Take the whole pack")}
                   onChange={() => setPick(togglePack(pick, pack, sources))} />
          )}
          <Box className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          <span className="text-sm font-semibold text-ink">{pack.name ?? "Pack"}</span>
          <span className="truncate font-mono text-xs text-muted">{pack.code}</span>
          <span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${part ? "bg-warn-bg text-warn" : "bg-content2 text-ink-700"}`}>
            {fmt(pack.holds)}{part ? ` of ${fmt(pack.size)}` : ""} {uom ?? ""}
          </span>
          {pickedInside > 0 && !on && (
            <span className="shrink-0 rounded-full bg-bad-bg px-2 py-0.5 text-[11px] font-semibold text-bad">{pickedInside} picked</span>
          )}
          {pack.held_by && <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-warn" title={pack.held_by}><Lock className="h-3 w-3" /></span>}
        </div>
        {open && (
          <div className="mt-0.5 space-y-0.5">
            {kids.map((k) => <PackNode key={k.id} pack={k} depth={depth + 1} />)}
            {units.length > 0 && <div className="ml-4 border-l border-line pl-3"><UnitList units={units} /></div>}
          </div>
        )}
      </div>
    );
  };

  const tops = children.get(null) ?? [];
  const loose = unitsByPack.get(null) ?? [];
  const pct = shortfall > 0 ? Math.min(100, (total / shortfall) * 100) : 0;

  return (
    <DetailSheet
      open={open}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={() => setPick(emptyPick())} disabled={!total}>Clear</Button>
          <span className="flex-1" />
          <Button variant="subtle" onClick={onClose}>Cancel</Button>
          <Button disabled={!exact} onClick={() => sources && onDone(codesOf(pick, sources), total)}>
            <Check className="h-4 w-4" /> Use this pick
          </Button>
        </div>
      }
    >
      {loading || !sources ? (
        <div className="space-y-2">{[0, 1, 2, 3].map((k) => <div key={k} className="h-10 animate-pulse rounded-lg bg-content2" />)}</div>
      ) : (
        <div className="space-y-4">
          {/* Where the pick stands — the one number that decides "Use this pick". */}
          <div className={`rounded-xl border px-4 py-3 ${exact ? "border-ok/40 bg-ok-bg" : "border-line bg-content2/60"}`}>
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Write-off pick</p>
                <p className="tabular text-2xl font-bold text-ink">
                  {fmt(total)} <span className="text-base font-medium text-muted">of {fmt(shortfall)} {uom ?? ""}</span>
                </p>
              </div>
              <p className={`text-right text-sm font-semibold ${exact ? "text-ok" : "text-warn"}`}>
                {exact ? "Exactly the shortfall" : `${fmt(left)} still to pick`}
              </p>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-content3">
              <div className={`h-full rounded-full transition-all ${exact ? "bg-ok" : "bg-bad"}`} style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-2 text-xs text-muted">
              {mode === "UNITS"
                ? `Pick the ${fmt(shortfall)} ${unitWord(tracking, shortfall)} that are missing or damaged, one by one.`
                : "Take whole packs where a whole pack is gone, and single codes for the rest."}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[14rem] flex-1">
              <ScanLine className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
              <input
                ref={scanRef}
                value={query}
                onChange={(e) => { setQuery(e.target.value); setScanNote(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); scan(); } }}
                placeholder={mode === "UNITS" ? "Scan or type a serial / IMEI" : "Scan or type a pack or unit code"}
                aria-label="Scan or search a code"
                className="h-11 w-full rounded-lg border border-line bg-content1 pl-9 pr-9 text-sm outline-none focus:border-brand"
              />
              {query && (
                <button type="button" onClick={() => setQuery("")} aria-label="Clear search"
                        className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-muted hover:bg-content2">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            {mode === "CODES" && (
              <Button variant="soft" onClick={() => setPick(suggestPick(sources, shortfall))}>
                <Sparkles className="h-4 w-4" /> Suggest a pick
              </Button>
            )}
          </div>
          {scanNote && (
            <p className={`rounded-lg px-3 py-2 text-xs font-medium ${scanNote.ok ? "bg-ok-bg text-ok" : "bg-bad-bg text-bad"}`}>{scanNote.text}</p>
          )}
          {note && (
            <p className="rounded-lg bg-info-bg px-3 py-2 text-xs text-info">{note}</p>
          )}
          {sources.truncated && (
            <p className="rounded-lg bg-warn-bg px-3 py-2 text-xs text-warn">
              This lot holds more units than the list shows. Scan or type the codes you need.
            </p>
          )}

          <div className="space-y-1">
            {tops.map((p) => <PackNode key={p.id} pack={p} depth={0} />)}
          </div>
          {loose.length > 0 && (
            <div>
              <p className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
                {tops.length ? "Loose on the shelf" : unitWord(tracking, 2)}
              </p>
              <UnitList units={loose} />
            </div>
          )}
          {!tops.length && !loose.length && (
            <p className="rounded-lg bg-content2 px-3 py-4 text-center text-sm text-muted">
              Nothing at this batch and location can be picked.
            </p>
          )}
        </div>
      )}
    </DetailSheet>
  );
}
