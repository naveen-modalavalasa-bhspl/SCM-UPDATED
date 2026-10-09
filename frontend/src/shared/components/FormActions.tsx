import type { ReactNode } from "react";

/** The action bar at the foot of a document form.
 *
 * On desktop it sits inline where it always has. On a phone it pins above the
 * bottom module nav, because the alternative is what these forms do today: Save,
 * Submit and Post live at the end of a 900-line ConsignmentForm, so acting on a
 * document means scrolling the whole document first.
 *
 * `bottom` clears the nav in `AppLayout` (py-2.5 + a 20px icon + label ~= 3.5rem)
 * plus the device inset. The spacer reserves the same height in the flow so the
 * bar never covers the last field.
 */

const BOTTOM = "bottom-[calc(3.5rem+env(safe-area-inset-bottom))]";

export function FormActions({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <>
      {/* Phone: pinned above the module nav. */}
      <div
        className={`fixed inset-x-0 ${BOTTOM} z-20 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-content1/95 px-4 py-3 backdrop-blur md:hidden ${className}`}
      >
        {children}
      </div>
      <div aria-hidden className="h-20 md:hidden" />

      {/* Desktop: inline, unchanged. */}
      <div className={`hidden flex-wrap items-center justify-end gap-2 md:flex ${className}`}>
        {children}
      </div>
    </>
  );
}
