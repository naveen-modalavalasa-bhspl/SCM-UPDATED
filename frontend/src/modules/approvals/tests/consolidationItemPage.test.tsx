import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

/** The item page is where an approver decides AT THE INDENT: each row has its own
 *  quantity box and exclude button, "Remove from all items" takes an indent out of the
 *  whole cycle, and "Reduce %" gives every included indent the same share of its own
 *  ceiling. These drive the real page, so a button that does the wrong thing — or does
 *  nothing — fails here and not in front of an approver. */

const consolidation = vi.fn();
vi.mock("../api", () => ({
  approvalsApi: { consolidation: (...args: unknown[]) => consolidation(...args) },
}));

const { ConsolidationItemPage } = await import("../pages/ConsolidationItemPage");

const indent = (id: number, name: string) => ({
  id, indent_no: `IND-${id}`, status: "PENDING_APPROVAL", priority: "NORMAL",
  requested_by_name: name, line_count: 1, total_requested_quantity: 10,
});

const allocation = (indent_id: number, line_id: number, requested: number, extra = {}) => ({
  indent_id, indent_no: `IND-${indent_id}`, line_id,
  requested_quantity: requested, ceiling_quantity: requested, ...extra,
});

/** Item 7 is asked for by indents 1-3; indent 2 also asks for item 8, so it has a line
 *  somewhere other than the page being tested. Indent 3 was dropped by a lower rung. */
const batch = (cycle: string) => ({
  cycle,
  indents: [indent(1, "Asha Rao"), indent(2, "Bhaskar Rao"), indent(3, "Chitra Devi")],
  consolidated_items: [
    {
      item_id: 7, item_code: "MED-DOL", item_name: "Dolo 650", uom_code: "STRIP", uom_decimals: 0,
      total_requested_quantity: 25, total_ceiling_quantity: 15, indent_count: 3,
      allocations: [
        allocation(1, 71, 10),
        allocation(2, 72, 10),
        allocation(3, 73, 5, { is_excluded: true, excluded_by_name: "Lower Approver", ceiling_quantity: 0 }),
      ],
    },
    {
      item_id: 8, item_code: "GLV-01", item_name: "Gloves", uom_code: "PAIR", uom_decimals: 0,
      total_requested_quantity: 6, total_ceiling_quantity: 6, indent_count: 1,
      allocations: [allocation(2, 82, 6)],
    },
  ],
});

