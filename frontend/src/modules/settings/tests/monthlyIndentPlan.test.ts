/** The screen's half of the cycle arithmetic, against the server's own cases.
 *
 *  `monthlyIndentPlan` exists to draw the schedule the server will actually run, so
 *  every case here is one of `platform/monthly_indent/tests/test_monthly_indent.py`
 *  read back in TypeScript. Where the two disagree the ribbon lies, and a ribbon that
 *  lies is worse than no ribbon: it is the only thing on the screen anybody checks.
 */
import { describe, expect, it } from "vitest";

import {
  cyclePeriodMonths, cycleWindow, dueDate, escalationSteps, isDayOutsideWindow, monthsAfter,
} from "../monthlyIndentPlan";

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
    // Between two cycles (the 5th has passed, the 26th has not): the next one.
    const win = cycleWindow(
      { cycle_month_offset: 0, start_day: 26, end_day: 5 }, new Date(2026, 8, 10));

    expect(iso(win.start)).toBe("2026-09-26");
    expect(iso(win.end)).toBe("2026-10-05");
  });

  it("keeps a cross-month window in force through its closing month", () => {
    const win = cycleWindow(
      { cycle_month_offset: 0, start_day: 26, end_day: 5 }, new Date(2026, 9, 3));

    expect(iso(win.start)).toBe("2026-09-26");
    expect(iso(win.end)).toBe("2026-10-05");
    expect(cyclePeriodMonths({ cycle_month_offset: 0, start_day: 26, end_day: 5 })).toBe(1);
  });

  it("opens a two-month window every second month from its anchor", () => {
    const shape = {
      cycle_month_offset: 0, start_day: 1, end_month_offset: 1, end_day: 31,
      anchor_month: "2026-09-01",
    };

    expect(iso(cycleWindow(shape, new Date(2026, 9, 20)).start)).toBe("2026-09-01");
    expect(iso(cycleWindow(shape, new Date(2026, 10, 3)).start)).toBe("2026-11-01");
    expect(cyclePeriodMonths(shape)).toBe(2);
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

describe("escalationSteps", () => {
  const win = cycleWindow({ cycle_month_offset: 0, start_day: 1, end_day: 10 },
                          new Date(2026, 8, 2));

  it("counts a follow-up from the reminder and climbs one step per gap", () => {
    const steps = escalationSteps(win, {
      escalation_enabled: true, escalation_target_type: "REPORTING_MANAGER",
      escalation_after_days: 1, escalation_levels: 3,
      trigger_day: 3, trigger_time: "10:00", escalation_time: null,
    });

    expect(steps.map((step) => iso(step.date)))
      .toEqual(["2026-09-04", "2026-09-05", "2026-09-06"]);
    expect(steps[0].time).toBe("10:00");
  });

  it("climbs only a reporting line, and never past the close", () => {
    expect(escalationSteps(win, {
      escalation_enabled: true, escalation_target_type: "HCM_ROLE",
      escalation_after_days: 1, escalation_levels: 3, trigger_day: 3,
      trigger_time: "10:00",
    })).toHaveLength(1);
    const late = escalationSteps(win, {
      escalation_enabled: true, escalation_target_type: "REPORTING_MANAGER",
      escalation_after_days: 7, escalation_levels: 2, trigger_day: 5,
      trigger_time: "10:00",
    });
    expect(iso(late[1].date)).toBe("2026-09-10");
    expect(late[1].moved).toBe(true);
  });
});

describe("monthsAfter", () => {
  it("counts whole months across a year boundary", () => {
    expect(monthsAfter(2026, 11, new Date(2027, 1, 4))).toBe(2);
    expect(monthsAfter(2026, 8, new Date(2026, 8, 30))).toBe(0);
  });
});
