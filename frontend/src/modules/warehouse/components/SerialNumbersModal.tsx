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
}) {
  const [serials, setSerials] = useState<string[]>([]);
  const [entry, setEntry] = useState("");
  const [error, setError] = useState<string | null>(null);

  const picking = available !== null && available !== undefined;

  useEffect(() => {
    if (isOpen) {
      // Pick mode starts with nothing rejected. A line the inspector has not opened yet
      // carries no decision (null), which is not the same as "every unit rejected".
      setSerials(picking && initial == null ? available ?? [] : initial ?? []);
      setEntry("");
      setError(null);
    }
    // `initial` is a fresh array on every render of the parent grid; keying the reset
    // off `isOpen` runs it once per open instead of wiping input on each keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (picking) {
    const accepted = new Set(serials);
    const rejected = (available ?? []).filter((s) => !accepted.has(s));
    const toggle = (serial: string) =>
      setSerials((rows) =>
        rows.includes(serial) ? rows.filter((r) => r !== serial) : [...rows, serial],
      );

    return (
      <Modal isOpen={isOpen} onClose={onClose} size="lg" scrollBehavior="inside">
        <ModalContent>
          <ModalHeader className="flex-col items-start gap-0.5">
            <span className="font-display text-lg font-bold text-ink">Reject serial numbers</span>
            <span className="text-xs font-normal text-muted">{itemLabel}</span>
          </ModalHeader>

          <ModalBody>
            <div className="mb-3 flex items-center justify-between text-sm">
              <span className="text-muted">Tick the units you are rejecting.</span>
              <span className="font-semibold text-ink">
                {accepted.size} accepted · <span className="text-bad">{rejected.length} rejected</span>
              </span>
            </div>

            {(available ?? []).length === 0 ? (
              <div className="py-8 text-center text-sm text-muted">
                No serials were captured on the GRN for this line.
              </div>
            ) : (
              <ul className="space-y-1.5">
                {(available ?? []).map((s, i) => {
                  const isRejected = !accepted.has(s);
                  return (
                    <li key={s}>
                      <label
                        className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 ${
                          isRejected ? "border-bad/50 bg-bad-bg/40" : "border-line/70 bg-content1"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isRejected}
                          disabled={readOnly}
                          onChange={() => toggle(s)}
                          aria-label={`Reject ${s}`}
                          className="h-4 w-4 shrink-0 accent-current text-bad"
                        />
                        <span className="w-6 shrink-0 text-[11px] text-muted tabular">{i + 1}</span>
                        <span className="truncate font-mono text-sm text-ink">{s}</span>
                        <span className={`ml-auto text-[11px] font-semibold uppercase ${
                          isRejected ? "text-bad" : "text-ok"
                        }`}>
                          {isRejected ? "Rejected" : "Accepted"}
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
                  onSave((available ?? []).filter((s) => accepted.has(s)));
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

  const required = Math.floor(quantity);
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

  // A plain expression, not a useMemo: pick mode returns before this point, and a hook
  // that only runs on one branch breaks the rules of hooks.
  const tone = remaining === 0 ? "text-ok" : remaining < 0 ? "text-bad" : "text-warn";

  const save = () => {
    // Capturing fewer than the line holds is allowed: putaway reads the serial of every
    // unit it places, so this is a head start, not the record of account.
    if (serials.length > required) {
      setError(`This line is for ${required} — ${serials.length} captured.`);
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
            <label className="relative mb-4 block">
              <ScanLine className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <input
                autoFocus
                value={entry}
                onChange={(e) => setEntry(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add(entry);
                  }
                }}
                placeholder="Scan or type a serial, then press Enter"
                aria-label="Serial number"
                className="min-h-11 w-full rounded-md border border-line bg-content1 pl-9 pr-3 text-sm text-ink outline-none placeholder:text-muted focus:border-brand"
              />
            </label>
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
