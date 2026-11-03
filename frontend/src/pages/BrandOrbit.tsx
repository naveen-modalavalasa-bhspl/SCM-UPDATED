import {
  Boxes, ClipboardCheck, FileText, ShoppingCart, Truck, Users, Warehouse,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import supplyChainCenter from "@/assets/supply-chain-center.png";
import scmMark from "@/assets/scm-mark.png";
import bavyaLogo from "@/assets/bavya-logo.png";

/**
 * The supply chain, turning.
 *
 * The brand artwork draws the seven stages as a ring around a courier. That ring
 * is the one part of it that wants to MOVE — a chain is a thing in motion — and
 * a flat PNG cannot. So the ring is rebuilt here in vector and the artwork is
 * kept only for its centre.
 *
 * Vector rather than seven crops out of the PNG, and that is the whole reason
 * this file exists: each icon in the source image is about ninety pixels across,
 * so a crop is already soft at 1x and visibly broken on a retina panel. Drawn
 * from `lucide-react` — a dependency the app already carries — every stage is
 * resolution-independent, takes its colour from the brand sweep rather than from
 * baked-in pixels, and costs nothing to download.
 *
 * The centre is `BrandMark` — one stocked carton, drawn. It replaced a cut-out
 * of the artwork's courier, which was a picture of a person doing supply chain
 * rather than a picture of supply chain, and which could never be sharper than
 * the 226 pixels the source had of him.
 *
 * It never turns. Only the world around it does, which is the right way round:
 * the goods are the fixed point the chain moves through.
 *
 * The rotation is one continuous, very slow revolution (a full turn per minute),
 * not an entrance animation that plays once and stops. Every badge counter-turns
 * at the same rate so its icon and its label stay upright and readable through
 * the whole revolution — a label that goes upside down at the bottom of the
 * circle is a toy, not a product. `prefers-reduced-motion` stops it dead.
 */

type Stage = {
  label: string;
  icon: LucideIcon;
  /** Where this stage sits on the brand sweep. The ring runs amber at the top
   *  through orange and crimson to violet, so the sweep that crosses the page
   *  horizontally is the same sweep wrapped into a circle here. */
  color: string;
};

/** Clockwise from the top, in the order the artwork itself reads. */
const STAGES: Stage[] = [
  { label: "Suppliers", icon: Users, color: "var(--grad-1)" },
  { label: "Warehouse", icon: Warehouse, color: "var(--grad-2)" },
  { label: "Logistics", icon: Truck, color: "#E8563F" },
  { label: "Acknowledgement", icon: ClipboardCheck, color: "var(--grad-3)" },
  { label: "Indent", icon: FileText, color: "#A3116B" },
  { label: "Inventory", icon: Boxes, color: "#7A138C" },
  { label: "Procurement", icon: ShoppingCart, color: "var(--grad-4)" },
];

const STEP = 360 / STAGES.length;


export function BrandOrbit({ className = "" }: { className?: string }) {
  return (
    <div
      className={`brand-orbit ${className}`}
      /* One decorative composition. The stage names are read out by the label
         on the image itself, so announcing seven more list items would only
         make a screen reader slower. */
      role="img"
      aria-label="Bavya SCM — indent, procurement, suppliers, warehouse, logistics and acknowledgement, one continuous chain"
    >
      <div className="orbit-frame">
        {/* The track the stages ride, and the arrowheads that say which way the
            chain runs. Rotates with the ring so an arrow always sits between the
            same two stages. */}
        <div className="orbit-track" aria-hidden>
          <svg viewBox="0 0 100 100" className="h-full w-full">
            <defs>
              <linearGradient id="orbit-track-line" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="var(--grad-1)" />
                <stop offset="34%" stopColor="var(--grad-2)" />
                <stop offset="68%" stopColor="var(--grad-3)" />
                <stop offset="100%" stopColor="var(--grad-4)" />
              </linearGradient>
            </defs>
            <circle
              cx="50" cy="50" r="41.5"
              fill="none"
              stroke="url(#orbit-track-line)"
              strokeWidth="0.5"
              strokeDasharray="0.6 3.4"
              strokeLinecap="round"
              opacity="0.75"
            />
          </svg>
        </div>

        <div className="orbit-ring" aria-hidden>
          {STAGES.map((stage, i) => (
            <div key={stage.label} className="orbit-arm" style={{ "--a": `${i * STEP}deg` } as React.CSSProperties}>
              <div className="orbit-fix orbit-pin" style={{ "--a": `${i * STEP}deg` } as React.CSSProperties}>
                <div className="orbit-upright">
                  <span className="orbit-badge" style={{ "--c": stage.color } as React.CSSProperties}>
                    <stage.icon className="h-[42%] w-[42%]" strokeWidth={1.75} />
                  </span>
                  <span className="orbit-label">{stage.label}</span>
                </div>
              </div>
            </div>
          ))}

          {/* Between each pair, on the track itself, pointing the way round. */}
          {STAGES.map((stage, i) => (
            <div
              key={`arrow-${stage.label}`}
              className="orbit-arm orbit-arm--arrow"
              style={{ "--a": `${i * STEP + STEP / 2}deg` } as React.CSSProperties}
              aria-hidden
            >
              <svg className="orbit-arrow" viewBox="0 0 12 12" style={{ color: stage.color }}>
                <path d="M2.6 1.4 L9.6 6 L2.6 10.6 Z" fill="currentColor" />
              </svg>
            </div>
          ))}
        </div>

        {/* What the ring is for, at the centre of it. Never turns. */}
        <div className="orbit-core">
          <img src={supplyChainCenter} alt="Supply Chain" aria-hidden draggable={false}
               className="orbit-core-photo" />
        </div>
      </div>

      {/* The lockup. Below the ring rather than inside it, because a wordmark
          sitting in the middle of a turning circle competes with the one thing
          that is meant to hold still — and because this is the signature on the
          work, which belongs at the foot of it. */}
      <div className="orbit-mark">
        <img src={scmMark} alt="SCM" className="orbit-mark-scm" draggable={false} />
        <p className="orbit-mark-by">
          <span>Powered by</span>
          <img src={bavyaLogo} alt="Bavya" draggable={false} />
        </p>
      </div>

      <style>{ORBIT_CSS}</style>
    </div>
  );
}

const ORBIT_CSS = `
.brand-orbit {
  --o: clamp(20rem, 33vw, 31rem);
  /* The ring has to CLEAR the center artwork:
     a badge reaches inward to (--r minus its own radius), and the core reaches out to
     half of --core. 0.415 against 0.58 leaves a clear, beautiful band between them. */
  --r: calc(var(--o) * 0.415);          /* orbit radius: the badges and the track */
  --core: calc(var(--o) * 0.58);        /* the full supply chain fleet & courier */
  --badge: calc(var(--o) * 0.115);
  --spin: 60s;
  width: var(--o);
  max-width: 100%;
  display: grid;
  place-items: center;
}
.orbit-frame {
  position: relative;
  width: var(--o);
  aspect-ratio: 1;
  display: grid;
  place-items: center;
}
.orbit-track, .orbit-ring {
  position: absolute;
  inset: 0;
  animation: orbit-spin var(--spin) linear infinite;
}
/* A zero-size pivot at the centre, not a full-size box.
   inset: 0 here made each arm as big as the whole frame, and a TRANSFORM still
   counts toward scrollable overflow even though it never affects layout — so
   seven frame-sized boxes flung out to the orbit radius grew the document by
   ~190px and the page scrolled to reveal nothing at all. A point has nothing to
   overflow with; only the badge painted on it does, and that lands inside. */
.orbit-arm {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 0;
  height: 0;
  transform: rotate(var(--a)) translateY(calc(var(--r) * -1));
}
/* Everything hung on a pivot centres itself, because the pivot cannot do it.
   A 0x0 GRID does not centre anything: grid rows auto-size to their content, so
   the row was 70px tall inside a 0px box and place-items:center had nothing to
   work against — every badge start-aligned from the pivot and ended up 26-50px
   inside the track it is meant to sit on, by a different amount per stage
   because the offset is in screen space and the arm angle is not. */
.orbit-pin {
  position: absolute;
  left: 0;
  top: 0;
}
/* Two nested cancellations: the static one undoes this arm's own placement
   angle, the animated one undoes the ring's continuous turn. They have to be
   separate elements — a transform and an animation on the same element do not
   compose, the animation simply wins. */
.orbit-fix { transform: translate(-50%, -50%) rotate(calc(var(--a) * -1)); }
/* Only the badge is in flow here. The label used to be a second row, so the
   stack was 81px tall against a 57px badge and centring the STACK pushed the
   badge 12px off the radius — the track ran through empty space above it. */
.orbit-upright {
  position: relative;
  animation: orbit-spin var(--spin) linear infinite reverse;
}
.orbit-badge {
  display: grid;
  place-items: center;
  width: var(--badge);
  height: var(--badge);
  border-radius: 50%;
  color: var(--c);
  background: #FFFFFF;
  border: 1.5px solid color-mix(in srgb, var(--c) 55%, transparent);
  box-shadow: 0 10px 26px -14px var(--c), 0 1px 2px #1a10281a;
}
.orbit-label {
  position: absolute;
  top: calc(100% + .4rem);
  left: 50%;
  transform: translateX(-50%);
  font-size: clamp(.5rem, .78vw, .6875rem);
  font-weight: 600;
  letter-spacing: .01em;
  color: #4a4056;
  white-space: nowrap;
}
.orbit-arm--arrow { transform: rotate(var(--a)) translateY(calc(var(--r) * -1)); }
.orbit-arrow {
  position: absolute;
  left: 0;
  top: 0;
  transform: translate(-50%, -50%);
  width: clamp(.55rem, .9vw, .78rem);
  height: clamp(.55rem, .9vw, .78rem);
  opacity: .95;
}

/* No disc. The mark stands on the ground at the centre of the ring, and its own
   contact shadow is part of the drawing, so all this has to do is size it. */
.orbit-core {
  position: relative;
  width: var(--core);
  display: grid;
  place-items: center;
  pointer-events: none;
}
.orbit-core svg {
  width: 100%;
  height: auto;
  overflow: visible;
}
/* Used only by the commented-out courier above. Kept here rather than deleted
   so that putting him back is two uncomments and nothing else. */
.orbit-core-photo {
  width: 100%;
  height: auto;
  max-width: none;
  user-select: none;
  filter: drop-shadow(0 18px 26px #4D148C24);
}

.orbit-mark {
  display: grid;
  justify-items: center;
  gap: .85rem;
  margin-top: clamp(.5rem, 2vw, 1.75rem);
  animation: orbit-mark-in .7s ease-out .5s both;
}
.orbit-mark-scm {
  width: clamp(7.5rem, 12vw, 10.5rem);
  height: auto;
}
.orbit-mark-by {
  display: flex;
  align-items: center;
  gap: .5rem;
  font-size: clamp(.5625rem, .72vw, .6875rem);
  font-weight: 600;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: #9a90a8;
}
.orbit-mark-by img {
  height: clamp(.85rem, 1.25vw, 1.05rem);
  width: auto;
}

@keyframes orbit-mark-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

@keyframes orbit-spin { to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
  .orbit-track, .orbit-ring, .orbit-upright { animation: none !important; }
}
`;
