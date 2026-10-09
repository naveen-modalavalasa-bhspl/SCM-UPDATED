import { test, expect } from "../../src/fixtures.js";
import { loginAs } from "../../src/pages/login.js";
import { loadUsers, type Account } from "../../src/config.js";

/**
 * "Serve what you hold" on the approval screen — the heart of the cascade.
 *
 *   SLOW_MO=1500 npx playwright test tests/stocking-points-flow/02 --headed
 *
 * The rule under test: a line's remainder is `approved − allocated`, an approver
 * issues what they hold against it, and the SAME indent travels on carrying only
 * what is still owed. No child documents.
 *
 * This spec drives the panel through the browser and reads the arithmetic back from
 * the API, so a pass means the screen and the ledger agree.
 */

const users = loadUsers();
const admin: Account = users.admin ?? users.raiser;

interface AvailabilityLine {
  line_id: number;
  item_name?: string | null;
  approved_quantity: number;
  allocated_quantity: number;
  remainder: number;
  available_at_my_points: number;
  issuable_now: number;
}

interface Availability {
  indent_no: string;
  target_warehouse_id: number | null;
  my_warehouse_ids: number[];
  items: AvailabilityLine[];
}

interface PendingRow { doc_id: number; doc_type: string; doc_no?: string | null }

/** The first indent actually waiting on one of the configured approvers. Discovered,
 *  never hardcoded: which rung holds a document changes every time the suite runs. */
async function findPendingIndent(api: any, pool: Account[]) {
  for (const account of pool) {
    const items: PendingRow[] = await api.pending(account).catch(() => []);
    const indent = items.find((row) => row.doc_type?.toUpperCase() === "INDENT");
    if (indent) return { account, indentId: indent.doc_id, indentNo: indent.doc_no };
  }
  return null;
}

test.describe("Approval screen — serve from your own stock", () => {
  test("the panel states the remainder and refuses what it cannot back", async ({
    page, api, log, goto, capture,
  }) => {
    const pool = [...(users.approvers ?? []), users.raiser, ...(users.inventory ? [users.inventory] : [])];
    const found = await log.runStep("Find an indent waiting on a configured approver", () =>
      findPendingIndent(api, pool),
    );
    test.skip(!found, "No indent is pending with any account in users.json.");
    const { account, indentId, indentNo } = found!;
    log.info(`target: ${indentNo ?? indentId} is with ${account.label}`);

    const before = await api.getAs<Availability>(
      `/api/approvals/indents/${indentId}/availability`, account,
    );
    log.info(
      `availability: ${before.items.length} line(s), ` +
      `owed=${before.items.reduce((s, l) => s + l.remainder, 0)}, ` +
      `target point=${before.target_warehouse_id ?? "UNTAGGED"}`,
    );

    await test.step("The remainder is approved minus what is already served", async () => {
      for (const line of before.items) {
        expect(
          line.remainder,
          `${line.item_name}: remainder must be approved(${line.approved_quantity}) ` +
          `- allocated(${line.allocated_quantity})`,
        ).toBeCloseTo(Math.max(line.approved_quantity - line.allocated_quantity, 0), 3);
        // Never offer to issue more than is owed, nor more than is held.
        expect(line.issuable_now).toBeLessThanOrEqual(line.remainder + 1e-9);
        expect(line.issuable_now).toBeLessThanOrEqual(line.available_at_my_points + 1e-9);
      }
    });

    await test.step("The panel renders on the review screen", async () => {
      await loginAs(page, account, log);
      await goto(`/approvals?reviewIndent=${indentId}`, "Approval review");

      const panel = page.getByText(/serve from your own stock/i);
      await expect(panel).toBeVisible({ timeout: 20_000 });
      await capture("issue-panel");

      // Whatever the data says, the screen must say the same thing.
      for (const line of before.items) {
        const label = `Issue quantity for ${line.item_name}`;
        const input = page.getByLabel(label);
        if (await input.count()) {
          const disabled = await input.first().isDisabled();
          expect(
            disabled,
            `${line.item_name}: the issue box should be disabled exactly when nothing is issuable`,
          ).toBe(line.issuable_now <= 0);
        }
      }

      const issueButton = page.getByRole("button", { name: /issue now/i });
      await expect(issueButton).toBeVisible();
      // Nothing typed yet, so the action must not be available.
      await expect(issueButton).toBeDisabled();
    });

    await test.step("An untagged requester is refused, not silently ignored", async () => {
      test.skip(
        before.target_warehouse_id !== null,
        "The requester is tagged, so this guard does not apply to this run.",
      );
      await expect(
        page.getByText(/not tagged to a stocking point/i),
      ).toBeVisible();
      log.info("guard: the screen explains why it cannot issue, and offers no button");
    });

    await test.step("Issue what is actually held, and watch the remainder fall", async () => {
      const servable = before.items.find((line) => line.issuable_now > 0);
      test.skip(
        !servable || before.target_warehouse_id === null,
        "Nobody holds any of what is owed (or the requester is untagged), so there is " +
        "nothing to issue. Tag the positions and put stock at the approver's point to " +
        "exercise this leg.",
      );

      const line = servable!;
      // One unit, not the whole line: this writes to the append-only ledger against
      // live data, so the smallest move that proves the rule is the right one.
      const qty = Math.min(1, line.issuable_now);
      await page.getByLabel(`Issue quantity for ${line.item_name}`).fill(String(qty));
      await page.getByLabel("Reason for this issue").fill("Playwright functional run");
      await capture("issue-filled");

      await page.getByRole("button", { name: /issue now/i }).click();
      await expect(page.getByText(/issued 1 line/i)).toBeVisible({ timeout: 20_000 });
      await capture("issue-done");

      const after = await api.getAs<Availability>(
        `/api/approvals/indents/${indentId}/availability`, account,
      );
      const updated = after.items.find((l) => l.line_id === line.line_id)!;
      log.info(
        `remainder: ${line.remainder} -> ${updated.remainder} ` +
        `(allocated ${line.allocated_quantity} -> ${updated.allocated_quantity})`,
      );

      expect(updated.allocated_quantity, "issuing must record what was served")
        .toBeCloseTo(line.allocated_quantity + qty, 3);
      expect(updated.remainder, "the remainder is what travels up with the indent")
        .toBeCloseTo(line.remainder - qty, 3);
    });
  });
});
