/**
 * How much of the base map ApMap3D gives up while the camera moves, learned from how
 * long frames actually take on this machine.
 *
 * Level 0 is sharp and full detail; 1 coarsens the terrain grid; 2 drops the canvas to
 * 75% resolution; 3 to half — the old "blurred while it turns" frame. A still map is
 * always drawn at level 0, whatever was learned.
 *
 * Two measurements, because either alone misses the lag:
 *  - `cost`, the time `drawMap` took. It is all of a drag's frame that we control.
 *  - `interval`, the time between one drawn frame and the next, fed ONLY while the
 *    motion is paced by requestAnimationFrame (orbit, a glide). That is the whole
 *    frame — React, the SVG layer, its filters, the backdrop blurs over a canvas that
 *    changed — and it is the number an orbit's smoothness depends on. Timing drawMap
 *    alone read 9 ms on a laptop taking 30 ms a frame, so it never stepped down. A
 *    drag's interval is the hand's pace, not the machine's, so it is never fed.
 *
 * Decisions are made on smoothed figures and only after several frames agree: one GC
 * pause used to drop a level, twenty quick frames raised it again, and an orbit — which
 * never settles — swung between sharp and soft, reallocating the canvas each time.
 * A step up that has to be taken back soon after makes the next step up wait longer.
 */

export const MAX_LEVEL = 3;
/** ~48 fps: below this an orbit visibly steps. */
export const FRAME_BUDGET_MS = 21;
/** drawMap's share of a 16.7 ms frame; the SVG and the browser need the rest. */
export const COST_BUDGET_MS = 11;
const SLOW_FRAMES = 4;
const FAST_FRAMES = 45;
const MAX_PATIENCE = 16;
/** A step down this soon after a step up means the step up was wrong. */
const RELAPSE_FRAMES = 120;

export interface QualityState {
  level: number;
  cost: number | null;
  interval: number | null;
  slow: number;
  fast: number;
  /** Multiplies FAST_FRAMES; doubles on every relapse. */
  patience: number;
  /** Frames since the last step up, or null if there has not been one. */
  sinceUp: number | null;
}

export function initialQuality(): QualityState {
  return { level: 0, cost: null, interval: null, slow: 0, fast: 0, patience: 1, sinceUp: null };
}

const ema = (prev: number | null, value: number, alpha: number) =>
  prev == null ? value : prev + (value - prev) * alpha;

/** One frame drawn while moving. `interval` is null when the frame was not paced. */
export function sampleFrame(state: QualityState, cost: number, interval: number | null): QualityState {
  const s = { ...state };
  // Each sample is capped at twice its budget, so one pause cannot carry the average
  // over on its own; a machine that is really slow is over on every frame anyway.
  s.cost = ema(s.cost, Math.min(2 * COST_BUDGET_MS, cost), 0.25);
  if (interval != null) s.interval = ema(s.interval, Math.min(2 * FRAME_BUDGET_MS, interval), 0.2);
  if (s.sinceUp != null) s.sinceUp += 1;

  const over = s.cost > COST_BUDGET_MS || (s.interval != null && s.interval > FRAME_BUDGET_MS);
  const under = s.cost < COST_BUDGET_MS * 0.4 && (s.interval == null || s.interval < FRAME_BUDGET_MS * 0.85);

  if (over) {
    s.fast = 0;
    s.slow += 1;
    if (s.slow >= SLOW_FRAMES && s.level < MAX_LEVEL) {
      if (s.sinceUp != null && s.sinceUp < RELAPSE_FRAMES) s.patience = Math.min(MAX_PATIENCE, s.patience * 2);
      s.level += 1;
      s.slow = 0;
      s.sinceUp = null;
      // The averages describe the level just left; start measuring this one afresh.
      s.cost = null;
      s.interval = null;
    }
  } else if (under) {
    s.slow = 0;
    s.fast += 1;
    if (s.fast >= FAST_FRAMES * s.patience && s.level > 0) {
      s.level -= 1;
      s.fast = 0;
      s.sinceUp = 0;
      s.cost = null;
      s.interval = null;
    }
  } else {
    s.slow = 0;
    s.fast = 0;
  }
  return s;
}

/** The canvas resolution a level draws at. */
export function levelRatio(level: number, dpr: number): number {
  if (level >= 3) return Math.max(0.6, dpr * 0.5);
  if (level === 2) return Math.max(0.75, dpr * 0.75);
  return dpr;
}
