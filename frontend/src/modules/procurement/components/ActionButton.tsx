import type { ComponentProps } from "react";
import { Button as KitButton, TONE_MINT, TONE_RED } from "@/shared/components";

/**
 * The kit's `<Button>` wearing procurement's pastel tones (2026-09-05).
 *
 * Asked for by the business owner: the same treatment indents got. Every screen in
 * this module imports Button from HERE rather than from the kit, so a tone is
 * decided once by what the button DOES — its variant — instead of being written
 * onto seventy-four call sites and drifting the first time one is copied.
 *
 * `subtle` and `ghost` are deliberately left alone: they are already quiet (white
 * box, brand text) and re-tinting them would remove the one contrast the pastel
 * primaries need to read as the main action on the screen.
 *
 * Nothing else changes — same props, same component, so `variant`, `disabled` and a
 * caller's own `className` all behave exactly as they did.
 */
const TONE: Partial<Record<string, string>> = {
  primary: TONE_MINT,
  secondary: TONE_MINT,
  soft: TONE_MINT,
  danger: TONE_RED,
  dangerSoft: TONE_RED,
};

export function Button({ variant = "primary", className = "", ...rest }: ComponentProps<typeof KitButton>) {
  // A caller that brought its own tone — Approve, Reject, Send for approval — keeps
  // it. Two tones on one button is two `!bg-` rules of equal weight, and which of
  // them wins is stylesheet order, not the order they are written here.
  const tone = className.includes("!bg-") ? "" : TONE[variant] ?? "";
  return <KitButton variant={variant} className={`${className} ${tone}`.trim()} {...rest} />;
}
