import { expect, test } from "@playwright/test";
import { Api, duplicatesBy, reader } from "./helpers.js";

/**
 * The guards themselves, proven against live data without writing to it.
 *
 * The invariant specs beside this file check the STATE of the database, so they
 * stay red until the rows that were already created wrong are cleaned up. These
 * specs check the RULE instead: they ask the API to create a second document for
 * an indent that already has one and require it to be refused. A refused create
 * writes nothing, so this suite is safe to run against real data as often as you
 * like — and it is the evidence that the fix is actually in the running server.
 */

const DEAD = new Set(["CANCELLED", "REJECTED"]);

interface Issue {
  id: number; issue_no: string; status: string; warehouse_id: number;
  indent_id: number | null; indent_no: string | null;
}
interface Allocation { id: number; status: string; indent_id: number; indent_no: string | null }

/** An indent that already carries a live issue — the exact case the guard must catch. */
async function indentWithLiveIssue(api: Api) {
  const issues = await api.all<Issue>("/api/warehouse/issues", reader());
  return issues.find((row) => row.indent_id && !DEAD.has(row.status)) ?? null;
}

test("a second material issue for the same indent is refused", async ({ request }) => {
  const api = new Api(request);
  const existing = await indentWithLiveIssue(api);
  test.skip(!existing, "No indent currently carries a live issue to duplicate.");

  const response = await api.raw("post", "/api/warehouse/issues", reader(), {
    issue_type: "DEPARTMENT",
    issue_date: new Date().toISOString().slice(0, 10),
    indent_id: existing!.indent_id,
    warehouse_id: existing!.warehouse_id,
    direction: "OUT",
    items: [],
  });
  const body = await response.text();

  // 404/403 would mean the request never reached the guard — that is not a pass.
  expect(
    [422, 400].includes(response.status()),
    `Creating a second issue for ${existing!.indent_no} should be refused with a ` +
      `validation error. Got ${response.status()}: ${body}`,
  ).toBe(true);
  expect(
    body,
    "The refusal must name the issue already holding the indent, so the storekeeper " +
      "knows what to cancel rather than just being told no.",
  ).toContain(existing!.issue_no);
});

test("a second allocation for the same indent is refused", async ({ request }) => {
  const api = new Api(request);
  const allocations = await api.all<Allocation>("/api/allocations", reader());
  const existing = allocations.find((row) => !DEAD.has(row.status));
  test.skip(!existing, "No indent currently carries a live allocation to duplicate.");

  const response = await api.raw("post", "/api/allocations", reader(), {
    indent_id: existing!.indent_id,
    lines: [],
  });
  const body = await response.text();

  expect(
    [422, 400].includes(response.status()),
    `Creating a second allocation for ${existing!.indent_no} should be refused. ` +
      `Got ${response.status()}: ${body}`,
  ).toBe(true);
});

test("a second fulfilment for the same indent is refused", async ({ request }) => {
  const api = new Api(request);
  const pickings = await api.all<{
    id: number; pick_no: string; status: string; ref_type: string;
    ref_id: number; ref_no: string | null; warehouse_id: number;
  }>("/api/warehouse/pickings", reader());
  const existing = pickings.find((row) => row.ref_type === "INDENT" && row.status !== "CANCELLED");
  test.skip(!existing, "No indent currently carries a live fulfilment to duplicate.");

  const response = await api.raw("post", "/api/warehouse/pickings", reader(), {
    pick_date: new Date().toISOString().slice(0, 10),
    warehouse_id: existing!.warehouse_id,
    ref_type: "INDENT",
    ref_id: existing!.ref_id,
    strategy: "FEFO",
    items: [],
  });
  const body = await response.text();

  expect(
    [422, 400].includes(response.status()),
    `Creating a second fulfilment for ${existing!.ref_no} should be refused. ` +
      `Got ${response.status()}: ${body}`,
  ).toBe(true);
});

test("switching to a position you do not hold is refused, not a server error", async ({ request }) => {
  const api = new Api(request);
  const response = await api.raw("post", "/api/auth/switch-position", reader(), {
    position_id: 99_999_999,
  });

  expect(
    response.status(),
    "A position that is not yours is a permission answer. It used to raise " +
      "NameError inside the handler and surface as a 500, which the client can only " +
      "report as 'Internal server error'.",
  ).toBe(403);
});

/** Guards stop new damage; this reports what the old damage still is. */
test("report: duplicates already in the data", async ({ request }) => {
  const api = new Api(request);
  const live = (await api.all<Issue>("/api/warehouse/issues", reader()))
    .filter((row) => row.indent_id && !DEAD.has(row.status));
  const stale = duplicatesBy(live, (row) => row.indent_id).map(([, rows]) => ({
    indent: rows[0].indent_no,
    issues: rows.map((row) => `${row.issue_no}=${row.status}`),
  }));
  test.info().annotations.push({
    type: "pre-existing duplicates",
    description: stale.length
      ? `${stale.length} indent(s) still carry duplicate issues created before the ` +
        `guard existed. The guard cannot undo them — they need a data decision: ` +
        `${JSON.stringify(stale)}`
      : "none",
  });
});
