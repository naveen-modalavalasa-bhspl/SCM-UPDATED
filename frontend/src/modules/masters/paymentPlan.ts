import type { PaymentSplit, PaymentStageKey } from "./types";

/**
 * A payment term as the payments it becomes. The SAME arithmetic as
 * `term_instalments` in backend/app/shared/masters/defs.py — the server is what the
 * PO is built from; this only lets the form show it before Save. Keep them in step.
 */

export interface PaymentStage {
  key: PaymentStageKey;
  label: string;
  /** Milestone code printed on the PO and the accounts desk: ADV 1/1, DLV 2/4. */
  short: string;
  /** When the clock for this stage starts. */
  trigger: string;
  /** How a day count on this stage reads: "30 days after delivery". */
  after: string;
  /** Tailwind colour token for the stage's dot, bar and chip. */
  tone: string;
}

export const PAYMENT_STAGES: PaymentStage[] = [
  { key: "advance", label: "Advance", short: "ADV", trigger: "When the PO is approved",
    after: "after PO approval", tone: "cat-1" },
  { key: "delivery", label: "Against delivery", short: "DLV",
    trigger: "When the goods are received", after: "after delivery", tone: "cat-2" },
  { key: "installation", label: "Post installation / commissioning", short: "INS",
    trigger: "When installation is signed off", after: "after installation", tone: "cat-3" },
  { key: "warranty", label: "Post support / warranty", short: "WAR",
    trigger: "When the warranty or support period ends", after: "after the warranty ends",
    tone: "cat-4" },
];

export const MAX_INSTALMENTS = 12;
export const MIN_INSTALMENTS = 2;

/** Loose form values: inputs hold strings while being typed. */
export type PlanValues = Record<string, unknown>;

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

/** "30,,90" -> ["30", "", "90"]. Keeps the blanks: a row being typed is still a row. */
export const splitList = (v: unknown): string[] =>
  v === null || v === undefined || String(v) === "" ? [] : String(v).split(",").map((s) => s.trim());
export const joinList = (parts: string[]) => parts.join(",");

export const stagePct = (values: PlanValues, key: PaymentStageKey) => num(values[`${key}_pct`]);
export const stageSplit = (values: PlanValues, key: PaymentStageKey): PaymentSplit => {
  const s = String(values[`${key}_split`] ?? "ONE");
  return s === "EQUAL" || s === "CUSTOM" ? s : "ONE";
};

/** The four stage shares added up. */
export const planTotal = (values: PlanValues) =>
  round2(PAYMENT_STAGES.reduce((sum, s) => sum + stagePct(values, s.key), 0));

export interface Instalment {
  stage: PaymentStage;
  /** 1-based, within the stage. */
  n: number;
  of: number;
  /** "DLV 2/4". */
  code: string;
  /** Share of the STAGE, %. */
  stagePct: number;
  /** Share of the ORDER, %. */
  orderPct: number;
  days: number;
}

/** One stage as payments. A stage at 0% is none. */
export function stageInstalments(values: PlanValues, stage: PaymentStage): Instalment[] {
  const pct = stagePct(values, stage.key);
  if (pct <= 0) return [];
  const split = stageSplit(values, stage.key);
  const days = splitList(values[`${stage.key}_instalment_days`]).map(num);
  const make = (parts: { stagePct: number; orderPct: number; days: number }[]) =>
    parts.map((p, i) => ({
      stage, n: i + 1, of: parts.length, code: `${stage.short} ${i + 1}/${parts.length}`, ...p,
    }));
  if (split === "ONE" || days.length < MIN_INSTALMENTS) {
    return make([{ stagePct: 100, orderPct: round2(pct), days: num(values[`${stage.key}_days`]) }]);
  }
  let shares: number[];
  let order: number[];
  if (split === "CUSTOM") {
    shares = splitList(values[`${stage.key}_instalment_pcts`]).map(num);
    while (shares.length < days.length) shares.push(0);
    shares = shares.slice(0, days.length);
    order = shares.map((s) => round2((pct * s) / 100));
  } else {
    // The ORDER share is divided, so 50% in three is 16.67 / 16.67 / 16.66.
    const even = round2(pct / days.length);
    order = days.map(() => even);
    shares = days.map(() => round2((even * 100) / pct));
    shares[shares.length - 1] = round2(100 - shares.slice(0, -1).reduce((a, b) => a + b, 0));
  }
  const sumShares = round2(shares.reduce((a, b) => a + b, 0));
  // The last takes the rounding — but only once the shares are whole, or a half-typed
  // custom plan would show its last row soaking up everything not yet allocated.
  if (split === "EQUAL" || sumShares === 100) {
    order[order.length - 1] = round2(pct - order.slice(0, -1).reduce((a, b) => a + b, 0));
  }
  return make(shares.map((s, i) => ({ stagePct: s, orderPct: order[i], days: days[i] })));
}

