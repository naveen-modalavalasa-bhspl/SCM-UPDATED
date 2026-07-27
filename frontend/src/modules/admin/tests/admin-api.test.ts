import { describe, expect, it } from "vitest";
import { adminApi } from "../api";

describe("admin api", () => {
  it("exposes the rules engine, including the pre-save conflict check", () => {
    for (const fn of ["vocabulary", "list", "get", "create", "update", "deactivate",
                      "checkConflicts", "simulate", "executions"]) {
      expect(typeof adminApi.rules[fn as keyof typeof adminApi.rules]).toBe("function");
    }
  });

  it("keeps the existing HCM sync surface intact", () => {
    for (const fn of ["syncNow", "syncStatus", "syncEntity", "syncLog",
                      "getSchedule", "setSchedule"]) {
      expect(typeof adminApi[fn as keyof typeof adminApi]).toBe("function");
    }
  });

  it("exposes audit and notification settings", () => {
    expect(typeof adminApi.audit).toBe("function");
    for (const fn of ["list", "create", "update", "remove"]) {
      expect(typeof adminApi.notifications[fn as keyof typeof adminApi.notifications])
        .toBe("function");
    }
  });

  it("exposes document numbering settings", () => {
    for (const fn of ["list", "create", "update", "deactivate"]) {
      expect(typeof adminApi.docSeries[fn as keyof typeof adminApi.docSeries]).toBe("function");
    }
  });
});
