import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Every control the Indent module puts on screen, addressed the way a person
 * finds it.
 *
 * Two rules hold throughout:
 *
 * 1. **Roles and visible text, not test ids.** A locator only a test can find
 *    proves nothing about whether anyone can use the screen. Where the app leaves
 *    a control with no accessible name, the comment says so — those are findings,
 *    not things to paper over with a `data-testid`.
 * 2. **Never sleep to wait.** These screens keep their filter state in the URL
 *    (Overview excepted — see `FilterStateHome`) and announce their own loading
 *    with `aria-busy`. So an action is followed by "the app's query state says it
 *    accepted this" and "the busy flag cleared", which are facts, rather than by a
 *    timeout, which is a guess. Even the search box's 300 ms debounce is waited
 *    out by watching the query change, not the clock.
 *
 * HeroUI tables render through react-aria: every list is `role="grid"` named
 * "List", never `role="table"`.
 */

/* ------------------------------------------------------------------ the module */

export const INDENT_TABS = [
  { label: "Overview", path: "/indents/dashboard", title: "Overview" },
  { label: "All requests", path: "/indents", title: "All requests" },
  { label: "Acknowledgements", path: "/indents/acknowledgements", title: "Acknowledgements" },
  { label: "Activity ledger", path: "/indents/reports", title: "Activity ledger" },
  { label: "Alert & Notification", path: "/indents/notifications", title: "Alert & Notification" },
] as const;

/** Out of scope by request; the run must not visit or assert on it. */
export const EXCLUDED_TAB = "Acknowledgments";

export type IndentTabLabel = (typeof INDENT_TABS)[number]["label"];

export function isoDate(daysFromToday = 0, now = new Date()) {
  const value = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysFromToday);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

/**
 * The ranges the filter bar resolves its presets to, reimplemented here.
 *
 * Deliberately a second implementation rather than an import: the point of the
 * assertion is that the app's arithmetic is right, and a test that borrows the
 * app's own function can only ever agree with it.
 */
