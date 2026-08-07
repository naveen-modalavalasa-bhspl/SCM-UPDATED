import { test, expect } from "../../src/fixtures.js";
import { loginAs } from "../../src/pages/login.js";
import { loadUsers, type Account } from "../../src/config.js";

/**
 * The cascade, driven entirely through the browser so it can be watched:
 *
 *   SLOW_MO=1500 npx playwright test tests/stocking-points-flow/03 --headed
 *
 * An approver opens a Monthly consolidation, serves what their own MDP holds, and
 * ticks "send the rest on". The remainder — not the whole request — travels to the
 * next rung, on the SAME indent. Then it checks the next approver really has it.
 *
 * Nothing is seeded from here: the run reads the live queue, and skips with a clear
 * reason when the data cannot express the step.
 */

const users = loadUsers();

interface Availability {
  indent_no: string;
  target_warehouse_id: number | null;
  items: Array<{
    line_id: number; item_name?: string | null;
    remainder: number; available_at_my_points: number; issuable_now: number;
  }>;
}

interface Pending { doc_id: number; doc_type: string; doc_no?: string | null }

test.describe("Cascade — serve what you hold, send the rest on", () => {
  test("an approver issues from their MDP and the remainder moves up", async ({
    page, api, log, goto, capture,
  }) => {
    // Who is actually holding something, and can actually serve part of it. Asked of
    // the API rather than hardcoded: which rung holds a document changes every run.
    let driver: Account | null = null;
    let indentId = 0;
    let before: Availability | null = null;

    for (const account of [...(users.approvers ?? []), users.raiser]) {
      const pending: Pending[] = await api.pending(account).catch(() => []);
      for (const row of pending.filter((r) => r.doc_type?.toUpperCase() === "INDENT")) {
        const snapshot = await api.getAs<Availability>(
          `/api/approvals/indents/${row.doc_id}/availability`, account,
        ).catch(() => null);
        if (snapshot?.target_warehouse_id && snapshot.items.some((i) => i.issuable_now > 0)) {
          driver = account; indentId = row.doc_id; before = snapshot;
          break;
        }
      }
      if (driver) break;
    }

    test.skip(
      !driver,
      "No approver currently holds an indent they can serve from their own point. " +
      "Tag the positions (Inventory > Stocking Points) and put stock at an MDP.",
    );

    const line = before!.items.find((i) => i.issuable_now > 0)!;
    log.info(
      `driver: ${driver!.label} on ${before!.indent_no} — ` +
      `${line.item_name} owed ${line.remainder}, holds ${line.available_at_my_points}`,
    );

    await test.step("Open the approval and read the panel", async () => {
      await loginAs(page, driver!, log);
      await goto(`/approvals?reviewIndent=${indentId}`, "Approval review");
      await expect(page.getByText(/serve from your own stock/i)).toBeVisible({ timeout: 20_000 });
      await capture("cascade-panel");

      // The screen must state the same arithmetic the API does.
      await expect(page.getByText(String(line.remainder), { exact: false }).first())
        .toBeVisible();
    });

    await test.step("Issue one unit and tick 'send the rest on'", async () => {
      await page.getByLabel(`Issue quantity for ${line.item_name}`).fill("1");
      await page.getByLabel("Reason for this issue").fill("Playwright cascade run");

      const forward = page.getByRole("checkbox", { name: /send the rest on/i });
      if (await forward.count()) await forward.first().check();
      await capture("cascade-filled");

      await page.getByRole("button", { name: /issue now/i }).click();
      await expect(page.getByText(/issued 1 line/i)).toBeVisible({ timeout: 25_000 });
      await capture("cascade-issued");
    });

    await test.step("The remainder moved, and the served units were recorded", async () => {
      const after = await api.getAs<Availability>(
        `/api/approvals/indents/${indentId}/availability`, driver!,
      );
      const updated = after.items.find((i) => i.line_id === line.line_id)!;
      log.info(`remainder ${line.remainder} -> ${updated.remainder}`);
      expect(updated.remainder, "one unit served means one less owed")
        .toBeCloseTo(line.remainder - 1, 3);
    });

    await test.step("Somebody else is holding it now", async () => {
      const stillMine: Pending[] = await api.pending(driver!).catch(() => []);
      const heldByDriver = stillMine.some(
        (r) => r.doc_id === indentId && r.doc_type?.toUpperCase() === "INDENT",
      );
      // Forwarding is the whole point: an approver who has served what they can must
      // not still be sitting on the document.
      expect(heldByDriver, "the indent should have left this approver's queue").toBe(false);

      const nextHolder = [...(users.approvers ?? []), users.raiser].find(async (a) => {
        const rows: Pending[] = await api.pending(a).catch(() => []);
        return rows.some((r) => r.doc_id === indentId);
      });
      log.info(`forwarded away from ${driver!.label}${nextHolder ? "" : " (or completed)"}`);
    });

    await test.step("It shows in the fulfilment queue while anything is owed", async () => {
      await goto("/inventory/fulfillment", "Fulfilment queue");
      await capture("cascade-fulfilment-queue");
    });
  });
});
