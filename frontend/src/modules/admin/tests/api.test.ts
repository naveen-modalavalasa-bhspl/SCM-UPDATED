import { describe, expect, it } from "vitest";
import { adminApi, stepPayload } from "../api";
import type { CustomLadderStep } from "../types";

describe("admin api", () => {
  it("exposes HCM sync + schedule operations", () => {
    // Pinned by name rather than by the whole key list, so adding an admin area
    // does not fail a test that is only about HCM sync.
    for (const fn of ["getSchedule", "setSchedule", "syncEntity", "syncLog",
                      "syncNow", "syncStatus"]) {
      expect(typeof adminApi[fn as keyof typeof adminApi]).toBe("function");
    }
  });

  it("exposes every admin area the module has screens for", () => {
    expect(Object.keys(adminApi).sort()).toEqual([
      "appLogs", "approvalPosts", "audit", "customLadders", "docSeries", "flow",
      "getSchedule", "ladders", "notifications",
      "reminders", "rules", "setSchedule", "syncEntity", "syncLog", "syncNow", "syncStatus",
      "workflows",
    ]);
  });
});

describe("approval chain steps", () => {
  // A chain may mix all three kinds — the SCM indent climbs the field reporting line
  // and then hands to two fixed chairs — so the shaping is per step, not per chain.
  const steps: CustomLadderStep[] = [
    { sequence: 1, name: "District Manager", position_role_id: 159,
      position_id: null, post_id: null, holders: [] },
    { sequence: 2, name: "Indent Team", post_id: 2,
      position_id: null, position_role_id: null, holders: [] },
    { sequence: 3, name: "Floor In-charge", position_id: 55153,
      post_id: null, position_role_id: null, holders: [] },
  ];

  it("sends each kind of chair under its own key", () => {
    expect(steps.map(stepPayload)).toEqual([
      { name: "District Manager", position_role_id: 159 },
      { name: "Indent Team", post_id: 2 },
      { name: "Floor In-charge", position_id: 55153 },
    ]);
  });

  it("never sends two kinds at once", () => {
    // The server rejects a step naming none or two of the three, and a 422 on save
    // reads to the admin as "Save did nothing" — so this is the contract.
    for (const payload of steps.map(stepPayload)) {
      const named = ["position_id", "post_id", "position_role_id"]
        .filter((key) => (payload as Record<string, unknown>)[key] != null);
      expect(named).toHaveLength(1);
    }
  });
});
