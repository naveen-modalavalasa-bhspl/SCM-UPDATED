import { useCallback, useMemo, useSyncExternalStore } from "react";

/**
 * The approver's working draft for one consolidation cycle.
 *
 * A consolidation is a GROUP BY over the pending queue and is stored nowhere, so
 * there is no server-side draft either: nothing is written until the approver hits
 * Approve all and the per-indent quantities go out. But the decisions now outlive a
 * single screen — the totals are set on an item's own page and spent on the
 * consolidation page's Approve all — so they cannot live in either page's `useState`,
 * which unmounts the moment you navigate between the two.
 *
 * Kept per cycle, in sessionStorage: a draft belongs to this sitting at this desk.
 * A new tab starts clean, and closing the tab throws the draft away rather than
 * leaving stale numbers to be approved next week against a queue that has moved on.
 */

const STORAGE_PREFIX = "scm-erp:approvals:consolidation:draft:v1:";

export interface ItemDecision {
  /** What the approver typed as the item's batch total. "" means "the full ceiling". */
  approved: string;
  /** Indent numbers getting nothing — their share goes to the rest. Exact, uppercase. */
  excluded: string[];
}

/** Keyed by `item_id`, one entry per item the approver has actually touched. */
export type CycleDecisions = Record<string, ItemDecision>;

export const EMPTY_DECISION: ItemDecision = { approved: "", excluded: [] };

const EMPTY: CycleDecisions = {};

// Snapshots have to be reference-stable or useSyncExternalStore loops forever.
const snapshots = new Map<string, CycleDecisions>();
const listeners = new Set<() => void>();

const storageKey = (cycle: string) => `${STORAGE_PREFIX}${cycle}`;

/** An untouched item is absent, not stored empty, so a decision map only ever holds
 *  what the approver actually changed — and `{}` means "nothing decided yet". */
const isEmpty = (decision: ItemDecision) =>
  decision.approved.trim() === "" && decision.excluded.length === 0;

function parse(raw: string | null): CycleDecisions {
  if (!raw) return EMPTY;
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<ItemDecision>> | null;
    if (!parsed || typeof parsed !== "object") return EMPTY;
    const state: CycleDecisions = {};
    for (const [itemId, value] of Object.entries(parsed)) {
      const decision: ItemDecision = {
        approved: typeof value?.approved === "string" ? value.approved : "",
        excluded: Array.isArray(value?.excluded)
          ? value.excluded.filter((no): no is string => typeof no === "string")
          : [],
      };
      if (!isEmpty(decision)) state[itemId] = decision;
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

  const patch = useCallback((itemId: number, next: Partial<ItemDecision>) => {
    const current = snapshot(key);
    const merged: ItemDecision = { ...EMPTY_DECISION, ...current[String(itemId)], ...next };
    const updated = { ...current };
    if (isEmpty(merged)) delete updated[String(itemId)];
    else updated[String(itemId)] = merged;
    persist(key, updated);
  }, [key]);

  const setApproved = useCallback(
    (itemId: number, approved: string) => patch(itemId, { approved }), [patch],
  );

  /** Exclude/restore one indent on one item. A toggle rather than a set-this-list
   *  call, because that is the only thing either screen does to the list. */
  const toggleExcluded = useCallback((itemId: number, indentNo: string) => {
    const no = indentNo.trim().toUpperCase();
    if (!no) return;
    const current = snapshot(key)[String(itemId)] ?? EMPTY_DECISION;
    patch(itemId, {
      excluded: current.excluded.includes(no)
        ? current.excluded.filter((value) => value !== no)
        : [...current.excluded, no],
    });
  }, [key, patch]);

  const includeAll = useCallback((itemId: number) => patch(itemId, { excluded: [] }), [patch]);

  /** Drop the whole cycle — what an approval does, once the indents have gone on. */
  const clearCycle = useCallback(() => persist(key, EMPTY), [key]);

  return useMemo(
    () => ({ decisions, setApproved, toggleExcluded, includeAll, clearCycle }),
    [clearCycle, decisions, includeAll, setApproved, toggleExcluded],
  );
}
