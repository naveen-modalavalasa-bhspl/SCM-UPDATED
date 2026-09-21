import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../api", () => ({
  returnsApi: { list: vi.fn() },
}));

import DecisionQueuePage from "../pages/DecisionQueuePage";
import { returnsApi } from "../api";

const list = returnsApi.list as unknown as ReturnType<typeof vi.fn>;

const row = (over: Record<string, unknown> = {}) => ({
  id: 8,
  return_no: "BHS/NA/2026-27/RET0008",
  status: "PENDING_APPROVAL",
  reason: "RECALL",
  reason_label: "Batch recall / Manufacturer recall",
  intent: "RETURN",
  intent_label: "Return only",
  from_warehouse_name: "AP-104-MMU-Phc Thullur - LIP",
  raised_by_name: "A.anusha",
  total_qty: "1",
  total_items: 1,
  value: "100",
  hazard_features: [],
  // A naive MySQL stamp, which is what the older rows on this document carry.
  created_at: "2026-09-08 11:04:00",
  ...over,
});

const mount = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/returns/decisions"]}>
        <DecisionQueuePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const lastQuery = () => list.mock.calls[list.mock.calls.length - 1][0];

/** A local calendar day `count` days back, as the filter writes it. */
const iso = (count: number) => {
  const day = new Date();
  day.setDate(day.getDate() - count);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
};

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue({ items: [row()], total: 1, page: 1, size: 20 });
});

/**
 * The decision desk's queue, and the two controls that narrow it.
 *
 * Both are pinned here because both were once wrong in a way nobody could see from the
 * screen: a term filtered in the browser silently searched one page of a backlog, and a
 * "Wants" column that read "Return only — no replacement" stated an outcome this
 * document cannot promise — the supplier decides replacement or credit on their own
 * note. The label is SERVED, so this test asserts the desk prints what the server sent
 * rather than composing one of its own.
 */
describe("DecisionQueuePage — the decision desk", () => {
  it("draws the served intent label, not a locally composed one", async () => {
    mount();
    expect(await screen.findByText("Return only")).toBeInTheDocument();
    expect(screen.queryByText(/no replacement/i)).not.toBeInTheDocument();
  });

  it("reads a naive timestamp as the branch's own wall clock", async () => {
    mount();
    // The 8th, spelled with its month: never the 7th (a naive stamp read as UTC lands
    // five and a half hours early) and never the ambiguous 9/8/2026. The exact order and
    // spelling of the parts is the reader's locale's business, so neither is asserted.
    // findAll, not find: `ResponsiveList` draws the table AND the narrow card, and hides
    // one of the two in CSS, so every value on a row is in the document twice.
    const stamps = await screen.findAllByText(
      /(0?8[^0-9]*Sep\w*[^0-9]*2026)|(Sep\w*[^0-9]*0?8,?[^0-9]*2026)/);
    expect(stamps.length).toBeGreaterThan(0);
  });

  it("searches on the SERVER — the term is a query parameter, not a local filter", async () => {
    mount();
    await screen.findByText("Return only");

    fireEvent.change(screen.getByLabelText("Search this queue"),
                     { target: { value: "RET0008" } });
    await waitFor(() => expect(lastQuery()).toMatchObject({
      queue: "decision", page: 1, search: "RET0008",
    }));
  });

  it("holds a half-typed term back until the typing stops", async () => {
    mount();
    await screen.findByText("Return only");
    const box = screen.getByLabelText("Search this queue");

    fireEvent.change(box, { target: { value: "RET" } });
    fireEvent.change(box, { target: { value: "RET00" } });
    fireEvent.change(box, { target: { value: "RET0008" } });

    await waitFor(() => expect(lastQuery()).toMatchObject({ search: "RET0008" }));
    // Only the settled term was ever asked for: the two keystrokes in between must not
    // each become a request that can resolve after the one that replaced it.
    expect(list.mock.calls.map((call) => call[0].search))
      .not.toContain("RET00");
  });

  it("names the date it filters, and reads back what it is holding", async () => {
    mount();
    await screen.findByText("Return only");

    // Closed, the pill says both halves: which date, and that it is not bounded yet.
    const pill = screen.getByRole("button", { name: /Raised: Any time/ });
    fireEvent.click(pill);
    fireEvent.click(screen.getByRole("button", { name: "Last 7 days" }));

    await waitFor(() => expect(lastQuery()).toMatchObject({ date_from: iso(6), date_to: iso(0) }));
    // And the preset is derived back OFF those two dates, never remembered separately —
    // so a range restored from anywhere else reads the same as one just pressed.
    expect(screen.getByRole("button", { name: /Raised: Last 7 days/ })).toBeInTheDocument();
  });

  it("bounds the raise date at both ends when the dates are typed in", async () => {
    mount();
    await screen.findByText("Return only");

    fireEvent.click(screen.getByRole("button", { name: /Raised: Any time/ }));
    // A range no preset can spell, and far enough back that none ever will — the
    // presets are all relative to today, so a range near it would read back as one.
    fireEvent.change(screen.getByLabelText("Raised from"),
                     { target: { value: "2025-03-04" } });
    fireEvent.change(screen.getByLabelText("Raised to"),
                     { target: { value: "2025-03-09" } });
    await waitFor(() => expect(lastQuery()).toMatchObject({
      date_from: "2025-03-04", date_to: "2025-03-09",
    }));
    // So the pill prints the range itself rather than a preset's name.
    expect(screen.getByRole("button", { name: /Raised: 04 Mar . 09 Mar/ })).toBeInTheDocument();
  });

  it("says a filtered-empty queue is filtered, not empty", async () => {
    mount();
    await screen.findByText("Return only");

    list.mockResolvedValue({ items: [], total: 0, page: 1, size: 20 });
    fireEvent.change(screen.getByLabelText("Search this queue"),
                     { target: { value: "zzz" } });

    // "Nothing waiting on you" here would send somebody hunting a configuration fault
    // that is really a search term.
    expect(await screen.findAllByText("Nothing matches those filters", undefined,
                                      { timeout: 3000 })).not.toHaveLength(0);
  });
});
