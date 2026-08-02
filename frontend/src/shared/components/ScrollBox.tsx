import type { ReactNode } from "react";

/** Horizontal scroll container for content that cannot become phone-shaped.
 *
 * A 23-role x 90-permission matrix has no card form — collapsing it would destroy
 * the at-a-glance comparison it exists for. So it stays wide and scrolls inside its
 * own box, and the page itself never scrolls sideways. `ResponsiveList` and
 * `LinesEditor` already do this internally; this is the surface for everything else
 * (permission matrix, masters, approval config).
 *
 * The right-edge fade is the affordance: without it a cut-off column reads as a
 * rendering bug rather than as "there is more this way".
 */
export function ScrollBox({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`relative ${className}`}>
      <div className="overflow-x-auto overscroll-x-contain">{children}</div>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-content1 to-transparent md:hidden"
      />
    </div>
  );
}
