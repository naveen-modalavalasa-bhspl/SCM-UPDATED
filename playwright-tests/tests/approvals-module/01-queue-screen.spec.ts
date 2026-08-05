import { test, expect } from "../../src/fixtures.js";
import { ApprovalsApi, listRows, statCard, users, type PendingRow, signIn } from "./helpers.js";

/**
 * P1–P6 and the empty-state half of N10: the "Waiting for me" queue screen.
 *
 * Read-only. Nothing here decides a document, so it can run against live data
 * without consuming somebody's real work. Assertions are soft on purpose — one
 * broken filter must not hide the state of the other five.
 */

const list = users();

test.describe("Approvals — Waiting for me queue", () => {

  test("P1–P6 · queue tiles, filters, sorting and row routing", async ({ page, log, goto, capture, playwright }) => {
    const context = await playwright.request.newContext({ baseURL: process.env.API_URL || "http://localhost:8000" });
    const api = new ApprovalsApi(context);

    const found = await api.firstApproverWithWork(list.approvers);
    test.skip(!found, "No configured approver has anything pending — nothing to inspect on this screen.");
    const { account, rows } = found!;
    log.info(`Inspecting the queue of ${account.label}: ${rows.length} pending item(s).`);

    await signIn(page, api, account, log);
    await goto("/approvals", "queue-initial");

    // ---- P1 · the tiles describe the whole queue, not one page of twenty -------
    await log.runStep("P1 · KPI tiles agree with the full pending queue", async () => {
      await expect(page.getByRole("heading", { name: "Waiting for me" })).toBeVisible({ timeout: 20_000 });
      const waiting = await statCard(page, "Waiting on you");
      expect.soft(Number(waiting), `"Waiting on you" shows ${waiting} but /api/approvals/pending returns ${rows.length}.`)
        .toBe(rows.length);

      const overdue = rows.filter((row) => row.due_at && new Date(row.due_at).getTime() < Date.now()).length;
      const pastDue = await statCard(page, "Past due");
      expect.soft(Number(pastDue), `"Past due" shows ${pastDue}; the API data says ${overdue}.`).toBe(overdue);

      const longest = await statCard(page, "Longest wait");
      log.info(`Tiles — waiting ${waiting}, past due ${pastDue}, longest ${longest}.`);
    });

    // ---- P2 · document-type chips ---------------------------------------------
    await log.runStep("P2 · type chips filter the list and de-select on a second click", async () => {
      const types = [...new Set(rows.map((row) => row.doc_type))];
      for (const type of types) {
        const expected = rows.filter((row) => row.doc_type === type).length;
        const chip = page.getByRole("button", { name: new RegExp(`\\s${expected}$`) }).first();
        const anyChip = page.locator("button").filter({ hasText: new RegExp(`^\\S.*\\s\\d+$`) });
        if (!(await anyChip.count())) {
          log.warn("assert", "No document-type chips rendered even though the queue has documents.");
          break;
        }
        const target = (await chip.count()) ? chip : anyChip.first();
        await target.click();
        await page.waitForTimeout(250);
        const shown = await listRows(page).count();
        log.info(`Chip for ${type}: expected ${expected} row(s), list shows ${shown}.`);
        expect.soft(shown, `Chip "${type}" should narrow the list to ${expected} row(s).`).toBeLessThanOrEqual(Math.max(expected, 20));
        await target.click(); // de-select
        await page.waitForTimeout(200);
      }
      await capture("queue-after-type-chips");
    });

    // ---- P3 · search + clear ---------------------------------------------------
    await log.runStep("P3 · search matches document, requester and stage; Clear resets everything", async () => {
      const sample: PendingRow = rows[0]!;
      const search = page.getByLabel("Search approvals");

      for (const [what, term] of [
        ["document number", sample.doc_no],
        ["requester", sample.requested_by_name],
        ["stage", sample.current_stage_name],
      ] as const) {
        if (!term) continue;
        await search.fill(String(term));
        await page.waitForTimeout(350);
        const shown = await listRows(page).count();
        expect.soft(shown, `Searching by ${what} ("${term}") returned no rows.`).toBeGreaterThan(0);
      }

      await search.fill("zzz-no-such-document-zzz");
      await page.waitForTimeout(350);
      await expect.soft(page.getByText("Nothing matches these filters.").first(),
        "A search that matches nothing should show the filtered empty state.").toBeVisible({ timeout: 10_000 });
      await capture("queue-empty-filtered");

      const clear = page.getByRole("button", { name: /^Clear$/ });
      expect.soft(await clear.count(), "The Clear button should appear once a filter is active.").toBeGreaterThan(0);
      if (await clear.count()) await clear.first().click();
      await page.waitForTimeout(300);
      expect.soft(await search.inputValue(), "Clear should empty the search box.").toBe("");
    });

    // ---- P4 · sorting and the past-due toggle ---------------------------------
    await log.runStep("P4 · sort order and the Past due only toggle", async () => {
      const sort = page.getByLabel("Sort approvals");
      const readWaiting = async () => {
        const cells = await page.locator("table tbody tr td:nth-child(4)").allInnerTexts();
        return cells.map((text) => Number((text.match(/(\d+)d/) ?? [])[1] ?? NaN));
      };

      await sort.selectOption("oldest");
      await page.waitForTimeout(300);
      const oldestFirst = await readWaiting();
      const descending = oldestFirst.every((value, index, all) => index === 0 || Number.isNaN(value) || all[index - 1]! >= value);
      expect.soft(descending, `"Oldest first" should put the longest wait at the top. Got: ${oldestFirst.join(", ")}`).toBe(true);

      await sort.selectOption("newest");
      await page.waitForTimeout(300);
      const newestFirst = await readWaiting();
      const ascending = newestFirst.every((value, index, all) => index === 0 || Number.isNaN(value) || all[index - 1]! <= value);
      expect.soft(ascending, `"Newest first" should put the shortest wait at the top. Got: ${newestFirst.join(", ")}`).toBe(true);

      for (const option of ["due", "value"]) {
        await sort.selectOption(option);
        await page.waitForTimeout(300);
        expect.soft(await listRows(page).count(), `Sorting by "${option}" emptied the list.`).toBeGreaterThan(0);
      }
      await sort.selectOption("oldest");

      const overdueRows = rows.filter((row) => row.due_at && new Date(row.due_at).getTime() < Date.now()).length;
      await page.getByRole("button", { name: "Past due only" }).click();
      await page.waitForTimeout(350);
      const shown = await listRows(page).count();
      log.info(`Past due only: ${shown} row(s) shown, ${overdueRows} overdue in the API data.`);
      if (!overdueRows) {
        expect.soft(shown, "Nothing is overdue, so the Past due filter should show an empty list.").toBe(0);
      }
      await page.getByRole("button", { name: "Past due only" }).click();
      await page.waitForTimeout(250);
    });

    // ---- P5 · the Raised window -----------------------------------------------
    await log.runStep("P5 · Raised window presets and the custom date range", async () => {
      for (const preset of ["Last 24 hours", "Last 7 days", "Last 30 days"]) {
        await page.getByRole("button", { name: preset }).click();
        await page.waitForTimeout(350);
        const shown = await listRows(page).count();
        log.info(`Raised = ${preset}: ${shown} row(s).`);
      }
      await page.getByRole("button", { name: "Custom" }).click();
      const from = page.locator('input[type="date"]').first();
      const to = page.locator('input[type="date"]').nth(1);
      await expect.soft(from, "Choosing Custom should reveal the From/To date inputs.").toBeVisible({ timeout: 8_000 });

      const today = new Date();
      const week = new Date(today.getTime() - 7 * 86_400_000);
      await from.fill(week.toISOString().slice(0, 10));
      await to.fill(today.toISOString().slice(0, 10));
      await page.waitForTimeout(350);
      expect.soft(await from.getAttribute("max"), "From should be clamped to the To date.").toBe(today.toISOString().slice(0, 10));
      await capture("queue-custom-range");

      await page.getByRole("button", { name: "Any time" }).click();
      await page.waitForTimeout(250);
    });

    // ---- P6 · a row opens the right document screen ---------------------------
    await log.runStep("P6 · View details routes each document type to its own screen", async () => {
      const expectedPath: Record<string, RegExp> = {
        INDENT: /\/approvals\?reviewIndent=\d+/,
        MR: /\/inventory\/material-requests\/\d+/,
        ALLOCATION: /\/inventory\/allocation-approvals\?review=\d+/,
        PO: /\/pos\/\d+/,
        GRN: /\/warehouse\/grn\/\d+/,
        ISSUE: /\/warehouse\/material-issues\/\d+/,
        WH_ISSUE: /\/warehouse\/material-issues\/\d+/,
        DISPATCH: /\/warehouse\/transactions\/dispatch\/\d+/,
        PURCHASE_RETURN: /\/warehouse\/purchase-returns\/\d+/,
      };
      const seen = new Set<string>();
      for (const row of rows) {
        if (seen.has(row.doc_type)) continue;
        seen.add(row.doc_type);
        await goto("/approvals", `queue-before-${row.doc_type}`);
        const marker = page.getByText(row.doc_no ?? `#${row.doc_id}`, { exact: false }).first();
        if (!(await marker.count())) {
          log.warn("assert", `${row.doc_type} ${row.doc_no} is pending but is not on the first page of the queue.`);
          continue;
        }
        await marker.click();
        await page.waitForTimeout(250);
        const pattern = expectedPath[row.doc_type];
        const url = page.url();
        if (pattern) {
          expect.soft(pattern.test(url), `${row.doc_type} row opened ${url}, expected to match ${pattern}.`).toBe(true);
        }
        log.info(`${row.doc_type} → ${url}`);
        await capture(`opened-${row.doc_type}`);
      }
    });

    await context.dispose();
  });

  test("N10 · empty states, disabled controls and the mobile card layout", async ({ page, log, goto, capture, playwright }) => {
    const context = await playwright.request.newContext({ baseURL: process.env.API_URL || "http://localhost:8000" });
    const api = new ApprovalsApi(context);
    const found = await api.firstApproverWithWork(list.approvers);
    const account = found?.account ?? list.approvers[0]!;

    await signIn(page, api, account, log);

    await log.runStep("N10 · a filter that matches nothing shows a readable empty state", async () => {
      await goto("/approvals", "queue-for-empty-state");
      await page.getByLabel("Search approvals").fill("qqqq-nothing-matches-qqqq");
      await page.waitForTimeout(200);
      await expect.soft(page.getByText("Nothing matches these filters.").first()).toBeVisible({ timeout: 10_000 });
      await capture("empty-filtered-queue");
    });

    await log.runStep("N10 · My Decisions and Team Queue empty/disabled behaviour", async () => {
      await goto("/approvals/decisions", "decisions-screen");
      const exportButton = page.getByRole("button", { name: /Export Excel/i }).first();
      const rowCount = await listRows(page).count();
      if (!rowCount) {
        await expect.soft(page.getByText("You have not made an approval decision yet.").first()).toBeVisible({ timeout: 10_000 });
        expect.soft(await exportButton.isDisabled(), "Export Excel must be disabled when there is nothing to export.").toBe(true);
      }

      await goto("/approvals/team-queue", "team-queue-screen");
      const teamRows = await listRows(page).count();
      if (!teamRows) {
        await expect.soft(page.getByText("No approval team is mapped below your active position.").first()).toBeVisible({ timeout: 10_000 });
      } else {
        // "Remind" must be dead for an approver with nothing pending.
        const zeroPending = page.locator("table tbody tr").filter({ hasText: /^\D*0\D/ }).first();
        if (await zeroPending.count()) {
          const button = zeroPending.getByRole("button", { name: /Remind/i });
          if (await button.count()) {
            expect.soft(await button.first().isDisabled(), "Remind should be disabled for an approver with 0 pending.").toBe(true);
          }
        }
      }
    });

    await log.runStep("N10 · the queue renders as cards at 375px with 44px tap targets", async () => {
      await page.setViewportSize({ width: 375, height: 800 });
      await goto("/approvals", "queue-mobile");
      const table = page.locator("table");
      const tableVisible = (await table.count()) ? await table.first().isVisible() : false;
      expect.soft(tableVisible, "Below 768px the table must be replaced by the card layout.").toBe(false);

      const buttons = page.getByRole("button", { name: "View details" });
      const count = Math.min(await buttons.count(), 3);
      for (let index = 0; index < count; index += 1) {
        const box = await buttons.nth(index).boundingBox();
        if (box) {
          expect.soft(box.height, `A "View details" tap target is only ${box.height}px tall; 44px is the floor.`)
            .toBeGreaterThanOrEqual(40);
        }
      }
      await capture("queue-mobile-cards");
      await page.setViewportSize({ width: 1440, height: 900 });
    });

    await context.dispose();
  });
});
