import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/api/client", () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

import { api } from "@/shared/api/client";
import { AllocationApprovalsPage } from "../pages/AllocationApprovalsPage";
import { AllocationApprovalDetailPage } from "../pages/AllocationApprovalDetailPage";

const mockGet = api.get as unknown as ReturnType<typeof vi.fn>;
const mockPost = api.post as unknown as ReturnType<typeof vi.fn>;

/** The row as the LIST returns it: totals included, so a queue screen never opens a
 *  row to add its quantities up. */
const listRow = {
  id: 3,
  allocation_no: "ALC/0003",
  indent_id: 12,
  indent_no: "IND/0012",
  status: "PENDING_APPROVAL",
  allocated_by_name: "Inventory Executive",
  current_approver_name: "Inventory Manager",
  approved_at: null,
  created_at: "2026-07-28T10:00:00Z",
  total_qty: 60,
  requested_total: 100,
};

const line = {
  id: 1,
  indent_item_id: 21,
  item_id: 5,
  item_code: "CEMENT",
  item_name: "Cement",
  uom_code: "BAG",
  requested_qty: 100,
  quantity: 60,
  warehouse_id: 1,
  warehouse_name: "Main Store",
};

/** What the approver may actually give right now: 80 free of 100 asked for, because
 *  another pending allocation has promised 20 out of the same point. */
const availability = [{
  id: 1,
  item_id: 5,
  item_code: "CEMENT",
  item_name: "Cement",
  uom_code: "BAG",
  warehouse_id: 1,
  warehouse_name: "Main Store",
  requested_qty: 100,
  quantity: 60,
  on_shelf: 100,
  pledged_elsewhere: 20,
  free: 80,
  max_allowed: 80,
}];

const wrap = (ui: React.ReactNode, path = "/") => (
  <QueryClientProvider client={new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })}>
    <MemoryRouter initialEntries={[path]}>
      {/* Routed, not bare: the detail page reads the allocation id out of the URL. */}
      <Routes>
        <Route path="/" element={ui} />
        <Route path="/inventory/allocation-approvals/:id" element={ui} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>
);

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockGet.mockImplementation((url: string) => {
    if (url === "/api/workflow/pending") {
      return Promise.resolve({
        data: {
          items: [{
            instance_id: 9, doc_type: "ALLOCATION", doc_id: 3, doc_no: "ALC/0003",
          }],
        },
      });
    }
    if (url === "/api/allocations") {
      return Promise.resolve({ data: { items: [listRow], total: 1, page: 1, size: 100 } });
    }
    if (url === "/api/allocations/approval-batches") {
      return Promise.resolve({ data: { items: [] } });
    }
    if (url === "/api/allocations/3") {
      return Promise.resolve({ data: { ...listRow, remarks: null, items: [line] } });
    }
    if (url === "/api/allocations/3/availability") {
      return Promise.resolve({ data: availability });
    }
    if (url === "/api/workflow/history/ALLOCATION/3") {
      return Promise.resolve({ data: { items: [] } });
    }
    return Promise.reject(new Error(`Unexpected GET ${url}`));
  });
  mockPost.mockResolvedValue({ data: { status: "APPROVED" } });
});

describe("AllocationApprovalsPage", () => {
  it("shows a row's totals without opening the allocation", async () => {
    render(wrap(<AllocationApprovalsPage />));

    await waitFor(() => expect(screen.getAllByText("ALC/0003").length).toBeGreaterThan(0));
    // getAllBy: ResponsiveList renders the table and the mobile cards together.
    expect(screen.getAllByText("60 approved to give").length).toBeGreaterThan(0);
    expect(screen.getAllByText("of 100 requested").length).toBeGreaterThan(0);
    // The point of the totals: no per-row detail request. This screen used to fire one
    // for every allocation on the page.
    expect(mockGet).not.toHaveBeenCalledWith("/api/allocations/3", expect.anything());
    expect(mockGet).not.toHaveBeenCalledWith("/api/allocations/3");
  });
});

describe("AllocationApprovalDetailPage", () => {
  it("quotes the live free stock and approves the approver's own quantity", async () => {
    render(wrap(<AllocationApprovalDetailPage />, "/inventory/allocation-approvals/3"));

    await waitFor(() => expect(screen.getByText("Review ALC/0003")).toBeInTheDocument());
    // Free now, not just what was decided: 100 on the shelf less 20 promised elsewhere.
    await waitFor(() => expect(screen.getByText("80 BAG")).toBeInTheDocument());

    const give = await screen.findByLabelText("Give quantity for Cement");
    fireEvent.change(give, { target: { value: "40" } });

    fireEvent.click(screen.getByText("Approve revised and reserve"));
    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith("/api/allocations/3/approve", {
        comments: "", revisions: [{ id: 1, quantity: 40 }],
      });
    });
  });

  it("sends no revision when the quantity is left alone", async () => {
    render(wrap(<AllocationApprovalDetailPage />, "/inventory/allocation-approvals/3"));

    await waitFor(() => expect(screen.getByText("Approve and reserve")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Approve and reserve"));
    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith("/api/allocations/3/approve", {
        comments: "", revisions: [],
      });
    });
  });

  it("is read-only for an allocation that is not waiting on this login", async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === "/api/workflow/pending") return Promise.resolve({ data: { items: [] } });
      if (url === "/api/allocations/3") {
        return Promise.resolve({
          data: {
            ...listRow, status: "APPROVED", current_approver_name: null,
            approved_at: "2026-07-28T12:00:00Z", remarks: null, items: [line],
          },
        });
      }
      if (url === "/api/allocations/3/availability") {
        return Promise.resolve({ data: availability });
      }
      if (url === "/api/workflow/history/ALLOCATION/3") {
        return Promise.resolve({ data: { items: [] } });
      }
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });

    render(wrap(<AllocationApprovalDetailPage />, "/inventory/allocation-approvals/3"));

    await waitFor(() => expect(screen.getByText("Review ALC/0003")).toBeInTheDocument());
    expect(screen.queryByLabelText("Give quantity for Cement")).not.toBeInTheDocument();
    expect(screen.queryByText("Approve and reserve")).not.toBeInTheDocument();
    expect(screen.queryByText("Reject")).not.toBeInTheDocument();
  });
});
