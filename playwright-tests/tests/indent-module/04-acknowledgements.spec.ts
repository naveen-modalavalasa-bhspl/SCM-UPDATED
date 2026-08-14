import { test, expect } from "./support/fixtures.js";
import { config } from "../../src/config.js";
import { Acknowledgements, isShown, pageTitle, settle } from "./support/screens.js";
import { acknowledgementsQuery, expectRowsToMatch } from "./support/oracle.js";
import type { Acknowledgement } from "./support/api.js";

/**
 * Indent › My deliveries.
 *
 * What the account is still owed, how far it has got, and confirming it arrived —
 * including the photo the rule says must come with it.
 *
 * Two things shape this scenario.
 *
 * **It cannot seed itself.** A delivery only exists once an indent has been
 * approved, allocated and dispatched by other people; nothing a single account
 * can do produces one. So the run tests against whatever this account actually
 * has, and when it has nothing it says so loudly instead of passing quietly — an
 * empty screen is a fact about the data, never evidence the screen works.
 *
 * **Confirming receipt is the one irreversible thing in the module.** It writes
 * `received_qty` and can close a real indent. So the run stops short of it by
 * default: it opens the modal, checks the arithmetic, uploads and deletes a photo,
 * and proves the photo rule by letting the server refuse a confirm that has none —
 * all of which leave the data exactly as they found it. Set
 * `ALLOW_DELIVERY_CONFIRM=true` to let it complete a real receipt.
 */

const ACKNOWLEDGEMENTS = "/indents/acknowledgements";

const receivable = (line: Acknowledgement["lines"][number]) =>
  Math.max(Number(line.dispatched_quantity) - Number(line.received_quantity), 0);

