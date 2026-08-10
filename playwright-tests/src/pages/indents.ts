import { expect, type Page } from "@playwright/test";
import type { RunLogger } from "../logger.js";
import { config } from "../config.js";

export interface CreatedIndent {
  id: number;
  indentNo: string;
  itemLabel: string;
}

/**
 * Fills the New Request form and creates the indent, returning its id.
 *
 * The item is picked from whatever the catalogue actually offers rather than a
 * hardcoded code, so the run survives a masters reseed. `itemQuery` narrows the
 * list when a specific item matters.
 */
export async function createIndent(
  page: Page,
  log: RunLogger,
  options: { quantity: number; itemQuery?: string; remarks?: string; daysAhead?: number;
             /** "Monthly" makes the request part of the consolidation cycle. */
             indentType?: string },
): Promise<CreatedIndent> {
  return log.runStep("Create indent", async () => {
    if (options.indentType) {
      // Set before the item: the type decides which cycle the request joins, and the
      // consolidation screen groups by it.
      const type = page.getByRole("combobox", { name: "Indent type" }).first();
      await type.click();
      await page.getByRole("option", { name: options.indentType, exact: false })
        .first().click();
    }

    const combobox = page.getByRole("combobox", { name: "Item" }).first();
    await combobox.click();
    // Defaults to an item the warehouse actually holds — see config.stockedItem.
    const query = options.itemQuery ?? config.stockedItem;
    if (query) await combobox.fill(query);

    const listbox = page.getByRole("listbox");
    await expect(listbox.getByRole("option").first()).toBeVisible({ timeout: 15_000 });
    const option = listbox.getByRole("option").filter({ hasNot: page.locator("[aria-disabled='true']") }).first();
    const itemLabel = (await option.innerText()).trim();
    await option.click();
    log.info(`Picked item: ${itemLabel}`);

    await page.getByRole("spinbutton").first().fill(String(options.quantity));

    const required = new Date();
    required.setDate(required.getDate() + (options.daysAhead ?? 7));
    await page.getByLabel("Required date").fill(required.toISOString().slice(0, 10));

    if (options.remarks) {
      // Addressed by placeholder, not label: shared/components `Field` renders its
      // caption as a plain span inside the <label>, so the control's only
      // accessible name is the placeholder. Logged as an a11y finding by the run.
      await page.getByPlaceholder("Optional").fill(options.remarks);
    }

    await page.getByRole("button", { name: "Create indent" }).click();

    // Success is a redirect onto the new indent's detail screen; the id in that
    // URL is what the rest of the run follows.
    await page.waitForURL(/\/indents\/\d+$/, { timeout: 30_000 });
    const id = Number(page.url().match(/\/indents\/(\d+)$/)![1]);
    const heading = await page.getByRole("heading").first().innerText();
    const indentNo = heading.trim().split(/\s+/).pop() ?? String(id);
    log.info(`Indent created: ${indentNo} (id ${id})`);
    return { id, indentNo, itemLabel };
  });
}

/** Sends a DRAFT indent into the approval ladder. */
export async function submitForApproval(page: Page, log: RunLogger, indentId: number) {
  await log.runStep(`Submit indent ${indentId} for approval`, async () => {
    const button = page.getByRole("button", { name: /submit for approval/i });
    await expect(button).toBeVisible({ timeout: 15_000 });

    // Waiting for the button to disappear is not enough: its label flips to
    // "Submitting…" the moment it is clicked, which reads as "gone" while the call
    // is still in flight. The response itself is the only honest signal.
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => new RegExp(`/api/indents/${indentId}/submit$`).test(new URL(r.url()).pathname),
        { timeout: 45_000 },
      ),
      button.click(),
    ]);
    if (!response.ok()) {
      throw new Error(`Submit rejected: ${response.status()} ${await response.text()}`);
    }
    await expect(page.getByRole("button", { name: /submitting/i })).toBeHidden({ timeout: 30_000 });
  });
}
