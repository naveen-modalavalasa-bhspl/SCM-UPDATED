import { useEffect, useRef, useState } from "react";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Skeleton } from "@heroui/react";
import { FixedSizeList } from "react-window";
import { Boxes, MapPin, ScanLine, Trash2 } from "lucide-react";
import { Button, ErrorBanner } from "@/shared/components";
import { TrackingBadge } from "./TrackingBadge";
import type { TrackingType, TrackingTypeMeta } from "../types";

/**
 * One unit as the picker shows it: the value being validated, plus every other
 * identifier the same physical unit carries and where it is standing.
 *
 * The list used to be a single column of monospace strings. A serial, an IMEI, an
 * asset tag and a consumable lot code all look the same in that column — fifteen
 * characters of upper case and digits — so nothing on screen said which of them the
 * storekeeper was looking at, or which of a handset's two numbers he was expected to
 * scan. Naming the type per row, once, is the fix.
 */
export interface PickerUnit {
  /** The identifier this line is validated on — what selection is keyed by. */
  value: string;
  type?: TrackingType | null;
  serial?: string | null;
  imei?: string | null;
  code?: string | null;
  batchNo?: string | null;
  binCode?: string | null;
}

/** Where the units being picked are standing, and how many the pick is for. Shown
 *  above the list because the list is SCOPED to it: a unit in another bin or another
 *  batch is not on offer here, and a storekeeper who does not know that reads a short
 *  list as missing stock. */
export interface PickerScope {
  batchNo?: string | null;
  binCode?: string | null;
  /** The whole walk down to that location — `F1 / F1-A1 / F1-A1-R1 / …`. A picker
   *  being told the list is confined to `F1-A1-R1-B2` has been told nothing he can
   *  act on unless he is also told where that is. */
  binPath?: string | null;
  /** What that exact batch-and-bin holds, from the served sources. */
  available?: number | null;
  /** Which pick of the item this is, when the ask was served from several locations. */
  splitLabel?: string | null;
}

/**
 * Captures the serial numbers of a receipt or issue line — or, at inspection, picks
 * which of the captured ones are being rejected.
 *
 * **Capture mode** (the default, used by the GRN): a serial-tracked line needs exactly
 * as many serials as its quantity, and they must be unique — both are checked here
 * before the modal will save, because the line grid has nowhere to show a per-serial
 * error once the modal has closed. The box keeps focus and clears on Enter so a scanner
 * gun can fire through a whole carton without anyone touching the keyboard.
 *
 * `partial` relaxes only the count, for the gate entry: the guard records what the
 * unopened load lets them read and the GRN, which is the same document row, insists on
 * the full set later. The ceiling stays — more serials than units is a miscount either
 * way.
 *
 * **Pick mode** (`available` given, used by QC): the serials already exist — they were
 * read off the units at the GRN — so typing them again could only introduce a number
 * that was never received, which the backend rejects at completion. The inspector ticks
 * the units being rejected and `onSave` still receives the ACCEPTED ones, so both modes
 * hand back the same thing: what this line is keeping.
 */
