import { useCallback, useMemo, useSyncExternalStore } from "react";
import { parseIndentTimestamp } from "./dateTime";
import type { IndentNotification } from "./types";

/**
 * Read/unread state for indent notifications.
 *
 * `/api/indents/notifications` derives its rows from the indents themselves — the id
 * is `indent:<id>:<status>` and nothing is stored server-side, so there is no row to
 * flag as read. This keeps that flag next to the person it belongs to, in
 * localStorage, per employee.
 *
 * Two pieces, because "mark all read" cannot enumerate rows it has never fetched:
 *  - `allReadAt` — a watermark. The list is ordered newest-first on `updated_at`, so
 *    everything at or below the watermark is read, and a status change (which bumps
 *    `updated_at` and mints a new id) surfaces as unread again.
 *  - `readIds` — the individual rows opened since then, capped so the entry cannot
 *    grow without bound.
 */

const STORAGE_PREFIX = "scm-erp:indents:notifications:read:v1:";
const MAX_TRACKED_IDS = 300;

export interface NotificationReadState {
  allReadAt: string | null;
  readIds: string[];
}

const EMPTY: NotificationReadState = { allReadAt: null, readIds: [] };

// Snapshots have to be reference-stable or useSyncExternalStore loops forever.
const snapshots = new Map<string, NotificationReadState>();
const listeners = new Set<() => void>();

function storageKey(employeeId: number | null) {
  return `${STORAGE_PREFIX}${employeeId ?? "anonymous"}`;
}

function parse(raw: string | null): NotificationReadState {
  if (!raw) return EMPTY;
  try {
    const parsed = JSON.parse(raw) as Partial<NotificationReadState> | null;
    const allReadAt = typeof parsed?.allReadAt === "string" ? parsed.allReadAt : null;
    const readIds = Array.isArray(parsed?.readIds)
      ? parsed.readIds.filter((id): id is string => typeof id === "string").slice(-MAX_TRACKED_IDS)
      : [];
    if (!allReadAt && readIds.length === 0) return EMPTY;
    return { allReadAt, readIds };
  } catch {
    return EMPTY;
  }
}

function snapshot(key: string): NotificationReadState {
  const cached = snapshots.get(key);
  if (cached) return cached;
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(key);
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }
  const state = parse(stored);
  snapshots.set(key, state);
  return state;
}

function emit() {
  listeners.forEach((listener) => listener());
}

function persist(key: string, state: NotificationReadState) {
  snapshots.set(key, state);
  try {
    if (state.allReadAt === null && state.readIds.length === 0) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, JSON.stringify(state));
    }
  } catch {
    // Persistence is a nicety; the in-memory snapshot still drives this tab.
  }
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && !event.key.startsWith(STORAGE_PREFIX)) return;
    // Another tab moved the flag; drop the cache so the next snapshot re-reads it.
    snapshots.clear();
    emit();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function getServerSnapshot() {
  return EMPTY;
}

export interface NotificationReads {
  /** True once anything has been read — until then unread and everything are the same list. */
  hasReadState: boolean;
  isRead: (note: IndentNotification) => boolean;
  markRead: (id: string) => void;
  markAllRead: () => void;
}

export function useIndentNotificationReads(employeeId: number | null): NotificationReads {
  const key = storageKey(employeeId);
  const state = useSyncExternalStore(subscribe, () => snapshot(key), getServerSnapshot);

  const readIds = useMemo(() => new Set(state.readIds), [state.readIds]);
  const allReadAt = useMemo(
    () => (state.allReadAt ? parseIndentTimestamp(state.allReadAt)?.getTime() ?? null : null),
    [state.allReadAt],
  );

  const isRead = useCallback((note: IndentNotification) => {
    if (readIds.has(note.id)) return true;
    if (allReadAt === null) return false;
    const raised = parseIndentTimestamp(note.created_at)?.getTime();
    return raised !== undefined && raised <= allReadAt;
  }, [allReadAt, readIds]);

  const markRead = useCallback((id: string) => {
    const current = snapshot(key);
    if (current.readIds.includes(id)) return;
    persist(key, {
      allReadAt: current.allReadAt,
      readIds: [...current.readIds, id].slice(-MAX_TRACKED_IDS),
    });
  }, [key]);

  // The watermark subsumes every id below it, so the list starts clean again.
  const markAllRead = useCallback(() => {
    persist(key, { allReadAt: new Date().toISOString(), readIds: [] });
  }, [key]);

  return useMemo(() => ({
    hasReadState: state !== EMPTY,
    isRead,
    markRead,
    markAllRead,
  }), [isRead, markAllRead, markRead, state]);
}
