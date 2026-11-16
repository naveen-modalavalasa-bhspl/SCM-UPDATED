import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/shared/api/client", () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn(),
  },
}));

const heldPermissions = new Set<string>();
vi.mock("@/shared/auth/AuthContext", () => ({
  useAuth: () => ({
    can: (code: string) => heldPermissions.has(code),
    me: null,
  }),
}));

// A new gate entry loads only the receiving-point list on mount; every other
// lookup fires on search. The real `myWarehouseOptions` would run through the
// mocked client and return nothing list-like, so it is stubbed, not the rest.
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    myWarehouseOptions: vi.fn().mockResolvedValue([]),
  };
});

import ReceiptForm from "../pages/ReceiptForm";

const openNewGateEntry = () => render(
  <QueryClientProvider client={new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })}>
    <MemoryRouter initialEntries={["/warehouse/material-inward/new"]}>
      <Routes>
        <Route path="*" element={<ReceiptForm mode="GATE_ENTRY" />} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>,
);

describe("ReceiptForm documents", () => {
  it("offers no attach button without the filing grant, and says who to ask", async () => {
    heldPermissions.clear();
    openNewGateEntry();
    // The form itself loads; only the filing affordance is gated.
    await waitFor(() => {
      expect(screen.getByText("Documents")).toBeInTheDocument();
    });
    expect(screen.queryByText("Attach a file")).not.toBeInTheDocument();
    expect(screen.getByText(/needs the receipt filing permission/)).toBeInTheDocument();
  });

  it("offers the attach button to a login holding receipt.create", async () => {
    heldPermissions.clear();
    heldPermissions.add("receipt.create");
    openNewGateEntry();
    await waitFor(() => {
      expect(screen.getByText("Attach a file")).toBeInTheDocument();
    });
    expect(screen.queryByText(/needs the receipt filing permission/)).not.toBeInTheDocument();
  });
});
