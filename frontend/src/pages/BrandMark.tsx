/**
 * What the chain is for.
 *
 * The centre of the ring is the thing all seven stages exist to move: one
 * stocked carton, labelled. It replaced the courier illustration, which was a
 * picture of a person doing supply chain rather than a picture of supply chain,
 * and which could only ever be as sharp as the 226px the source artwork had of
 * him.
 *
 * The LABEL is the point of it. A plain box is a box; a box with a barcode and
 * a QR on its side is stock this system can account for — which is exactly what
 * `warehouse/components/UnitCodeLabels.tsx` prints at putaway, and what every
 * document in the ring quotes. Without it the mark says "goods". With it the
 * mark says "goods we can find".
 *
 * Drawn, not photographed. Every colour is a `--grad-*` stop, so the mark cannot
 * drift from the brand the way a flat export does, it stays sharp at any size or
 * pixel density, and it costs a few hundred bytes instead of ninety kilobytes.
 *
 * Lit from above and to the left, which is what makes three flat quadrilaterals
 * read as one solid: the top face carries the sweep's warm end because it faces
 * the light, the right face its crimson, and the left face falls away into the
 * violet the sweep ends on.
 *
 * The geometry is true 2:1 isometric — half-width 60 against a rhombus
 * half-height of 34 — because a box drawn by eye is the one thing in a brand
 * mark everybody can see is wrong.
 */

const W = 60;    // half-width of the box
const HH = 34;   // half-height of the top rhombus
const D = 72;    // depth of the vertical faces

const TOP = `0,0 ${W},${HH} 0,${HH * 2} ${-W},${HH}`;
const RIGHT = `${W},${HH} 0,${HH * 2} 0,${HH * 2 + D} ${W},${HH + D}`;
const LEFT = `${-W},${HH} 0,${HH * 2} 0,${HH * 2 + D} ${-W},${HH + D}`;

/**
 * Maps a flat 0..100 square onto the right-hand face, so the label can be drawn
 * square and land in perspective.
 *
 * The face's own axes are the two edges leaving its near-bottom corner: across
 * is (W, -HH) and down is (0, D). An SVG matrix IS those two axes plus an
 * origin, in that order — so the transform is the face, not an approximation of
 * it, and a rectangle drawn at 0,0 100x100 fills it exactly.
 */
const FACE = `matrix(${W / 100}, ${-HH / 100}, 0, ${D / 100}, 0, ${HH * 2})`;

/** Code 128 is a two-width symbology; these are bar widths, not data. Fixed
 *  rather than random so the mark is byte-identical on every render. */
const BARS = [2, 1, 1, 3, 1, 2, 1, 1, 2, 3, 1, 1, 2, 1, 3, 1, 1, 2, 2, 1, 3, 1, 1, 2, 1, 1];

function Barcode({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const unit = w / BARS.reduce((a, b) => a + b, 0);
  let cursor = x;
  return (
    <g fill="#1B1020">
      {BARS.map((bw, i) => {
        const bx = cursor;
        cursor += bw * unit;
        // Every other run is the space between bars.
        return i % 2 === 0 ? <rect key={i} x={bx} y={y} width={bw * unit * 0.85} height={h} /> : null;
      })}
    </g>
  );
}

/** A QR at this size cannot carry data anyone could scan, so it carries the
 *  three finder squares that make a QR recognisable and nothing that pretends
 *  to be a payload. */
function QrGlyph({ x, y, s }: { x: number; y: number; s: number }) {
  const m = s / 7;
  const finder = (fx: number, fy: number) => (
    <>
      <rect x={fx} y={fy} width={m * 3} height={m * 3} fill="#1B1020" />
      <rect x={fx + m * 0.75} y={fy + m * 0.75} width={m * 1.5} height={m * 1.5} fill="#FFFFFF" />
    </>
  );
  return (
    <g>
      {finder(x, y)}
      {finder(x + s - m * 3, y)}
      {finder(x, y + s - m * 3)}
      <rect x={x + m * 4} y={y + m * 4} width={m} height={m} fill="#1B1020" />
      <rect x={x + m * 5.5} y={y + m * 5} width={m} height={m} fill="#1B1020" />
      <rect x={x + m * 4.5} y={y + m * 6} width={m} height={m} fill="#1B1020" />
    </g>
  );
}

export function BrandMark({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox={`${-W - 14} -14 ${W * 2 + 28} ${HH * 2 + D + 42}`}
      role="img"
      aria-label="A labelled carton — the stock this chain moves"
    >
      <defs>
        <linearGradient id="bm-top" x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0%" stopColor="var(--grad-1)" />
          <stop offset="100%" stopColor="var(--grad-2)" />
        </linearGradient>
        <linearGradient id="bm-right" x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0%" stopColor="var(--grad-2)" />
          <stop offset="100%" stopColor="var(--grad-3)" />
        </linearGradient>
        <linearGradient id="bm-left" x1="1" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--grad-3)" />
          <stop offset="100%" stopColor="var(--grad-4)" />
        </linearGradient>
        <radialGradient id="bm-shadow">
          <stop offset="0%" stopColor="var(--grad-4)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--grad-4)" stopOpacity="0" />
        </radialGradient>
      </defs>

      <ellipse cx="0" cy={HH * 2 + D + 8} rx={W * 1.15} ry="13" fill="url(#bm-shadow)" />

      <polygon points={LEFT} fill="url(#bm-left)" />
      <polygon points={RIGHT} fill="url(#bm-right)" />
      <polygon points={TOP} fill="url(#bm-top)" />

      {/* The tape closing the lid. Lighter than it was — at this size the old
          weight read as strapping rather than as a seam. */}
      <path
        d={`M ${-W},${HH} L ${W},${HH}`}
        stroke="#FFFFFF" strokeOpacity="0.32" strokeWidth="1.2" strokeLinecap="round"
      />

      {/* One highlight along the lid's leading edge, so the top face reads as
          catching the light rather than as a flat fill. */}
      <path
        d={`M ${-W},${HH} L 0,0 L ${W},${HH}`}
        fill="none" stroke="#FFFFFF" strokeOpacity="0.28" strokeWidth="2" strokeLinejoin="round"
      />

      {/* The shipping label, drawn square and mapped onto the face. */}
      <g transform={FACE}>
        <rect x="13" y="24" width="74" height="62" rx="4" fill="#FFFFFF" fillOpacity="0.95" />
        <Barcode x={20} y={31} w={60} h={19} />
        <QrGlyph x={20} y={56} s={22} />
        {/* Two rules standing in for the code printed under the symbol. Lines,
            not lorem text: invented characters at this size are noise. */}
        <rect x={48} y={58} width={32} height={3.4} rx="1.7" fill="#1B1020" fillOpacity="0.72" />
        <rect x={48} y={65} width={24} height={3.4} rx="1.7" fill="#1B1020" fillOpacity="0.4" />
        <rect x={48} y={72} width={28} height={3.4} rx="1.7" fill="#1B1020" fillOpacity="0.4" />
      </g>
    </svg>
  );
}