export function raisedRange(preset: "today" | "this_week" | "this_month", now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const local = (value: Date) =>
    `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  if (preset === "today") return { from: local(today), to: local(today) };
  if (preset === "this_week") {
    const monday = new Date(today);
    monday.setDate(today.getDate() - (today.getDay() === 0 ? 6 : today.getDay() - 1));
    return { from: local(monday), to: local(today) };
  }
  return { from: local(new Date(today.getFullYear(), today.getMonth(), 1)), to: local(today) };
}

export function requiredByRange(preset: "today" | "next_7_days" | "next_30_days", now = new Date()) {
  if (preset === "today") return { from: isoDate(0, now), to: isoDate(0, now) };
  return { from: isoDate(0, now), to: isoDate(preset === "next_7_days" ? 7 : 30, now) };
}

/* ------------------------------------------------------------------- settling */

/**
 * Waits for the screen to stop fetching.
 *
 * `networkidle` is both discouraged and wrong here — TanStack Query prefetches the
 * adjacent page in the background, so the network is never idle at a predictable
 * moment. The app's own `aria-busy` region is the honest signal.
 */
export async function settle(page: Page, timeout = 20_000) {
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.locator("[aria-busy='true']").first()
    .waitFor({ state: "detached", timeout })
    .catch(() => undefined);
}

/** The query string the app currently has in the address bar. */
export function currentQuery(page: Page) {
  return new URL(page.url()).search.replace(/^\?/, "");
}

export function currentPath(page: Page) {
  return new URL(page.url()).pathname;
}

/* ---------------------------------------------------------------- navigation */

export function indentNav(page: Page) {
  return page.getByRole("navigation", { name: "Indent" });
}

export async function openTab(page: Page, label: IndentTabLabel) {
  await indentNav(page).getByRole("link", { name: label, exact: true }).click();
  await settle(page);
}

export function pageTitle(page: Page) {
  return page.getByRole("heading", { level: 1 }).first();
}

export function newIndentButton(page: Page) {
  return page.getByRole("button", { name: "New indent" });
}

/* ---------------------------------------------------------------- filter bar */

export type DateFilterLabel = "Raised date" | "Required by" | "Activity date" | "Notification date";

/** What a filter change is proved by, which is not the same on every screen. */
export type FilterStateHome =
  /** All requests, Activity ledger, Alert & Notification: filters live in the URL. */
  | { kind: "url" }
  /**
   * Overview: filters live in React state only, so the address bar never moves.
   * The honest signal there is the request the screen makes as a result — matched
   * on its own query string, so a stale in-flight response cannot satisfy the wait.
   */
  | { kind: "request"; path: string };

/**
 * The shared filter bar, in all four of its modes.
 *
 * The modes differ in ways that matter to a test and are easy to get wrong:
 *
 * - On Overview and All requests a date preset is *staged* and needs Apply. On
 *   Activity ledger and Alert & Notification the same preset applies the moment
 *   it is clicked, and closes the popup itself.
 * - Overview is the only one of the four whose filters are not in the URL, so it
 *   is also the only one where a reload loses them and a filtered view cannot be
 *   shared as a link. That is a real difference in behaviour, and the run says so
 *   rather than pretending the four screens are the same.
 *
 * Every method takes the same predicate — "what should be true of the query once
 * this lands" — and each mode proves it its own way.
 */
export class FilterBar {
  constructor(
    private readonly page: Page,
    private readonly options: {
      appliesPresetsImmediately?: boolean;
      stateHome?: FilterStateHome;
    } = {},
  ) {}

  private get stateHome(): FilterStateHome {
    return this.options.stateHome ?? { kind: "url" };
  }

  private get appliesPresetsImmediately() {
    return this.options.appliesPresetsImmediately ?? false;
  }

  /** Runs an action and waits until the app's query state satisfies `predicate`. */
  private async run(predicate: (params: URLSearchParams) => boolean, action: () => Promise<void>) {
    const home = this.stateHome;
    if (home.kind === "url") {
      await action();
      await expect(this.page).toHaveURL(
        (url) => predicate(new URLSearchParams(url.search)),
        { timeout: 20_000 },
      );
    } else {
      // Armed before the action so a fast response cannot be missed.
      //
      // Best-effort, deliberately: returning to a filter the query cache already
      // holds and still considers fresh produces no request at all, so insisting
      // on one would fail the second time a test visits the same combination.
      // Nothing rests on this wait — it only avoids reading the screen mid-flight.
      // The assertion that follows polls the rendered values against the API, so a
      // filter that quietly did nothing is still caught, and caught by name.
      const response = this.page.waitForResponse(
        (candidate) => {
          const url = new URL(candidate.url());
          return url.pathname === home.path && predicate(url.searchParams);
        },
        { timeout: 10_000 },
      ).catch(() => undefined);
      await action();
      await response;
    }
    await settle(this.page);
  }

  get search() {
    return this.page.getByRole("searchbox").first();
  }

  get clearSearchButton() {
    return this.page.getByRole("button", { name: "Clear search" });
  }

  /**
   * Types into the search box and waits for the app to act on it.
   *
   * The bar debounces 300 ms before it touches the query, so the wait is on the
   * query actually carrying the term — never on the clock.
   */
  async searchFor(text: string) {
    await this.run(
      (params) => params.get("search") === text.trim(),
      async () => { await this.search.fill(text); },
    );
  }

  async clearSearch() {
    await this.run(
      (params) => !params.has("search"),
      async () => { await this.clearSearchButton.click(); },
    );
  }

  private trigger(name: RegExp | string) {
    return this.page.getByRole("button", { name }).first();
  }

  get statusTrigger() {
    return this.trigger(/^(Status|Indent status|Event)( \(\d+\))?$/);
  }

  get priorityTrigger() {
    return this.trigger(/^Priority( \(\d+\))?$/);
  }

  dateTrigger(label: DateFilterLabel) {
    return this.trigger(label);
  }

  get clearAll() {
    return this.page.getByRole("button", { name: "Clear all" });
  }

  /**
   * Opens one of the two HeroUI dropdowns.
   *
   * They are `closeOnSelect={false}`, so one is frequently still open when the
   * next toggle begins and the first click merely closes it. Retrying makes
   * "open the menu" mean what it says instead of depending on what the previous
   * step happened to leave behind.
   */
  private async openMenu(trigger: Locator) {
    const menu = this.page.getByRole("menu");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await menu.isVisible().catch(() => false)) return menu;
      await trigger.click();
      if (await menu.isVisible({ timeout: 3_000 }).catch(() => false)) return menu;
    }
    await expect(menu, "The filter dropdown never opened.").toBeVisible({ timeout: 5_000 });
    return menu;
  }

  private async closeMenu() {
    await this.page.keyboard.press("Escape");
    await expect(this.page.getByRole("menu")).toBeHidden({ timeout: 10_000 }).catch(() => undefined);
  }

  /** The labels a dropdown currently offers — a filter can only filter by these. */
  async optionsOf(trigger: Locator): Promise<string[]> {
    const menu = await this.openMenu(trigger);
    const labels = (await menu.getByRole("menuitem").allInnerTexts()).map((text) => text.trim());
    await this.closeMenu();
    return labels;
  }

  private async pick(
    trigger: Locator,
    optionLabel: string,
    predicate: (params: URLSearchParams) => boolean,
  ) {
    await this.run(predicate, async () => {
      const menu = await this.openMenu(trigger);
      await menu.getByRole("menuitem", { name: optionLabel, exact: true }).click();
      await this.closeMenu();
    });
  }

  /** Selects a status; `param` is `status` everywhere but the ledger's Event filter. */
  async selectStatus(optionLabel: string, value: string, param = "status") {
    await this.pick(this.statusTrigger, optionLabel, (params) => params.getAll(param).includes(value));
  }

  async deselectStatus(optionLabel: string, value: string, param = "status") {
    await this.pick(this.statusTrigger, optionLabel, (params) => !params.getAll(param).includes(value));
  }

  async selectPriority(optionLabel: string, value: string) {
    await this.pick(this.priorityTrigger, optionLabel, (params) => params.getAll("priority").includes(value));
  }

  async deselectPriority(optionLabel: string, value: string) {
    await this.pick(this.priorityTrigger, optionLabel, (params) => !params.getAll("priority").includes(value));
  }

  datePopup(label: DateFilterLabel) {
    return this.page.getByRole("dialog", { name: `${label} filter` });
  }

  async openDate(label: DateFilterLabel) {
    const popup = this.datePopup(label);
    if (!(await popup.isVisible().catch(() => false))) await this.dateTrigger(label).click();
    await expect(popup, `The "${label}" filter popup did not open.`).toBeVisible({ timeout: 10_000 });
    return popup;
  }

  async closeDate(label: DateFilterLabel) {
    const popup = this.datePopup(label);
    if (await popup.isVisible().catch(() => false)) {
      await popup.getByRole("button", { name: `Close ${label} filter` }).click();
      await expect(popup).toBeHidden({ timeout: 10_000 });
    }
  }

  /**
   * Picks a named preset and makes sure it took effect.
   *
   * `expectUrl` is what "took effect" means for this screen, so a preset that
   * silently fails to apply cannot pass as one that did.
   */
  async applyDatePreset(
    label: DateFilterLabel,
    preset: string,
    predicate: (params: URLSearchParams) => boolean,
  ) {
    await this.run(predicate, async () => {
      const popup = await this.openDate(label);
      await popup.getByRole("button", { name: preset, exact: true }).click();
      if (!this.appliesPresetsImmediately) {
        await popup.getByRole("button", { name: "Apply", exact: true }).click();
      }
      await expect(popup, `The "${label}" popup stayed open after ${preset}.`)
        .toBeHidden({ timeout: 10_000 });
    });
  }

  async applyCustomRange(
    label: DateFilterLabel,
    from: string,
    to: string,
    predicate: (params: URLSearchParams) => boolean,
  ) {
    await this.run(predicate, async () => {
      const popup = await this.openDate(label);
      await popup.getByRole("button", { name: "Custom range", exact: true }).click();
      await popup.getByLabel(`${label} from`).fill(from);
      await popup.getByLabel(`${label} to`).fill(to);
      await popup.getByRole("button", { name: "Apply", exact: true }).click();
      await expect(popup, `The "${label}" popup stayed open after Apply.`)
        .toBeHidden({ timeout: 10_000 });
    });
  }

  /** Clears from inside the popup, which is a different control to "Clear all". */
  async clearDate(label: DateFilterLabel, predicate: (params: URLSearchParams) => boolean) {
    await this.run(predicate, async () => {
      const popup = await this.openDate(label);
      await popup.getByRole("button", { name: "Clear", exact: true }).click();
      await expect(popup).toBeHidden({ timeout: 10_000 });
    });
  }

  async resetAll() {
    if (!(await this.clearAll.isVisible().catch(() => false))) return;
    await this.run(
      (params) => params.toString() === "",
      async () => { await this.clearAll.click(); },
    );
  }

  /** The filter bar itself — the one section on the screen holding the search box. */
  get bar() {
    return this.page.locator("section").filter({ has: this.page.getByRole("searchbox") }).first();
  }

  /**
   * Every filter chip currently shown, as the words a person reads.
   *
   * HeroUI's `Chip` renders a bare `div` with utility classes and no role, no
   * `data-slot` and no accessible name, so there is nothing to address it by:
   * these are read as lines of text out of the filter bar instead. That is a
   * finding in itself — a chip that removes a filter when clicked is a control,
   * and it is invisible to anything that navigates by role.
   */
  async chipTexts(): Promise<string[]> {
    const text = await this.bar.innerText().catch(() => "");
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) =>
        /^(Search|Raised|Status|Indent status|Priority|Required by|Activity date|Notification date|Event|Item|Transaction):/
          .test(line));
  }
}

/* ------------------------------------------------------------------ list grid */

/** Every HeroUI list on every Indent screen is a grid labelled "List". */
export class ListGrid {
  /**
   * `emptyMessage` is what the screen puts in the cell when there is nothing to
   * show. It is a `RegExp` on Acknowledgements, where the empty content is a whole
   * `EmptyState` block rather than a single sentence.
   */
  constructor(readonly page: Page, private readonly emptyMessage: string | RegExp) {}

  get grid() {
    return this.page.getByRole("grid", { name: "List" });
  }

  get rows() {
    return this.grid.locator("tbody tr");
  }

  get emptyCell() {
    return this.page.getByRole("gridcell", { name: this.emptyMessage });
  }

  header(name: string) {
    return this.grid.getByRole("columnheader", { name, exact: true });
  }

  async isEmpty() {
    return this.emptyCell.isVisible().catch(() => false);
  }

  /**
   * Every row as its cell texts, in column order. Empty when the list is empty.
   *
   * `innerText`, not `textContent`: a cell that stacks two lines — an indent
   * number over its date, an item name over its code — concatenates into one
   * unreadable run under `textContent`, and a test that then splits on
   * whitespace gets "IND/2026-27/00139Needed" and compares it against nothing.
   */
  async matrix(): Promise<string[][]> {
    if (await this.isEmpty()) return [];
    return this.rows.evaluateAll((rows) =>
      rows.map((row) =>
        Array.from(row.querySelectorAll("td")).map((cell) => ((cell as HTMLElement).innerText ?? "").trim())));
  }

  /** The values in one column, top to bottom — the run's row identity. */
  async column(index: number): Promise<string[]> {
    return (await this.matrix()).map((cells) => cells[index] ?? "");
  }
}

export interface PagerReading {
  page: number;
  pages: number;
  total: number;
}

export function pagerSummary(page: Page) {
  return page.getByText(/^Page \d+ of \d+ \(\d+ total\)$/).first();
}

export async function readPager(page: Page): Promise<PagerReading | null> {
  const text = await pagerSummary(page).innerText().catch(() => "");
  const match = text.match(/Page (\d+) of (\d+) \((\d+) total\)/);
  return match ? { page: Number(match[1]), pages: Number(match[2]), total: Number(match[3]) } : null;
}

export function pagerButton(page: Page, direction: "Previous" | "Next") {
  return page.getByRole("button", { name: direction }).first();
}

export async function goToPage(page: Page, direction: "Previous" | "Next", expectedPage: number) {
  await pagerButton(page, direction).click();
  await expect(page).toHaveURL(
    (url) => {
      const value = new URLSearchParams(url.search).get("page");
      return expectedPage === 1 ? value === null : value === String(expectedPage);
    },
    { timeout: 15_000 },
  );
  await settle(page);
}

/* -------------------------------------------------------------------- overview */

export class Overview {
  static readonly KPI_LABELS = [
    "Total indents", "Awaiting approval", "Approved active", "Raised this month",
    "In draft", "Units requested", "Rejected", "Approval rate",
  ] as const;

  readonly filters: FilterBar;

  constructor(private readonly page: Page) {
    // Overview alone keeps its filters out of the URL, so a filter change is
    // proved by the stats call it triggers rather than by the address bar.
    this.filters = new FilterBar(page, { stateHome: { kind: "request", path: "/api/indents/stats" } });
  }

  /**
   * The number on one KPI tile.
   *
   * The tile has no accessible relationship between its caption and its value —
   * both are plain spans in a card — so this walks up to the card and picks the
   * numeric line. That the walk is necessary is itself worth knowing.
   */
  async kpi(label: string): Promise<string> {
    const tile = this.page.getByText(label, { exact: true }).first().locator("xpath=../..");
    const lines = (await tile.innerText()).split("\n").map((line) => line.trim()).filter(Boolean);
    return lines.find((line) => line !== label && /^-?[\d,]+(?:\.\d+)?%?$|^-$/.test(line)) ?? "";
  }

  /**
   * The number in the middle of the donut.
   *
   * The test id sits on the whole centre block, which also holds the caption
   * "Total indents", so the number itself is the first span inside it.
   */
  get donutTotal() {
    return this.page.getByTestId("status-donut-total").locator("span").first();
  }

  get emptyDonut() {
    return this.page.getByTestId("status-empty-donut-track");
  }

  legendCount(status: string) {
    return this.page.getByTestId(`status-legend-count-${status}`);
  }

  get legend() {
    return this.page.getByTestId("status-breakdown-legend");
  }

  private get recentCard() {
    return this.page.getByRole("heading", { name: "Recent Indents" }).locator("xpath=../..");
  }

  recentRows() {
    return this.recentCard.getByRole("button").filter({ hasNotText: /^View all$/ });
  }

  /** The indent numbers on the Recent Indents card, newest first. */
  async recentIndentNos(): Promise<string[]> {
    const texts = await this.recentRows().allInnerTexts();
    return texts.map((text) => text.split("\n")[0].trim()).filter(Boolean);
  }

  get viewAll() {
    return this.page.getByRole("button", { name: "View all" });
  }

  get emptyRecent() {
    return this.page.getByText("No indents match active filters.");
  }

  get statsError() {
    return this.page.locator(".text-bad").first();
  }
}

/* --------------------------------------------------------------- all requests */

export class AllRequests {
  static readonly COLUMNS = ["Indent", "Requested by", "Department", "Items", "Status", "Raised"] as const;
  static readonly INDENT_COLUMN = 0;
  static readonly STATUS_COLUMN = 4;

  readonly filters: FilterBar;
  readonly list: ListGrid;

  constructor(private readonly page: Page) {
    this.filters = new FilterBar(page);
    this.list = new ListGrid(page, "No indents match active filters.");
  }

  indentNos() {
    return this.list.column(AllRequests.INDENT_COLUMN);
  }

  statuses() {
    return this.list.column(AllRequests.STATUS_COLUMN);
  }

  /** Opens a row by its indent number and waits to land on that indent. */
  async openIndent(indentNo: string) {
    await this.list.rows.filter({ hasText: indentNo }).first().click();
    await this.page.waitForURL(/\/indents\/\d+(\?.*)?$/, { timeout: 30_000 });
    await settle(this.page);
    return Number(this.page.url().match(/\/indents\/(\d+)/)![1]);
  }
}

/* ------------------------------------------------------------- new request form */

export class NewRequestForm {
  constructor(private readonly page: Page) {}

  itemBox(row = 0) {
    return this.page.getByRole("combobox", { name: "Item" }).nth(row);
  }

  toggleItemOptions(row = 0) {
    return this.page.getByRole("button", { name: "Toggle item options" }).nth(row);
  }

  quantity(row = 0) {
    return this.page.getByRole("spinbutton").nth(row);
  }

  get requiredDate() {
    return this.page.getByLabel("Required date");
  }

  /** Remarks has no accessible name — `Field` renders its caption as a plain span. */
  get remarks() {
    return this.page.getByPlaceholder("Optional");
  }

  /** Priority goes through the shared `Select`, which names itself "Select an option". */
  get priority() {
    return this.page.getByRole("combobox", { name: "Select an option" });
  }

  get deliveryLocation() {
    return this.page.getByRole("combobox", { name: /Office is assigned from your position|Tagged office/ });
  }

  /** Also unnamed; reachable only through its label's text. */
  get raisedAs() {
    return this.page.locator("label").filter({ hasText: "Raised as" }).locator("input").first();
  }

  get addLine() { return this.page.getByRole("button", { name: "Add line" }); }
  removeLine(row = 0) { return this.page.getByRole("button", { name: "Remove line" }).nth(row); }
  get create() { return this.page.getByRole("button", { name: "Create indent" }); }
  get saveChanges() { return this.page.getByRole("button", { name: "Save changes" }); }
  get cancel() { return this.page.getByRole("button", { name: "Cancel", exact: true }); }
  get chooseBom() { return this.page.getByRole("button", { name: "Choose BOM" }); }

  get listbox() { return this.page.getByRole("listbox"); }

  get requiredDateError() {
    return this.page.locator("#required-date-error");
  }

  duplicateError(row = 0) {
    return this.page.locator(`#indent-item-${row}-duplicate-error`);
  }

  missingQuantityError(row = 0) {
    return this.page.locator(`#indent-item-${row}-qty-error`);
  }

  get noMatchingItems() {
    return this.page.getByText("No matching items");
  }

  /** Opens the row's item list, optionally narrowed by a typed query. */
  async openItemOptions(row: number, query?: string) {
    const box = this.itemBox(row);
    await box.click();
    if (query !== undefined) await box.fill(query);
    await expect(this.listbox).toBeVisible({ timeout: 20_000 });
    return this.listbox;
  }

  async itemOptionLabels(row: number, query?: string): Promise<string[]> {
    await this.openItemOptions(row, query);
    return this.listbox.getByRole("option").allInnerTexts();
  }

  /** Picks a specific item by the label the catalogue gave it. */
  async pickItem(row: number, label: string) {
    await this.openItemOptions(row, label);
    await this.listbox.getByRole("option", { name: label, exact: true }).first().click();
    await expect(this.itemBox(row)).toHaveValue(label, { timeout: 10_000 });
  }

  async setPriority(label: "Normal" | "Urgent") {
    await this.priority.click();
    await this.page.getByRole("option", { name: label, exact: true }).first().click();
  }
}

