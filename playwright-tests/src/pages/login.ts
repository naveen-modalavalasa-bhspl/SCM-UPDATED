import { expect, type Page } from "@playwright/test";
import type { Account } from "../config.js";
import type { RunLogger } from "../logger.js";

/**
 * Signs out whoever is on screen and signs the given account in.
 *
 * The app keeps its JWT in localStorage, so a hard clear is the only reliable way
 * to drop an identity between the rungs of an approval chain — the "Sign out"
 * button is used when it is there, and the storage wipe is the safety net.
 */
export async function loginAs(page: Page, account: Account, log: RunLogger) {
  await log.runStep(`Sign in as ${account.label} (${account.employeeId})`, async () => {
    const signOut = page.getByRole("button", { name: "Sign out" });
    if (await signOut.count()) {
      await signOut.first().click();
      await page.waitForURL(/\/login/, { timeout: 10_000 }).catch(() => undefined);
    }
    await page.goto("/login");
    await page.evaluate(() => localStorage.clear());
    await page.goto("/login");

    await page.getByLabel("Employee ID").fill(account.employeeId);
    await page.getByLabel("Password").fill(account.password);
    await page.getByRole("button", { name: /sign in/i }).click();

    // A bad password renders an inline error instead of navigating; surface it as
    // itself rather than as a timeout on the URL wait.
    const error = page.locator("form .text-bad");
    await Promise.race([
      page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 }),
      error.waitFor({ state: "visible", timeout: 20_000 }).then(async () => {
        throw new Error(`Login rejected for ${account.label}: ${await error.innerText()}`);
      }),
    ]);
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 15_000 });
  });

  if (account.position) await switchPosition(page, account, log);
}

/**
 * Picks the working position from the sidebar's "Working as" switcher.
 *
 * Scope and permissions hang off the active position, not the employee — the same
 * person can be blind to a document under one hat and own it under another — so a
 * run that never switches is testing whichever position happens to be the default.
 */
async function switchPosition(page: Page, account: Account, log: RunLogger) {
  await log.runStep(`Switch ${account.label} to position "${account.position}"`, async () => {
    const selector = page.getByRole("button", { name: "Working position" }).first();
    await expect(selector).toBeVisible({ timeout: 15_000 });

    if ((await selector.innerText()).includes(account.position!)) {
      log.info(`Already working as ${account.position}.`);
      return;
    }

    await selector.click();
    const option = page.getByRole("option").filter({ hasText: account.position! }).first();
    if (!(await option.count())) {
      const available = await page.getByRole("option").allInnerTexts();
      throw new Error(
        `${account.label} has no position matching "${account.position}". Available: ${available.join(", ") || "none"}.`,
      );
    }
    // Switching re-issues the token and sends the app back to the home screen.
    await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === "/api/auth/switch-position", { timeout: 30_000 }),
      option.click(),
    ]);
    await expect(selector).toContainText(account.position!.slice(0, 12), { timeout: 20_000 });
  });
}
