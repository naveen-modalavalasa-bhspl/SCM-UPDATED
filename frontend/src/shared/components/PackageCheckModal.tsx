import { useEffect, useMemo, useState } from "react";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { Box, Check, CheckCheck, Minus, PackageX, Plus } from "lucide-react";
import { Button } from "./ui";

/**
 * Check a line package by package (2026-10-26) — outward QC and the receiving site.
 *
 * An item issued in a container travels as PACKAGES, each with its own code. What is
 * wrong with a delivery is always said against a package: a package rejected (or
 * missing) WHOLE, or some units out of a package that is otherwise kept (rejected
 * inside it, or short in it). The two add up to the line's rejected (short) base
 * quantity, so every unit that does not go on can be traced to the package it came
 * out of.
 */
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
}

export interface PackageCheck {
  /** Packages kept (accepted / arrived). */
  kept: string[];
  /** Units taken out of a KEPT package: rejected in it, or short in it. */
  partial: Record<string, number>;
}

const COPY = {
  qc: {
    title: "Inspect the packages",
    kept: "Kept", whole: "Rejected", partial: "rejected out of it",
    keptNoun: "accepted", lostNoun: "rejected",
    hint: "Untick a package to reject it whole. For a few bad units, keep it and say how many came out of it.",
  },
  receipt: {
    title: "Check the packages",
    kept: "Arrived", whole: "Missing", partial: "short in it",
    keptNoun: "received", lostNoun: "short",
    hint: "Mark a package missing if it never arrived. If it came short, keep it and say how many are missing from it.",
  },
} as const;

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
  useEffect(() => {
    if (open) {
      setKept(value.kept);
      setPartial({ ...value.partial });
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = useMemo(() => packages.reduce((s, p) => s + p.carries, 0), [packages]);
  const lost = useMemo(() => packages.reduce((s, p) => s + (kept.includes(p.code)
    ? Math.min(partial[p.code] ?? 0, p.carries) : p.carries), 0), [packages, kept, partial]);
  const good = total - lost;
  const name = packName.toLowerCase();
  const plural = /(x|s|ch|sh)$/.test(name) ? `${name}es` : `${name}s`;
  const off = target !== undefined && Math.abs(lost - target) > 1e-6;

  // One quick count per kind of pack: "Carton — 18 of 20 kept". Lowering it leaves
  // packs out from the END of the list, raising it takes them back in order, so a
  // line of fifty cartons is not fifty presses.
  const groups = useMemo(() => {
    const by = new Map<string, PackageToCheck[]>();
    for (const p of packages) {
      if (!p.group) continue;
      by.set(p.group, [...(by.get(p.group) ?? []), p]);
    }
    return [...by.entries()].filter(([, list]) => list.length > 1);
  }, [packages]);
  const setGroupKept = (list: PackageToCheck[], n: number) => {
    if (readOnly) return;
    const want = Math.max(0, Math.min(n, list.length));
    const codes = list.map((p) => p.code);
    setKept((now) => {
      const others = now.filter((c) => !codes.includes(c));
      return [...others, ...codes.slice(0, want)];
    });
    setPartial((now) => {
      const next = { ...now };
      for (const c of codes.slice(want)) delete next[c];
      return next;
    });
  };

  const toggle = (code: string) => {
    if (readOnly) return;
    setKept((now) => now.includes(code) ? now.filter((c) => c !== code) : [...now, code]);
    setPartial((now) => { const next = { ...now }; delete next[code]; return next; });
  };
  const setPart = (pkg: PackageToCheck, qty: number) => {
    const n = Math.max(0, Math.min(Math.floor(qty) || 0, pkg.carries - 1));
    setPartial((now) => ({ ...now, [pkg.code]: n }));
  };

  return (
    <Modal isOpen={open} onOpenChange={(o) => { if (!o) onClose(); }} size="2xl"
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
              [`${plural} ${copy.keptNoun === "accepted" ? "kept" : "arrived"}`, `${kept.length} / ${packages.length}`, "text-ink"],
              [copy.keptNoun, `${good.toLocaleString("en-IN")} ${uom ?? ""}`, "text-ok"],
              [copy.lostNoun, `${lost.toLocaleString("en-IN")} ${uom ?? ""}`, lost ? "text-bad" : "text-muted"],
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
                ? `You entered ${target.toLocaleString("en-IN")} ${copy.lostNoun} — the packages below say ${lost.toLocaleString("en-IN")}. Saving here sets it to ${lost.toLocaleString("en-IN")}.`
                : `Every ${copy.lostNoun} unit is placed in a ${name}.`}
            </p>
          )}
          {!readOnly && <p className="text-xs text-muted">{copy.hint}</p>}
          {groups.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {groups.map(([group, list]) => {
                const n = list.filter((p) => kept.includes(p.code)).length;
                return (
                  <div key={group}
                       className="flex items-center gap-2 rounded-xl border border-line bg-content2/40 px-3 py-1.5">
                    <span className="text-xs font-semibold text-ink">{group}</span>
                    <button type="button" aria-label={`One fewer ${group} ${copy.kept.toLowerCase()}`}
                            disabled={readOnly || n === 0} onClick={() => setGroupKept(list, n - 1)}
                            className="grid h-8 w-8 place-items-center rounded-lg border border-line hover:border-brand disabled:opacity-40">
                      <Minus className="h-3.5 w-3.5" />
                    </button>
                    <span className="min-w-16 text-center text-xs tabular">
                      <b className={n < list.length ? "text-bad" : "text-ok"}>{n}</b> of {list.length} {copy.kept.toLowerCase()}
                    </span>
                    <button type="button" aria-label={`One more ${group} ${copy.kept.toLowerCase()}`}
                            disabled={readOnly || n === list.length} onClick={() => setGroupKept(list, n + 1)}
                            className="grid h-8 w-8 place-items-center rounded-lg border border-line hover:border-brand disabled:opacity-40">
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <ul className="space-y-2">
            {packages.map((pkg, i) => {
              const on = kept.includes(pkg.code);
              const part = partial[pkg.code] ?? 0;
              return (
                <li key={pkg.code}
                    className={`flex flex-wrap items-center gap-3 rounded-xl border p-3 transition-colors ${
                      on ? (part ? "border-warn/40 bg-warn/5" : "border-line bg-content1")
                        : "border-bad/30 bg-bad/5"}`}>
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-content2 text-[11px] font-bold text-muted">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    {pkg.label
                      ? <span className="block truncate text-[13px] font-semibold text-ink">{pkg.label}</span>
                      : <span className="mono block truncate text-[13px] font-semibold text-ink" title={pkg.code}>{pkg.code}</span>}
                    <span className="text-[11px] text-muted">
                      {pkg.detail && <>{pkg.detail} · </>}
                      carries {pkg.carries.toLocaleString("en-IN")} {uom ?? ""}
                      {on && part > 0 && <> · <b className="text-warn">{pkg.carries - part}</b> {copy.keptNoun}</>}
                    </span>
                  </span>
                  {on && !readOnly && pkg.carries > 1 && (
                    <span className="flex items-center gap-1 text-[11px] text-muted">
                      <button type="button" aria-label="Fewer" onClick={() => setPart(pkg, part - 1)}
                              className="grid h-8 w-8 place-items-center rounded-lg border border-line hover:border-brand">
                        <Minus className="h-3.5 w-3.5" />
                      </button>
                      <input type="number" min={0} max={pkg.carries - 1} value={part}
                             onChange={(e) => setPart(pkg, Number(e.target.value))}
                             aria-label={`${copy.partial} ${pkg.code}`}
                             className="h-8 w-14 rounded-lg border border-line bg-content1 text-center text-sm outline-none focus:border-brand" />
                      <button type="button" aria-label="More" onClick={() => setPart(pkg, part + 1)}
                              className="grid h-8 w-8 place-items-center rounded-lg border border-line hover:border-brand">
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                      <span className="ml-1 w-24">{copy.partial}</span>
                    </span>
                  )}
                  {on && readOnly && part > 0 && (
                    <span className="text-[11px] font-semibold text-warn">{part} {copy.partial}</span>
                  )}
                  <button type="button" onClick={() => toggle(pkg.code)} disabled={readOnly}
                          aria-pressed={on}
                          className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold ${
                            on ? "bg-ok/10 text-ok" : "bg-bad/10 text-bad"}`}>
                    {on ? <Check className="h-3.5 w-3.5" /> : <PackageX className="h-3.5 w-3.5" />}
                    {on ? copy.kept : copy.whole}
                  </button>
                </li>
              );
            })}
          </ul>
        </ModalBody>
        <ModalFooter className="flex flex-wrap items-center justify-between gap-2">
          {!readOnly ? (
            <Button variant="ghost" onClick={() => { setKept(packages.map((p) => p.code)); setPartial({}); }}>
              <CheckCheck size={14} /> All {copy.kept.toLowerCase()}
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>{readOnly ? "Close" : "Cancel"}</Button>
            {!readOnly && (
              <Button onClick={() => {
                const clean = Object.fromEntries(Object.entries(partial)
                  .filter(([code, n]) => kept.includes(code) && n > 0));
                onSave({ kept, partial: clean });
                onClose();
              }}>
                <Check size={14} /> Save
              </Button>
            )}
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
