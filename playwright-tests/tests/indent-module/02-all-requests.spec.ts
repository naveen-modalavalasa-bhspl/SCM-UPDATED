import { seededTest as test, expect } from "./support/fixtures.js";
import {
  AllRequests, IndentDetail, JourneyScreen, currentPath, currentQuery, isoDate, newIndentButton,
  pageTitle, pagerButton, raisedRange, readPager, requiredByRange, settle, goToPage,
} from "./support/screens.js";
import {
  PAGE_SIZE, allRequestsQuery, expectRowsToMatch, expectValueToMatch,
} from "./support/oracle.js";

/**
 * Indent › All requests.
 *
 * The list, its filters, its pagination, and the two screens it leads to: an
 * indent's own page with its status bar, and the complete journey behind it.
 *
 * Every filter is checked three ways — the URL the control wrote, the rows the
 * API returns for that URL, and the rows actually on screen — so a filter that
 * writes the right query and renders the wrong list still fails.
 */

const ALL_REQUESTS = "/indents";

test.describe("Indent › All requests", () => {
  test("The list filters, pages and opens correctly", async ({
    page, goto, log, checks, indents, tester, dataset, granted,
  }) => {
    const screen = new AllRequests(page);

    /* --------------------------------------------------------------- the grid */

    await goto(ALL_REQUESTS, "All requests");

    await log.runStep("The list renders its columns and its first page", async () => {
      await checks("The screen is titled 'All requests'", async () => {
        await expect(pageTitle(page)).toHaveText("All requests");
      });

      for (const column of AllRequests.COLUMNS) {
        await checks(`The '${column}' column is present`, async () => {
          await expect(screen.list.header(column)).toBeVisible();
        });
      }

      await checks(
        granted.has("indent.create")
          ? "'New indent' is offered to an account holding indent.create"
          : "'New indent' is correctly hidden from an account without indent.create",
        async () => {
          await expect(newIndentButton(page)).toBeVisible({ visible: granted.has("indent.create") });
        },
      );

      await checks("The rows on screen are exactly the API's first page, in order", async () => {
        const expected = await indents.list(allRequestsQuery(""), tester);
        await expectRowsToMatch(
          () => screen.indentNos(),
          expected.items.map((item) => item.indent_no),
          "The first page does not match /api/indents.",
        );
      });

      await checks("The pager reports the API's total and page count", async () => {
        const expected = await indents.list(allRequestsQuery(""), tester);
        const pager = await readPager(page);
        expect(pager, "No pager was rendered under the list.").not.toBeNull();
        expect(pager!.total).toBe(expected.total);
        expect(pager!.pages).toBe(Math.max(1, Math.ceil(expected.total / PAGE_SIZE)));
        expect(pager!.page).toBe(1);
      });
    });

    /* ------------------------------------------------------------- the search */

    await log.runStep("The search box narrows the list on every field it searches", async () => {
      const sample = dataset.drafts[0];
      const terms: { label: string; term: string }[] = [
        { label: "an indent number", term: sample.indentNo },
        ...(dataset.requesterName ? [{ label: "a requester name", term: dataset.requesterName }] : []),
        ...(dataset.departmentName ? [{ label: "a department name", term: dataset.departmentName }] : []),
        { label: "a status word", term: "draft" },
      ];

      for (const { label, term } of terms) {
        await screen.filters.searchFor(term);
        const expected = await indents.list(allRequestsQuery(currentQuery(page)), tester);

        await checks(`Searching by ${label} ("${term}") lists exactly the API's rows`, async () => {
          await expectRowsToMatch(
            () => screen.indentNos(),
            expected.items.map((item) => item.indent_no),
            `The list does not match the API for search "${term}".`,
          );
        });

        await checks(`Searching by ${label} ("${term}") updates the total`, async () => {
          await expectValueToMatch(
            async () => (await readPager(page))?.total ?? -1,
            expected.total,
            `The pager total disagrees with the API for search "${term}".`,
          );
        });
      }

      await checks("Searching an indent number leaves exactly that indent", async () => {
        await screen.filters.searchFor(sample.indentNo);
        await expectRowsToMatch(
          () => screen.indentNos(),
          [sample.indentNo],
          `Searching ${sample.indentNo} should leave exactly that row.`,
        );
      });

      await checks("Searching resets the list to page 1", async () => {
        expect(new URLSearchParams(currentQuery(page)).get("page")).toBeNull();
      });

      await checks("A search matching nothing shows the empty state, not a stale list", async () => {
        await screen.filters.searchFor(`no-such-indent-${dataset.runId}`);
        await expect(screen.list.emptyCell).toBeVisible({ timeout: 15_000 });
        expect(await screen.indentNos()).toEqual([]);
        expect((await readPager(page))?.total).toBe(0);
      });

      await checks("Clearing the search restores the full list", async () => {
        await screen.filters.clearSearch();
        const expected = await indents.list(allRequestsQuery(""), tester);
        await expectRowsToMatch(
          () => screen.indentNos(),
          expected.items.map((item) => item.indent_no),
          "Clearing the search did not restore the unfiltered list.",
        );
      });
    });

    /* -------------------------------------------------------- the raised date */

    await log.runStep("The raised-date filter cuts by when the indent was raised", async () => {
      // Stated on every run, green or red: the presets are computed from the
      // browser's calendar day and the server buckets `created_at` by the UTC
      // one, so they only agree for part of the day. The check below is the one
      // that bites, and it can only bite while the two days differ — which is
      // exactly why the mechanism is recorded here rather than left to be
      // rediscovered from a red run at 2am.
      const now = new Date();
      const offsetMinutes = -now.getTimezoneOffset();
      const localDay = isoDate(0, now);
      const utcDay = now.toISOString().slice(0, 10);
      checks.note(
        `Browser timezone is UTC${offsetMinutes >= 0 ? "+" : "-"}`
          + `${String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, "0")}:`
          + `${String(Math.abs(offsetMinutes) % 60).padStart(2, "0")}. `
          + `Local calendar day is ${localDay}; the server's is ${utcDay}. `
          + (localDay === utcDay
            ? "They agree at this hour, so the date presets look correct right now. They will not agree "
              + "during the offset window each day, and everything raised inside it falls into the "
              + "previous server day."
            : "They do not agree at this hour, so anything raised now is filed under the previous server "
              + "day and is invisible to the 'Today' preset."),
      );

      for (const preset of ["Today", "This week", "This month"] as const) {
        const key = preset === "Today" ? "today" : preset === "This week" ? "this_week" : "this_month";
        const range = raisedRange(key);

        await screen.filters.applyDatePreset(
          "Raised date",
          preset,
          (params) => params.get("created_date_from") === range.from
            && params.get("created_date_to") === range.to,
        );

        const expected = await indents.list(allRequestsQuery(currentQuery(page)), tester);

        await checks(`Raised date '${preset}' resolves to ${range.from} … ${range.to} and lists the API's rows`, async () => {
          await expectRowsToMatch(
            () => screen.indentNos(),
            expected.items.map((item) => item.indent_no),
            `The list does not match the API for raised date '${preset}'.`,
          );
        });

        await checks(`Raised date '${preset}' keeps the drafts raised today`, async () => {
          const wide = await indents.list(
            allRequestsQuery(`created_date_from=${range.from}&created_date_to=${range.to}&size=500`), tester);
          const shown = new Set(wide.items.map((item) => item.indent_no));
          const kept = dataset.drafts.filter((draft) => shown.has(draft.indentNo));
          expect(
            kept.length,
            `'${preset}' resolved to ${range.from}…${range.to} and returned none of the `
              + `${dataset.drafts.length} indents this run raised minutes ago.\n`
              + `The preset is computed from the browser's local date (now ${new Date().toString()}), `
              + "but the server buckets created_at by the UTC calendar day "
              + `(now ${new Date().toISOString()}). Wherever local time runs ahead of UTC, everything `
              + "raised in that offset window falls into the previous UTC day and disappears from 'Today'.",
          ).toBeGreaterThan(0);
        });

        await checks(`Raised date '${preset}' is shown back as a chip`, async () => {
          const chips = (await screen.filters.chipTexts()).join(" | ");
          expect(chips, `Chips read: ${chips || "(none)"}`).toMatch(/Raised:/);
        });
      }

      const pastFrom = isoDate(-60);
      const pastTo = isoDate(-31);
      await screen.filters.applyCustomRange(
        "Raised date",
        pastFrom,
        pastTo,
        (params) => params.get("created_date_from") === pastFrom && params.get("created_date_to") === pastTo,
      );

      await checks("A window that closed a month ago excludes everything raised today", async () => {
        const expected = await indents.list(allRequestsQuery(currentQuery(page)), tester);
        await expectRowsToMatch(
          () => screen.indentNos(),
          expected.items.map((item) => item.indent_no),
          "A past custom range does not match the API.",
        );
        const shown = await screen.indentNos();
        expect(
          shown.filter((indentNo) => dataset.indentNos.has(indentNo)),
          "Indents raised today appeared in a window that closed a month ago.",
        ).toEqual([]);
      });

      await checks("An end date before the start date is refused, with a reason", async () => {
        const popup = await screen.filters.openDate("Raised date");
        await popup.getByRole("button", { name: "Custom range", exact: true }).click();
        await popup.getByLabel("Raised date from").fill(isoDate(0));
        await popup.getByLabel("Raised date to").fill(isoDate(-5));
        await expect(
          popup.getByText("To date must be the same as or later than From date."),
          "No message explained why the backwards range was refused.",
        ).toBeVisible();
        await expect(
          popup.getByRole("button", { name: "Apply", exact: true }),
          "Apply stayed enabled on a backwards date range.",
        ).toBeDisabled();
        await screen.filters.closeDate("Raised date");
      });

      await screen.filters.resetAll();
    });

    /* ------------------------------------------------------- the required-by */

    await log.runStep("The required-by filter cuts by when the items are needed", async () => {
      const cases = [
        { label: "Today", key: "today" as const, maxDays: 0 },
        { label: "Next 7 days", key: "next_7_days" as const, maxDays: 7 },
        { label: "Next 30 days", key: "next_30_days" as const, maxDays: 30 },
      ];

      for (const { label, key, maxDays } of cases) {
        const range = requiredByRange(key);
        await screen.filters.applyDatePreset(
          "Required by",
          label,
          (params) => params.get("required_by_from") === range.from
            && params.get("required_by_to") === range.to,
        );

        const expected = await indents.list(allRequestsQuery(currentQuery(page)), tester);

        await checks(`Required by '${label}' resolves to ${range.from} … ${range.to} and lists the API's rows`, async () => {
          await expectRowsToMatch(
            () => screen.indentNos(),
            expected.items.map((item) => item.indent_no),
            `The list does not match the API for required by '${label}'.`,
          );
        });

        await checks(`Required by '${label}' drops the seeded drafts needed after it`, async () => {
          const shown = new Set(expected.items.map((item) => item.indent_no));
          const wronglyKept = dataset.drafts
            .filter((draft) => draft.requiredInDays > maxDays && shown.has(draft.indentNo))
            .map((draft) => `${draft.indentNo} (needed in ${draft.requiredInDays} days)`);
          expect(
            wronglyKept,
            `'${label}' kept indents needed later than ${range.to}.`,
          ).toEqual([]);
        });
      }

      await checks("Required by 'Today' really is narrower than no filter at all", async () => {
        const range = requiredByRange("today");
        const filtered = await indents.list(
          allRequestsQuery(`required_by_from=${range.from}&required_by_to=${range.to}`), tester);
        const all = await indents.list(allRequestsQuery(""), tester);
        expect(
          filtered.total,
          "Required by 'Today' returned as much as no filter — it is not filtering.",
        ).toBeLessThan(all.total);
      });

      await screen.filters.resetAll();
    });

    /* --------------------------------------------------- status and priority */

    await log.runStep("Status and priority cut the list, together and separately", async () => {
      await screen.filters.selectStatus("Draft", "DRAFT");

      await checks("Status 'Draft' lists the API's draft rows", async () => {
        const expected = await indents.list(allRequestsQuery(currentQuery(page)), tester);
        await expectRowsToMatch(
          () => screen.indentNos(),
          expected.items.map((item) => item.indent_no),
          "The Draft-filtered list does not match the API.",
        );
      });

      await checks("Every row on a Draft-filtered list actually reads DRAFT", async () => {
        const statuses = [...new Set(await screen.statuses())];
        expect(
          statuses.filter((status) => !/draft/i.test(status)),
          `The Draft filter left rows in other statuses: ${statuses.join(", ")}.`,
        ).toEqual([]);
      });

      await checks("Adding 'Rejected' widens the list rather than narrowing it", async () => {
        const draftOnly = await indents.list(allRequestsQuery("status=DRAFT"), tester);
        await screen.filters.selectStatus("Rejected", "REJECTED");
        const expected = await indents.list(allRequestsQuery(currentQuery(page)), tester);
        expect(
          expected.total,
          "Selecting a second status did not widen the result — the statuses are not being OR-ed.",
        ).toBeGreaterThanOrEqual(draftOnly.total);
        await expectRowsToMatch(
          () => screen.indentNos(),
          expected.items.map((item) => item.indent_no),
          "Draft + Rejected does not match the API.",
        );
        await screen.filters.deselectStatus("Rejected", "REJECTED");
      });

      await screen.filters.selectPriority("Urgent", "URGENT");

      await checks("Draft + Urgent matches the API for both filters at once", async () => {
        const expected = await indents.list(allRequestsQuery(currentQuery(page)), tester);
        await expectRowsToMatch(
          () => screen.indentNos(),
          expected.items.map((item) => item.indent_no),
          "Draft + Urgent does not match the API.",
        );
      });

      await checks("Draft + Urgent keeps only the urgent drafts the run seeded", async () => {
        const expected = await indents.list(allRequestsQuery(`${currentQuery(page)}&size=200`), tester);
        const shown = new Set(expected.items.map((item) => item.indent_no));
        const wronglyKept = dataset.normal.filter((draft) => shown.has(draft.indentNo)).map((d) => d.indentNo);
        const wronglyDropped = dataset.urgent.filter((draft) => !shown.has(draft.indentNo)).map((d) => d.indentNo);
        expect(wronglyKept, "Normal-priority drafts survived an Urgent filter.").toEqual([]);
        expect(wronglyDropped, "Urgent drafts were dropped by an Urgent filter.").toEqual([]);
      });

      await checks("Both filters are named back to the user as chips", async () => {
        const chips = (await screen.filters.chipTexts()).join(" | ");
        expect(chips, `Chips read: ${chips || "(none)"}`).toMatch(/Status:.*Draft/i);
        expect(chips, `Chips read: ${chips || "(none)"}`).toMatch(/Priority:.*Urgent/i);
      });

      await checks("'Clear all' empties the query string and restores the list", async () => {
        await screen.filters.resetAll();
        expect(currentQuery(page)).toBe("");
        expect(await screen.filters.chipTexts()).toEqual([]);
        const expected = await indents.list(allRequestsQuery(""), tester);
        await expectRowsToMatch(
          () => screen.indentNos(),
          expected.items.map((item) => item.indent_no),
          "'Clear all' did not restore the unfiltered list.",
        );
      });
    });

    /* ------------------------------------------------------------- URL state */

    await log.runStep("Filters live in the URL, so a filtered list can be reloaded and shared", async () => {
      await screen.filters.selectStatus("Draft", "DRAFT");
      await screen.filters.selectPriority("Urgent", "URGENT");
      const shared = currentQuery(page);

      await checks("The URL carries the filters that are applied", async () => {
        const params = new URLSearchParams(shared);
        expect(params.getAll("status")).toContain("DRAFT");
        expect(params.getAll("priority")).toContain("URGENT");
      });

      await checks("Reloading keeps the filters and the same rows", async () => {
        const before = await screen.indentNos();
        await page.reload();
        await settle(page);
        expect(currentQuery(page)).toBe(shared);
        await expectRowsToMatch(() => screen.indentNos(), before, "A reload changed the filtered list.");
      });

      await checks("Opening the URL fresh reproduces the same filtered list", async () => {
        const before = await screen.indentNos();
        await goto(`${ALL_REQUESTS}?${shared}`, "All requests from a shared link");
        await expectRowsToMatch(
          () => screen.indentNos(),
          before,
          "The same URL produced a different list on a fresh visit.",
        );
      });

      await checks("A junk filter value in the URL is dropped rather than sent on", async () => {
        await goto(`${ALL_REQUESTS}?status=NOT_A_STATUS&priority=BOGUS`, "All requests with junk filters");
        expect(
          currentQuery(page),
          "An unrecognised status or priority survived in the URL.",
        ).toBe("");
      });

      await goto(ALL_REQUESTS, "All requests, unfiltered");
    });

    /* ----------------------------------------------------------- pagination */

    await log.runStep("Pagination moves through real, different rows", async () => {
      const firstPage = await indents.list(allRequestsQuery(""), tester);
      const totalPages = Math.max(1, Math.ceil(firstPage.total / PAGE_SIZE));

      expect(
        totalPages,
        `The account can only see ${firstPage.total} indents, so paging cannot be tested. `
          + "Raise SEED_COUNT above the page size.",
      ).toBeGreaterThan(1);

      await checks("'Previous' is disabled on page 1", async () => {
        await expect(pagerButton(page, "Previous")).toBeDisabled();
      });

      const pageOneRows = await screen.indentNos();

      await checks("'Next' goes to page 2 and puts the page in the URL", async () => {
        await goToPage(page, "Next", 2);
        expect(new URLSearchParams(currentQuery(page)).get("page")).toBe("2");
        expect((await readPager(page))?.page).toBe(2);
      });

      await checks("Page 2 shows the API's second page", async () => {
        const expected = await indents.list(allRequestsQuery("", { page: 2 }), tester);
        await expectRowsToMatch(
          () => screen.indentNos(),
          expected.items.map((item) => item.indent_no),
          "Page 2 does not match the API's second page.",
        );
      });

      await checks("Page 2 shares no row with page 1", async () => {
        const pageTwoRows = await screen.indentNos();
        const overlap = pageTwoRows.filter((indentNo) => pageOneRows.includes(indentNo));
        expect(overlap, `These rows appeared on both pages: ${overlap.join(", ")}.`).toEqual([]);
      });

      await checks("'Previous' returns to page 1 and drops the page from the URL", async () => {
        await goToPage(page, "Previous", 1);
        expect(new URLSearchParams(currentQuery(page)).get("page")).toBeNull();
        await expectRowsToMatch(() => screen.indentNos(), pageOneRows, "Going back did not restore page 1.");
      });

      await checks("'Next' is disabled on the last page", async () => {
        await goto(`${ALL_REQUESTS}?page=${totalPages}`, `All requests, page ${totalPages}`);
        await expect(pagerButton(page, "Next")).toBeDisabled();
      });

      await checks("A page number past the end is corrected to the last page", async () => {
        await goto(`${ALL_REQUESTS}?page=999999`, "All requests, page 999999");
        await expect(page).toHaveURL(
          (url) => {
            const value = new URLSearchParams(url.search).get("page");
            return totalPages === 1 ? value === null : value === String(totalPages);
          },
          { timeout: 20_000 },
        );
        expect((await readPager(page))?.page).toBe(totalPages);
      });

      await checks("A filter and a page number combine correctly in the URL", async () => {
        await goto(`${ALL_REQUESTS}?status=DRAFT&page=2`, "Drafts, page 2");
        const expected = await indents.list(allRequestsQuery(currentQuery(page)), tester);
        await expectRowsToMatch(
          () => screen.indentNos(),
          expected.items.map((item) => item.indent_no),
          "A filtered page 2 does not match the API.",
        );
      });
    });

    checks.assertAllPassed();
  });

  /* ================================================================== detail */

  test("An indent opens with the right status bar, lines and journey", async ({
    page, goto, log, checks, indents, tester, dataset,
  }) => {
    const screen = new AllRequests(page);
    const detail = new IndentDetail(page);
    const journeyScreen = new JourneyScreen(page);
    const target = dataset.drafts[0];

    await goto(`${ALL_REQUESTS}?search=${encodeURIComponent(target.indentNo)}`, `All requests filtered to ${target.indentNo}`);

    const indentId = await log.runStep(`Open ${target.indentNo} from the list`, async () => {
      const opened = await screen.openIndent(target.indentNo);
      expect(opened, "Clicking the row opened a different indent.").toBe(target.id);
      return opened;
    });

    const snapshot = await indents.indent(indentId, tester);
    const journey = await indents.journey(indentId, tester);

    await log.runStep("The indent screen states what it is and who it belongs to", async () => {
      await checks("The heading is the indent number", async () => {
        await expect(detail.title).toHaveText(target.indentNo);
      });

      await checks("The status shown is the status the API reports", async () => {
        await expect(
          page.getByText(snapshot.status.replace(/_/g, " "), { exact: false }).first(),
        ).toBeVisible();
      });

      await checks("The line items are the API's line items, quantity and UOM included", async () => {
        // Item names in the live catalogue carry stray whitespace, so both sides
        // are collapsed before comparing — the screen is not at fault for that.
        const flatten = (value: string) => value.replace(/\s+/g, " ").trim();
        const rows = await detail.lineMatrix();
        expect(rows.length, "The line-items table is empty.").toBe(snapshot.items.length);
        for (const [index, item] of snapshot.items.entries()) {
          const row = flatten(rows[index].join(" | "));
          expect(row, `Line ${index + 1} does not name its item.`)
            .toContain(flatten(item.item_name ?? item.item_code ?? ""));
          expect(
            Number(rows[index][1].replace(/,/g, "")),
            `Line ${index + 1} shows a different quantity to the API.`,
          ).toBe(Number(item.quantity));
        }
      });

      await checks("The quantity on screen is the quantity the run asked for", async () => {
        const rows = await detail.lineMatrix();
        expect(Number(rows[0][1].replace(/,/g, ""))).toBe(target.quantity);
      });

      for (const field of ["Requested by", "Department", "Priority"]) {
        await checks(`The '${field}' field is filled in`, async () => {
          await expect(detail.field(field)).not.toHaveText("—");
        });
      }

      await checks("The priority shown is the priority the indent was raised with", async () => {
        await expect(detail.field("Priority")).toHaveText(target.priority);
      });
    });

    await log.runStep("The status bar reflects where the indent actually is", async () => {
      await checks("The progress bar is rendered and named for assistive technology", async () => {
        await expect(detail.progressGroup).toBeVisible({ timeout: 20_000 });
      });

      await checks("It shows the seven lifecycle phases, in order", async () => {
        const steps = await detail.progressSteps();
        expect(steps.map((step) => step.label)).toEqual([
          "Draft", "Submitted", "Approvals", "Allocation", "Warehouse", "Delivery", "Acknowledgement",
        ]);
      });

      await checks("A draft sits on the first phase and nothing later is marked done", async () => {
        const steps = await detail.progressSteps();
        const done = steps.filter((step) => /complete|done|approved/i.test(step.state)).map((s) => s.label);
        expect(
          done.filter((label) => !["Draft"].includes(label)),
          `A draft is showing later phases as finished: ${done.join(", ")}.`,
        ).toEqual([]);
      });

      await checks("Every phase announces a state, not just a label", async () => {
        const steps = await detail.progressSteps();
        expect(steps.filter((step) => !step.state).map((s) => s.label)).toEqual([]);
      });
    });

    await log.runStep("The way back to the list keeps the filter that led here", async () => {
      await checks("The back link is labelled for where it goes", async () => {
        await expect(detail.backLink(/All indents/)).toBeVisible();
      });

      await checks("It returns to All requests with the search still applied", async () => {
        await detail.backLink(/All indents/).click();
        await page.waitForURL(/\/indents(\?.*)?$/, { timeout: 30_000 });
        await settle(page);
        expect(currentPath(page)).toBe("/indents");
        expect(
          new URLSearchParams(currentQuery(page)).get("search"),
          "Going back to the list threw away the search that led to the indent.",
        ).toBe(target.indentNo);
      });

      // Back on the filtered list, and back into the indent, for the journey.
      await screen.openIndent(target.indentNo);
    });

    await log.runStep("'View complete indent journey' opens the journey and it matches the API", async () => {
      await checks("The journey card is a real link, named for the indent it opens", async () => {
        await expect(detail.journeyCard(target.indentNo)).toBeVisible();
      });

      await detail.journeyCard(target.indentNo).click();
      await page.waitForURL(/\/indents\/\d+\/journey$/, { timeout: 30_000 });
      await settle(page);

      await checks("The journey screen names the same indent", async () => {
        await expect(journeyScreen.title).toHaveText(target.indentNo);
      });

      // The screen's own rule: a stage counts as "happened" only once it is
      // stamped AND no longer the stage the document is sitting on. A draft is
      // still at "Draft created", so a draft legitimately has nothing in the
      // timeline — which is why "occurred" is defined here and not as "has a
      // timestamp".
      const stages = journey.stages ?? [];
      const occurred = stages.filter((stage) => Boolean(stage.timestamp) && !stage.is_current);

      await checks("Every stage the API returns is somewhere on the screen", async () => {
        const shown = [...await journeyScreen.timelineStages(), ...await journeyScreen.upcomingStages()]
          .map((heading) => heading.trim());
        const missing = stages
          .map((stage) => (stage.title ?? "").trim())
          .filter((title) => title && !shown.includes(title));
        expect(
          missing,
          `The API returned stages the journey never shows: ${missing.join(", ")}. On screen: ${shown.join(" / ")}.`,
        ).toEqual([]);
      });

      await checks("The timeline holds every stage that has actually finished", async () => {
        if (!occurred.length) {
          await expect(
            journeyScreen.noEvents,
            "Nothing has finished yet, so the screen should say so plainly rather than show a blank panel.",
          ).toBeVisible();
          return;
        }
        const shown = await journeyScreen.timelineStages();
        for (const stage of occurred) {
          expect(
            shown.some((heading) => heading.trim() === (stage.title ?? "").trim()),
            `Stage "${stage.title}" finished but is missing from the timeline. Timeline shows: ${shown.join(" / ")}.`,
          ).toBe(true);
        }
      });

      await checks("Nothing finished is also listed as still to come", async () => {
        const shownUpcoming = await journeyScreen.upcomingStages();
        const finishedTitles = occurred.map((stage) => (stage.title ?? "").trim());
        const leaked = shownUpcoming.map((heading) => heading.trim()).filter((heading) => finishedTitles.includes(heading));
        expect(leaked, `These finished stages are listed under 'Still to come': ${leaked.join(", ")}.`).toEqual([]);
      });

      await checks("The stage the document is sitting on is shown, and shown as current", async () => {
        const current = stages.find((stage) => stage.is_current);
        if (!current) {
          checks.note("The API reports no current stage for this indent, so 'Current' could not be checked.");
          return;
        }
        await expect(
          page.getByRole("heading", { level: 3, name: (current.title ?? "").trim() }).first(),
          `The current stage "${current.title}" is not on the journey screen at all.`,
        ).toBeVisible();
        // Where a stamped, current stage lands is worth saying out loud: it reads
        // as "not yet started" to the person who just created the document.
        if (current.timestamp && !occurred.length) {
          checks.note(
            `A draft's journey says "No recorded journey events are available." and files its own `
              + `"${current.title}" stage under "Still to come", although the API stamps that stage with `
              + `${current.timestamp}. To the person who just raised the indent, the thing they did reads `
              + "as not having happened yet.",
          );
        }
      });

      await checks("The complete-history panel is present", async () => {
        await expect(journeyScreen.historyHeading).toBeVisible();
      });

      await checks("'Back to indent details' returns to the indent", async () => {
        await journeyScreen.back.click();
        await page.waitForURL(/\/indents\/\d+$/, { timeout: 30_000 });
        await settle(page);
        await expect(detail.title).toHaveText(target.indentNo);
      });

      await checks("Coming back from the journey still leads back to the filtered list", async () => {
        await detail.backLink(/All indents/).click();
        await page.waitForURL(/\/indents(\?.*)?$/, { timeout: 30_000 });
        await settle(page);
        expect(
          new URLSearchParams(currentQuery(page)).get("search"),
          "Detouring through the journey lost the filter the indent was opened from: the indent screen "
            + "carries its return address in router state, and navigating to the journey and back "
            + "replaces that state, so the way out falls back to an unfiltered list.",
        ).toBe(target.indentNo);
      });
    });

    checks.assertAllPassed();
  });
});
