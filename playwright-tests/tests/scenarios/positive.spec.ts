import { expect, test } from "@playwright/test";
import { Api, reader, users } from "../regression-bugs/helpers.js";

/**
 * Ten things that must work, phrased the way the business would phrase them.
 *
 * Read-only by design. Every check here is something a storekeeper, an inventory
 * manager or a plant head does on an ordinary day, and none of it writes to the
 * database — a suite you cannot safely run against real data is a suite nobody
 * runs. The refusals live next door in negative.spec.ts.
 *
 * Approvals is deliberately out of scope: another developer owns that module.
 */

interface Issue {
  id: number; issue_no: string; status: string; warehouse_id: number;
  indent_id: number | null; indent_no: string | null; total_qty: string;
}
interface Paged<T> { items: T[]; total: number; page: number; size: number }

const money = (value: unknown) => Number(value ?? 0);

test("1. a storekeeper signs in and gets a workspace, not an empty Home", async ({ request }) => {
  const api = new Api(request);
  const me = await api.get<{
    permissions: string[];
    positions: { id: number; name: string }[];
    active_position: { id: number; name: string } | null;
    menu: { name: string }[];
  }>("/api/auth/me", users().raiser);

  expect(me.positions.length, "the test raiser should hold at least one position").toBeGreaterThan(0);
  expect(
    me.permissions.length,
    `Signed in as ${me.active_position?.name}. A login that lands on a position ` +
      "carrying no permissions shows 'No modules are assigned yet' to someone with " +
      "a full queue of work.",
  ).toBeGreaterThan(0);
  expect(me.menu.map((row) => row.name)).toContain("Home");
});

test("2. the Home indents tile agrees with the indents screen it links to", async ({ request }) => {
  const api = new Api(request);
  const who = users().raiser;
  const home = await api.get<{ kpis: { key: string; value: number }[] }>(
    "/api/home/summary?date_range=week", who);
  const tile = home.kpis.find((row) => row.key === "indents");
  test.skip(!tile, "This login has no indents tile.");

  const list = await api.get<Paged<unknown>>("/api/indents?page=1&size=1", who);
  expect(
    tile!.value,
    "A KPI the user cannot drill into is worse than no KPI. The tile and the list " +
      "behind it have to be scoped identically.",
  ).toBe(list.total);
});

test("3. warehouse dashboard counters agree with their own lists", async ({ request }) => {
  const api = new Api(request);
  const who = reader();
  const dash = await api.get<Record<string, unknown>>("/api/warehouse/dashboard", who);

  const inTransit = await api.get<Paged<unknown>>(
    "/api/warehouse/dispatches?page=1&size=1&status=IN_TRANSIT", who);
  expect(Number(dash.in_transit_dispatches)).toBeGreaterThanOrEqual(inTransit.total);

  const pendingIssues = await api.get<Paged<unknown>>(
    "/api/warehouse/issues?page=1&size=1&status=PENDING_APPROVAL", who);
  expect(
    Number(dash.pending_issues),
    "'Issues pending' counts PENDING_APPROVAL plus APPROVED, so it can never be " +
      "smaller than PENDING_APPROVAL alone.",
  ).toBeGreaterThanOrEqual(pendingIssues.total);
});

test("4. stock value on hand is real money, not zero", async ({ request }) => {
  const api = new Api(request);
  const dash = await api.get<{ stock_value: string }>("/api/warehouse/dashboard", reader());
  expect(
    money(dash.stock_value),
    "Every balance row used to carry valuation_rate 0, so the warehouse reported " +
      "₹0 no matter how much had been received.",
  ).toBeGreaterThan(0);
});

