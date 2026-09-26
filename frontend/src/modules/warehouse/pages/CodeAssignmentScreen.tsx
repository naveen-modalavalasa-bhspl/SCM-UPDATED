import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Boxes, Check, MapPin, ScanLine, Trash2, X } from "lucide-react";
import { Button, ErrorBanner } from "@/shared/components";
import { listSerials } from "../api";
import { TrackingBadge } from "../components/TrackingBadge";
import type { SerialNumber, TrackingType, TrackingTypeMeta, UnitMode } from "../types";

/**
 * Naming the physical units on one pick of a material issue — a SCREEN, not a dialog.
 *
 * It was a modal, and a modal is the wrong shape for this job. One bay can hold
 * hundreds of thousands of coded units (the live floor has a single lot of 464,981),
 * the storekeeper is reading labels off a shelf rather than answering a question, and
 * the work is interleaved with walking. A 600px box that dims the document behind it
 * says "finish this now"; this is a place you stand for ten minutes.
 *
 * It is rendered in place of the form rather than pushed as a route on purpose. A
 * material issue is routinely drafted and not yet saved — an unsaved line has no id
 * to put in a URL — so a real navigation would throw the half-typed document away to
 * go and pick codes for it. Same component tree, same state, whole screen.
 *
 * WHAT MAKES IT CORRECT, and every one of these fails quietly if it is undone:
 *
 * - **Selection is held by VALUE, in one Set, for the whole pick.** The list under it
 *   is one page of a server-side query; the selection is not. Picking 500 on page 1
 *   and 500 on page 2 is one pick of 1,000, and `Save` hands back all of it.
 * - **The search runs on the SERVER.** Filtering the page in the browser answers
 *   "is it on this page", which is not the question a storekeeper holding a label is
 *   asking. With 47 pages the answer is almost always no, and it is the wrong no.
 * - **A scan that misses the page is looked up directly.** A gun fires its payload and
 *   Enter inside the search debounce, so the unit in the storekeeper's hand is
 *   routinely on a page that has not been fetched. Telling him it does not exist,
 *   because of where it happens to sort, is the worst answer this screen can give.
 * - **"Loading", "failed" and "empty" are three different sentences.** They were one,
 *   and a failed request read as an empty shelf.
 */
export interface CodeScope {
  batchNo?: string | null;
  binCode?: string | null;
  binPath?: string | null;
  available?: number | null;
  splitLabel?: string | null;
}

/**
 * Where the picked units are going — a stock movement's destination location and the
 * batch they keep. Given, the screen grows a third view listing every unit already
 * standing at that location in that batch, so the storekeeper sees what the bay holds
 * before he adds to it, and afterwards finds the moved units exactly there.
 */
export interface CodeDestination {
  binId: number;
  binCode?: string | null;
  binPath?: string | null;
  batchId?: number | null;
  batchNo?: string | null;
}

type View = "shelf" | "picked" | "destination";

/** How many rows one page carries. Well inside `core/pagination.MAX_PAGE_SIZE` (500),
 *  and small enough that a page renders in one frame on the tablets on the floor. */
const PAGE_SIZE = 200;

