import { test, expect } from "../../src/fixtures.js";
import { ApprovalsApi, signIn, users, raiseIndent } from "../approvals-module/helpers.js";
import { approveAsHolder, walkLadder, REVIEW_URL, confirmButton, approvedQuantityBox, waitForStatus, deliveryControl, isLocked } from "./helpers.js";
import { createIndent } from "../../src/pages/indents.js";

/**
 * The indent approval scenarios the business owner asked to see proved:
 *
 *  S1  Store Keeper raises → the ladder (OE, DM, RM, SPH, COO) walks to APPROVED,
 *      discovering each rung from the backend rather than a hardcoded order, and
 *      stepping over any rung whose RBAC job profile is switched off.
 *  S2  An approver returns the indent for correction; the requester corrects it
 *      and resubmits; it re-enters the ladder.
 *  S3  Delivery location can never be edited — not on the correction form, not on
 *      a re-edit of that form, not on the draft edit form.
 *  S4  An approver may only REDUCE a quantity. Raising it above what was requested
 *      is refused by the screen and by the API.
 *
 * No application code and no schema is touched by this suite.
 */

const stamp = () => new Date().toISOString().slice(11, 19);

test.describe("Indent approval scenarios", () => {
  test("S1 — Store Keeper → OE → DM → RM → SPH → COO walks dynamically", async ({ page, log, goto, playwright }) => {
    const context = await playwright.request.newContext({ baseURL: process.env.API_URL || "http://localhost:8000" });
    const api = new ApprovalsApi(context);
    const list = users();

    const raised = await raiseIndent(api, page, log, goto, list.raiser, `S1 ladder ${stamp()}`);
    log.info(`S1 raised ${raised.indentNo} (id ${raised.id}) as ${list.raiser.label}`);

    const walk = await walkLadder(page, api, log, goto, list, raised.id);
    for (const rung of walk.rungs) {
      log.info(`S1 rung: ${rung.label} — approved via ${rung.via}${rung.note ? ` (${rung.note})` : ""}`);
    }
    log.info(`S1 final status of ${raised.indentNo}: ${walk.finalStatus} after ${walk.rungs.length} rungs`);

    await context.dispose();
    expect(walk.stranded, `Ladder stranded on ${walk.stranded?.label} — that profile cannot act even over the API`).toBeNull();
    expect(["APPROVED", "PARTIALLY_APPROVED"], `Ladder ended at ${walk.finalStatus}`).toContain(walk.finalStatus);
  });

  test("S2 — return for correction, correct, resubmit", async ({ page, log, goto, capture, playwright }) => {
    const context = await playwright.request.newContext({ baseURL: process.env.API_URL || "http://localhost:8000" });
    const api = new ApprovalsApi(context);
    const list = users();

    const raised = await raiseIndent(api, page, log, goto, list.raiser, `S2 return ${stamp()}`);
    const holder = await api.whoHasIndent(raised.id, list.approvers);
    expect(holder, `Nobody in users.json holds ${raised.indentNo} after submit`).not.toBeNull();
    log.info(`S2 ${raised.indentNo} (id ${raised.id}) is with ${holder!.label}`);

    // --- the approver returns it -------------------------------------------
    await signIn(page, api, holder!, log);
    await goto(REVIEW_URL(raised.id), "review-before-return");
    const screenUsable = await page.getByText("Approval review").first().isVisible({ timeout: 12_000 }).catch(() => false);
    if (!screenUsable) {
      log.problem("assert", `${holder!.label} cannot open the review screen — returning over the API.`);
      const r = await api.raw("post", `/api/approvals/indents/${raised.id}/return`, holder!, { comments: "Please correct the quantity." });
      expect(r.ok, `Return over API answered ${r.status}: ${r.body}`).toBeTruthy();
    } else {
      await page.getByRole("button", { name: /Return for correction/i }).first().click();
      await page.getByRole("dialog").locator("textarea").first().fill("Quantity is too high — please correct and resubmit.");
      await confirmButton(page).click();
      log.info(`S2 ${holder!.label} confirmed "Return for correction" on ${raised.indentNo}.`);
    }

    const readAs = list.admin ?? list.approvers[0]!;
    const afterReturn = await waitForStatus(api, raised.id, readAs, ["RETURNED_FOR_CORRECTION", "RETURNED"]);
    log.info(`S2 status after return: ${afterReturn}`);
    expect(["RETURNED_FOR_CORRECTION", "RETURNED"]).toContain(afterReturn);

    // --- the requester corrects it -----------------------------------------
    // The correction lives on the indent's own detail screen: "Edit correction"
    // opens the indent form in edit mode, "Resubmit correction" sends it back up.
    await signIn(page, api, list.raiser, log);
    await goto(`/indents/${raised.id}`, "returned-indent-detail");
    await expect(page.getByText("Returned for correction").first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: /Edit correction/i }).click();
    await page.waitForURL(/\/indents\/new\?edit=/, { timeout: 20_000 });
    await capture("correction-edit-1");

    // S3, first edit: the delivery location must be locked.
    const firstEdit = await isLocked(deliveryControl(page));
    log.info(`S3 correction edit #1 — delivery location: ${firstEdit.how}`);
    expect(firstEdit.locked, "Delivery location must not be editable while correcting a returned indent").toBeTruthy();

    const qty = page.getByRole("spinbutton", { name: /Quantity/i }).first();
    await qty.fill("4");
    await Promise.all([
      page.waitForResponse((r) => r.request().method() === "PUT" && /\/api\/indents\//.test(new URL(r.url()).pathname), { timeout: 45_000 }),
      page.getByRole("button", { name: /Save correction/i }).click(),
    ]);
    log.info("S2 correction saved (quantity 6 → 4).");

    // --- re-edit: open the correction a second time ------------------------
    await goto(`/indents/${raised.id}`, "returned-indent-detail-2");
    await page.getByRole("button", { name: /Edit correction/i }).click();
    await page.waitForURL(/\/indents\/new\?edit=/, { timeout: 20_000 });
    await capture("correction-edit-2");
    const secondEdit = await isLocked(deliveryControl(page));
    log.info(`S3 correction re-edit — delivery location: ${secondEdit.how}`);
    expect(secondEdit.locked, "Delivery location must stay locked on a re-edit too").toBeTruthy();
    await expect(page.getByRole("spinbutton", { name: /Quantity/i }).first(), "The saved correction must survive a reopen")
      .toHaveValue(/^4(\.0+)?$/);

    // --- resubmit ----------------------------------------------------------
    await goto(`/indents/${raised.id}`, "before-resubmit");
    const resubmit = page.getByRole("button", { name: /Resubmit correction/i });
    await expect(resubmit).toBeVisible({ timeout: 20_000 });
    const [submit] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/indents\//.test(new URL(r.url()).pathname), { timeout: 60_000 }),
      resubmit.click(),
    ]);
    const submitBody = await submit.text();
    log.info(`S2 resubmit answered ${submit.status()} on ${new URL(submit.url()).pathname}: ${submitBody.slice(0, 400)}`);
    expect(submit.ok(), `Resubmit after correction failed: ${submit.status()} ${submitBody}`).toBeTruthy();

    const afterResubmit = await waitForStatus(api, raised.id, readAs, ["PENDING_APPROVAL", "SUBMITTED"]);
    log.info(`S2 status after resubmit: ${afterResubmit}`);
    expect(["PENDING_APPROVAL", "SUBMITTED"]).toContain(afterResubmit);

    const backWith = await api.whoHasIndent(raised.id, list.approvers);
    log.info(`S2 after resubmit the indent is with: ${backWith?.label ?? "nobody in users.json"}`);
    expect(backWith, "A resubmitted indent must land back in an approver's inbox").not.toBeNull();

    await context.dispose();
  });

  test("S3 — delivery location is locked on the draft edit form", async ({ page, log, goto, playwright }) => {
    const context = await playwright.request.newContext({ baseURL: process.env.API_URL || "http://localhost:8000" });
    const api = new ApprovalsApi(context);
    const list = users();

    await signIn(page, api, list.raiser, log);
    await goto("/indents/new", "new-indent-form");
    const created = await createIndent(page, log, { quantity: 3, remarks: `S3 draft ${stamp()}` });
    log.info(`S3 draft ${created.indentNo} (id ${created.id}) created for the edit check.`);

    await goto(`/indents/new?edit=${created.id}`, "draft-edit-form");
    await expect(page.getByText(/^Edit /)).toBeVisible({ timeout: 20_000 });

    const state = await isLocked(deliveryControl(page));
    log.info(`S3 draft edit — delivery location: ${state.how}`);

    await context.dispose();
    expect(
      state.locked,
      "Delivery location must stay locked when editing an indent — it is assigned from the raiser's position",
    ).toBeTruthy();
  });

  test("S4 — an approver may reduce a quantity but never raise it", async ({ page, log, goto, playwright }) => {
    const context = await playwright.request.newContext({ baseURL: process.env.API_URL || "http://localhost:8000" });
    const api = new ApprovalsApi(context);
    const list = users();

    const raised = await raiseIndent(api, page, log, goto, list.raiser, `S4 quantity ${stamp()}`);
    const holder = await api.whoHasIndent(raised.id, list.approvers);
    expect(holder, `Nobody holds ${raised.indentNo}`).not.toBeNull();

    const detail = await api.raw("get", `/api/approvals/indents/${raised.id}`, holder!);
    const line = detail.json.items[0];
    log.info(`S4 ${raised.indentNo} line ${line.id}: requested ${line.requested_quantity}`);

    // --- the API refuses an increase ---------------------------------------
    const tooHigh = await api.raw("post", `/api/approvals/indents/${raised.id}/approve`, holder!, {
      items: [{ line_id: line.id, approved_quantity: Number(line.requested_quantity) + 5 }],
      comments: "Attempting to raise the quantity.",
    });
    log.info(`S4 API approve with quantity ${Number(line.requested_quantity) + 5} answered ${tooHigh.status}: ${tooHigh.body.slice(0, 300)}`);
    expect(tooHigh.ok, "The API must refuse an approved quantity above what was requested").toBeFalsy();

    // --- the screen refuses an increase ------------------------------------
    await signIn(page, api, holder!, log);
    await goto(REVIEW_URL(raised.id), "review-quantity");
    const usable = await page.getByText("Approval review").first().isVisible({ timeout: 12_000 }).catch(() => false);
    if (usable) {
      const qty = approvedQuantityBox(page);
      const boxes = page.locator("input[type=checkbox]");
      for (let index = 0; index < await boxes.count(); index += 1) await boxes.nth(index).check();

      // Every checklist box is ticked, so the ONLY thing that may keep Approve
      // disabled from here on is the quantity itself.
      await qty.fill(String(Number(line.requested_quantity) + 5));
      const approveButton = page.getByRole("button", { name: /^Approve$/ }).first();
      await expect(approveButton, "Approve must stay disabled when the quantity is above what was requested").toBeDisabled({ timeout: 10_000 });
      log.info(`S4 screen blocks an increase: entered ${Number(line.requested_quantity) + 5}, Approve stays disabled.`);

      // --- a reduction is accepted -----------------------------------------
      await qty.fill("2");
      await expect(approveButton).toBeEnabled({ timeout: 10_000 });
      await approveButton.click();
      const [approved] = await Promise.all([
        page.waitForResponse((r) => new RegExp(`/api/approvals/indents/${raised.id}/approve$`).test(new URL(r.url()).pathname), { timeout: 45_000 }),
        confirmButton(page).click(),
      ]);
      expect(approved.ok(), `Reduce-and-approve failed: ${approved.status()} ${await approved.text()}`).toBeTruthy();
      log.info("S4 reduce-and-approve accepted.");
    } else {
      log.problem("assert", `${holder!.label} cannot open the review screen — reduction checked over the API only.`);
      const reduced = await api.raw("post", `/api/approvals/indents/${raised.id}/approve`, holder!, {
        items: [{ line_id: line.id, approved_quantity: 2 }], comments: "Reduced.",
      });
      expect(reduced.ok, `Reduce over API answered ${reduced.status}: ${reduced.body}`).toBeTruthy();
    }

    // --- the reduction stuck ----------------------------------------------
    const after = await api.raw("get", `/api/indents/${raised.id}`, list.admin ?? list.approvers[0]!);
    const savedLine = (after.json?.items ?? [])[0];
    log.info(`S4 after approval: approved_quantity=${savedLine?.approved_quantity} requested=${savedLine?.quantity}`);
    expect(Number(savedLine?.approved_quantity)).toBe(2);

    await context.dispose();
  });
});
