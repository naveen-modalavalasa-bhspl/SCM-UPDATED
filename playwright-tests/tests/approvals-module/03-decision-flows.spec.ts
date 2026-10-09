import { test, expect } from "../../src/fixtures.js";
import { ApprovalsApi, listRows, pendingIndent, reader, users, signIn } from "./helpers.js";

/**
 * P7 and P8 — the two decisions that actually move a document.
 *
 * Both raise their own indent. A decision is irreversible, so no live request is
 * ever spent here. Success is read from the API afterwards, not from the screen
 * closing: a dialog that disappears proves nothing about what was written.
 */

const list = users();

test.describe("Approvals — decisions that move the document", () => {

  test("P7 · approve an indent end to end and see it leave the queue", async ({ page, log, goto, capture, playwright }) => {
    const context = await playwright.request.newContext({ baseURL: process.env.API_URL || "http://localhost:8000" });
    const api = new ApprovalsApi(context);

    const target = await pendingIndent(api, page, log, goto, list, "Raised for the approvals approve-path run.");
    await signIn(page, api, target.approver, log);

    await log.runStep("P7 · the indent is visible in the approver's own inbox", async () => {
      await goto("/approvals", "inbox-before-approve");
      const row = page.getByText(target.indentNo, { exact: false }).first();
      expect.soft(await row.count(), `${target.indentNo} is pending for ${target.approver.label} but is not listed in their inbox.`)
        .toBeGreaterThan(0);
    });

    await log.runStep("P7 · approve through the review screen", async () => {
      await goto(`/approvals?reviewIndent=${target.id}`, "review-before-approve");
      const approve = page.getByRole("button", { name: "Approve", exact: true });
      await expect(approve).toBeVisible({ timeout: 25_000 });

      const boxes = page.getByRole("checkbox");
      const count = await boxes.count();
      for (let index = 0; index < count; index += 1) {
        if (!(await boxes.nth(index).isChecked())) await boxes.nth(index).check();
      }
      await page.getByPlaceholder("Optional approval comment").fill("Approved by the automated approvals suite.");
      await expect(approve).toBeEnabled({ timeout: 10_000 });
      await approve.click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await capture("approve-confirm-dialog");

      const [response] = await Promise.all([
        page.waitForResponse((r) => new RegExp(`/api/approvals/indents/${target.id}/approve$`).test(new URL(r.url()).pathname), { timeout: 45_000 }),
        dialog.getByRole("button", { name: "Approve", exact: true }).click(),
      ]);
      expect(response.ok(), `Approve answered ${response.status()}: ${await response.text()}`).toBe(true);
      await expect(dialog).toBeHidden({ timeout: 30_000 });
    });

    await log.runStep("P7 · the approver lands back on the queue with no error painted over it", async () => {
      await page.waitForURL(/\/approvals(\?|$)/, { timeout: 20_000 }).catch(() => undefined);
      expect.soft(page.url(), "After approving, the approver should be back on the approvals queue.").toMatch(/\/approvals/);
      const errorBanner = page.locator(".text-danger").filter({ hasText: /not awaiting approval|error|failed/i });
      expect.soft(await errorBanner.count(), "An error banner was painted over a screen whose action succeeded.").toBe(0);
      await capture("queue-after-approve");
    });

    await log.runStep("P7 · the decision is recorded and the row is gone from the inbox", async () => {
      const stillPending = (await api.pending(target.approver))
        .some((row) => row.doc_type === "INDENT" && row.doc_id === target.id);
      expect.soft(stillPending, `${target.indentNo} is still in ${target.approver.label}'s pending queue after approval.`).toBe(false);

      const decisions = await api.decisions(target.approver);
      const mine = decisions.find((row: any) => row.doc_id === target.id && row.doc_type === "INDENT");
      expect.soft(mine, `${target.indentNo} did not appear in ${target.approver.label}'s My Decisions.`).toBeTruthy();
      if (mine) expect.soft(mine.decision, "The recorded decision should be APPROVED.").toBe("APPROVED");

      await goto("/approvals/decisions", "my-decisions-after-approve");
      await page.getByLabel("Search decisions").fill(target.indentNo);
      await page.waitForTimeout(250);
      expect.soft(await listRows(page).count(), `${target.indentNo} is not findable on the My Decisions screen.`).toBeGreaterThan(0);
      await capture("decisions-shows-approval");
    });

    await context.dispose();
  });

  test("P8 · return for correction, fix it as the requester and resubmit", async ({ page, log, goto, capture, playwright }) => {
    const context = await playwright.request.newContext({ baseURL: process.env.API_URL || "http://localhost:8000" });
    const api = new ApprovalsApi(context);

    const target = await pendingIndent(api, page, log, goto, list, "Raised for the approvals return-path run.");
    await signIn(page, api, target.approver, log);

    await log.runStep("P8 · return the indent with correction instructions", async () => {
      await goto(`/approvals?reviewIndent=${target.id}`, "review-before-return");
      await page.getByRole("button", { name: "Return for correction", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await dialog.locator("textarea").fill("Automated run: please correct the quantity and resubmit.");

      const [response] = await Promise.all([
        page.waitForResponse((r) => new RegExp(`/api/approvals/indents/${target.id}/return$`).test(new URL(r.url()).pathname), { timeout: 45_000 }),
        dialog.getByRole("button", { name: "Return", exact: true }).click(),
      ]);
      expect(response.ok(), `Return answered ${response.status()}: ${await response.text()}`).toBe(true);
      await expect(dialog).toBeHidden({ timeout: 30_000 });
      await capture("after-return");
    });

    await log.runStep("P8 · the returned indent is out of the ladder and back with the requester", async () => {
      const snapshot = await api.indent(target.id, reader(list));
      expect.soft(snapshot.status, `${target.indentNo} should be back with the requester after a return; it is ${snapshot.status}.`)
        .toBe("DRAFT");
      const stillPending = (await api.pending(target.approver))
        .some((row) => row.doc_type === "INDENT" && row.doc_id === target.id);
      expect.soft(stillPending, "A returned indent must not stay in the approver's queue.").toBe(false);
    });

    await log.runStep("P8 · the requester can actually read the indent they must correct", async () => {
      const asRequester = await api.raw("get", `/api/indents/${target.id}`, list.raiser);
      expect.soft(asRequester.ok,
        `The requester cannot read their own returned indent — the correction screen cannot load. `
        + `GET /api/indents/${target.id} as ${list.raiser.label} → ${asRequester.status} ${asRequester.body.slice(0, 200)}`)
        .toBe(true);
    });

    await log.runStep("P8 · the requester corrects and resubmits it", async () => {
      await signIn(page, api, list.raiser, log);
      await goto(`/indents/${target.id}/correction`, "correction-screen");

      await expect(page.getByText("Returned for correction")).toBeVisible({ timeout: 20_000 });
      const quantity = page.locator('input[type="number"]').first();
      await expect(quantity).toBeVisible({ timeout: 10_000 });

      // Zero and blank must be refused before the good value goes in.
      await quantity.fill("0");
      await page.waitForTimeout(250);
      await expect.soft(page.getByText("Every quantity must be greater than zero."),
        "A zero quantity on the correction screen must show the inline error.").toBeVisible({ timeout: 8_000 });
      const save = page.getByRole("button", { name: /Save correction/i });
      expect.soft(await save.isDisabled(), "Save correction must be disabled while a quantity is zero.").toBe(true);
      await capture("correction-zero-quantity");

      await quantity.fill("4");
      // Addressed by its own options: the layout sidebar renders a hidden select
      // for the position switcher, and that one is first in the DOM.
      const priority = page.locator("select")
        .filter({ has: page.locator('option[value="URGENT"]') }).first();
      if (await priority.count()) await priority.selectOption("URGENT");
      await page.waitForTimeout(200);

      const [saved] = await Promise.all([
        page.waitForResponse((r) => new RegExp(`/api/indents/${target.id}$`).test(new URL(r.url()).pathname) && r.request().method() === "PUT", { timeout: 30_000 }),
        page.getByRole("button", { name: /Save correction/i }).click(),
      ]);
      expect.soft(saved.ok(), `Save correction answered ${saved.status()}: ${await saved.text()}`).toBe(true);

      const [resubmitted] = await Promise.all([
        page.waitForResponse((r) => new RegExp(`/api/indents/${target.id}/submit$`).test(new URL(r.url()).pathname), { timeout: 45_000 }),
        page.getByRole("button", { name: /Save and resubmit/i }).click(),
      ]);
      expect(resubmitted.ok(), `Resubmit answered ${resubmitted.status()}: ${await resubmitted.text()}`).toBe(true);
      await capture("after-resubmit");
    });

    await log.runStep("P8 · the corrected indent is back in an approver's queue", async () => {
      const snapshot = await api.indent(target.id, reader(list));
      expect.soft(snapshot.status, `${target.indentNo} should be pending approval again; it is ${snapshot.status}.`)
        .toBe("PENDING_APPROVAL");
      const holder = await api.whoHasIndent(target.id, list.approvers);
      expect.soft(holder, `${target.indentNo} is pending but no configured approver holds it after the resubmit.`).not.toBeNull();
      if (holder) log.info(`${target.indentNo} is back with ${holder.label}.`);
    });

    await context.dispose();
  });
});
