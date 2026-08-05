import { expect, test } from "@playwright/test";
import { Api, reader, users } from "../regression-bugs/helpers.js";

/**
 * Ten things the system must refuse, and refuse *well*.
 *
 * "Well" means two separate claims, and both are tested: the request is rejected,
 * and it is rejected with an answer the user can act on. A 500 is not a refusal —
 * it is the server falling over on a case somebody should have thought about, and
 * the client can only ever show "Internal server error" for it.
 *
 * Every refusal here writes nothing, so this file is safe against real data.
 * Approvals is out of scope: another developer owns that module.
 */

const REFUSED = [400, 422];

interface Issue {
  id: number; issue_no: string; status: string; warehouse_id: number;
  indent_id: number | null; indent_no: string | null;
}

const today = () => new Date().toISOString().slice(0, 10);

async function liveIssue(api: Api) {
  const issues = await api.all<Issue>("/api/warehouse/issues", reader());
  return issues.find(
    (row) => row.indent_id && !["CANCELLED", "REJECTED"].includes(row.status)) ?? null;
}

test("1. a second material issue for one indent is refused, and says which one blocks it", async ({ request }) => {
  const api = new Api(request);
  const existing = await liveIssue(api);
  test.skip(!existing, "No indent currently carries a live issue.");

  const response = await api.raw("post", "/api/warehouse/issues", reader(), {
    issue_type: "DEPARTMENT", issue_date: today(),
    indent_id: existing!.indent_id, warehouse_id: existing!.warehouse_id,
    direction: "OUT", items: [],
  });
  const body = await response.text();
  expect(REFUSED, `got ${response.status()}: ${body}`).toContain(response.status());
  expect(
    body,
    "Naming the blocking document is the difference between a storekeeper fixing " +
      "this themselves and raising a ticket.",
  ).toContain(existing!.issue_no);
});

test("2. a second allocation for one indent is refused", async ({ request }) => {
  const api = new Api(request);
  const allocations = await api.all<{ id: number; status: string; indent_id: number }>(
    "/api/allocations", reader());
  const live = allocations.find((row) => !["CANCELLED", "REJECTED"].includes(row.status));
  test.skip(!live, "No live allocation.");

  const response = await api.raw("post", "/api/allocations", reader(), {
    indent_id: live!.indent_id, lines: [],
  });
  expect(REFUSED, `got ${response.status()}: ${await response.text()}`)
    .toContain(response.status());
});

test("3. a second fulfilment for one indent is refused", async ({ request }) => {
  const api = new Api(request);
  const pickings = await api.all<{
    id: number; status: string; ref_type: string; ref_id: number; warehouse_id: number;
  }>("/api/warehouse/pickings", reader());
  const live = pickings.find((row) => row.ref_type === "INDENT" && row.status !== "CANCELLED");
  test.skip(!live, "No live indent fulfilment.");

  const response = await api.raw("post", "/api/warehouse/pickings", reader(), {
    pick_date: today(), warehouse_id: live!.warehouse_id,
    ref_type: "INDENT", ref_id: live!.ref_id, strategy: "FEFO", items: [],
  });
  expect(REFUSED, `got ${response.status()}: ${await response.text()}`)
    .toContain(response.status());
});

test("4. switching to a position you do not hold is a 403, never a 500", async ({ request }) => {
  const api = new Api(request);
  const response = await api.raw("post", "/api/auth/switch-position", reader(), {
    position_id: 99_999_999,
  });
  expect(response.status(), await response.text()).toBe(403);
});

test("5. a material issue line priced below zero is refused", async ({ request }) => {
  const api = new Api(request);
  const issues = await api.all<Issue>("/api/warehouse/issues", reader());
  const free = issues.find((row) => !row.indent_id);
  test.skip(!free, "No issue to borrow a warehouse from.");

  const response = await api.raw("post", "/api/warehouse/issues", reader(), {
    issue_type: "DEPARTMENT", issue_date: today(),
    warehouse_id: free!.warehouse_id, direction: "OUT",
    items: [{ item_id: 2, requested_qty: 1, issued_qty: 1, rate: -500 }],
  });
  const body = await response.text();
  expect(REFUSED, `got ${response.status()}: ${body}`).toContain(response.status());
  expect(
    body.toLowerCase(),
    "Goods leaving a store have a cost or none; never a negative one. One live " +
      "issue reached ₹ -62,617 this way.",
  ).toContain("negative");
});

test("6. an issue with no lines is refused", async ({ request }) => {
  const api = new Api(request);
  const issues = await api.all<Issue>("/api/warehouse/issues", reader());
  const free = issues.find((row) => !row.indent_id);
  test.skip(!free, "No issue to borrow a warehouse from.");

  const response = await api.raw("post", "/api/warehouse/issues", reader(), {
    issue_type: "DEPARTMENT", issue_date: today(),
    warehouse_id: free!.warehouse_id, direction: "OUT", items: [],
  });
  expect(REFUSED, `got ${response.status()}: ${await response.text()}`)
    .toContain(response.status());
});

test("7. no token means 401, and the data stays behind the door", async ({ request }) => {
  const response = await request.get("/api/warehouse/issues?page=1&size=1");
  expect([401, 403], await response.text()).toContain(response.status());
  expect(
    await response.text(),
    "an unauthenticated error must not leak rows",
  ).not.toContain("issue_no");
});

test("8. a document that does not exist is a 404, not a stack trace", async ({ request }) => {
  const api = new Api(request);
  for (const path of [
    "/api/warehouse/issues/99999999",
    "/api/warehouse/pickings/99999999",
    "/api/warehouse/dispatches/99999999",
  ]) {
    const response = await api.raw("get", path, reader());
    expect(response.status(), `${path} answered ${response.status()}`).toBe(404);
  }
});

test("9. cancelling a document that is already cancelled is refused", async ({ request }) => {
  const api = new Api(request);
  const issues = await api.all<Issue>("/api/warehouse/issues", reader());
  const dead = issues.find((row) => row.status === "CANCELLED");
  test.skip(!dead, "No cancelled issue to re-cancel.");

  const response = await api.raw(
    "post", `/api/warehouse/issues/${dead!.id}/cancel`, reader(), { reason: "QA re-cancel" });
  expect(
    REFUSED,
    `Re-cancelling ${dead!.issue_no} answered ${response.status()}: ${await response.text()}`,
  ).toContain(response.status());
});

test("10. hostile input is handled, not crashed on", async ({ request }) => {
  const api = new Api(request);
  const nasty = [
    "?page=1&size=50&search=" + encodeURIComponent("'; DROP TABLE out_issues; --"),
    "?page=1&size=50&search=" + encodeURIComponent("<script>alert(1)</script>"),
    "?page=1&size=50&search=" + encodeURIComponent("x".repeat(500)),
    "?page=0&size=5",
    "?page=1&size=100000",
    "?page=1&size=5&status=NOT_A_STATUS",
  ];
  for (const query of nasty) {
    const response = await api.raw("get", `/api/warehouse/issues${query}`, reader());
    expect(
      response.status(),
      `${query} answered ${response.status()} — anything in the 500s means the ` +
        "input reached something that could not cope with it.",
    ).toBeLessThan(500);
  }

  // And the table is still there.
  const after = await api.get<{ total: number }>(
    "/api/warehouse/issues?page=1&size=1", reader());
  expect(after.total).toBeGreaterThan(0);
});
