import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * Procurement's list filters, held in the URL rather than in component state.
 *
 * WHY: a KPI tile applies a filter, and a filter that lives in `useState` cannot be
 * applied from anywhere else — not from the Overview, not from a notification's deep
 * link, and not from a link somebody pasted into a chat. Every register in this module
 * reads its filters from here, so the same `?status=PENDING_APPROVAL` means the same
 * thing whether it was typed, pressed on a tile, or arrived from another screen.
 *
 * It is also what makes a tile a TOGGLE: pressing the tile whose filter is already on
 * clears it, because `set` compares against what the URL already says.
 *
 * `replace: true` on every write — a filter is not a place. Ten presses on the strip
 * should leave the browser Back button going back to where the user came from, not
 * walking them out through ten states of the same screen.
 */

export type FilterValue = string | number | boolean | undefined | null;

export function useUrlFilters() {
  const [params, setParams] = useSearchParams();

  /** Read one filter. Absent and empty are the same answer: no filter. */
  const get = useCallback(
    (key: string) => params.get(key) ?? "", [params]);

  const getBool = useCallback(
    (key: string) => params.get(key) === "1", [params]);

  const getNumber = useCallback((key: string) => {
    const raw = params.get(key);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }, [params]);

  /**
   * Write filters. `undefined`, `null`, `""` and `false` all REMOVE a key rather than
   * writing an empty one, so a cleared filter leaves a clean URL and two ways of
   * saying "no filter" can never disagree.
   *
   * Any write resets `page` to 1 unless the caller is setting `page` itself: filtering
   * to four rows while sitting on page 3 shows an empty list and reads as a bug.
   */
  const set = useCallback((next: Record<string, FilterValue>) => {
    setParams((prev) => {
      const out = new URLSearchParams(prev);
      for (const [key, value] of Object.entries(next)) {
        if (value === undefined || value === null || value === "" || value === false) {
          out.delete(key);
        } else {
          out.set(key, value === true ? "1" : String(value));
        }
      }
      if (!("page" in next)) out.delete("page");
      return out;
    }, { replace: true });
  }, [setParams]);

  /**
   * The tile press. Sets `values` when they are not already on, clears every key in
   * `values` when they are — which is what makes the strip a set of toggles.
   */
  const toggle = useCallback((values: Record<string, FilterValue>) => {
    const isOn = Object.entries(values).every(([key, value]) => {
      const current = params.get(key) ?? "";
      if (value === true) return current === "1";
      if (value === undefined || value === null || value === "" || value === false) {
        return current === "";
      }
      return current === String(value);
    });
    set(Object.fromEntries(
      Object.keys(values).map((key) => [key, isOn ? undefined : values[key]]),
    ));
  }, [params, set]);

  /** Whether the filter a tile stands for is the one currently applied. */
  const isActive = useCallback((values: Record<string, FilterValue>) =>
    Object.entries(values).every(([key, value]) => {
      const current = params.get(key) ?? "";
      if (value === true) return current === "1";
      if (value === undefined || value === null || value === "" || value === false) {
        return current === "";
      }
      return current === String(value);
    }), [params]);

  /** Drop every filter this screen owns, page included. */
  const clear = useCallback((keys: string[]) => {
    setParams((prev) => {
      const out = new URLSearchParams(prev);
      [...keys, "page"].forEach((key) => out.delete(key));
      return out;
    }, { replace: true });
  }, [setParams]);

  const page = useMemo(() => {
    const n = Number(params.get("page") ?? 1);
    return Number.isFinite(n) && n >= 1 ? n : 1;
  }, [params]);

  const setPage = useCallback(
    (next: number) => set({ page: next > 1 ? next : undefined }), [set]);

  /** How many of `keys` are currently set — for a "Clear (3)" button. */
  const activeCount = useCallback((keys: string[]) =>
    keys.filter((key) => (params.get(key) ?? "") !== "").length, [params]);

  return { params, get, getBool, getNumber, set, toggle, isActive, clear,
           page, setPage, activeCount };
}
