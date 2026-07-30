import { describe, expect, it } from "vitest";
import type { PendingApproval } from "../types";
import { filterPendingApprovals, rangeWindow } from "../pages/ApprovalsPage";

const approvals: PendingApproval[] = [
  {
    instance_id: 1,
    doc_type: "INDENT",
    doc_id: 42,
    stage_sequence: 1,
    doc_no: "IND-00042",
    summary: "Cotton rolls required",
    requested_by_name: "Asha Rao",
  },
  {
    instance_id: 2,
    doc_type: "INDENT",
    doc_id: 77,
    stage_sequence: 1,
    doc_no: "IND-00077",
    summary: "Lab reagents required",
    requested_by_name: "Dev Kumar",
  },
  {
    instance_id: 3,
    doc_type: "PURCHASE_ORDER",
    doc_id: 88,
    stage_sequence: 1,
    doc_no: "PO-00088",
    summary: "Purchase order approval",
    requested_by_name: "Nisha Rao",
  },
];

const overdue: PendingApproval = {
  instance_id: 4,
  doc_type: "ALLOCATION",
  doc_id: 9,
  stage_sequence: 1,
  doc_no: "ALC-00009",
  summary: "Stock allocation for IND-00042",
  requested_by_name: "Asha Rao",
  due_at: "2020-01-01T00:00:00",
};

describe("filterPendingApprovals", () => {
  it("matches approval rows by document number, summary, requester or id", () => {
    expect(filterPendingApprovals(approvals, { search: "cotton" })).toEqual([approvals[0]]);
    expect(filterPendingApprovals(approvals, { search: "dev" })).toEqual([approvals[1]]);
    expect(filterPendingApprovals(approvals, { search: "77" })).toEqual([approvals[1]]);
  });

  it("returns every approval when search is blank", () => {
    expect(filterPendingApprovals(approvals, { search: "  " })).toEqual(approvals);
    expect(filterPendingApprovals(approvals)).toEqual(approvals);
  });

  /* This screen is the one inbox for everything blocked on this person, and
     /api/workflow/pending is already scoped to them. Hiding a PO here does not
     protect anything — it just loses the approver's own work. */
  it("shows every document type, not only indents", () => {
    expect(filterPendingApprovals(approvals, { search: "purchase" })).toEqual([approvals[2]]);
  });

  it("narrows to one document type", () => {
    expect(filterPendingApprovals(approvals, { docType: "PURCHASE_ORDER" })).toEqual([approvals[2]]);
    expect(filterPendingApprovals(approvals, { docType: "INDENT" }))
      .toEqual([approvals[0], approvals[1]]);
  });

  it("keeps only rows past their due date when asked", () => {
    const all = [...approvals, overdue];
    expect(filterPendingApprovals(all, { overdueOnly: true })).toEqual([overdue]);
    expect(filterPendingApprovals(all, { overdueOnly: false })).toEqual(all);
  });

  it("drops rows with no waiting_since once a window is set", () => {
    expect(filterPendingApprovals(approvals, { window: [0, Infinity] })).toEqual([]);
  });
});

const at = (iso: string) => new Date(iso).getTime();

describe("rangeWindow", () => {
  const now = at("2026-07-30T14:00:00");

  it("is null when no range is chosen", () => {
    expect(rangeWindow("", "", "", now)).toBeNull();
  });

  /* The presets are rolling, not calendar: at 2pm, "last 24 hours" reaches back to
     2pm yesterday, so a row from 9am yesterday is out and 6pm yesterday is in. */
  it("rolls back from now for the presets", () => {
    expect(rangeWindow("24h", "", "", now)).toEqual([at("2026-07-29T14:00:00"), Infinity]);
    expect(rangeWindow("7d", "", "", now)).toEqual([at("2026-07-23T14:00:00"), Infinity]);
    expect(rangeWindow("30d", "", "", now)).toEqual([at("2026-06-30T14:00:00"), Infinity]);
  });

  it("is null for custom until a date is given", () => {
    expect(rangeWindow("custom", "", "", now)).toBeNull();
  });

  /* One custom day must cover that whole day — local midnight to the next, so an
     evening row does not fall out east of Greenwich. */
  it("covers whole calendar days for custom", () => {
    const [from, to] = rangeWindow("custom", "2026-07-15", "2026-07-15", now)!;
    expect(from).toBe(new Date(2026, 6, 15).getTime());
    expect(to).toBe(new Date(2026, 6, 16).getTime());
    expect(at("2026-07-15T23:45:00")).toBeGreaterThanOrEqual(from);
    expect(at("2026-07-15T23:45:00")).toBeLessThan(to);
  });

  it("leaves the open end unbounded when only one date is given", () => {
    expect(rangeWindow("custom", "2026-07-15", "", now)![1]).toBe(Infinity);
    expect(rangeWindow("custom", "", "2026-07-15", now)![0]).toBe(-Infinity);
  });
});

describe("filtering by range", () => {
  const now = at("2026-07-30T14:00:00");
  const dated: PendingApproval[] = [
    { ...approvals[0], waiting_since: "2026-07-30T09:00:00" },   // today
    { ...approvals[1], waiting_since: "2026-07-26T09:00:00" },   // 4 days ago
    { ...approvals[2], waiting_since: "2026-06-20T09:00:00" },   // 40 days ago
  ];

  it("keeps only what falls inside the chosen window", () => {
    const inWindow = (key: Parameters<typeof rangeWindow>[0]) =>
      filterPendingApprovals(dated, { window: rangeWindow(key, "", "", now) });

    expect(inWindow("24h")).toEqual([dated[0]]);
    expect(inWindow("7d")).toEqual([dated[0], dated[1]]);
    expect(inWindow("30d")).toEqual([dated[0], dated[1]]);
    expect(inWindow("")).toEqual(dated);
  });
});
