import { useState, type KeyboardEvent, type WheelEvent } from "react";
import { PackageSearch, Plus, Trash2 } from "lucide-react";
import { Field, Input } from "@/shared/components";
import { ItemCombobox } from "@/modules/indents/components/ItemCombobox";
import type { MyStockRow, ReturnLineWrite } from "../types";

/**
 * The LINE ITEMS card — the same Item / Qty / delete row the indent form uses, and the
 * same combobox control, so the two screens are one screen with different data behind
 * them. `ItemCombobox` is imported rather than copied: returns sits after indents in
 * the import chain (CLAUDE.md rule 5), so this direction is allowed, and a copy would
 * be the thing that eventually looks different.
 *
 * The picker only ever offers what the raiser is actually holding, summed per item
 * across bins and batches. A storekeeper does not think in balance slices — they think
 * "I have 50 of these" — and the backend walks the lots itself at approval.
 */
export const BLANK_LINE: ReturnLineWrite = { item_id: 0, quantity: "", remarks: "" };

const num = (value: string | number | null | undefined) => Number(value ?? 0);

/**
 * Hides the browser's native number spinner, exactly as the indent form does. It stays
 * `type="number"` — only the arrows go; stepping 0.001 at a time was never a useful way
 * to enter a quantity.
 */
const NO_SPINNER = "[&_input]:[appearance:textfield] "
  + "[&_input::-webkit-outer-spin-button]:m-0 [&_input::-webkit-outer-spin-button]:appearance-none "
  + "[&_input::-webkit-inner-spin-button]:m-0 [&_input::-webkit-inner-spin-button]:appearance-none";

/**
 * Hiding the arrows does not stop a `type="number"` field from stepping: the mouse wheel
 * and the up/down keys still move it, one whole `step` at a time, with nothing on screen
 * to say it happened. Scrolling the page with the cursor resting on a focused Qty box is
 * enough to walk a quantity away from what was typed — which is how quantities nobody
 * entered reached the indent table before the same guard was added there. The wheel blurs
 * the field so the page scrolls instead, and the arrows do nothing.
 */
const NO_SILENT_STEPPING = {
  onWheel: (event: WheelEvent<HTMLInputElement>) => event.currentTarget.blur(),
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") event.preventDefault();
  },
};

/**
 * UoMs that cannot be split. Half a box is not a thing anybody can put on a shelf, so
 * the quantity box steps in whole units and refuses a decimal outright rather than
 * accepting 2.5 and letting the backend round it to something the returner never typed.
 */
const WHOLE_UNIT_UOMS = new Set([
  "NOS", "NO", "NUM", "EA", "EACH", "PCS", "PC", "PIECE", "UNIT", "UNITS",
  "PACK", "PKT", "PACKET", "BOX", "BOXES", "CTN", "CARTON", "BAG", "BAGS",
  "BTL", "BOTTLE", "TUBE", "VIAL", "AMP", "STRIP", "ROLL", "SET", "PAIR", "DOZ",
]);

export function isWholeUnit(uom: string | null | undefined) {
  return WHOLE_UNIT_UOMS.has(String(uom ?? "").trim().toUpperCase());
}

export function holdingFor(stock: MyStockRow[], itemId: number) {
  const rows = stock.filter((row) => row.item_id === itemId);
  if (rows.length === 0) return null;
  return {
    quantity: rows.reduce((running, row) => running + num(row.available_qty), 0),
    uom: rows[0].uom_code ?? "",
  };
}

