/**
 * What a quality inspection FOUND, by quantity (SCM_0164 / 0165 / 0166).
 *
 * Every figure the inspection screens used to show counted LINES — "Passed 0, Failed 0"
 * under a sheet that had just rejected two units, a 0 % pass rate on a delivery that
 * kept 80 % of itself, "0/1 passed" on the list. A line that keeps 8 of 10 is neither a
 * pass nor a fail: it is PARTIAL, and nothing anywhere counted it. The quantities were
 * right on every line and wrong in every total.
 *
 * This is the one place a screen turns lines into totals. It mirrors the server's
 * `inspection_quantity_summary` (warehouse/service.py) rule for rule, so the live form,
 * the saved document and the register can never tell three different stories:
 *
 *   - a line's result follows its own split — all kept PASSED, none kept FAILED,
 *     anything between PARTIAL, nothing inspected PENDING;
 *   - the pass rate is accepted ÷ inspected QUANTITY, and is null (not 0 %) while
 *     nothing has been inspected, because 0 % reads as "everything failed".
 *
 * Pure: no React, no fetching — `tests/qcSummary.test.ts` covers it.
 */

export type QcResult = "PENDING" | "PASSED" | "FAILED" | "PARTIAL";

export interface QcLineLike {
  inspected_qty?: number | string | null;
  accepted_qty?: number | string | null;
  rejected_qty?: number | string | null;
  result?: string | null;
}

export interface QcSummary {
  lines: number;
  passed: number;
  partial: number;
  failed: number;
  pending: number;
  inspected: number;
  accepted: number;
  rejected: number;
  /** accepted ÷ inspected × 100, one decimal; null while nothing is inspected. */
  passRate: number | null;
}

const n = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** The result a split implies — the same rule as the server's `_derive_result`. */
export function deriveResult(inspected: number, accepted: number): QcResult {
  if (inspected <= 0) return "PENDING";
  if (accepted >= inspected) return "PASSED";
  if (accepted <= 0) return "FAILED";
  return "PARTIAL";
}

/**
 * A line's result from its three numbers (SCM_0124) — the server's `qc_split`.
 *
 * A line starts UN-INSPECTED (0 / 0 / 0) and stays Pending until accepted + rejected
 * account for everything inspected. Only then does the split decide it. Seeded "fully
 * accepted", the first Save turned a sheet nobody had looked at into a Pass.
 */
export function qcLineResult(inspected: number, accepted: number, rejected: number): QcResult {
  if (inspected <= 0) return "PENDING";
  if (accepted + rejected < inspected - 1e-9) return "PENDING";
  return deriveResult(inspected, accepted);
}

/** A line's result: what it says, unless it still says PENDING — then its numbers. */
export function lineResult(line: QcLineLike): QcResult {
  const stored = line.result as QcResult | null | undefined;
  if (stored && stored !== "PENDING") return stored;
  return qcLineResult(n(line.inspected_qty), n(line.accepted_qty), n(line.rejected_qty));
}

export interface QcSplit { inspected: number; accepted: number; rejected: number }

/**
 * One edit to a QC line's numbers (SCM_0124), so typing never decides more than was typed.
 *
 * - Accepted typed → the rest of what was inspected is rejected: the split is complete.
 * - Rejected typed → the rest is accepted.
 * - Only Inspected typed → a line already judged keeps its accepted (capped) and the
 *   rest rejected; a line still being judged keeps its numbers and stays Pending.
 *   Counting 10 must not quietly reject 10.
 *
 * `max` caps Inspected at what arrived / was issued.
 */
export function applyQcEdit(
  prev: QcSplit,
  patch: { inspected?: number; accepted?: number; rejected?: number },
  max?: number,
): QcSplit {
  const cap = (value: number, top: number) => Math.min(Math.max(value, 0), top);
  const inspected = patch.inspected !== undefined
    ? cap(patch.inspected, max ?? Number.POSITIVE_INFINITY)
    : prev.inspected;
  if (patch.accepted !== undefined) {
    const accepted = cap(patch.accepted, inspected);
    return { inspected, accepted, rejected: inspected - accepted };
  }
  if (patch.rejected !== undefined) {
    const rejected = cap(patch.rejected, inspected);
    return { inspected, accepted: inspected - rejected, rejected };
  }
  const wasJudged = prev.inspected > 0
    && Math.abs(prev.accepted + prev.rejected - prev.inspected) < 1e-9;
  const accepted = cap(prev.accepted, inspected);
  return wasJudged
    ? { inspected, accepted, rejected: inspected - accepted }
    : { inspected, accepted, rejected: cap(prev.rejected, inspected - accepted) };
}

