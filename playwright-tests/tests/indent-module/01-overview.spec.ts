import { seededTest as test, expect } from "./support/fixtures.js";
import {
  INDENT_TABS, Overview, currentPath, currentQuery, isShown, isoDate, newIndentButton,
  openTab, pageTitle, raisedRange, requiredByRange, settle,
} from "./support/screens.js";
import {
  RECENT_ROWS_SHOWN, donutTotalFrom, expectRowsToMatch, expectValueToMatch,
  overviewRecentQuery, overviewStatsQuery, sameNumberText,
} from "./support/oracle.js";

/**
 * Indent › Overview.
 *
 * Every control on the screen, and — the part that decides whether this suite is
 * worth running — whether the numbers and the rows are *right* after each one,
 * not merely different. Each filter is applied by clicking, then the same query
 * is asked of the API as the same account, and the eight KPI tiles, the donut,
 * the legend and the Recent Indents card are all compared against that answer.
 *
 * Overview is also the one screen in the module that keeps its filters out of the
 * URL. That is checked here explicitly, because it means a filtered Overview
 * cannot be reloaded or shared as a link, unlike every sibling screen.
 */

const OVERVIEW = "/indents/dashboard";
const KPI_TO_STAT = {
  "Total indents": "total",
  "Awaiting approval": "awaiting_approval",
  "Approved active": "approved_active",
  "Raised this month": "this_month",
  "In draft": "draft",
  "Units requested": "total_qty",
  Rejected: "rejected",
} as const;

