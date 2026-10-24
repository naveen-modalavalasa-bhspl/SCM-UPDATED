import { useState, type ReactNode } from "react";
import {
  CalendarClock, Check, ChevronDown, Divide, Lightbulb, Minus, Plus, SlidersHorizontal,
} from "lucide-react";
import {
  MAX_INSTALMENTS, MIN_INSTALMENTS, PAYMENT_STAGES, joinList, planInstalments, planTotal,
  resizeInstalments, rupees, splitList, stageInstalments, stagePct, stageProblem,
  stageSplit, whenText, type Instalment, type PaymentStage, type PlanValues,
} from "../paymentPlan";
import type { PaymentSplit } from "../types";

/**
 * The payment plan of a payment term: how much of the order each of the four stages
 * pays, and whether a stage is paid in one go or split into instalments — EQUAL (the
 * stage divided evenly) or CUSTOM (each instalment its own share). Edits the flat
 * form values (`delivery_pct`, `delivery_split`, `delivery_instalment_days` …) so
 * MasterCrud saves it like any other field.
 */
export function PaymentPlanEditor({
  values, onPatch, error,
}: {
  values: PlanValues;
  onPatch: (patch: PlanValues) => void;
  error?: string;
}) {
  const [sample, setSample] = useState("100000");
  const amount = Math.max(0, Number(sample) || 0);
  const total = planTotal(values);

  return (
    <div className="space-y-3">
      <AllocationBar values={values} total={total} />

      {PAYMENT_STAGES.map((stage) => (
        <StageCard key={stage.key} stage={stage} values={values} onPatch={onPatch}
                   sample={amount} />
      ))}

      {error && (
        <div role="alert" className="rounded-xl border border-bad/30 bg-bad-bg px-3 py-2 text-sm font-medium text-bad">
          {error}
        </div>
      )}

      <div className="rounded-2xl border border-line bg-content1 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-brand" />
            <h3 className="text-sm font-semibold text-ink">Payment timeline preview</h3>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted">
            On an order of
            <span className="relative">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted">₹</span>
              <input type="number" min={0} value={sample}
                     onChange={(e) => setSample(e.target.value)}
                     aria-label="Sample order value"
                     className="h-11 w-36 rounded-xl border border-line bg-content1 pl-6 pr-2 text-sm tabular-nums text-ink outline-none focus:border-brand" />
            </span>
          </label>
        </div>
        <PaymentPlanPreview instalments={planInstalments(values)} amount={amount} />
      </div>

      <PlanGuide />
    </div>
  );
}

