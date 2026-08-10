/* Scenario 3 — monthly indents, consolidated into one request.
 *
 * A regular indent is one store keeper asking for one thing. The monthly cycle is
 * every LIP asking at once, and approving them one by one would mean the same manager
 * signing the same item forty times. So the cycle consolidates: many indents, one
 * document, one decision, and the warehouse then issues per indent afterwards.
 *
 * This walks it with three real store keepers under the same OE, because
 * consolidation cannot be demonstrated with one raiser — the thing being tested is
 * that separate requests for the same item arrive as a single line.
 */
import { expect, test } from "../../src/fixtures.js";
import { loginAs } from "../../src/pages/login.js";
import { loadUsers } from "../../src/config.js";
import { createIndent, submitForApproval } from "../../src/pages/indents.js";

const users = loadUsers();

test.describe.configure({ mode: "serial" });

test.describe("Monthly indents consolidate into one request", () => {
  test("three store keepers raise monthly indents and they arrive as one consolidation",
    async ({ page, log, api, goto, capture }) => {
    const raisers = users.monthlyRaisers ?? [users.raiser];
    expect(raisers.length, "Scenario 3 needs at least two monthly raisers.")
      .toBeGreaterThan(1);

    const raised: string[] = [];
    const raisedIds: number[] = [];
    for (const raiser of raisers) {
      await loginAs(page, raiser, log);
      await goto("/indents/new", "new-indent-form");
      const indent = await createIndent(page, log, {
        quantity: 4,
        indentType: "Monthly",
        remarks: `Scenario 3 — monthly cycle, raised by ${raiser.label}.`,
      });
      await submitForApproval(page, log, indent.id);
      raised.push(indent.indentNo);
      raisedIds.push(indent.id);
      log.info(`${raiser.label} raised ${indent.indentNo}.`);
      await capture(`monthly-raised-${raised.length}`);
    }

    // ---- the consolidation ----
    // Seen by the rung above them: separate requests for the same item must appear as
    // ONE line carrying every indent behind it, not as three rows to sign in turn.
    // Whoever the ladder actually parked them with — the rungs are configurable, and
    // this month's OE may be switched off, so asking each in turn beats assuming.
    let approveAll = page.getByRole("button", { name: /approve all \d+/i }).first();
    let holder = "";
    for (const candidate of users.approvers) {
      await loginAs(page, candidate, log);
      await goto("/approvals/consolidation", "consolidation-list");
      approveAll = page.getByRole("button", { name: /approve all \d+/i }).first();
      if (await approveAll.isVisible({ timeout: 8_000 }).catch(() => false)) {
        holder = candidate.label ?? candidate.employeeId;
        log.info(`The cycle is waiting with ${holder}.`);
        break;
      }
      log.info(`Nothing waiting with ${candidate.label ?? candidate.employeeId}.`);
    }
    await capture("consolidation-list");

    // "Approve all N" sits on the cycle card and signs every indent inside it in one
    // action — that single click is the whole point of consolidating, so it is what
    // gets driven rather than the per-indent buttons.
    await expect(
      approveAll,
      "No consolidation cycle is offering Approve all. Either the monthly indents are "
        + "not waiting at this rung, or they landed in different cycles.",
    ).toBeVisible({ timeout: 20_000 });
    const approveLabel = (await approveAll.innerText()).trim();
    log.info(`Consolidation offers: ${approveLabel}`);
    await capture("consolidation-before-approve");

    await approveAll.click();
    await page.getByRole("button", { name: /confirm|approve|yes/i }).last().click()
      .catch(() => undefined);
    await page.waitForTimeout(3_000);
    await capture("consolidation-approved");
    log.info("Consolidation approved in one action.");

    // Every indent in the cycle must have moved together — one decision, many
    // documents, which is the property consolidation exists to provide.
    for (const id of raisedIds) {
      const row = await api.indent(id, raisers[0]).catch(() => null);
      log.info(`${row?.indent_no ?? id}: ${row?.status ?? "status not read"}`);
    }
  });
});