export function ReturnLinesEditor({
  lines,
  onChange,
  stock,
  disabled = false,
  lockedNote = null,
}: {
  lines: ReturnLineWrite[];
  onChange: (lines: ReturnLineWrite[]) => void;
  stock: MyStockRow[];
  disabled?: boolean;
  /**
   * Why the picker has nothing in it, said out loud. The form scopes the shelf to the
   * chosen indent, so before one is picked the option list is legitimately empty — and
   * an empty combobox with no explanation reads as "we are holding nothing", which is a
   * different and much more alarming statement.
   *
   * Set, the editor draws this sentence IN PLACE OF the rows (see the early return
   * below) rather than beneath a greyed-out copy of them.
   */
  lockedNote?: string | null;
}) {
  // Which line last tried to pick an item that was already taken. Cleared on the next
  // successful pick, so the warning does not outlive the mistake.
  const [warnedAt, setWarnedAt] = useState<number | null>(null);
  const setDuplicateWarning = (index: number) => setWarnedAt(index);

  const options = Array.from(
    new Map(
      stock.map((row) => [
        row.item_id,
        {
          value: row.item_id,
          label: `${row.item_name ?? "—"}${row.item_code ? ` (${row.item_code})` : ""}`,
        },
      ]),
    ).values(),
  );

  const patch = (index: number, changes: Partial<ReturnLineWrite>) =>
    onChange(lines.map((line, at) => (at === index ? { ...line, ...changes } : line)));

  /** Items already on another line — offered greyed out rather than hidden, so the
   * returner can see the item exists and understand why it cannot be picked twice. */
  const takenElsewhere = (index: number) =>
    new Set(
      lines
        .filter((line, at) => at !== index && line.item_id)
        .map((line) => line.item_id),
    );

  const remove = (index: number) =>
    // Never down to zero rows: an empty card gives the raiser nothing to type into and
    // no obvious way back, so the last line is emptied instead of dropped.
    onChange(lines.length > 1 ? lines.filter((_line, at) => at !== index) : [{ ...BLANK_LINE }]);

  /**
   * Nothing can be picked yet, drawn as a statement rather than as a row of dead
   * controls.
   *
   * REDRAWN 2026-09-07. The locked state used to render the real Item and Qty boxes
   * greyed out with the explanation as an 11px grey line beneath them — so the widest
   * card on the page opened as a switched-off form, which reads as "this screen is
   * broken" far more readily than as "answer the question above first". A form that is
   * waiting on something should say what it is waiting for and offer nothing to press.
   *
   * `lockedNote` only. A return that has simply left the raiser (`disabled` with no
   * note) still draws its lines: they are the document, and the reader is here to read
   * them.
   */
  if (lockedNote) {
    return (
      <div className="grid place-items-center rounded-xl border border-dashed border-line bg-content2/60 px-4 py-8 text-center">
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-brand-050 text-brand">
          <PackageSearch className="h-5 w-5" />
        </span>
        <p className="mt-3 max-w-md text-sm font-medium text-body">{lockedNote}</p>
      </div>
    );
  }

  return (
    <div>
      {/* The indent form's own row: Item / Qty labelled on the first line only, the same
        * 1fr / 120px / 44px columns, the same 44px delete target at the end. The labels
        * moved off a separate uppercase header strip and onto the fields themselves, which
        * is where the indent puts them — the words are unchanged. */}
      <ul className="space-y-3">
        {lines.map((line, index) => {
          const holding = line.item_id ? holdingFor(stock, line.item_id) : null;
          const wanted = num(line.quantity);
          const over = holding !== null && wanted > holding.quantity;
          const taken = takenElsewhere(index);
          const duplicate = Boolean(line.item_id) && taken.has(line.item_id);
          const whole = isWholeUnit(holding?.uom);
          const fractional = whole && Number.isFinite(wanted) && !Number.isInteger(wanted);

          return (
            <li key={index} className="grid gap-3 sm:grid-cols-[1fr_120px_44px]">
              <div>
                <Field label={index === 0 ? "Item" : ""}>
                  <ItemCombobox
                    value={line.item_id || ""}
                    onChange={(value) => patch(index, { item_id: Number(value) || 0 })}
                    options={options.map((option) => ({
                      ...option,
                      isDisabled: taken.has(option.value),
                    }))}
                    onDisabledSelect={() => setDuplicateWarning(index)}
                    isInvalid={duplicate}
                    isDisabled={disabled}
                    placeholder="Type item code or name…"
                  />
                </Field>
                {duplicate || warnedAt === index ? (
                  <p className="mt-1 text-xs text-bad">
                    That item is already on another line — change the quantity there
                    instead.
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-muted">
                    {holding
                      ? `You are holding ${holding.quantity.toLocaleString()} ${holding.uom}`.trim()
                      : "Pick an item to see what you are holding"}
                  </p>
                )}
              </div>

              <div>
                <Field label={index === 0 ? "Qty" : ""}>
                  <Input
                    type="number"
                    min="0"
                    // The shelf quantity is the ceiling: the browser's own number input
                    // then refuses the spinner past it, before any typing is validated.
                    max={holding ? String(holding.quantity) : undefined}
                    step={whole ? "1" : "0.001"}
                    className={NO_SPINNER}
                    value={line.quantity}
                    onChange={(event) => {
                      const typed = event.target.value;
                      // A whole-unit item never accepts a separator at all, so the field
                      // cannot even hold "2." on the way to "2.5".
                      if (whole && /[.,]/.test(typed)) return;
                      patch(index, { quantity: typed });
                    }}
                    {...NO_SILENT_STEPPING}
                    disabled={disabled}
                    isInvalid={over || fractional || wanted < 0}
                    placeholder="—"
                    aria-label={`Quantity for line ${index + 1}`}
                  />
                </Field>
                {over && holding && (
                  <p className="mt-1 text-xs text-bad">
                    Only {holding.quantity.toLocaleString()} {holding.uom} is on the shelf
                  </p>
                )}
                {!over && fractional && (
                  <p className="mt-1 text-xs text-bad">
                    {holding?.uom} comes in whole units
                  </p>
                )}
                {!over && !fractional && wanted < 0 && (
                  <p className="mt-1 text-xs text-bad">Quantity cannot be negative</p>
                )}
              </div>

              {!disabled && (
                <button
                  type="button"
                  onClick={() => remove(index)}
                  aria-label={`Remove line ${index + 1}`}
                  // Sits level with the boxes, not with the first row's label above them.
                  className={`grid h-11 w-11 place-items-center rounded-xl text-muted transition-colors hover:bg-bad-bg hover:text-bad ${
                    index === 0 ? "sm:mt-6.5" : ""
                  }`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {!disabled && (
        <button
          type="button"
          onClick={() => onChange([...lines, { ...BLANK_LINE }])}
          className="mt-3 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-brand hover:text-brand-600"
        >
          <Plus className="h-4 w-4" /> Add line
        </button>
      )}
    </div>
  );
}
