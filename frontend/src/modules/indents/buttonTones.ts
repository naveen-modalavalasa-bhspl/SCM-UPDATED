/* Pastel action tones for the indents module (2026-09-05).
 *
 * Asked for by the business owner screen by screen: the same action must wear the
 * same colour wherever it appears, so the tones live here rather than as a hex
 * literal copied onto each button. Each is a fill, its text/icon colour and a
 * 1px border in the saturated version of the same hue — a pastel fill with no
 * edge reads as a disabled control on white.
 *
 * `!` prefixes throughout: HeroUI's own solid/flat variant classes set the same
 * properties, and these have to win without dropping the kit's `<Button>`.
 */

/** Create/edit an indent — New indent, Edit Indent, Create indent. */
export const TONE_MINT = "!bg-[#d8f2e4] !text-[#15774f] !border !border-[#30a46c]";
/** The one commitment on the screen: Submit for approval. Deeper, still pastel. */
export const TONE_DEEP_MINT = "!bg-[#b6e5cd] !text-[#0d5c3c] !border !border-[#1c8a5b]";
/** Destructive — Delete Draft. */
export const TONE_RED = "!bg-[#fdeaea] !text-[#b3261e] !border !border-[#e5484d]";
/** Print/PDF, everywhere in the module. */
export const TONE_YELLOW = "!bg-[#fdf4d3] !text-[#8a6d0b] !border !border-[#d9b40b]";
/** Backing out — Cancel. */
export const TONE_PINK = "!bg-[#fce4ee] !text-[#CC004C] !border !border-[#CC004C]";
/** The BOM pair, matching the PENDING APPROVAL pill. */
export const TONE_AMBER = "!bg-[#fbf1dc] !text-[#b7791f] !border !border-[#d99a0b]";
/** Read-only housekeeping — Mark all read on Alert & Notification. */
export const TONE_BLUE = "!bg-[#e2edfb] !text-[#1b5aa6] !border !border-[#3b82f6]";

/* The notification tab strip's active pill (Unread / Everything) only.
 *
 * `SubNav` paints it with `.bg-brand`, the four-stop Bavya sweep at full
 * strength, which on this screen sat next to a page of pastel rows and shouted.
 * Dimmed to the same sweep in pastel — still the brand's four stops, still a
 * sweep, an eighth of the saturation. Scoped through the strip's own
 * `className` and keyed on `aria-current`, so no other module's SubNav moves.
 */
export const NOTIFICATION_SUBNAV_PASTEL =
  "[&_[aria-current=page]]:!bg-[linear-gradient(90deg,#f8cf9e_0%,#f4b3a6_30%,#eda6c2_65%,#cdbcee_100%)]"
  + " [&_[aria-current=page]]:!text-[#6b1f45]";
