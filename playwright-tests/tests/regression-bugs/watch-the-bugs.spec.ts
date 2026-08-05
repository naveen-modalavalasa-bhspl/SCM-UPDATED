import { expect, test } from "@playwright/test";
import { Api, duplicatesBy, reader, users } from "./helpers.js";

/**
 * The same defects the API specs assert, walked through the real screens so a
 * person can watch them happen.
 *
 * Run it headed and slowly:
 *   npx playwright test tests/regression-bugs/watch-the-bugs.spec.ts --headed --workers=1
 * with SLOW_MO=1000 in the environment.
 *
 * This file only looks. It signs in, opens the screen where the defect shows, and
 * asserts on what is on the page — it never approves, rejects or cancels anything,
 * so watching it costs the data nothing.
 */

const DEAD = new Set(["CANCELLED", "REJECTED"]);
const pause = (page: import("@playwright/test").Page) => page.waitForTimeout(1200);

interface Issue {
  id: number; issue_no: string; status: string;
  indent_id: number | null; indent_no: string | null;
}

async function signIn(page: import("@playwright/test").Page, id: string, password: string) {
  await page.goto("/login");
  await page.getByRole("textbox", { name: "Employee ID" }).fill(id);
  await page.locator('input[type="password"]').first().fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 45_000 });
  await pause(page);
}

test("watch: a cancelled material issue is still queued as an approval", async ({ page, request }) => {
  const api = new Api(request);
  const list = users();

  // Find the approver actually holding a task on a dead document — never hardcode
  // a name, the ladder is configuration.
  const issueStatus = new Map(
    (await api.all<Issue>("/api/warehouse/issues", reader())).map((r) => [r.id, r]),
  );
  let holder: { employeeId: string; password: string; label: string } | null = null;
  let ghostNo: string | null = null;
  for (const account of list.approvers) {
    const pending = await api
      .get<{ items: { doc_type: string; doc_id: number; doc_no?: string }[] }>(
        "/api/approvals/pending?page=1&size=200", account)
      .catch(() => ({ items: [] }));
    const ghost = (pending.items ?? []).find(
      (item) => item.doc_type === "WH_ISSUE" && DEAD.has(issueStatus.get(item.doc_id)?.status ?? ""),
    );
    if (ghost) {
      holder = account;
      ghostNo = ghost.doc_no ?? issueStatus.get(ghost.doc_id)?.issue_no ?? null;
      break;
    }
  }

  test.skip(!holder, "No ghost approval in the queue right now — nothing to watch.");

  await signIn(page, holder!.employeeId, holder!.password);
  await page.goto("/approvals");
  await pause(page);

  const row = page.getByRole("row", { name: new RegExp(ghostNo!.replace(/\//g, "\\/")) });
  await expect(row).toBeVisible();
  await pause(page);

  await row.getByRole("button", { name: "View details" }).click();
  await pause(page);

  // The dead end: the approver arrives at a cancelled document with no decision to make.
  await expect(page.getByText("CANCELLED", { exact: false }).first()).toBeVisible();
  await pause(page);

  expect(
    ghostNo,
    `${ghostNo} is CANCELLED but still sits in ${holder!.label}'s approval queue, and ` +
      "opening it offers no Approve, Reject or Return — the task can never be cleared.",
  ).toBeNull();
});

test("watch: one indent carrying several material issues", async ({ page, request }) => {
  const api = new Api(request);
  const live = (await api.all<Issue>("/api/warehouse/issues", reader()))
    .filter((row) => row.indent_id && !DEAD.has(row.status));
  const offenders = duplicatesBy(live, (row) => row.indent_id);

  test.skip(!offenders.length, "No indent currently carries duplicate issues.");

  const [, rows] = offenders.sort((a, b) => b[1].length - a[1].length)[0];
  const indentNo = rows[0].indent_no!;
  const admin = reader();

  await signIn(page, admin.employeeId, admin.password);
  await page.goto("/warehouse/transactions/material-issues");
  await pause(page);

  await page.getByRole("textbox", { name: /Search issue/i }).fill(indentNo);
  await pause(page);
  await page.waitForTimeout(1500); // debounce

  for (const issue of rows) {
    await expect(page.getByText(issue.issue_no, { exact: false }).first()).toBeVisible();
  }
  await pause(page);

  expect(
    rows.map((row) => `${row.issue_no}=${row.status}`),
    `${indentNo} has ${rows.length} live material issues on one indent. ` +
      "Every one of them reserves and moves stock for the same requirement.",
  ).toHaveLength(1);
});
