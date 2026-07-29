import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/api/client", () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

import { api } from "@/shared/api/client";
import { AllocationApprovalsPage } from "../pages/AllocationApprovalsPage";

const mockGet = api.get as unknown as ReturnType<typeof vi.fn>;
const mockPost = api.post as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockGet.mockImplementation((url: string) => {
    if (url === "/api/workflow/pending") {
      return Promise.resolve({
        data: {
          items: [{
            instance_id: 9,
            doc_type: "ALLOCATION",
            doc_id: 3,
            doc_no: "ALC/0003",
          }],
        },
      });
    }
    if (url === "/api/allocations/3") {
      return Promise.resolve({
        data: {
          id: 3,
          allocation_no: "ALC/0003",
          indent_id: 12,
          indent_no: "IND/0012",
          status: "PENDING_APPROVAL",
          allocated_by_name: "Inventory Executive",
          current_approver_name: "Inventory Manager",
          approved_at: null,
          created_at: "2026-07-28T10:00:00Z",
          items: [{
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
          }],
        },
      });
    }
    return Promise.reject(new Error(`Unexpected GET ${url}`));
  });
  mockPost.mockResolvedValue({ data: { status: "APPROVED" } });
});

describe("AllocationApprovalsPage", () => {
  it("shows only assigned allocations and approves the stock decision", async () => {
    render(
      <QueryClientProvider client={new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })}>
        <MemoryRouter><AllocationApprovalsPage /></MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getAllByText("ALC/0003").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText("ALC/0003")[0]);
    await waitFor(() => expect(screen.getByText("Approve and reserve")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Approve and reserve"));

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith("/api/allocations/3/approve", { comments: "" });
    });
  });
});
