import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  returnsApi: {
    raiser: vi.fn().mockResolvedValue({
      employee_id: 1,
      employee_code: "E-9963",
      employee_name: "Sai Teja",
      position_name: "Store Keeper",
      office_name: "AP-104-MMU-Chilamathur",
      from_warehouse_id: 3,
      from_warehouse_name: "LIP Chilamathur",
      to_warehouse_id: 9,
      to_warehouse_name: "MDP Hindupur",
      destination_note: null,
    }),
    reasons: vi.fn().mockResolvedValue([
      { value: "DAMAGED", label: "Damaged" },
      { value: "OTHER", label: "Other" },
    ]),
    myStock: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, size: 500 }),
    indents: vi.fn().mockResolvedValue({
      items: [{
        id: 55, indent_no: "IND-0055", indent_date: "2026-09-01", status: "APPROVED",
        total_items: 2, total_qty: "12", project_name: null, position_name: null,
      }],
      total: 1, page: 1, size: 200,
    }),
    approvalFlowFor: vi.fn().mockResolvedValue({
      steps: [], is_live: false, is_configured: true, indent_no: null,
      current_stage_message: null, note: null,
    }),
    get: vi.fn(),
    attachments: vi.fn().mockResolvedValue([]),
    upload: vi.fn(),
    removeAttachment: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    submit: vi.fn(),
  },
}));

import ReturnFormPage from "../pages/ReturnFormPage";
import { returnsApi } from "../api";

const mount = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/returns/new"]}>
        <ReturnFormPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

/**
 * The raise form's SHAPE, after the 2026-09-07 redraw: three numbered steps in the order
 * they must be answered, a locked step that says why it is locked rather than drawing
 * dead controls, and a rail that is populated from the first paint.
 *
 * Each of those was a defect once — the gate in the wrong column, a greyed-out form that
 * read as broken, a disabled Submit as the only validation feedback — so they are pinned
 * here rather than left to be re-litigated by the next person tidying the layout.
 */
describe("ReturnFormPage — the raise screen", () => {
  it("opens on the three numbered steps, in order, with nothing hollow", async () => {
    mount();
    expect(screen.getByText("New return")).toBeInTheDocument();

    // Step 1 is the gate, step 2 is what it gates, step 3 is the evidence.
    expect(screen.getByText("Details")).toBeInTheDocument();
    expect(screen.getByText("Line items & reasons")).toBeInTheDocument();
    expect(screen.getByText("Photos & documents")).toBeInTheDocument();
    expect(screen.getByText("Step 1:")).toBeInTheDocument();
    expect(screen.getByText("Step 2:")).toBeInTheDocument();
    expect(screen.getByText("Step 3:")).toBeInTheDocument();

    // The locked step SAYS why, instead of drawing dead controls.
    expect(
      screen.getByText(/Answer .Against indent. in step 1 first/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Quantity for line 1")).not.toBeInTheDocument();

    // The rail is populated from the first paint — nothing appears out of nowhere.
    expect(screen.getByText("Ready to submit")).toBeInTheDocument();
    expect(screen.getByText("After you submit")).toBeInTheDocument();
    expect(screen.getByText("4 to go")).toBeInTheDocument();
    expect(screen.getByText("Give every item a reason")).toBeInTheDocument();
    expect(screen.getByText("Add a photo of the stock")).toBeInTheDocument();

    // The identity strip, not five disabled boxes.
    await waitFor(() => expect(screen.getByText("Sai Teja")).toBeInTheDocument());
    expect(screen.getByText("Employee id E-9963")).toBeInTheDocument();
    expect(screen.getByText("LIP Chilamathur")).toBeInTheDocument();
    expect(screen.getByText("MDP Hindupur")).toBeInTheDocument();
    expect(
      screen.getByText("Filled in from your position — it cannot be edited here."),
    ).toBeInTheDocument();

    // The commit buttons keep their words and stay gated.
    expect(screen.getByText("Save draft")).toBeInTheDocument();
    expect(screen.getByText("Submit for approval").closest("button")).toBeDisabled();
  });

  it("unlocks step 2 once the indent question is answered", async () => {
    // Driven through the EDIT route rather than the dropdown: React Aria opens its
    // listbox on pointer events jsdom does not synthesise, and a saved draft with no
    // indent on it hydrates to the same "answered" state the dropdown produces.
    (returnsApi.get as any).mockResolvedValue({
      id: 7, reason: "DAMAGED", reason_note: null, intent: "RETURN", kind: "FIELD",
      indent_id: null, can_edit: true, items: [],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/returns/7/edit"]}>
          <Routes>
            <Route path="/returns/:id/edit" element={<ReturnFormPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getByLabelText("Quantity for line 1")).toBeInTheDocument());
    expect(
      screen.queryByText(/Answer .Against indent. in step 1 first/),
    ).not.toBeInTheDocument();
    // An empty shelf says so, in the step, rather than leaving a bare picker.
    expect(
      screen.getByText("There is no stock on your point to return."),
    ).toBeInTheDocument();
    // Only the indent question is ticked off: reasons are per ITEM now (SCM_0129), and a
    // draft with no items has nobody to give one to.
    expect(screen.getByText("3 to go")).toBeInTheDocument();
  });
});
