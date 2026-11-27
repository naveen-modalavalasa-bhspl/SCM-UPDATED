/** How many options a dropdown DRAWS at once.
 *
 *  Every row is loaded (`fetchAllPages`) and every row is searchable — this only
 *  bounds what is put in the DOM. 983 warehouses drawn as 983 list items is a dropdown
 *  that takes a second to open on a site laptop and freezes on a phone, and nobody
 *  scrolls past the first screenful anyway: they type. */
export const OPTION_DRAW_LIMIT = 100;

export interface OptionWindow<T> {
  /** What to draw: the first matches, with the chosen option always among them. */
  shown: T[];
  /** Matches left undrawn — said on screen, so a cut list never reads as a short one. */
  hidden: number;
  /** Every match, drawn or not. */
  matched: number;
}

/** The slice of an already-filtered option list a dropdown should draw.
 *
 *  The chosen option is kept in view even when it sits past the limit: an edit form
 *  opening on warehouse number 900 must still show warehouse 900 as chosen. */
export function optionWindow<T>(
  matches: T[],
  isChosen: (option: T) => boolean,
  limit = OPTION_DRAW_LIMIT,
): OptionWindow<T> {
  if (matches.length <= limit) return { shown: matches, hidden: 0, matched: matches.length };
  const shown = matches.slice(0, limit);
  if (!shown.some(isChosen)) {
    const chosen = matches.find(isChosen);
    if (chosen) shown.unshift(chosen);
  }
  return { shown, hidden: matches.length - shown.length, matched: matches.length };
}

/** The footer line under a cut list. */
export const moreMatchesLabel = (hidden: number, matched: number) =>
  `Showing ${(matched - hidden).toLocaleString()} of ${matched.toLocaleString()} — keep typing to narrow`;