/* ---------------------------------------------------------------------- detail */

export class IndentDetail {
  constructor(private readonly page: Page) {}

  get title() { return this.page.getByRole("heading", { level: 1 }).first(); }
  get statusBadge() { return this.page.locator("header, [data-slot='chip']").first(); }
  get submit() { return this.page.getByRole("button", { name: /submit for approval/i }); }
  get approve() { return this.page.getByRole("button", { name: /^Approve$/ }); }
  get reject() { return this.page.getByRole("button", { name: /^Reject$/ }); }
  get edit() { return this.page.getByRole("button", { name: "Edit Indent" }); }
  get deleteDraft() { return this.page.getByRole("button", { name: /Delete Draft/ }); }
  get unavailable() { return this.page.getByText("This indent is not available to your current account"); }

  /** The compact progress bar — the "status bar" on the indent screen. */
  get progress() { return this.page.getByTestId("compact-approval-progress"); }
  get progressGroup() { return this.page.getByRole("group", { name: "Compact indent progress" }); }

  /** Each step's accessible name is "<label>, <state>[: caption]". */
  async progressSteps(): Promise<{ label: string; state: string }[]> {
    const names = await this.progress.locator("li > span[aria-label]").evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("aria-label") ?? ""));
    return names.map((name) => {
      const [label, rest = ""] = name.split(",");
      return { label: label.trim(), state: rest.split(":")[0].trim() };
    });
  }

  journeyCard(indentNo: string) {
    return this.page.getByRole("button", { name: `View complete indent journey for ${indentNo}` });
  }

  lineItems() {
    return this.page.getByRole("grid", { name: "Line items" });
  }

  async lineMatrix(): Promise<string[][]> {
    return this.lineItems().locator("tbody tr").evaluateAll((rows) =>
      rows.map((row) => Array.from(row.querySelectorAll("td")).map((cell) => (cell.textContent ?? "").trim())));
  }

  /** One field from the detail description list, addressed by its caption. */
  field(label: string) {
    return this.page.getByText(label, { exact: true }).locator("xpath=following-sibling::dd[1]");
  }

  backLink(label: string | RegExp) {
    return this.page.getByRole("button", { name: label }).first();
  }
}

