import { useCallback, useMemo, useSyncExternalStore } from "react";

/**
 * The approver's working draft for one consolidation cycle.
 *
 * A consolidation is a GROUP BY over the pending queue and is stored nowhere, so
 * there is no server-side draft either: nothing is written until the approver hits
 * Approve all and the per-indent quantities go out. But the decisions outlive a
 * single screen — they are set on an item's own page and spent on the consolidation
 * page's Approve all — so they cannot live in either page's `useState`, which
 * unmounts the moment you navigate between the two.
 *
 * Kept per cycle, in sessionStorage: a draft belongs to this sitting at this desk.
 * A new tab starts clean, and closing the tab throws the draft away rather than
 * leaving stale numbers to be approved next week against a queue that has moved on.
 *
 * ONE ENTRY PER INDENT LINE (2026-11-06). The draft used to hold one batch total and one
 * list of excluded indent numbers per ITEM, and a proportional split turned those into
 * the quantity each indent got. The approver now decides at the indent: each line
 * carries its own quantity and its own excluded flag, so the draft is exactly what will
 * be sent and nothing is derived from a total. The key is the line id, which is unique
 * across every item and every indent of the cycle.
 */

// v2: the shape changed. A v1 draft (a batch total per item) means nothing here, and
// reading it as if it did would approve numbers nobody typed on a line.
const STORAGE_PREFIX = "scm-erp:approvals:consolidation:draft:v2:";

export interface LineDecision {
  /** What the approver typed for this indent's line. "" means "the full ceiling". */
  approved: string;
  /** Dropped from this item for this indent: it gets nothing, and the flag is sent to the
   *  server as such (an excluded line and a line approved at zero are not the same). */
  excluded: boolean;
}

/** Keyed by `line_id`, one entry per line the approver has actually touched. */
export type CycleDecisions = Record<string, LineDecision>;

export const EMPTY_DECISION: LineDecision = { approved: "", excluded: false };

const EMPTY: CycleDecisions = {};

// Snapshots have to be reference-stable or useSyncExternalStore loops forever.
const snapshots = new Map<string, CycleDecisions>();
const listeners = new Set<() => void>();

const storageKey = (cycle: string) => `${STORAGE_PREFIX}${cycle}`;

/** An untouched line is absent, not stored empty, so a decision map only ever holds
 *  what the approver actually changed — and `{}` means "nothing decided yet". */
const isEmpty = (decision: LineDecision) =>
  decision.approved.trim() === "" && !decision.excluded;

function parse(raw: string | null): CycleDecisions {
  if (!raw) return EMPTY;
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<LineDecision>> | null;
    if (!parsed || typeof parsed !== "object") return EMPTY;
    const state: CycleDecisions = {};
    for (const [lineId, value] of Object.entries(parsed)) {
      const decision: LineDecision = {
        approved: typeof value?.approved === "string" ? value.approved : "",
        excluded: value?.excluded === true,
      };
      if (!isEmpty(decision)) state[lineId] = decision;
    }
    return Object.keys(state).length === 0 ? EMPTY : state;
  } catch {
    return EMPTY;
  }
}

function snapshot(key: string): CycleDecisions {
  const cached = snapshots.get(key);
  if (cached) return cached;
  let stored: string | null = null;
  try {
    stored = window.sessionStorage.getItem(key);
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }
  const state = parse(stored);
  snapshots.set(key, state);
  return state;
}

function persist(key: string, state: CycleDecisions) {
  snapshots.set(key, state);
  try {
    if (Object.keys(state).length === 0) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(state));
  } catch {
    // Persistence is a nicety; the in-memory snapshot still drives this tab.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const getServerSnapshot = () => EMPTY;

/** Read/write one cycle's draft. Pure state — nothing here talks to the API. */
export function useConsolidationDecisions(cycle: string) {
  const key = storageKey(cycle);
  const decisions = useSyncExternalStore(subscribe, () => snapshot(key), getServerSnapshot);

  /** Apply several lines' changes in ONE write, so a whole-indent action is one render
   *  and one storage write rather than one per line. */
  const patchMany = useCallback(
    (entries: Array<[number, Partial<LineDecision>]>) => {
      if (entries.length === 0) return;
      const current = snapshot(key);
      const updated = { ...current };
      for (const [lineId, next] of entries) {
        const merged: LineDecision = { ...EMPTY_DECISION, ...current[String(lineId)], ...next };
        if (isEmpty(merged)) delete updated[String(lineId)];
        else updated[String(lineId)] = merged;
      }
      persist(key, updated);
    },
    [key],
  );

  const setApproved = useCallback(
    (lineId: number, approved: string) => patchMany([[lineId, { approved }]]),
    [patchMany],
  );

  /** Set many lines' quantities at once — what a percentage reduction does. */
  const setApprovedMany = useCallback(
    (entries: Array<{ lineId: number; approved: string }>) =>
      patchMany(entries.map(({ lineId, approved }) => [lineId, { approved }])),
    [patchMany],
  );

  /** Exclude or restore any number of lines: one line (a row's own button) or every
   *  line of an indent in the cycle ("remove from all items"). */
  const setExcluded = useCallback(
    (lineIds: number[], excluded: boolean) =>
      patchMany(lineIds.map((lineId) => [lineId, { excluded }])),
    [patchMany],
  );

  /** Drop the whole cycle — what an approval does, once the indents have gone on. */
  const clearCycle = useCallback(() => persist(key, EMPTY), [key]);

  return useMemo(
    () => ({ decisions, setApproved, setApprovedMany, setExcluded, clearCycle }),
    [clearCycle, decisions, setApproved, setApprovedMany, setExcluded],
  );
}
