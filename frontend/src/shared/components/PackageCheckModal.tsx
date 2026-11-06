import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import {
  AlertTriangle, Box, Boxes, Check, CheckCheck, ChevronDown, Minus, PackageX, Plus,
} from "lucide-react";
import { Button } from "./ui";
import { guardNumberKeys } from "../quantity";

/**
 * Check a line package by package (2026-10-26) — outward QC and the receiving site.
 *
 * An item issued in a container travels as PACKAGES, each with its own code. What is
 * wrong with a delivery is always said against a package: a package rejected (or
 * missing) WHOLE, or some units out of a package that is otherwise kept (rejected
 * inside it, or short in it). The two add up to the line's rejected (short) base
 * quantity, so every unit that does not go on can be traced to the package it came
 * out of.
 *
 * 2026-10-28: the packages are drawn as the tree they came out of — carton, then the
 * boxes and strips inside it — so "4 boxes + 5 strips" reads as one carton, not nine
 * unrelated codes. A group can be kept or rejected (missing) in one press. A kept box
 * that carries strips can be checked STRIP BY STRIP: a strip rejected (missing) whole,
 * or some units out of a strip. Those roll up into the box's own figure, which is
 * what the server records — so nothing downstream changes, and the detail is kept in
 * `inner` for the screen that opens the check again.
 */
export interface PackRef { code: string; name?: string | null }
export interface InnerPack { code: string; name?: string | null; carries: number; part?: boolean }

export interface PackageToCheck {
  code: string;
  /** Base units this package carries. */
  carries: number;
  /** Shown instead of the code when a pack has none yet — "Carton 2" at the GRN. */
  label?: string;
  /** A second line under the name — "part pack · 20 of 50". */
  detail?: string;
  /** Packs of one kind share a group, and a group gets a quick count (2026-10-27). */
  group?: string;
  /** The pack's own name — "Box", "Strip". */
  name?: string | null;
  /** The packs around it, outermost first (2026-10-28). */
  path?: PackRef[] | null;
  /** The packs directly inside it, for a strip-by-strip check (2026-10-28). */
  inner?: InnerPack[] | null;
}

export interface InnerCheck {
  /** Strips rejected (missing) whole. */
  lost: string[];
  /** Units out of a strip that is otherwise kept. */
  partial: Record<string, number>;
}

export interface PackageCheck {
  /** Packages kept (accepted / arrived). */
  kept: string[];
  /** Units taken out of a KEPT package: rejected in it, or short in it. */
  partial: Record<string, number>;
  /** Strip-by-strip detail inside a kept package; rolled up into `partial`. */
  inner?: Record<string, InnerCheck>;
}

const COPY = {
  qc: {
    title: "Inspect the packages",
    kept: "Kept", whole: "Rejected", partial: "rejected out of it",
    keptNoun: "accepted", lostNoun: "rejected", lostVerb: "Reject",
    hint: "Untick a package to reject it whole. For a few bad units, keep it and say how many came out of it — or open it and check the strips inside.",
  },
  receipt: {
    title: "Check the packages",
    kept: "Arrived", whole: "Missing", partial: "short in it",
    keptNoun: "received", lostNoun: "short", lostVerb: "Mark missing",
    hint: "Mark a package missing if it never arrived. If it came short, keep it and say how many are missing — or open it and check the strips inside.",
  },
} as const;

const fmt = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 3 });
const short = (code: string) => {
  const tail = code.split("-").pop() ?? code;
  return code.length <= 8 ? code : `…${tail.slice(-4)}`;
};
const plural = (name: string, n: number) =>
  n === 1 ? name : /(s|x|z|ch|sh)$/.test(name) ? `${name}es` : `${name}s`;
const noun = (name?: string | null, fallback = "package") => (name ?? fallback).toLowerCase();

/** "PK-WH-1549-0000593" -> "…0593": enough to find it on a carton, the full code on hover. */
export const shortPackCode = short;

/** "carton …0572 › box …0597" — where a package came out of. */
export function packPathLabel(path?: PackRef[] | null): string {
  return (path ?? []).map((p) => `${noun(p.name, "pack")} ${short(p.code)}`).join(" › ");
}

