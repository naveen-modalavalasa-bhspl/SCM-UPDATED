import { useEffect, useState } from "react";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
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
}) {
  const [serials, setSerials] = useState<string[]>([]);
  // "a serial" but "an IMEI": the article follows the sound, not the spelling.
  const article = /^[aeiou]/i.test(noun) ? "an" : "a";
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  const [entry, setEntry] = useState("");
  const [bulkEntry, setBulkEntry] = useState("");
  const [error, setError] = useState<string | null>(null);

  const picking = available !== null && available !== undefined;

  useEffect(() => {
    if (isOpen) {
      // Pick mode starts with nothing rejected. A line the inspector has not opened yet
      // carries no decision (null), which is not the same as "every unit rejected".
      setSerials(picking && initial == null ? available ?? [] : initial ?? []);
      setEntry("");
      setBulkEntry("");
      setError(null);
    }
    // `initial` is a fresh array on every render of the parent grid; keying the reset
    // off `isOpen` runs it once per open instead of wiping input on each keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

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
    const visible = (available ?? []).filter((s) =>
      needle ? aliases(s).some((token) => token.toLowerCase().includes(needle)) : true,
    );
    const rejected = (available ?? []).filter((s) => !selected.has(s));
    const toggle = (serial: string) =>
      setSerials((rows) =>
        rows.includes(serial) ? rows.filter((r) => r !== serial) : [...rows, serial],
      );
    const selectMode = pickMode === "select";
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

    /**
     * Tick the whole list in one press.
     *
     * Issuing 200 handsets off a bin meant 200 individual clicks, or 200 scans, for a
     * decision the storekeeper had already made — the units are all in the same bin and
     * the line is for all of them. Bounded by the SAME ceiling a scan is: never more
     * than the line asks for, so it fills the remaining slots and stops.
     *
     * It follows the search box. With a filter typed, "all" means the units on screen,
     * which is how a storekeeper picks one batch out of a mixed bin; clearing the search
     * offers the rest. Already-selected units are left alone rather than re-added.
     */
    const addable = visible.filter((s) => !selected.has(s));
    const room = required - selected.size;
    const willAdd = Math.max(0, Math.min(room, addable.length));
    const selectAll = () => {
      if (willAdd <= 0) return;
      setError(null);
      setSerials((rows) => [...rows, ...addable.slice(0, willAdd)]);
    };
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
      const hit =
        rows.find((s) => same(s, value))
        ?? rows.find((s) => aliases(s).some((token) => same(token, value)));
      setEntry("");
      if (!hit) {
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
          <ModalHeader className="flex-col items-start gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-display text-lg font-bold text-ink">
                {selectMode
                  ? `Assign ${plural(2)}`
                  : "Reject serial numbers"}
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
                  ? trackingMeta?.hint ?? `Select exactly ${required} ${plural(required)}.`
                  : "Tick the units you are rejecting."}
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
                {/* `disabled`, not `isDisabled`: the shared Button forwards only the
                  * former (see shared/components/ui.tsx), so the latter would be
                  * dropped and the button would stay pressable at the ceiling. */}
                <Button
                  variant="subtle"
                  disabled={selected.size === 0}
                  onClick={clearAll}
                >
                  Clear
                </Button>
                {willAdd <= 0 && selected.size >= required && (
                  <span className="text-xs text-muted">
                    This pick is full at {required}.
                  </span>
                )}
              </div>
            )}

            {(available ?? []).length === 0 ? (
              <div className="py-8 text-center text-sm text-muted">
                {selectMode
                  ? `No ${plural(2)} are available in this batch and location.`
                  : "No serials were captured on the GRN for this line."}
              </div>
            ) : visible.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted">
                Nothing here matches the search.
              </div>
            ) : typed ? (
              /* The columned picker. One row per unit, and the TYPE is stated in its
               * own column rather than left to be inferred from the shape of the
               * string — an IMEI and an asset tag are indistinguishable by eye. The
               * batch and bin repeat down every row on purpose: they are what the
               * list is scoped to, so a row that somehow carries a different one is
               * visible instead of silent. */
              <div className="overflow-x-auto rounded-xl border border-line/70">
                <table className="w-full min-w-[620px] border-collapse text-sm">
                  <thead className="bg-content2">
                    <tr>
                      <th className="w-10 px-3 py-2" aria-label="Selected" />
                      <th className="w-8 px-1 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">#</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                        {trackingMeta?.label ?? "Identifier"}
                      </th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                        Also on this unit
                      </th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">Batch</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">Location</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((value, i) => {
                      const unit = unitByValue?.[value];
                      const isSelected = selected.has(value);
                      // Full at the ceiling: an unticked row that cannot be ticked
                      // says so by going quiet, rather than by refusing the click
                      // with an error the storekeeper has to read.
                      const full = selectMode && !isSelected && selected.size >= required;
                      return (
                        <tr
                          key={value}
                          onClick={() => !readOnly && !full && toggle(value)}
                          className={`border-t border-line/70 ${
                            isSelected ? "bg-brand/5" : full ? "opacity-50" : "hover:bg-content2/60"
                          } ${readOnly || full ? "" : "cursor-pointer"}`}
                        >
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              checked={selectMode ? isSelected : !isSelected}
                              disabled={readOnly || full}
                              onChange={() => toggle(value)}
                              onClick={(e) => e.stopPropagation()}
                              aria-label={`${selectMode ? "Select" : "Reject"} ${value}`}
                              className="h-4 w-4 accent-current text-brand"
                            />
                          </td>
                          <td className="px-1 py-2 text-[11px] text-muted tabular">{i + 1}</td>
                          <td className="px-3 py-2">
                            <span className="flex items-center gap-2">
                              <TrackingBadge type={unit?.type ?? trackingType} meta={trackingMeta} size="sm" />
                              <span className="font-mono text-sm font-semibold text-ink">{value}</span>
                            </span>
                          </td>
                          <td className="px-3 py-2 font-mono text-[11px] leading-4 text-muted">
                            {[
                              unit?.serial && unit.serial !== value ? `SN ${unit.serial}` : null,
                              unit?.imei && unit.imei !== value ? `IMEI ${unit.imei}` : null,
                              unit?.code && unit.code !== value ? `Code ${unit.code}` : null,
                            ].filter(Boolean).join("  ·  ") || "—"}
                          </td>
                          <td className="px-3 py-2 font-mono text-xs text-body">{unit?.batchNo || "—"}</td>
                          <td className="px-3 py-2 font-mono text-xs text-body">
                            <span className="flex items-center gap-1">
                              <MapPin className="h-3 w-3 shrink-0 text-brand" aria-hidden />
                              {unit?.binCode || "—"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <ul className="space-y-1.5">
                {visible.map((s, i) => {
                  const isSelected = selected.has(s);
                  const isRejected = !isSelected;
                  return (
                    <li key={s}>
                      <label
                        className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 ${
                          selectMode
                            ? isSelected ? "border-brand/50 bg-brand/5" : "border-line/70 bg-content1"
                            : isRejected ? "border-bad/50 bg-bad-bg/40" : "border-line/70 bg-content1"
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
                        <span className="w-6 shrink-0 text-[11px] text-muted tabular">{i + 1}</span>
                        <span className="min-w-0">
                          <span className="block truncate font-mono text-sm text-ink">{s}</span>
                          {imeiBySerial?.[s] && (
                            <span className="block truncate font-mono text-[11px] text-muted">
                              IMEI {imeiBySerial[s]}
                            </span>
                          )}
                          {metaByValue?.[s] && (
                            <span className="block truncate font-mono text-[11px] text-muted">
                              {metaByValue[s]}
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
                    </li>
                  );
                })}
              </ul>
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
                  onSave((available ?? []).filter((s) => selected.has(s)));
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

    const duplicatesInPaste = incoming.filter((value, index) => incoming.indexOf(value) !== index);
    if (duplicatesInPaste.length) {
      setError(`${duplicatesInPaste[0]} appears more than once in the pasted list.`);
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
              {serials.map((s, i) => (
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