import { describe, expect, it } from "vitest";
import { adminApi } from "../api";

describe("admin api", () => {
  it("exposes HCM sync + schedule operations", () => {
    expect(Object.keys(adminApi).sort()).toEqual(
      ["getSchedule", "setSchedule", "syncEntity", "syncLog", "syncNow", "syncStatus"].sort(),
    );
  });
});
