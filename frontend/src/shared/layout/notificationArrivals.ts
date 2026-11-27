import { isUrgentNotification, type NotificationRow } from "@/shared/api/notifications";

/**
 * When the bell opens by itself and when the desktop shows a pop-up (2026-11-23).
 *
 * The bell watches the unread COUNT (cheap, every 20 s) and only reads the list when
 * the count goes up. What is "new" is decided by id: rows with an id above the highest
 * one already seen, still unread. The first read only sets the mark — signing in to
 * forty old notifications must not open the panel or fire forty pop-ups.
 */
export function arrivals(rows: Pick<NotificationRow, "id" | "is_read">[], seenUpTo: number | null) {
  const top = rows.reduce((m, r) => Math.max(m, r.id), seenUpTo ?? 0);
  if (seenUpTo === null) return { fresh: [] as number[], seenUpTo: top };
  const fresh = rows.filter((r) => r.id > seenUpTo && !r.is_read).map((r) => r.id);
  return { fresh, seenUpTo: top };
}

/** Open the panel the moment something arrives — over a dialog too, and whether or
 *  not the tab is in front (decided 2026-11-23). It stays open until the person closes
 *  it: nothing closes it on a timer. */
export function shouldOpenPanel(opts: { fresh: number }) {
  return opts.fresh > 0;
}

/** An urgent arrival keeps its desktop pop-up on screen until it is clicked. */
export function needsInteraction(rows: Pick<NotificationRow, "id" | "entity_type">[], fresh: number[]) {
  return rows.some((r) => fresh.includes(r.id) && isUrgentNotification(r));
}

/** The words on a desktop pop-up for several arrivals at once: one per row up to three,
 *  then one summary — a burst of ten must not bury the screen. */
export function desktopBatch<T extends Pick<NotificationRow, "id" | "title" | "body">>(rows: T[]) {
  if (rows.length <= 3) return rows.map((r) => ({ id: r.id, title: r.title, body: r.body ?? "", row: r as T | null }));
  return [{ id: rows[0].id, title: `${rows.length} new notifications`,
            body: rows.slice(0, 3).map((r) => r.title).join(" · ") + " …", row: null as T | null }];
}

const PREF = "scm.desktopAlerts";
export const desktopSupported = () => typeof window !== "undefined" && "Notification" in window;
export function desktopPref(): boolean {
  try { return localStorage.getItem(PREF) === "on"; } catch { return false; }
}
export function setDesktopPref(on: boolean) {
  try { localStorage.setItem(PREF, on ? "on" : "off"); } catch { /* private window */ }
}
/** On only when this browser said yes AND the person switched it on. */
export const desktopActive = () =>
  desktopSupported() && Notification.permission === "granted" && desktopPref();
