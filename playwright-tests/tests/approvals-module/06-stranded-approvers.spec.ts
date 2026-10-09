import { test, expect } from "../../src/fixtures.js";
import { ApprovalsApi, listRows, users, signIn } from "./helpers.js";

/**
 * Every configured approver must be able to REACH the work assigned to them.
 *
 * A ladder rung that resolves to somebody whose working position carries no
 * approval permission strands the document: the API still hands them the task,
 * but the left rail never offers Approvals and the screen has nothing to open.
 * This checks each account for that gap, which no single-user journey can see.
 */

const list = users();

test.describe("Approvals — nobody holds work they cannot reach", () => {
  test("every configured approver can open the queue that holds their work", async ({ page, log, goto, capture, playwright }) => {
    const context = await playwright.request.newContext({ baseURL: process.env.API_URL || "http://localhost:8000" });
    const api = new ApprovalsApi(context);

    for (const account of list.approvers) {
      await log.runStep(`Can ${account.label} reach their own approvals?`, async () => {
        const me = await api.raw("get", "/api/auth/me", account);
        const menu = (me.json?.menu ?? []).map((entry: any) => entry.label ?? entry.name ?? entry.code);
        const permissions = (me.json?.permissions ?? []).length;
        const pending = await api.pending(account).catch(() => []);
        log.info(`${account.label}: ${pending.length} pending, ${permissions} permission(s), menu = ${menu.join(" / ") || "(empty)"}`);

        if (!pending.length) return;

        expect.soft(menu.some((label: string) => /approval/i.test(String(label))),
          `${account.label} holds ${pending.length} pending approval(s) but the navigation offers no Approvals entry `
          + `(menu: ${menu.join(", ") || "empty"}, ${permissions} permissions). Those documents cannot be acted on.`)
          .toBe(true);

        await signIn(page, api, account, log);
        await goto("/approvals", `queue-${account.employeeId}`);
        await page.waitForTimeout(250);

        const heading = await page.getByRole("heading", { name: "Waiting for me" }).count();
        expect.soft(heading, `${account.label} cannot open /approvals at all — the screen never rendered.`).toBeGreaterThan(0);
        if (heading) {
          expect.soft(await listRows(page).count(),
            `${account.label} has ${pending.length} pending approval(s) but their queue renders no rows.`)
            .toBeGreaterThan(0);
        }
        await capture(`reachability-${account.employeeId}`);
      });
    }

    await context.dispose();
  });
});
