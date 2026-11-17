import type { SyncResult } from "./types";

/**
 * What one "Sync now" run ended as, in one sentence and one colour (SCM_0197).
 *
 * The page used to print every message — "Sync started", a refusal, a crash — in the
 * same tinted box, and a follow-up hiccup (the organisation feed being unreachable)
 * read exactly like the HCM sync failing. The rule is now:
 *
 * - SUCCESS (green): every entity of THIS run synced, and any follow-up landed.
 * - WARNING (amber): every entity synced, but follow-up work after it failed. The
 *   mirror is fresh; something downstream needs a look.
 * - ERROR (red): at least one entity of this run actually failed.
 *
 * Only rows that STARTED at or after the press count: the status feed carries the
 * last twenty rows, and a failure from yesterday is not today's result.
 */
export type SyncTone = "success" | "warning" | "error" | "info";

export interface SyncOutcome {
  tone: SyncTone;
  title: string;
  detail?: string;
}

const HOOK_LABELS: Record<string, string> = {
  sync_after_hcm: "Organisation directory",
  rebuild_stocking_points: "Stocking points",
};

const labelOf = (row: SyncResult, labels: Record<string, string>) =>
  labels[row.entity] ?? HOOK_LABELS[row.entity] ?? row.entity.replace(/_/g, " ");

function stamp(value?: string | null): number {
  if (!value) return NaN;
  // The server writes naive UTC; read it as UTC whatever the browser's zone.
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`;
  return Date.parse(iso);
}

export function syncOutcome(
  rows: SyncResult[],
  startedAt: number,
  labels: Record<string, string> = {},
): SyncOutcome | null {
  // A little slack for a server clock a second or two behind the browser.
  const thisRun = rows.filter((row) => stamp(row.started_at) >= startedAt - 5_000);
  if (thisRun.length === 0) return null;
  if (thisRun.some((row) => row.status === "RUNNING")) return null;

  const isHook = (row: SyncResult) => (row.source ?? "").toUpperCase() === "HOOK";
  const entities = thisRun.filter((row) => !isHook(row));
  const failed = entities.filter((row) => row.status === "FAILED");
  const hookFailed = thisRun.filter((row) => isHook(row) && row.status === "FAILED");

  if (failed.length > 0) {
    const names = failed.map((row) => labelOf(row, labels));
    const first = failed.find((row) => row.error_message)?.error_message;
    return {
      tone: "error",
      title: `Sync failed for ${names.join(", ")}`,
      detail: first ?? "HCM did not answer for these. Everything else was synced.",
    };
  }

  const records = entities.reduce((sum, row) => sum + (row.records_upserted ?? 0), 0);
  const done = `${records.toLocaleString("en-IN")} record${records === 1 ? "" : "s"} across ${entities.length} list${entities.length === 1 ? "" : "s"}`;

  if (hookFailed.length > 0) {
    return {
      tone: "warning",
      title: "HCM synced — a follow-up step needs attention",
      detail: `${done} are up to date. ${hookFailed
        .map((row) => `${labelOf(row, labels)}: ${row.error_message ?? "did not finish"}`)
        .join(" · ")}`,
    };
  }
  return { tone: "success", title: "Sync complete", detail: `${done} are up to date.` };
}
