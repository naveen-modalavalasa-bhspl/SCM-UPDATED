/**
 * Filter chrome — the ONE place a filter control's look is decided.
 *
 * Every module's filter bar imports these strings rather than writing its own
 * pill. Before this the indents bar, the shared `FilterMenu` and the shared
 * `FilterBar` each had their own idea of what a filter looks like — three
 * radii, three border treatments, three active colours on the same screen.
 * Change a token here and every filter in the app moves together.
 *
 * The shape is HeroUI's bordered combobox — the control on Logistics > Shipments:
 * a 12px box with a 2px border, muted placeholder, chevron right, and the list
 * dropping full-width beneath it. A resting filter is quiet; hovering firms the
 * border; open or holding a value it goes to full ink. Brand is spent on the
 * value, not on the box.
 *
 * Not a component on purpose — these are class strings, so a control keeps its
 * own markup (combobox, disclosure, date pair) and only borrows the dress.
 */

/** Height of every filter control. One number, so a wrapped row still lines up. */
export const FILTER_H = "h-11";

/**
 * The capsule. Carries the border and the fill; whatever sits inside carries
 * the press. Splitting the two is what lets an active filter hold its own ✕
 * without nesting one <button> inside another.
 */
export const FILTER_SHELL = `inline-flex ${FILTER_H} shrink-0 items-center rounded-xl border-2 transition-colors duration-150`;

/** Resting: white box, 2px hairline, muted placeholder. */
export const FILTER_IDLE = "border-line bg-content1 text-muted hover:border-ink/30";
/** Holding a value: the border goes to ink and the label stops being placeholder grey. */
export const FILTER_ON = "border-ink bg-content1 text-ink";
/** Open: the same ink border, so the box and the panel under it read as one control. */
export const FILTER_OPEN = "border-ink bg-content1 text-ink";

/** The pressable area inside the capsule. */
export const FILTER_TRIGGER = "inline-flex h-full min-w-0 items-center gap-2 rounded-[10px] text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/60";

/** The ✕ that drops one filter. Red on hover — it destroys something. */
export const FILTER_CLEAR = "mr-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-bad-bg hover:text-bad focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bad/60";

/** How many values a multi-select is holding. */
export const FILTER_BADGE = "grid h-[18px] min-w-[18px] place-items-center rounded-md bg-brand px-1 text-[10px] font-bold leading-none text-white";

/** The chevron. Rotates when the control is open. */
export const FILTER_CHEVRON = "h-4 w-4 shrink-0 opacity-50 transition-transform duration-150";

/**
 * A native <select> dressed as a capsule. The OS picker is the right control on a
 * phone and it is already accessible, so this borrows the chrome and nothing else —
 * the browser keeps drawing its own arrow.
 */
export const FILTER_SELECT = `${FILTER_H} shrink-0 cursor-pointer rounded-xl border-2 border-line bg-content1 px-3 text-sm font-medium text-ink outline-none transition-colors hover:border-ink/30 focus:border-ink`;

/** A pill that is on or off rather than holding a value — a type, a toggle. */
export const FILTER_TOGGLE = `inline-flex ${FILTER_H} shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl border-2 px-3.5 text-sm font-medium transition-colors`;
export const FILTER_TOGGLE_ON = "border-brand bg-brand text-white shadow-sm";
export const FILTER_TOGGLE_OFF = "border-line bg-content1 text-muted hover:border-ink/30 hover:text-ink";

/** The search / text field that sits beside the filters. */
export const FILTER_FIELD = `${FILTER_H} w-full rounded-xl border-2 border-line bg-content1 text-sm font-medium text-ink outline-none transition-colors placeholder:font-normal placeholder:text-muted [&::-webkit-search-cancel-button]:hidden hover:border-ink/30 focus:border-ink`;

/**
 * The panel a filter opens. Overflow is left to the caller: some panels scroll,
 * some clip. `pop-in` is defined in index.css and respects reduced motion.
 */
export const FILTER_PANEL = "pop-in rounded-xl border border-line bg-content1 shadow-[0_16px_40px_-12px_rgba(14,20,36,0.28),0_2px_8px_rgba(14,20,36,0.06)]";

/** A row inside that panel. */
export const FILTER_ROW = "flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 text-left text-sm font-medium transition-colors";
export const FILTER_ROW_ON = "bg-content2 text-ink";
export const FILTER_ROW_OFF = "text-body hover:bg-content2/70";

/** The rail the whole bar sits on. z-10, never z-20: the app header is sticky
 *  at z-20 and a bar on the same layer scrolls OVER it instead of under. */
export const FILTER_RAIL = "relative z-10 rounded-2xl border border-line/70 bg-content1 p-2.5 shadow-[0_1px_2px_rgba(14,20,36,0.04),0_14px_32px_-20px_rgba(14,20,36,0.35)]";
