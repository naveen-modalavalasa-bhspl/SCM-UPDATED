import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { CycleLedger, DecisionLedger } from "../types";

/** The cycle payload is fetched by the component, so the module is mocked rather
 *  than the network: this test is about what the screen SAYS, not about axios. */
const cycleLedger = vi.fn();
vi.mock("../api", () => ({ approvalsApi: { cycleLedger: (...args: unknown[]) => cycleLedger(...args) } }));

/** `<Can>` reads the session; the roll-up must render for a login that holds
 *  nothing, with the gated action simply absent. */
vi.mock("@/shared/auth/AuthContext", () => ({ useAuth: () => ({ can: () => false }) }));

const { MonthlyCycleLedger } = await import("../components/MonthlyCycleLedger");

const ledger = {
  decision: {
    mode: "DECIDED", decision: "APPROVED", decision_label: "APPROVED",
    stage_name: "OE", decided_at: "2026-09-21T09:43:56", summary: "You approved all 48 requested units.",
  },
  indent: {
    id: 173, indent_no: "BHS/104/2026-27/IND0069", type: "Monthly/Consolidation",
    indent_type: "MONTHLY", status: "PENDING_APPROVAL", requester: "Rajesh",
  },
  consolidation: { is_consolidated: true, milestones: [], source_indents: [] },
  items: [], timeline: [], pending_now: [], legacy_gaps: [],
} as unknown as DecisionLedger;

const cycle: CycleLedger = {
  cycle: {
    key: "C8", consolidation_id: 8, consolidation_no: "BHS/104/2026-27/CON0004",
    consolidation_status: "OPEN", period: "2026-09", period_label: "September 2026",
    earliest_required_date: "2026-09-15", latest_required_date: "2026-09-30",
    project_name: "104-MMU",
  },
  anchor: { id: 173, indent_no: "BHS/104/2026-27/IND0069", requester: "Rajesh", status: "PENDING_APPROVAL" },
  scope: {
    full_trail: false, reached_me: 2, total_in_cycle: 11,
    outcome_label: "Approved at your stage",
    note: "2 of this cycle's 11 indents reached you. The rest are somebody else's decision and are not counted here.",
  },
  decision: {
    mode: "MIXED", signed_count: 1, waiting_count: 1,
    first_decided_at: "2026-09-21T09:43:56", last_decided_at: "2026-09-21T09:43:56",
    stage_names: ["OE"], summary: "You signed 1 of the 11 indents in this cycle, across 2 sites — 10 of 20 units approved, 10 cut.",
  },
  totals: {
    indents: 2, sites: 2, requesters: 2, items: 1, lines: 2,
    requested: 60, approved: 10, decided_requested: 20, waiting_quantity: 40,
    change: -10, reduced_lines: 1, excluded_lines: 0,
  },
  items: [{
    item_id: 5, item_code: "102020-ABS", item_name: "Absorbent Cotton 500 g", uom_code: "NOS",
    requested: 60, decided_requested: 20, approved: 10, waiting_quantity: 40, change: -10,
    request_count: 2, site_count: 2, decided_sites: 1, waiting_requests: 1,
    reduced_sites: 1, excluded_sites: 0,
    decision: "PARTIALLY_APPROVED",
    sites: [
      {
        line_id: 1, indent_id: 155, indent_no: "BHS/104/2026-27/IND0051",
        requester: "Narasimharaju", office_name: "Agali", requested: 40, approved: null,
        change: null, decision: "WAITING", is_excluded: false, indent_status: "PENDING_APPROVAL",
      },
      {
        line_id: 2, indent_id: 173, indent_no: "BHS/104/2026-27/IND0069",
        requester: "Rajesh", office_name: "K Basavanahalli", requested: 20, approved: 10,
        change: -10, decision: "PARTIALLY_APPROVED", is_excluded: false,
        reason: "Cut to the stock the main store is holding.",
        quantity_history: [{
          audit_id: 900, previous_quantity: 20, new_quantity: 10, delta: -10,
          reduction: 10, actor_name: "C Ramakrishna", stage_name: "OE",
          changed_at: "2026-09-21T09:43:56", reason: "Only 10 on the shelf",
          source: "sys_audit_log",
        }],
        indent_status: "PENDING_APPROVAL",
      },
    ],
  }],
  indents: [
    {
      id: 155, indent_no: "BHS/104/2026-27/IND0051", requester: "Narasimharaju",
      requested_by_id: 1, office_name: "Agali", status: "PENDING_APPROVAL",
      line_count: 1, requested: 40, approved: null, change: null, decision: "WAITING",
      action_id: null, is_anchor: false, on_my_desk: true,
    },
    {
      id: 173, indent_no: "BHS/104/2026-27/IND0069", requester: "Rajesh",
      requested_by_id: 2, office_name: "K Basavanahalli", status: "PENDING_APPROVAL",
      line_count: 1, requested: 20, approved: 10, change: -10,
      decision: "PARTIALLY_APPROVED", action_id: 1620, decided_at: "2026-09-21T09:43:56",
      stage_name: "OE", current_approver_name: "MAHENDRA Y",
      is_anchor: true, on_my_desk: false,
    },
  ],
};

