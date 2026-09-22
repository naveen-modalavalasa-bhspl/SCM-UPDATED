/** The month, as a plan — and the plain English for every part of it.
 *
 *  The Monthly Indent screen is a schedule, not a form: a window in the month when
 *  stores send their indent, and a handful of nudges fired on named days inside it.
 *  Drawn as a row of number boxes it said nothing — "trigger day 21" and "end day 30"
 *  are two integers, and whether the first falls inside the second is arithmetic the
 *  reader had to do in their head, every time, against a month whose length they also
 *  had to remember.
 *
 *  So the dates are computed HERE, once, mirroring `platform/monthly_indent/service.py`
 *  exactly — `calculate_cycle` for the window, `occurrence` for where a reminder
 *  actually lands. The ribbon on screen is therefore not a picture of the settings: it is the
 *  schedule the server will run, drawn. If the two ever drift the ribbon lies, which is
 *  why every rule below names the server function it mirrors and why this file holds no
 *  React.
 *
 *  The wording lives here for the same reason the enums do on the server: a condition
 *  must read the same in the list, in the editor and in the day panel, and three copies
 *  of "has not sent this month's indent" is three chances to say it differently.
 */
import type {
  MonthlyIndentCondition, MonthlyIndentCycle, MonthlyIndentEscalationTargetType,
  MonthlyIndentRule, MonthlyIndentTargetType,
} from "./types";

