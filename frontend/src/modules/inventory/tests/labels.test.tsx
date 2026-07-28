import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/shared/api/client", () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

import { api } from "@/shared/api/client";
import { LabelsPage } from "../pages/LabelsPage";

const mockGet = api.get as unknown as ReturnType<typeof vi.fn>;

const STOCK = {
  id: 1, warehouse_id: 1, item_id: 7, item_code: "101010-0039",
  item_name: "4 Channel ISE MODULE Reagent Pack", uom_code: "ml",
  bin_id: 0, bin_code: "A-1", batch_id: 0, batch_no: "22-july-2026",
  project_id: 0, available_qty: 998, reserved_qty: 0, total_qty: 998,
};

beforeEach(() => {
  mockGet.mockReset();
  mockGet.mockImplementation((url: string) =>
    Promise.resolve({
      data: url.startsWith("/api/stock")
        ? { items: [STOCK], total: 1, page: 1, size: 200 }
        : { items: [], total: 0, page: 1, size: 200 },
    }),
  );
});

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/inventory/labels"]}>
        <LabelsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe("LabelsPage", () => {
  it("renders instead of bouncing to another screen", async () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "Labels & Printing" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("4 Channel ISE MODULE Reagent Pack")).toBeInTheDocument(),
    );
  });

  it("cannot print until a row is picked", async () => {
    renderPage();
    await waitFor(() => screen.getByText("4 Channel ISE MODULE Reagent Pack"));
    // The count in the label is what tells the user how many stickers come out.
    expect(screen.getByRole("button", { name: /Print label/ })).toBeDisabled();
  });
});
