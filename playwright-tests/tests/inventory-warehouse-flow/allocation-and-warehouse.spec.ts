import { test, expect } from "../../src/fixtures.js";
import { loadUsers } from "../../src/config.js";
import { loginAs } from "../../src/pages/login.js";
import { allocateStock, approveAllocation } from "../../src/pages/inventory.js";
import { openWarehouseIssues, walkIssueLadder } from "../../src/pages/warehouse.js";

const users = loadUsers();

/**
 * Picks up where the indent suite stops.
 *
 * The indent ladder is somebody else's journey; this one is inventory's and the
 * warehouse's. Kept in its own folder so a broken allocation screen does not read as
 * a broken approval chain, and so this can be run on its own against whatever indent
 * is already parked in front of inventory.
 */
test.describe("Inventory and warehouse approvals", () => {
  test.describe.configure({ mode: "serial" });

  test("inventory allocates and signs every hat, then the warehouse issue ladder is walked", async ({
    page, log, api, goto, capture,
  }) => {
    const raiser = users.raiser;
    const inventoryUser = users.inventory!;

    // Asked as the RAISER: scope follows the active position, and the inventory
    // account defaults to a hat at another warehouse that cannot see this project.
    // RESUME_INDENT names one; otherwise take whatever is already waiting, so the
    // suite never depends on the indent suite having just run.
    const resumeId = Number(process.env.RESUME_INDENT);
    const target = Number.isFinite(resumeId) && resumeId > 0
      ? await api.indent(resumeId, raiser)
      : await api.firstIndentAwaiting(raiser);

    expect(
      target,
      "No indent is sitting at AWAITING_ALLOCATION, so there is nothing for inventory "
        + "to allocate. Run tests/indent-approval-flow first, or pass RESUME_INDENT=<id>.",
    ).not.toBeNull();

    const indent = { id: target!.id, indentNo: target!.indent_no };
    log.info(`Working on ${indent.indentNo} (${target!.status}).`);

    // ---- inventory: decide, then sign it once per hat ----

    await loginAs(page, inventoryUser, log);
    // Allocating twice is refused by the backend ("already awaiting approval"), which
    // is correct — so a run that stopped after submitting resumes at the signature
    // instead of dying on its own leftovers.
    const pending = (await api.allocationsFor(indent.id, inventoryUser))
      .some((row) => row.status === "PENDING_APPROVAL");
    if (pending) {
      log.info("An allocation is already awaiting approval — resuming at the signature.");
    } else {
      await allocateStock(page, log, indent, goto);
      await capture("allocation-submitted");
    }

    // Highest id, not last in the list: the API does not promise an order, and a
    // rejected allocation stays attached to the indent forever — so "the last one"
    // can be a dead one and the run then watches the wrong document.
    const created = await api.allocationsFor(indent.id, inventoryUser);
    const allocation = [...created].sort((a, b) => a.id - b.id).at(-1)!;
    log.info(`Allocation ${allocation.allocation_no} is ${allocation.status}.`);

    const hats = inventoryUser.hats ?? [];
    const signed: string[] = [];
    for (const hat of hats.length ? hats : [undefined]) {
      const now = (await api.allocationsFor(indent.id, inventoryUser))
        .find((row) => row.id === allocation.id);
      if (now?.status !== "PENDING_APPROVAL") break;
      if (hat) await loginAs(page, { ...inventoryUser, position: hat }, log);
      await approveAllocation(page, log, indent, goto, hat);
      signed.push(hat ?? "current hat");
      await capture(`allocation-signed-${hat ?? "current"}`);
    }

    const decided = (await api.allocationsFor(indent.id, inventoryUser))
      .find((row) => row.id === allocation.id);
    expect(
      decided?.status,
      `${allocation.allocation_no} is ${decided?.status} after ${signed.length} signature(s). `
        + `Hats signed: ${signed.join(" → ") || "none"}.`,
    ).toBe("APPROVED");
    log.info(`${allocation.allocation_no} approved across ${signed.length} hat(s): ${signed.join(" → ")}.`);

    const closed = await api.indent(indent.id, raiser);
    log.info(`${indent.indentNo} is now ${closed.status}.`);

    // ---- warehouse: the material issue ladder ----

    await walkIssueLadder(page, log, api, goto, capture, users);
  });
});

test.describe("Warehouse issues screen", () => {
  test("the material issues list opens for the warehouse approvers", async ({
    page, log, goto,
  }) => {
    const approver = users.approvers.find((a) => a.employeeId === "HR-EMP-16295")
      ?? users.approvers[0];
    await loginAs(page, approver, log);
    await openWarehouseIssues(page, log, goto);
  });
});
