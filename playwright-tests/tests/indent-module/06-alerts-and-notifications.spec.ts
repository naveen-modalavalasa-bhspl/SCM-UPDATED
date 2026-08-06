import { test, expect } from "./support/fixtures.js";
import {
  Notifications, currentQuery, goToPage, isShown, isoDate, pageTitle,
  pagerButton, raisedRange, readPager, settle,
} from "./support/screens.js";
import {
  PAGE_SIZE, expectRowsToMatch, expectValueToMatch, notificationsQuery,
} from "./support/oracle.js";

/**
 * Indent › Alert & Notification.
 *
 * The status alerts raised against this account's indents, and every control on
 * the screen: search, notification date, status, paging, and the row that opens
 * the indent behind the alert.
 *
 * A notification here is not a stored record — it is derived from an indent's
 * current status, and only for statuses past DRAFT. So this screen, alone in the
 * module, cannot be seeded by a single account: raising drafts produces nothing.
 * The run therefore tests against whatever alerts this account actually has, and
 * when it has none it says so at report level rather than passing quietly. That
 * derivation is also worth checking in its own right, which is why the run
 * confirms a Draft filter returns nothing: drafts are deliberately silent.
 */

const NOTIFICATIONS = "/indents/notifications";

/** Filter options, and the status each one asks the API for. */
const STATUS_OPTIONS = [
  { label: "Pending approvals", value: "PENDING_APPROVAL" },
  { label: "Awaiting allocation", value: "AWAITING_ALLOCATION" },
  { label: "Allocated", value: "ALLOCATED" },
  { label: "Partially fulfilled", value: "PARTIALLY_FULFILLED" },
  { label: "Rejected", value: "REJECTED" },
  { label: "Returned for correction", value: "RETURNED_FOR_CORRECTION" },
  { label: "Fulfilled", value: "CLOSED" },
] as const;

