import type { IssueTray } from "../types";

/**
 * Trays on a pick (MoM 2026-11-18, point 14) — the screen half of `issue_trays.py`,
 * pure so it is tested. The server is still the one that refuses; this only says the
 * same thing before the press.
 */
const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export const inTrays = (trays?: IssueTray[] | null) =>
  r3((trays ?? []).reduce((sum, t) => sum + n(t.quantity), 0));

/** What of the pick is not in a tray yet (negative = the trays hold too much). */
export const leftOver = (issued: number, trays?: IssueTray[] | null) => r3(n(issued) - inTrays(trays));

/** The next tray's number: one past the highest number used, kept in the same shape
 *  ("T-04" → "T-05"), else "T-01". The storekeeper types or scans over it. */
export function nextTrayNo(trays?: IssueTray[] | null): string {
  let best: { prefix: string; num: number; width: number } | null = null;
  for (const t of trays ?? []) {
    const m = /^(.*?)(\d+)$/.exec(t.tray_no ?? "");
    if (!m) continue;
    const num = Number(m[2]);
    if (!best || num > best.num) best = { prefix: m[1], num, width: m[2].length };
  }
  if (!best) return "T-01";
  return `${best.prefix}${String(best.num + 1).padStart(best.width, "0")}`;
}

/** Codes of the pick that no OTHER tray holds — what tray `index` may take. */
export function codesFree(all: string[], trays: IssueTray[], index: number): string[] {
  const taken = new Set(trays.flatMap((t, i) => (i === index ? [] : t.codes ?? [])));
  return all.filter((code) => !taken.has(code));
}

export interface TrayProblem { index: number | null; message: string }

/** Everything the save would refuse, in words, plus "not all in trays yet" (which the
 *  save allows and submit does not). */
export function trayProblems(issued: number, trays: IssueTray[]): TrayProblem[] {
  const out: TrayProblem[] = [];
  const seen = new Map<string, number>();
  const codeAt = new Map<string, string>();
  trays.forEach((t, index) => {
    const no = (t.tray_no ?? "").trim();
    if (!no) out.push({ index, message: "Type or scan the tray number." });
    else if (seen.has(no.toUpperCase())) out.push({ index, message: `Tray ${no} is listed twice.` });
    else seen.set(no.toUpperCase(), index);
    if (n(t.quantity) <= 0) out.push({ index, message: "Say how much goes into this tray." });
    if ((t.codes?.length ?? 0) > n(t.quantity)) {
      out.push({ index, message: `${t.codes.length} codes in a tray of ${n(t.quantity)}.` });
    }
    for (const code of t.codes ?? []) {
      const other = codeAt.get(code);
      if (other !== undefined) out.push({ index, message: `${code} is already in tray ${other}.` });
      else codeAt.set(code, no || `#${index + 1}`);
    }
  });
  const left = leftOver(issued, trays);
  if (trays.length && left < 0) out.push({ index: null, message: `The trays hold ${-left} more than the pick.` });
  return out;
}