export function SerialNumbersModal({
  isOpen,
  onClose,
  onSave,
  initial = [],
  quantity,
  itemLabel,
  readOnly = false,
  partial = false,
  available = null,
  imeiBySerial,
  metaByValue,
  unitByValue,
  scope,
  trackingType,
  trackingMeta,
  pickMode = "reject",
  noun = "serial",
  paging = null,
  displayValue,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** The serials this line is keeping. In pick mode, everything not ticked. */
  onSave: (serials: string[]) => void;
  initial?: string[] | null;
  /** How many serials the line requires. Ignored in pick mode. */
  quantity: number;
  itemLabel: string;
  /** What one captured code is called. An IMEI obeys the same rules as a serial —
   *  one per unit, unique, mandatory on a GRN — so it reuses this modal rather
   *  than cloning it, and only the wording changes. */
  noun?: string;
  readOnly?: boolean;
  /** Allow saving fewer serials than the quantity. Capture mode only. */
  partial?: boolean;
  /** The GRN's serials for this line. Present = pick mode, absent = type them. */
  available?: string[] | null;
  /** serial -> IMEI. Shown beside each unit so a handset is identified by both of
   *  its numbers at the moment it is picked, not retyped at the far end. */
  imeiBySerial?: Record<string, string>;
  /** The rest of the unit, keyed by the value being validated. Whatever the item is
   *  validated on — serial, IMEI or code — the other identifiers of the SAME unit are
   *  shown under it, so picking one identifier reflects the others rather than
   *  leaving the storekeeper to look them up. */
  metaByValue?: Record<string, string>;
  /** The full unit behind each offered value. Present = the typed, columned picker;
   *  absent = the plain list, which is what QC and the GRN still want. */
  unitByValue?: Record<string, PickerUnit>;
  /** The batch and bin this pick is confined to. */
  scope?: PickerScope;
  /** What kind of identifier the line is asking for, for the badge and the wording. */
  trackingType?: TrackingType | null;
  /** The served row for that type — see `TRACKING_META`. */
  trackingMeta?: TrackingTypeMeta | null;
  /** `reject` is QC semantics; `select` is used when issuing stock from a bin. */
  pickMode?: "reject" | "select";
  /**
   * Server-side paging for the offered list. Absent = the caller handed over the whole
   * pool and the modal filters it in the browser, which is what the GRN and QC do.
   *
   * A material issue cannot work that way any more: one bin can hold 10,000 coded
   * units, and `MAX_PAGE_SIZE` is 500, so the picker silently offered the first 500
   * and called the rest missing stock. With this present `available` is ONE PAGE, the
   * search box narrows the whole pool at the server rather than the page in the
   * browser, and `onResolve` finds a scanned unit that is not on the page in hand.
   *
   * Selection is held by value and survives paging: `serials` is the modal's own
   * state and nothing here rewrites it, so a unit ticked on page 1 is still ticked
   * after a walk to page 14 and back.
   */
  paging?: {
    page: number;
    pageSize: number;
    total: number;
    loading?: boolean;
    onPageChange: (page: number) => void;
    /** Debounced by the caller; drives the server query. */
    onSearchChange: (value: string) => void;
    /** Why the list could not be fetched, if it could not.
     *
     * "No codes are available here" and "the request for them failed" are different
     * facts and only one of them is about the shelf. Conflating them sent a
     * storekeeper to look for stock that was sitting in the bay, because a failed
     * request rendered as an empty one. */
    error?: string | null;
    /** True once a fetch has actually completed. An empty list before that is "not
     *  asked yet", which must not be drawn as "nothing here". */
    loaded?: boolean;
    /** Look one exact identifier up across the WHOLE pool, for a scan that lands on
     *  a unit the current page does not carry. Returns the value to select, or null. */
    onResolve?: (value: string) => Promise<string | null>;
  } | null;
  /** How a code is DRAWN in the list — never what is searched, selected or saved.
   *  The acknowledgement screen passes the short tail of a long generated code; the
   *  full code stays on hover. Absent = drawn as it is. */
  displayValue?: (value: string) => string;
}) {
  const show = (value: string) => displayValue?.(value) ?? value;
  const [serials, setSerials] = useState<string[]>([]);
  // "a serial" but "an IMEI": the article follows the sound, not the spelling.
  const article = /^[aeiou]/i.test(noun) ? "an" : "a";
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  const [entry, setEntry] = useState("");
  const [bulkEntry, setBulkEntry] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Draw the whole captured list rather than the tail of it. See CAPTURE_WINDOW. */
  const [showEveryCapture, setShowEveryCapture] = useState(false);

  const picking = available !== null && available !== undefined;

  useEffect(() => {
    if (isOpen) {
      // Pick mode starts with nothing rejected. A line the inspector has not opened yet
      // carries no decision (null), which is not the same as "every unit rejected".
      setSerials(picking && initial == null ? available ?? [] : initial ?? []);
      setEntry("");
      setBulkEntry("");
      setError(null);
      setShowEveryCapture(false);
    }
    // `initial` is a fresh array on every render of the parent grid; keying the reset
    // off `isOpen` runs it once per open instead of wiping input on each keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  /**
   * Hand the search box to the server, 300 ms after the storekeeper stops typing.
   *
   * Only when the list is paged: unpaged callers already hold the whole pool and
   * filter it in the browser, which is instant and costs nothing. 300 ms is chosen
   * against a scanner gun rather than a typist — a gun delivers its whole payload in
   * one burst and fires Enter, so the debounce must not be short enough to launch a
   * query per character of a barcode.
   */
  const onSearchChange = paging?.onSearchChange;
  /**
   * What was last HANDED to the server, so an unchanged needle is never sent twice.
   *
   * Not an optimisation — it is what makes the pager work. `paging` is built as an
   * object literal by the caller, so `onSearchChange` is a new function on every
   * render and this effect re-runs every time. Without this guard each of those runs
   * re-sent the same (usually empty) search, and telling the caller "the search
   * changed" is what resets it to page 1: pressing Next moved to page 2 and snapped
   * back 300 ms later, so no page but the first could ever be read.
   */
  const sentSearch = useRef<string | null>(null);

  useEffect(() => {
    if (isOpen) sentSearch.current = "";
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !onSearchChange) return;
    const value = entry.trim();
    if (sentSearch.current === value) return;
    const timer = setTimeout(() => {
      sentSearch.current = value;
      onSearchChange(value);
    }, 300);
    return () => clearTimeout(timer);
  }, [entry, isOpen, onSearchChange]);

  const required = Math.floor(quantity);

  if (picking) {
    const selected = new Set(serials);

    /**
     * Every string that means this unit.
     *
     * The label stuck on the goods carries the SERIAL, but a line keyed on an asset
     * code or an IMEI lists those — so a scan of the label matched nothing at all and
     * the storekeeper fell back to reading the list by eye. All of a unit's numbers
     * are searched, whichever one the line happens to be validated on.
     *
     * `unitByValue` is the structured form the issue picker passes; `metaByValue` is
     * the display string the GRN and QC pickers still pass. Both are read, so neither
     * caller loses the match.
     */
    const aliases = (value: string): string[] => {
      const unit = unitByValue?.[value];
      return [
        value,
        unit?.serial ?? null,
        unit?.imei ?? null,
        unit?.code ?? null,
        imeiBySerial?.[value] ?? null,
        ...(metaByValue?.[value] ?? "").split(/[\s·,]+/),
      ].filter((token): token is string => !!token && token.trim().length > 0);
    };

    const needle = entry.trim().toLowerCase();
    // With paging on, the server has already narrowed the pool to the needle and the
    // page in hand IS the answer. Filtering it again in the browser would hide rows
    // the server matched on a column this alias list does not reproduce, and would
    // blank the list for the moment between the keystroke and the debounced refetch.
    const visible = paging
      ? (available ?? [])
      : (available ?? []).filter((s) =>
          needle ? aliases(s).some((token) => token.toLowerCase().includes(needle)) : true,
        );
    const rejected = (available ?? []).filter((s) => !selected.has(s));
    const toggle = (serial: string) =>
      setSerials((rows) =>
        rows.includes(serial) ? rows.filter((r) => r !== serial) : [...rows, serial],
      );
    const selectMode = pickMode === "select";
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

    const clearAll = () => {
      setError(null);
      setSerials([]);
    };

    /**
     * One scan of the gun. Enter fires this; the box is cleared either way so the
     * next barcode lands in an empty field without anyone touching the keyboard.
     *
     * The label stuck on the unit carries its SERIAL, but a line validated on an
     * asset code or an IMEI lists THOSE — so a scanned serial matched nothing at all
     * and the storekeeper fell back to reading the list by eye. `metaByValue` already
     * carries the unit's other identifiers for display; matching against it too means
     * the same scan finds the unit whichever number the line happens to be keyed on.
     *
     * A miss now says so. Silence was the worst outcome: the gun beeps on every read,
     * so nothing on screen changing looked identical to a successful scan.
     */
    const scanOrSearch = () => {
      const value = entry.trim();
      if (!value) return;
      const rows = available ?? [];
      // The value the line is keyed on first, then any other identifier of the
      // same unit — so one scan of the label finds it whichever number is on it.
      // If none match exactly but the filter narrowed the list to exactly one, select it.
      const hit =
        rows.find((s) => same(s, value))
        ?? rows.find((s) => aliases(s).some((token) => same(token, value)))
        ?? (visible.length === 1 ? visible[0] : undefined);
      setEntry("");
      if (!hit) {
        // Paged: the gun fires faster than the debounce, so the unit it just read is
        // routinely on a page that has not been fetched. Ask the server for that one
        // identifier before calling it missing — telling a storekeeper the unit in his
        // hand does not exist, because of where it happens to sort, is the worst
        // answer this box can give.
        if (paging?.onResolve) {
          setError(null);
          void paging.onResolve(value).then((found) => {
            if (!found) {
              setError(
                `${value} is not among the units in this batch and location.`
                + (selectMode ? " Check the split it belongs to." : ""),
              );
              return;
            }
            setSerials((rows2) => {
              if (rows2.includes(found)) {
                setError(`${found} is already on this pick.`);
                return rows2;
              }
              if (selectMode && rows2.length >= required) {
                setError(`This pick is for ${required}; remove one before scanning another.`);
                return rows2;
              }
              return [...rows2, found];
            });
          });
          return;
        }
        setError(
          `${value} is not among the units in this batch and location.`
          + (selectMode ? " Check the split it belongs to." : ""),
        );
        return;
      }
      if (!selectMode) {
        if (!selected.has(hit)) toggle(hit);
        setError(null);
        return;
      }
      if (selected.has(hit)) {
        setError(`${hit} is already on this pick.`);
        return;
      }
      if (selected.size >= required) {
        setError(`This pick is for ${required}; remove one before scanning another.`);
        return;
      }
      setError(null);
      toggle(hit);
    };

    const typed = !!unitByValue;
    const unitNoun = trackingMeta?.unit ?? noun;
    const plural = (count: number) => `${unitNoun}${count === 1 ? "" : "s"}`;

    return (
      <Modal isOpen={isOpen} onClose={onClose} size={typed ? "3xl" : "lg"} scrollBehavior="inside">
        <ModalContent>
          <ModalHeader className="flex-col items-start gap-1 bg-content1/80 backdrop-blur-md border-b border-line/50 pb-4">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-display text-lg font-bold text-ink">
                {selectMode
                  ? `Assign ${plural(2)}`
                  : `Reject ${plural(2)}`}
              </span>
              <TrackingBadge type={trackingType} meta={trackingMeta} />
            </span>
            <span className="text-xs font-normal text-muted">{itemLabel}</span>
          </ModalHeader>

          <ModalBody>
            {/* What this pick is confined to. The list below holds ONLY the units in
              * this batch and this bin — that is what stops a storekeeper picking a
              * unit out of a bay the line is not drawing on — so the scope has to be
              * on screen, or a correctly short list reads as missing stock. */}
            {selectMode && scope && (
              <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-line/70 bg-content2/50 px-3 py-2 text-xs">
                {scope.splitLabel && (
                  <span className="font-semibold text-ink">{scope.splitLabel}</span>
                )}
                <span className="flex items-center gap-1.5 text-muted">
                  <Boxes className="h-3.5 w-3.5" aria-hidden />
                  Batch <b className="font-mono text-ink">{scope.batchNo || "unbatched"}</b>
                </span>
                <span className="flex items-center gap-1.5 text-muted">
                  <MapPin className="h-3.5 w-3.5 text-brand" aria-hidden />
                  {/* The route, then the bay. Everything but the last rung stays
                    * muted: one of them is the label on the shelf, the rest is how
                    * you get there. */}
                  {scope.binPath
                    ? scope.binPath.split("/").map((rung, position, all) => (
                        <span key={`${rung}-${position}`}>
                          <b className={position === all.length - 1
                            ? "font-mono text-ink"
                            : "font-mono font-normal text-muted"}>
                            {rung.trim()}
                          </b>
                          {position < all.length - 1 && (
                            <span className="px-0.5 text-muted/60">›</span>
                          )}
                        </span>
                      ))
                    : <b className="font-mono text-ink">{scope.binCode || "no bin"}</b>}
                </span>
                {scope.available != null && (
                  <span className="text-muted">
                    Holds <b className="tabular text-ink">{scope.available}</b>
                  </span>
                )}
                <span className="ml-auto text-muted">
                  This pick needs <b className="tabular text-ink">{required}</b>{" "}
                  {plural(required)}
                </span>
              </div>
            )}
            {!readOnly && (
              <label className="relative mb-3 block">
                <ScanLine className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <input
                  autoFocus
                  value={entry}
                  onChange={(e) => setEntry(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      scanOrSearch();
                    }
                  }}
                  placeholder={selectMode
                    ? `Scan or search ${unitNoun === "IMEI" ? "an" : "a"} ${unitNoun}`
                    : "Search serials"}
                  aria-label={`Search ${plural(2)}`}
                  className="min-h-11 w-full rounded-md border border-line bg-content1 pl-9 pr-3 text-sm text-ink outline-none placeholder:text-muted focus:border-brand"
                />
              </label>
            )}
            <ErrorBanner error={error} />

            <div className="mb-3 flex items-center justify-between text-sm">
              <span className="text-muted">
                {selectMode
                  ? trackingMeta?.hint ?? `Choose exactly ${required} ${plural(required)}.`
                  : `Tick exactly ${available ? available.length - required : 0} units to reject.`}
              </span>
              <span className="font-semibold text-ink">
                {selectMode ? (
                  <>{selected.size} / {required} selected</>
                ) : (
                  <>{selected.size} accepted · <span className="text-bad">{rejected.length} rejected</span></>
                )}
              </span>
            </div>

            {selectMode && !readOnly && (available ?? []).length > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Button
                  variant="subtle"
                  disabled={selected.size === 0}
                  onClick={clearAll}
                >
                  Clear
                </Button>
                {selected.size >= required && (
                  <span className="text-xs text-muted">
                    This pick is full at {required}.
                  </span>
                )}
              </div>
            )}

            {paging?.error && (available ?? []).length === 0 ? (
              <div className="py-8 text-center text-sm">
                <p className="font-semibold text-bad">The {plural(2)} could not be loaded.</p>
                <p className="mt-1 text-muted">{paging.error}</p>
                <p className="mt-1 text-muted">
                  This is not a statement about the shelf — the stock may well be there.
                </p>
              </div>
            ) : (paging && !paging.loaded) || (paging?.loading && (available ?? []).length === 0) ? (
              <div className="space-y-3 py-4">
                {[1, 2, 3, 4, 5].map((i) => (
                  <Skeleton key={i} className="h-11 w-full rounded-lg" />
                ))}
              </div>
            ) : (available ?? []).length === 0 ? (
              <div className="py-8 text-center text-sm text-muted">
                {/* Paged and searched: the pool is not empty, this needle just does not
                  * match anything in it. Saying "none are available" there sends a
                  * storekeeper to look for stock that is sitting on the shelf. */}
                {paging && entry.trim()
                  ? "Nothing in this batch and location matches the search."
                  : selectMode
                    ? `No ${plural(2)} are available in this batch and location.`
                    : "No serials were captured on the GRN for this line."}
              </div>
            ) : visible.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted">
                Nothing here matches the search.
              </div>
            ) : typed ? (
              <div className="overflow-hidden rounded-xl border border-line/70">
                <div className="bg-content2 flex items-center border-b border-line/70">
                  <div className="w-10 px-3 py-2" />
                  <div className="w-8 px-1 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">#</div>
                  <div className="flex-1 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">{trackingMeta?.label ?? "Identifier"}</div>
                  <div className="w-24 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">Batch</div>
                  <div className="w-24 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">Location</div>
                </div>
                <FixedSizeList
                  height={400}
                  itemCount={visible.length}
                  itemSize={44}
                  width="100%"
                >
                  {({ index, style }) => {
                    const value = visible[index];
                    const unit = unitByValue?.[value];
                    const isSelected = selected.has(value);
                    const full = selectMode && !isSelected && selected.size >= required;
                    return (
                      <div
                        style={style}
                        onClick={() => !readOnly && !full && toggle(value)}
                        className={`flex items-center border-b border-line/70 last:border-b-0 transition-colors ${
                          isSelected ? "bg-brand/5" : full ? "opacity-50" : "hover:bg-content2/60"
                        } ${readOnly || full ? "" : "cursor-pointer"}`}
                      >
                        <div className="w-10 px-3 py-2">
                          <input
                            type="checkbox"
                            checked={selectMode ? isSelected : !isSelected}
                            disabled={readOnly || full}
                            onChange={() => toggle(value)}
                            onClick={(e) => e.stopPropagation()}
                            aria-label={`${selectMode ? "Select" : "Reject"} ${value}`}
                            className="h-4 w-4 accent-current text-brand"
                          />
                        </div>
                        <div className="w-8 px-1 py-2 text-[11px] text-muted tabular">{index + 1}</div>
                        <div className="flex-1 px-3 py-2 truncate">
                          <span className="flex items-center gap-2">
                            <TrackingBadge type={unit?.type ?? trackingType} meta={trackingMeta} size="sm" />
                            <span className="font-mono text-sm font-semibold text-ink" title={value}>{show(value)}</span>
                          </span>
                        </div>
                        <div className="w-24 px-3 py-2 font-mono text-xs text-body truncate">{unit?.batchNo || "—"}</div>
                        <div className="w-24 px-3 py-2 font-mono text-xs text-body truncate">
                          <span className="flex items-center gap-1">
                            <MapPin className="h-3 w-3 shrink-0 text-brand" aria-hidden />
                            {unit?.binCode || "—"}
                          </span>
                        </div>
                      </div>
                    );
                  }}
                </FixedSizeList>
              </div>
            ) : (
              <div className="rounded-xl border border-line/70 overflow-hidden">
                <FixedSizeList
                  height={400}
                  itemCount={visible.length}
                  itemSize={44}
                  width="100%"
                >
                  {({ index, style }) => {
                    const s = visible[index];
                    const isSelected = selected.has(s);
                    const isRejected = !isSelected;
                    return (
                      <label
                        style={style}
                        className={`flex cursor-pointer items-center gap-3 border-b border-line/50 last:border-0 px-3 transition-colors ${
                          selectMode
                            ? isSelected ? "bg-brand/5" : "bg-content1 hover:bg-content2/50"
                            : isRejected ? "bg-bad-bg/40" : "bg-content1 hover:bg-content2/50"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={selectMode ? isSelected : isRejected}
                          disabled={readOnly}
                          onChange={() => toggle(s)}
                          aria-label={`${selectMode ? "Select" : "Reject"} ${s}`}
                          className={`h-4 w-4 shrink-0 accent-current ${selectMode ? "text-brand" : "text-bad"}`}
                        />
                        <span className="w-6 shrink-0 text-[11px] text-muted tabular">{index + 1}</span>
                        <span className="min-w-0 flex flex-col justify-center">
                          <span className="block truncate font-mono text-sm text-ink" title={s}>{show(s)}</span>
                          {(imeiBySerial?.[s] || metaByValue?.[s]) && (
                            <span className="block truncate font-mono text-[11px] text-muted">
                              {[
                                imeiBySerial?.[s] ? `IMEI ${imeiBySerial[s]}` : null,
                                metaByValue?.[s]
                              ].filter(Boolean).join(" · ")}
                            </span>
                          )}
                        </span>
                        <span className={`ml-auto text-[11px] font-semibold uppercase ${selectMode ? (
                          isSelected ? "text-brand" : "text-muted"
                        ) : (
                          isRejected ? "text-bad" : "text-ok"
                        )}`}>
                          {selectMode ? (isSelected ? "Selected" : "Available") : (isRejected ? "Rejected" : "Accepted")}
                        </span>
                      </label>
                    );
                  }}
                </FixedSizeList>
              </div>
            )}

            {/* The pager. Present only for a paged caller, and deliberately BELOW the
              * list: it is where a storekeeper's eye ends up after reading the rows.
              *
              * It states the size of the whole pool, not of the page, because the
              * count is the thing that tells him the short list in front of him is a
              * window and not the whole shelf. Selections made on other pages are
              * still held — that is why the "N / required selected" line above counts
              * the document rather than the page. */}
            {paging && (paging.total > paging.pageSize || paging.page > 1) && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line/70 pt-3 text-sm">
                <span className="text-muted">
                  {(paging.page - 1) * paging.pageSize + 1}
                  –
                  {Math.min(paging.page * paging.pageSize, paging.total)}
                  {" of "}
                  <b className="tabular text-ink">{paging.total}</b> {plural(paging.total)}
                  {paging.loading && <span className="ml-2 text-muted">loading…</span>}
                </span>
                <span className="flex items-center gap-2">
                  <Button
                    variant="subtle"
                    disabled={paging.page <= 1 || !!paging.loading}
                    onClick={() => paging.onPageChange(paging.page - 1)}
                  >
                    Previous
                  </Button>
                  <span className="tabular text-muted">
                    Page {paging.page} of {Math.max(1, Math.ceil(paging.total / paging.pageSize))}
                  </span>
                  <Button
                    variant="subtle"
                    disabled={paging.page >= Math.ceil(paging.total / paging.pageSize) || !!paging.loading}
                    onClick={() => paging.onPageChange(paging.page + 1)}
                  >
                    Next
                  </Button>
                </span>
              </div>
            )}
          </ModalBody>

          <ModalFooter>
            <Button variant="subtle" onClick={onClose}>{readOnly ? "Close" : "Cancel"}</Button>
            {!readOnly && (
              <Button
                onClick={() => {
                  if (selectMode && selected.size !== required) {
                    setError(
                      `This pick is for ${required} ${plural(required)}; ${selected.size} selected.`,
                    );
                    return;
                  }
                  // Select mode hands back the WHOLE selection; reject mode hands
                  // back what is left of the page.
                  //
                  // These are not the same question, and intersecting with
                  // `available` answered the wrong one as soon as the list paged:
                  // `available` is the page on screen, so picking 500 on page 1 and
                  // 500 on page 2 saved only the 500 the reader happened to be
                  // looking at. QC's list is the line's own captured serials and is
                  // never paged, so there the intersection is exactly right — it is
                  // what turns "rejected" into "accepted".
                  //
                  // Deduplicated through a Set rather than `indexOf`: this list runs
                  // to `limits.MAX_SERIALS_PER_LINE` (10,000), where the quadratic
                  // form freezes the tab.
                  onSave(
                    selectMode
                      ? Array.from(new Set(serials))
                      : (available ?? []).filter((s) => selected.has(s)),
                  );
                  onClose();
                }}
              >
                Save
              </Button>
            )}
          </ModalFooter>
        </ModalContent>
      </Modal>
    );
  }

  const remaining = required - serials.length;

  const add = (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    if (serials.includes(value)) {
      setError(`${value} is already on this line.`);
      return;
    }
    if (serials.length >= required) {
      setError(`This line is for ${required}; remove one before adding another.`);
      return;
    }
    setError(null);
    setSerials((s) => [...s, value]);
    setEntry("");
  };

  const parseBulk = (raw: string) =>
    raw
      .split(/[\s,;]+/)
      .map((value) => value.trim())
      .filter(Boolean);

  const addMany = (raw: string) => {
    const incoming = parseBulk(raw);
    if (!incoming.length) return;

    // One pass with a Set, not `indexOf` inside a filter. That was O(n^2): a carton
    // of 10,000 scans — which `limits.MAX_SERIALS_PER_LINE` now allows — is a hundred
    // million comparisons on the main thread, and the tab stops responding for long
    // enough to look like a crash. The first repeat is still the one named.
    const seen = new Set<string>();
    const repeated = incoming.find((value) => {
      if (seen.has(value)) return true;
      seen.add(value);
      return false;
    });
    if (repeated) {
      setError(`${repeated} appears more than once in the pasted list.`);
      return;
    }

    const existing = new Set(serials);
    const duplicate = incoming.find((value) => existing.has(value));
    if (duplicate) {
      setError(`${duplicate} is already on this line.`);
      return;
    }

    if (serials.length + incoming.length > required) {
      setError(`This line is for ${required}; pasted list would capture ${serials.length + incoming.length}.`);
      return;
    }

    setSerials((rows) => [...rows, ...incoming]);
    setBulkEntry("");
    setError(null);
  };

  /**
   * How many captured rows are DRAWN. The line may now hold 10,000
   * (`limits.MAX_SERIALS_PER_LINE`), and each one renders a list item with a delete
   * button — 10,000 of those is tens of thousands of DOM nodes, built on the main
   * thread while a scanner gun is still firing into the box above them.
   *
   * The tail, not the head: a storekeeper watching this list is checking that the
   * scan he just made landed, and that is always at the bottom. The whole set is
   * still captured, still saved, and still counted on the line above — only the
   * drawing is bounded, and "Show all" is one press away for anyone who needs to
   * hunt down a specific row.
   */
  const CAPTURE_WINDOW = 300;
  const captureHidden = showEveryCapture ? 0 : Math.max(0, serials.length - CAPTURE_WINDOW);
  const captureWindow = serials
    .map((value, index) => ({ value, index }))
    .slice(captureHidden);

  // A plain expression, not a useMemo: pick mode returns before this point, and a hook
  // that only runs on one branch breaks the rules of hooks.
  const tone = remaining === 0 ? "text-ok"
    : remaining < 0 ? "text-bad"
      : partial ? "text-muted" : "text-warn";

  const save = () => {
    if (!partial && serials.length !== required) {
      setError(`This line needs exactly ${required} serial numbers; ${serials.length} captured.`);
      return;
    }
    onSave(serials);
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex-col items-start gap-0.5">
          <span className="font-display text-lg font-bold text-ink">Serial numbers</span>
          <span className="text-xs font-normal text-muted">{itemLabel}</span>
        </ModalHeader>

        <ModalBody>
          <ErrorBanner error={error} />

          <div className="mb-3 flex items-center justify-between text-sm">
            <span className="text-muted">
              {serials.length} of {required} captured
              {partial && " · the rest can wait for the GRN"}
            </span>
            <span className={`font-semibold ${tone}`}>
              {remaining > 0 ? `${remaining} to go` : remaining === 0 ? "Complete" : `${-remaining} too many`}
            </span>
          </div>

          {!readOnly && (
            <div className="mb-4 space-y-3">
              <label className="relative block">
                <ScanLine className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <input
                  autoFocus
                  value={entry}
                  onChange={(e) => setEntry(e.target.value)}
                  onPaste={(e) => {
                    const pasted = e.clipboardData.getData("text");
                    if (parseBulk(pasted).length > 1) {
                      e.preventDefault();
                      addMany(pasted);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      add(entry);
                    }
                  }}
                  placeholder={`Scan or type ${article} ${noun}`}
                  aria-label={`${Noun} number`}
                  className="min-h-11 w-full rounded-md border border-line bg-content1 pl-9 pr-3 text-sm text-ink outline-none placeholder:text-muted focus:border-brand"
                />
              </label>

              <div className="rounded-xl border border-line/70 bg-content2/40 p-3">
                <textarea
                  value={bulkEntry}
                  onChange={(e) => setBulkEntry(e.target.value)}
                  placeholder={`Paste ${noun} numbers`}
                  aria-label={`Bulk ${noun} numbers`}
                  rows={4}
                  className="min-h-28 w-full resize-y rounded-md border border-line bg-content1 px-3 py-2 font-mono text-sm text-ink outline-none placeholder:font-sans placeholder:text-muted focus:border-brand"
                />
                <div className="mt-2 flex justify-end">
                  <Button variant="soft" onClick={() => addMany(bulkEntry)}>
                    Add pasted
                  </Button>
                </div>
              </div>
            </div>
          )}

          {serials.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted">Nothing captured yet.</div>
          ) : (
            <ul className="space-y-1.5">
              {captureHidden > 0 && (
                <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-line bg-content2/40 px-3 py-2 text-xs text-muted">
                  <span>
                    Showing the last <b className="tabular text-ink">{CAPTURE_WINDOW}</b> of{" "}
                    <b className="tabular text-ink">{serials.length}</b>. All of them are
                    captured and will be saved.
                  </span>
                  <Button variant="subtle" onClick={() => setShowEveryCapture(true)}>
                    Show all
                  </Button>
                </li>
              )}
              {captureWindow.map(({ value: s, index: i }) => (
                <li
                  key={s}
                  className="flex min-h-11 items-center justify-between gap-2 rounded-lg border border-line/70 bg-content1 px-3"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="w-6 shrink-0 text-[11px] text-muted tabular">{i + 1}</span>
                    <span className="truncate font-mono text-sm text-ink">{s}</span>
                  </span>
                  {!readOnly && (
                    <button
                      type="button"
                      aria-label={`Remove ${s}`}
                      onClick={() => setSerials((rows) => rows.filter((r) => r !== s))}
                      className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:text-bad"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </ModalBody>

        <ModalFooter>
          <Button variant="subtle" onClick={onClose}>{readOnly ? "Close" : "Cancel"}</Button>
          {!readOnly && <Button onClick={save}>Save {noun}s</Button>}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
