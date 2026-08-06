import { seededTest as test, expect } from "./support/fixtures.js";
import {
  ActivityLedger, currentQuery, goToPage, isoDate, isShown, pageTitle,
  pagerButton, raisedRange, readPager, settle,
} from "./support/screens.js";
import {
  PAGE_SIZE, activityQuery, expectRowsToMatch, expectValueToMatch,
} from "./support/oracle.js";

/**
 * Indent › Activity ledger.
 *
 * A read-only trail of everything that has happened to the indents this account
 * can see. Every control on it — search, activity date, event, paging — and the
 * row that leads back into an indent.
 *
 * The run's own seeding guarantees this screen has something to show: raising a
 * draft writes a "Request created" event, so `SEED_COUNT` drafts put at least
 * that many rows in the ledger and give paging more than one page to move
 * through. Nothing here writes anything; the ledger is append-only by design and
 * the test treats it that way.
 */

const LEDGER = "/indents/reports";

/** The Event dropdown's options, and the event label each one leaves behind. */
const EVENTS = [
  { label: "Request created", value: "REQUEST_CREATED", shownAs: "Request created" },
  { label: "Request submitted", value: "REQUEST_SUBMITTED", shownAs: "Request submitted" },
  { label: "Approval completed", value: "APPROVAL_COMPLETED", shownAs: "Approval completed" },
  { label: "Stock allocated", value: "STOCK_ALLOCATED", shownAs: "Stock allocated" },
] as const;

