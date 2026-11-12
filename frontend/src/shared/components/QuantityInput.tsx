import { forwardRef } from "react";
import type { ClipboardEvent, InputHTMLAttributes, KeyboardEvent } from "react";

import { acceptsQuantityEdit, leadingZeroFix, sanitizeQuantityInput } from "../quantity";

export interface QuantityInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "min" | "max" | "step"> {
  /** The text in the box. Kept as a string so "5." and "" can exist while typing. */
  value: string;
  onChange: (raw: string) => void;
  /** Places the unit allows. 0 for a unit counted in whole numbers (UOM "Allows decimal" off). */
  decimals?: number;
  /** Lowest allowed quantity. Exposed on the element; judged by `quantityProblem`. */
  min?: number;
  /** Highest allowed quantity. Exposed on the element; judged by `quantityProblem`. */
  max?: number;
}

/**
 * A quantity box that knows its unit.
 *
 * What the unit cannot hold never reaches the box: letters, "e", "+", "-", a second
 * point, a point at all for a whole-unit unit, and any digit beyond `decimals` are
 * refused as the key is pressed or the text pasted. Minimum and maximum are not
 * keystroke rules — a box that will not take a 6 reads as a broken keyboard — so they
 * are judged by `quantityProblem`, and the server judges them again.
 */
export const QuantityInput = forwardRef<HTMLInputElement, QuantityInputProps>(function QuantityInput(
  { value, onChange, decimals = 3, min = 0, max, onKeyDown, onPaste, onBeforeInput, ...rest }, ref,
) {
  const wholeOnly = decimals <= 0;

  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.length !== 1) return;                       // arrows, Backspace, Tab...
    const el = event.currentTarget;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    if (acceptsQuantityEdit(el.value, start, end, event.key, decimals)) return;
    event.preventDefault();
    // SCM_0156: "." into an empty box was meant as "0." — write that, rather than
    // swallowing the key and leaving the storekeeper wondering why nothing happened.
    const fixed = leadingZeroFix(el.value.slice(0, start) + event.key + el.value.slice(end), decimals);
    if (fixed !== null) onChange(fixed);
  };

  // Covers what a key event cannot: IME, drag-and-drop text, mobile keyboards.
  const beforeInput: NonNullable<InputHTMLAttributes<HTMLInputElement>["onBeforeInput"]> = (event) => {
    onBeforeInput?.(event);
    const native = event.nativeEvent as InputEvent;
    if (typeof native.data !== "string" || native.data === "") return;
    const el = event.currentTarget;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    if (!acceptsQuantityEdit(el.value, start, end, native.data, decimals)) event.preventDefault();
  };

  const paste = (event: ClipboardEvent<HTMLInputElement>) => {
    onPaste?.(event);
    if (event.defaultPrevented) return;
    const el = event.currentTarget;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const pasted = event.clipboardData.getData("text");
    const next = el.value.slice(0, start) + pasted + el.value.slice(end);
    // A paste that does not fit is cleaned, not dropped: "1,000 NOS" becomes "1000".
    event.preventDefault();
    onChange(sanitizeQuantityInput(next, decimals));
  };

  return (
    <input
      ref={ref}
      type="text"
      inputMode={wholeOnly ? "numeric" : "decimal"}
      autoComplete="off"
      data-decimals={decimals}
      data-leading-zero="auto"
      data-min={min}
      data-max={max}
      {...rest}
      value={value}
      onChange={(event) => onChange(sanitizeQuantityInput(event.target.value, decimals))}
      onKeyDown={keyDown}
      onBeforeInput={beforeInput}
      onPaste={paste}
    />
  );
});
