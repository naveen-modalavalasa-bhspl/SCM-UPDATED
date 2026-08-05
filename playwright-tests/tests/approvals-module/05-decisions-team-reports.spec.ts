import { test, expect } from "../../src/fixtures.js";
import { ApprovalsApi, listRows, statCard, users, signIn } from "./helpers.js";

/**
 * P9 and P10 — the three read screens: My Decisions, Team Queue and Reports.
 *
 * Read-only apart from one reminder, which is only sent when the screen itself
 * says there is somebody with pending work to remind.
 */

const list = users();

test.describe("Approvals — decisions, team queue and reports", () => {

  test("P9 · My Decisions history, filters, routing and export", async ({ page, log, goto, capture, playwright }) => {
    const context = await playwright.request.newContext({ baseURL: process.env.API_URL || "http://localhost:8000" });
    const api = new ApprovalsApi(context);

    let account = list.approvers[0]!;
    for (const candidate of list.approvers) {
      const rows = await api.decisions(candidate).catch(() => []);
      if (rows.length) { account = candidate; break; }
    }
    const decisions = await api.decisions(account).catch(() => []);
    log.info(`${account.label} has ${decisions.length} recorded decision(s).`);

    await signIn(page, api, account, log);
    await goto("/approvals/decisions", "my-decisions");
    await expect(page.getByRole("heading", { name: "My Decisions" })).toBeVisible({ timeout: 20_000 });

    await log.runStep("P9 · the history lists what the API recorded", async () => {
      const shown = await listRows(page).count();
      const expected = Math.min(decisions.length, 20);
      expect.soft(shown, `My Decisions shows ${shown} row(s); the API returns ${decisions.length} (page size 20).`).toBe(expected);
    });

    await log.runStep("P9 · the decision filter narrows the list", async () => {
      test.skip(!decisions.length, "No decisions recorded for this account.");
      // The shared Select is a HeroUI Autocomplete, not a native <select>: it is
      // driven by typing and picking an option.
      const select = page.getByLabel("Decision").first();
      for (const decision of ["APPROVED", "REJECTED", "RETURNED"]) {
        const expected = decisions.filter((row: any) => row.decision === decision).length;
        await select.fill("");
        await select.click();
        const option = page.getByRole("option", { name: new RegExp(`^${decision}$`, "i") }).first();
        if (!(await option.count())) {
          log.warn("assert", `The Decision filter offers no "${decision}" option.`);
          continue;
        }
        await option.click();
        await page.waitForTimeout(250);
        const shown = await listRows(page).count();
        log.info(`Filter ${decision}: ${shown} shown, ${expected} in the API data.`);
        if (!expected) {
          expect.soft(shown, `Filtering by ${decision} should show nothing — the account has none.`).toBe(0);
        } else {
          expect.soft(shown, `Filtering by ${decision} emptied a list that should hold ${expected} row(s).`).toBeGreaterThan(0);
        }
      }
      await select.fill("");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(350);
    });

    await log.runStep("P9 · search finds a decision by document number", async () => {
      test.skip(!decisions.length, "No decisions recorded for this account.");
      const sample: any = decisions[0];
      const term = sample.doc_no ?? String(sample.doc_id);
      await page.getByLabel("Search decisions").fill(String(term));
      await page.waitForTimeout(250);
      expect.soft(await listRows(page).count(), `Searching My Decisions for "${term}" returned nothing.`).toBeGreaterThan(0);
      await capture("decisions-search");
      await page.getByLabel("Search decisions").fill("");
      await page.waitForTimeout(300);
    });

    await log.runStep("P9 · a decided row opens a read-only screen, not an action screen", async () => {
      test.skip(!decisions.length, "No decisions recorded for this account.");
      const button = page.getByRole("button", { name: "View details" }).first();
      test.skip(!(await button.count()), "No rows rendered to open.");
      await button.click();
      await page.waitForTimeout(300);
      const url = page.url();
      log.info(`My Decisions row opened ${url}`);
      expect.soft(/reviewIndent=/.test(url),
        `A completed decision must not reopen the action-only review screen (${url}).`).toBe(false);
      const text = await page.locator("body").innerText();
      expect.soft(/Traceback|Internal Server Error|\{"success"/i.test(text),
        `The read-only screen showed a raw error: ${text.slice(0, 250)}`).toBe(false);
      await capture("decision-detail");
      await goto("/approvals/decisions", "back-to-decisions");
    });

    await log.runStep("P9 · Export Excel downloads a workbook", async () => {
      const button = page.getByRole("button", { name: /Export Excel/i }).first();
      if (await button.isDisabled()) {
        expect.soft(decisions.length, "Export is disabled although there are decisions to export.").toBe(0);
        return;
      }
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 20_000 }).catch(() => null),
        button.click(),
      ]);
      expect.soft(download, "Export Excel produced no download.").not.toBeNull();
      if (download) log.info(`Downloaded ${download.suggestedFilename()}`);
    });

    await context.dispose();
  });

  test("P10 · Team Queue rows, reminders, and the Reports screen end to end", async ({ page, log, goto, capture, playwright }) => {
    const context = await playwright.request.newContext({ baseURL: process.env.API_URL || "http://localhost:8000" });
    const api = new ApprovalsApi(context);

    // Pick whichever configured approver actually has a team below them. The
    // endpoint is asked for every account, because a 500 here is itself a finding
    // and must not be swallowed into "this person has no team".
    let account = list.approvers[0]!;
    let team: any[] = [];
    for (const candidate of list.approvers) {
      const response = await api.raw("get", "/api/approvals/team-queue", candidate);
      if (!response.ok) {
        log.problem("http-error", `GET /api/approvals/team-queue as ${candidate.label} → ${response.status} ${response.body.slice(0, 200)}`);
        expect.soft(response.status, `Team Queue answered ${response.status} for ${candidate.label}.`).toBeLessThan(500);
        continue;
      }
      const items = response.json?.items ?? [];
      log.info(`${candidate.label}: team-queue returns ${items.length} row(s).`);
      if (items.length) { account = candidate; team = items; break; }
    }
    log.info(`Driving Team Queue as ${account.label} (${team.length} team member(s) from the API).`);

    await signIn(page, api, account, log);

    await log.runStep("P10 · Team Queue matches the API and the reminder works", async () => {
      await goto("/approvals/team-queue", "team-queue");
      await expect(page.getByRole("heading", { name: "Team Queue" })).toBeVisible({ timeout: 20_000 });
      const shown = await listRows(page).count();
      expect.soft(shown, `Team Queue shows ${shown} row(s); the API returns ${team.length}.`).toBe(team.length);

      const withWork = team.find((row: any) => row.pending_count > 0);
      if (!withWork) {
        log.info("Nobody in the team has pending work — the reminder path cannot be exercised.");
        return;
      }
      const row = page.locator("table tbody tr").filter({ hasText: String(withWork.approver_name) }).first();
      const remind = (await row.count()) ? row.getByRole("button", { name: /Remind/i }) : page.getByRole("button", { name: /Remind/i }).first();
      const [response] = await Promise.all([
        page.waitForResponse((r) => /\/api\/approvals\/team-queue\/\d+\/remind$/.test(new URL(r.url()).pathname), { timeout: 30_000 }).catch(() => null),
        remind.click(),
      ]);
      if (response) {
        expect.soft(response.ok(), `Remind answered ${response.status()}: ${await response.text()}`).toBe(true);
      }
      await expect.soft(page.getByText("Reminder sent.")).toBeVisible({ timeout: 15_000 });
      await capture("team-queue-reminder");
    });

    await log.runStep("P10 · the Reports screen loads its KPIs", async () => {
      await goto("/approvals?view=reports", "reports");
      await expect(page.getByRole("heading", { name: "Approval reports" })).toBeVisible({ timeout: 25_000 });
      const summary = await api.ok<any>("/api/approvals/reports/summary", account).catch(() => null);
      for (const label of ["Total requests", "Pending", "Approved", "Rejected", "Returned", "Overdue", "Average approval time", "Approval success rate"]) {
        const value = await statCard(page, label).catch(() => "");
        expect.soft(value, `The "${label}" KPI never rendered a value.`).not.toBe("");
        expect.soft(value, `The "${label}" KPI is stuck on its loading placeholder.`).not.toBe("—");
        log.info(`KPI ${label} = ${value}`);
      }
      if (summary) log.info(`API summary: ${JSON.stringify(summary)}`);
      await capture("reports-kpis");
    });

    await log.runStep("P10 · every report filter narrows the table without breaking it", async () => {
      const before = await listRows(page).count();
      log.info(`Report table starts with ${before} row(s).`);

      for (const preset of ["Last 7 days", "Last 30 days", "All time"]) {
        await page.getByRole("button", { name: preset, exact: true }).click();
        await page.waitForTimeout(350);
        log.info(`Report range ${preset}: ${await listRows(page).count()} row(s).`);
      }

      await page.getByRole("button", { name: "Custom", exact: true }).click();
      const from = page.getByLabel("Report from date");
      const to = page.getByLabel("Report to date");
      await expect.soft(from, "Custom range must reveal the report date inputs.").toBeVisible({ timeout: 8_000 });
      const today = new Date().toISOString().slice(0, 10);
      const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
      await from.fill(monthAgo);
      await to.fill(today);
      await page.waitForTimeout(350);
      expect.soft(await from.getAttribute("max"), "The report From date must be clamped to the To date.").toBe(today);

      for (const [label, name] of [
        ["Document type", "document type"],
        ["Decision status", "decision status"],
        ["Approval stage", "approval stage"],
        ["Approver", "approver"],
      ] as const) {
        const select = page.getByLabel(label);
        const options = await select.locator("option").allInnerTexts();
        if (options.length > 1) {
          await select.selectOption({ index: 1 });
          await page.waitForTimeout(350);
          log.info(`Report filtered by ${name} = "${options[1]}": ${await listRows(page).count()} row(s).`);
          await select.selectOption({ index: 0 });
          await page.waitForTimeout(250);
        } else {
          log.info(`The ${name} filter has no values to choose from.`);
        }
      }

      await page.getByLabel("Requester filter").fill("zzz-no-such-requester");
      await page.waitForTimeout(200);
      await expect.soft(page.getByText("No approval records match these report filters.").first(),
        "A report filter matching nothing must show the empty state.").toBeVisible({ timeout: 10_000 });
      await capture("reports-empty-filter");

      await page.getByRole("button", { name: "Overdue only" }).click();
      await page.waitForTimeout(300);
      const reset = page.getByRole("button", { name: /^Reset$/ });
      expect.soft(await reset.count(), "Reset should appear once report filters are active.").toBeGreaterThan(0);
      if (await reset.count()) await reset.first().click();
      await page.waitForTimeout(350);
      expect.soft(await page.getByLabel("Requester filter").inputValue(), "Reset must clear the requester filter.").toBe("");
    });

    await log.runStep("P10 · the report charts render", async () => {
      for (const title of ["Decision trend", "Pending ageing"]) {
        await expect.soft(page.getByRole("heading", { name: title }), `The "${title}" chart is missing.`)
          .toBeVisible({ timeout: 10_000 });
      }
      await capture("reports-charts");
    });

    await log.runStep("P10 · the report exports to Excel", async () => {
      const button = page.getByRole("button", { name: /Export Excel/i }).first();
      if (await button.isDisabled()) {
        log.info("Report export is disabled — the filtered table is empty.");
        return;
      }
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 20_000 }).catch(() => null),
        button.click(),
      ]);
      expect.soft(download, "The report Export Excel button produced no download.").not.toBeNull();
      if (download) log.info(`Downloaded ${download.suggestedFilename()}`);
    });

    await context.dispose();
  });
});
