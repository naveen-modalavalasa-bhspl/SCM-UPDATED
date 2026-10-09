import { expect, test } from "@playwright/test";
import { Api, duplicatesBy, reader } from "./helpers.js";

/**
 * One indent produces ONE of each downstream document.
 *
 * Live data on 2026-08-05 broke this four ways over: IND/2026-27/00189 carried
 * three material issues (two stranded in PENDING_APPROVAL), IND/2026-27/00013
 * carried four APPROVED allocations, IND/2026-27/00142 carried three completed
 * fulfilments.
 *
 * A cancelled or rejected document is a legitimate re-raise after a mistake, so
 * it is excluded. The rule under test is that no indent holds more than one LIVE
 * document of a kind at the same time.
 */

const DEAD = new Set(["CANCELLED", "REJECTED"]);

interface Issue {
  id: number; issue_no: string; status: string;
  indent_id: number | null; indent_no: string | null;
}
interface Allocation {
  id: number; allocation_no: string; status: string;
  indent_id: number; indent_no: string | null;
}
interface Picking {
  id: number; pick_no: string; status: string;
  ref_type: string; ref_id: number; ref_no: string | null;
}
interface Dispatch {
  id: number; dispatch_no: string; status: string;
  ref_type: string | null; ref_id: number | null;
}

test("one indent has at most one live material issue", async ({ request }) => {
  const api = new Api(request);
  const live = (await api.all<Issue>("/api/warehouse/issues", reader()))
    .filter((row) => row.indent_id && !DEAD.has(row.status));

  const offenders = duplicatesBy(live, (row) => row.indent_id).map(([indentId, rows]) => ({
    indent: rows[0].indent_no ?? indentId,
    issues: rows.map((row) => `${row.issue_no}=${row.status}`),
  }));

  expect(
    offenders,
    "Indents carrying more than one live material issue.\n" +
      "Cause: warehouse.service._build_issue() guards duplicates per picking_id only " +
      "(a picklist may not be issued twice) and never per indent_id, so an issue " +
      "raised straight against an indent is unguarded. The extra issues strand in " +
      "PENDING_APPROVAL and clog the approver's queue.\n" +
      JSON.stringify(offenders, null, 2),
  ).toEqual([]);
});

test("one indent has at most one live stock allocation", async ({ request }) => {
  const api = new Api(request);
  const live = (await api.all<Allocation>("/api/allocations", reader()))
    .filter((row) => !DEAD.has(row.status));

  const offenders = duplicatesBy(live, (row) => row.indent_id).map(([indentId, rows]) => ({
    indent: rows[0].indent_no ?? indentId,
    allocations: rows.map((row) => `${row.allocation_no}=${row.status}`),
  }));

  expect(
    offenders,
    "Indents carrying more than one live allocation.\n" +
      "Cause: inventory.allocations.ensure_no_active() checks only DRAFT and " +
      "PENDING_APPROVAL (ACTIVE_ALLOCATION_STATUSES), so the moment one allocation " +
      "is APPROVED an unlimited number more can be raised and approved against the " +
      "same indent — each one reserving stock again.\n" +
      JSON.stringify(offenders, null, 2),
  ).toEqual([]);
});

test("one indent has at most one live fulfilment", async ({ request }) => {
  const api = new Api(request);
  const live = (await api.all<Picking>("/api/warehouse/pickings", reader()))
    .filter((row) => row.ref_type === "INDENT" && !DEAD.has(row.status));

  const offenders = duplicatesBy(live, (row) => row.ref_id).map(([indentId, rows]) => ({
    indent: rows[0].ref_no ?? indentId,
    fulfilments: rows.map((row) => `${row.pick_no}=${row.status}`),
  }));

  expect(
    offenders,
    "Indents carrying more than one live fulfilment (picklist).\n" +
      JSON.stringify(offenders, null, 2),
  ).toEqual([]);
});

test("one indent has at most one live dispatch", async ({ request }) => {
  const api = new Api(request);
  const issues = await api.all<Issue>("/api/warehouse/issues", reader());
  const indentOfIssue = new Map(issues.map((row) => [row.id, row.indent_no]));

  const live = (await api.all<Dispatch>("/api/warehouse/dispatches", reader()))
    .filter((row) => !DEAD.has(row.status) && row.ref_type === "WH_ISSUE" && row.ref_id)
    .map((row) => ({ ...row, indent: indentOfIssue.get(row.ref_id as number) ?? null }))
    .filter((row) => row.indent);

  const offenders = duplicatesBy(live, (row) => row.indent).map(([indent, rows]) => ({
    indent,
    dispatches: rows.map((row) => `${row.dispatch_no}=${row.status}`),
  }));

  expect(
    offenders,
    "Indents carrying more than one live dispatch.\n" +
      "Downstream of the duplicate-issue defect: every extra issue earns its own " +
      "dispatch, so the same indent ships twice.\n" +
      JSON.stringify(offenders, null, 2),
  ).toEqual([]);
});
