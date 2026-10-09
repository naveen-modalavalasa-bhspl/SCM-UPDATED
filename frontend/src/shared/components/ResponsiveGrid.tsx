import type { ReactNode } from "react";

/** One stacking rule for the whole app.
 *
 * A three-column grid at 375px gives each cell ~110px, which is not enough for a
 * StatCard's value or a filter's input. `ResponsiveGrid` starts at one column and
 * opens up at `sm`, so every module stacks the same way instead of each screen
 * inventing its own breakpoint. Two columns survive a phone unaided, which is why
 * `cols={2}` is not a special case here and the guard test lets bare `grid-cols-2`
 * through — see `src/shared/tests/mobile-guard.test.ts`.
 *
 * Class strings are written out in full: Tailwind scans source text, so a
 * template-built name like `sm:grid-cols-${n}` is never emitted into the CSS.
 */

const COLS = {
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-2 sm:grid-cols-2 lg:grid-cols-4",
} as const;

export function ResponsiveGrid({
  cols = 2,
  gap = "gap-3",
  className = "",
  children,
}: {
  cols?: 2 | 3 | 4;
  gap?: string;
  className?: string;
  children: ReactNode;
}) {
  return <div className={`grid ${COLS[cols]} ${gap} ${className}`}>{children}</div>;
}