/** "Pass all un-inspected lines": what a line nobody has touched becomes — the whole
 *  quantity inspected and accepted. A line already being worked is left alone. */
export function passIfUntouched(prev: QcSplit, full: number): QcSplit | null {
  const untouched = prev.inspected <= 0 && prev.accepted <= 0 && prev.rejected <= 0;
  return untouched && full > 0 ? { inspected: full, accepted: full, rejected: 0 } : null;
}

export function summarizeQc(lines: readonly QcLineLike[]): QcSummary {
  const out: QcSummary = {
    lines: lines.length, passed: 0, partial: 0, failed: 0, pending: 0,
    inspected: 0, accepted: 0, rejected: 0, passRate: null,
  };
  for (const line of lines) {
    const inspected = n(line.inspected_qty);
    out.inspected += inspected;
    out.accepted += Math.min(n(line.accepted_qty), inspected);
    out.rejected += n(line.rejected_qty);
    const result = lineResult(line);
    if (result === "PASSED") out.passed += 1;
    else if (result === "FAILED") out.failed += 1;
    else if (result === "PARTIAL") out.partial += 1;
    else out.pending += 1;
  }
  out.passRate = out.inspected > 0 ? Math.round((out.accepted / out.inspected) * 1000) / 10 : null;
  return out;
}

/** The summary a list row was SERVED (`inspected_qty`, `pass_rate`, …). Older servers
 *  that do not send the quantities fall back to the line counts they do send. */
export function summaryFromRow(row: {
  total_items: number; passed_items: number; failed_items: number;
  inspected_qty?: number | string | null; accepted_qty?: number | string | null;
  rejected_qty?: number | string | null; partial_items?: number | null;
  pending_items?: number | null; pass_rate?: number | null;
}): QcSummary {
  const served = row.inspected_qty !== undefined && row.inspected_qty !== null;
  const partial = row.partial_items ?? 0;
  const pending = row.pending_items
    ?? Math.max(row.total_items - row.passed_items - row.failed_items - partial, 0);
  return {
    lines: row.total_items,
    passed: row.passed_items,
    failed: row.failed_items,
    partial,
    pending,
    inspected: served ? n(row.inspected_qty) : 0,
    accepted: served ? n(row.accepted_qty) : 0,
    rejected: served ? n(row.rejected_qty) : 0,
    passRate: served ? (row.pass_rate ?? null) : null,
  };
}

/** A quantity as a person reads it: 10, not 10.00; 2.5, not 2.500. */
export const qcQty = (value: number) =>
  value.toLocaleString("en-IN", { maximumFractionDigits: 3 });

/** The pass rate as text — "80 %", "92.5 %", or "—" when nothing is inspected. */
export const qcRate = (rate: number | null) =>
  rate === null ? "—" : `${Number.isInteger(rate) ? rate : rate.toFixed(1)}%`;

/** Which way the inspection went, as a tone a screen can colour by. */
export type QcTone = "ok" | "warn" | "bad" | "idle";

export function qcTone(summary: QcSummary): QcTone {
  if (summary.inspected <= 0) return "idle";
  if (summary.rejected <= 0) return "ok";
  if (summary.accepted <= 0) return "bad";
  return "warn";
}

/**
 * The whole inspection in one sentence — what a supervisor asks across the dock.
 *
 *   "Nothing inspected yet."
 *   "All 10 units accepted."
 *   "8 of 10 units accepted · 2 rejected, on 1 partly rejected line."
 *   "All 6 units rejected, across 2 failed lines."
 */
export function qcSentence(summary: QcSummary, uom = "units"): string {
  const { inspected, accepted, rejected, partial, failed } = summary;
  if (inspected <= 0) return "Nothing inspected yet.";
  if (rejected <= 0) return `All ${qcQty(inspected)} ${uom} accepted.`;
  const where: string[] = [];
  if (partial) where.push(`${partial} partly rejected line${partial === 1 ? "" : "s"}`);
  if (failed) where.push(`${failed} failed line${failed === 1 ? "" : "s"}`);
  const tail = where.length ? `, on ${where.join(" and ")}` : "";
  if (accepted <= 0) return `All ${qcQty(inspected)} ${uom} rejected${tail}.`;
  return `${qcQty(accepted)} of ${qcQty(inspected)} ${uom} accepted · ${qcQty(rejected)} rejected${tail}.`;
}