/** The browser's own `window.confirm`, which Delete Draft uses. */
export function answerNativeConfirm(page: Page, accept: boolean) {
  page.once("dialog", (dialog) => {
    void (accept ? dialog.accept() : dialog.dismiss());
  });
}

/* --------------------------------------------------------------------- journey */

export class JourneyScreen {
  constructor(private readonly page: Page) {}

  get title() { return this.page.getByRole("heading", { level: 1 }).first(); }
  get back() { return this.page.getByRole("button", { name: "Back to indent details" }); }
  get timeline() { return this.page.getByRole("list", { name: "Complete indent journey timeline" }); }
  get upcoming() { return this.page.getByRole("list", { name: "Remaining indent journey stages" }); }
  get historyHeading() { return this.page.getByRole("heading", { name: "Complete history" }); }
  get noEvents() { return this.page.getByText("No recorded journey events are available."); }
  get noHistory() { return this.page.getByText("No history has been recorded yet."); }

  /** Stage headings in the order the timeline renders them. */
  async timelineStages(): Promise<string[]> {
    return this.timeline.getByRole("heading", { level: 3 }).allInnerTexts();
  }

  async upcomingStages(): Promise<string[]> {
    if (!(await this.upcoming.isVisible().catch(() => false))) return [];
    return this.upcoming.getByRole("heading", { level: 3 }).allInnerTexts();
  }
}