/** A one-pixel PNG, built in memory so the run needs no fixture files on disk. */
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test.describe("Indent › My deliveries", () => {
  test("The deliveries list, its filters, and confirming what arrived", async ({
    page, goto, log, checks, indents, tester,
  }) => {
    const screen = new Acknowledgements(page);

    await goto(ACKNOWLEDGEMENTS, "My deliveries");

    const all = await indents.acknowledgements("", tester);

    await log.runStep("The screen renders with its own filter bar", async () => {
      await checks("The screen is titled 'My deliveries'", async () => {
        await expect(pageTitle(page)).toHaveText("My deliveries");
      });

      await checks("It explains what it is for", async () => {
        await expect(
          page.getByText("What you asked for, how far it has got, and confirming it reached you."),
        ).toBeVisible();
      });

      await checks("The search box, status filter and 'Ready to confirm' toggle are all present", async () => {
        await expect(screen.search).toBeVisible();
        await expect(screen.statusSelect).toBeVisible();
        await expect(screen.readyToConfirm).toBeVisible();
      });

      await checks("The status filter is announced as a status filter", async () => {
        // The page asks for `aria-label="Filter by status"`, but the shared
        // `Select` accepts an `ariaLabel` prop and nothing else, so the attribute
        // is dropped on the floor and the control falls back to naming itself
        // after its placeholder.
        await expect(
          page.getByRole("combobox", { name: "Filter by status" }),
          "The status filter is not reachable by the name the page gives it: AcknowledgementsPage passes "
            + "`aria-label=\"Filter by status\"` to the shared `Select`, whose props are "
            + "`ariaLabel`/`label`/`placeholder` — `aria-label` is never forwarded. The control ends up "
            + "named \"Any status\" after its placeholder, so anyone navigating by name is told what the "
            + "current value is rather than what the control does. Passing `ariaLabel` fixes it.",
        ).toBeVisible();
      });

      await checks("'New indent' is not offered here — this screen does not raise anything", async () => {
        expect(await isShown(page.getByRole("button", { name: "New indent" }))).toBe(false);
      });

      await checks("The rows on screen are exactly what the API returns", async () => {
        await expectRowsToMatch(
          () => screen.indentNos(),
          all.map((delivery) => delivery.indent_no),
          "The deliveries list does not match /api/warehouse/acknowledgements/mine.",
        );
      });
    });

    if (!all.length) {
      // Said out loud, at report level. A green run on an empty screen must never
      // read as "deliveries work".
      checks.note(
        `${tester.label} has no deliveries at all, so the row, modal, photo and confirm paths on `
          + "My deliveries were NOT exercised. Everything below the empty state is unverified for this "
          + "account. Run this suite as an account that has an approved, dispatched indent to cover it.",
      );

      await log.runStep("With no deliveries, the screen says so and its filters still work", async () => {
        await checks("The empty state explains why the screen is blank", async () => {
          await expect(screen.emptyNothingOnItsWay).toBeVisible();
          await expect(
            page.getByText(/Indents you raise appear here once they are approved/),
          ).toBeVisible();
        });

        await checks("Searching an empty list changes the empty message rather than breaking", async () => {
          await screen.searchFor("no-such-delivery");
          await expect(screen.emptyNothingMatches).toBeVisible({ timeout: 15_000 });
          await expect(page.getByText("Try a different search or clear the filters.")).toBeVisible();
        });

        await checks("Clearing the search restores the original empty message", async () => {
          await screen.searchFor("");
          await expect(screen.emptyNothingOnItsWay).toBeVisible({ timeout: 15_000 });
        });

        await checks("The status filter can still be opened and applied", async () => {
          await screen.chooseStatus("Allocated");
          const expected = await indents.acknowledgements(acknowledgementsQuery({ status: "ALLOCATED" }), tester);
          await expectRowsToMatch(
            () => screen.indentNos(),
            expected.map((delivery) => delivery.indent_no),
            "The status filter does not match the API on an empty list.",
          );
        });
      });

      checks.assertAllPassed();
      return;
    }

    /* -------------------------------------------------------------- the filters */

    await log.runStep("Every filter on the screen matches what the API returns for it", async () => {
      const sample = all[0];

      await checks(`Searching an indent number ("${sample.indent_no}") narrows to that delivery`, async () => {
        await screen.searchFor(sample.indent_no);
        const expected = await indents.acknowledgements(acknowledgementsQuery({ search: sample.indent_no }), tester);
        await expectRowsToMatch(
          () => screen.indentNos(),
          expected.map((delivery) => delivery.indent_no),
          `The search for ${sample.indent_no} does not match the API.`,
        );
      });

      await checks("A search matching nothing shows 'Nothing matches', not a stale list", async () => {
        await screen.searchFor("no-such-delivery-anywhere");
        await expect(screen.emptyNothingMatches).toBeVisible({ timeout: 15_000 });
        expect(await screen.indentNos()).toEqual([]);
      });

      await checks("Clearing the search restores every delivery", async () => {
        await screen.searchFor("");
        await expectRowsToMatch(
          () => screen.indentNos(),
          all.map((delivery) => delivery.indent_no),
          "Clearing the search did not restore the full list.",
        );
      });

      // Only filter by statuses this account actually has, so a green result is
      // about the filter and not about an accident of the data.
      const presentStatuses = [...new Set(all.map((delivery) => delivery.status))];
      const statusLabels: Record<string, string> = {
        ALLOCATED: "Allocated",
        PARTIALLY_FULFILLED: "Partly received",
        PARTIALLY_ORDERED: "Partly ordered",
        ORDERED: "Ordered",
        PENDING_PROCUREMENT: "With procurement",
      };

      for (const status of presentStatuses) {
        const label = statusLabels[status];
        if (!label) {
          checks.note(`The status filter offers no option for "${status}", which this account holds.`);
          continue;
        }
        await checks(`Status '${label}' lists exactly the API's ${status} deliveries`, async () => {
          await screen.chooseStatus(label);
          const expected = await indents.acknowledgements(acknowledgementsQuery({ status }), tester);
          await expectRowsToMatch(
            () => screen.indentNos(),
            expected.map((delivery) => delivery.indent_no),
            `The '${label}' filter does not match the API.`,
          );
          expect(
            expected.every((delivery) => delivery.status === status),
            `The '${label}' filter returned deliveries in other statuses.`,
          ).toBe(true);
        });
      }

      await checks("'Any status' closes the dropdown, like every other option", async () => {
        await screen.statusSelect.click();
        const listbox = page.getByRole("listbox");
        await expect(listbox).toBeVisible({ timeout: 15_000 });
        await listbox.getByRole("option", { name: "Any status", exact: true }).first().click();
        await expect(
          listbox,
          "Choosing 'Any status' leaves the dropdown open — every other option closes it. Its option "
            + "carries an empty key, so react-aria never registers a selection change. While the overlay "
            + "is open HeroUI marks the rest of the page aria-hidden, so the list underneath cannot be "
            + "read and no other control can be used until the user presses Escape or clicks away. The "
            + "box also goes blank rather than reading 'Any status'. Giving the option a real key (say "
            + "\"ALL\") and mapping it to 'no filter' would fix both.",
        ).toBeHidden({ timeout: 5_000 });
      });

      await checks("'Any status' restores every delivery", async () => {
        // Escape first: the popover above is still open when that check fails,
        // and everything underneath it is aria-hidden until it closes.
        if (await screen.statusListboxIsOpen()) await page.keyboard.press("Escape");
        await expectRowsToMatch(
          () => screen.indentNos(),
          all.map((delivery) => delivery.indent_no),
          "'Any status' did not restore the full list.",
        );
      });

      await checks("'Ready to confirm' keeps only the deliveries that can be confirmed", async () => {
        await screen.toggleReadyToConfirm();
        const expected = await indents.acknowledgements(acknowledgementsQuery({ onlyActionable: true }), tester);
        await expectRowsToMatch(
          () => screen.indentNos(),
          expected.map((delivery) => delivery.indent_no),
          "'Ready to confirm' does not match the API.",
        );
        expect(
          expected.filter((delivery) => !delivery.can_acknowledge).map((d) => d.indent_no),
          "'Ready to confirm' kept deliveries that cannot be confirmed.",
        ).toEqual([]);
      });

      await checks("Turning 'Ready to confirm' off restores every delivery", async () => {
        await screen.toggleReadyToConfirm();
        await expectRowsToMatch(
          () => screen.indentNos(),
          all.map((delivery) => delivery.indent_no),
          "Turning the toggle off did not restore the full list.",
        );
      });
    });

    /* ------------------------------------------------------------- the summary */

    await log.runStep("Each row summarises the delivery honestly", async () => {
      const matrix = await screen.list.matrix();

      await checks("Each row states how many item lines the indent has", async () => {
        for (const [index, delivery] of all.entries()) {
          const row = matrix[index];
          expect(row, `Row ${index + 1} is missing.`).toBeDefined();
          expect(
            row.join(" | "),
            `Row for ${delivery.indent_no} does not show its ${delivery.lines.length} lines.`,
          ).toContain(String(delivery.lines.length));
        }
      });

      await checks("A delivery waiting to be confirmed says how much is waiting", async () => {
        const waiting = all.find((delivery) =>
          delivery.lines.reduce((sum, line) => sum + receivable(line), 0) > 0);
        if (!waiting) {
          checks.note("No delivery is currently waiting for confirmation, so its wording was not checked.");
          return;
        }
        const total = waiting.lines.reduce((sum, line) => sum + receivable(line), 0);
        await expect(
          screen.rowFor(waiting.indent_no),
          `${waiting.indent_no} has ${total} waiting but its row does not say so.`,
        ).toContainText("waiting for you to confirm");
      });

      await checks("Only deliveries that can be confirmed carry a Confirm button", async () => {
        for (const delivery of all) {
          const row = screen.rowFor(delivery.indent_no);
          const hasButton = await row.getByRole("button", { name: /^Confirm/ }).count() > 0;
          expect(
            hasButton,
            `${delivery.indent_no} can_acknowledge=${delivery.can_acknowledge} but its Confirm button `
              + `is ${hasButton ? "present" : "absent"}.`,
          ).toBe(delivery.can_acknowledge);
        }
      });
    });

    /* --------------------------------------------------------------- the modal */

    const openable = all.find((delivery) => delivery.can_acknowledge) ?? all[0];
    const confirmable = all.find((delivery) =>
      delivery.can_acknowledge && delivery.lines.some((line) => receivable(line) > 0));

    await log.runStep(`Open ${openable.indent_no} and check what the modal says`, async () => {
      await screen.open(openable.indent_no);

      await checks("The modal is titled with the indent number", async () => {
        await expect(screen.modalTitle).toHaveText(openable.indent_no);
      });

      await checks("The dialog has an accessible name, so it announces what it is", async () => {
        // `ConfirmModal` puts the title in HeroUI's `ModalHeader`, which is a
        // plain container: it looks like a heading and is not one, and nothing
        // ties it to the dialog. A dialog with no name announces as "dialog".
        const title = screen.modal;
        const named = await title.evaluate((node) =>
          Boolean(node.getAttribute("aria-label") || node.getAttribute("aria-labelledby")));
        const hasHeading = await screen.modal.getByRole("heading").count() > 0;
        expect(
          named || hasHeading,
          "The delivery dialog has no aria-label, no aria-labelledby and no heading inside it, so it "
            + "announces only as \"dialog\" — the indent number on screen is styled as a title but is "
            + "rendered as a plain div by ConfirmModal's ModalHeader. Making that title a heading, or "
            + "pointing aria-labelledby at it, would name the dialog.",
        ).toBe(true);
      });

      await checks("Every line of the indent is listed, with its approved, sent and received quantities", async () => {
        const rows = await screen.lineMatrix();
        expect(rows.length, "The modal lists a different number of lines to the API.").toBe(openable.lines.length);
        for (const [index, line] of openable.lines.entries()) {
          const cells = rows[index];
          expect(cells[0], `Line ${index + 1} does not name its item.`)
            .toContain(line.item_name ?? line.item_code ?? "");
          expect(Number(cells[1].replace(/,/g, "")), `Line ${index + 1} shows the wrong approved quantity.`)
            .toBe(Number(line.approved_quantity));
          expect(Number(cells[2].replace(/,/g, "")), `Line ${index + 1} shows the wrong sent quantity.`)
            .toBe(Number(line.dispatched_quantity));
          expect(Number(cells[3].replace(/,/g, "")), `Line ${index + 1} shows the wrong received quantity.`)
            .toBe(Number(line.received_quantity));
        }
      });

      const anythingToConfirm = openable.lines.some((line) => receivable(line) > 0);

      if (anythingToConfirm) {
        await checks("'Arrived now' is offered, capped at what was sent but not yet received", async () => {
          for (const line of openable.lines) {
            const max = receivable(line);
            if (max <= 0) continue;
            const field = screen.arrivedNow(line.item_name ?? line.item_code ?? "");
            await expect(field, "The 'Arrived now' field is missing for a line that has stock waiting.")
              .toBeVisible();
            expect(
              Number(await field.getAttribute("max")),
              `'Arrived now' would accept more than the ${max} actually sent for ${line.item_code}.`,
            ).toBe(max);
            expect(
              Number(await field.inputValue()),
              `'Arrived now' should default to the ${max} waiting for ${line.item_code}.`,
            ).toBe(max);
          }
        });

        await checks("A line with nothing waiting cannot have a quantity typed against it", async () => {
          const settled = openable.lines.find((line) => receivable(line) === 0);
          if (!settled) {
            checks.note("Every line on this delivery has stock waiting, so the disabled case was not covered.");
            return;
          }
          await expect(screen.arrivedNow(settled.item_name ?? settled.item_code ?? "")).toBeDisabled();
        });

        await checks("The photo rule is stated on screen before anything is confirmed", async () => {
          await expect(screen.modal.getByText("Photo of the goods")).toBeVisible();
          await expect(screen.photoWarning).toBeVisible();
        });
      } else {
        await checks("With nothing waiting, the modal offers only Close", async () => {
          await expect(screen.closeOnly).toBeVisible();
          expect(await isShown(screen.confirmReceipt)).toBe(false);
        });
      }

      await screen.close();
    });

    /* --------------------------------------------------- photos, and the rule */

    if (!confirmable) {
      checks.note(
        "No delivery is currently confirmable for this account, so photo upload, the no-photo rule and "
          + "the confirm itself were NOT exercised. Those paths remain unverified for this run.",
      );
      checks.assertAllPassed();
      return;
    }

    await log.runStep(`Attach and remove evidence on ${confirmable.indent_no}`, async () => {
      await screen.open(confirmable.indent_no);
      const before = await indents.attachments(confirmable.indent_id, tester);

      await checks("A photo can be attached, and is listed as a photo", async () => {
        await screen.addPhoto.setInputFiles({
          name: "goods-received.png",
          mimeType: "image/png",
          buffer: PIXEL_PNG,
        });
        await expect(
          screen.modal.getByText("goods-received.png"),
          "The uploaded photo did not appear in the attachment list.",
        ).toBeVisible({ timeout: 20_000 });
        await expect(screen.modal.getByText("Photo", { exact: true }).first()).toBeVisible();
      });

      await checks("Once a photo is attached the 'attach a photo' warning goes away", async () => {
        await expect(screen.photoWarning).toBeHidden({ timeout: 15_000 });
      });

      await checks("The server holds the photo, not just the screen", async () => {
        const after = await indents.attachments(confirmable.indent_id, tester);
        expect(
          after.length,
          "The attachment list on the server did not grow after the upload.",
        ).toBe(before.length + 1);
        expect(after.some((row) => row.file_name === "goods-received.png" && row.doc_category === "RECEIPT_PHOTO"))
          .toBe(true);
      });

      await checks("A bill can be attached alongside the photo, and is labelled as a bill", async () => {
        await screen.addBill.setInputFiles({
          name: "supplier-bill.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.from("%PDF-1.4 automated indent module run"),
        });
        await expect(screen.modal.getByText("supplier-bill.pdf")).toBeVisible({ timeout: 20_000 });
        const after = await indents.attachments(confirmable.indent_id, tester);
        expect(after.some((row) => row.file_name === "supplier-bill.pdf" && row.doc_category === "RECEIPT_BILL"))
          .toBe(true);
      });

      await checks("An attachment can be removed again", async () => {
        await screen.removeAttachment("supplier-bill.pdf").click();
        await expect(screen.modal.getByText("supplier-bill.pdf")).toBeHidden({ timeout: 20_000 });
        const after = await indents.attachments(confirmable.indent_id, tester);
        expect(after.some((row) => row.file_name === "supplier-bill.pdf")).toBe(false);
      });

      await checks("Removing the last photo brings the warning back", async () => {
        await screen.removeAttachment("goods-received.png").click();
        await expect(screen.photoWarning).toBeVisible({ timeout: 20_000 });
        const after = await indents.attachments(confirmable.indent_id, tester);
        expect(
          after.length,
          "The run left attachments behind on a real delivery.",
        ).toBe(before.length);
      });
    });

    await log.runStep("Confirming without a photo is refused", async () => {
      // Safe by construction: the server rejects it, so nothing is written. This is
      // also the only honest way to test the rule — the screen states it but does
      // not enforce it.
      await checks("The Confirm button is offered even with no photo attached", async () => {
        await expect(screen.confirmReceipt).toBeEnabled();
        checks.note(
          "'I received these' stays enabled while the screen is still saying 'Attach at least one photo "
            + "before confirming'. The rule is enforced by the server, not the form, so the only feedback "
            + "is an error after the click. Disabling the button until a photo is attached would say it sooner.",
        );
      });

      await checks("Clicking it is refused by the server, with the reason shown", async () => {
        const [response] = await Promise.all([
          page.waitForResponse(
            (candidate) => new URL(candidate.url()).pathname === `/api/indents/${confirmable.indent_id}/acknowledge`,
            { timeout: 45_000 },
          ),
          screen.confirmReceipt.click(),
        ]);
        expect(
          response.status(),
          `Confirming with no photo returned ${response.status()} — the photo rule is not being enforced.`,
        ).toBeGreaterThanOrEqual(400);
        await expect(
          screen.modal.getByText(/photo/i).first(),
          "The refusal was not explained on screen.",
        ).toBeVisible({ timeout: 15_000 });
      });

      await checks("Nothing was received as a result of the refused confirm", async () => {
        const after = await indents.acknowledgements(acknowledgementsQuery({ search: confirmable.indent_no }), tester);
        const row = after.find((delivery) => delivery.indent_id === confirmable.indent_id);
        expect(row, "The delivery disappeared after a refused confirm.").toBeDefined();
        for (const [index, line] of (row!.lines ?? []).entries()) {
          expect(
            Number(line.received_quantity),
            `Line ${index + 1} recorded a receipt from a confirm the server refused.`,
          ).toBe(Number(confirmable.lines[index].received_quantity));
        }
      });
    });

    if (!config.allowDeliveryConfirm) {
      checks.note(
        "The full receipt — photo, quantity, confirm, status change — was NOT run, because it writes "
          + `received quantities on a real indent (${confirmable.indent_no}) and cannot be undone. `
          + "Set ALLOW_DELIVERY_CONFIRM=true in playwright-tests/.env to include it.",
      );
      await screen.close();
      checks.assertAllPassed();
      return;
    }

    await log.runStep(`Confirm receipt of ${confirmable.indent_no} in full`, async () => {
      const line = confirmable.lines.find((candidate) => receivable(candidate) > 0)!;
      const expected = Number(line.received_quantity) + receivable(line);

      await checks("With a photo and a quantity, the confirm is accepted", async () => {
        await screen.addPhoto.setInputFiles({
          name: "goods-received.png",
          mimeType: "image/png",
          buffer: PIXEL_PNG,
        });
        await expect(screen.modal.getByText("goods-received.png")).toBeVisible({ timeout: 20_000 });
        const [response] = await Promise.all([
          page.waitForResponse(
            (candidate) => new URL(candidate.url()).pathname === `/api/indents/${confirmable.indent_id}/acknowledge`,
            { timeout: 45_000 },
          ),
          screen.confirmReceipt.click(),
        ]);
        expect(
          response.ok(),
          `Confirming with a photo was refused: ${response.status()} ${await response.text()}`,
        ).toBe(true);
      });

      await checks("The modal closes once the receipt is recorded", async () => {
        await expect(screen.modal).toBeHidden({ timeout: 20_000 });
        await settle(page);
      });

      await checks("The received quantity on the server went up by what was confirmed", async () => {
        const after = await indents.acknowledgements("", tester);
        const row = after.find((delivery) => delivery.indent_id === confirmable.indent_id);
        if (!row) {
          // A fully received indent leaves the list, which is itself the right outcome.
          const indent = await indents.indent(confirmable.indent_id, tester);
          expect(
            ["PARTIALLY_FULFILLED", "CLOSED"],
            `After a full receipt ${confirmable.indent_no} sits in ${indent.status}.`,
          ).toContain(indent.status);
          return;
        }
        const updated = row.lines.find((candidate) => candidate.indent_item_id === line.indent_item_id)!;
        expect(Number(updated.received_quantity)).toBe(expected);
      });
    });

    checks.assertAllPassed();
  });
});