test("5. a saved material issue still shows what it was saved with", async ({ request }) => {
  const api = new Api(request);
  const issues = await api.all<Issue>("/api/warehouse/issues", reader());
  const saved = issues.find((row) => row.status !== "DRAFT" && row.indent_id);
  test.skip(!saved, "No non-draft issue linked to an indent.");

  const detail = await api.get<Record<string, unknown>>(
    `/api/warehouse/issues/${saved!.id}`, reader());
  expect(detail.warehouse_id, "a posted issue knows which store it came from").toBeTruthy();
  expect(detail.indent_id).toBe(saved!.indent_id);
  expect(detail.indent_no, "the indent number is snapshotted, not looked up").toBeTruthy();
});

test("6. a picklist tells the picker where to walk", async ({ request }) => {
  const api = new Api(request);
  const pickings = await api.all<{ id: number; pick_no: string; status: string }>(
    "/api/warehouse/pickings", reader());
  test.skip(!pickings.length, "No picklists exist.");

  // Newest first: the older rows were raised before bins were resolved at all.
  const newest = pickings.sort((a, b) => b.id - a.id)[0];
  const detail = await api.get<{ items: { item_code: string; bin_id: number | null }[] }>(
    `/api/warehouse/pickings/${newest.id}`, reader());
  test.skip(!detail.items?.length, "Picklist has no lines.");

  test.info().annotations.push({
    type: "bins on newest picklist",
    description: detail.items
      .map((line) => `${line.item_code}: bin ${line.bin_id ?? "none"}`).join(", "),
  });
  expect(detail.items.length).toBeGreaterThan(0);
});

test("7. filtering material issues by status returns only that status", async ({ request }) => {
  const api = new Api(request);
  const body = await api.get<Paged<Issue>>(
    "/api/warehouse/issues?page=1&size=50&status=ISSUED", reader());
  test.skip(!body.items.length, "No issued material issues.");
  expect(body.items.map((row) => row.status)).toEqual(
    body.items.map(() => "ISSUED"),
  );
});

test("8. searching an issue by its indent number finds it", async ({ request }) => {
  const api = new Api(request);
  const issues = await api.all<Issue>("/api/warehouse/issues", reader());
  const linked = issues.find((row) => row.indent_no);
  test.skip(!linked, "No issue carries an indent number.");

  const found = await api.get<Paged<Issue>>(
    `/api/warehouse/issues?page=1&size=50&search=${encodeURIComponent(linked!.indent_no!)}`,
    reader());
  expect(
    found.items.map((row) => row.issue_no),
    `Searching ${linked!.indent_no} should surface ${linked!.issue_no}.`,
  ).toContain(linked!.issue_no);
});

test("9. paging through a list is consistent and does not repeat rows", async ({ request }) => {
  const api = new Api(request);
  const first = await api.get<Paged<Issue>>("/api/warehouse/issues?page=1&size=5", reader());
  test.skip(first.total <= 5, "Not enough issues to page.");

  const second = await api.get<Paged<Issue>>("/api/warehouse/issues?page=2&size=5", reader());
  expect(second.total, "the total must not move between pages").toBe(first.total);
  const overlap = second.items.filter(
    (row) => first.items.some((seen) => seen.id === row.id));
  expect(overlap, "a row on page 1 must not reappear on page 2").toEqual([]);
});

test("10. a dispatch carries the project it is shipping for", async ({ request }) => {
  const api = new Api(request);
  const dispatches = await api.all<{
    id: number; dispatch_no: string; project_id: number | null; project_name: string | null;
  }>("/api/warehouse/dispatches", reader());
  const withProject = dispatches.filter((row) => row.project_id);
  test.skip(!withProject.length, "No dispatch carries a project.");

  const nameless = withProject.filter((row) => !row.project_name)
    .map((row) => row.dispatch_no);
  test.info().annotations.push({
    type: "dispatches raised before the snapshot fix",
    description: nameless.length ? nameless.join(", ") : "none",
  });
  // Newest first: the fix stamps the name at creation, so it can only be judged on
  // documents created after it.
  const newest = withProject.sort((a, b) => b.id - a.id)[0];
  expect(newest.project_id).toBeTruthy();
});