/** Packages grouped by where they came out of, in first-seen order. */
export function packGroups<T extends { path?: PackRef[] | null }>(list: T[]): [string, T[]][] {
  const by = new Map<string, T[]>();
  for (const p of list) {
    const k = packPathLabel(p.path);
    by.set(k, [...(by.get(k) ?? []), p]);
  }
  return [...by.entries()];
}

/** What the strip detail inside a package comes to, in base units. */
export function innerLost(pkg: PackageToCheck, d?: InnerCheck): number {
  if (!d || !pkg.inner?.length) return 0;
  return pkg.inner.reduce((s, q) => s + (d.lost.includes(q.code)
    ? q.carries : Math.min(d.partial[q.code] ?? 0, q.carries)), 0);
}

/** "4 boxes + 5 strips" for a list of packages. */
export function packMix(list: { name?: string | null }[], fallback = "package"): string {
  const by = new Map<string, number>();
  for (const p of list) by.set(noun(p.name, fallback), (by.get(noun(p.name, fallback)) ?? 0) + 1);
  return [...by.entries()].map(([k, n]) => `${n} ${plural(k, n)}`).join(" + ");
}

interface Node {
  key: string;
  ref?: PackRef;         // a pack around the packages (a carton, an opened box)
  pkg?: PackageToCheck;  // a package on the line
  children: Node[];
}

/** The packages as the tree they came out of. Packs with no path stay flat. */
export function packageTree(packages: PackageToCheck[]): Node[] {
  const roots: Node[] = [];
  const index = new Map<string, Node>();
  const at = (list: Node[], ref: PackRef, key: string) => {
    let node = index.get(key);
    if (!node) {
      node = { key, ref, children: [] };
      index.set(key, node);
      list.push(node);
    }
    return node;
  };
  for (const pkg of packages) {
    let level = roots;
    let key = "";
    for (const ref of pkg.path ?? []) {
      key = `${key}/${ref.code}`;
      level = at(level, ref, key).children;
    }
    level.push({ key: `${key}/=${pkg.code}`, pkg, children: [] });
  }
  return roots;
}

const leaves = (n: Node): PackageToCheck[] =>
  n.pkg ? [n.pkg] : n.children.flatMap(leaves);