/* ------------------------------------------------------------- acknowledgements */

export class Acknowledgements {
  static readonly INDENT_COLUMN = 0;

  readonly list: ListGrid;

  constructor(private readonly page: Page) {
    // This screen's empty content is an EmptyState block, not one sentence, and
    // its wording changes with whether a filter is on.
    this.list = new ListGrid(page, /Nothing on its way|Nothing matches/);
  }

  get search() { return this.page.getByRole("textbox", { name: "Search acknowledgements" }); }

  /**
   * The status filter.
   *
   * Addressed by its placeholder, not by the "Filter by status" the page asks
   * for: the shared `Select` reads an `ariaLabel` prop and this screen passes
   * `aria-label`, so the label it wants is dropped and the control ends up named
   * after its placeholder. Recorded as a finding by the scenario that uses this.
   */
  get statusSelect() { return this.page.getByRole("combobox", { name: "Any status" }); }

  get readyToConfirm() { return this.page.getByRole("button", { name: "Ready to confirm" }); }
  /** Both the desktop grid and the mobile card list render an empty state. */
  get emptyNothingOnItsWay() { return this.page.getByText("Nothing on its way").first(); }
  get emptyNothingMatches() { return this.page.getByText("Nothing matches").first(); }

  /**
   * Picks a status.
   *
   * The popover is closed afterwards on purpose. Choosing "Any status" leaves it
   * open — its option carries an empty key, so react-aria never sees a selection
   * change — and while an overlay is open HeroUI marks the rest of the page
   * `aria-hidden`, which makes the list underneath unreadable and every other
   * control unclickable. Escape here is what a person would have to do too.
   */
  async chooseStatus(label: string) {
    await this.statusSelect.click();
    const listbox = this.page.getByRole("listbox");
    await expect(listbox).toBeVisible({ timeout: 15_000 });
    await listbox.getByRole("option", { name: label, exact: true }).first().click();
    if (await listbox.isVisible().catch(() => false)) {
      await this.page.keyboard.press("Escape");
      await expect(listbox).toBeHidden({ timeout: 10_000 }).catch(() => undefined);
    }
    await settle(this.page);
  }