/** Every payment the term makes, stage by stage. */
export const planInstalments = (values: PlanValues) =>
  PAYMENT_STAGES.flatMap((s) => stageInstalments(values, s));

/** What is wrong with one stage, in a sentence — or null. Mirrors the server's checks
 *  so the user meets them before Save, not after. */
export function stageProblem(values: PlanValues, stage: PaymentStage): string | null {
  const pct = stagePct(values, stage.key);
  const split = stageSplit(values, stage.key);
  if (pct <= 0 || split === "ONE") return null;
  const days = splitList(values[`${stage.key}_instalment_days`]);
  if (days.length < MIN_INSTALMENTS) return `${stage.label}: pick at least ${MIN_INSTALMENTS} instalments.`;
  for (let i = 0; i < days.length; i++) {
    if (days[i] === "" || !/^\d+$/.test(days[i])) {
      return `${stage.label}: enter the days for instalment ${i + 1}.`;
    }
    if (Number(days[i]) > 3650) return `${stage.label}: instalment ${i + 1} is more than 3650 days away.`;
    if (i > 0 && Number(days[i]) <= Number(days[i - 1])) {
      return `${stage.label}: instalment ${i + 1} must fall after instalment ${i} (${days[i - 1]} days).`;
    }
  }
  if (split === "CUSTOM") {
    const shares = splitList(values[`${stage.key}_instalment_pcts`]);
    for (let i = 0; i < days.length; i++) {
      const s = Number(shares[i]);
      if (shares[i] === undefined || shares[i] === "" || !Number.isFinite(s) || s <= 0) {
        return `${stage.label}: enter a share above 0% for instalment ${i + 1}.`;
      }
    }
    const sum = round2(shares.slice(0, days.length).reduce((a, b) => a + Number(b), 0));
    if (sum !== 100) {
      return `${stage.label}: the instalment shares add up to ${sum}% — they must make 100% of the stage.`;
    }
  }
  if (stageInstalments(values, stage).some((p) => p.orderPct <= 0)) {
    return `${stage.label}: ${pct}% is too small to split into ${days.length} payments.`;
  }
  return null;
}

/** The first thing wrong with the whole plan, or null. */
export function planProblem(values: PlanValues): string | null {
  const total = planTotal(values);
  if (total !== 100) {
    return `The four shares add up to ${total}% — they must make exactly 100% of the order.`;
  }
  for (const s of PAYMENT_STAGES) {
    const problem = stageProblem(values, s);
    if (problem) return problem;
  }
  return null;
}

/** Resize a stage's instalment lists to `n` rows. New day counts continue the
 *  rhythm already there (30, 60 -> 90), so adding a row rarely needs typing. */
export function resizeInstalments(values: PlanValues, key: PaymentStageKey, n: number): PlanValues {
  const days = splitList(values[`${key}_instalment_days`]);
  const shares = splitList(values[`${key}_instalment_pcts`]);
  const next = days.slice(0, n);
  while (next.length < n) {
    const nums = next.map(Number).filter((d) => Number.isFinite(d));
    const last = nums.length ? nums[nums.length - 1] : 0;
    const gap = nums.length >= 2 ? Math.max(1, last - nums[nums.length - 2]) : 30;
    next.push(String(nums.length ? last + gap : 30));
  }
  const nextShares = shares.slice(0, n);
  while (nextShares.length < n) nextShares.push("");
  return {
    [`${key}_instalment_days`]: joinList(next),
    [`${key}_instalment_pcts`]: joinList(nextShares),
  };
}

/** What the form sends for the plan: numbers as numbers, lists as comma text, and
 *  nothing stale — a stage switched back to one payment drops its lists. */
export function planPayload(values: PlanValues): PlanValues {
  const out: PlanValues = {};
  for (const s of PAYMENT_STAGES) {
    const split = stagePct(values, s.key) > 0 ? stageSplit(values, s.key) : "ONE";
    out[`${s.key}_pct`] = stagePct(values, s.key);
    out[`${s.key}_split`] = split;
    out[`${s.key}_instalment_days`] = split === "ONE" ? null : String(values[`${s.key}_instalment_days`] ?? "") || null;
    out[`${s.key}_instalment_pcts`] = split === "CUSTOM" ? String(values[`${s.key}_instalment_pcts`] ?? "") || null : null;
    const first = splitList(values[`${s.key}_instalment_days`])[0];
    out[`${s.key}_days`] = split === "ONE" ? num(values[`${s.key}_days`]) : num(first);
  }
  return out;
}

export const rupees = (amount: number) =>
  `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(amount)}`;

/** "30 days after delivery", or the trigger itself on day 0. */
export const whenText = (p: Instalment) =>
  p.days > 0 ? `${p.days} day${p.days === 1 ? "" : "s"} ${p.stage.after}` : p.stage.trigger;
