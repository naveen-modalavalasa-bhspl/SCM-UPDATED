import { describe, expect, it } from "vitest";
import {
  doctypeBadge, fmtWait, indentHit, ladderChipLabel, ladderOrigin, ladderRoute,
  ladderStages, waitingSince,
  type TrackApproval, type TrackJourney,
} from "../liveTrackingModel";

const journey = (overrides: Partial<TrackJourney> = {}): TrackJourney => ({
  indent_id: 1,
  indent_no: "IND-0001",
  status: "PENDING_APPROVAL",
  created_at: "2026-08-01T04:30:00Z",
  current_stage_message: "Waiting for approval",
  stages: [],
  ...overrides,
});

describe("indentHit", () => {
  it("picks the indent out of a mixed result set", () => {
    const hits = [
      { key: "po", id: 2, doc_no: "PO-9", status: null, label: "Purchase Order" },
      { key: "indent", id: 7, doc_no: "IND-7", status: null, label: "Indent" },
    ];
    expect(indentHit(hits)?.id).toBe(7);
  });

  it("answers nothing when no indent matched", () => {
    expect(indentHit([{ key: "grn", id: 1, doc_no: "G-1", status: null, label: "Goods Receipt" }]))
      .toBeUndefined();
  });
});

describe("ladderStages", () => {
  it("keeps the human ladder and drops operational evidence", () => {
    const j = journey({
      stages: [
        { sequence: 1, title: "Draft created", status: "APPROVED", stage_type: "draft" },
        { sequence: 2, title: "Request submitted", status: "SUBMITTED", stage_type: "submission" },
        { sequence: 3, title: "Manager", status: "APPROVED", stage_type: "approval" },
        { sequence: 4, title: "Final", status: "APPROVED", stage_type: "final" },
        { sequence: 5, title: "Stock allocated", status: "COMPLETED", stage_type: "allocation" },
        { sequence: 6, title: "Material issued", status: "COMPLETED", stage_type: "warehouse" },
      ],
    });
    expect(ladderStages(j).map((stage) => stage.title)).toEqual([
      "Draft created", "Request submitted", "Manager", "Final",
    ]);
  });
});

describe("waitingSince", () => {
  it("counts from the last rung that happened", () => {
    const j = journey({
      stages: [
        { sequence: 1, title: "Draft", status: "APPROVED", stage_type: "draft", timestamp: "2026-08-01T05:00:00Z" },
        { sequence: 2, title: "Submitted", status: "SUBMITTED", stage_type: "submission", timestamp: "2026-08-01T06:00:00Z" },
        { sequence: 3, title: "Manager", status: "PENDING", stage_type: "approval" },
      ],
    });
    expect(waitingSince(j)).toBe("2026-08-01T06:00:00Z");
  });

  it("falls back to creation for a document nothing has happened to", () => {
    expect(waitingSince(journey())).toBe("2026-08-01T04:30:00Z");
  });
});

describe("fmtWait", () => {
  it("speaks the way a desk speaks", () => {
    expect(fmtWait(45)).toBe("45s");
    expect(fmtWait(300)).toBe("5m");
    expect(fmtWait(3600 * 3 + 120)).toBe("3h 2m");
    expect(fmtWait(3600 * 24 * 2 + 3600 * 5)).toBe("2d 5h");
  });

  it("says nothing for a leg with no length", () => {
    expect(fmtWait(null)).toBe("—");
    expect(fmtWait(undefined)).toBe("—");
  });
});

describe("doctypeBadge", () => {
  it("wears the short code the backend stamped", () => {
    expect(doctypeBadge({ doctype_code: "IND", label: "Indent" })).toBe("IND");
    expect(doctypeBadge({ doctype_code: "ALL", label: "Stock Allocation" })).toBe("ALL");
    expect(doctypeBadge({ doctype_code: "MR", label: "Material Request" })).toBe("MR");
  });

  it("falls back to the row's label when the backend sent no code", () => {
    expect(doctypeBadge({ doctype_code: null, label: "Indent" })).toBe("Indent");
  });

  it("says nothing rather than inventing a doctype", () => {
    expect(doctypeBadge({})).toBe("—");
  });
});

describe("ladderChipLabel", () => {
  it("speaks with the backend's own wording", () => {
    const approval: TrackApproval = {
      approval_ladder_label: "Approval Ladder v2.1", ladder_name: "Indent ladder",
    };
    expect(ladderChipLabel(approval)).toBe("Approval Ladder v2.1");
  });

  it("falls back to the ladder's name when no label was sent", () => {
    expect(ladderChipLabel({ ladder_name: "Indent ladder" })).toBe("Indent ladder");
  });

  it("is honest about a document that never reached a workflow", () => {
    expect(ladderChipLabel(null)).toBe("No approval ladder");
  });
});

describe("ladderRoute", () => {
  it("opens only where the backend said to", () => {
    expect(ladderRoute({ navigation_route: "/indents/7" })).toBe("/indents/7");
  });

  it("deep-links a project-scoped ladder to that project's approval-flow", () => {
    expect(ladderRoute({
      doctype: "MR", project_id: 104, navigation_route: "/inventory/material-requests/3",
    })).toBe("/admin/approval-flow/MR?project=104");
  });

  it("renders nothing clickable when there is no route", () => {
    expect(ladderRoute({ navigation_route: null })).toBeUndefined();
    expect(ladderRoute(null)).toBeUndefined();
    expect(ladderRoute(undefined)).toBeUndefined();
  });
});

describe("ladderOrigin", () => {
  it("names the project, then the module", () => {
    expect(ladderOrigin({ project: "SCM", module: "Indents" })).toBe("SCM · Indents");
  });

  it("carries whichever of the two arrived", () => {
    expect(ladderOrigin({ project: null, module: "Inventory" })).toBe("Inventory");
    expect(ladderOrigin({ project: "SCM", module: null })).toBe("SCM");
  });

  it("is empty when the document runs no ladder", () => {
    expect(ladderOrigin(null)).toBe("");
  });
});