  /** Whether the status popover is still on screen — see `chooseStatus`. */
  async statusListboxIsOpen() {
    return this.page.getByRole("listbox").isVisible().catch(() => false);
  }

  async searchFor(text: string) {
    await this.search.fill(text);
    await settle(this.page);
  }

  async toggleReadyToConfirm() {
    await this.readyToConfirm.click();
    await settle(this.page);
  }

  /** The indent numbers on screen. The Indent cell stacks a date beneath each one. */
  async indentNos(): Promise<string[]> {
    const cells = await this.list.column(Acknowledgements.INDENT_COLUMN);
    return cells.map((cell) => cell.split("\n")[0].trim()).filter(Boolean);
  }

  rowFor(indentNo: string) {
    return this.list.rows.filter({ hasText: indentNo }).first();
  }

  /* --------------------------------------------------------------- the modal */

  get modal() { return this.page.getByRole("dialog"); }

  /**
   * The modal's title.
   *
   * `ConfirmModal` renders it through HeroUI's `ModalHeader`, which is a plain
   * container — the title is styled like a heading but is not one, so there is no
   * `heading` role to find and the dialog has no accessible name. Located by its
   * text, and reported as a finding by the scenario that uses it.
   */
  get modalTitle() { return this.modal.locator(".font-display").first(); }
  get confirmReceipt() { return this.modal.getByRole("button", { name: "I received these" }); }
  get closeOnly() { return this.modal.getByRole("button", { name: "Close", exact: true }); }
  get cancel() { return this.modal.getByRole("button", { name: "Cancel", exact: true }); }
  get addPhoto() { return this.modal.locator("input[type='file'][accept='image/*']"); }
  get addBill() { return this.modal.locator("input[type='file']:not([accept='image/*'])"); }
  get photoWarning() { return this.modal.getByText("Attach at least one photo before confirming."); }
  get quantityWarning() { return this.modal.getByText("Enter what you received on at least one line."); }
  get errorBanner() { return this.modal.locator(".text-bad, [role='alert']").first(); }

