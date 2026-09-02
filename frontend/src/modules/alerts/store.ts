import { DEFAULT_CATALOG } from "./catalog";
import type { ActiveAlert, AlertDef, AlertOptions, AlertParams } from "./types";

/**
 * The alert queue, as a plain external store rather than React state.
 *
 * A confirm is asked from event handlers, axios interceptors and mutation
 * callbacks — places that are not always inside a component. Keeping the queue
 * outside React means `alerts.confirm(...)` is callable from any of them and
 * still renders, while `<AlertHost>` subscribes with `useSyncExternalStore`.
 *
 * Only the top of the queue is rendered. Two dialogs stacked on top of each
 * other is never the right answer to "are you sure?".
 */

type Listener = () => void;

let queue: ActiveAlert[] = [];
let catalog: Record<string, AlertDef> = DEFAULT_CATALOG;
let nextId = 1;

const listeners = new Set<Listener>();
/** id -> resolve, so dismissing anywhere settles the promise the caller awaits. */
const pending = new Map<number, (confirmed: boolean) => void>();
/** id -> the promise handed to the caller, so a merged duplicate can share it. */
const promises = new Map<number, Promise<boolean>>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  // New array identity on every change: useSyncExternalStore compares snapshots
  // by reference, so mutating in place would render nothing.
  queue = [...queue];
  listeners.forEach((listener) => listener());
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): ActiveAlert[] {
  return queue;
}

/** Overlay the server's copy on top of the bundled defaults. */
export function hydrateCatalog(items: Record<string, AlertDef>) {
  catalog = { ...DEFAULT_CATALOG, ...items };
}

export function getCatalog(): Record<string, AlertDef> {
  return catalog;
}

/** Fills `{placeholders}`. An unsupplied key is left visible rather than blanked,
 *  so a missing param shows up in review instead of reading as finished copy. */
export function interpolate(template: string, params?: AlertParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = params[key];
    return value === undefined || value === null ? whole : String(value);
  });
}

/**
 * Put a dialog on screen.
 *
 * Resolves `true` when the primary button is pressed, `false` when it is
 * cancelled, dismissed or closes itself. A plain alert therefore resolves
 * `false` on auto-close, which is what "the user did not act on it" means.
 */
export function pushAlert(
  code: string | null,
  options: AlertOptions = {},
): Promise<boolean> {
  const def = code ? catalog[code] : undefined;
  if (code && !def && import.meta.env.DEV) {
    // Not thrown: a missing catalog entry must never take a screen down, but it
    // should be impossible to miss while developing.
    console.warn(`[alerts] no catalog entry for "${code}" — using the overrides only`);
  }
  // A code with no entry and no title override used to render an empty white box: the
  // action had in fact succeeded, and the dialog said nothing at all. Falling back to
  // the variant's own word is not good copy, but it is readable, and a blank dialog is
  // worse than a plain one — the user cannot tell it from a broken screen.
  const FALLBACK_TITLE: Record<string, string> = {
    success: "Done", info: "Note", warning: "Careful", error: "That did not work",
    danger: "Are you sure?",
  };

  const mode = options.mode ?? def?.mode ?? "alert";
  const variant = options.variant ?? def?.variant ?? "info";
  const autoCloseMs = mode === "confirm"
    ? null
    : options.autoCloseMs !== undefined
      ? options.autoCloseMs
      : def?.auto_close_ms ?? null;

  const id = nextId++;
  const item: ActiveAlert = {
    id,
    variant,
    mode,
    title: interpolate(
      options.title ?? def?.title ?? FALLBACK_TITLE[variant] ?? "Note", options.params),
    message: interpolate(options.message ?? def?.message ?? "", options.params),
    confirmLabel: options.confirmLabel !== undefined
      ? options.confirmLabel
      : def?.confirm_label ?? (mode === "confirm" ? "Confirm" : null),
    cancelLabel: options.cancelLabel !== undefined
      ? options.cancelLabel
      : def?.cancel_label ?? (mode === "confirm" ? "Cancel" : null),
    autoCloseMs,
  };

  // One dropped connection fails every query on the screen at once, and each of
  // those used to queue its own "Can't reach the server" — dismissed one, read the
  // same sentence again, four times over. An announcement already queued in the
  // same words is the same announcement, so it is joined rather than repeated. A
  // CONFIRM is never merged: two questions that read alike can still be about two
  // different documents, and each caller is waiting on its own answer.
  if (mode === "alert") {
    const twin = queue.find((existing) =>
      existing.mode === "alert"
      && existing.variant === item.variant
      && existing.title === item.title
      && existing.message === item.message);
    if (twin) {
      const running = timers.get(twin.id);
      if (running) clearTimeout(running);
      if (twin.autoCloseMs !== null) {
        // Restart the clock: the newest raise is when the user last needed to see it.
        timers.set(twin.id, setTimeout(() => resolveAlert(twin.id, false), twin.autoCloseMs));
      }
      return promises.get(twin.id) ?? Promise.resolve(false);
    }
  }

  queue = [...queue, item];
  emit();

  if (autoCloseMs !== null) {
    timers.set(id, setTimeout(() => resolveAlert(id, false), autoCloseMs));
  }

  const promise = new Promise<boolean>((resolve) => pending.set(id, resolve));
  promises.set(id, promise);
  return promise;
}

/** Close one dialog and settle its promise. Safe to call twice. */
export function resolveAlert(id: number, confirmed: boolean) {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  const resolve = pending.get(id);
  pending.delete(id);
  promises.delete(id);
  queue = queue.filter((item) => item.id !== id);
  emit();
  resolve?.(confirmed);
}

/** Close everything — used on sign-out so a stale confirm cannot outlive a session. */
export function clearAlerts() {
  [...queue].forEach((item) => resolveAlert(item.id, false));
}

/** Test seam: drops queue, timers and catalog overrides. */
export function __resetAlerts() {
  timers.forEach(clearTimeout);
  timers.clear();
  pending.clear();
  promises.clear();
  queue = [];
  catalog = DEFAULT_CATALOG;
  nextId = 1;
  emit();
}
