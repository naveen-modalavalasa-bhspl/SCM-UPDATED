import { expect, type Page } from "@playwright/test";
import type { Account } from "../config.js";
import type { RunLogger } from "../logger.js";

/**
 * Approves one rung of the ladder through the review screen.
 *
 * The screen is reachable directly at /approvals?reviewIndent=<id> — the same URL
 * the inbox pushes when a row is opened — so a rung can be driven without
 * depending on the row's position in a paginated list. The inbox is still checked
 * first, because "the document is visible where the approver would look for it" is
 * itself part of what is being tested.
 */
export async function approveRung(
  page: Page,
  log: RunLogger,
  approver: Account,
  indent: { id: number; indentNo: string },
  goto: (path: string, label?: string) => Promise<void>,
) {
  await log.runStep(`Approve ${indent.indentNo} as ${approver.label}`, async () => {
    await goto("/approvals", `inbox-${approver.label}`);
    const inboxRow = page.getByText(indent.indentNo, { exact: false }).first();
    if (await inboxRow.count()) {
      log.info(`${indent.indentNo} is visible in ${approver.label}'s inbox.`);
    } else {
      log.warn("assert", `${indent.indentNo} is not listed in ${approver.label}'s inbox, though the API says it is pending there.`);
    }

    await goto(`/approvals?reviewIndent=${indent.id}`, `review-${approver.label}`);

    // If the review screen never renders, the useful error is the API's, not a
    // locator timeout twenty seconds later. The listeners have already recorded it.
    const approveButton = page.getByRole("button", { name: "Approve", exact: true });
    try {
      await expect(approveButton).toBeVisible({ timeout: 20_000 });
    } catch {
      const refused = log.events
        .filter((event) => event.kind === "http-error" && event.message.includes(`/${indent.id}`))
        .pop();
      throw new Error(
        `${approver.label} cannot open ${indent.indentNo} for review, though it sits in their inbox.`
          + (refused
            ? `\nThe API refused it: ${refused.message}\n${JSON.stringify((refused.data as { body?: string })?.body ?? "")}`
            : "\nThe review screen never finished loading."),
      );
    }

    // Every checklist box must be ticked before the Approve button enables.
    const checks = page.getByRole("checkbox");
    const count = await checks.count();
    for (let index = 0; index < count; index += 1) {
      const box = checks.nth(index);
      if (!(await box.isChecked())) await box.check();
    }
    log.info(`Ticked ${count} checklist item(s).`);

    await page
      .getByPlaceholder("Optional approval comment")
      .fill(`Approved by automated functional run — ${approver.label}.`);

    await expect(approveButton).toBeEnabled({ timeout: 15_000 });
    await approveButton.click();

    // The confirmation dialog repeats the label, so the click is scoped to it.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    // As with submit, the API response — not the closing dialog — is what says the
    // decision was actually recorded.
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => new RegExp(`/api/approvals/indents/${indent.id}/approve$`).test(new URL(r.url()).pathname),
        { timeout: 45_000 },
      ),
      dialog.getByRole("button", { name: "Approve", exact: true }).click(),
    ]);
    if (!response.ok()) {
      throw new Error(`Approval rejected for ${approver.label}: ${response.status()} ${await response.text()}`);
    }
    await expect(dialog).toBeHidden({ timeout: 30_000 });
  });
}