export function PackageCheckModal({
  open, onClose, onSave, packages, value, mode, packName = "package", uom, itemLabel,
  readOnly = false, target,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (check: PackageCheck) => void;
  packages: PackageToCheck[];
  value: PackageCheck;
  mode: "qc" | "receipt";
  packName?: string;
  uom?: string | null;
  itemLabel?: string;
  readOnly?: boolean;
  /** The rejected (short) base quantity the inspector typed, to allocate. */
  target?: number;
}) {
  const copy = COPY[mode];
  const [kept, setKept] = useState<string[]>([]);
  const [partial, setPartial] = useState<Record<string, number>>({});
  const [inner, setInner] = useState<Record<string, InnerCheck>>({});
  const [openInner, setOpenInner] = useState<Record<string, boolean>>({});
  const [confirm, setConfirm] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setKept(value.kept);
      setPartial({ ...value.partial });
      setInner({ ...(value.inner ?? {}) });
      setOpenInner({});
      setConfirm(null);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const byCode = useMemo(() => new Map(packages.map((p) => [p.code, p])), [packages]);
  const tree = useMemo(() => packageTree(packages), [packages]);
  const grouped = tree.some((n) => !n.pkg);

  /** What a kept package loses: its strip detail when it has any, else its count. */
  const lostIn = (pkg: PackageToCheck) => {
    const d = inner[pkg.code];
    return d && (d.lost.length || Object.keys(d.partial).length)
      ? Math.min(innerLost(pkg, d), pkg.carries)
      : Math.min(partial[pkg.code] ?? 0, pkg.carries);
  };
  const lostOf = (pkg: PackageToCheck) => (kept.includes(pkg.code) ? lostIn(pkg) : pkg.carries);
  const total = useMemo(() => packages.reduce((s, p) => s + p.carries, 0), [packages]);
  const lost = packages.reduce((s, p) => s + lostOf(p), 0);
  const good = total - lost;
  const name = packName.toLowerCase();
  const off = target !== undefined && Math.abs(lost - target) > 1e-6;
  const keptCount = packages.filter((p) => kept.includes(p.code)).length;

  // ---- one kind of pack, many of them: the quick count stays (2026-10-27) ----
  const kinds = useMemo(() => {
    if (grouped) return [];
    const by = new Map<string, PackageToCheck[]>();
    for (const p of packages) {
      if (!p.group) continue;
      by.set(p.group, [...(by.get(p.group) ?? []), p]);
    }
    return [...by.entries()].filter(([, list]) => list.length > 1);
  }, [packages, grouped]);

  const setMany = (codes: string[], keep: boolean) => {
    if (readOnly) return;
    setKept((now) => keep ? [...new Set([...now, ...codes])] : now.filter((c) => !codes.includes(c)));
    const drop = (rec: Record<string, unknown>) => {
      const next = { ...rec };
      for (const c of codes) delete next[c];
      return next;
    };
    setPartial((now) => drop(now) as Record<string, number>);
    setInner((now) => drop(now) as Record<string, InnerCheck>);
  };
  const setKindKept = (list: PackageToCheck[], n: number) => {
    const want = Math.max(0, Math.min(n, list.length));
    const codes = list.map((p) => p.code);
    setMany(codes.slice(want), false);
    setKept((now) => [...now.filter((c) => !codes.includes(c)), ...codes.slice(0, want)]);
  };
  const toggle = (code: string) => {
    if (readOnly) return;
    setMany([code], !kept.includes(code));
  };
  const setPart = (pkg: PackageToCheck, qty: number) => {
    const n = Math.max(0, Math.min(Math.floor(qty) || 0, pkg.carries - 1));
    setPartial((now) => ({ ...now, [pkg.code]: n }));
  };
  // ---- inside a kept package, strip by strip ----
  const innerOf = (code: string): InnerCheck => inner[code] ?? { lost: [], partial: {} };
  const setInnerFor = (pkg: PackageToCheck, next: InnerCheck) => {
    // Every strip gone is the box gone: it is rejected (missing) whole, not "all of it
    // out of a kept box", which the server refuses.
    if (innerLost(pkg, next) >= pkg.carries - 1e-6) {
      setMany([pkg.code], false);
      return;
    }
    setInner((now) => ({ ...now, [pkg.code]: next }));
    setPartial((now) => { const c = { ...now }; delete c[pkg.code]; return c; });
  };
  const toggleStrip = (pkg: PackageToCheck, code: string) => {
    const d = innerOf(pkg.code);
    const lostNow = d.lost.includes(code);
    const p = { ...d.partial };
    delete p[code];
    setInnerFor(pkg, { lost: lostNow ? d.lost.filter((c) => c !== code) : [...d.lost, code], partial: p });
  };
  const setStripPart = (pkg: PackageToCheck, strip: InnerPack, qty: number) => {
    const d = innerOf(pkg.code);
    const n = Math.max(0, Math.min(Math.floor(qty) || 0, strip.carries - 1));
    const p = { ...d.partial, [strip.code]: n };
    if (!n) delete p[strip.code];
    setInnerFor(pkg, { lost: d.lost, partial: p });
  };

  const save = () => {
    const outPartial: Record<string, number> = {};
    const outInner: Record<string, InnerCheck> = {};
    for (const p of packages) {
      if (!kept.includes(p.code)) continue;
      const n = lostIn(p);
      if (n > 0) outPartial[p.code] = n;
      const d = inner[p.code];
      if (d && (d.lost.length || Object.keys(d.partial).length)) outInner[p.code] = d;
    }
    onSave({ kept: kept.filter((c) => byCode.has(c)), partial: outPartial, inner: outInner });
    onClose();
  };

  // ---- drawing ----
  const groupHeader = (n: Node, depth: number) => {
    const list = leaves(n);
    const codes = list.map((p) => p.code);
    const keptHere = list.filter((p) => kept.includes(p.code)).length;
    const lostHere = list.reduce((s, p) => s + lostOf(p), 0);
    const carriesHere = list.reduce((s, p) => s + p.carries, 0);
    const label = `${noun(n.ref?.name, "pack")} ${short(n.ref!.code)}`;
    const confirming = confirm === n.key;
    return (
      <div className={`flex flex-wrap items-center gap-2 ${depth ? "px-3 py-2" : "px-4 py-3"}`}>
        <span className={`grid shrink-0 place-items-center rounded-lg bg-content2 text-brand ${depth ? "h-7 w-7" : "h-9 w-9"}`}>
          {depth ? <Box className="h-3.5 w-3.5" /> : <Boxes className="h-4 w-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold capitalize text-ink" title={n.ref!.code}>
            {label}{depth > 0 && <span className="ml-1 text-[11px] font-normal normal-case text-muted">opened</span>}
          </span>
          <span className="block text-[11px] text-muted">
            {packMix(list, name)} · {fmt(carriesHere)} {uom ?? ""}
            {lostHere > 0 && <> · <b className="text-bad">{fmt(lostHere)} {copy.lostNoun}</b></>}
          </span>
        </span>
        {!readOnly && (confirming ? (
          <span className="flex flex-wrap items-center gap-2 rounded-lg bg-bad/10 px-2 py-1 text-xs text-bad">
            <AlertTriangle className="h-3.5 w-3.5" />
            {copy.lostVerb} all {list.length}?
            <button type="button" onClick={() => setConfirm(null)}
                    className="min-h-8 rounded-md px-2 font-semibold text-ink hover:bg-content1">Cancel</button>
            <button type="button" onClick={() => { setMany(codes, false); setConfirm(null); }}
                    className="min-h-8 rounded-md bg-bad px-2 font-semibold text-white">{copy.lostVerb}</button>
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold tabular ${
              keptHere === list.length && !lostHere ? "bg-ok/10 text-ok" : "bg-warn-bg text-warn"}`}>
              {keptHere} / {list.length} {copy.kept.toLowerCase()}
            </span>
            <button type="button" onClick={() => setMany(codes, true)} disabled={keptHere === list.length}
                    className="min-h-9 rounded-lg px-2 text-xs font-semibold text-ok hover:bg-ok/10 disabled:opacity-40">
              All {copy.kept.toLowerCase()}
            </button>
            <button type="button" onClick={() => (mode === "receipt" ? setConfirm(n.key) : setMany(codes, false))}
                    disabled={keptHere === 0}
                    className="min-h-9 rounded-lg px-2 text-xs font-semibold text-bad hover:bg-bad/10 disabled:opacity-40">
              {mode === "receipt" ? "All missing" : "Reject all"}
            </button>
          </span>
        ))}
      </div>
    );
  };

  const packageRow = (pkg: PackageToCheck, i: number) => {
    const on = kept.includes(pkg.code);
    const d = inner[pkg.code];
    const detailed = !!d && (d.lost.length > 0 || Object.keys(d.partial).length > 0);
    const part = on ? lostIn(pkg) : 0;
    const strips = pkg.inner ?? [];
    const expanded = openInner[pkg.code] ?? detailed;
    const stripName = noun(strips[0]?.name, "strip");
    return (
      <li key={pkg.code}
          className={`rounded-xl border transition-colors ${
            on ? (part ? "border-warn/40 bg-warn/5" : "border-line bg-content1") : "border-bad/30 bg-bad/5"}`}>
        <div className="flex flex-wrap items-center gap-3 p-3">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-content2 text-[11px] font-bold text-muted">
            {i + 1}
          </span>
          <span className="min-w-0 flex-1">
            {pkg.label
              ? <span className="block truncate text-[13px] font-semibold text-ink">{pkg.label}</span>
              : (
                <span className="block truncate text-[13px] font-semibold text-ink" title={pkg.code}>
                  {pkg.name && <span className="capitalize">{noun(pkg.name)} </span>}
                  <span className="mono">{pkg.name ? short(pkg.code) : pkg.code}</span>
                </span>
              )}
            <span className="text-[11px] text-muted">
              {pkg.detail && <>{pkg.detail} · </>}
              carries {fmt(pkg.carries)} {uom ?? ""}
              {on && part > 0 && <> · <b className="text-warn">{fmt(pkg.carries - part)}</b> {copy.keptNoun}</>}
            </span>
          </span>
          {on && !readOnly && pkg.carries > 1 && !detailed && (
            <span className="flex items-center gap-1 text-[11px] text-muted">
              <button type="button" aria-label="Fewer" onClick={() => setPart(pkg, (partial[pkg.code] ?? 0) - 1)}
                      className="grid h-9 w-9 place-items-center rounded-lg border border-line hover:border-brand">
                <Minus className="h-3.5 w-3.5" />
              </button>
              <input type="number" onKeyDown={guardNumberKeys} min={0} max={pkg.carries - 1} value={partial[pkg.code] ?? 0}
                data-uom={uom ?? ""}
                     onChange={(e) => setPart(pkg, Number(e.target.value))}
                     aria-label={`${copy.partial} ${pkg.code}`}
                     className="h-9 w-14 rounded-lg border border-line bg-content1 text-center text-sm outline-none focus:border-brand" />
              <button type="button" aria-label="More" onClick={() => setPart(pkg, (partial[pkg.code] ?? 0) + 1)}
                      className="grid h-9 w-9 place-items-center rounded-lg border border-line hover:border-brand">
                <Plus className="h-3.5 w-3.5" />
              </button>
              <span className="ml-1 w-24">{copy.partial}</span>
            </span>
          )}
          {on && detailed && (
            <span className="text-[11px] font-semibold text-warn">{fmt(part)} {copy.partial} — from its {plural(stripName, 2)}</span>
          )}
          {on && readOnly && part > 0 && !detailed && (
            <span className="text-[11px] font-semibold text-warn">{fmt(part)} {copy.partial}</span>
          )}
          <button type="button" onClick={() => toggle(pkg.code)} disabled={readOnly}
                  aria-pressed={on}
                  className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold ${
                    on ? "bg-ok/10 text-ok" : "bg-bad/10 text-bad"}`}>
            {on ? <Check className="h-3.5 w-3.5" /> : <PackageX className="h-3.5 w-3.5" />}
            {on ? copy.kept : copy.whole}
          </button>
        </div>
        {on && strips.length > 0 && (
          <div className="border-t border-line/60 px-3 pb-3">
            <button type="button" onClick={() => setOpenInner((s) => ({ ...s, [pkg.code]: !expanded }))}
                    aria-expanded={expanded}
                    className="inline-flex min-h-9 items-center gap-1 text-xs font-semibold text-brand">
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
              {expanded ? "Hide" : "Check"} the {strips.length} {plural(stripName, strips.length)} inside
              {detailed && !expanded && <span className="ml-1 font-normal text-warn">· {d!.lost.length} {copy.whole.toLowerCase()}</span>}
            </button>
            {expanded && (
              <ul className="mt-1 grid gap-1.5 sm:grid-cols-2">
                {strips.map((s) => {
                  const gone = d?.lost.includes(s.code) ?? false;
                  const sp = d?.partial[s.code] ?? 0;
                  return (
                    <li key={s.code}
                        className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 ${
                          gone ? "border-bad/30 bg-bad/5" : sp ? "border-warn/40 bg-warn/5" : "border-line bg-content1"}`}>
                      <span className="min-w-0 flex-1">
                        <span className="mono block truncate text-[12px] font-semibold text-ink" title={s.code}>{short(s.code)}</span>
                        <span className="text-[10px] text-muted">
                          {gone ? copy.whole : sp ? `${fmt(s.carries - sp)} of ${fmt(s.carries)}` : `${fmt(s.carries)} ${uom ?? ""}`}
                        </span>
                      </span>
                      {!gone && !readOnly && s.carries > 1 && (
                        <span className="flex items-center gap-0.5">
                          <button type="button" aria-label={`Fewer ${copy.partial} ${s.code}`} disabled={!sp}
                                  onClick={() => setStripPart(pkg, s, sp - 1)}
                                  className="grid h-8 w-8 place-items-center rounded-md border border-line hover:border-brand disabled:opacity-40">
                            <Minus className="h-3 w-3" />
                          </button>
                          <span className="w-6 text-center text-xs font-bold tabular">{sp}</span>
                          <button type="button" aria-label={`More ${copy.partial} ${s.code}`}
                                  onClick={() => setStripPart(pkg, s, sp + 1)}
                                  className="grid h-8 w-8 place-items-center rounded-md border border-line hover:border-brand">
                            <Plus className="h-3 w-3" />
                          </button>
                        </span>
                      )}
                      <button type="button" disabled={readOnly} onClick={() => toggleStrip(pkg, s.code)}
                              aria-pressed={!gone}
                              className={`inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-[11px] font-semibold ${
                                gone ? "bg-bad/10 text-bad" : "bg-ok/10 text-ok"}`}>
                        {gone ? <PackageX className="h-3 w-3" /> : <Check className="h-3 w-3" />}
                        {gone ? copy.whole : copy.kept}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </li>
    );
  };

  let counter = 0;
  const draw = (nodes: Node[], depth: number): ReactNode[] => nodes.map((n) => {
    if (n.pkg) return packageRow(n.pkg, counter++);
    return (
      <li key={n.key} className={`overflow-hidden rounded-2xl border ${depth ? "border-line/70 bg-content2/30" : "border-line bg-content2/40"}`}>
        {groupHeader(n, depth)}
        <ul className={`space-y-2 ${depth ? "px-2 pb-2" : "px-3 pb-3"}`}>{draw(n.children, depth + 1)}</ul>
      </li>
    );
  });

  return (
    <Modal isOpen={open} onOpenChange={(o) => { if (!o) onClose(); }} size="3xl"
           scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          <span className="flex items-center gap-2 text-base font-semibold text-ink">
            <Box className="h-4 w-4 text-brand" aria-hidden /> {copy.title}
          </span>
          {itemLabel && <span className="text-xs font-normal text-muted">{itemLabel}</span>}
        </ModalHeader>
        <ModalBody className="gap-3">
          <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-line bg-line text-center">
            {[
              [`${plural(name, 2)} ${mode === "qc" ? "kept" : "arrived"}`, `${keptCount} / ${packages.length}`, "text-ink"],
              [copy.keptNoun, `${fmt(good)} ${uom ?? ""}`, "text-ok"],
              [copy.lostNoun, `${fmt(lost)} ${uom ?? ""}`, lost ? "text-bad" : "text-muted"],
            ].map(([label, figure, tone]) => (
              <div key={label} className="bg-content1 px-3 py-2.5">
                <div className={`text-lg font-bold tabular ${tone}`}>{figure}</div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</div>
              </div>
            ))}
          </div>
          {target !== undefined && (
            <p className={`rounded-lg px-3 py-2 text-xs ${off ? "bg-warn-bg text-warn" : "bg-ok/10 text-ok"}`}>
              {off
                ? `You entered ${fmt(target)} ${copy.lostNoun} — the packages below say ${fmt(lost)}. Saving here sets it to ${fmt(lost)}.`
                : `Every ${copy.lostNoun} unit is placed in a ${name}.`}
            </p>
          )}
          {!readOnly && <p className="text-xs text-muted">{copy.hint}</p>}
          {kinds.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {kinds.map(([group, list]) => {
                const n = list.filter((p) => kept.includes(p.code)).length;
                return (
                  <div key={group}
                       className="flex items-center gap-2 rounded-xl border border-line bg-content2/40 px-3 py-1.5">
                    <span className="text-xs font-semibold text-ink">{group}</span>
                    <button type="button" aria-label={`One fewer ${group} ${copy.kept.toLowerCase()}`}
                            disabled={readOnly || n === 0} onClick={() => setKindKept(list, n - 1)}
                            className="grid h-9 w-9 place-items-center rounded-lg border border-line hover:border-brand disabled:opacity-40">
                      <Minus className="h-3.5 w-3.5" />
                    </button>
                    <span className="min-w-16 text-center text-xs tabular">
                      <b className={n < list.length ? "text-bad" : "text-ok"}>{n}</b> of {list.length} {copy.kept.toLowerCase()}
                    </span>
                    <button type="button" aria-label={`One more ${group} ${copy.kept.toLowerCase()}`}
                            disabled={readOnly || n === list.length} onClick={() => setKindKept(list, n + 1)}
                            className="grid h-9 w-9 place-items-center rounded-lg border border-line hover:border-brand disabled:opacity-40">
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <ul className="space-y-2">{draw(tree, 0)}</ul>
        </ModalBody>
        <ModalFooter className="flex flex-wrap items-center justify-between gap-2">
          {!readOnly ? (
            <Button variant="ghost" onClick={() => setMany(packages.map((p) => p.code), true)}>
              <CheckCheck size={14} /> All {copy.kept.toLowerCase()}
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>{readOnly ? "Close" : "Cancel"}</Button>
            {!readOnly && (
              <Button onClick={save}>
                <Check size={14} /> Save
              </Button>
            )}
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