  arrivedNow(itemLabel: string) {
    return this.modal.getByRole("spinbutton", { name: `Received now for ${itemLabel}` });
  }

  attachmentRows() {
    return this.modal.locator("li").filter({ has: this.page.getByRole("button", { name: /^Remove / }) });
  }

  removeAttachment(fileName: string) {
    return this.modal.getByRole("button", { name: `Remove ${fileName}` });
  }

  /** The line table inside the modal, as raw cell text — the arithmetic under test. */
  async lineMatrix(): Promise<string[][]> {
    return this.modal.locator("table tbody tr").evaluateAll((rows) =>
      rows.map((row) => Array.from(row.querySelectorAll("td")).map((cell) => (cell.textContent ?? "").trim())));
  }

  async open(indentNo: string) {
    await this.rowFor(indentNo).click();
    await expect(this.modal).toBeVisible({ timeout: 15_000 });
  }

  async close() {
    if (await this.modal.isVisible().catch(() => false)) {
      await this.page.keyboard.press("Escape");
      await expect(this.modal).toBeHidden({ timeout: 10_000 }).catch(() => undefined);
    }
  }
}

/* ------------------------------------------------------------- activity ledger */

export class ActivityLedger {
  static readonly COLUMNS = ["WHEN", "REQUEST", "EVENT", "DETAILS", "QTY", "DEPARTMENT", "RESULT"] as const;
  static readonly REQUEST_COLUMN = 1;
  static readonly EVENT_COLUMN = 2;
  static readonly RESULT_COLUMN = 6;

