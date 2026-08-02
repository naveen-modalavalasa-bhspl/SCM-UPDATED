import { describe, expect, it } from "vitest";

import { approvalsToTimeline } from "../components/Timeline";
import type { ApprovalEvent } from "../types";

/**
 * The Progress panel used to be built from the document's own columns, where
 * `approved_at` is written only when the WHOLE ladder completes. On the live
 * two-rung warehouse ladder that meant rung 1's approval (Mahendra) appeared
 * nowhere while rung 2 (Murali) was still pending — the document looked as if
 * nobody had approved it.
 */

const event = (over: Partial<ApprovalEvent>): ApprovalEvent => ({
  stage_sequence: 1,
  stage_name: "Head SCM and Logistics",
  actor_name: "MAHENDRA",
  action: "APPROVED",
  acted_at: "2026-08-02T14:19:27",
  ...over,
});

describe("approvalsToTimeline", () => {
  it("shows a rung that approved while a later rung is still pending", () => {
    const trail = approvalsToTimeline([
      event({ stage_sequence: 0, stage_name: "Submitted", action: "SUBMITTED",
              actor_name: "Murali krishna" }),
      event({}),
    ]);
    expect(trail).toHaveLength(1);
    expect(trail[0].title).toBe("Head SCM and Logistics approved");
    expect(trail[0].by).toBe("MAHENDRA");
  });

  it("drops SUBMITTED — the screen's own 'Raised' entry already says it", () => {
    expect(approvalsToTimeline([event({ action: "SUBMITTED" })])).toEqual([]);
  });

  it("names the acting position and keeps the comment", () => {
    const [entry] = approvalsToTimeline([
      event({ actor_position: "Head SCM and Logistics", comments: "ok to release" }),
    ]);
    expect(entry.by).toBe("MAHENDRA · Head SCM and Logistics");
    expect(entry.detail).toBeTruthy();
  });

  it("flags a rejection so it cannot read as an approval", () => {
    const [entry] = approvalsToTimeline([event({ action: "REJECTED" })]);
    expect(entry.title).toBe("Head SCM and Logistics rejected");
    expect(entry.tone).toBe("bad");
  });

  it("keeps every rung of a multi-step ladder, in order", () => {
    const trail = approvalsToTimeline([
      event({}),
      event({ stage_sequence: 2, stage_name: "Manager Supply chain management Chief",
              actor_name: "Murali krishna" }),
    ]);
    expect(trail.map((e) => e.by)).toEqual(["MAHENDRA", "Murali krishna"]);
  });
});
