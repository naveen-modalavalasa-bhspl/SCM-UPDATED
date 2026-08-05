import { test, expect } from "../../src/fixtures.js";
import { loadUsers, type Account } from "../../src/config.js";
import { loginAs } from "../../src/pages/login.js";
import { createIndent, submitForApproval } from "../../src/pages/indents.js";
import { approveRung } from "../../src/pages/approvals.js";
import { allocateStock, approveAllocation } from "../../src/pages/inventory.js";

const users = loadUsers();

/** Statuses that mean the ladder is finished and the document has reached inventory. */
const LANDED = ["APPROVED", "AWAITING_ALLOCATION", "ALLOCATED", "PARTIALLY_FULFILLED", "PENDING_PROCUREMENT"];

/** A ladder deeper than this is a configuration bug, not a test to keep walking. */
const MAX_RUNGS = 12;

test.describe("Indent lifecycle", () => {
  // One user journey across several logins; it cannot be split or parallelised.
  test.describe.configure({ mode: "serial" });

  test("store keeper raises an indent, the ladder approves it, and inventory allocates and signs it off", async ({
    page,
    log,
    api,
    goto,
    capture,
  }) => {
    const raiser = users.raiser;

    // RESUME_INDENT=<id> picks an indent that is already in the ladder up where it
    // stopped, instead of raising a new one. Useful after fixing whatever blocked a
    // run — the configuration change gets proven against the very document that
    // caught it, and no throwaway indent is created.
    const resumeId = Number(process.env.RESUME_INDENT);
    let indent: { id: number; indentNo: string };

    if (Number.isFinite(resumeId) && resumeId > 0) {
      const existing = await api.indent(resumeId, raiser);
      indent = { id: existing.id, indentNo: existing.indent_no };
      log.info(`Resuming ${indent.indentNo} (id ${indent.id}) — currently ${existing.status}, with ${existing.current_approver_name ?? "unknown"}.`);
    } else {
      await loginAs(page, raiser, log);
      await goto("/indents/new", "new-indent-form");

      indent = await createIndent(page, log, {
        quantity: 5,
        remarks: "Raised by the automated functional run.",
      });
      await capture("indent-created");

      await submitForApproval(page, log, indent.id);
      await capture("indent-submitted");

      const afterSubmit = await api.indent(indent.id, raiser);
      expect(
        afterSubmit.status,
        `A submitted indent should be waiting on an approver, not sitting in ${afterSubmit.status}.`,
      ).toBe("PENDING_APPROVAL");
      log.info(`${indent.indentNo} is now with: ${afterSubmit.current_approver_name ?? "unknown"}`);
    }

    // Walk the ladder as configured, not as assumed. Each pass asks the backend who
    // the document is actually waiting on, so adding or removing a rung in
    // Settings > Approvals Config needs no change here.
    const walked: string[] = [];
    for (let rung = 1; rung <= MAX_RUNGS; rung += 1) {
      const snapshot = await api.indent(indent.id, raiser);
      if (LANDED.includes(snapshot.status)) break;

      expect(
        snapshot.status,
        `The indent stopped at ${snapshot.status} after ${walked.length} approval(s) — the ladder did not carry it through.`,
      ).toBe("PENDING_APPROVAL");

      const approver: Account | null = await api.whoIsItWaitingOn(indent.id, users.approvers);
      expect(
        approver,
        `${indent.indentNo} is pending, but none of the configured approver accounts has it in their queue. `
          + `The backend says it is with "${snapshot.current_approver_name ?? "unknown"}" — add that person to users.json.`,
      ).not.toBeNull();

      await loginAs(page, approver!, log);
      await approveRung(page, log, approver!, indent, goto);
      walked.push(`${rung}. ${approver!.label}`);
      await capture(`after-approval-${rung}`);
    }

    const final = await api.indent(indent.id, raiser);
    log.info(`Ladder walked: ${walked.join(" → ") || "(none)"}`);
    log.info(`Final status: ${final.status}`);
    expect(
      LANDED,
      `After ${walked.length} approval(s) the indent is ${final.status}; it never reached inventory.`,
    ).toContain(final.status);

    const history = await api.history("INDENT", indent.id, raiser);
    log.info("Approval history", history.items);

    // The last hop: whoever runs inventory must actually see it in the queue.
    const inventoryUser = users.inventory ?? users.approvers[users.approvers.length - 1];
    await loginAs(page, inventoryUser, log);
    await goto("/inventory/fulfillment", "inventory-fulfillment-queue");

    await expect(
      page.getByText(indent.indentNo, { exact: false }).first(),
      `${indent.indentNo} is ${final.status} but does not appear in the inventory fulfilment queue.`,
    ).toBeVisible({ timeout: 20_000 });
    await capture("landed-in-inventory");

    // ---- inventory's own half: decide, then approve that decision ----

    await allocateStock(page, log, indent, goto);
    await capture("allocation-submitted");

    const submitted = await api.allocationsFor(indent.id, inventoryUser);
    expect(
      submitted.length,
      `No allocation exists for ${indent.indentNo} after submitting one.`,
    ).toBeGreaterThan(0);
    const allocation = submitted[submitted.length - 1];
    log.info(`Allocation ${allocation.allocation_no} is ${allocation.status}.`);

    await approveAllocation(page, log, indent, goto);
    await capture("allocation-approved");

    const decided = (await api.allocationsFor(indent.id, inventoryUser))
      .find((row) => row.id === allocation.id);
    expect(
      decided?.status,
      `${allocation.allocation_no} did not reach APPROVED after being approved.`,
    ).toBe("APPROVED");

    // Which of these the indent lands on depends on what was actually on the shelf:
    // everything reserved, part reserved with the rest raised as a material request,
    // or nothing available at all. All three are the flow working.
    const closed = await api.indent(indent.id, raiser);
    log.info(`Ladder walked: ${walked.join(" → ") || "(resumed)"}`);
    log.info(`${indent.indentNo} finished at ${closed.status}.`);
    expect(
      ["ALLOCATED", "PARTIALLY_FULFILLED", "PENDING_PROCUREMENT"],
      `After its allocation was approved, ${indent.indentNo} is ${closed.status} — `
        + "approving an allocation should have moved it out of AWAITING_ALLOCATION.",
    ).toContain(closed.status);

    log.info(`✔ ${indent.indentNo} completed the journey: raised → approvals → allocated → ${closed.status}.`);
  });
});