test.describe("Indent › Overview", () => {
  test("Overview shows the right numbers and rows for every filter", async ({
    page, goto, log, checks, indents, tester, dataset, granted,
  }) => {
    const overview = new Overview(page);

    /* ------------------------------------------------------------ the screen */

    await goto(OVERVIEW, "Overview");

    await log.runStep("The screen and its module navigation are present", async () => {
      await checks("Overview is titled 'Overview'", async () => {
        await expect(pageTitle(page)).toHaveText("Overview");
      });

      for (const tab of INDENT_TABS) {
        await checks(`The '${tab.label}' tab is offered`, async () => {
          await expect(page.getByRole("navigation", { name: "Indent" })
            .getByRole("link", { name: tab.label, exact: true })).toBeVisible();
        });
      }

      // The account decides whether this button exists at all, so the run states
      // which case it is testing instead of asserting one and failing on the other.
      const canCreate = granted.has("indent.create");
      await checks(
        canCreate
          ? "'New indent' is offered to an account holding indent.create"
          : "'New indent' is correctly hidden from an account without indent.create",
        async () => {
          await expect(newIndentButton(page)).toBeVisible({ visible: canCreate });
        },
      );
    });

    /* -------------------------------------------------- the unfiltered numbers */

    await log.runStep("Unfiltered KPIs, donut and recent rows agree with the API", async () => {
      const stats = await indents.stats("", tester);

      for (const [label, key] of Object.entries(KPI_TO_STAT)) {
        await checks(`KPI '${label}' equals the API's ${key}`, async () => {
          const shown = await overview.kpi(label);
          expect(
            sameNumberText(shown, stats[key as keyof typeof stats] as number),
            `'${label}' shows "${shown}" but /api/indents/stats says ${String(stats[key as keyof typeof stats])}.`,
          ).toBe(true);
        });
      }

      await checks("KPI 'Approval rate' equals the API's approval_rate, as a percentage", async () => {
        const shown = await overview.kpi("Approval rate");
        expect(shown.replace(/\s/g, "")).toBe(`${stats.approval_rate}%`);
      });

      await checks("The seeded drafts are counted — the run is looking at its own data", async () => {
        expect(
          stats.draft,
          `Only ${stats.draft} drafts are visible although the run seeded ${dataset.drafts.length}.`,
        ).toBeGreaterThanOrEqual(dataset.drafts.length);
      });

      await checks("Every status in the breakdown has a legend row with the API's count", async () => {
        for (const [status, count] of Object.entries(stats.by_status)) {
          const row = overview.legendCount(status);
          if (!(await isShown(row))) continue; // The chart draws eight primary statuses only.
          expect(
            (await row.innerText()).trim(),
            `The legend shows ${status} as "${(await row.innerText()).trim()}", the API says ${count}.`,
          ).toBe(String(count));
        }
      });

      await checks("The donut total equals the sum of the statuses it draws", async () => {
        const expected = donutTotalFrom(stats.by_status);
        await expect(overview.donutTotal).toHaveText(String(expected));
      });

      const recent = await indents.list(overviewRecentQuery(""), tester);
      await checks("Recent Indents lists the five newest indents the API returns", async () => {
        await expectRowsToMatch(
          () => overview.recentIndentNos(),
          recent.items.slice(0, RECENT_ROWS_SHOWN).map((item) => item.indent_no),
          "Recent Indents does not match the newest indents the API returns.",
        );
      });
    });

    /* ------------------------------------------------------------- the search */

    await log.runStep("The search box narrows the whole screen, on every field it searches", async () => {
      const sample = dataset.drafts[0];

      // The main list searches four fields — indent number, requester, department
      // and the status word — so all four are exercised. Anything else is a claim
      // the screen does not actually make.
      const terms: { label: string; term: string }[] = [
        { label: "an indent number", term: sample.indentNo },
        ...(dataset.requesterName ? [{ label: "a requester name", term: dataset.requesterName }] : []),
        ...(dataset.departmentName ? [{ label: "a department name", term: dataset.departmentName }] : []),
        { label: "a status word", term: "draft" },
      ];

      for (const { label, term } of terms) {
        await overview.filters.searchFor(term);
        const query = overviewStatsQuery(`search=${encodeURIComponent(term)}`);
        const stats = await indents.stats(query, tester);
        const recent = await indents.list(overviewRecentQuery(`search=${encodeURIComponent(term)}`), tester);

        await checks(`Searching by ${label} ("${term}") gives the API's total`, async () => {
          await expectValueToMatch(
            () => overview.kpi("Total indents"),
            String(stats.total),
            `Searching "${term}" shows a different total to the API's ${stats.total}.`,
          );
        });

        await checks(`Searching by ${label} ("${term}") lists the API's rows`, async () => {
          await expectRowsToMatch(
            () => overview.recentIndentNos(),
            recent.items.slice(0, RECENT_ROWS_SHOWN).map((item) => item.indent_no),
            `Recent Indents does not match the API for search "${term}".`,
          );
        });
      }

      await checks("Searching an indent number narrows the screen to that one indent", async () => {
        await overview.filters.searchFor(sample.indentNo);
        await expectRowsToMatch(
          () => overview.recentIndentNos(),
          [sample.indentNo],
          `Searching ${sample.indentNo} should leave exactly that indent on the card.`,
        );
      });

      await checks("A search matching nothing empties the card and zeroes the total", async () => {
        await overview.filters.searchFor(`no-such-indent-${dataset.runId}`);
        await expect(overview.emptyRecent).toBeVisible({ timeout: 15_000 });
        expect(await overview.kpi("Total indents")).toBe("0");
      });

      await checks("The donut degrades to its empty state rather than drawing nothing", async () => {
        await expect(overview.emptyDonut).toBeVisible({ timeout: 15_000 });
      });

      await checks("Clearing the search restores the unfiltered total", async () => {
        const before = await indents.stats("", tester);
        await overview.filters.clearSearch();
        await expectValueToMatch(
          () => overview.kpi("Total indents"),
          String(before.total),
          "Clearing the search did not restore the unfiltered total.",
        );
      });
    });

    /* -------------------------------------------------------- the raised date */

    await log.runStep("The raised-date filter cuts by the date the indent was raised", async () => {
      for (const preset of ["Today", "This week", "This month"] as const) {
        const key = preset === "Today" ? "today" : preset === "This week" ? "this_week" : "this_month";
        const range = raisedRange(key);

        await overview.filters.applyDatePreset(
          "Raised date",
          preset,
          (params) => params.get("created_date_from") === range.from
            && params.get("created_date_to") === range.to,
        );

        const query = overviewStatsQuery(`created_date_from=${range.from}&created_date_to=${range.to}`);
        const stats = await indents.stats(query, tester);

        await checks(`Raised date '${preset}' resolves to ${range.from} … ${range.to} and totals correctly`, async () => {
          await expectValueToMatch(
            () => overview.kpi("Total indents"),
            String(stats.total),
            `'${preset}' shows a different total to the API for ${range.from}…${range.to}.`,
          );
        });

        await checks(`Raised date '${preset}' includes today's ${dataset.drafts.length} seeded drafts`, async () => {
          // Every seeded draft was raised moments ago, so all three windows must
          // contain them. If one does not, the window is not the window it says.
          expect(
            stats.draft,
            `'${preset}' resolved to ${range.from}…${range.to} and counted ${stats.draft} drafts, `
              + `although this run raised ${dataset.drafts.length} minutes ago.\n`
              + `The preset comes from the browser's local date (now ${new Date().toString()}), but the `
              + `server buckets created_at by the UTC calendar day (now ${new Date().toISOString()}). `
              + "Wherever local time runs ahead of UTC, everything raised inside that offset falls into "
              + "the previous UTC day and vanishes from 'Today'.",
          ).toBeGreaterThanOrEqual(dataset.drafts.length);
        });
      }

      const pastFrom = isoDate(-60);
      const pastTo = isoDate(-31);
      await overview.filters.applyCustomRange(
        "Raised date",
        pastFrom,
        pastTo,
        (params) => params.get("created_date_from") === pastFrom && params.get("created_date_to") === pastTo,
      );

      await checks("A raised-date window that ended a month ago excludes everything raised today", async () => {
        const stats = await indents.stats(
          overviewStatsQuery(`created_date_from=${pastFrom}&created_date_to=${pastTo}`),
          tester,
        );
        await expectValueToMatch(
          () => overview.kpi("Total indents"),
          String(stats.total),
          "A past custom range shows a different total to the API.",
        );
        const shownRows = await overview.recentIndentNos();
        expect(
          shownRows.filter((indentNo) => dataset.indentNos.has(indentNo)),
          "Indents raised today appeared in a window that closed a month ago.",
        ).toEqual([]);
      });

      await checks("An end date before the start date is refused, with a reason", async () => {
        const popup = await overview.filters.openDate("Raised date");
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
        await overview.filters.closeDate("Raised date");
      });

      await checks("Clearing the raised date restores the unfiltered total", async () => {
        const stats = await indents.stats("", tester);
        await overview.filters.resetAll();
        await expectValueToMatch(
          () => overview.kpi("Total indents"),
          String(stats.total),
          "Clearing the date filter did not restore the unfiltered total.",
        );
      });
    });

    /* --------------------------------------------------------- the required by */

    await log.runStep("The required-by filter cuts by the date the items are needed", async () => {
      // The seed put required dates at today, +5 and +40 days, so the three
      // presets are guaranteed to partition it differently. Without that spread a
      // green result here would prove nothing.
      const cases = [
        { label: "Today", key: "today" as const, seeded: dataset.drafts.filter((d) => d.requiredInDays === 0) },
        { label: "Next 7 days", key: "next_7_days" as const, seeded: dataset.drafts.filter((d) => d.requiredInDays <= 7) },
        { label: "Next 30 days", key: "next_30_days" as const, seeded: dataset.drafts.filter((d) => d.requiredInDays <= 30) },
      ];

      for (const { label, key, seeded } of cases) {
        const range = requiredByRange(key);
        await overview.filters.applyDatePreset(
          "Required by",
          label,
          (params) => params.get("required_by_from") === range.from
            && params.get("required_by_to") === range.to,
        );

        const query = overviewStatsQuery(`required_by_from=${range.from}&required_by_to=${range.to}`);
        const stats = await indents.stats(query, tester);

        await checks(`Required by '${label}' resolves to ${range.from} … ${range.to} and totals correctly`, async () => {
          await expectValueToMatch(
            () => overview.kpi("Total indents"),
            String(stats.total),
            `'${label}' shows a different total to the API for ${range.from}…${range.to}.`,
          );
        });

        await checks(`Required by '${label}' keeps the ${seeded.length} seeded drafts that fall inside it`, async () => {
          expect(
            stats.draft,
            `${seeded.length} seeded drafts are needed by ${range.to} or sooner, but only ${stats.draft} drafts are counted.`,
          ).toBeGreaterThanOrEqual(seeded.length);
        });
      }

      await checks("Required by 'Today' excludes the drafts needed in 40 days", async () => {
        const range = requiredByRange("today");
        const stats = await indents.stats(
          overviewStatsQuery(`required_by_from=${range.from}&required_by_to=${range.to}`),
          tester,
        );
        const far = dataset.drafts.filter((draft) => draft.requiredInDays > 7).length;
        expect(far, "The seed did not produce far-future drafts, so this filter proves nothing.").toBeGreaterThan(0);
        const all = await indents.stats("", tester);
        expect(
          stats.total,
          "Required by 'Today' returned as much as no filter at all — it is not filtering.",
        ).toBeLessThan(all.total);
      });

      await overview.filters.resetAll();
    });

    /* ---------------------------------------------------- status and priority */

    await log.runStep("The status and priority filters cut the screen the same way the API does", async () => {
      await overview.filters.selectStatus("Draft", "DRAFT");

      await checks("Status 'Draft' leaves only drafts, counted as the API counts them", async () => {
        const stats = await indents.stats(overviewStatsQuery("status=DRAFT"), tester);
        await expectValueToMatch(
          () => overview.kpi("Total indents"),
          String(stats.total),
          "Filtering to Draft shows a different total to the API.",
        );
        expect(
          stats.total,
          "Filtering to Draft returned indents that are not drafts.",
        ).toBe(stats.draft);
      });

      await checks("Status 'Draft' lists the API's draft rows, newest first", async () => {
        const recent = await indents.list(overviewRecentQuery("status=DRAFT"), tester);
        await expectRowsToMatch(
          () => overview.recentIndentNos(),
          recent.items.slice(0, RECENT_ROWS_SHOWN).map((item) => item.indent_no),
          "The Draft-filtered card does not match the API.",
        );
      });

      await overview.filters.selectPriority("Urgent", "URGENT");

      await checks("Draft + Urgent together match the API for both filters at once", async () => {
        const stats = await indents.stats(overviewStatsQuery("status=DRAFT&priority=URGENT"), tester);
        const recent = await indents.list(overviewRecentQuery("status=DRAFT&priority=URGENT"), tester);
        await expectValueToMatch(
          () => overview.kpi("Total indents"),
          String(stats.total),
          "Draft + Urgent shows a different total to the API.",
        );
        await expectRowsToMatch(
          () => overview.recentIndentNos(),
          recent.items.slice(0, RECENT_ROWS_SHOWN).map((item) => item.indent_no),
          "Draft + Urgent lists different rows to the API.",
        );
        expect(
          stats.total,
          `The run seeded ${dataset.urgent.length} urgent drafts; the filtered total is ${stats.total}.`,
        ).toBeGreaterThanOrEqual(dataset.urgent.length);
      });

      await checks("Both filters are named back to the user as chips", async () => {
        const chips = (await overview.filters.chipTexts()).join(" | ");
        expect(chips, `Chips read: ${chips || "(none)"}`).toMatch(/Status:.*Draft/i);
        expect(chips, `Chips read: ${chips || "(none)"}`).toMatch(/Priority:.*Urgent/i);
      });

      await checks("Deselecting Urgent drops only that filter", async () => {
        await overview.filters.deselectPriority("Urgent", "URGENT");
        const stats = await indents.stats(overviewStatsQuery("status=DRAFT"), tester);
        await expectValueToMatch(
          () => overview.kpi("Total indents"),
          String(stats.total),
          "Deselecting Urgent did not return the screen to the Draft-only total.",
        );
      });

      await checks("'Clear all' removes every filter and every chip", async () => {
        await overview.filters.resetAll();
        expect(await overview.filters.chipTexts()).toEqual([]);
        const stats = await indents.stats("", tester);
        await expectValueToMatch(
          () => overview.kpi("Total indents"),
          String(stats.total),
          "'Clear all' did not restore the unfiltered total.",
        );
      });
    });

    /* ------------------------------------------------- Overview's own URL story */

    await log.runStep("Overview filters do not survive a reload", async () => {
      await overview.filters.selectStatus("Draft", "DRAFT");
      const queryBeforeReload = currentQuery(page);
      await page.reload();
      await settle(page);

      // Not a failure — a difference. Every sibling screen keeps its filters in the
      // URL; this one does not, so a filtered Overview cannot be bookmarked or sent
      // to a colleague. Recorded so the difference is a decision, not a surprise.
      checks.note(
        "Overview keeps its filters in React state, not the URL"
          + ` (address bar after filtering: "${queryBeforeReload || "empty"}"),`
          + " so reloading returns to the unfiltered screen and a filtered view cannot be shared as a link."
          + " All requests, Activity ledger and Alert & Notification all keep theirs in the URL.",
      );

      await checks("Reloading Overview leaves a usable, unfiltered screen", async () => {
        await expect(pageTitle(page)).toHaveText("Overview");
        await expect(overview.donutTotal).toBeVisible({ timeout: 15_000 });
      });
    });

    /* ------------------------------------------------------- the two exits out */

    await log.runStep("Recent Indents and 'View all' lead where they say they do", async () => {
      await goto(OVERVIEW, "Overview before opening a recent indent");
      const shown = await overview.recentIndentNos();

      await checks("Clicking a recent indent opens that indent", async () => {
        expect(shown.length, "The Recent Indents card is empty, so the link could not be tested.")
          .toBeGreaterThan(0);
        const target = shown[0];
        await overview.recentRows().first().click();
        await page.waitForURL(/\/indents\/\d+(\?.*)?$/, { timeout: 30_000 });
        await settle(page);
        await expect(
          page.getByRole("heading", { level: 1 }),
          `Clicking ${target} on the Overview card did not open ${target}.`,
        ).toHaveText(target);
      });

      await goto(OVERVIEW, "Overview before 'View all'");

      await checks("'View all' goes to All requests", async () => {
        await overview.viewAll.click();
        await page.waitForURL(/\/indents(\?.*)?$/, { timeout: 30_000 });
        await settle(page);
        expect(currentPath(page)).toBe("/indents");
        await expect(pageTitle(page)).toHaveText("All requests");
      });

      await checks("The Overview tab is reachable again from All requests", async () => {
        await openTab(page, "Overview");
        await expect(pageTitle(page)).toHaveText("Overview");
      });
    });

    checks.assertAllPassed();
  });
});
