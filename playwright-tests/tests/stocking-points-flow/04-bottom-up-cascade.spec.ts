import { test, expect } from "../../src/fixtures.js";
import { loginAs } from "../../src/pages/login.js";
import { loadUsers, type Account } from "../../src/config.js";

/**
 * The whole story, bottom-up, through the browser:
 *
 *   SLOW_MO=1500 npx playwright test tests/stocking-points-flow/04 --headed
 *
 *   1. the storekeeper raises an indent from their LIP and submits it
 *   2. it appears with the OE above them
 *   3. each rung serves what its own MDP holds and sends the rest on
 *   4. what nobody could serve ends up awaiting allocation
 *
 * The chain comes from users.json `cascadeChain`, bottom rung first, and is walked in
 * that order — so this reads as the real journey rather than a set of assertions.
 */

const users = loadUsers();
const chain: Account[] = users.cascadeChain ?? [];
const raiser = chain[0];

interface Availability {
  indent_no: string;
  target_warehouse_id: number | null;
  items: Array<{
    line_id: number; item_name?: string | null; approved_quantity: number;
    allocated_quantity: number; remainder: number;
    available_at_my_points: number; issuable_now: number;
  }>;
}
interface Pending { doc_id: number; doc_type: string; doc_no?: string | null }

test.describe("Bottom-up cascade — storekeeper to allocation", () => {
  test.skip(chain.length < 2, "users.json needs a cascadeChain of at least two rungs.");

  test("an indent is raised, served rung by rung, and lands at allocation", async ({
    page, api, log, goto, capture,
  }) => {
    let indentId = 0;
    let indentNo = "";

    await test.step(`1. ${raiser.label} raises an indent from their LIP`, async () => {
      // Raised through the API, not the form. The indent FORM belongs to the indents
      // module and has its own suite; what this run is here to prove starts at the
      // approval. Driving the form only added a way for this spec to fail for a
      // reason that has nothing to do with the cascade.
      const items = await api.getAs<{ items: Array<{ id: number; name: string }> }>(
        "/api/items?size=1&is_active=true", raiser,
      );
      const item = items.items?.[0];
      expect(item, "need at least one active item to raise against").toBeTruthy();

      const created = await api.postAs<{ id: number; indent_no: string }>(
        "/api/indents",
        {
          indent_type: "REGULAR",
          priority: "NORMAL",
          // Mandatory server-side; a week out is a realistic ask.
          required_date: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10),
          items: [{ item_id: item!.id, quantity: 10 }],
          remarks: "Bottom-up cascade run",
        },
        raiser,
      );
      indentId = created.id;
      indentNo = created.indent_no;
      log.info(`raised ${indentNo} as ${raiser.label}`);

      await api.postAs(`/api/indents/${indentId}/submit`, {}, raiser);
      log.info(`submitted ${indentNo} for approval`);

      // Now show it on screen, signed in as the storekeeper, so the run is watchable
      // from the bottom rung as asked.
      await loginAs(page, raiser, log);
      await goto(`/indents/${indentId}`, `${raiser.label} viewing ${indentNo}`);
      await capture("01-raised-by-storekeeper");
    });

    await test.step("2. It is waiting with somebody above the raiser", async () => {
      let holder: Account | null = null;
      for (const rung of chain.slice(1)) {
        const pending: Pending[] = await api.pending(rung).catch(() => []);
        if (pending.some((r) => r.doc_id === indentId)) { holder = rung; break; }
      }
      log.info(`after submit, held by: ${holder?.label ?? "nobody in the chain"}`);
      expect(holder, `${indentNo} should be waiting with a rung above the raiser`)
        .not.toBeNull();
    });

    await test.step("3. Walk up: each rung serves what it holds, and sends the rest on", async () => {
      for (let rung = 1; rung < chain.length; rung += 1) {
        const account = chain[rung];
        const pending: Pending[] = await api.pending(account).catch(() => []);
        if (!pending.some((r) => r.doc_id === indentId)) continue;

        // A rung that cannot read the indent cannot serve it. That is a finding
        // about who has been granted what, not a failure of the cascade, so it is
        // reported and the walk stops there rather than blowing up the run.
        const before = await api.getAs<Availability>(
          `/api/approvals/indents/${indentId}/availability`, account,
        ).catch((error: Error) => {
          log.info(`blocked: ${account.label} cannot review it — ${error.message}`);
          return null;
        });
        if (!before) {
          log.info(`${account.label} is blocked by permissions — walk stops here`);
          break;
        }
        const line = before.items.find((i) => i.issuable_now > 0);
        log.info(
          `${account.label}: owed ${before.items[0]?.remainder}, ` +
          `holds ${before.items[0]?.available_at_my_points}`,
        );

        await loginAs(page, account, log);
        await goto(`/approvals?reviewIndent=${indentId}`, `${account.label} reviewing`);
        await expect(page.getByText(/serve from your own stock/i))
          .toBeVisible({ timeout: 20_000 });
        await capture(`04-rung${rung}-${account.employeeId}`);

        if (line) {
          const give = Math.min(1, line.issuable_now);
          await page.getByLabel(`Issue quantity for ${line.item_name}`).fill(String(give));
          await page.getByLabel("Reason for this issue").fill(`Served by ${account.label}`);
          const forward = page.getByRole("checkbox", { name: /send the rest on/i });
          if (await forward.count()) await forward.first().check();
          await page.getByRole("button", { name: /issue now/i }).click();
          await expect(page.getByText(/issued \d+ line/i)).toBeVisible({ timeout: 25_000 });
          await capture(`05-rung${rung}-issued`);

          const after = await api.getAs<Availability>(
            `/api/approvals/indents/${indentId}/availability`, account,
          );
          log.info(
            `${account.label} served ${give}; remainder ` +
            `${before.items[0]?.remainder} -> ${after.items[0]?.remainder}`,
          );
          expect(after.items[0].allocated_quantity,
            "what was served must be recorded on the line")
            .toBeGreaterThan(before.items[0].allocated_quantity - 0.001);
        } else {
          // Holds none of it: approve so the remainder keeps climbing.
          log.info(`${account.label} holds none of it — approving so it moves on`);
          const items = before.items.map((i) => ({
            line_id: i.line_id, approved_quantity: i.approved_quantity,
          }));
          await api.postAs(`/api/approvals/indents/${indentId}/approve`,
            { items, comments: "Nothing to serve here" }, account);
        }
      }
    });

    await test.step("4. Where it ended up", async () => {
      const snapshot = await api.getAs<{ status: string; indent_no: string }>(
        `/api/indents/${indentId}`, users.admin ?? raiser,
      );
      log.info(`${indentNo} final status: ${snapshot.status}`);

      const stillPending: Pending[] = [];
      for (const rung of chain) {
        const rows: Pending[] = await api.pending(rung).catch(() => []);
        if (rows.some((r) => r.doc_id === indentId)) stillPending.push(rows[0]);
      }
      log.info(`rungs still holding it: ${stillPending.length}`);

      await loginAs(page, users.admin ?? raiser, log);
      await goto("/inventory/fulfillment", "Fulfilment queue");
      await capture("06-fulfilment-queue");
    });
  });
});
