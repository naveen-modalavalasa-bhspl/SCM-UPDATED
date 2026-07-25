import { describe, expect, it } from "vitest";
import { adminApi } from "../api";

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
      "audit", "featureAccess", "getSchedule", "groups", "hcmRoles",
      "notifications", "pageAccess", "roles", "rules", "setFeatureAccess",
      "setPageAccess", "setSchedule", "syncEntity", "syncLog", "syncNow",
      "syncStatus", "users",
    ]);
  });
});
