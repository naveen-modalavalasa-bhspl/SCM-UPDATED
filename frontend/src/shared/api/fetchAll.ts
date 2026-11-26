import { api } from "./client";
import type { Paginated } from "@/shared/types";

/** Rows per request. It is the server's own `MAX_PAGE_SIZE`: asking for more is refused
 *  with a 422, asking for less only costs round trips. */
export const ALL_ROWS_PAGE_SIZE = 500;

/** How many pages a "give me everything" read may take before it stops: 50 x 500 =
 *  25,000 rows. Well past every master this system has (983 warehouses is the largest),
 *  and small enough that a table which should never be read whole — 773k unit codes —
 *  cannot be pulled into a browser by accident. */
export const ALL_ROWS_MAX_PAGES = 50;

/** Requests in flight at once once the first page has said how many there are. */
const PARALLEL = 4;

// `any` on purpose: every module's list client types its own filters, and this has to
// accept all of them. What it adds — page and size — is the only part it relies on.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Params = Record<string, any>;
type PageFn<T> = (params: Params) => Promise<{ items: T[]; total?: number }>;

/** Every row a paginated list holds, read a page at a time.
 *
 *  Why it exists (bug sheet QA-5, BUG_0013/14/16/17): dropdowns asked for one page —
 *  `size: 100` or `300` — and never for page 2, so the 301st brand, generic name or
 *  warehouse simply was not there, with nothing on screen saying the list had been
 *  cut. Raising the number is not the fix: the server caps a page at 500 on purpose
 *  (CLAUDE.md, "How much one request may carry"). Paging through is.
 *
 *  The first page says how many there are; the rest are fetched a few at a time and
 *  put back in page order, so the result reads exactly as one long page would. Any
 *  `page` / `size` the caller passes is ignored — this function owns both. */
export async function fetchAllPages<T>(load: PageFn<T>, params: Params = {}): Promise<T[]> {
  const base = { ...params };
  delete base.page;
  delete base.size;

  const first = await load({ ...base, page: 1, size: ALL_ROWS_PAGE_SIZE });
  const rows = [...(first.items ?? [])];
  const total = Number(first.total ?? rows.length);
  const pages = Math.min(Math.ceil(total / ALL_ROWS_PAGE_SIZE), ALL_ROWS_MAX_PAGES);
  if (pages <= 1) return rows;

  if (Math.ceil(total / ALL_ROWS_PAGE_SIZE) > ALL_ROWS_MAX_PAGES) {
    // Said out loud, never silent: a list cut short is the defect this replaced.
    console.warn(
      `fetchAllPages: ${total} rows, reading the first ${ALL_ROWS_MAX_PAGES * ALL_ROWS_PAGE_SIZE}.`
      + " Use a server-side search for a list this size.",
    );
  }

  const rest: T[][] = new Array(pages - 1);
  let next = 2;
  const worker = async () => {
    while (next <= pages) {
      const page = next;
      next += 1;
      const data = await load({ ...base, page, size: ALL_ROWS_PAGE_SIZE });
      rest[page - 2] = data.items ?? [];
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, pages - 1) }, worker));
  for (const chunk of rest) rows.push(...(chunk ?? []));
  return rows;
}

/** `fetchAllPages` over a plain GET path, for call sites that talk to `api` directly. */
export const getAllPages = <T>(path: string, params: Params = {}) =>
  fetchAllPages<T>(
    (p) => api.get<Paginated<T>>(path, { params: p }).then((r) => r.data),
    params,
  );

/** Rows read whole, wrapped back into the `{items, total, page, size}` shape, for a
 *  screen written against one page that must now see all of them. */
export const asPage = <T>(items: T[]): Paginated<T> =>
  ({ items, total: items.length, page: 1, size: items.length });
