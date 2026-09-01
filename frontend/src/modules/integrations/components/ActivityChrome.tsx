import { ArrowDownLeft, ArrowUpRight, Plug, Puzzle, Radio } from "lucide-react";
import { StatusPill } from "@/shared/components";
import type { ActivityRow } from "../types";

/**
 * The two marks an activity row is read by — the result pill and the direction arrow.
 *
 * They live here rather than in the list because the list and one event's own page
 * both draw them, and a row that is green on one screen and grey on the other reads
 * as two different events. One definition, imported twice.
 */

/** The three results, in the app's own status colours.
 *
 *  `StatusPill` maps a document status to a tone and takes a `label` that overrides
 *  the words without touching the status. An integration outcome is not a document
 *  status, so it is translated to the nearest one here — module-local, one line, and
 *  the shared pill is still the only thing that decides what green looks like. */
export const OUTCOME_STATUS: Record<string, string> = {
  OK: "APPROVED",
  FAILED: "REJECTED",
  DUPLICATE: "DRAFT",
};

/** True when the request never got through — it was turned away at the door.
 *
 *  NOT the same as `outcome === "FAILED"`. A push that arrived and was stored, but
 *  whose lines could not all be posted, is FAILED too — and it DID get through. Only
 *  a refusal means nothing moved, and only a refusal may be described that way.
 *
 *  A refusal is either a row from the error log (`err:`) or a request answered with
 *  a 4xx/5xx. It lives here because the list and the event page both read it, and a
 *  request called "turned away" on one screen and "read out of us" on the other is
 *  the log telling two stories about one event. */
export const wasRefused = (row: ActivityRow) =>
  row.id.startsWith("err:") || (row.status_code ?? 0) >= 400;

export const CHANNEL_ICON = {
  WEBHOOK: Radio,
  ADAPTER: Puzzle,
  APPLICATION: Plug,
} as const;

export function OutcomePill({ row }: { row: ActivityRow }) {
  return (
    <StatusPill status={OUTCOME_STATUS[row.outcome] ?? "DRAFT"}
                label={row.outcome_word} />
  );
}

/** The arrow says which way the data moved. Two icons carry the one fact the whole
 *  row hangs off, and the text beside them repeats it for a screen reader. */
export function Direction({ row }: { row: ActivityRow }) {
  const Icon = row.direction === "IN" ? ArrowDownLeft : ArrowUpRight;
  const ChannelIcon = CHANNEL_ICON[row.channel] ?? Plug;
  return (
    <span className="flex items-center gap-1.5" title={row.channel_note}>
      <Icon className={`h-4 w-4 shrink-0 ${
        row.direction === "IN" ? "text-info" : "text-brand"}`} aria-hidden="true" />
      <ChannelIcon className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
      <span className="sr-only">{row.channel_note}. </span>
    </span>
  );
}