test.describe("Indent › Activity ledger", () => {
  test("The ledger lists, filters and pages correctly", async ({
    page, goto, log, checks, indents, tester, dataset,
  }) => {
    const screen = new ActivityLedger(page);

    await goto(LEDGER, "Activity ledger");

    await log.runStep("The ledger renders its columns and its first page", async () => {
      await checks("The screen is titled 'Activity ledger'", async () => {
        await expect(pageTitle(page)).toHaveText("Activity ledger");
      });

      for (const column of ActivityLedger.COLUMNS) {
        await checks(`The '${column}' column is present`, async () => {
          await expect(screen.list.header(column)).toBeVisible();
        });
      }

      await checks("'New indent' is not offered — the ledger is read-only", async () => {
        expect(await isShown(page.getByRole("button", { name: "New indent" }))).toBe(false);
      });

      await checks("The rows on screen are exactly the API's first page, in order", async () => {
        const expected = await indents.activity(activityQuery(""), tester);
        await expectRowsToMatch(
          () => screen.indentNos(),
          expected.items.map((row) => row.indent_no),
          "The ledger does not match /api/indents/activity.",
        );
      });

      await checks("The footer reports the API's total and page count", async () => {
        const expected = await indents.activity(activityQuery(""), tester);
        const pager = await readPager(page);
        expect(pager, "No pagination footer was rendered.").not.toBeNull();
        expect(pager!.total).toBe(expected.total);
        expect(pager!.pages).toBe(Math.max(1, Math.ceil(expected.total / PAGE_SIZE)));
      });

      await checks("Every seeded draft left a 'Request created' event behind", async () => {
        const created = await indents.activity(activityQuery("transaction_type=REQUEST_CREATED&size=200"), tester);
        const seen = new Set(created.items.map((row) => row.indent_no));
        const missing = dataset.drafts.filter((draft) => !seen.has(draft.indentNo)).map((d) => d.indentNo);
        expect(
          missing,
          `These indents were raised but never appear in the ledger: ${missing.slice(0, 5).join(", ")}.`,
        ).toEqual([]);
      });

      await checks("No row is left saying its time or its result is unavailable", async () => {
        const matrix = await screen.list.matrix();
        const broken = matrix
          .filter((cells) => cells.join(" ").includes("unavailable"))
          .map((cells) => cells.slice(0, 3).join(" | "));
        expect(broken, `Rows rendered with missing data: ${broken.slice(0, 3).join(" ; ")}`).toEqual([]);
      });
    });

    /* -------------------------------------------------------------- the search */

    await log.runStep("The search box narrows the ledger on the fields it searches", async () => {
      const sample = dataset.drafts[0];

      await checks(`Searching an indent number ("${sample.indentNo}") leaves only that indent's events`, async () => {
        await screen.filters.searchFor(sample.indentNo);
        const expected = await indents.activity(activityQuery(currentQuery(page)), tester);
        await expectRowsToMatch(
          () => screen.indentNos(),
          expected.items.map((row) => row.indent_no),
          `The ledger does not match the API for search "${sample.indentNo}".`,
        );
        expect(
          [...new Set(await screen.indentNos())],
          "Searching one indent number returned other indents' events.",
        ).toEqual([sample.indentNo]);
      });

      await checks("Searching an event name leaves only that kind of event", async () => {
        await screen.filters.searchFor("Request created");
        const expected = await indents.activity(activityQuery(currentQuery(page)), tester);
        await expectRowsToMatch(
          () => screen.indentNos(),
          expected.items.map((row) => row.indent_no),
          "The ledger does not match the API for an event-name search.",
        );
        const events = [...new Set(await screen.events())];
        expect(
          events.filter((event) => !/request created/i.test(event)),
          `Searching "Request created" also returned: ${events.join(", ")}.`,
        ).toEqual([]);
      });

      if (dataset.departmentName) {
        await checks(`Searching a department name ("${dataset.departmentName}") matches the API`, async () => {
          await screen.filters.searchFor(dataset.departmentName);
          const expected = await indents.activity(activityQuery(currentQuery(page)), tester);
          await expectRowsToMatch(
            () => screen.indentNos(),
            expected.items.map((row) => row.indent_no),
            "The ledger does not match the API for a department search.",
          );
        });
      }

      if (dataset.requesterName) {
        await checks(`Searching an actor name ("${dataset.requesterName}") matches the API`, async () => {
          await screen.filters.searchFor(dataset.requesterName);
          const expected = await indents.activity(activityQuery(currentQuery(page)), tester);
          await expectRowsToMatch(
            () => screen.indentNos(),
            expected.items.map((row) => row.indent_no),
            "The ledger does not match the API for an actor search.",
          );
        });
      }

      await checks("A search matching nothing shows the empty state, not a stale list", async () => {
        await screen.filters.searchFor(`no-such-activity-${dataset.runId}`);
        await expect(screen.list.emptyCell).toBeVisible({ timeout: 15_000 });
        expect(await screen.indentNos()).toEqual([]);
        expect((await readPager(page))?.total).toBe(0);
      });

      await checks("Searching resets the ledger to page 1", async () => {
        expect(new URLSearchParams(currentQuery(page)).get("page")).toBeNull();
      });

      await checks("Clearing the search restores the full ledger", async () => {
        await screen.filters.clearSearch();
        const expected = await indents.activity(activityQuery(""), tester);
        await expectRowsToMatch(
          () => screen.indentNos(),
          expected.items.map((row) => row.indent_no),
          "Clearing the search did not restore the ledger.",
        );
      });
    });

    /* ------------------------------------------------------- the activity date */

    await log.runStep("The activity-date filter cuts by when the activity happened", async () => {
      for (const preset of ["Today", "This week", "This month"] as const) {
        const key = preset === "Today" ? "today" : preset === "This week" ? "this_week" : "this_month";
        const range = raisedRange(key);

        await screen.filters.applyDatePreset(
          "Activity date",
          preset,
          (params) => params.get("date_from") === range.from && params.get("date_to") === range.to,
        );

        const expected = await indents.activity(activityQuery(currentQuery(page)), tester);

        await checks(`Activity date '${preset}' resolves to ${range.from} … ${range.to} and matches the API`, async () => {
          await expectRowsToMatch(
            () => screen.indentNos(),
            expected.items.map((row) => row.indent_no),
            `The ledger does not match the API for activity date '${preset}'.`,
          );
        });

        await checks(`Activity date '${preset}' contains the events the run just created`, async () => {
          const wide = await indents.activity(
            activityQuery(`date_from=${range.from}&date_to=${range.to}&size=500`), tester);
          const seen = new Set(wide.items.map((row) => row.indent_no));
          const found = dataset.drafts.filter((draft) => seen.has(draft.indentNo)).length;
          expect(found, `'${preset}' contains none of the events the run raised moments ago.`).toBeGreaterThan(0);
        });
      }

      const pastFrom = isoDate(-60);
      const pastTo = isoDate(-31);
      await screen.filters.applyCustomRange(
        "Activity date",
        pastFrom,
        pastTo,
        (params) => params.get("date_from") === pastFrom && params.get("date_to") === pastTo,
      );

      await checks("A window that closed a month ago excludes everything that happened today", async () => {
        const expected = await indents.activity(activityQuery(currentQuery(page)), tester);
        await expectRowsToMatch(
          () => screen.indentNos(),
          expected.items.map((row) => row.indent_no),
          "A past custom range does not match the API.",
        );
        const shown = await screen.indentNos();
        expect(
          shown.filter((indentNo) => dataset.indentNos.has(indentNo)),
          "Events from today appeared in a window that closed a month ago.",
        ).toEqual([]);
      });

      await checks("An end date before the start date is refused, with a reason", async () => {
        const popup = await screen.filters.openDate("Activity date");
        await popup.getByRole("button", { name: "Custom range", exact: true }).click();
        await popup.getByLabel("Activity date from").fill(isoDate(0));
        await popup.getByLabel("Activity date to").fill(isoDate(-5));
        await expect(
          popup.getByText("To date must be the same as or later than From date."),
        ).toBeVisible();
        await expect(popup.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
        await screen.filters.closeDate("Activity date");
      });

      await screen.filters.resetAll();
    });

    /* ------------------------------------------------------------- the events */

    await log.runStep("The Event filter keeps one kind of event at a time", async () => {
      for (const event of EVENTS) {
        await screen.filters.selectStatus(event.label, event.value, "transaction_type");
        const expected = await indents.activity(activityQuery(currentQuery(page)), tester);

        await checks(`Event '${event.label}' matches the API`, async () => {
          await expectRowsToMatch(
            () => screen.indentNos(),
            expected.items.map((row) => row.indent_no),
            `The ledger does not match the API for event '${event.label}'.`,
          );
        });

        await checks(`Event '${event.label}' leaves no other kind of event on screen`, async () => {
          if (!expected.total) {
            checks.note(`This account has no '${event.label}' activity, so its rows could not be inspected.`);
            await expect(screen.list.emptyCell).toBeVisible({ timeout: 15_000 });
            return;
          }
          const events = [...new Set(await screen.events())];
          expect(
            events.filter((shown) => shown.trim() !== event.shownAs),
            `Filtering to '${event.label}' also showed: ${events.join(", ")}.`,
          ).toEqual([]);
        });

        await checks(`Event '${event.label}' is shown back as a chip`, async () => {
          const chips = (await screen.filters.chipTexts()).join(" | ");
          expect(chips, `Chips read: ${chips || "(none)"}`).toContain(event.label);
        });
      }

      await checks("Choosing a second event replaces the first — this filter takes one value", async () => {
        await screen.filters.selectStatus("Request created", "REQUEST_CREATED", "transaction_type");
        const values = new URLSearchParams(currentQuery(page)).getAll("transaction_type");
        expect(
          values,
          `The Event filter is carrying ${values.length} values: ${values.join(", ")}.`,
        ).toEqual(["REQUEST_CREATED"]);
      });

      await checks("Search and Event together match the API for both at once", async () => {
        await screen.filters.searchFor(dataset.drafts[0].indentNo);
        const expected = await indents.activity(activityQuery(currentQuery(page)), tester);
        await expectRowsToMatch(
          () => screen.indentNos(),
          expected.items.map((row) => row.indent_no),
          "Search + Event does not match the API.",
        );
        expect(
          expected.items.every((row) => row.indent_no === dataset.drafts[0].indentNo),
          "Combining search with the event filter leaked other indents in.",
        ).toBe(true);
      });

      await checks("'Clear all' empties the query string and restores the ledger", async () => {
        await screen.filters.resetAll();
        expect(currentQuery(page)).toBe("");
        expect(await screen.filters.chipTexts()).toEqual([]);
        const expected = await indents.activity(activityQuery(""), tester);
        await expectRowsToMatch(
          () => screen.indentNos(),
          expected.items.map((row) => row.indent_no),
          "'Clear all' did not restore the ledger.",
        );
      });
    });

    /* ----------------------------------------------------------- pagination */

    await log.runStep("Paging moves through real, different rows", async () => {
      const firstPage = await indents.activity(activityQuery(""), tester);
      const totalPages = Math.max(1, Math.ceil(firstPage.total / PAGE_SIZE));

      expect(
        totalPages,
        `The ledger holds only ${firstPage.total} events, so paging cannot be tested.`,
      ).toBeGreaterThan(1);

      await checks("'Previous' is disabled on page 1", async () => {
        await expect(pagerButton(page, "Previous")).toBeDisabled();
      });

      const pageOne = await screen.list.matrix();

      await checks("'Next' goes to page 2 and puts the page in the URL", async () => {
        await goToPage(page, "Next", 2);
        expect(new URLSearchParams(currentQuery(page)).get("page")).toBe("2");
        expect((await readPager(page))?.page).toBe(2);
      });

      await checks("Page 2 shows the API's second page", async () => {
        const expected = await indents.activity(activityQuery("", { page: 2 }), tester);
        await expectRowsToMatch(
          () => screen.indentNos(),
          expected.items.map((row) => row.indent_no),
          "Page 2 does not match the API's second page.",
        );
      });

      await checks("Page 2 repeats no row from page 1", async () => {
        const pageTwo = await screen.list.matrix();
        const asKey = (cells: string[]) => cells.join("|");
        const overlap = pageTwo.map(asKey).filter((key) => pageOne.map(asKey).includes(key));
        expect(overlap.length, `${overlap.length} rows appeared on both pages.`).toBe(0);
      });

      await checks("'Previous' returns to page 1", async () => {
        await goToPage(page, "Previous", 1);
        expect(new URLSearchParams(currentQuery(page)).get("page")).toBeNull();
        await expectValueToMatch(
          async () => (await screen.list.matrix()).map((cells) => cells.join("|")),
          pageOne.map((cells) => cells.join("|")),
          "Going back did not restore page 1.",
        );
      });

      await checks("'Next' is disabled on the last page", async () => {
        await goto(`${LEDGER}?page=${totalPages}`, `Activity ledger, page ${totalPages}`);
        await expect(pagerButton(page, "Next")).toBeDisabled();
      });

      await checks("A page number past the end is corrected to the last page", async () => {
        await goto(`${LEDGER}?page=999999`, "Activity ledger, page 999999");
        await expect(page).toHaveURL(
          (url) => {
            const value = new URLSearchParams(url.search).get("page");
            return totalPages === 1 ? value === null : value === String(totalPages);
          },
          { timeout: 20_000 },
        );
        expect((await readPager(page))?.page).toBe(totalPages);
      });
    });

    /* --------------------------------------------------------------- URL state */

    await log.runStep("A filtered ledger can be reloaded and shared", async () => {
      await goto(LEDGER, "Activity ledger, unfiltered");
      await screen.filters.selectStatus("Request created", "REQUEST_CREATED", "transaction_type");
      await screen.filters.searchFor(dataset.drafts[1].indentNo);
      const shared = currentQuery(page);

      await checks("Reloading keeps the filters and the same rows", async () => {
        const before = await screen.indentNos();
        await page.reload();
        await settle(page);
        expect(currentQuery(page)).toBe(shared);
        await expectRowsToMatch(() => screen.indentNos(), before, "A reload changed the filtered ledger.");
      });

      await checks("An unrecognised event in the URL is dropped rather than sent on", async () => {
        await goto(`${LEDGER}?transaction_type=NOT_AN_EVENT`, "Activity ledger with a junk event");
        expect(currentQuery(page), "An unrecognised event survived in the URL.").toBe("");
      });
    });

    /* ------------------------------------------------------------ the way in */

    await log.runStep("A ledger row leads into the indent, and back again", async () => {
      const target = dataset.drafts[0];
      await goto(`${LEDGER}?search=${encodeURIComponent(target.indentNo)}`, `Activity ledger for ${target.indentNo}`);
      const listUrl = currentQuery(page);

      await checks("Clicking a row opens that indent", async () => {
        const opened = await screen.openRow(target.indentNo);
        expect(opened, "The ledger row opened a different indent.").toBe(target.id);
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(target.indentNo);
      });

      await checks("The way back is labelled 'Activity ledger', not 'All indents'", async () => {
        await expect(page.getByRole("button", { name: /Activity ledger/ }).first()).toBeVisible();
      });

      await checks("Going back returns to the ledger with the search still applied", async () => {
        await page.getByRole("button", { name: /Activity ledger/ }).first().click();
        await page.waitForURL(/\/indents\/reports(\?.*)?$/, { timeout: 30_000 });
        await settle(page);
        expect(currentQuery(page), "Going back to the ledger threw away the filter that led there.")
          .toBe(listUrl);
      });
    });

    checks.assertAllPassed();
  });
});