export function CodeAssignmentScreen({
  open,
  onClose,
  onSave,
  initial,
  quantity,
  itemLabel,
  trackingType,
  trackingMeta,
  noun,
  unitMode,
  scope,
  readOnly = false,
  itemId,
  warehouseId,
  batchId,
  binId,
  issueId,
  issueLineId,
  backLabel = "Back to the issue",
  unbatched = false,
  claimFree = false,
  destination,
  browse = false,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (codes: string[]) => void;
  initial: string[];
  quantity: number;
  itemLabel: string;
  trackingType: TrackingType;
  trackingMeta?: TrackingTypeMeta | null;
  noun: string;
  unitMode: UnitMode;
  scope?: CodeScope;
  readOnly?: boolean;
  itemId?: number;
  warehouseId?: number;
  batchId?: number;
  binId?: number;
  issueId?: number;
  issueLineId?: number;
  /** The way back names the document the screen was opened from. */
  backLabel?: string;
  /** No batch named means the UNBATCHED lot, not every batch in the bay. */
  unbatched?: boolean;
  /** Offer only units no document is holding — for a picker with no line of its own. */
  claimFree?: boolean;
  destination?: CodeDestination;
  /** A viewer, not a picker: lists the units at the scope, selects nothing. */
  browse?: boolean;
}) {
  const qc = useQueryClient();
  const [picked, setPicked] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [entry, setEntry] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("shelf");
  const showPicked = view === "picked";
  /** Which pool the list and the pager are reading. */
  const listView: "shelf" | "destination" = view === "destination" ? "destination" : "shelf";
  const [busyScan, setBusyScan] = useState(false);

  const required = Math.floor(quantity);
  const selected = useMemo(() => new Set(picked), [picked]);

  // Fresh every time the screen opens on a pick. Keyed on `open` alone: `initial` is
  // a new array on every render of the parent grid, so keying on it would wipe the
  // storekeeper's work on each keystroke elsewhere on the form.
  useEffect(() => {
    if (!open) return;
    setPicked(initial ?? []);
    setPage(1);
    setEntry("");
    setSearch("");
    setError(null);
    setView("shelf");
    // "" is what has effectively been sent: the first query goes out unsearched. Left
    // at its initial null, the very first debounce sees null !== "" , calls that a
    // changed needle and resets the reader to page 1 — 300 ms after every press of
    // Next, which is exactly the bug this ref exists to prevent.
    sent.current = "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /**
   * What was last handed to the server, so an unchanged needle is never sent twice.
   *
   * Not an optimisation. Re-sending the same search says "the search changed", and a
   * changed search must return the reader to page 1 — so without this, every render
   * quietly reset the pager and no page but the first could be read.
   */
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const value = entry.trim();
    if (sent.current === value) return;
    const timer = setTimeout(() => {
      sent.current = value;
      // Only a needle that actually CHANGED sends the reader back to page 1.
      // Only a needle that actually CHANGED sends the reader back to page 1.
      setSearch((current) => {
        if (current !== value) setPage(1);
        return value;
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [entry, open]);

  const ready = !!(itemId && warehouseId);
  /** One page of either pool. The destination is read with no claim filter: a unit
   *  already standing there is shown whatever holds it — it is not being offered. */
  const args = (which: number, needle: string, where: "shelf" | "destination" = "shelf") => {
    const atDest = where === "destination" && !!destination;
    const batch = atDest ? destination!.batchId : batchId;
    return {
      item_id: itemId!,
      batch_id: batch || undefined,
      bin_id: (atDest ? destination!.binId : binId) || undefined,
      unbatched: (unbatched && !batch) || undefined,
      claim_free: (!atDest && claimFree) || undefined,
      warehouse_id: warehouseId!,
      issue_id: atDest ? undefined : issueId || undefined,
      issue_line_id: atDest ? undefined : issueLineId || undefined,
      status: "available",
      page: which,
      size: PAGE_SIZE,
      search: needle || undefined,
    };
  };
  const key = (which: number, needle: string, where: "shelf" | "destination" = "shelf") => [
    "wh-issue-codes", where, itemId ?? 0, warehouseId ?? 0, batchId ?? 0, binId ?? 0,
    destination?.binId ?? 0, destination?.batchId ?? 0, unbatched, claimFree,
    issueLineId ?? 0, which, needle,
  ];

  const codes = useQuery({
    queryKey: key(page, search, listView),
    queryFn: () => listSerials(args(page, search, listView)),
    enabled: open && ready,
    // The page being read must not blank out while the next one loads: a list that
    // empties and refills reads as stock disappearing off the shelf.
    placeholderData: (previous) => previous,
    // A page already read is shown again instantly. Every request here pays for a
    // COUNT over the whole filtered set — 464,981 rows on the live floor, and about
    // a third of a second of it — so re-fetching a page the storekeeper walked back
    // to is the single most expensive thing this screen could do for no new
    // information. Units do not appear in a bay while one pick is being named.
    staleTime: 5 * 60_000,
  });

  /**
   * The size of the pool, carried across page changes.
   *
   * The pager reads `total`, and `total` arrives with each page. Moving to a page that
   * is not in cache yet leaves it briefly undefined, which collapsed the pager and
   * re-laid out the footer under the storekeeper's hand mid-press. It cannot change
   * while one pick is being named, so the last known figure stands until a new one
   * arrives; a fresh search resets it, because that genuinely is a different pool.
   */
  const lastTotal = useRef(0);
  useEffect(() => { lastTotal.current = 0; }, [search, itemId, batchId, binId, listView]);
  if (codes.data?.total != null) lastTotal.current = codes.data.total;
  const total = codes.data?.total ?? lastTotal.current;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  /** The value this item is validated on, for one row. */
  const keyOf = (row: SerialNumber): string =>
    unitMode === "SERIAL"
      ? row.serial_number
      : unitMode === "IMEI"
        ? row.imei ?? ""
        : row.asset_code ?? row.consumable_code ?? row.serial_number;

  const rows = (codes.data?.items ?? []).filter((row) => !!keyOf(row));
  /**
   * The neighbouring pages, fetched while this one is being read.
   *
   * Both directions: a storekeeper who has walked past the unit he wanted goes BACK,
   * and paying a round trip for that is as bad as paying one to go forward. Only the
   * neighbours — reading the whole bay to page through it is the unbounded query this
   * endpoint is paginated to avoid.
   */
  useEffect(() => {
    if (!open || !ready) return;
    for (const which of [page + 1, page - 1]) {
      if (which < 1 || which > pageCount || which === page) continue;
      void qc.prefetchQuery({
        queryKey: key(which, search, listView),
        queryFn: () => listSerials(args(which, search, listView)),
        staleTime: 5 * 60_000,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ready, page, pageCount, search, total, listView]);

  const room = required - selected.size;

  const toggle = (value: string) => {
    setError(null);
    setPicked((current) => {
      if (current.includes(value)) return current.filter((v) => v !== value);
      if (current.length >= required) {
        setError(`This pick is for ${required}; remove one before adding another.`);
        return current;
      }
      return [...current, value];
    });
  };

  /**
   * One scan of the gun, or one typed code.
   *
   * Looks on the page first, then asks the server for that exact identifier. The
   * second half is what makes the search "precise" across pages: the unit is selected
   * whether or not the page it lives on has ever been fetched.
   */
  const commit = async () => {
    const value = entry.trim();
    if (!value || browse) return;
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
    const onPage = listView !== "shelf" ? undefined : rows.find((row) =>
      same(keyOf(row), value)
      || [row.serial_number, row.imei, row.asset_code, row.consumable_code]
        .some((token) => token && same(token, value)));
    if (onPage) {
      setEntry("");
      const found = keyOf(onPage);
      if (selected.has(found)) { setError(`${found} is already on this pick.`); return; }
      toggle(found);
      return;
    }
    if (!ready) return;
    setBusyScan(true);
    try {
      const hit = await listSerials({ ...args(1, value), size: 25 });
      const match = (hit.items ?? []).find((row) =>
        same(keyOf(row) || "", value)
        || [row.serial_number, row.imei, row.asset_code, row.consumable_code]
          .some((token) => token && same(token, value)));
      setEntry("");
      if (!match) {
        setError(`${value} is not among the ${noun}s in this batch and location.`);
        return;
      }
      const found = keyOf(match);
      if (selected.has(found)) { setError(`${found} is already on this pick.`); return; }
      toggle(found);
    } catch {
      setError(`${value} could not be looked up. The request failed.`);
    } finally {
      setBusyScan(false);
    }
  };

  if (!open) return null;

  const complete = selected.size === required;
  const listed = showPicked ? picked : rows.map(keyOf);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-content1">
      {/* Header — what is being picked, and from where. The scope is on screen
        * because the list is SCOPED to it: a unit in another bay is not offered at
        * all, so a correctly short list reads as missing stock without this. */}
      <header className="shrink-0 border-b border-line bg-content2/60 px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="subtle" onClick={onClose}>
            <ArrowLeft className="h-4 w-4" /> {backLabel}
          </Button>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-display text-lg font-bold text-ink">
                {browse ? `${noun}s here` : `${readOnly ? "Assigned" : "Select"} ${noun}s`}
              </h1>
              {trackingType !== "NONE" && <TrackingBadge type={trackingType} meta={trackingMeta} />}
            </div>
            <p className="truncate text-xs text-muted">{itemLabel}</p>
          </div>
          {browse ? (
            <div className="text-right">
              <p className="font-display text-2xl font-bold tabular text-ink">{total.toLocaleString()}</p>
              <p className="text-[11px] uppercase tracking-wider text-muted">available</p>
            </div>
          ) : (
            <div className="text-right">
              <p className={`font-display text-2xl font-bold tabular ${complete ? "text-ok" : "text-warn"}`}>
                {selected.size} <span className="text-muted">/ {required}</span>
              </p>
              <p className="text-[11px] uppercase tracking-wider text-muted">selected</p>
              {/* How far along, at a glance from across the aisle. */}
              <div className="mt-1 h-1.5 w-28 overflow-hidden rounded-full bg-content3">
                <div className={`h-full transition-all duration-300 ${complete ? "bg-ok" : "bg-warn"}`}
                     style={{ width: `${required ? Math.min(100, (selected.size / required) * 100) : 0}%` }} />
              </div>
            </div>
          )}
        </div>

        {scope && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-line/70 bg-content1 px-3 py-2 text-xs">
            {scope.splitLabel && <span className="font-semibold text-ink">{scope.splitLabel}</span>}
            <span className="flex items-center gap-1.5 text-muted">
              <Boxes className="h-3.5 w-3.5" aria-hidden />
              Batch <b className="font-mono text-ink">{scope.batchNo || "unbatched"}</b>
            </span>
            <span className="flex items-center gap-1.5 text-muted">
              <MapPin className="h-3.5 w-3.5 text-brand" aria-hidden />
              {scope.binPath
                ? scope.binPath.split("/").map((rung, i, all) => (
                    <span key={`${rung}-${i}`}>
                      <b className={i === all.length - 1
                        ? "font-mono text-ink"
                        : "font-mono font-normal text-muted"}>{rung.trim()}</b>
                      {i < all.length - 1 && <span className="px-0.5 text-muted/60">›</span>}
                    </span>
                  ))
                : <b className="font-mono text-ink">{scope.binCode || "no bin"}</b>}
            </span>
            {scope.available != null && (
              <span className="text-muted">Holds <b className="tabular text-ink">{scope.available}</b></span>
            )}
            {destination && (
              <span className="flex items-center gap-1.5 text-muted">
                <ArrowRight className="h-3.5 w-3.5 text-ok" aria-hidden />
                to <b className="font-mono text-ink">{destination.binPath || destination.binCode || "destination"}</b>
              </span>
            )}
            {listView === "shelf" && (
              <span className="ml-auto text-muted">
                <b className="tabular text-ink">{total.toLocaleString()}</b>{" "}
                {browse ? "available here" : "here to choose from"}
              </span>
            )}
          </div>
        )}
      </header>

      {/* The scan box and the two views. Sticky, because it is the thing the
        * storekeeper comes back to after every walk to the shelf. */}
      <div className="shrink-0 border-b border-line bg-content1 px-4 py-3 sm:px-6">
        {!readOnly && (
          <label className="relative block">
            <ScanLine className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              autoFocus
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commit(); } }}
              placeholder={browse
                ? `Search any ${noun} here — every page, not just this one`
                : `Scan or search any ${noun} — every page, not just this one`}
              aria-label={`Scan or search ${noun}s`}
              className="min-h-11 w-full rounded-md border border-line bg-content1 pl-9 pr-3 text-sm text-ink outline-none placeholder:text-muted focus:border-brand"
            />
          </label>
        )}
        <ErrorBanner error={error} />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant={view === "shelf" ? "soft" : "ghost"}
                  onClick={() => { setView("shelf"); setPage(1); }}>
            {destination ? "At source" : "On this shelf"}
          </Button>
          {/* The picks made on OTHER pages are invisible in a paged list, so there has
            * to be somewhere to see and undo them. Read straight off the selection —
            * it costs no request. */}
          {!browse && (
            <Button variant={showPicked ? "soft" : "ghost"} onClick={() => setView("picked")}>
              Selected ({selected.size})
            </Button>
          )}
          {destination && (
            <Button variant={view === "destination" ? "soft" : "ghost"}
                    onClick={() => { setView("destination"); setPage(1); }}>
              <ArrowRight className="h-4 w-4" /> At destination
            </Button>
          )}
          <span className="flex-1" />
          {!readOnly && !browse && view === "shelf" && (
            <Button variant="subtle" disabled={selected.size === 0} onClick={() => setPicked([])}>
              Clear all
            </Button>
          )}
        </div>
      </div>

      {/* The list */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-6">
        {showPicked ? (
          picked.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted">
              Nothing picked yet. Scan a {noun}, or choose from the shelf.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {picked.map((value, index) => (
                <li key={value}
                    className="flex min-h-11 items-center justify-between gap-2 rounded-lg border border-line/70 bg-content1 px-3">
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="w-10 shrink-0 text-[11px] text-muted tabular">{index + 1}</span>
                    <span className="truncate font-mono text-sm text-ink">{value}</span>
                  </span>
                  {!readOnly && (
                    <button type="button" aria-label={`Remove ${value}`}
                            onClick={() => setPicked((c) => c.filter((v) => v !== value))}
                            className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:text-bad">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )
        ) : codes.isError ? (
          <div className="py-16 text-center text-sm">
            <p className="font-semibold text-bad">The {noun}s could not be loaded.</p>
            <p className="mt-1 text-muted">{(codes.error as Error)?.message || "The request failed."}</p>
            <p className="mt-1 text-muted">
              This is not a statement about the shelf — the stock may well be there.
            </p>
          </div>
        ) : !codes.isSuccess ? (
          <p className="py-16 text-center text-sm text-muted">Loading {noun}s…</p>
        ) : listed.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted">
            {search
              ? `Nothing in this batch and location matches “${search}”.`
              : listView === "destination"
                ? `No ${noun}s of this item and batch are at the destination yet — the ${selected.size || ""} you select land here.`
                : `No ${noun}s are available in this batch and location.`}
          </p>
        ) : (
          <>
          {listView === "destination" && (
            <p className="mb-3 rounded-lg border border-ok/30 bg-ok/5 px-3 py-2 text-xs text-body">
              Already standing at the destination in this batch. The{" "}
              <b className="tabular">{selected.size}</b> selected {noun}
              {selected.size === 1 ? "" : "s"} join them when the movement completes.
            </p>
          )}
          <ul className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((row, index) => {
              const value = keyOf(row);
              const isOn = listView === "shelf" && selected.has(value);
              const fixed = readOnly || browse || listView !== "shelf";
              return (
                <li key={row.id}>
                  <label
                    className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition ${
                      isOn ? "border-brand bg-brand/5" : "border-line/70 bg-content1 hover:border-line"
                    } ${fixed ? "cursor-default" : ""}`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={isOn}
                      disabled={fixed}
                      onChange={() => !fixed && toggle(value)}
                    />
                    {fixed ? (
                      <span className={`h-2 w-2 shrink-0 rounded-full ${listView === "destination" ? "bg-ok" : "bg-brand/50"}`} />
                    ) : (
                      <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                        isOn ? "border-brand bg-brand text-white" : "border-line"
                      }`}>
                        {isOn && <Check className="h-3.5 w-3.5" />}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-sm text-ink">{value}</span>
                      {/* The unit's other numbers. A handset carries a serial AND an
                        * IMEI; showing the one the line is not keyed on is what lets
                        * a storekeeper match the label in his hand. */}
                      {(() => {
                        const others = [
                          unitMode !== "SERIAL" ? row.serial_number : null,
                          unitMode !== "IMEI" ? row.imei : null,
                          row.asset_code && row.asset_code !== value ? row.asset_code : null,
                          row.consumable_code && row.consumable_code !== value ? row.consumable_code : null,
                        ].filter((t): t is string => !!t && t !== value);
                        return others.length ? (
                          <span className="block truncate text-[11px] text-muted">{others.join(" · ")}</span>
                        ) : null;
                      })()}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted tabular">
                      {(page - 1) * PAGE_SIZE + index + 1}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          </>
        )}
      </div>

      {/* Footer — the pager and the decision */}
      <footer className="shrink-0 border-t border-line bg-content2/60 px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          {!showPicked && total > PAGE_SIZE && (
            <div className="flex items-center gap-2 text-sm">
              <Button variant="subtle" disabled={page <= 1 || codes.isFetching}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}>
                Previous
              </Button>
              <span className="tabular text-muted">
                {((page - 1) * PAGE_SIZE + 1).toLocaleString()}–
                {Math.min(page * PAGE_SIZE, total).toLocaleString()} of{" "}
                <b className="text-ink">{total.toLocaleString()}</b>
              </span>
              <Button variant="subtle" disabled={page >= pageCount || codes.isFetching}
                      onClick={() => setPage((p) => Math.min(pageCount, p + 1))}>
                Next
              </Button>
              {codes.isFetching && <span className="text-xs text-muted">loading…</span>}
            </div>
          )}
          <span className="flex-1" />
          {busyScan && <span className="text-xs text-muted">looking it up…</span>}
          {!complete && !readOnly && !browse && (
            <span className="text-xs text-muted">
              {room > 0
                ? `${room} more to assign before this pick can be saved.`
                : `${-room} too many.`}
            </span>
          )}
          <Button variant="subtle" onClick={onClose}>
            <X className="h-4 w-4" /> {readOnly || browse ? "Close" : "Cancel"}
          </Button>
          {!readOnly && !browse && (
            <Button
              disabled={!complete}
              onClick={() => {
                // The WHOLE selection, deduplicated through a Set rather than
                // `indexOf` — this list runs to 10,000, where the quadratic form
                // freezes the tab. Never intersected with the page on screen: that
                // is what used to throw away everything picked elsewhere.
                onSave(Array.from(new Set(picked)));
                onClose();
              }}
            >
              Save {selected.size} {noun}{selected.size === 1 ? "" : "s"}
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}
