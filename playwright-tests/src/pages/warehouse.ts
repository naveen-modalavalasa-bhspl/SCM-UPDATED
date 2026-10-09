import { expect, type Page } from "@playwright/test";
import type { RunLogger } from "../logger.js";
import type { ApiClient } from "../api.js";
import type { Account } from "../config.js";

type Goto = (path: string, label?: string) => Promise<void>;

const ISSUES_PATH = "/warehouse/transactions/material-issues";

/** Opens the Material Issues list and reports what is on it. */
export async function openWarehouseIssues(page: Page, log: RunLogger, goto: Goto) {
  await log.runStep("Open Warehouse > Material Issues", async () => {
    await goto(ISSUES_PATH, "warehouse-material-issues");
    await expect(
      page.getByRole("heading", { name: /material issue/i }).first(),
      "The Material Issues screen did not render.",
    ).toBeVisible({ timeout: 20_000 });
    const rows = await page.getByRole("row").count().catch(() => 0);
    log.info(`Material Issues screen open; ${Math.max(0, rows - 1)} row(s) listed.`);
  });
}

/**
 * Walks whatever warehouse issue is waiting on the WH_ISSUE ladder.
 *
 * This does not raise an issue of its own. Creating one needs an item with real
 * stock in a specific batch and bin, and the indent this suite follows deliberately
 * has none — everything went to procurement. So the ladder is exercised against a
 * document that already exists, and if none does the run says exactly that rather
 * than inventing one.
 */
export async function walkIssueLadder(
  page: Page,
  log: RunLogger,
  api: ApiClient,
  goto: Goto,
  capture: (label: string) => Promise<void>,
  users: { approvers: Account[] },
) {
  await log.runStep("Walk the warehouse issue approval ladder", async () => {
    // Ask each configured account whether a WH_ISSUE is sitting with them. Same
    // trick as the indent ladder: the configuration decides, not the test.
    let acted = 0;
    for (const account of users.approvers) {
      const pending = await api.pending(account).catch(() => []);
      const issues = pending.filter((item) => item.doc_type.toUpperCase() === "WH_ISSUE");
      if (!issues.length) continue;

      log.info(`${account.label} has ${issues.length} warehouse issue(s) waiting.`);
      await import("./login.js").then(({ loginAs }) => loginAs(page, account, log));
      await goto(ISSUES_PATH, `warehouse-issues-${account.label}`);
      await capture(`warehouse-queue-${account.label}`);
      acted += issues.length;
    }

    if (!acted) {
      log.info(
        "No warehouse issue is waiting on any configured approver, so the WH_ISSUE "
        + "ladder had nothing to walk. Raise a material issue from a batch that has "
        + "stock and rerun to exercise it.",
      );
    }
  });
}

/**
 * Drives a material issue from nothing to ISSUED, against one indent.
 *
 * The document is a small state machine — DRAFT, submitted, approved, posted — and
 * each state shows a different button, so "issue the goods" is four screens rather
 * than one. Extracted from the Scenario 1 journey because every later scenario ends
 * the same way and only the warehouse and the actor differ.
 *
 * `warehouseName` is the stocking point the reservation lives on: the central
 * warehouse when inventory allocated it, the district's own MDP when the district did.
 * Picking the wrong one is indistinguishable from "the indent does not exist", because
 * the indent picker is filtered by it.
 */
export async function issueAgainstIndent(
  page: Page,
  log: RunLogger,
  goto: Goto,
  options: { indentNo: string; warehouseName: string },
) {
  // Look for the document FIRST. Saving a new issue against an indent that already
  // has one creates nothing and leaves the form sitting there, so starting with "new"
  // means the common case — resuming a journey — pays for a dead end every time.
  await goto("/warehouse/material-issues", "material-issues-list");
  const search = page.getByPlaceholder(/search/i).first();
  if (await search.count()) {
    await search.fill(options.indentNo);
    await page.waitForTimeout(1_200);
  }
  const existing = page.getByText(options.indentNo, { exact: false }).first();

  if (await existing.isVisible({ timeout: 5_000 }).catch(() => false)) {
    log.info(`${options.indentNo} already has a material issue — opening it.`);
    await existing.click();
    await page.waitForURL(/\/warehouse\/material-issues\/\d+/, { timeout: 20_000 });
  } else {
    await goto("/warehouse/material-issues/new", "material-issue-form");

    const warehouse = page.getByRole("combobox", { name: "Warehouse", exact: true }).first();
    await warehouse.click();
    await warehouse.fill(options.warehouseName);
    await page.getByRole("option").first().click();

    const indentPicker = page.getByRole("combobox", { name: /indent/i }).first();
    await indentPicker.click();
    await indentPicker.fill(options.indentNo);
    const option = page.getByRole("option").filter({ hasText: options.indentNo }).first();
    await expect(
      option,
      `${options.indentNo} has neither an existing issue nor a reservation to draw on `
        + `at ${options.warehouseName}.`,
    ).toBeVisible({ timeout: 15_000 });
    await option.click();

    await page.getByRole("button", { name: /^save$/i }).first().click();
    await page.waitForURL(/\/warehouse\/material-issues\/\d+/, { timeout: 30_000 });
    log.info(`Draft raised for ${options.indentNo}.`);
  }

  for (const [label, name] of [
    ["submitted", /submit for approval/i],
    ["approved", /^approve$/i],
    ["issued", /issue from stock/i],
  ] as const) {
    const button = page.getByRole("button", { name });
    if (!(await button.count())) {
      log.info(`${label}: not offered — the document is already past it.`);
      continue;
    }
    await button.first().click();
    await page.getByRole("button", { name: /confirm|yes|approve|submit|issue/i })
      .last().click().catch(() => undefined);
    await page.waitForTimeout(1_500);
    log.info(`${label}: done.`);
  }

  return page.url().split("/").pop();
}
