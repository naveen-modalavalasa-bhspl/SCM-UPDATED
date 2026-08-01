import { useEffect, useState } from "react";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { ScanLine, Trash2 } from "lucide-react";
import { Button } from "@/shared/components";
import { ErrorBanner } from "@/shared/components";

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
  available = null,
  pickMode = "reject",
}: {
  isOpen: boolean;
  onClose: () => void;
  /** The serials this line is keeping. In pick mode, everything not ticked. */
  onSave: (serials: string[]) => void;
  initial?: string[] | null;
  /** How many serials the line requires. Ignored in pick mode. */
  quantity: number;
  itemLabel: string;
  readOnly?: boolean;
  /** The GRN's serials for this line. Present = pick mode, absent = type them. */
  available?: string[] | null;
  /** `reject` is QC semantics; `select` is used when issuing stock from a bin. */
  pickMode?: "reject" | "select";
}) {
  const [serials, setSerials] = useState<string[]>([]);
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
    const visible = (available ?? []).filter((s) =>
      entry.trim() ? s.toLowerCase().includes(entry.trim().toLowerCase()) : true,
    );
    const rejected = (available ?? []).filter((s) => !selected.has(s));
    const toggle = (serial: string) =>
      setSerials((rows) =>
        rows.includes(serial) ? rows.filter((r) => r !== serial) : [...rows, serial],
      );
    const scanOrSearch = () => {
      const value = entry.trim();
      if (!value) return;
      const exact = (available ?? []).find((s) => s.toLowerCase() === value.toLowerCase());
      if (exact) {
        if (!selected.has(exact)) toggle(exact);
        setEntry("");
        setError(null);
      }
    };
    const selectMode = pickMode === "select";

    return (
      <Modal isOpen={isOpen} onClose={onClose} size="lg" scrollBehavior="inside">
        <ModalContent>
          <ModalHeader className="flex-col items-start gap-0.5">
            <span className="font-display text-lg font-bold text-ink">
              {selectMode ? "Select serial numbers" : "Reject serial numbers"}
            </span>
            <span className="text-xs font-normal text-muted">{itemLabel}</span>
          </ModalHeader>

          <ModalBody>
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
                  placeholder={selectMode ? "Search or scan an available serial" : "Search serials"}
                  aria-label="Search serial numbers"
                  className="min-h-11 w-full rounded-md border border-line bg-content1 pl-9 pr-3 text-sm text-ink outline-none placeholder:text-muted focus:border-brand"
                />
              </label>
            )}
            <ErrorBanner error={error} />

            <div className="mb-3 flex items-center justify-between text-sm">
              <span className="text-muted">
                {selectMode ? "Tick the units being issued." : "Tick the units you are rejecting."}
              </span>
              <span className="font-semibold text-ink">
                {selectMode ? (
                  <>{selected.size} selected</>
                ) : (
                  <>{selected.size} accepted · <span className="text-bad">{rejected.length} rejected</span></>
                )}
              </span>
            </div>

            {(available ?? []).length === 0 ? (
              <div className="py-8 text-center text-sm text-muted">
                {selectMode ? "No available serials found for this item, batch and bin." : "No serials were captured on the GRN for this line."}
              </div>
            ) : visible.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted">
                No serials match the search.
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
                        <span className="truncate font-mono text-sm text-ink">{s}</span>
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
                    setError(`Select exactly ${required} serial numbers; ${selected.size} selected.`);
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
  const tone = remaining === 0 ? "text-ok" : remaining < 0 ? "text-bad" : "text-warn";

  const save = () => {
    if (serials.length !== required) {
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
            <span className="text-muted">{serials.length} of {required} captured</span>
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
                  placeholder="Scan or type a serial"
                  aria-label="Serial number"
                  className="min-h-11 w-full rounded-md border border-line bg-content1 pl-9 pr-3 text-sm text-ink outline-none placeholder:text-muted focus:border-brand"
                />
              </label>

              <div className="rounded-xl border border-line/70 bg-content2/40 p-3">
                <textarea
                  value={bulkEntry}
                  onChange={(e) => setBulkEntry(e.target.value)}
                  placeholder="Paste serial numbers"
                  aria-label="Bulk serial numbers"
                  rows={4}
                  className="min-h-28 w-full resize-y rounded-md border border-line bg-content1 px-3 py-2 font-mono text-sm text-ink outline-none placeholder:font-sans placeholder:text-muted focus:border-brand"
                />
                <div className="mt-2 flex justify-end">
                  <Button variant="subtle" onClick={() => addMany(bulkEntry)}>
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
          {!readOnly && <Button onClick={save}>Save serials</Button>}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
