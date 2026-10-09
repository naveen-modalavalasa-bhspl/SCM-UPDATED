import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/shared/api/client", () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

import { api } from "@/shared/api/client";
import { FulfillmentQueuePage } from "../pages/FulfillmentQueuePage";

const mockGet = api.get as unknown as ReturnType<typeof vi.fn>;

const INDENT = {
  id: 8,
  indent_no: "IND/2026-27/00008",
  requested_by_name: "Ravi Requester",
  department_name: "Mechanical",
  priority: "NORMAL",
  status: "AWAITING_ALLOCATION",
  total_items: 1,
  created_at: "2026-07-20T09:00:00Z",
};

/** The queue is `/api/indents` with `has_remainder` (owed) and no status — status is
 *  an optional narrowing, never what defines the list. */
const isQueueCall = (_url: string, cfg: any) => !!cfg?.params?.has_remainder;

beforeEach(() => {
  mockGet.mockReset();
  mockGet.mockImplementation((url: string, cfg: any) =>
    Promise.resolve({
      data: isQueueCall(url, cfg)
        ? { items: [INDENT], total: 1, page: 1, size: 100 }
        : { items: [], total: 0, page: 1, size: 100 },
    }),
  );
});

describe("FulfillmentQueuePage", () => {
  it("opens the allocation screen for the row, not the home page", async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={["/inventory/fulfillment"]}>
          <Routes>
            <Route path="/inventory/fulfillment" element={<FulfillmentQueuePage />} />
            <Route path="/inventory/allocate/:indentId" element={<div>ALLOCATION SCREEN</div>} />
            <Route path="/" element={<div>HOME</div>} />
            <Route path="*" element={<div>HOME</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getAllByText("IND/2026-27/00008").length).toBeGreaterThan(0), { timeout: 4000 });
    fireEvent.click(screen.getAllByText("IND/2026-27/00008")[0]);

    await waitFor(() => expect(screen.getByText("ALLOCATION SCREEN")).toBeInTheDocument());
    expect(screen.queryByText("HOME")).not.toBeInTheDocument();
  });

  it("hides an indent that already has an allocation awaiting approval", async () => {
    mockGet.mockImplementation((url: string, cfg: any) => {
      if (url === "/api/allocations") {
        return Promise.resolve({
          data: {
            items: [{ id: 91, indent_id: INDENT.id, status: "PENDING_APPROVAL" }],
            total: 1,
            page: 1,
            size: 100,
          },
        });
      }
      return Promise.resolve({
        data: isQueueCall(url, cfg)
          ? { items: [INDENT], total: 1, page: 1, size: 100 }
          : { items: [], total: 0, page: 1, size: 100 },
      });
    });

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={["/inventory/fulfillment"]}>
          <Routes>
            <Route path="/inventory/fulfillment" element={<FulfillmentQueuePage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith(
        "/api/allocations",
        expect.objectContaining({ params: expect.objectContaining({ status: "PENDING_APPROVAL" }) }),
      );
      expect(screen.queryByText(INDENT.indent_no)).not.toBeInTheDocument();
    });
  });
});
