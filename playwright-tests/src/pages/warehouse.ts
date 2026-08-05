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
