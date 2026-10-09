/* Scenario 2 — the MDP already holds the stock, so the indent never reaches the
 * central warehouse.
 *
 * Scenario 1 is the long way round: the request climbs the whole ladder, inventory
 * reserves from the central warehouse, and the warehouse ships. But when the district
 * above the raiser already has the goods on its own shelf, sending the paperwork to
 * head office is waste. The indent stops climbing, the MDP allocates out of its own
 * stock, and issues straight to the raiser's LIP.
 *
 * What this proves that Scenario 1 cannot: allocation is scoped to the stocking point
 * of the person doing it. The same screens, driven by a district manager rather than
 * the inventory manager, must draw on MDP-14848 and not on the central warehouse.
 */
import { expect, test } from "../../src/fixtures.js";
import { loginAs } from "../../src/pages/login.js";
import { loadUsers } from "../../src/config.js";
import { createIndent, submitForApproval } from "../../src/pages/indents.js";
import { allocateStock, approveAllocation } from "../../src/pages/inventory.js";
import { issueAgainstIndent } from "../../src/pages/warehouse.js";

const users = loadUsers();

test.describe.configure({ mode: "serial" });

test.describe("MDP fulfils an indent from its own stock", () => {
  test("the district manager allocates and issues without the indent leaving the district",
    async ({ page, log, api, goto, capture }) => {
    const raiser = users.raiser;
    // The rung directly above the raiser that holds an MDP: the OE and the DM share
    // MDP-14848, so either can serve this — the DM is used because they can also
    // approve, which is what lets the indent stop here.
    const mdpUser = users.approvers.find((a) => a.employeeId === "HR-EMP-07299")
      ?? users.approvers[1];

    // ---- the store keeper asks for something the district already has ----
    await loginAs(page, raiser, log);
    await goto("/indents/new", "new-indent-form");
    const indent = await createIndent(page, log, {
      quantity: 5,
      remarks: "Scenario 2 — served locally by the MDP.",
    });
    await submitForApproval(page, log, indent.id);
    log.info(`Raised and submitted ${indent.indentNo} for ${indent.itemLabel}.`);
    await capture("indent-raised");

    // ---- the district manager picks it up ----
    await loginAs(page, mdpUser, log);
    await goto("/approvals", "approvals-queue");
    const waiting = page.getByText(indent.indentNo, { exact: false }).first();
    const atThisRung = await waiting.isVisible({ timeout: 20_000 }).catch(() => false);
    log.info(atThisRung
      ? `${indent.indentNo} is waiting at the district.`
      : `${indent.indentNo} is not at this rung yet — a lower rung signs first.`);
    await capture("district-approvals-queue");

    // ---- allocate from the district's own shelf ----
    // The fulfilment queue is scoped by stocking point, so what this login can allocate
    // IS the assertion: an MDP holder must see the indent and be offered their own
    // warehouse, never the central one.
    await goto("/inventory/fulfillment", "fulfilment-queue");
    const queued = page.getByText(indent.indentNo, { exact: false }).first();
    await expect(
      queued,
      `${indent.indentNo} is not in the district's fulfilment queue. Either it is still `
        + "climbing the ladder, or the MDP is not tagged as this login's stocking point.",
    ).toBeVisible({ timeout: 20_000 });
    await capture("district-fulfilment");

    // ---- allocate out of the district's own stock ----
    await allocateStock(page, log, indent, goto);
    await capture("district-allocation-submitted");

    const created = await api.allocationsFor(indent.id, mdpUser);
    const allocation = [...created].sort((a, b) => a.id - b.id).at(-1)!;
    log.info(`${allocation.allocation_no} is ${allocation.status}.`);

    if (allocation.status === "PENDING_APPROVAL") {
      await approveAllocation(page, log, indent, goto);
      await capture("district-allocation-approved");
    }

    const decided = (await api.allocationsFor(indent.id, mdpUser))
      .find((row) => row.id === allocation.id);
    expect(
      decided?.status,
      `${allocation.allocation_no} is ${decided?.status}. The district must be able to `
        + "sign its own allocation, or nothing can be issued locally.",
    ).toBe("APPROVED");

    // ---- issue it straight to the raiser's LIP ----
    // MDP-14848, not the central warehouse: the whole point of this scenario is that
    // the goods never travel through head office.
    const issueId = await issueAgainstIndent(page, log, goto, {
      indentNo: indent.indentNo,
      warehouseName: "104 - BRANCH OFFICE - Guntur - MDP",
    });
    await capture("district-material-issue");
    log.info(`Material issue ${issueId} raised at the district and posted.`);

    const state = await api.indent(indent.id, raiser).catch(() => null);
    log.info(`${indent.indentNo} is ${state?.status ?? "unknown"} after the district served it.`);
  });
});