  readonly filters: FilterBar;
  readonly list: ListGrid;

  constructor(private readonly page: Page) {
    // Activity ledger applies a date preset the moment it is chosen.
    this.filters = new FilterBar(page, { appliesPresetsImmediately: true });
    this.list = new ListGrid(page, "No activity matches active filters.");
  }

  get footer() { return this.page.getByTestId("activity-pagination-footer"); }
  get errorBanner() { return this.page.getByText("Unable to load activity ledger"); }
  get retry() { return this.page.getByRole("button", { name: "Retry" }); }

  indentNos() { return this.list.column(ActivityLedger.REQUEST_COLUMN); }
  events() { return this.list.column(ActivityLedger.EVENT_COLUMN); }

  async openRow(indentNo: string) {
    await this.list.rows.filter({ hasText: indentNo }).first().click();
    await this.page.waitForURL(/\/indents\/\d+(\?.*)?$/, { timeout: 30_000 });
    await settle(this.page);
    return Number(this.page.url().match(/\/indents\/(\d+)/)![1]);
  }
}

/* ----------------------------------------------------------- alerts & notifications */

export class Notifications {
  readonly filters: FilterBar;

  constructor(private readonly page: Page) {
    // Alert & Notification applies a date preset the moment it is chosen.
    this.filters = new FilterBar(page, { appliesPresetsImmediately: true });
  }

  get footer() { return this.page.getByTestId("notification-pagination-footer"); }
  get empty() { return this.page.getByText("No status notifications yet."); }
  get loading() { return this.page.getByText("Loading notifications…"); }

  /**
   * The notification rows.
   *
   * They are buttons in a card, with no list role and no accessible name of their
   * own — assistive technology gets the whole blob of text and nothing to navigate
   * by. Located here by the one thing that distinguishes them structurally: each
   * row puts its title in a `<strong>`, which no other button on the screen does.
   */
  rows() {
    return this.page.locator("button").filter({ has: this.page.locator("strong") });
  }

  /** Each row as `{ title, message }` — the pair the API also returns. */
  async entries(): Promise<{ title: string; message: string }[]> {
    const texts = await this.rows().allInnerTexts();
    return texts.map((text) => {
      const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
      return { title: lines[0] ?? "", message: lines[2] ?? lines[1] ?? "" };
    });
  }

  async openRow(index: number) {
    await this.rows().nth(index).click();
    await this.page.waitForURL(/\/indents\/\d+(\?.*)?$/, { timeout: 30_000 });
    await settle(this.page);
    return Number(this.page.url().match(/\/indents\/(\d+)/)![1]);
  }
}

/* ------------------------------------------------------------------------ misc */

export async function isShown(locator: Locator) {
  return (await locator.count()) > 0 && (await locator.first().isVisible().catch(() => false));
}
