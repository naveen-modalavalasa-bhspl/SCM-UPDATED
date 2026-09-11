import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IndentPrintPage } from "../pages/PrintPage";
import { indentApi } from "../api";
import type { Indent } from "../types";

vi.mock("@/shared/auth/AuthContext", () => ({
  useAuth: () => ({
    can: () => true,
    me: { employee: { id: 7, name: "A Anil Kumar" }, permissions: ["indent.view"] },
  }),
}));

vi.mock("../api", async () => {
  const React = await import("react");
  const scope = { employeeId: 7, activePositionId: 3 };
  const scoped = () => ["indents-module", scope.employeeId, scope.activePositionId] as const;
  return {
    INDENT_QUERY_STALE_TIME: 30_000,
    INDENT_QUERY_GC_TIME: 300_000,
    indentApi: { get: vi.fn(), journey: vi.fn(), company: vi.fn() },
    indentKeys: {
      detail: (_s: unknown, id: number) => [...scoped(), "detail", id] as const,
      company: () => [...scoped(), "company"] as const,
    },
    isIndentUnavailableError: (error: unknown) =>
      (error as { code?: string } | null)?.code === "INDENT_UNAVAILABLE",
    useIndentAccountScope: () => React.useMemo(() => scope, []),
  };
});

const INDENT: Indent = {
  id: 135,
  indent_no: "BHS/104/2026-27/IND0031",
  indent_type: "REGULAR",
  indent_date: "2026-08-01",
  required_date: "2026-08-10",
  requested_by_id: 7,
  requested_by_name: "A Anil Kumar",
  position_name: "STORE KEEPER LIP Chilamathur -phc-2",
  department_name: "104",
  office_name: "Chilamathur PHC",
  office_sac: "SAC-104",
  status: "CLOSED",
  priority: "NORMAL",
  total_items: 1,
  total_qty: 20,
  remarks: "Replacement for the failed unit.",
  is_bookmarked: "NO",
  can_submit: false,
  can_approve: false,
  can_reject: false,
  created_at: "2026-08-01T05:30:00Z",
  items: [{
    id: 1, item_id: 9, item_code: "303030-PRINTER-EPSON-EPSON-0001",
    item_name: "Epson Printer", uom_code: "uom-NOS", quantity: 20,
    approved_quantity: 20, ordered_quantity: 20, received_quantity: 20,
  }],
};

function renderPrintPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/indents/135/print"]}>
        <Routes>
          <Route path="/indents/:id/print" element={<IndentPrintPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(window, "print").mockImplementation(() => {});
  vi.mocked(indentApi.get).mockResolvedValue(INDENT);
  vi.mocked(indentApi.company).mockResolvedValue({});
});

describe("IndentPrintPage", () => {
  it("prints the letterhead, the particulars and the indent lines — and nothing else", async () => {
    renderPrintPage();

    // Letterhead: the settings row is empty here, so the registered particulars stand
    // rather than a blank header going out of the building.
    expect(await screen.findByText("Bavya Health Services Private Limited")).toBeInTheDocument();
    expect(screen.getByText(/U85120AP2008PTC058143/)).toBeInTheDocument();
    expect(screen.getByText(/Ramdev Apartments/)).toBeInTheDocument();

    expect(screen.getAllByText("BHS/104/2026-27/IND0031").length).toBeGreaterThan(0);
    expect(screen.getByText("Epson Printer")).toBeInTheDocument();
    expect(screen.getByText("303030-PRINTER-EPSON-EPSON-0001")).toBeInTheDocument();
    // displayUom strips the `uom-` prefix on the printed sheet too.
    expect(screen.getByText("NOS")).toBeInTheDocument();

    // The sheet is the requisition and nothing else: the approval trail, the document
    // history and the progress strip live on the journey screen, which stays live.
    expect(screen.queryByText(/Approval trail/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Document history/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Progress$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Currently with/i)).not.toBeInTheDocument();

    expect(screen.getByText("Replacement for the failed unit.")).toBeInTheDocument();
    expect(screen.getByText(/Printed by A Anil Kumar/)).toBeInTheDocument();

    await waitFor(() => expect(window.print).toHaveBeenCalled());
  });

  it("configured company settings win over the registered fallback", async () => {
    vi.mocked(indentApi.company).mockResolvedValue({
      legal_name: "Bavya Health Services Pvt Ltd (Unit II)",
      gstin: "06AADCB5486B1ZW",
    });
    renderPrintPage();

    expect(await screen.findByText("Bavya Health Services Pvt Ltd (Unit II)")).toBeInTheDocument();
    expect(screen.getAllByText(/06AADCB5486B1ZW/).length).toBeGreaterThan(0);
    // Untouched fields still fall back rather than printing blank.
    expect(screen.getByText(/U85120AP2008PTC058143/)).toBeInTheDocument();
  });

  it("prints nothing for an indent this account may not read", async () => {
    vi.mocked(indentApi.get).mockRejectedValue(
      Object.assign(new Error("Not available"), { code: "INDENT_UNAVAILABLE" }));
    renderPrintPage();

    expect(await screen.findByText(/not available to your account/i)).toBeInTheDocument();
    expect(screen.queryByText("Epson Printer")).not.toBeInTheDocument();
    expect(window.print).not.toHaveBeenCalled();
  });
});
