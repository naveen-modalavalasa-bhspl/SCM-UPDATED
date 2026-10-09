/** Named report views, stored in the browser.
 *
 *  A view is just the page's query string. The ledger page already keeps every
 *  filter, date, sort and column choice in the URL — so "save this view" is
 *  "remember this URL", and restoring one is a navigation rather than a pile of
 *  state to rehydrate. Nothing here knows what a filter is.
 *
 *  localStorage, not the database: a view is one person's shortcut on one machine,
 *  and persisting it server-side would need a table we are not adding. The cost is
 *  that views do not follow you to another browser — for sharing, the URL itself is
 *  already the shareable artefact, which is the whole reason filters live there.
 */

const KEY = "scm.reports.saved-views";
const MAX_PER_LEDGER = 20;

export interface SavedView {
  name: string;
  /** The raw query string, without the leading "?". */
  query: string;
}

type Store = Record<string, SavedView[]>;

function read(): Store {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    // A hand-edited or half-written entry must not take the reports screen down
    // with it — an unreadable store is an empty store.
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function write(store: Store): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Private browsing, or the quota is full. Losing a shortcut is not worth an error.
  }
}

export function listViews(ledger: string): SavedView[] {
  const views = read()[ledger];
  return Array.isArray(views) ? views : [];
}

/** Saves under `name`, replacing any view of the same name — re-saving is how you
 *  update one, so a second "Month end" would otherwise be indistinguishable. */
export function saveView(ledger: string, name: string, query: string): SavedView[] {
  const trimmed = name.trim();
  if (!trimmed) return listViews(ledger);

  const store = read();
  const rest = listViews(ledger).filter((v) => v.name !== trimmed);
  const next = [{ name: trimmed, query }, ...rest].slice(0, MAX_PER_LEDGER);
  store[ledger] = next;
  write(store);
  return next;
}

export function deleteView(ledger: string, name: string): SavedView[] {
  const store = read();
  const next = listViews(ledger).filter((v) => v.name !== name);
  store[ledger] = next;
  write(store);
  return next;
}
