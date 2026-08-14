import { expect } from "@playwright/test";

/**
 * What each screen *should* be showing, derived independently of the screen.
 *
 * This is the difference between a filter test that means something and one that
 * does not. "Click Urgent, see the list change" passes when the list changes to
 * the wrong thing. So instead: click Urgent, read the query the app put in the
 * address bar, translate that query into the API call the screen is contracted to
 * make, ask the API as the same account, and compare row for row.
 *
 * Three facts get checked at once, and each can fail on its own:
 *
 * - the control wrote the right thing into the URL (state),
 * - the screen rendered exactly what that state returns (fetch + render),
 * - the rows on screen actually satisfy the filter (the predicate, checked locally).
 *
 * The translations below are the screens' real contracts, taken from
 * `ListPage`/`DashboardPage`/`ReportsPage`/`NotificationsPage`. They are written
 * out by hand rather than imported so that a change to the app's query building
 * shows up here as a failure instead of being silently agreed with.
 */

/** The page size every Indent list screen defaults to. */
export const PAGE_SIZE = 20;

function build(pairs: [string, string][]) {
  const params = new URLSearchParams();
  for (const [key, value] of pairs) {
    if (value !== "") params.append(key, value);
  }
  return params.toString();
}

function copyAll(from: URLSearchParams, key: string): [string, string][] {
  return from.getAll(key).map((value) => [key, value] as [string, string]);
}

function copyOne(from: URLSearchParams, key: string, as = key): [string, string][] {
  const value = from.get(key);
  return value ? [[as, value]] : [];
}

/**
 * `/indents` — the All requests grid.
 *
 * The screen sends the raised-date range only when both ends are present, always
 * sends its sort, and always sends page and size. `raised_preset` and
 * `required_by_preset` are UI memory and never reach the API.
 */
export function allRequestsQuery(urlQuery: string, { page }: { page?: number } = {}): string {
  const from = new URLSearchParams(urlQuery);
  const raisedFrom = from.get("created_date_from") ?? "";
  const raisedTo = from.get("created_date_to") ?? "";
  const size = from.get("size") ?? String(PAGE_SIZE);
  const currentPage = page ?? Number(from.get("page") ?? 1);
  return build([
    ...copyOne(from, "search"),
    ...(raisedFrom && raisedTo
      ? ([["created_date_from", raisedFrom], ["created_date_to", raisedTo]] as [string, string][])
      : []),
    ...copyOne(from, "required_by_from"),
    ...copyOne(from, "required_by_to"),
    ...copyAll(from, "status"),
    ...copyAll(from, "priority"),
    ["sort_by", "created_at"],
    ["sort_dir", "desc"],
    ["page", String(currentPage)],
    ["size", size],
  ]);
}

/** `/indents/stats` — the KPI tiles and the donut. Same filters, no paging. */
export function overviewStatsQuery(urlQuery: string): string {
  const from = new URLSearchParams(urlQuery);
  const raisedFrom = from.get("created_date_from") ?? "";
  const raisedTo = from.get("created_date_to") ?? "";
  return build([
    ...copyOne(from, "search"),
    ...(raisedFrom && raisedTo
      ? ([["created_date_from", raisedFrom], ["created_date_to", raisedTo]] as [string, string][])
      : []),
    ...copyOne(from, "required_by_from"),
    ...copyOne(from, "required_by_to"),
    ...copyAll(from, "status"),
    ...copyAll(from, "priority"),
  ]);
}

/** The Recent Indents card asks for six and renders five. */
export function overviewRecentQuery(urlQuery: string): string {
  const stats = overviewStatsQuery(urlQuery);
  return stats ? `${stats}&size=6` : "size=6";
}

export const RECENT_ROWS_SHOWN = 5;

/**
 * `/indents/activity` — the Activity ledger.
 *
 * Its Event dropdown writes `transaction_type`, not `status`, and it carries a
 * single value: the screen sends `selectedStatuses[0]`.
 */
export function activityQuery(urlQuery: string, { page }: { page?: number } = {}): string {
  const from = new URLSearchParams(urlQuery);
  const size = from.get("size") ?? String(PAGE_SIZE);
  const currentPage = page ?? Number(from.get("page") ?? 1);
  return build([
    ...copyOne(from, "search"),
    ...copyOne(from, "date_from"),
    ...copyOne(from, "date_to"),
    ...(from.getAll("transaction_type").slice(0, 1).map((value) =>
      ["transaction_type", value] as [string, string])),
    ["page", String(currentPage)],
    ["size", size],
  ]);
}

/** `/indents/notifications` — Alert & Notification. Fixed page size, no size param in the URL. */
export function notificationsQuery(urlQuery: string, { page }: { page?: number } = {}): string {
  const from = new URLSearchParams(urlQuery);
  const currentPage = page ?? Number(from.get("page") ?? 1);
  return build([
    ...copyOne(from, "search"),
    ...copyOne(from, "date_from"),
    ...copyOne(from, "date_to"),
    ...copyAll(from, "status"),
    ["page", String(currentPage)],
    ["size", String(PAGE_SIZE)],
  ]);
}

/** `/warehouse/acknowledgements/mine` — Acknowledgements keeps its filters in component state. */
export function acknowledgementsQuery(
  { search, status, onlyActionable }: { search?: string; status?: string; onlyActionable?: boolean },
): string {
  return build([
    ...(search?.trim() ? ([["search", search.trim()]] as [string, string][]) : []),
    ...(status ? ([["status", status]] as [string, string][]) : []),
    ...(onlyActionable ? ([["only_actionable", "true"]] as [string, string][]) : []),
  ]);
}

/* -------------------------------------------------------------- comparisons */

/**
 * Waits until what is on screen equals what the API says it should be.
 *
 * Polling rather than a single read, because React commits the new rows a beat
 * after the fetch resolves. Polling on the *correct* value is not the same as
 * sleeping and hoping: the assertion still fails, with both lists in the message,
 * if the screen settles on anything else.
 */
export async function expectRowsToMatch(
  read: () => Promise<string[]>,
  expected: string[],
  message: string,
  timeout = 15_000,
) {
  await expect.poll(read, { message, timeout }).toEqual(expected);
}

export async function expectValueToMatch<T>(
  read: () => Promise<T>,
  expected: T,
  message: string,
  timeout = 15_000,
) {
  await expect.poll(read, { message, timeout }).toEqual(expected);
}

/** Compares two numbers written as display text ("1,234", "42 ", "-"). */
export function sameNumberText(actual: string, expected: number | string) {
  const clean = (value: string) => value.replace(/[,\s]/g, "");
  const left = clean(actual);
  const right = clean(String(expected));
  if (left === right) return true;
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber === rightNumber;
}

/**
 * The donut's total, computed the way the chart computes it.
 *
 * Not `stats.total`: the chart only draws eight primary statuses, so an indent
 * sitting in SUBMITTED or ORDERED is counted by the KPI tile and not by the
 * donut. A test that compared the donut to `stats.total` would report a defect
 * every time the database held one.
 */
export const PRIMARY_STATUSES = [
  "PENDING_APPROVAL",
  "RETURNED_FOR_CORRECTION",
  "AWAITING_ALLOCATION",
  "ALLOCATED",
  "PARTIALLY_FULFILLED",
  "CLOSED",
  "REJECTED",
  "DRAFT",
] as const;

export function donutTotalFrom(byStatus: Record<string, number>) {
  return PRIMARY_STATUSES.reduce((sum, status) => sum + (Number(byStatus[status]) || 0), 0);
}
