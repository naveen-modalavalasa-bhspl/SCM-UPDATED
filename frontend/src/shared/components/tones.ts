/* Pastel action tones (2026-09-05). Indents first, procurement on the same set.
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
  "[&_[aria-current=page]]:!bg-none [&_[aria-current=page]]:!bg-[#fdefdc]"
  + " [&_[aria-current=page]]:!text-[#9a5b12]"
  + " [&_[aria-current=page]]:!border [&_[aria-current=page]]:!border-[#e8a34a]";

/* The filter surfaces (2026-09-05). Same pastel orange the shared FILTER_TOGGLE_ON
 * moved to, so a selected preset, a ticked status and an active chip all agree.
 * `.bg-brand` was the four-stop sweep as a background image, which on a 100px
 * preset pill was the whole gradient compressed into a thumbnail. */
export const FILTER_PRESET_ON = "bg-[#fdefdc] text-[#9a5b12] ring-[#e8a34a]";
export const FILTER_TICK_ON = "border-[#e8a34a] bg-[#fdefdc] text-[#9a5b12]";
export const FILTER_APPLY = "border border-[#e8a34a] bg-[#fdefdc] text-[#9a5b12] hover:bg-[#fbe6c8]";

/** The "Ready to acknowledge" quick filter when it is on. */
export const FILTER_PILL_ON = "border-[#e8a34a] bg-[#fdefdc] text-[#9a5b12]";
/** Its count, on and off. */
export const FILTER_PILL_COUNT_ON = "bg-[#f6d9ad] text-[#7d4a0d]";
export const FILTER_PILL_COUNT_OFF = "bg-[#fdefdc] text-[#9a5b12]";

/* The four decision tones, applied module-wide (2026-09-05).
 *
 * One colour per DECISION, not per screen: an approval reads the same in
 * procurement, inventory, logistics, the warehouse and returns, so an approver
 * who signs in four modules a day is not relearning the buttons in each. Approve
 * and Reject are the darker pastels — they are terminal, and must outrank the
 * lighter "send it on" mint sitting beside them.
 *
 * PURELY VISUAL. Every one of these buttons keeps its own <Can> gate, its own
 * disabled rules and its own handler; nothing here decides who may press what.
 */
export const TONE_APPROVE = "!bg-[#b6e5cd] !text-[#0d5c3c] !border !border-[#1c8a5b]";
export const TONE_REJECT = "!bg-[#f7cfcc] !text-[#8f1f18] !border !border-[#cf3b34]";
/** Send/Submit for approval — a handoff, not a decision. */
export const TONE_SUBMIT = TONE_MINT;
/** Backing out, beside one of the above. */
export const TONE_CANCEL = TONE_PINK;