/** The whole point of this screen is that it does not go anywhere, so the harness
 *  has to be able to say where it is. */
function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

const HERE = "/approvals/decisions/INDENT/173";

function draw() {
  cycleLedger.mockResolvedValue(cycle);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[HERE]}>
        <MonthlyCycleLedger ledger={ledger} />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const register = async () => {
  await screen.findByText("Absorbent Cotton 500 g");
  fireEvent.click(screen.getByRole("button", { name: /By indent/ }));
  return screen.findByRole("button", { name: /IND0069/ });
};

describe("MonthlyCycleLedger", () => {
  it("leads with the sentence the SERVER wrote, never one it composed", async () => {
    draw();
    expect(await screen.findByText(cycle.decision.summary)).toBeTruthy();
  });

  it("says out loud that it is counting less than the cycle holds", async () => {
    draw();
    expect(await screen.findByText(cycle.scope.note!)).toBeTruthy();
  });

  it("opens on the roll-up, because that is the view the month needs", async () => {
    draw();
    expect(await screen.findByText("Absorbent Cotton 500 g")).toBeTruthy();
    expect(screen.getByText(/2 indents, 2 sites/)).toBeTruthy();
  });

  it("never prints the whole ask against the approved figure", async () => {
    // 60 was requested across both sites but only 20 of it reached a decision.
    // Reading 60 -> 10 would report a 50-unit cut that nobody made.
    draw();
    await screen.findByText("Absorbent Cotton 500 g");
    const cut = screen.getAllByText("Cut").at(0)!.parentElement!;
    expect(cut.textContent).toContain("10");
    expect(screen.getAllByText("Still with you").at(0)!.parentElement!.textContent).toContain("40");
  });

  it("opens a row onto the sites that asked, with the one still pending marked", async () => {
    draw();
    const row = await screen.findByText("Absorbent Cotton 500 g");
    fireEvent.click(row);
    await waitFor(() => expect(screen.getByText("Narasimharaju")).toBeTruthy());
    expect(screen.getByText(/pending/)).toBeTruthy();
  });

  it("switches to the register of indents", async () => {
    draw();
    await screen.findByText("Absorbent Cotton 500 g");
    fireEvent.click(screen.getByRole("button", { name: /By indent/ }));
    await waitFor(() => expect(screen.getAllByText(/IND0051/).length).toBeGreaterThan(0));
  });

  it("opens an indent WHERE IT IS \u2014 the whole reason the link went away", async () => {
    // "Open ledger" went to /approvals/decisions/INDENT/<id>, which for a monthly
    // indent is THIS component again against a different anchor: the reader left
    // the month to read one member of it and arrived back at the month, having
    // lost their filter, their search and their place in the list.
    draw();
    const row = await register();
    expect(screen.queryByRole("button", { name: /Open ledger/ })).toBeNull();

    fireEvent.click(row);
    // The items that make up 20 -> 10, which is the one question the six-column
    // table could not answer and the only reason anybody pressed the link.
    await waitFor(() => expect(row.getAttribute("aria-expanded")).toBe("true"));
    const panel = within(document.getElementById("cycle-indent-173")!);
    expect(panel.getByText("Absorbent Cotton 500 g")).toBeTruthy();
    // The change column says it, and so does the audit folded in under the line.
    expect(panel.getAllByText("−10").length).toBeGreaterThan(0);
    // Why, in the approver's own words.
    expect(panel.getByText(/Cut to the stock the main store is holding/)).toBeTruthy();
    // And still on the page it started on.
    expect(screen.getByTestId("where").textContent).toBe(HERE);
  });

  it("closes the row it opened, so one document is on screen at a time", async () => {
    draw();
    const row = await register();
    fireEvent.click(row);
    await waitFor(() => expect(row.getAttribute("aria-expanded")).toBe("true"));
    fireEvent.click(row);
    await waitFor(() => expect(row.getAttribute("aria-expanded")).toBe("false"));
    expect(screen.queryByText(/Cut to the stock the main store is holding/)).toBeNull();
  });

  it("says where the document sits now without spending a column on it", async () => {
    draw();
    const row = await register();
    expect(row.textContent).toContain("MAHENDRA Y");
    // The one still on this approver's desk says so in their own words, not the
    // name of a stranger.
    const mine = await screen.findByRole("button", { name: /IND0051/ });
    expect(mine.textContent).toContain("with you");
  });

  it("crosses from an item's site line into the register, and opens it there", async () => {
    draw();
    fireEvent.click(await screen.findByText("Absorbent Cotton 500 g"));
    fireEvent.click(await screen.findByText("Narasimharaju"));
    const row = await screen.findByRole("button", { name: /IND0051/ });
    await waitFor(() => expect(row.getAttribute("aria-expanded")).toBe("true"));
    expect(screen.getByTestId("where").textContent).toBe(HERE);
  });

  it("an undecided line reads as unanswered, never as a decision to give nothing", async () => {
    draw();
    await register();
    const mine = await screen.findByRole("button", { name: /IND0051/ });
    expect(within(mine).getByText("pending")).toBeTruthy();
  });

  it("has no third tab, because a cycle is many indents and that one showed one", async () => {
    // "This indent" was the single document the reader happened to arrive on, drawn
    // a third time beside a roll-up that contains it and a register that lists it
    // with ten siblings. The URL had already answered the question it asked.
    draw();
    await screen.findByText("Absorbent Cotton 500 g");
    const tabs = screen.getByRole("group", { name: /How to read this cycle/ });
    expect(tabs.textContent).toContain("By item");
    expect(tabs.textContent).toContain("By indent");
    expect(tabs.textContent).not.toContain("This indent");
  });

  it("keeps the audit that tab carried, on the line it belongs to", async () => {
    // Dropping the tab must not drop the only route to "who moved this line, from
    // what to what, at which rung" — for a monthly indent there is no other page.
    draw();
    fireEvent.click(await register());
    const panel = within(document.getElementById("cycle-indent-173")!);
    const audit = await panel.findByText(/Who changed this \(1\)/);
    fireEvent.click(audit);
    await waitFor(() => expect(panel.getByText(/C Ramakrishna/)).toBeTruthy());
    expect(panel.getByText(/Only 10 on the shelf/)).toBeTruthy();
  });

  it("draws no audit at all on a line nobody changed", async () => {
    // Six rows each saying "no change to this line" is the text this panel exists
    // to not print.
    draw();
    fireEvent.click(await screen.findByRole("button", { name: /By indent/ }));
    fireEvent.click(await screen.findByRole("button", { name: /IND0051/ }));
    const panel = within(document.getElementById("cycle-indent-155")!);
    await waitFor(() => expect(panel.getByText("Absorbent Cotton 500 g")).toBeTruthy());
    expect(panel.queryByText(/Who changed this/)).toBeNull();
  });

  it("offers only the outcomes the cycle actually contains", async () => {
    draw();
    await screen.findByText("Absorbent Cotton 500 g");
    // One item, one outcome: a chip row that can only ever empty the screen is
    // not drawn at all.
    expect(screen.queryByRole("group", { name: "Outcome" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /By indent/ }));
    const outcomes = await screen.findByRole("group", { name: "Outcome" });
    expect(outcomes.textContent).toContain("Waiting");
    expect(outcomes.textContent).toContain("Partially approved");
    expect(outcomes.textContent).not.toContain("Denied");
  });
});
