import type { Location } from "react-router-dom";

/**
 * Where a return detail screen was opened FROM, carried on the navigation itself.
 *
 * Two things read it and they have to agree, which is why it is one file:
 *
 *  - the back link on the detail screen, so "back" lands on the queue the reader was
 *    working rather than always on All Returns — a decision desk three pages deep into
 *    its backlog was being thrown out of it by the only way back;
 *  - the module tab strip, so the tab that was clicked STAYS lit while its detail screen
 *    is open. `/returns/14` matches no tab's path, so without this nothing is
 *    highlighted and the reader cannot tell which of the eight screens they are in.
 *
 * It travels as react-router navigation state under `navFrom`, which the shared layout
 * reads generically (any module may use the same key). History state survives a reload,
 * so a refreshed detail screen keeps its origin; a deep link from a notification carries
 * none and falls back to the register, which is the honest answer — nothing was clicked.
 */
export const ORIGIN_STATE_KEY = "navFrom";

/** The returns screens a detail can be opened from, longest path first so the lookup
 *  cannot match `/returns` for `/returns/decisions`. Labels are the menu's own
 *  (`page_registry.py`), so the back link names the tab the reader can see. */
const ORIGINS: { path: string; label: string }[] = [
  { path: "/returns/dashboard", label: "Overview" },
  { path: "/returns/approvals", label: "Approvals" },
  { path: "/returns/decisions", label: "Decision Desk" },
  { path: "/returns/sign-off", label: "Sign-off" },
  { path: "/returns/logistics", label: "Return logistics" },
  { path: "/returns/mine", label: "My Returns" },
  { path: "/returns/purchase", label: "Purchase Returns" },
  { path: "/returns", label: "All Returns" },
];

const REGISTER = ORIGINS[ORIGINS.length - 1];

/** The navigation state a list screen hands to a detail screen it opens. */
export function originState(pathname: string) {
  const origin = ORIGINS.find((row) => row.path === pathname);
  return origin ? { [ORIGIN_STATE_KEY]: origin.path } : undefined;
}

/**
 * The screen a detail was opened from — its path and the label to name it by.
 *
 * Anything that is not one of this module's own list screens is ignored rather than
 * trusted: the value comes off history state, which an old entry or another module can
 * also have written, and a back link pointing outside Returns is worse than one that
 * lands on the register.
 */
export function originOf(state: Location["state"]) {
  const value = state && typeof state === "object"
    ? (state as Record<string, unknown>)[ORIGIN_STATE_KEY]
    : undefined;
  return ORIGINS.find((row) => row.path === value) ?? REGISTER;
}
