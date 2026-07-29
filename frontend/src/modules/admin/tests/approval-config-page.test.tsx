import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/api/client", () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

import { api } from "@/shared/api/client";
import { ApprovalConfigPage } from "../pages/ApprovalConfigPage";

const mockGet = api.get as unknown as ReturnType<typeof vi.fn>;
const mockPost = api.post as unknown as ReturnType<typeof vi.fn>;

const rung = (level: number, name: string, enabled: boolean, holder: string) => ({
  sequence: level, name, position_role_id: level, is_enabled: enabled,
  holders: [{ id: level * 10, name: holder }], is_dead: false, conditions: [],
});

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockGet.mockImplementation((url: string) => {
    if (url === "/api/workflow/ladders/options") {
      return Promise.resolve({
        data: {
          projects: [{ id: 500, name: "104-MMU-AP-Pulicherla" }],
          doc_types: [
            { code: "INDENT", label: "Indent", module: "Indents" },
            { code: "GRN", label: "Goods Receipt", module: "Warehouse" },
          ],
          module_order: ["Indents", "Inventory", "Warehouse"],
        },
      });
    }
    if (url === "/api/workflow/ladders") {
      return Promise.resolve({
        data: {
          workflow_id: 7, version: 3, project_id: 500, doc_type: "INDENT",
          module: "Indents", is_new: false, in_flight: 20,
          rungs: [
            rung(1, "COO", true, "DVD Prasad"),
            rung(2, "SPH", true, "Naresh Babu Metta"),
            rung(3, "Regional Manager", true, "Shaik Ikbal Hussain"),
            rung(4, "District Manager", false, "V Suresh Kumar"),
            rung(5, "OE", false, "T Bethaiah"),
            rung(6, "MMU Pilot", false, "A Bala Raju"),
          ],
        },
      });
    }
    return Promise.reject(new Error(`Unexpected GET ${url}`));
  });
  mockPost.mockImplementation((url: string) => {
    if (url === "/api/workflow/ladders/preview") {
      return Promise.resolve({
        data: {
          from: { position_id: 606, position_name: "Pilot" },
          self_approved: false,
          chain: [
            { role_name: "Regional Manager", position_name: "RM",
              approver_names: ["Shaik Ikbal Hussain"] },
            { role_name: "SPH", position_name: "SPH",
              approver_names: ["Naresh Babu Metta"] },
            { role_name: "COO", position_name: "COO",
              approver_names: ["DVD Prasad"] },
          ],
        },
      });
    }
    return Promise.reject(new Error(`Unexpected POST ${url}`));
  });
});

const renderPage = () => render(
  <QueryClientProvider client={new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })}>
    <ApprovalConfigPage />
  </QueryClientProvider>,
);

describe("ApprovalConfigPage", () => {
  it("lists the ranks with their real holders, highest rank first", async () => {
    renderPage();

    await waitFor(() => expect(screen.getByText("COO")).toBeInTheDocument());
    expect(screen.getByText("DVD Prasad")).toBeInTheDocument();
    expect(screen.getByText("A Bala Raju")).toBeInTheDocument();
    expect(screen.getByText(/3 of 6 ranks on/)).toBeInTheDocument();
  });

  it("shows where a request would actually go", async () => {
    renderPage();

    await waitFor(() => expect(screen.getByText("It goes to")).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByText(/3 approvals/)).toBeInTheDocument());
    // Once beside its rank in the list, once in the resolved chain.
    expect(screen.getAllByText(/Shaik Ikbal Hussain/)).toHaveLength(2);
  });

  it("warns that a rank nobody holds will be skipped", async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === "/api/workflow/ladders/options") {
        return Promise.resolve({
          data: {
            projects: [{ id: 500, name: "104-MMU-AP-Pulicherla" }],
            doc_types: [{ code: "INDENT", label: "Indent", module: "Indents" }],
            module_order: ["Indents"],
          },
        });
      }
      return Promise.resolve({
        data: {
          workflow_id: 7, version: 1, project_id: 500, doc_type: "INDENT",
          module: "Indents", is_new: false, in_flight: 0,
          rungs: [{
            sequence: 1, name: "Regional Manager", position_role_id: 3,
            is_enabled: true, holders: [], is_dead: true, conditions: [],
          }],
        },
      });
    });

    renderPage();

    await waitFor(() => expect(
      screen.getByText(/Nobody holds this rank/)).toBeInTheDocument());
  });

  it("explains that an unsaved project starts from its own ranks", async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === "/api/workflow/ladders/options") {
        return Promise.resolve({
          data: {
            projects: [{ id: 500, name: "104-MMU-AP-Pulicherla" }],
            doc_types: [{ code: "INDENT", label: "Indent", module: "Indents" }],
            module_order: ["Indents"],
          },
        });
      }
      return Promise.resolve({
        data: {
          workflow_id: null, version: 0, project_id: 500, doc_type: "INDENT",
          module: "Indents", is_new: true, in_flight: 0,
          rungs: [rung(1, "COO", true, "DVD Prasad")],
        },
      });
    });

    renderPage();

    await waitFor(() => expect(
      screen.getByText(/New ladder for 104-MMU-AP-Pulicherla/)).toBeInTheDocument());
  });
});