/* ---------------------------------------------------------------------------
 * Dates. Mirrors service.calculate_cycle / service.occurrence.
 * ------------------------------------------------------------------------- */

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** The 1st of the month `months` after `anchor`'s month. */
function addMonths(year: number, month: number, months: number) {
  const total = month + months;
  return { year: year + Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
}

/** A day number clamped to the month's real length — day 31 in February is the 28th
 *  (or 29th), which is what the server means by "last day". */
export function clampedDay(year: number, month: number, day: number): Date {
  return new Date(year, month, Math.min(Math.max(day, 1), daysInMonth(year, month)));
}

export interface CycleWindow {
  start: Date;
  end: Date;
  /** The window runs past the end of the month it opens in. */
  wraps: boolean;
  /** The months the ribbon has to draw — the opening month through the closing one. */
  months: { year: number; month: number }[];
  /** The first of the month these indents are FOR. Not a date the window is measured
   *  against: only what the cycle is called. */
  serves: Date;
}

/** Which settings of the cycle describe the window. The rest of the row — the
 *  timezone, the scheduler, the approval switch — moves no date. */
export type CycleShape = Pick<MonthlyIndentCycle,
  "cycle_month_offset" | "start_day" | "end_day"> &
  Partial<Pick<MonthlyIndentCycle, "end_month_offset" | "serves_month_offset">>;

/** How many months after the opening month the window closes in. Mirrors
 *  `service.cycle_span_months`.
 *
 *  `end_month_offset` states it. Zero keeps the one shorthand that existed before
 *  that field did — a closing day EARLIER than the opening day means the next month
 *  — so a cycle saved as 26 -> 5 still draws the window it always drew.
 */
export function cycleSpanMonths(cycle: CycleShape): number {
  if (cycle.end_month_offset) return cycle.end_month_offset;
  return cycle.end_day < cycle.start_day ? 1 : 0;
}

/** The window the server would resolve from these settings, today.
 *
 *  Each end is two decisions — a day, and which month that day is in — so a cycle may
 *  run from one day to just over a year, and `months` is however many the band
 *  crosses. Drawing a multi-month window inside one month would put the close before
 *  the open, which is the whole reason `months` is a list.
 */
export function cycleWindow(cycle: CycleShape, today: Date = new Date()): CycleWindow {
  const anchor = addMonths(today.getFullYear(), today.getMonth(), cycle.cycle_month_offset || 0);
  const start = clampedDay(anchor.year, anchor.month, cycle.start_day);
  const span = cycleSpanMonths(cycle);
  const endAnchor = addMonths(anchor.year, anchor.month, span);
  const end = clampedDay(endAnchor.year, endAnchor.month, cycle.end_day);
  const months = Array.from({ length: span + 1 },
                            (_, index) => addMonths(anchor.year, anchor.month, index));
  const serves = addMonths(anchor.year, anchor.month, cycle.serves_month_offset || 0);
  return {
    start, end, wraps: span > 0, months,
    serves: new Date(serves.year, serves.month, 1),
  };
}

/** Where a day-of-month setting actually fires — mirrors `service.occurrence`.
 *
 *  A window that spans months carries the same day number more than once, so the
 *  FIRST occurrence inside the window wins. A day the window never reaches is still
 *  pulled to the nearest edge rather than dropped, and the ribbon draws it there:
 *  a pin sitting outside the band would say "this never fires", which is not what
 *  happens.
 */
export function dueDate(window: CycleWindow, day: number): Date {
  for (const { year, month } of window.months) {
    const candidate = clampedDay(year, month, day);
    if (candidate >= window.start && candidate <= window.end) return candidate;
  }
  const first = clampedDay(window.start.getFullYear(), window.start.getMonth(), day);
  return first < window.start ? window.start : window.end;
}

/** True when the day was moved to fire somewhere other than where it was typed —
 *  i.e. no month of the window carries it. */
export function isDayOutsideWindow(window: CycleWindow, day: number): boolean {
  return !window.months.some(({ year, month }) => {
    const candidate = clampedDay(year, month, day);
    return candidate >= window.start && candidate <= window.end;
  });
}

/** How many whole months `date` sits after the given month. Negative before it.
 *
 *  Tapping a day on the ribbon has to set a day AND a month offset — without the
 *  second, "close the collection here" on a day in the band's second month silently
 *  moved the close into the first one. */
export function monthsAfter(year: number, month: number, date: Date): number {
  return (date.getFullYear() - year) * 12 + (date.getMonth() - month);
}

export const dateKey = (date: Date) =>
  `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

export const sameDay = (a: Date, b: Date) => dateKey(a) === dateKey(b);

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const monthName = (year: number, month: number) => `${MONTH_NAMES[month]} ${year}`;

/** "3 Sep" — short, because it appears inside sentences. */
export function shortDate(date: Date): string {
  return `${date.getDate()} ${MONTH_NAMES[date.getMonth()].slice(0, 3)}`;
}

/** "21 September" — for the one place a sentence carries a single date. The year is
 *  spelled only when it has to be: a window may now run from December into January,
 *  and "1 December to 31 January" leaves which January open to guessing. */
export function longDate(date: Date, withYear = false): string {
  const year = withYear ? ` ${date.getFullYear()}` : "";
  return `${date.getDate()} ${MONTH_NAMES[date.getMonth()]}${year}`;
}

/** "10:00" (or "10:00:00" off the wire) read as "10:00 am". Twelve-hour, because a
 *  storekeeper reading "18:30" has to convert and half of them get it wrong. */
export function prettyTime(value?: string | null): string {
  if (!value) return "—";
  const [rawHour, rawMinute] = value.split(":");
  const hour = Number(rawHour);
  if (Number.isNaN(hour)) return value;
  const suffix = hour < 12 ? "am" : "pm";
  const shown = hour % 12 === 0 ? 12 : hour % 12;
  return `${shown}:${rawMinute ?? "00"} ${suffix}`;
}

/** The HH:MM an `<input type="time">` wants, from whatever the wire carried. */
export const timeValue = (value?: string | null) => (value ? value.slice(0, 5) : "");

/** "every 30 minutes" / "every 2 hours" — a number of minutes is not a duration to
 *  anybody who is not already thinking in minutes. */
export function everyPhrase(minutes: number): string {
  if (!minutes || minutes < 1) return "never";
  if (minutes < 60) return `every ${minutes} minutes`;
  const hours = minutes / 60;
  if (Number.isInteger(hours)) return hours === 1 ? "every hour" : `every ${hours} hours`;
  return `every ${Math.floor(hours)} h ${minutes % 60} min`;
}

/* ---------------------------------------------------------------------------
 * The words. One copy each.
 * ------------------------------------------------------------------------- */

/** What the rule is looking for. The sentence that goes after "…who".
 *
 *  NOT_RESPONDED and NOT_SUBMITTED ask the server the SAME question (see
 *  `eligible_candidates`) — the difference is what the admin means by it, so the
 *  wording separates them by intent rather than pretending they check two things.
 */
export const CONDITION_CLAUSE: Record<MonthlyIndentCondition, string> = {
  NOT_SUBMITTED: "has not sent this month's indent yet",
  NOT_RESPONDED: "still has not sent it after the first reminder",
  PENDING_APPROVAL: "has a monthly indent sitting with them for approval",
};

/** The same thing, short enough for a chip. */
export const CONDITION_CHIP: Record<MonthlyIndentCondition, string> = {
  NOT_SUBMITTED: "Not sent yet",
  NOT_RESPONDED: "Still not sent",
  PENDING_APPROVAL: "Waiting to approve",
};

export const CONDITION_OPTIONS = (Object.keys(CONDITION_CLAUSE) as MonthlyIndentCondition[])
  .map((value) => ({ value, label: CONDITION_CLAUSE[value] }));

export const TARGET_NOUN: Record<MonthlyIndentTargetType, string> = {
  HCM_ROLE: "Everyone with a job role",
  POSITION: "Everyone holding one post",
  EMPLOYEE: "One named person",
};

export const TARGET_OPTIONS = (Object.keys(TARGET_NOUN) as MonthlyIndentTargetType[])
  .map((value) => ({ value, label: TARGET_NOUN[value] }));

export const ESCALATION_NOUN: Record<MonthlyIndentEscalationTargetType, string> = {
  REPORTING_MANAGER: "Their own reporting manager",
  HCM_ROLE: "Everyone with a job role",
  EMPLOYEE: "One named person",
};

export const ESCALATION_OPTIONS =
  (Object.keys(ESCALATION_NOUN) as MonthlyIndentEscalationTargetType[])
    .map((value) => ({ value, label: ESCALATION_NOUN[value] }));

type RuleLike = Pick<MonthlyIndentRule,
  "target_type" | "target_ref_id" | "target_name" | "condition"> & Partial<MonthlyIndentRule>;

/** Who gets the first nudge — "every Store Keeper", "Ramesh Kumar".
 *
 *  Nothing chosen yet is its own answer. Prefixing the placeholder like a real name
 *  produced "remind every nobody yet", which reads as a bug in the sentence rather
 *  than as a field still to be filled. */
export function whoPhrase(rule: RuleLike): string {
  if (!rule.target_ref_id && !rule.target_name) return "nobody yet";
  const name = rule.target_name || `#${rule.target_ref_id}`;
  if (rule.target_type === "EMPLOYEE") return name;
  if (rule.target_type === "POSITION") return `everyone in the post ${name}`;
  return `every ${name}`;
}