/** Plain-language notes for whoever sets up a term for the first time. */
function PlanGuide() {
  const [open, setOpen] = useState(true);
  return (
    <div className="overflow-hidden rounded-2xl border border-info/25 bg-info-bg">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
              className="flex min-h-11 w-full items-center gap-2 px-4 text-left text-sm font-semibold text-info">
        <Lightbulb className="h-4 w-4 shrink-0" />
        How a payment term works
        <ChevronDown className={`ml-auto h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul className="space-y-1.5 px-4 pb-3 text-xs leading-relaxed text-body">
          <li><b className="text-ink">1. Split the order into stages.</b> Give each stage a share
            of the order value. The four shares must add up to <b>100%</b>.</li>
          <li><b className="text-ink">2. Each stage starts its own clock:</b> Advance when the PO is
            approved, Delivery when the goods arrive, Installation when it is signed off,
            Warranty when the warranty period ends. "Days" are always counted from that moment.</li>
          <li><b className="text-ink">3. Leave both boxes unticked to pay a stage in one payment.</b>{" "}
            Tick <b>Equal instalments</b> to divide it into equal parts — 30% of ₹10,000 = ₹3,000,
            in 4 parts = ₹750 each at 30, 60, 90 and 120 days. Tick <b>Custom instalments</b> to set
            each part's share yourself, e.g. 30% + 40% + 10% + 20%.</li>
          <li><b className="text-ink">4. On the PO,</b> every payment gets a code — <b>ADV</b> advance,{" "}
            <b>DLV</b> delivery, <b>INS</b> installation, <b>WAR</b> warranty, then which instalment
            (DLV 2/4 = the 2nd of 4 delivery payments). Accounts pays against those codes.</li>
          <li><b className="text-ink">5. Changing a term later</b> never changes a PO already raised
            with it — the order keeps the plan it was approved with.</li>
        </ul>
      )}
    </div>
  );
}

/** The order's 100%, coloured by stage, with what is left to allocate. */
function AllocationBar({ values, total }: { values: PlanValues; total: number }) {
  const ok = total === 100;
  const left = Math.round((100 - total) * 100) / 100;
  return (
    <div className="rounded-2xl border border-line bg-content1 p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-ink">Share of the order</span>
        <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums ${
          ok ? "bg-ok-bg text-ok" : "bg-warn-bg text-warn"}`}>
          {ok && <Check className="h-3.5 w-3.5" />}
          {ok ? "100% allocated"
            : left > 0 ? `${total}% allocated · ${left}% still to place`
            : `${total}% — ${-left}% too much`}
        </span>
      </div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-neutral-bg">
        {PAYMENT_STAGES.map((s) => {
          const pct = Math.min(stagePct(values, s.key), 100);
          return pct > 0 ? (
            <div key={s.key} title={`${s.label}: ${pct}%`}
                 style={{ width: `${pct}%`, background: `var(--color-${s.tone})` }}
                 className="h-full border-r border-content1 last:border-r-0" />
          ) : null;
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {PAYMENT_STAGES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5 text-xs text-muted">
            <span className="h-2 w-2 rounded-full" style={{ background: `var(--color-${s.tone})` }} />
            {s.label} <b className="tabular-nums text-ink">{stagePct(values, s.key)}%</b>
          </span>
        ))}
      </div>
    </div>
  );
}

const NUM_INPUT =
  "h-11 w-full rounded-xl border border-line bg-content1 px-3 text-sm tabular-nums text-ink outline-none focus:border-brand disabled:bg-neutral-bg disabled:text-muted";

/** One stage: its share, and how that share is paid. */
function StageCard({
  stage, values, onPatch, sample,
}: { stage: PaymentStage; values: PlanValues; onPatch: (p: PlanValues) => void; sample: number }) {
  const k = stage.key;
  const pct = stagePct(values, k);
  const split = stageSplit(values, k);
  const days = splitList(values[`${k}_instalment_days`]);
  const shares = splitList(values[`${k}_instalment_pcts`]);
  const parts = stageInstalments(values, stage);
  const problem = stageProblem(values, stage);
  const stageAmount = (sample * pct) / 100;
  const color = `var(--color-${stage.tone})`;

  /** Tick a box. Ticking the one already ticked goes back to a single payment. */
  const choose = (mode: PaymentSplit) => {
    const next: PaymentSplit = split === mode ? "ONE" : mode;
    const patch: PlanValues = { [`${k}_split`]: next };
    if (next !== "ONE") {
      // First time split: start at three monthly payments (30, 60, 90 days) — the
      // most common plan — and keep whatever rows a previous split already had.
      const count = days.length >= MIN_INSTALMENTS ? days.length : 3;
      if (days.length < MIN_INSTALMENTS) Object.assign(patch, resizeInstalments(values, k, count));
      // Custom starts from equal parts, so the stage is whole (100%) from the first
      // tick and the user only moves the parts they want different.
      if (next === "CUSTOM") patch[`${k}_instalment_pcts`] = joinList(evenShares(count));
    }
    onPatch(patch);
  };

  const setCount = (n: number) => {
    const clamped = Math.min(MAX_INSTALMENTS, Math.max(MIN_INSTALMENTS, n));
    onPatch(resizeInstalments(values, k, clamped));
  };
  const setDay = (i: number, v: string) => {
    const next = [...days]; next[i] = v.replace(/[^\d]/g, "");
    onPatch({ [`${k}_instalment_days`]: joinList(next) });
  };
  const setShare = (i: number, v: string) => {
    const next = days.map((_, j) => shares[j] ?? "");
    next[i] = v.replace(/[^\d.]/g, "");
    onPatch({ [`${k}_instalment_pcts`]: joinList(next) });
  };
  const allocated = Math.round(shares.slice(0, days.length)
    .reduce((a, b) => a + (Number(b) || 0), 0) * 100) / 100;

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-content1"
             style={{ boxShadow: `inset 4px 0 0 ${color}` }}>
      <div className="flex flex-wrap items-start gap-3 p-4 pl-5">
        <div className="min-w-[12rem] flex-1">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold text-ink">{stage.label}</h4>
            <span className="rounded-md px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wider text-white"
                  style={{ background: color }}>{stage.short}</span>
          </div>
          <p className="mt-0.5 text-xs text-muted">Clock starts: {stage.trigger.toLowerCase()}</p>
        </div>
        <label className="w-36">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted">
            Share of order
          </span>
          <span className="relative block">
            <input type="number" min={0} max={100} step="0.01" inputMode="decimal"
                   aria-label={`${stage.label} share of the order, percent`}
                   value={String(values[`${k}_pct`] ?? "")}
                   onChange={(e) => onPatch({ [`${k}_pct`]: e.target.value })}
                   className={`${NUM_INPUT} pr-8`} />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted">%</span>
          </span>
        </label>
      </div>

      {pct <= 0 ? (
        <p className="border-t border-line/70 px-5 py-2.5 text-xs text-muted">
          Not used. Enter a share to pay part of the order at this stage.
        </p>
      ) : (
        <div className="space-y-3 border-t border-line/70 px-5 py-4">
          {/* The two boxes. Neither ticked = one payment. */}
          <div className="grid gap-2 sm:grid-cols-2">
            <SplitOption checked={split === "EQUAL"} onToggle={() => choose("EQUAL")}
              icon={<Divide className="h-4 w-4" />} title="Equal instalments"
              detail={`Divide ${pct}% into equal parts`} />
            <SplitOption checked={split === "CUSTOM"} onToggle={() => choose("CUSTOM")}
              icon={<SlidersHorizontal className="h-4 w-4" />} title="Custom instalments"
              detail="Set each part's share yourself" />
          </div>

          {split === "ONE" ? (
            <label className="flex flex-wrap items-center gap-2 text-sm text-body">
              Pay the full {pct}% in one payment, within
              <input type="number" min={0} max={3650} inputMode="numeric"
                     aria-label={`${stage.label} payable within days`}
                     value={String(values[`${k}_days`] ?? "")}
                     onChange={(e) => onPatch({ [`${k}_days`]: e.target.value })}
                     className={`${NUM_INPUT} !w-24`} />
              days {stage.after}
              {sample > 0 && <span className="text-xs text-muted">({rupees(stageAmount)} on the sample order)</span>}
            </label>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm font-medium text-ink">Number of instalments</span>
                <div className="inline-flex items-center rounded-xl border border-line">
                  <button type="button" aria-label="One fewer instalment"
                          disabled={days.length <= MIN_INSTALMENTS}
                          onClick={() => setCount(days.length - 1)}
                          className="flex h-11 w-11 items-center justify-center text-body hover:bg-content2 disabled:opacity-40">
                    <Minus className="h-4 w-4" />
                  </button>
                  <input type="number" min={MIN_INSTALMENTS} max={MAX_INSTALMENTS}
                         aria-label="Number of instalments" value={days.length}
                         onChange={(e) => setCount(Number(e.target.value) || MIN_INSTALMENTS)}
                         className="h-11 w-12 border-x border-line bg-transparent text-center text-sm font-semibold tabular-nums text-ink outline-none" />
                  <button type="button" aria-label="One more instalment"
                          disabled={days.length >= MAX_INSTALMENTS}
                          onClick={() => setCount(days.length + 1)}
                          className="flex h-11 w-11 items-center justify-center text-body hover:bg-content2 disabled:opacity-40">
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
                {split === "EQUAL" && sample > 0 && days.length > 0 && (
                  <span className="text-xs text-muted">
                    {rupees(stageAmount)} ÷ {days.length} = <b className="text-ink">{rupees(stageAmount / days.length)}</b> each
                  </span>
                )}
              </div>

              <div className="overflow-hidden rounded-xl border border-line/70">
                <div className="hidden grid-cols-[5.5rem_1fr_1fr_1fr] gap-3 bg-content2 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted sm:grid">
                  <span>Payment</span><span>Pay after</span><span>Share of stage</span>
                  <span className="text-right">Of order · amount</span>
                </div>
                {days.map((d, i) => {
                  const part = parts[i];
                  return (
                    <div key={i} className="grid grid-cols-2 items-center gap-3 border-t border-line/60 px-3 py-2 first:border-t-0 sm:grid-cols-[5.5rem_1fr_1fr_1fr] sm:first:border-t">
                      <span className="col-span-2 font-mono text-xs font-bold sm:col-span-1" style={{ color }}>
                        {stage.short} {i + 1}/{days.length}
                      </span>
                      <label className="flex items-center gap-2">
                        <input type="text" inputMode="numeric" value={d}
                               aria-label={`Instalment ${i + 1} days ${stage.after}`}
                               onChange={(e) => setDay(i, e.target.value)}
                               className={`${NUM_INPUT} !w-20`} />
                        <span className="text-xs text-muted">days</span>
                      </label>
                      {split === "CUSTOM" ? (
                        <label className="flex items-center gap-2">
                          <input type="text" inputMode="decimal" value={shares[i] ?? ""}
                                 placeholder="0"
                                 aria-label={`Instalment ${i + 1} share of the stage, percent`}
                                 onChange={(e) => setShare(i, e.target.value)}
                                 className={`${NUM_INPUT} !w-20`} />
                          <span className="text-xs text-muted">%</span>
                        </label>
                      ) : (
                        <span className="text-sm tabular-nums text-body">{part ? `${part.stagePct}%` : "—"}</span>
                      )}
                      <span className="text-right text-sm tabular-nums">
                        <span className="text-muted">{part ? `${part.orderPct}%` : "—"}</span>
                        {sample > 0 && part && (
                          <b className="ml-2 text-ink">{rupees((sample * part.orderPct) / 100)}</b>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-muted">Days are counted {stage.after}. Each instalment must come after the one before it.</p>

              {split === "CUSTOM" && (
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className={allocated === 100 ? "font-semibold text-ok" : "font-semibold text-warn"}>
                      {allocated === 100 ? "✓ The parts make 100% of this stage"
                        : allocated < 100 ? `${allocated}% placed · ${Math.round((100 - allocated) * 100) / 100}% of the stage left`
                        : `${allocated}% placed — ${Math.round((allocated - 100) * 100) / 100}% too much`}
                    </span>
                    {allocated !== 100 && (
                      <button type="button"
                              onClick={() => onPatch({ [`${k}_instalment_pcts`]: joinList(evenShares(days.length)) })}
                              className="min-h-11 rounded-lg px-2 font-semibold text-brand hover:bg-brand-050">
                        Reset to equal parts
                      </button>
                    )}
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-neutral-bg">
                    <div className="h-full rounded-full transition-all"
                         style={{ width: `${Math.min(allocated, 100)}%`,
                                  background: allocated === 100 ? "var(--color-ok)" : "var(--color-warn)" }} />
                  </div>
                </div>
              )}
            </>
          )}
          {problem && <p className="text-xs font-medium text-bad">{problem}</p>}
        </div>
      )}
    </section>
  );
}

/** "33.33, 33.33, 33.34": equal shares of 100 that add up exactly. */
function evenShares(n: number): string[] {
  const each = Math.floor((100 / n) * 100) / 100;
  const out = Array.from({ length: n }, () => each);
  out[n - 1] = Math.round((100 - each * (n - 1)) * 100) / 100;
  return out.map(String);
}

/** A checkbox drawn as a tile: the box, what it does, and one line of why. */
function SplitOption({
  checked, onToggle, icon, title, detail,
}: { checked: boolean; onToggle: () => void; icon: ReactNode; title: string; detail: string }) {
  return (
    <label className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
      checked ? "border-brand bg-brand-050" : "border-line hover:bg-content2"}`}>
      <input type="checkbox" checked={checked} onChange={onToggle}
             className="h-4 w-4 shrink-0 accent-[var(--color-brand)]" />
      <span className={checked ? "text-brand" : "text-muted"}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-ink">{title}</span>
        <span className="block text-xs text-muted">{detail}</span>
      </span>
    </label>
  );
}

/**
 * Every payment of a plan as a timeline: code, when, share and amount. Shared by the
 * master form and the PO, so a buyer picking a term sees exactly what accounts will
 * be asked to pay.
 */
export function PaymentPlanPreview({
  instalments, amount,
}: { instalments: Instalment[]; amount: number }) {
  if (!instalments.length) {
    return <p className="text-sm text-muted">Give at least one stage a share to see the payments.</p>;
  }
  return (
    <ol className="relative space-y-2">
      {instalments.map((p) => {
        const color = `var(--color-${p.stage.tone})`;
        return (
          <li key={p.code} className="flex items-center gap-3 rounded-xl border border-line/70 bg-content1 px-3 py-2">
            <span className="w-[4.75rem] shrink-0 rounded-md px-1.5 py-1 text-center font-mono text-[11px] font-bold text-white"
                  style={{ background: color }}>{p.code}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-ink">
                {p.stage.label}{p.of > 1 ? ` — instalment ${p.n} of ${p.of}` : ""}
              </span>
              <span className="block text-xs text-muted">{whenText(p)}</span>
            </span>
            <span className="text-right tabular-nums">
              <span className="block text-sm font-semibold text-ink">
                {amount > 0 ? rupees((amount * p.orderPct) / 100) : `${p.orderPct}%`}
              </span>
              {amount > 0 && <span className="block text-xs text-muted">{p.orderPct}% of order</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
