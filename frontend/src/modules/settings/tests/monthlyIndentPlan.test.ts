/** The screen's half of the cycle arithmetic, against the server's own cases.
 *
 *  `monthlyIndentPlan` exists to draw the schedule the server will actually run, so
 *  every case here is one of `platform/monthly_indent/tests/test_monthly_indent.py`
 *  read back in TypeScript. Where the two disagree the ribbon lies, and a ribbon that
 *  lies is worse than no ribbon: it is the only thing on the screen anybody checks.
 */
import { describe, expect, it } from "vitest";

import { cycleWindow, dueDate, isDayOutsideWindow, monthsAfter } from "../monthlyIndentPlan";

const SEP_21 = new Date(2026, 8, 21);
const SEP_1 = new Date(2026, 8, 1);

const iso = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-`
  + `${String(date.getDate()).padStart(2, "0")}`;

describe("cycleWindow", () => {
  it("runs from this month's opening day to the end of the next", () => {
    const win = cycleWindow(
      { cycle_month_offset: 0, start_day: 1, end_month_offset: 1, end_day: 31 }, SEP_21);

    expect(iso(win.start)).toBe("2026-09-01");
    expect(iso(win.end)).toBe("2026-10-31");
    expect(win.months).toHaveLength(2);
  });

  it("clamps a closing day to the real length of its month", () => {
    const win = cycleWindow(
      { cycle_month_offset: 0, start_day: 15, end_month_offset: 5, end_day: 31 }, SEP_21);

    expect(iso(win.end)).toBe("2027-02-28");
    expect(win.months).toHaveLength(6);
  });

  it("keeps the old shorthand: a closing day before the opening one means next month", () => {
    const win = cycleWindow({ cycle_month_offset: 0, start_day: 26, end_day: 5 }, SEP_1);

    expect(iso(win.start)).toBe("2026-09-26");
    expect(iso(win.end)).toBe("2026-10-05");
  });

  it("names the month it serves without moving a date", () => {
    const win = cycleWindow({
      cycle_month_offset: 0, start_day: 1, end_month_offset: 1, end_day: 31,
      serves_month_offset: 2,
    }, SEP_21);

    expect(iso(win.start)).toBe("2026-09-01");
    expect(iso(win.serves)).toBe("2026-11-01");
  });
});

describe("dueDate", () => {
  const win = cycleWindow(
    { cycle_month_offset: 0, start_day: 10, end_month_offset: 1, end_day: 31 }, SEP_1);

  it("fires in whichever month of the window carries the day", () => {
    expect(iso(dueDate(win, 20))).toBe("2026-09-20");
    expect(iso(dueDate(win, 5))).toBe("2026-10-05");
  });

  it("pulls a day no month of the window reaches onto the nearest edge", () => {
    const short = cycleWindow({ cycle_month_offset: 0, start_day: 10, end_day: 20 }, SEP_1);

    expect(iso(dueDate(short, 3))).toBe("2026-09-10");
    expect(iso(dueDate(short, 28))).toBe("2026-09-20");
    expect(isDayOutsideWindow(short, 3)).toBe(true);
    expect(isDayOutsideWindow(win, 5)).toBe(false);
  });
});

describe("monthsAfter", () => {
  it("counts whole months across a year boundary", () => {
    expect(monthsAfter(2026, 11, new Date(2027, 1, 4))).toBe(2);
    expect(monthsAfter(2026, 8, new Date(2026, 8, 30))).toBe(0);
  });
});
