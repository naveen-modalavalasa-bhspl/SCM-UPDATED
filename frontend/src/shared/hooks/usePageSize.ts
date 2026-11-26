import { useCallback, useState } from "react";

/** The rows-per-page choices every list offers. 500 is the server's own ceiling
 *  (`MAX_PAGE_SIZE`), so the largest choice is one request, never a refused one. */
export const PAGE_SIZE_OPTIONS = [20, 50, 100, 200, 500] as const;

const STORAGE_PREFIX = "scm.pageSize.";

const read = (key: string, fallback: number): number => {
  try {
    const raw = Number(window.localStorage.getItem(STORAGE_PREFIX + key));
    return (PAGE_SIZE_OPTIONS as readonly number[]).includes(raw) ? raw : fallback;
  } catch {
    return fallback;
  }
};

/** Rows per page for one list, remembered per screen in this browser.
 *
 *  QA-5 BUG_0011: every list was fixed at 20 or 25 rows a page. A storekeeper
 *  reconciling a shelf wants 500 on one screen; somebody on a phone wants 20. The
 *  choice is a convenience, so it lives in localStorage — losing it costs nothing. */
export function usePageSize(screen: string, fallback = 20): [number, (size: number) => void] {
  const [size, setSize] = useState(() => read(screen, fallback));
  const choose = useCallback((next: number) => {
    setSize(next);
    try {
      window.localStorage.setItem(STORAGE_PREFIX + screen, String(next));
    } catch {
      // Private window or blocked storage: the choice simply is not remembered.
    }
  }, [screen]);
  return [size, choose];
}