let counter = 0;
function renderItemPage() {
  // A cycle per test: the draft store keeps an in-memory snapshot per cycle key.
  const cycle = `2026-${String(++counter).padStart(2, "0")}-item`;
  consolidation.mockResolvedValue({ items: [batch(cycle)] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/approvals/consolidation/${cycle}/items/7`]}>
        <Routes>
          <Route path="approvals/consolidation/:cycle/items/:itemId" element={<ConsolidationItemPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return cycle;
}

const draftOf = (cycle: string) => JSON.parse(
  window.sessionStorage.getItem(`scm-erp:approvals:consolidation:draft:v2:${cycle}`) ?? "{}",
);

/** Under Vitest CSS is off, so the desktop table AND the phone cards are both in the
 *  DOM and every control appears twice. A browser shows one of them; the tests drive the
 *  table. */
const tableOf = async () => within(await screen.findByRole("table"));

/** The table row for an indent. */
const rowOf = (indentNo: string) => {
  const cell = screen.getAllByText(indentNo).find((el) => el.closest("tr"));
  return within(cell!.closest("tr") as HTMLElement);
};

/** Exclude opens a dialog now (SCM_0153): all of the line, or part of it. */
async function excludeAll(indentNo: string) {
  fireEvent.click(rowOf(indentNo).getByRole("button", { name: /^Exclude$/ }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: /^Exclude all$/ }));
}

describe("ConsolidationItemPage", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    consolidation.mockReset();
  });

  it("decides at the indent: a quantity box on every row, and neither item-level section", async () => {
    renderItemPage();
    const table = await tableOf();
    await table.findByLabelText("Quantity for IND-1");

    expect(table.getByLabelText("Quantity for IND-2")).toBeTruthy();
    // The two sections this replaced.
    expect(screen.queryByText(/Approve \(total\)/i)).toBeNull();
    expect(screen.queryByText(/Leave an indent out/i)).toBeNull();
  });

  it("changes only the row that was typed in", async () => {
    const cycle = renderItemPage();
    const table = await tableOf();
    const box = await table.findByLabelText("Quantity for IND-2");

    fireEvent.change(box, { target: { value: "4" } });

    expect(draftOf(cycle)).toEqual({ 72: { approved: "4", excluded: false } });
    // 10 (IND-1) + 4 (IND-2); IND-3 was dropped below and carries nothing.
    await waitFor(() => expect(screen.getByText(/going out of/).textContent).toContain("14"));
  });

  it("excludes only PART of a row, with a reason (SCM_0153)", async () => {
    const cycle = renderItemPage();
    const table = await tableOf();
    await table.findByLabelText("Quantity for IND-2");

    fireEvent.click(rowOf("IND-2").getByRole("button", { name: /^Exclude$/ }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(dialog.getByRole("radio", { name: /Only part of it/ }));
    // All of it is not "part": the dialog says so and will not confirm.
    fireEvent.change(dialog.getByLabelText("Quantity to exclude"), { target: { value: "10" } });
    expect(dialog.getByText(/That is all of it/)).toBeTruthy();
    expect((dialog.getByRole("button", { name: /^Exclude part$/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(dialog.getByLabelText("Quantity to exclude"), { target: { value: "4" } });
    expect(dialog.getByText(/still goes to IND-2/).textContent).toContain("6");
    fireEvent.change(dialog.getByPlaceholderText(/Old stock/), { target: { value: "Branch has stock" } });
    fireEvent.click(dialog.getByRole("button", { name: /^Exclude part$/ }));

    expect(draftOf(cycle)).toEqual({
      72: { approved: "6", excluded: false, partial: true, reason: "Branch has stock" },
    });
    // The row keeps its box at what is left and says what was taken out, and why.
    expect(rowOf("IND-2").getByText(/4 excluded · Branch has stock/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/going out of/).textContent).toContain("16"));
  });

  it("excludes one row, then offers to remove the indent from all items", async () => {
    const cycle = renderItemPage();
    const table = await tableOf();
    await table.findByLabelText("Quantity for IND-2");

    await excludeAll("IND-2");

    expect(draftOf(cycle)).toEqual({ 72: { approved: "", excluded: true } });
    // The same slot now offers the wider action, plus a way back.
    const row = rowOf("IND-2");
    expect(row.getByRole("button", { name: /Remove from all items/ })).toBeTruthy();
    expect(row.getByRole("button", { name: /^Include$/ })).toBeTruthy();
    expect(row.queryByRole("button", { name: /^Exclude$/ })).toBeNull();
  });

  it("removes an indent from every item once confirmed, and restores it again", async () => {
    const cycle = renderItemPage();
    const table = await tableOf();
    await table.findByLabelText("Quantity for IND-2");
    await excludeAll("IND-2");

    fireEvent.click(rowOf("IND-2").getByRole("button", { name: /Remove from all items/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Remove IND-2 from all items\?/)).toBeTruthy();
    // Said plainly: held back, not rejected.
    expect(within(dialog).getByText(/not rejected/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /Remove from all items/ }));

    // BOTH of IND-2's lines — this item's and the other item's — are out.
    await waitFor(() => expect(draftOf(cycle)).toEqual({
      72: { approved: "", excluded: true },
      82: { approved: "", excluded: true },
    }));
    expect(rowOf("IND-2").getByText(/Removed from all items/)).toBeTruthy();

    fireEvent.click(rowOf("IND-2").getByRole("button", { name: /Include again/ }));
    expect(draftOf(cycle)).toEqual({});
    expect(rowOf("IND-2").getByRole("button", { name: /^Exclude$/ })).toBeTruthy();
  });

  it("undoes a single exclusion without touching the indent's other items", async () => {
    const cycle = renderItemPage();
    const table = await tableOf();
    await table.findByLabelText("Quantity for IND-2");
    await excludeAll("IND-2");

    fireEvent.click(rowOf("IND-2").getByRole("button", { name: /^Include$/ }));

    expect(draftOf(cycle)).toEqual({});
    expect(rowOf("IND-2").getByLabelText("Quantity for IND-2")).toBeTruthy();
  });

  it("moves a row dropped by a lower approver out of the table (SCM_0151)", async () => {
    renderItemPage();
    const table = await tableOf();
    await table.findByLabelText("Quantity for IND-1");

    // Not a row with a 0 in it any more: no box, no button, not in the table at all…
    expect(table.queryByText("IND-3")).toBeNull();
    expect(screen.queryByLabelText("Quantity for IND-3")).toBeNull();
    // …but named, read-only, in the "Excluded earlier" strip with who took it out.
    expect(screen.getByText(/Excluded earlier · 1/)).toBeTruthy();
    expect(screen.getByText(/by Lower Approver/)).toBeTruthy();
  });

  it("reduces every included indent by the same percentage of its own ceiling", async () => {
    const cycle = renderItemPage();
    const table = await tableOf();
    await table.findByLabelText("Quantity for IND-1");

    fireEvent.click(screen.getByRole("button", { name: /Reduce %/ }));
    const dialog = await screen.findByRole("dialog");
    // Nothing typed yet: Apply is not offered.
    expect((within(dialog).getByRole("button", { name: /Apply/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText("Percentage"), { target: { value: "50" } });
    // Two indents are still in (the third was dropped below): 10 + 10 -> 5 + 5.
    expect(within(dialog).getByText(/2 indents/).textContent).toContain("20");
    expect(within(dialog).getByText(/2 indents/).textContent).toContain("10");
    fireEvent.click(within(dialog).getByRole("button", { name: /Apply/ }));

    await waitFor(() => expect(draftOf(cycle)).toEqual({
      71: { approved: "5", excluded: false },
      72: { approved: "5", excluded: false },
    }));
    // Each box still edits on its own afterwards.
    expect((within(screen.getByRole("table")).getByLabelText("Quantity for IND-1") as HTMLInputElement).value).toBe("5");
  });

  it("does not reduce an indent that has been excluded, nor the other items", async () => {
    const cycle = renderItemPage();
    const table = await tableOf();
    await table.findByLabelText("Quantity for IND-2");
    await excludeAll("IND-2");

    fireEvent.click(screen.getByRole("button", { name: /Reduce %/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Percentage"), { target: { value: "80" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Apply/ }));

    await waitFor(() => expect(draftOf(cycle)[71]).toEqual({ approved: "8", excluded: false }));
    // IND-2 stays excluded with nothing typed; item 8's line (82) is untouched.
    expect(draftOf(cycle)[72]).toEqual({ approved: "", excluded: true });
    expect(draftOf(cycle)[82]).toBeUndefined();
  });
});
