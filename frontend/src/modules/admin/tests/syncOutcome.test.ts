import { describe, expect, it } from "vitest";
import { syncOutcome } from "../syncOutcome";
import type { SyncResult } from "../types";

const started = Date.parse("2026-11-16T10:00:00Z");
const row = (over: Partial<SyncResult>): SyncResult => ({
  entity: "offices", status: "SUCCESS", records_fetched: 10, records_upserted: 10,
  source: "HCM", started_at: "2026-11-16T10:00:01", finished_at: "2026-11-16T10:00:02",
  ...over,
});

describe("syncOutcome (SCM_0197)", () => {
  it("is green when every entity of this run synced", () => {
    const out = syncOutcome([row({}), row({ entity: "employees", records_upserted: 5 })], started);
    expect(out?.tone).toBe("success");
    expect(out?.detail).toContain("15 records across 2 lists");
  });

  it("is red only when an entity actually failed", () => {
    const out = syncOutcome([row({ status: "FAILED", error_message: "HCM refused the key" })],
      started, { offices: "Offices" });
    expect(out).toMatchObject({ tone: "error", title: "Sync failed for Offices" });
    expect(out?.detail).toBe("HCM refused the key");
  });

  it("is amber, not red, when HCM synced but a follow-up failed", () => {
    const out = syncOutcome([
      row({}),
      row({ entity: "sync_after_hcm", source: "HOOK", status: "FAILED",
            error_message: "Could not reach the organisation feed" }),
    ], started);
    expect(out?.tone).toBe("warning");
    expect(out?.detail).toContain("Organisation directory: Could not reach the organisation feed");
  });

  it("ignores rows from an earlier run and waits while one is running", () => {
    expect(syncOutcome([row({ status: "FAILED", started_at: "2026-11-15T09:00:00" })], started))
      .toBeNull();
    expect(syncOutcome([row({ status: "RUNNING" })], started)).toBeNull();
  });
});
