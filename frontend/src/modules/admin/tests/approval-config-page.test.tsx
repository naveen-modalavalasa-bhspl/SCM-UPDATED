import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/api/client", () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

import { api } from "@/shared/api/client";
import { ApprovalConfigPage } from "../pages/ApprovalConfigPage";

const mockGet = api.get as unknown as ReturnType<typeof vi.fn>;
const mockPost = api.post as unknown as ReturnType<typeof vi.fn>;

// A rung carries the toggle and the counts; the holders' names come from the separate,
// project-keyed ranks read, and the positions only when a rung is opened.
// selected_position_ids null is the server's default: the rung is the whole rank, and
// the climb may pass through any post at it.
const rung = (level: number, name: string, enabled: boolean, dead = false) => ({
  sequence: level, name, position_role_id: level, is_enabled: enabled,
  position_count: 4, holder_count: dead ? 0 : 1, selected_position_ids: null,
  is_dead: dead, conditions: [],
});
const rank = (level: number, name: string, holder: string) => ({
  role_id: level, role_name: name, depth: level, position_count: 4,
  holders: [{ id: level * 10, name: holder }], holder_count: 1,
});

const RANKS = [
  rank(1, "COO", "DVD Prasad"),
  rank(2, "SPH", "Naresh Babu Metta"),
  rank(3, "Regional Manager", "Shaik Ikbal Hussain"),
  rank(4, "District Manager", "V Suresh Kumar"),
  rank(5, "OE", "T Bethaiah"),
  rank(6, "MMU Pilot", "A Bala Raju"),
];

const OPTIONS = {
  projects: [{ id: 500, name: "104-MMU-AP-Pulicherla" }],
  doc_types: [
    { code: "INDENT", label: "Indent", module: "Indents" },
    { code: "GRN", label: "Goods Receipt", module: "Warehouse" },
  ],
  module_order: ["Indents", "Inventory", "Warehouse"],
};

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockGet.mockImplementation((url: string) => {
    if (url === "/api/workflow/ladders/options") {
      return Promise.resolve({ data: OPTIONS });
    }
    if (url === "/api/workflow/ladders/ranks") {
      return Promise.resolve({ data: { ranks: RANKS } });
    }
    if (url === "/api/workflow/ladders") {
      return Promise.resolve({
        data: {
          workflow_id: 7, version: 3, project_id: 500, doc_type: "INDENT",
          module: "Indents", is_new: false, in_flight: 20,
          rungs: [
            rung(1, "COO", true),
            rung(2, "SPH", true),
            rung(3, "Regional Manager", true),
            rung(4, "District Manager", false),
            rung(5, "OE", false),
            rung(6, "MMU Pilot", false),
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

// Wrapped in a router: the screen links out to the hand-built ladder screen.
const renderPage = () => render(
  <QueryClientProvider client={new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })}>
    <MemoryRouter>
      <ApprovalConfigPage />
    </MemoryRouter>
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
        return Promise.resolve({ data: OPTIONS });
      }
      if (url === "/api/workflow/ladders/ranks") {
        return Promise.resolve({
          data: {
            ranks: [{ role_id: 3, role_name: "Regional Manager", depth: 3,
                      position_count: 4, holders: [], holder_count: 0 }],
          },
        });
      }
      return Promise.resolve({
        data: {
          workflow_id: 7, version: 1, project_id: 500, doc_type: "INDENT",
          module: "Indents", is_new: false, in_flight: 0,
          rungs: [rung(3, "Regional Manager", true, true)],
        },
      });
    });

    renderPage();

    await waitFor(() => expect(
      screen.getByText(/Nobody holds this rank/)).toBeInTheDocument());
  });

  it("loads a rank's positions only when that rung is opened", async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === "/api/workflow/ladders/options") {
        return Promise.resolve({ data: OPTIONS });
      }
      if (url === "/api/workflow/ladders/ranks") {
        return Promise.resolve({ data: { ranks: RANKS } });
      }
      if (url === "/api/workflow/ladders/rank-positions") {
        return Promise.resolve({
          data: {
            positions: [{ id: 603, name: "RM Kadapa", department_id: 9,
                          department_name: "Operations", holders: [] }],
          },
        });
      }
      return Promise.resolve({
        data: {
          workflow_id: 7, version: 1, project_id: 500, doc_type: "INDENT",
          module: "Indents", is_new: false, in_flight: 0,
          rungs: [rung(3, "Regional Manager", true)],
        },
      });
    });

    renderPage();
    await waitFor(() => expect(screen.getByText("Regional Manager")).toBeInTheDocument());
    const positionCalls = () => mockGet.mock.calls
      .filter(([url]) => url === "/api/workflow/ladders/rank-positions");
    expect(positionCalls()).toHaveLength(0);

    fireEvent.click(screen.getByText(/All 4 positions/));

    await waitFor(() => expect(screen.getByText("RM Kadapa")).toBeInTheDocument());
    expect(positionCalls()[0][1].params).toMatchObject({ role_id: 3, project_id: 500 });
  });

  it("leaves a rung on the whole rank until a position is ticked", async () => {
    // The rung must not arrive pre-narrowed: the reporting line a request climbs runs
    // through posts this project's own people do not hold, and a pinned rung drops
    // them silently while still showing as switched on.
    mockGet.mockImplementation((url: string) => {
      if (url === "/api/workflow/ladders/options") {
        return Promise.resolve({ data: OPTIONS });
      }
      if (url === "/api/workflow/ladders/ranks") {
        return Promise.resolve({ data: { ranks: RANKS } });
      }
      if (url === "/api/workflow/ladders/rank-positions") {
        return Promise.resolve({
          data: {
            positions: [{ id: 603, name: "RM Kadapa", department_id: 9,
                          department_name: "Operations", holders: [] }],
          },
        });
      }
      return Promise.resolve({
        data: {
          workflow_id: 7, version: 1, project_id: 500, doc_type: "INDENT",
          module: "Indents", is_new: false, in_flight: 0,
          rungs: [rung(3, "Regional Manager", true)],
        },
      });
    });

    renderPage();
    await waitFor(() => expect(screen.getByText(/All 4 positions/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/All 4 positions/));
    await waitFor(() => expect(screen.getByText("RM Kadapa")).toBeInTheDocument());

    const post = screen.getByRole("checkbox", { name: /RM Kadapa/ });
    fireEvent.click(post);
    await waitFor(() =>
      expect(screen.getByText(/1 of 4 positions/)).toBeInTheDocument());

    // Clearing the last tick hands the rung back to the rank, never leaves it empty.
    fireEvent.click(post);
    await waitFor(() =>
      expect(screen.getByText(/All 4 positions/)).toBeInTheDocument());
  });

  it("explains that an unsaved project starts from its own ranks", async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === "/api/workflow/ladders/options") {
        return Promise.resolve({ data: OPTIONS });
      }
      if (url === "/api/workflow/ladders/ranks") {
        return Promise.resolve({ data: { ranks: RANKS } });
      }
      return Promise.resolve({
        data: {
          workflow_id: null, version: 0, project_id: 500, doc_type: "INDENT",
          module: "Indents", is_new: true, in_flight: 0,
          rungs: [rung(1, "COO", true)],
        },
      });
    });

    renderPage();

    await waitFor(() => expect(
      screen.getByText(/New ladder for 104-MMU-AP-Pulicherla/)).toBeInTheDocument());
  });
});
