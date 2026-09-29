import { describe, expect, it } from "vitest";
import { MAX_LEVEL, initialQuality, sampleFrame, type QualityState } from "../components/mapQuality";

const run = (state: QualityState, frames: number, cost: number, interval: number | null) => {
  let s = state;
  for (let i = 0; i < frames; i += 1) s = sampleFrame(s, cost, interval);
  return s;
};

describe("the map's quality while moving", () => {
  it("stays sharp on a machine that keeps up", () => {
    expect(run(initialQuality(), 300, 3, 16.7).level).toBe(0);
  });

  it("steps down on an orbit whose frames are slow even though drawMap is cheap", () => {
    // The laptop the old rule missed: 9 ms in drawMap, 30 ms a frame.
    const s = run(initialQuality(), 30, 9, 30);
    expect(s.level).toBeGreaterThan(0);
  });

  it("does not read a drag's pace as the machine's", () => {
    // No interval fed: only drawMap's own cost counts.
    expect(run(initialQuality(), 100, 9, null).level).toBe(0);
  });

  it("ignores a single slow frame", () => {
    let s = run(initialQuality(), 20, 3, 16.7);
    s = sampleFrame(s, 40, 60);
    s = run(s, 20, 3, 16.7);
    expect(s.level).toBe(0);
  });

  it("never goes past the last level", () => {
    expect(run(initialQuality(), 500, 40, 80).level).toBe(MAX_LEVEL);
  });

  it("climbs back when there is time to spare, and waits longer after a relapse", () => {
    let s = run(initialQuality(), 4, 30, 40);
    expect(s.level).toBe(1);
    s = run(s, 45, 2, 15);
    expect(s.level).toBe(0);
    // Straight back over budget: the step up was wrong.
    s = run(s, 4, 30, 40);
    expect(s.level).toBe(1);
    expect(s.patience).toBe(2);
    expect(run(s, 45, 2, 15).level).toBe(1);
    expect(run(s, 90, 2, 15).level).toBe(0);
  });
});
