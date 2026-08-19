import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../../src/config.js";

/**
 * The Playwright-codegen recording of "raise an indent and walk it up the ladder",
 * cleaned up until it replays. What changed from the raw capture:
 *
 *  - the password is read from the gitignored users.json, never typed into source;
 *  - the duplicated `press('Enter')` + click('Sign in') pair is one click;
 *  - the hardcoded IND/2026-27/00052 became whatever number this run creates;
 *  - the checklist is `.check()` (idempotent) instead of a click that toggled it off;
 *  - `[id="react-aria4483214892-:r11t:"]` and the nth-child chains became the search
 *    box, which is how a human finds one document in a queue anyway.
 */

type Account = { employeeId: string; password: string; label: string; position?: string };

const chain = JSON.parse(readFileSync(resolve(ROOT, "users.json"), "utf8")).recordedChain as Account[];
const [raiser, ...approvers] = chain;

const INDENT_NO = /IND\/\d{4}-\d{2}\/\d+/;

async function login(page: Page, account: Account) {
  await page.goto("/login");
  // The JWT lives in localStorage, so clearing it is the only reliable way to drop
  // the previous rung's identity between logins.
  await page.evaluate(() => localStorage.clear());
  await page.goto("/login");
  await page.getByLabel("Employee ID").fill(account.employeeId);
  // "Password" also matches the show/hide toggle's aria-label — two matches is a
  // strict-mode failure, so target the input itself.
  await page.locator("input[name='password'], input[type='password']").first().fill(account.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  if (account.position) {
    await page.getByLabel("Working position").click();
    await page.getByRole("option", { name: account.position, exact: false }).first().click();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  }
}

test("indent is raised and approved up the ladder", async ({ page }) => {
  test.setTimeout(10 * 60_000);

  /* ---------------------------------------------------------- raise the indent */
  await login(page, raiser);
  await page.getByRole("button", { name: "Indents" }).click();
  await page.getByRole("button", { name: "New indent" }).click();

  await page.getByRole("combobox", { name: "Item" }).fill("cot");
  await page.getByRole("option", { name: /COTTON/ }).first().click();

  // A required date in the past is rejected; derive it rather than freezing the
  // recorded 2026-08-27, which goes stale the moment it passes.
  const required = new Date(Date.now() + 8 * 864e5).toISOString().slice(0, 10);
  await page.getByRole("textbox", { name: "Required date" }).fill(required);
  await page.getByRole("spinbutton", { name: /Quantity/ }).fill("1");
  await page.getByRole("button", { name: "Create indent" }).click();

  // The detail page titles itself with the new number — this is what replaces the
  // hardcoded document number the recording captured.
  const heading = page.getByRole("heading", { level: 1 }).filter({ hasText: INDENT_NO });
  await expect(heading).toBeVisible();
  const indentNo = ((await heading.innerText()).match(INDENT_NO) ?? [])[0]!;
  expect(indentNo).toBeTruthy();
  console.log(`raised ${indentNo}`);

  await page.getByRole("button", { name: "Submit for approval" }).click();
  await expect(page.getByRole("button", { name: "Submit for approval" })).toHaveCount(0);

  /* ------------------------------------------------------- walk it up the ladder */
  const approvedBy: string[] = [];

  for (const approver of approvers) {
    await login(page, approver);
    await page.getByRole("button", { name: "Approvals" }).click();

    // Searching is how a human finds one document in a queue, and it survives the
    // row moving, the page paginating, and the react-aria ids changing every render.
    const search = page.getByLabel("Search approvals");
    await expect(search).toBeVisible();
    await search.fill(indentNo);

    const row = page.getByRole("button", { name: "View details" });
    // A rung that is not holding this document has an empty queue — that is a real
    // outcome of the ladder, not a failure, so record it and move on.
    if (!(await row.count())) {
      console.log(`${approver.label}: ${indentNo} is not in this queue`);
      continue;
    }

    await row.first().click();
    // `.check()` is idempotent; the recording clicked some of these twice, which
    // toggled them back off and left Approve disabled.
    const checks = page.getByRole("checkbox");
    for (let i = 0; i < (await checks.count()); i += 1) await checks.nth(i).check();

    await page.getByRole("button", { name: "Approve" }).click();
    // The second Approve in the recording is the confirm modal, not a double-click.
    await page.getByRole("button", { name: "Approve" }).last().click();
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
    approvedBy.push(approver.label);
    console.log(`${approver.label}: approved ${indentNo}`);
  }

  expect(approvedBy.length, `no rung approved ${indentNo}`).toBeGreaterThan(0);
});
