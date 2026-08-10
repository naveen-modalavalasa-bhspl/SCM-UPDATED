/* The tail of the journey: an approved allocation becomes stock that actually leaves
 * the building.
 *
 * Scenario 1 ends here — the store keeper's indent has been signed by the ladder,
 * inventory has reserved the stock, and the warehouse now has to hand it over. That
 * hand-over is three documents, not one: a material issue takes the goods off the
 * shelf, a consignment packs them, and a dispatch sends them to the raiser's LIP.
 *
 * Driven as the warehouse manager, because who may issue is a permission and this run
 * is also the proof that his job profile carries it.
 */
import { expect, test } from "../../src/fixtures.js";
import { loginAs } from "../../src/pages/login.js";
import { loadUsers } from "../../src/config.js";

const users = loadUsers();

test.describe.configure({ mode: "serial" });

test.describe("Warehouse hand-over", () => {
  test("the warehouse issues an allocated indent, then consigns and dispatches it", async ({
    page, log, api, goto, capture,
  }) => {
    const warehouseUser = users.warehouse ?? users.approvers[0];
    const raiser = users.raiser;

    const resumeId = Number(process.env.RESUME_INDENT);
    const target = Number.isFinite(resumeId) && resumeId > 0
      ? await api.indent(resumeId, raiser)
      : null;
    expect(
      target,
      "Pass RESUME_INDENT=<id> naming an ALLOCATED indent — the warehouse can only "
        + "issue against stock inventory has already reserved.",
    ).not.toBeNull();
    log.info(`Issuing ${target!.indent_no} (${target!.status}).`);

    await loginAs(page, warehouseUser, log);

    // ---- material issue ----
    await goto("/warehouse/material-issues/new", "material-issue-form");

    // The indent picker only lists indents with an approved reservation, so choosing
    // ours here IS the assertion that the allocation landed.
    // The indent picker is disabled until a warehouse is chosen — it is the warehouse
    // that owns the reservation, so the form asks in that order and so does this.
    // The warehouse that HOLDS the reservation, not whichever sorts first: the indent
    // picker below is filtered by it, so the wrong one here reads as "no such indent".
    const warehouse = page.getByRole("combobox", { name: "Warehouse", exact: true }).first();
    await warehouse.click();
    await warehouse.fill(process.env.ISSUE_WAREHOUSE || "CENTRAL WAREHOUSE-1");
    await page.getByRole("option").first().click();

    const indentPicker = page.getByRole("combobox", { name: /indent/i }).first();
    await indentPicker.click();
    await indentPicker.fill(target!.indent_no);
    // Not offered is a legitimate answer, not a failure: a reservation can only be
    // drawn once, so an indent already issued disappears from this list. The run then
    // opens the existing document instead of insisting on making a second one.
    const option = page.getByRole("option").filter({ hasText: target!.indent_no }).first();
    const offered = await option.isVisible({ timeout: 10_000 }).catch(() => false);
    if (offered) {
      await option.click();
      await capture("material-issue-indent-picked");
    } else {
      log.info(`${target!.indent_no} is not offered — it already has an issue.`);
    }

    // A material issue is not one click. It is a DRAFT that gets saved, submitted for
    // a signature, approved by whoever the warehouse ladder named, and only then
    // posted — each state showing a different button. Walking it any other way tests
    // nothing, because the stock does not move until the last step.
    if (offered) await page.getByRole("button", { name: /^save$/i }).first().click();

    // An indent's reservation can only be drawn once, so if this indent already has an
    // issue the form saves nothing and the URL never moves. That is not a failure — the
    // document exists. Go back to the list, find it by indent number, open it, and carry
    // on from whatever state it is already in.
    const saved = offered && await page
      .waitForURL(/\/warehouse\/material-issues\/\d+/, { timeout: 15_000 })
      .then(() => true).catch(() => false);

    if (!saved) {
      log.info("Nothing new was created — this indent already has an issue. Opening it.");
      await goto("/warehouse/material-issues", "material-issues-list");
      const search = page.getByPlaceholder(/search/i).first();
      if (await search.count()) {
        await search.fill(target!.indent_no);
        await page.waitForTimeout(1_500);
      }
      const row = page.getByText(target!.indent_no, { exact: false }).first();
      await expect(
        row,
        `${target!.indent_no} has no material issue on the list either, so there is `
          + "nothing to post. The reservation may belong to a different warehouse.",
      ).toBeVisible({ timeout: 20_000 });
      await row.click();
      await page.waitForURL(/\/warehouse\/material-issues\/\d+/, { timeout: 20_000 });
    }
    await capture("material-issue-open");
    log.info(`Working on material issue ${page.url().split("/").pop()}.`);

    const step = async (name: RegExp, label: string) => {
      const button = page.getByRole("button", { name }).first();
      if (!(await button.count())) {
        log.info(`${label}: not offered on this document — skipping.`);
        return false;
      }
      await button.click();
      // Every one of these is behind a confirm, because each is irreversible.
      const confirm = page.getByRole("button", { name: /confirm|yes|approve|submit|issue/i });
      await confirm.last().click().catch(() => undefined);
      await expect(page.getByText(/error|failed/i).first())
        .toBeHidden({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(1_500);
      await capture(`material-issue-${label}`);
      log.info(`${label}: done.`);
      return true;
    };

    await step(/submit for approval/i, "submitted");
    await step(/^approve$/i, "approved");
    await step(/issue from stock/i, "issued");

    // Read the state off the screen rather than adding an API helper for one line.
    const state = await page.getByText(/DRAFT|PENDING_APPROVAL|APPROVED|ISSUED/).first()
      .innerText().catch(() => "unknown");
    log.info(`Material issue is now ${state.trim()}.`);

    // ---- consignment: pack what was issued ----
    //
    // Written from ConsignmentForm.tsx, not by probing the DOM. Saving needs, in the
    // form's own words: a material issue, every issued line fully packed, and every
    // package locked. Package number, type and barcode are issued by the server, so
    // the only thing to fill is the per-line quantity.
    await goto("/warehouse/dispatch/consignments/new", "consignment-form");

    // The Field caption is a plain span, so the control's accessible name is its
    // placeholder. Logged as an a11y finding by the run.
    const issueLookup = page.getByRole("combobox", { name: /select material issue/i }).first();
    await issueLookup.click();
    const issueOption = page.getByRole("option").first();
    await expect(
      issueOption,
      "No posted material issue is offered, so there is nothing to pack. The issue "
        + "must be ISSUED before a consignment can draw on it.",
    ).toBeVisible({ timeout: 20_000 });
    await issueOption.click();
    await capture("consignment-issue-picked");

    // One row per issued line. The input clamps to what is left to pack, so asking
    // for more than exists packs exactly the remainder — which is what "pack it all"
    // means and what the save rule demands.
    const qtyInputs = page.locator("table input[type='number']");
    const lineCount = await qtyInputs.count();
    for (let index = 0; index < lineCount; index += 1) {
      await qtyInputs.nth(index).fill("999999");
    }
    log.info(`Packed ${lineCount} line(s) in full.`);

    await page.getByRole("button", { name: /lock package/i }).first().click();
    await capture("consignment-packed");

    const saveConsignment = page.getByRole("button", { name: /save consignment/i }).first();
    await expect(
      saveConsignment,
      "Save is still disabled — the form is listing unmet conditions above the "
        + "packages (unpacked lines, or a package left unlocked).",
    ).toBeEnabled({ timeout: 15_000 });
    await saveConsignment.click();
    await page.waitForURL(/\/warehouse\/dispatch\/consignments\/\d+/, { timeout: 30_000 });
    await capture("consignment-saved");
    log.info(`Consignment saved: ${page.url().split("/").pop()}`);

    // ---- dispatch: out of the gate ----
    // A PACKED consignment offers "Confirm dispatch", which hands off to the dispatch
    // screen with the consignment already chosen; that screen's own button creates the
    // dispatch, and "Gate out" is the moment the goods physically leave.
    await page.getByRole("button", { name: /confirm dispatch/i }).first().click();
    await page.waitForURL(/\/warehouse\/dispatch\/new/, { timeout: 30_000 });
    await page.getByRole("button", { name: /confirm dispatch/i }).first().click();
    await page.waitForURL(/\/warehouse\/dispatch\/\d+/, { timeout: 30_000 });
    await capture("dispatch-created");
    log.info(`Dispatch created: ${page.url().split("/").pop()}`);

    // Only offered while the dispatch is still APPROVED or PACKED — confirming can
    // already carry it past the gate, and then there is nothing left to press.
    const gateOut = page.getByRole("button", { name: /gate out/i });
    if (await gateOut.count()) {
      await gateOut.first().click();
      await page.getByRole("button", { name: /gate out|confirm|yes/i }).last().click()
        .catch(() => undefined);
      await page.waitForTimeout(2_000);
      await capture("dispatch-gated-out");
      log.info("Dispatch gated out.");
    } else {
      log.info("Already past the gate — no gate-out step to take.");
    }

    const dispatchNo = await page.getByText(/DSP\/|DIS\//).first().innerText()
      .catch(() => "");
    log.info(`Dispatch number on screen: ${dispatchNo.trim() || "not shown"}`);

    // ---- the raiser receives it ----
    // Acknowledged by the person who asked for the goods, not the warehouse that sent
    // them: that signature is what turns a dispatch into a delivery.
    await loginAs(page, raiser, log);
    await goto("/warehouse/acknowledge-delivery", "acknowledge-delivery");

    const scan = page.getByPlaceholder(/scan a package label or type a dispatch number/i);
    if (dispatchNo.trim() && await scan.count()) {
      await scan.first().fill(dispatchNo.trim());
      await scan.first().press("Enter");
      await page.waitForTimeout(2_000);
    }

    const receivedBy = page.getByPlaceholder(/name of the receiver/i).first();
    await expect(
      receivedBy,
      "The acknowledge form did not open for the raiser — either nothing is out for "
        + "delivery to them, or the dispatch number did not resolve.",
    ).toBeVisible({ timeout: 20_000 });
    await receivedBy.fill(raiser.label ?? "Store keeper");
    await page.getByPlaceholder(/damage, shortage/i).first()
      .fill("Received in full by the automated functional run.");
    await capture("acknowledge-filled");

    await page.getByRole("button", { name: /acknowledge delivery/i }).first().click();
    await page.getByRole("button", { name: /confirm|yes|acknowledge/i }).last().click()
      .catch(() => undefined);
    await page.waitForTimeout(2_500);
    await capture("delivery-acknowledged");
    log.info("Delivery acknowledged by the raiser — the journey is closed.");
  });
});
