import type { CSSProperties } from "react";
import scmMark from "@/assets/scm-mark.png";

/* The full-screen wait, shown while /api/auth/me is in flight — the first thing
 * anybody sees on a cold open, and it used to be the word "Loading…" on an empty
 * ground.
 *
 * The mark is drawn as a MASK, not as an <img>: the PNG's own orange belongs to the
 * artwork it was cut from, and masking lets the app's own brand sweep be painted
 * through the letterforms instead. That buys two things at once — the wait is lit
 * with the same gradient as every brand fill in the product (`--brand-gradient`,
 * which re-mixes itself for the dark theme), and a highlight can travel through the
 * letters, which an <img> cannot do without a second copy of the artwork.
 *
 * Everything moves on transform/opacity/background-position only, so the whole
 * screen composites on the GPU and costs nothing on a warehouse tablet, and the
 * whole thing stands still under prefers-reduced-motion. */
export function AppSplash({ label = "Loading" }: { label?: string }) {
  return (
    <div className="splash" role="status" aria-live="polite">
      <div className="splash-aurora" aria-hidden="true" />
      <div className="splash-stack">
        <div
          className="splash-mark"
          style={{ "--splash-mark-src": `url(${scmMark})` } as CSSProperties}
          aria-hidden="true"
        />
        <div className="splash-track" aria-hidden="true">
          <span className="splash-comet" />
        </div>
      </div>
      <span className="sr-only">{label}</span>
    </div>
  );
}
