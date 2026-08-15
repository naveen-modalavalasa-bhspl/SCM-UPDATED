import { describe, expect, it } from "vitest";
import { reorder, stepKey, stepKind } from "../components/StepList";
import type { CustomLadderStep } from "../types";

const step = (name: string, over: Partial<CustomLadderStep> = {}): CustomLadderStep => ({
  sequence: 0, name, position_id: null, post_id: null, position_role_id: null,
  holders: [], ...over,
});

const chain: CustomLadderStep[] = [
  step("District Manager", { position_role_id: 159 }),
  step("Indent Team", { post_id: 2 }),
  step("SCM Head", { post_id: 1 }),
];

describe("chain step ordering", () => {
  it("moves a step and resequences everything after it", () => {
    const moved = reorder(chain, 2, 0);
    expect(moved.map((s) => s.name)).toEqual([
      "SCM Head", "District Manager", "Indent Team",
    ]);
    // Sequence is what the server saves as the signing order, so it must follow the
    // list rather than whatever the step arrived with.
    expect(moved.map((s) => s.sequence)).toEqual([1, 2, 3]);
  });

  it("moves a step down without dropping any", () => {
    expect(reorder(chain, 0, 2).map((s) => s.name)).toEqual([
      "Indent Team", "SCM Head", "District Manager",
    ]);
  });

  it("leaves the chain alone for a no-op or an out-of-range drop", () => {
    expect(reorder(chain, 1, 1)).toBe(chain);
    expect(reorder(chain, 0, 9)).toBe(chain);
    expect(reorder(chain, -1, 0)).toBe(chain);
  });
});

describe("step identity", () => {
  it("reads the kind off whichever chair the step names", () => {
    expect(chain.map(stepKind)).toEqual(["rank", "local", "local"]);
    expect(stepKind(step("Floor In-charge", { position_id: 55153 }))).toBe("hcm");
  });

  it("keys a post and a position separately even on the same id", () => {
    // Both are id 2 — without the kind prefix, adding one would grey out the other.
    expect(stepKey(step("a", { post_id: 2 })))
      .not.toEqual(stepKey(step("b", { position_id: 2 })));
  });
});