/** Who gets told when the nudge was ignored. */
export function chasePhrase(rule: Partial<MonthlyIndentRule>): string {
  const name = rule.escalation_target_name
    || (rule.escalation_target_ref_id ? `#${rule.escalation_target_ref_id}` : "");
  if (rule.escalation_target_type === "EMPLOYEE") return name || "one named person";
  if (rule.escalation_target_type === "HCM_ROLE") return name ? `every ${name}` : "a job role";
  // REPORTING_MANAGER with a role filter climbs until it finds that rank.
  return name ? `their nearest manager who is a ${name}` : "their reporting manager";
}

/** The whole rule as one sentence, for the list and the day panel. */
export function ruleSentence(rule: RuleLike): string {
  return `Remind ${whoPhrase(rule)} who ${CONDITION_CLAUSE[rule.condition]}.`;
}

/* ---------------------------------------------------------------------------
 * The agenda — the month read top to bottom.
 * ------------------------------------------------------------------------- */

export type AgendaKind = "open" | "remind" | "chase" | "close";

export interface AgendaItem {
  key: string;
  kind: AgendaKind;
  date: Date;
  /** Sorts within a day. The bookends have no clock, so they take the edges. */
  time: string;
  title: string;
  detail: string;
  rule?: MonthlyIndentRule;
  /** The rule's day setting fell outside the window and was pulled to this edge. */
  moved?: boolean;
}

/** Everything that happens this cycle, in the order it happens.
 *
 *  Inactive rules are left OUT rather than greyed in: this list answers "what will
 *  happen", and a switched-off rule will not happen. It is still in the rules list,
 *  which answers "what is configured".
 */
export function buildAgenda(
  cycle: CycleShape,
  rules: MonthlyIndentRule[],
  today: Date = new Date(),
): { window: CycleWindow; items: AgendaItem[] } {
  const window = cycleWindow(cycle, today);
  const items: AgendaItem[] = [
    {
      key: "open", kind: "open", date: window.start, time: "00:00",
      title: "Collection opens",
      detail: "Stores can start sending this month's indent.",
    },
    {
      key: "close", kind: "close", date: window.end, time: "23:59",
      title: "Collection closes",
      detail: "The last day counted for this month's indent.",
    },
  ];

  for (const rule of rules) {
    if (!rule.is_active) continue;
    items.push({
      key: `remind-${rule.id}`,
      kind: "remind",
      date: dueDate(window, rule.trigger_day),
      time: timeValue(rule.trigger_time) || "00:00",
      title: rule.name,
      detail: ruleSentence(rule),
      rule,
      moved: isDayOutsideWindow(window, rule.trigger_day),
    });
    if (rule.escalation_enabled && rule.escalation_day) {
      items.push({
        key: `chase-${rule.id}`,
        kind: "chase",
        date: dueDate(window, rule.escalation_day),
        time: timeValue(rule.escalation_time) || "00:00",
        title: `${rule.name} — no response`,
        detail: `Tell ${chasePhrase(rule)}.`,
        rule,
        moved: isDayOutsideWindow(window, rule.escalation_day),
      });
    }
  }

  items.sort((a, b) => (a.date.getTime() - b.date.getTime()) || a.time.localeCompare(b.time));
  return { window, items };
}

/** The variables a message may carry, with an example of each, so the editor can
 *  show what one produces without asking the server. The server renders the real
 *  thing on Preview; these are only the hints beside the chips. */
export const TEMPLATE_VARIABLES: { token: string; label: string; example: string }[] = [
  { token: "employee_name", label: "Person's name", example: "Ramesh Kumar" },
  { token: "role", label: "Their job role", example: "Store Keeper" },
  { token: "month", label: "The month", example: "September 2026" },
  { token: "cycle_start", label: "First day", example: "2026-09-01" },
  { token: "cycle_end", label: "Last day", example: "2026-09-30" },
  { token: "pending_since", label: "Waiting since", example: "2026-09-21 10:00" },
  { token: "approval_level", label: "Approval step", example: "OE Review" },
];