test.describe("Indent › Alert & Notification", () => {
  test("Alerts list, filter and page correctly", async ({
    page, goto, log, checks, indents, tester,
  }) => {
    const screen = new Notifications(page);

    await goto(NOTIFICATIONS, "Alert & Notification");

    const all = await indents.notifications(notificationsQuery(""), tester);

    await log.runStep("The screen renders with the controls it should have — and only those", async () => {
      await checks("The screen is titled 'Alert & Notification'", async () => {
        await expect(pageTitle(page)).toHaveText("Alert & Notification");
      });

      await checks("The search box and the notification-date filter are offered", async () => {
        await expect(screen.filters.search).toBeVisible();
        await expect(screen.filters.dateTrigger("Notification date")).toBeVisible();
      });

      await checks("The status filter is offered", async () => {
        await expect(screen.filters.statusTrigger).toBeVisible();
      });

      await checks("Priority is not offered — an alert has no priority of its own", async () => {
        expect(await isShown(screen.filters.priorityTrigger)).toBe(false);
      });

      await checks("Required-by is not offered — an alert is not something you need by a date", async () => {
        expect(await isShown(screen.filters.dateTrigger("Required by"))).toBe(false);
      });

      await checks("'New indent' is not offered — this screen does not raise anything", async () => {
        expect(await isShown(page.getByRole("button", { name: "New indent" }))).toBe(false);
      });

      await checks("The alerts on screen are exactly what the API returns, in order", async () => {
        await expectRowsToMatch(
          async () => (await screen.entries()).map((entry) => entry.title),
          all.items.map((item) => item.title),
          "The alerts on screen do not match /api/indents/notifications.",
        );
      });

      await checks("Each alert carries the message the API gave it", async () => {
        const shown = await screen.entries();
        for (const [index, item] of all.items.entries()) {
          expect(
            shown[index]?.message,
            `Alert ${index + 1} shows a different message to the API.`,
          ).toBe(item.message);
        }
      });

      await checks("The footer reports the API's total and page count", async () => {
        const pager = await readPager(page);
        expect(pager, "No pagination footer was rendered.").not.toBeNull();
        expect(pager!.total).toBe(all.total);
        expect(pager!.pages).toBe(Math.max(1, Math.ceil(all.total / PAGE_SIZE)));
      });
    });

    if (!all.items.length) {
      checks.note(
        `${tester.label} has no status alerts at all, so search, date and status filtering could only be `
          + "checked against an empty list, and the row-opens-the-indent path was NOT exercised. "
          + "Alerts derive from indents past DRAFT, so run this suite as an account with a submitted or "
          + "approved indent to cover this screen properly.",
      );

      await log.runStep("With no alerts, the screen says so and its controls still work", async () => {
        await checks("The empty state explains the blank screen", async () => {
          await expect(screen.empty).toBeVisible();
        });

        await checks("Searching an empty list changes the query without breaking the screen", async () => {
          await screen.filters.searchFor("anything");
          await expect(screen.empty).toBeVisible({ timeout: 15_000 });
          expect(new URLSearchParams(currentQuery(page)).get("search")).toBe("anything");
        });

        await checks("The date filter still applies to an empty list", async () => {
          await screen.filters.clearSearch();
          const range = raisedRange("this_month");
          await screen.filters.applyDatePreset(
            "Notification date",
            "This month",
            (params) => params.get("date_from") === range.from && params.get("date_to") === range.to,
          );
          await expect(screen.empty).toBeVisible({ timeout: 15_000 });
        });

        await checks("The status filter still applies to an empty list", async () => {
          await screen.filters.resetAll();
          await screen.filters.selectStatus("Pending approvals", "PENDING_APPROVAL");
          expect(new URLSearchParams(currentQuery(page)).getAll("status")).toEqual(["PENDING_APPROVAL"]);
          await expect(screen.empty).toBeVisible({ timeout: 15_000 });
        });
      });

      checks.assertAllPassed();
      return;
    }

    /* -------------------------------------------------------------- the search */

    await log.runStep("The search box narrows the alerts", async () => {
      const sample = all.items[0];

      await checks(`Searching an indent number ("${sample.indent_no}") leaves only its alerts`, async () => {
        await screen.filters.searchFor(sample.indent_no);
        const expected = await indents.notifications(notificationsQuery(currentQuery(page)), tester);
        await expectRowsToMatch(
          async () => (await screen.entries()).map((entry) => entry.title),
          expected.items.map((item) => item.title),
          `The alerts do not match the API for search "${sample.indent_no}".`,
        );
        expect(
          expected.items.every((item) => item.indent_no === sample.indent_no),
          "Searching one indent number returned other indents' alerts.",
        ).toBe(true);
      });

      await checks("Searching an alert title matches the API", async () => {
        await screen.filters.searchFor(sample.title);
        const expected = await indents.notifications(notificationsQuery(currentQuery(page)), tester);
        await expectRowsToMatch(
          async () => (await screen.entries()).map((entry) => entry.title),
          expected.items.map((item) => item.title),
          `The alerts do not match the API for search "${sample.title}".`,
        );
      });

      await checks("A search matching nothing shows the empty state, not a stale list", async () => {
        await screen.filters.searchFor("no-such-alert-anywhere-12345");
        await expect(screen.empty).toBeVisible({ timeout: 15_000 });
        expect(await screen.rows().count()).toBe(0);
        expect((await readPager(page))?.total).toBe(0);
      });

      await checks("Searching resets the list to page 1", async () => {
        expect(new URLSearchParams(currentQuery(page)).get("page")).toBeNull();
      });

      await checks("Clearing the search restores every alert", async () => {
        await screen.filters.clearSearch();
        await expectRowsToMatch(
          async () => (await screen.entries()).map((entry) => entry.title),
          all.items.map((item) => item.title),
          "Clearing the search did not restore the alerts.",
        );
      });
    });

    /* --------------------------------------------------- the notification date */

    await log.runStep("The notification-date filter cuts by when the alert was raised", async () => {
      for (const preset of ["Today", "This week", "This month"] as const) {
        const key = preset === "Today" ? "today" : preset === "This week" ? "this_week" : "this_month";
        const range = raisedRange(key);

        await screen.filters.applyDatePreset(
          "Notification date",
          preset,
          (params) => params.get("date_from") === range.from && params.get("date_to") === range.to,
        );

        const expected = await indents.notifications(notificationsQuery(currentQuery(page)), tester);

        await checks(`Notification date '${preset}' resolves to ${range.from} … ${range.to} and matches the API`, async () => {
          await expectRowsToMatch(
            async () => (await screen.entries()).map((entry) => entry.title),
            expected.items.map((item) => item.title),
            `The alerts do not match the API for notification date '${preset}'.`,
          );
        });

        await checks(`Notification date '${preset}' is never wider than 'This month'`, async () => {
          const month = raisedRange("this_month");
          const monthTotal = (await indents.notifications(
            notificationsQuery(`date_from=${month.from}&date_to=${month.to}`), tester)).total;
          expect(
            expected.total,
            `'${preset}' returned more alerts than the whole month containing it.`,
          ).toBeLessThanOrEqual(monthTotal);
        });
      }

      const pastFrom = isoDate(-3650);
      const pastTo = isoDate(-3600);
      await screen.filters.applyCustomRange(
        "Notification date",
        pastFrom,
        pastTo,
        (params) => params.get("date_from") === pastFrom && params.get("date_to") === pastTo,
      );

      await checks("A ten-year-old window returns nothing, and says so", async () => {
        const expected = await indents.notifications(notificationsQuery(currentQuery(page)), tester);
        expect(expected.total, "A decade-old date window still returned alerts.").toBe(0);
        await expect(screen.empty).toBeVisible({ timeout: 15_000 });
      });

      await checks("An end date before the start date is refused, with a reason", async () => {
        const popup = await screen.filters.openDate("Notification date");
        await popup.getByRole("button", { name: "Custom range", exact: true }).click();
        await popup.getByLabel("Notification date from").fill(isoDate(0));
        await popup.getByLabel("Notification date to").fill(isoDate(-5));
        await expect(
          popup.getByText("To date must be the same as or later than From date."),
        ).toBeVisible();
        await expect(popup.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
        await screen.filters.closeDate("Notification date");
      });

      await screen.filters.resetAll();
    });

    /* -------------------------------------------------------------- the status */

    await log.runStep("The status filter keeps only alerts in the statuses chosen", async () => {
      const present = [...new Set(all.items.map((item) => item.status))];

      for (const option of STATUS_OPTIONS) {
        // Only assert on statuses this account has, so a pass is about the filter
        // rather than about the data happening to be empty either way.
        if (!present.includes(option.value)) continue;

        await screen.filters.selectStatus(option.label, option.value);
        const expected = await indents.notifications(notificationsQuery(currentQuery(page)), tester);

        await checks(`Status '${option.label}' matches the API`, async () => {
          await expectRowsToMatch(
            async () => (await screen.entries()).map((entry) => entry.title),
            expected.items.map((item) => item.title),
            `The alerts do not match the API for status '${option.label}'.`,
          );
        });

        await checks(`Status '${option.label}' leaves no alert in another status`, async () => {
          expect(
            [...new Set(expected.items.map((item) => item.status))],
            `Filtering to ${option.value} returned other statuses.`,
          ).toEqual([option.value]);
        });

        await checks(`Status '${option.label}' is shown back as a chip`, async () => {
          const chips = (await screen.filters.chipTexts()).join(" | ");
          expect(chips, `Chips read: ${chips || "(none)"}`).toContain(option.label);
        });

        await screen.filters.deselectStatus(option.label, option.value);
      }

      if (present.length >= 2) {
        const [first, second] = present
          .map((status) => STATUS_OPTIONS.find((option) => option.value === status))
          .filter(Boolean)
          .slice(0, 2) as { label: string; value: string }[];

        await checks(`Selecting '${first.label}' and '${second.label}' widens rather than narrows`, async () => {
          await screen.filters.selectStatus(first.label, first.value);
          const one = await indents.notifications(notificationsQuery(currentQuery(page)), tester);
          await screen.filters.selectStatus(second.label, second.value);
          const both = await indents.notifications(notificationsQuery(currentQuery(page)), tester);
          expect(
            both.total,
            "Selecting a second status did not widen the result — the statuses are not being OR-ed.",
          ).toBeGreaterThan(one.total);
          await expectRowsToMatch(
            async () => (await screen.entries()).map((entry) => entry.title),
            both.items.map((item) => item.title),
            "Two statuses together do not match the API.",
          );
          await screen.filters.resetAll();
        });
      } else {
        checks.note(
          "This account's alerts are all in one status, so selecting two statuses at once was not covered.",
        );
      }

      await checks("Filtering to Draft returns nothing — drafts raise no alert by design", async () => {
        await screen.filters.selectStatus("Draft", "DRAFT");
        const expected = await indents.notifications(notificationsQuery(currentQuery(page)), tester);
        expect(expected.total, "A draft indent produced a status alert.").toBe(0);
        await expect(screen.empty).toBeVisible({ timeout: 15_000 });
        await screen.filters.resetAll();
      });

      await checks("'Clear all' empties the query string and restores every alert", async () => {
        expect(currentQuery(page)).toBe("");
        await expectRowsToMatch(
          async () => (await screen.entries()).map((entry) => entry.title),
          all.items.map((item) => item.title),
          "'Clear all' did not restore the alerts.",
        );
      });
    });

    /* ----------------------------------------------------------- pagination */

    const totalPages = Math.max(1, Math.ceil(all.total / PAGE_SIZE));

    if (totalPages > 1) {
      await log.runStep("Paging moves through real, different alerts", async () => {
        await checks("'Previous' is disabled on page 1", async () => {
          await expect(pagerButton(page, "Previous")).toBeDisabled();
        });

        const pageOne = (await screen.entries()).map((entry) => `${entry.title}|${entry.message}`);

        await checks("'Next' goes to page 2 and puts the page in the URL", async () => {
          await goToPage(page, "Next", 2);
          expect(new URLSearchParams(currentQuery(page)).get("page")).toBe("2");
          expect((await readPager(page))?.page).toBe(2);
        });

        await checks("Page 2 shows the API's second page", async () => {
          const expected = await indents.notifications(notificationsQuery("", { page: 2 }), tester);
          await expectRowsToMatch(
            async () => (await screen.entries()).map((entry) => entry.title),
            expected.items.map((item) => item.title),
            "Page 2 does not match the API's second page.",
          );
        });

        await checks("Page 2 repeats no alert from page 1", async () => {
          const pageTwo = (await screen.entries()).map((entry) => `${entry.title}|${entry.message}`);
          const overlap = pageTwo.filter((key) => pageOne.includes(key));
          expect(overlap.length, `${overlap.length} alerts appeared on both pages.`).toBe(0);
        });

        await checks("'Previous' returns to page 1", async () => {
          await goToPage(page, "Previous", 1);
          expect(new URLSearchParams(currentQuery(page)).get("page")).toBeNull();
          await expectValueToMatch(
            async () => (await screen.entries()).map((entry) => `${entry.title}|${entry.message}`),
            pageOne,
            "Going back did not restore page 1.",
          );
        });

        await checks("'Next' is disabled on the last page", async () => {
          await goto(`${NOTIFICATIONS}?page=${totalPages}`, `Alerts, page ${totalPages}`);
          await expect(pagerButton(page, "Next")).toBeDisabled();
        });

        await checks("A page number past the end is corrected to the last page", async () => {
          await goto(`${NOTIFICATIONS}?page=999999`, "Alerts, page 999999");
          await expect(page).toHaveURL(
            (url) => new URLSearchParams(url.search).get("page") === String(totalPages),
            { timeout: 20_000 },
          );
          expect((await readPager(page))?.page).toBe(totalPages);
        });
      });
    } else {
      checks.note(
        `This account has ${all.total} alert(s), which fits on one page, so paging on `
          + "Alert & Notification was NOT exercised.",
      );
    }

    /* --------------------------------------------------------------- URL state */

    await log.runStep("A filtered alert list can be reloaded and shared", async () => {
      await goto(NOTIFICATIONS, "Alerts, unfiltered");
      await screen.filters.searchFor(all.items[0].indent_no);
      const shared = currentQuery(page);

      await checks("Reloading keeps the filter and the same alerts", async () => {
        const before = (await screen.entries()).map((entry) => entry.title);
        await page.reload();
        await settle(page);
        expect(currentQuery(page)).toBe(shared);
        await expectRowsToMatch(
          async () => (await screen.entries()).map((entry) => entry.title),
          before,
          "A reload changed the filtered alert list.",
        );
      });

      await checks("An unrecognised status in the URL is dropped rather than sent on", async () => {
        await goto(`${NOTIFICATIONS}?status=NOT_A_STATUS`, "Alerts with a junk status");
        expect(currentQuery(page), "An unrecognised status survived in the URL.").toBe("");
      });
    });

    /* ------------------------------------------------------------- the way in */

    await log.runStep("An alert leads into the indent behind it, and back again", async () => {
      const target = all.items[0];
      await goto(
        `${NOTIFICATIONS}?search=${encodeURIComponent(target.indent_no)}`,
        `Alerts for ${target.indent_no}`,
      );
      const listUrl = currentQuery(page);

      await checks("Clicking an alert opens the indent it is about", async () => {
        const opened = await screen.openRow(0);
        expect(opened, "The alert opened a different indent.").toBe(target.indent_id);
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(target.indent_no);
      });

      await checks("The way back is labelled 'Alert & Notification'", async () => {
        await expect(page.getByRole("button", { name: /Alert & Notification/ }).first()).toBeVisible();
      });

      await checks("Going back returns to the alerts with the search still applied", async () => {
        await page.getByRole("button", { name: /Alert & Notification/ }).first().click();
        await page.waitForURL(/\/indents\/notifications(\?.*)?$/, { timeout: 30_000 });
        await settle(page);
        expect(currentQuery(page), "Going back threw away the filter that led there.").toBe(listUrl);
      });
    });

    checks.assertAllPassed();
  });
});
