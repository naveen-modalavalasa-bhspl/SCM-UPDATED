import { test, expect } from "./support/fixtures.js";
import {
  AllRequests, IndentDetail, NewRequestForm, answerNativeConfirm, currentPath, isShown,
  isoDate, newIndentButton, pageTitle, settle,
} from "./support/screens.js";

/**
 * Indent › New indent, and the life of a draft.
 *
 * Everything inside the New request box — every control, every rule it claims to
 * enforce — then the draft it produces: read it back, edit it, delete it. The
 * indent this test creates is deleted again whatever happens, so a red run leaves
 * nothing behind in anyone's list.
 *
 * This scenario deliberately does not seed: it is about one document, created
 * through the UI, from nothing.
 */

test.describe("Indent › New indent and the draft lifecycle", () => {
  test("The form enforces its rules, and the draft it creates can be read, edited and deleted", async ({
    page, goto, log, checks, indents, tester, granted,
  }) => {
    const form = new NewRequestForm(page);
    const detail = new IndentDetail(page);
    const list = new AllRequests(page);

    test.skip(
      !granted.has("indent.create"),
      `${tester.label} does not hold indent.create, so there is no New request form to test. `
        + "Point users.json at an account that can raise an indent.",
    );

    const catalogue = await indents.items(tester);
    expect(catalogue.length, "The item catalogue is empty; the form cannot be tested.").toBeGreaterThan(1);
    const firstItem = catalogue[0];
    const secondItem = catalogue[1];
    const labelOf = (item: { code: string; name: string }) => `${item.code} — ${item.name}`;

    /** Everything this test creates, so teardown is not conditional on it passing. */
    const created: number[] = [];

    try {
      /* ------------------------------------------------------------ getting in */

      await goto("/indents", "All requests, before raising");

      await log.runStep("'New indent' opens the New request form", async () => {
        await checks("The button leads to the form", async () => {
          await newIndentButton(page).click();
          await page.waitForURL(/\/indents\/new$/, { timeout: 30_000 });
          await settle(page);
          await expect(pageTitle(page)).toHaveText("New request");
        });
      });

      /* -------------------------------------------------------- the empty form */

      await log.runStep("An empty form refuses to create, and says why through its controls", async () => {
        await checks("'Create indent' is disabled until an item is chosen", async () => {
          await expect(form.create).toBeDisabled();
        });

        await checks("Quantity is disabled until an item is chosen", async () => {
          await expect(form.quantity(0)).toBeDisabled();
        });

        await checks("The only line cannot be removed — a form with no lines is not a form", async () => {
          await expect(form.removeLine(0)).toBeDisabled();
        });

        await checks("'Raised as' is filled from the signed-in position and cannot be edited", async () => {
          await expect(form.raisedAs).toBeDisabled();
          expect(
            (await form.raisedAs.inputValue()).trim(),
            "'Raised as' is blank, so the form cannot say who is raising this.",
          ).not.toBe("");
        });

        await checks("Delivery location is fixed by the position and cannot be edited when raising", async () => {
          await expect(form.deliveryLocation).toBeDisabled();
        });

        await checks("'Choose BOM' is offered when raising", async () => {
          await expect(form.chooseBom).toBeVisible();
        });
      });

      /* ------------------------------------------------------- the item picker */

      await log.runStep("The item picker searches, reports no match, and drives the quantity field", async () => {
        await checks("Opening the picker lists the catalogue", async () => {
          const options = await form.itemOptionLabels(0);
          expect(options.length, "The item picker opened with nothing in it.").toBeGreaterThan(0);
        });

        await checks("Typing narrows the list to matching items only", async () => {
          const options = await form.itemOptionLabels(0, firstItem.code);
          expect(options.length, `Typing "${firstItem.code}" matched nothing.`).toBeGreaterThan(0);
          expect(
            options.filter((option) => !option.toLowerCase().includes(firstItem.code.toLowerCase())),
            "The picker kept items that do not match what was typed.",
          ).toEqual([]);
        });

        await checks("A query that matches nothing says so instead of showing an empty box", async () => {
          await form.itemOptionLabels(0, "zzz-no-such-item-zzz");
          await expect(form.noMatchingItems).toBeVisible();
        });

        await checks("Choosing an item fills the box with that item", async () => {
          await form.pickItem(0, labelOf(firstItem));
          await expect(form.itemBox(0)).toHaveValue(labelOf(firstItem));
        });

        await checks("Choosing an item enables its quantity field", async () => {
          await expect(form.quantity(0)).toBeEnabled();
        });

        await checks("The quantity field names the item's unit of measure", async () => {
          const label = await form.quantity(0).getAttribute("aria-label");
          expect(label, "The quantity field does not say what unit it is in.").toMatch(/^Quantity \(.+\)$/);
          expect(
            label,
            "The quantity field says the UOM is unavailable, so the person cannot tell what they are ordering.",
          ).not.toContain("UOM unavailable");
        });
      });

      /* ---------------------------------------------------------- line handling */

      await log.runStep("Lines can be added and removed, and the same item cannot be added twice", async () => {
        await checks("'Add line' adds an empty second line", async () => {
          await form.addLine.click();
          await expect(form.itemBox(1)).toBeVisible();
          await expect(form.itemBox(1)).toHaveValue("");
        });

        await checks("With two lines, removing one becomes possible", async () => {
          await expect(form.removeLine(0)).toBeEnabled();
        });

        await checks("Choosing an item already on the indent is refused, and says so", async () => {
          await form.openItemOptions(1, firstItem.code);
          const alreadyUsed = form.listbox.getByRole("option", { name: labelOf(firstItem), exact: true }).first();
          await expect(
            alreadyUsed,
            "An item already on the indent was still offered as selectable.",
          ).toHaveAttribute("aria-disabled", "true");
          // `force`, because the option is only *marked* disabled: it is a live
          // <button> that anyone can click, and what happens when they do is
          // precisely what this check is about.
          await alreadyUsed.click({ force: true });
          await expect(form.duplicateError(1)).toHaveText("This item is already added to the indent.");
        });

        await checks("Choosing a different item clears the duplicate complaint", async () => {
          await form.pickItem(1, labelOf(secondItem));
          expect(await isShown(form.duplicateError(1))).toBe(false);
        });

        await checks("Removing the second line leaves the first intact", async () => {
          await form.removeLine(1).click();
          await expect(form.itemBox(1)).toHaveCount(0);
          await expect(form.itemBox(0)).toHaveValue(labelOf(firstItem));
        });
      });

      /* ------------------------------------------------------------ validation */

      await log.runStep("The form refuses to create an indent that is not valid", async () => {
        await checks("Creating with no required date is refused, with the reason on the field", async () => {
          await form.quantity(0).fill("4");
          await form.create.click();
          await expect(form.requiredDateError).toHaveText("Required date is mandatory.");
          expect(currentPath(page), "The form navigated away despite being invalid.")
            .toBe("/indents/new");
        });

        await checks("The required date cannot be set before today", async () => {
          await expect(form.requiredDate).toHaveAttribute("min", isoDate(0));
        });

        await checks("A past required date is refused, with the reason on the field", async () => {
          await form.requiredDate.fill(isoDate(-3));
          await form.create.click();
          await expect(form.requiredDateError).toHaveText("Required date cannot be earlier than today");
        });

        await checks("Creating with an item but no quantity is refused, with the reason on the row", async () => {
          await form.requiredDate.fill(isoDate(7));
          await form.quantity(0).fill("");
          await form.create.click();
          await expect(form.missingQuantityError(0)).toHaveText("Quantity is required for this item.");
          expect(currentPath(page)).toBe("/indents/new");
        });

        await checks("A quantity of zero is treated as no quantity", async () => {
          await form.quantity(0).fill("0");
          await form.create.click();
          await expect(form.missingQuantityError(0)).toBeVisible();
          expect(currentPath(page)).toBe("/indents/new");
        });
      });

      /* ------------------------------------------------------- the other fields */

      await log.runStep("Priority, remarks and Choose BOM behave", async () => {
        await checks("Priority can be set to Urgent", async () => {
          await form.setPriority("Urgent");
          await expect(form.priority).toHaveValue("Urgent");
        });

        await checks("Remarks accept free text", async () => {
          await form.remarks.fill("Raised by the automated Indent module run.");
          await expect(form.remarks).toHaveValue("Raised by the automated Indent module run.");
        });

        await checks("'Choose BOM' opens the BOM picker and closes without touching the form", async () => {
          await form.chooseBom.click();
          const modal = page.getByRole("dialog");
          await expect(modal.getByRole("heading", { name: "Choose BOM" })).toBeVisible({ timeout: 15_000 });
          await expect(modal.getByRole("textbox", { name: "Search BOMs" })).toBeVisible();
          await modal.getByRole("button", { name: "Cancel", exact: true }).click();
          await expect(modal).toBeHidden({ timeout: 10_000 });
          await expect(form.itemBox(0)).toHaveValue(labelOf(firstItem));
        });
      });

      /* ----------------------------------------------------------- Cancel first */

      await log.runStep("Cancel abandons the form without creating anything", async () => {
        const before = await indents.list("size=1&sort_by=created_at&sort_dir=desc", tester);
        await form.cancel.click();
        await page.waitForURL(/\/indents(\?.*)?$/, { timeout: 30_000 });
        await settle(page);

        await checks("Cancel returns to All requests", async () => {
          expect(currentPath(page)).toBe("/indents");
        });

        await checks("Cancel created nothing", async () => {
          const after = await indents.list("size=1&sort_by=created_at&sort_dir=desc", tester);
          expect(
            after.total,
            "The indent count rose after Cancel — the form saved something it should not have.",
          ).toBe(before.total);
        });
      });

      /* -------------------------------------------------------------- creating */

      const draft = await log.runStep("Fill the form again and create the indent", async () => {
        await newIndentButton(page).click();
        await page.waitForURL(/\/indents\/new$/, { timeout: 30_000 });
        await settle(page);

        await form.pickItem(0, labelOf(firstItem));
        await form.quantity(0).fill("7");
        await form.requiredDate.fill(isoDate(9));
        await form.setPriority("Urgent");
        await form.remarks.fill("Created by the automated Indent module run.");

        await expect(form.create, "'Create indent' stayed disabled on a complete form.").toBeEnabled();
        await form.create.click();
        await page.waitForURL(/\/indents\/\d+$/, { timeout: 45_000 });
        await settle(page);

        const id = Number(page.url().match(/\/indents\/(\d+)$/)![1]);
        created.push(id);
        const snapshot = await indents.indent(id, tester);
        log.info(`Created ${snapshot.indent_no} (id ${id}).`);
        return snapshot;
      });

      await log.runStep("The new indent reads back as what was typed", async () => {
        await checks("It lands on the indent's own screen, titled with its number", async () => {
          await expect(detail.title).toHaveText(draft.indent_no);
        });

        await checks("It is a DRAFT", async () => {
          expect(draft.status).toBe("DRAFT");
        });

        await checks("The quantity, priority and required date are the ones entered", async () => {
          expect(Number(draft.items[0].quantity)).toBe(7);
          expect(draft.priority).toBe("URGENT");
          expect(draft.required_date).toBe(isoDate(9));
        });

        await checks("The remarks are the ones entered", async () => {
          expect(draft.remarks).toBe("Created by the automated Indent module run.");
        });

        await checks("The line on screen is the item that was picked", async () => {
          // Whitespace collapsed on both sides: item names in the live catalogue
          // carry stray tabs, which is a data quirk and not the screen's doing.
          const flatten = (value: string) => value.replace(/\s+/g, " ").trim();
          const rows = await detail.lineMatrix();
          expect(rows.length).toBe(1);
          expect(flatten(rows[0].join(" | "))).toContain(flatten(firstItem.name));
          expect(Number(rows[0][1].replace(/,/g, ""))).toBe(7);
        });

        await checks("A draft offers Edit, Delete and Submit — and only its owner sees them", async () => {
          await expect(detail.edit).toBeVisible();
          await expect(detail.deleteDraft).toBeVisible();
          await expect(detail.submit).toBeVisible();
        });

        await checks("A draft is not approvable or rejectable from its own screen", async () => {
          expect(await isShown(detail.approve)).toBe(false);
          expect(await isShown(detail.reject)).toBe(false);
        });
      });

      await log.runStep("The new draft appears in All requests", async () => {
        await goto(`/indents?search=${encodeURIComponent(draft.indent_no)}`, "All requests, searching the new draft");
        await checks("Searching for it finds exactly it", async () => {
          expect(await list.indentNos()).toEqual([draft.indent_no]);
        });
        await checks("It is listed as a draft", async () => {
          expect((await list.statuses())[0]).toMatch(/draft/i);
        });
      });

      /* --------------------------------------------------------------- editing */

      await log.runStep("The draft can be edited, and the edit sticks", async () => {
        await goto(`/indents/${draft.id}`, `Indent ${draft.indent_no}`);
        await detail.edit.click();
        await page.waitForURL(/\/indents\/new\?edit=\d+$/, { timeout: 30_000 });
        await settle(page);

        await checks("The edit form is titled for the indent being edited", async () => {
          await expect(pageTitle(page)).toHaveText(`Edit ${draft.indent_no}`);
        });

        await checks("The edit form opens holding the values that were saved", async () => {
          await expect(form.itemBox(0)).toHaveValue(labelOf(firstItem));
          await expect(form.quantity(0)).toHaveValue("7");
          await expect(form.requiredDate).toHaveValue(isoDate(9));
          await expect(form.remarks).toHaveValue("Created by the automated Indent module run.");
        });

        await checks("Delivery location becomes editable when editing, unlike when raising", async () => {
          await expect(form.deliveryLocation).toBeEnabled();
        });

        await checks("'Choose BOM' is not offered when editing", async () => {
          expect(await isShown(form.chooseBom)).toBe(false);
        });

        await checks("Changes save and return to the indent", async () => {
          await form.quantity(0).fill("12");
          await form.requiredDate.fill(isoDate(14));
          await form.remarks.fill("Edited by the automated Indent module run.");
          await form.setPriority("Normal");
          await form.saveChanges.click();
          await page.waitForURL(/\/indents\/\d+$/, { timeout: 45_000 });
          await settle(page);
          await expect(detail.title).toHaveText(draft.indent_no);
        });

        await checks("The saved values are the edited ones, not the originals", async () => {
          const updated = await indents.indent(draft.id, tester);
          expect(Number(updated.items[0].quantity)).toBe(12);
          expect(updated.required_date).toBe(isoDate(14));
          expect(updated.priority).toBe("NORMAL");
          expect(updated.remarks).toBe("Edited by the automated Indent module run.");
        });

        await checks("The indent screen shows the edited quantity", async () => {
          const rows = await detail.lineMatrix();
          expect(Number(rows[0][1].replace(/,/g, ""))).toBe(12);
        });
      });

      /* -------------------------------------------------------------- deleting */

      await log.runStep("Deleting the draft asks first, and only then deletes", async () => {
        await checks("Dismissing the confirmation leaves the draft alone", async () => {
          answerNativeConfirm(page, false);
          await detail.deleteDraft.click();
          await settle(page);
          expect(currentPath(page), "The app navigated away after a dismissed confirmation.")
            .toBe(`/indents/${draft.id}`);
          const still = await indents.indent(draft.id, tester);
          expect(still.id, "The draft was deleted despite the confirmation being dismissed.").toBe(draft.id);
        });

        await checks("Accepting the confirmation deletes it and returns to All requests", async () => {
          answerNativeConfirm(page, true);
          await detail.deleteDraft.click();
          await page.waitForURL(/\/indents(\?.*)?$/, { timeout: 45_000 });
          await settle(page);
          expect(currentPath(page)).toBe("/indents");
        });

        await checks("The deleted draft is gone from the API, not merely hidden", async () => {
          const probe = await indents.probe("get", `/api/indents/${draft.id}`, tester);
          expect(
            [403, 404].includes(probe.status),
            `Reading the deleted draft returned ${probe.status}; it should be gone. Body: ${probe.body}`,
          ).toBe(true);
          // It is gone; nothing left to tear down.
          created.length = 0;
        });

        await checks("The deleted draft is gone from the list too", async () => {
          await goto(`/indents?search=${encodeURIComponent(draft.indent_no)}`, "All requests after the delete");
          await expect(list.list.emptyCell).toBeVisible({ timeout: 15_000 });
        });
      });
    } finally {
      // Belt and braces: if the run broke before the delete, remove what it made.
      for (const id of created) {
        const result = await indents.deleteIndent(id, tester);
        log.info(`Cleanup: deleting indent ${id} returned ${result.status}.`);
      }
    }

    checks.assertAllPassed();
  });
});
