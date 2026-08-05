import { test, expect } from "../../src/fixtures.js";
import { ApprovalsApi, pendingIndent, reader, users, signIn } from "./helpers.js";

/**
 * N1–N4 and N8: every guard on the indent review screen.
 *
 * It raises its OWN indent rather than borrowing a live one. N4 pushes a reason
 * the backend must refuse — if that validation were missing, the request would
 * go through and reject the document, and no real request may be spent proving
 * a defect. Everything else opens a modal and dismisses it.
 */

const list = users();

test.describe("Approvals — indent review validations", () => {

  test("N1–N4 · checklist gating, quantity bounds and required reasons", async ({ page, log, goto, capture, playwright }) => {
    const context = await playwright.request.newContext({ baseURL: process.env.API_URL || "http://localhost:8000" });
    const api = new ApprovalsApi(context);

    const target = await pendingIndent(api, page, log, goto, list, "Raised for the approvals validation run.");
    log.info(`Validating against ${target.indentNo} (id ${target.id}) as ${target.approver.label}.`);

    await signIn(page, api, target.approver, log);
    await goto(`/approvals?reviewIndent=${target.id}`, "review-screen");

    const approve = page.getByRole("button", { name: "Approve", exact: true });
    await expect(approve).toBeVisible({ timeout: 25_000 });

    // ---- N1 · the checklist gates the Approve button --------------------------
    await log.runStep("N1 · Approve stays disabled until every checklist box is ticked", async () => {
      const boxes = page.getByRole("checkbox");
      const count = await boxes.count();
      expect.soft(count, "The review screen should show three confirmation checkboxes.").toBe(3);

      for (let index = 0; index < count; index += 1) {
        if (await boxes.nth(index).isChecked()) await boxes.nth(index).uncheck();
      }
      expect.soft(await approve.isDisabled(), "With no box ticked, Approve must be disabled.").toBe(true);

      for (let index = 0; index < count; index += 1) {
        await boxes.nth(index).check();
        const shouldBeEnabled = index === count - 1;
        const disabled = await approve.isDisabled();
        expect.soft(disabled, `After ticking ${index + 1} of ${count} boxes, Approve should be ${shouldBeEnabled ? "enabled" : "disabled"}.`)
          .toBe(!shouldBeEnabled);
      }

      await boxes.nth(0).uncheck();
      expect.soft(await approve.isDisabled(), "Un-ticking a box must disable Approve again.").toBe(true);
      await boxes.nth(0).check();
      await capture("review-checklist");
    });

    // ---- N2 · approved quantity bounds ----------------------------------------
    await log.runStep("N2 · approved quantity must be between zero and the requested quantity", async () => {
      const quantity = page.locator('input[type="number"]').first();
      await expect(quantity).toBeVisible({ timeout: 10_000 });
      const requested = Number((await page.locator("table tbody tr td:nth-child(2)").first().innerText()).split(/\s+/)[0]);
      const original = await quantity.inputValue();
      const warning = page.getByText("Every quantity must be between zero and the requested quantity.");

      // Letters are not in the list: the field is <input type="number">, so the
      // browser itself refuses them and there is nothing for the app to validate.
      const cases: Array<[string, string, boolean]> = [
        ["above the requested quantity", String(requested + 1), true],
        ["negative", "-1", true],
        ["blank", "", false],
        ["zero", "0", false],
      ];
      for (const [what, value, mustBlock] of cases) {
        await quantity.fill(value);
        await page.waitForTimeout(250);
        const blocked = (await warning.count()) > 0 || await approve.isDisabled();
        if (mustBlock) {
          expect.soft(blocked, `A ${what} quantity ("${value}") must block Approve and show the inline warning.`).toBe(true);
        } else {
          log.info(`Quantity "${value}" (${what}) → Approve ${await approve.isDisabled() ? "disabled" : "enabled"}, warning ${(await warning.count()) ? "shown" : "hidden"}.`);
        }
        await capture(`quantity-${what.replace(/\s+/g, "-")}`);
      }
      await quantity.fill(original);
      await page.waitForTimeout(200);
    });

    // ---- N3 · a reason is required to reject or return -------------------------
    for (const [decision, button, confirmLabel] of [
      ["reject", "Reject", "Reject"],
      ["return", "Return for correction", "Return"],
    ] as const) {
      await log.runStep(`N3 · ${decision} refuses an empty and a whitespace-only reason`, async () => {
        await page.getByRole("button", { name: button, exact: true }).click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible({ timeout: 10_000 });

        const confirm = dialog.getByRole("button", { name: confirmLabel, exact: true });
        expect.soft(await confirm.isDisabled(), `${button}: Confirm must be disabled with an empty reason.`).toBe(true);
        await expect.soft(dialog.getByText("A reason is required.")).toBeVisible({ timeout: 5_000 });

        const reason = dialog.locator("textarea");
        await reason.fill("   ");
        await page.waitForTimeout(200);
        expect.soft(await confirm.isDisabled(), `${button}: Confirm must stay disabled for a whitespace-only reason.`).toBe(true);
        await capture(`${decision}-empty-reason`);

        await reason.fill("A real reason typed by the automated run.");
        await page.waitForTimeout(200);
        expect.soft(await confirm.isDisabled(), `${button}: Confirm should enable once a real reason is typed.`).toBe(false);

        // Dismiss without deciding — this spec never changes a document.
        await page.keyboard.press("Escape");
        const closed = await dialog.isHidden().catch(() => true);
        if (!closed) {
          const cancel = dialog.getByRole("button", { name: /cancel|close/i }).first();
          if (await cancel.count()) await cancel.click();
        }
        await expect(dialog).toBeHidden({ timeout: 10_000 });
      });
    }

    // ---- N4 · an over-long reason is refused by the backend, not the browser ----
    await log.runStep("N4 · a reason longer than 2000 characters is refused cleanly", async () => {
      const long = "x".repeat(2100);
      const response = await api.raw("post", `/api/approvals/indents/${target.id}/reject`, target.approver, { comments: long });
      expect.soft(response.status, `A 2100-character rejection reason answered ${response.status}. Expected 422.`).toBe(422);
      expect.soft(response.status, "An over-long reason must never reach a 500.").toBeLessThan(500);
      log.info(`Over-long reason → ${response.status}: ${response.body.slice(0, 300)}`);

      const after = await api.indent(target.id, reader(list)).catch(() => null);
      if (after) {
        expect.soft(after.status, `${target.indentNo} must still be pending after a refused reject; it is ${after.status}.`)
          .toBe("PENDING_APPROVAL");
      }
    });

    await context.dispose();
  });

  test("N8 · bad and stale ids in the review URL fail readably", async ({ page, log, goto, capture, playwright }) => {
    const context = await playwright.request.newContext({ baseURL: process.env.API_URL || "http://localhost:8000" });
    const api = new ApprovalsApi(context);
    const found = await api.firstApproverWithWork(list.approvers);
    const account = found?.account ?? list.approvers[0]!;
    await signIn(page, api, account, log);

    for (const [what, value] of [
      ["a non-existent id", "999999999"],
      ["zero", "0"],
      ["a negative id", "-5"],
      ["a non-numeric id", "abc"],
    ] as const) {
      await log.runStep(`N8 · reviewIndent=${value} (${what})`, async () => {
        await goto(`/approvals?reviewIndent=${value}`, `bad-id-${value}`);
        await page.waitForTimeout(250);

        const crashed = await page.locator("body").innerText();
        expect.soft(crashed.trim().length, `reviewIndent=${value} rendered a blank page.`).toBeGreaterThan(20);
        expect.soft(/\{"success":false|Traceback|Internal Server Error/i.test(crashed),
          `reviewIndent=${value} showed a raw error body instead of a message: ${crashed.slice(0, 200)}`).toBe(false);
        await capture(`bad-id-${value}`);
      });
    }

    await log.runStep("N8 · the API's own answer for a missing / invalid indent", async () => {
      for (const id of ["999999999", "0", "-5", "abc"]) {
        const response = await api.raw("get", `/api/approvals/indents/${id}`, account);
        expect.soft(response.status, `GET /api/approvals/indents/${id} answered ${response.status} — a 5xx is a defect.`)
          .toBeLessThan(500);
        log.info(`GET /api/approvals/indents/${id} → ${response.status} ${response.body.slice(0, 200)}`);
      }
    });

    await context.dispose();
  });
});
