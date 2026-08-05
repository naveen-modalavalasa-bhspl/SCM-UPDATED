import { expect, type Page } from "@playwright/test";
import type { RunLogger } from "../logger.js";

type Goto = (path: string, label?: string) => Promise<void>;

/**
 * Inventory's decision on an approved indent: how much to give, and from where.
 *
 * The screen pre-fills each line from the warehouse holding the most stock, so the
 * run accepts that proposal rather than inventing quantities — what is being tested
 * is that the decision can be recorded and sent for approval, not the arithmetic.
 * A proposal of zero (nothing on the shelf) is a valid decision and still submits;
 * the indent then goes to procurement instead of being reserved.
 */
export async function allocateStock(
  page: Page,
  log: RunLogger,
  indent: { id: number; indentNo: string },
  goto: Goto,
) {
  await log.runStep(`Allocate stock for ${indent.indentNo}`, async () => {
    await goto(`/inventory/allocate/${indent.id}`, "allocation-decision");

    const submit = page.getByRole("button", { name: "Submit for approval" });
    await expect(submit).toBeVisible({ timeout: 20_000 });

    // What the screen proposes, recorded so the report explains the outcome — an
    // indent that ends up at PENDING_PROCUREMENT did so because of these numbers.
    const proposed = await page.getByRole("spinbutton").allInnerTexts().catch(() => []);
    const quantities = await page.getByRole("spinbutton").evaluateAll(
      (inputs) => inputs.map((input) => (input as HTMLInputElement).value),
    );
    log.info(`Proposed quantities: ${quantities.join(", ") || proposed.join(", ") || "none"}`);

    await page
      .getByPlaceholder("e.g. holding 20 for the Eluru site on Monday")
      .fill("Allocated by the automated functional run.");

    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => new URL(r.url()).pathname === "/api/allocations" && r.request().method() === "POST",
        { timeout: 45_000 },
      ),
      submit.click(),
    ]);
    if (!response.ok()) {
      throw new Error(`Allocation rejected: ${response.status()} ${await response.text()}`);
    }
    await page.waitForURL(/\/inventory\/fulfillment/, { timeout: 30_000 });
  });
}

/**
 * The second half of the ladder you configured: the allocation itself needs signing
 * off before any stock is actually reserved.
 *
 * With the raiser allowed to approve, this is the same person wearing the Inventory
 * Manager hat — which is exactly the flow the project's custom ladder describes.
 */
export async function approveAllocation(
  page: Page,
  log: RunLogger,
  indent: { indentNo: string },
  goto: Goto,
) {
  await log.runStep(`Approve the allocation for ${indent.indentNo}`, async () => {
    await goto("/inventory/allocation-approvals", "allocation-approvals-queue");

    const row = page.getByText(indent.indentNo, { exact: false }).first();
    await expect(
      row,
      `The allocation for ${indent.indentNo} is not waiting in Allocation Approvals. `
        + "Either it was not submitted, or the ladder routed it to somebody else.",
    ).toBeVisible({ timeout: 20_000 });
    await row.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await dialog.getByPlaceholder("Optional reason or instruction")
      .fill("Approved by the automated functional run.");

    const approve = dialog.getByRole("button", { name: /approve and reserve/i });
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => /\/api\/allocations\/\d+\/approve$/.test(new URL(r.url()).pathname),
        { timeout: 45_000 },
      ),
      approve.click(),
    ]);
    if (!response.ok()) {
      throw new Error(`Allocation approval rejected: ${response.status()} ${await response.text()}`);
    }
    await expect(dialog).toBeHidden({ timeout: 30_000 });
  });
}
