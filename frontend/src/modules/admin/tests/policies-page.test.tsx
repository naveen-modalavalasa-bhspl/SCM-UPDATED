import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/api/client", () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

import { api } from "@/shared/api/client";
import { PoliciesPage } from "../pages/PoliciesPage";

const mockGet = api.get as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockGet.mockReset();
  mockGet.mockImplementation((url: string) => {
    if (url === "/api/workflow/definitions/options") {
      return Promise.resolve({
        data: {
          doc_types: ["INDENT", "ALLOCATION", "MR"],
          approver_types: ["REPORTING_MANAGER", "DEPT_HEAD", "POSITION"],
          approval_modes: ["ANY_ONE"],
          operators: ["GTE"],
          positions: [{ id: 20, name: "Plant Head" }],
          roles: [],
          employees: [],
          default_flow: [],
        },
      });
    }
    if (url === "/api/workflow/definitions") {
      return Promise.resolve({ data: { items: [], total: 0 } });
    }
    if (url === "/api/rules/events") {
      return Promise.resolve({
        data: {
          items: [{
            code: "INDENT_APPROVED",
            name: "Indent approved",
            context_schema: { priority: "text", total_qty: "number" },
          }],
          operators: ["EQ", "GTE"],
          logics: ["AND"],
          action_types: ["ROUTE_FULFILLMENT"],
        },
      });
    }
    if (url === "/api/rules") {
      return Promise.resolve({
        data: { items: [], total: 0, page: 1, size: 100, pages: 0 },
      });
    }
    return Promise.reject(new Error(`Unexpected GET ${url}`));
  });
});

describe("PoliciesPage", () => {
  it("turns the technical builders into guided business questions", async () => {
    render(
      <QueryClientProvider client={new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })}>
        <PoliciesPage />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Approval & Automation")).toBeInTheDocument();
    expect(screen.getByText("Already protecting the flow")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Extra approval for large requests"));

    await waitFor(() => {
      expect(screen.getByText(
        "From what quantity should the Department Head approve?",
      )).toBeInTheDocument();
    });
    expect(screen.getByText("Who gives the senior approval?")).toBeInTheDocument();
    expect(screen.getByText("This is what will happen")).toBeInTheDocument();
  });

  it("offers a sentence-based automation exception builder", async () => {
    render(
      <QueryClientProvider client={new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })}>
        <PoliciesPage />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByText("Add exception"));
    await waitFor(() => {
      expect(screen.getByText("Add an automation exception")).toBeInTheDocument();
    });
    expect(screen.getByText("When this happens")).toBeInTheDocument();
    expect(screen.getByText("Only when")).toBeInTheDocument();
    expect(screen.getByText("Then do this")).toBeInTheDocument();
    expect(screen.getByText("In plain words")).toBeInTheDocument();
  });
});
