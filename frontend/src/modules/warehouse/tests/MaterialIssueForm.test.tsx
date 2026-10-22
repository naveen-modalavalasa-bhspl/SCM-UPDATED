import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/shared/api/client", () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

const heldPermissions = new Set<string>(["issue.view", "issue.create"]);
vi.mock("@/shared/auth/AuthContext", () => ({
  useAuth: () => ({ can: (code: string) => heldPermissions.has(code) }),
}));

// Mock the API calls for the warehouse module
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    occupancyPreview: vi.fn().mockResolvedValue([
      {
        location_id: 10,
        location_code: "BIN-1",
        location_name: "BIN-1",
        capacity_volume: 500,
        occupied_volume: 100,
        free_volume: 400,
        direction: "OUT",
        move_volume: 10,
        headline: "BIN-1 frees up 10 m³",
        unmeasured_lines: 0,
        // The four gates the meter draws. A cube-only payload is not what the server
        // sends, and a fixture that pretends otherwise stops testing the real screen.
        gates: [{
          key: "VOLUME", label: "Cube", unit: "m³", status: "OK",
          capacity: 500, occupied: 450, projected: 470, free: 30, over_by: 0, pct: 94,
          detail: "30 m³ of 500 m³ free after this.", note: null,
        }],
        lines: [],
      }
    ]),
    getIssue: vi.fn().mockResolvedValue({
      id: 1,
      issue_no: "ISS/001",
      warehouse_id: 1,
      status: "DRAFT",
      // One ask served out of TWO bays — the shape the flat grid could not express.
      // Both lines carry the same indent line, which is what makes them two picks of
      // one ask rather than two unrelated rows.
      items: [
        {
          id: 101, item_id: 1, indent_item_id: 55, bin_id: 10, batch_id: 11,
          item_code: "303010-MONITOR-HP-HP-0001", item_name: "All-in-One Monitor",
          bin_code: "F1-A1-R1-B1", batch_no: "AUG-26",
          requested_qty: 5, issued_qty: 5, rate: 0,
          tracking_type: "ASSET", unit_mode: "CODE", has_units: true,
          serial_numbers: ["AST-MON-2026-001"], unit_keys: ["AST-MON-2026-001"],
        },
        {
          id: 102, item_id: 1, indent_item_id: 55, bin_id: 20, batch_id: 12,
          item_code: "303010-MONITOR-HP-HP-0001", item_name: "All-in-One Monitor",
          bin_code: "F1-A2-R3-B2", batch_no: "SEP-26",
          requested_qty: 10, issued_qty: 10, rate: 0,
          tracking_type: "ASSET", unit_mode: "CODE", has_units: true,
          serial_numbers: [], unit_keys: [],
        },
      ],
    }),
    issueApprovalHistory: vi.fn().mockResolvedValue([]),
    warehouseOptions: vi.fn().mockResolvedValue([{ id: 1, name: "Main Store", is_bin_managed: true }]),
    trackingTypes: vi.fn().mockResolvedValue([
      { code: "ASSET", label: "Asset tag", unit: "asset tag",
        hint: "Scan the asset tag stamped on the unit at putaway." },
    ]),
    // What the POINT holds, which is what an issue picks from — not the whole item
    // master. The point stocks one of the two vacutainers; the other is in the
    // catalogue and nowhere on this floor.
    itemOptions: vi.fn().mockImplementation(
      (_search?: string, _wh?: number, inStock?: boolean) => Promise.resolve(
        inStock
          ? [{ id: 1, code: "303010-MONITOR-HP-HP-0001", name: "All-in-One Monitor",
               is_batch_tracked: true, on_hand: 15, batch_count: 2,
               location_count: 2 }]
          : [{ id: 1, code: "303010-MONITOR-HP-HP-0001", name: "All-in-One Monitor",
               is_batch_tracked: true, on_hand: 15, batch_count: 2,
               location_count: 2 },
             { id: 2, code: "101010-VAC-CIT-VACUTAINER-BD-0001",
               name: "Sodium Citrate Vacutainer", is_batch_tracked: true,
               on_hand: 0, batch_count: 0, location_count: 0 }],
      ),
    ),
    // The live probe behind the "N codes here" line on each pick. Both picks can name
    // every unit they take, so nothing on this document is short of identifiers.
    issueUnitSupply: vi.fn().mockResolvedValue([
      { item_id: 1, batch_id: 11, bin_id: 10, need: 5, has_units: true, available: 6 },
      { item_id: 1, batch_id: 12, bin_id: 20, need: 10, has_units: true, available: 11 },
    ]),
    // One bay holding more units than a page. Each page carries its OWN codes, so a
    // test that reads page 2 can only pass if the request actually asked for page 2.
    listSerials: vi.fn().mockImplementation(({ page = 1, size = 100 }: any) => {
      const total = 450;
      const start = (page - 1) * size;
      return Promise.resolve({
        items: Array.from(
          { length: Math.max(0, Math.min(size, total - start)) },
          (_unused, offset) => {
            const n = start + offset + 1;
            return {
              id: n, item_id: 1, serial_number: `SN-${n}`, imei: null,
              asset_code: `AST-${n}`, consumable_code: null,
              batch_id: 11, batch_no: "AUG-26", bin_id: 10, bin_code: "F1-A1-R1-B1",
            };
          },
        ),
        total, page, size,
      });
    }),
    issueStockSources: vi.fn().mockResolvedValue([
      {
        item_id: 1, bin_id: 10, bin_code: "F1-A1-R1-B1",
        bin_path: "F1 / F1-A1 / F1-A1-R1 / F1-A1-R1-B1",
        batch_id: 11, batch_no: "AUG-26",
        available_qty: 0, reserved_qty: 5, own_reserved_qty: 5,
        total_qty: 5, drawable_qty: 5,
        batch_total_qty: 5, batch_available_qty: 0,
        item_total_qty: 15, item_available_qty: 0,
      },
      {
        item_id: 1, bin_id: 20, bin_code: "F1-A2-R3-B2",
        bin_path: "F1 / F1-A2 / F1-A2-R3 / F1-A2-R3-B2",
        batch_id: 12, batch_no: "SEP-26",
        available_qty: 0, reserved_qty: 10, own_reserved_qty: 10,
        total_qty: 10, drawable_qty: 10,
        batch_total_qty: 10, batch_available_qty: 0,
        item_total_qty: 15, item_available_qty: 0,
      },
    ]),
    // Spied on, not left to the real implementation: the save-then-submit test
    // below asserts the ORDER these two are called in, which the real `put`/`post`
    // helpers can't give us without a live `api.put`.
    updateIssue: vi.fn().mockResolvedValue({ id: 1, issue_no: "ISS/001", status: "DRAFT" }),
    submitIssue: vi.fn().mockResolvedValue({ id: 1, issue_no: "ISS/001", status: "PENDING_APPROVAL" }),
  };
});

import MaterialIssueForm from "../pages/MaterialIssueForm";
import { updateIssue, submitIssue } from "../api";

const wrap = (ui: React.ReactNode, path = "/") => (
  <QueryClientProvider client={new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })}>
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={ui} />
        <Route path="/warehouse/material-issues/:id" element={ui} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>
);

const open = () => render(wrap(<MaterialIssueForm />, "/warehouse/material-issues/1"));

describe("MaterialIssueForm", () => {
  it("renders the calculation breakdown for an issue with items", async () => {
    open();
    await waitFor(() => {
      expect(screen.getByText("Calculation breakdown")).toBeInTheDocument();
    });
  });

  it("names the kind of identifier the item is tracked by, from the served catalogue", async () => {
    open();
    // "Asset tag" rather than an undifferentiated column of codes. The word comes
    // from the backend's TRACKING_META, never from the screen.
    await waitFor(() => {
      expect(screen.getAllByText("Asset tag").length).toBeGreaterThan(0);
    });
  });

  it("reads two lines against one indent line as one ask over two locations", async () => {
    open();
    // ONE row for the item, with both bays inside it — and one set of column
    // headings for the whole document, not one per item.
    await waitFor(() => {
      expect(screen.getAllByText("Item & what it is owed").length).toBe(1);
    });
    // Both bays are named, which the single-location grid could not do.
    await waitFor(() => {
      expect(screen.getAllByText(/F1-A1-R1-B1/).length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText(/F1-A2-R3-B2/).length).toBeGreaterThan(0);
  });

  it("draws the whole storage hierarchy, not a bare bin code", async () => {
    open();
    // The walk down to the bay, served as `bin_path`. A picker reading
    // `F1-A1-R1-B1` alone has been handed a memory test, not a destination.
    await waitFor(() => {
      expect(screen.getAllByText("F1-A1-R1").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("F1-A2").length).toBeGreaterThan(0);
  });

  it("says what each location is holding for this document", async () => {
    open();
    // `available_qty` is 0 on both rows — the allocation reserved them — and saying
    // so on its own told a storekeeper his correct document was impossible.
    await waitFor(() => {
      expect(screen.getAllByText(/allocated here/).length).toBe(2);
    });
  });

  it("states the same shelf at three widths, each one saying which it is", async () => {
    open();
    // The warehouse holds 15 of the item, across two batches of 5 and 10, each in one
    // bay. A bare number beside a dropdown is the thing that gets read as the wrong
    // quantity, so every figure carries the scope it measures.
    await waitFor(() => {
      expect(screen.getByText("In this warehouse")).toBeInTheDocument();
    });
    expect(screen.getAllByText("in this batch").length).toBe(2);
    expect(screen.getAllByText("at this location").length).toBe(2);
  });

  it("offers a new item row, so an issue can be raised without an indent", async () => {
    open();
    // A main store issues to departments, writes off scrap and moves stock for reasons
    // no indent covers — `_build_issue` has always allowed it, and only a LIP is
    // refused. The grid simply never rendered the button, so the item picker existed
    // with no way of creating the empty line it picks into.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /add item/i })).toBeEnabled();
    });
  });

  it("picks items from what the point holds, with the quantity on the option", async () => {
    open();
    // The item picker only stands on a row that has not named one yet — on a saved
    // line the item is the line, and changing it is removing the row and adding
    // another.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /add item/i })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: /add item/i }));

    // The catalogue is several thousand rows and the point stocks a couple of dozen
    // of them. Offering the whole master sent the storekeeper down two more dropdowns
    // before anything told him the shelf was empty.
    await waitFor(() => {
      expect(screen.getAllByText(/On the shelf here/).length).toBeGreaterThan(0);
    });
    // And the way to the rest of the catalogue is stated, not hidden: naming an item
    // the system does not think is there is a real thing a storekeeper has to do.
    expect(screen.getAllByText("Show every item").length).toBeGreaterThan(0);
  });

  const pickButton = (label: RegExp) =>
    screen.getAllByRole("button").find((node) => label.test(node.textContent || ""));

  const openPick = async (label: RegExp) => {
    await waitFor(() => expect(pickButton(label)).toBeTruthy());
    fireEvent.click(pickButton(label)!);
  };

  it("walks to the next page of codes and keeps them there", async () => {
    // `paging` used to be built as an object literal, so the debounced search effect
    // re-ran on every render and re-sent an unchanged needle — which resets the reader
    // to page 1. Next moved to page 2 and snapped back 300 ms later, so no page but
    // the first could ever be read. `sent` is the guard; this is its test.
    open();
    await openPick(/^\s*1\s*\/\s*5\s*$/);

    expect(await screen.findByText("AST-1")).toBeTruthy();
    expect(screen.queryByText("AST-201")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(await screen.findByText("AST-201")).toBeTruthy();
    expect(screen.queryByText("AST-1")).toBeNull();

    // And it STAYS there: the reset fired on a 300 ms debounce, so an assertion made
    // straight after the press passed even against the bug.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(screen.queryByText("AST-201")).toBeTruthy();
    expect(screen.queryByText("AST-1")).toBeNull();
  }, 15_000);

  it("keeps codes picked on every page, not just the page that was open at Save", async () => {
    // The reported bug: 500 picked on page 1, 500 on page 2, Save — and the line came
    // back with 500, because the save intersected the selection with the page on
    // screen. The selection is the document's, not the page's.
    open();
    await openPick(/^\s*0\s*\/\s*10\s*$/);

    const scan = await screen.findByLabelText(/scan or search codes/i);
    const enter = (code: string) => {
      fireEvent.change(scan, { target: { value: code } });
      fireEvent.keyDown(scan, { key: "Enter" });
    };

    await screen.findByText("AST-1");
    ["AST-1", "AST-2", "AST-3", "AST-4", "AST-5"].forEach(enter);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /selected \(5\)/i })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    await screen.findByText("AST-201");
    ["AST-201", "AST-202", "AST-203", "AST-204", "AST-205"].forEach(enter);

    // Ten selected, five of them on a page that is no longer on screen.
    const save = await screen.findByRole("button", { name: /save 10 codes/i });
    fireEvent.click(save);

    await waitFor(() => expect(pickButton(/^\s*10\s*\/\s*10\s*$/)).toBeTruthy());
  }, 15_000);

  it("counts identifiers per pick, so a pick with none is called out on its own row", async () => {
    open();
    // 15 issued over two picks with one code on the first: the item-level count of
    // "1 of 15" used to be the only signal, and it said nothing about WHICH pick was
    // unscanned. Each pick states its own gap, on the pick.
    await waitFor(() => {
      expect(screen.getAllByText("4 more auto-assigned on save").length).toBe(1);
    });
    expect(screen.getAllByText("10 more auto-assigned on save").length).toBe(1);
  });

  it("saves pending edits before handing the document to the approval chain", async () => {
    // Submit carries no line data of its own — it approves whatever is already in
    // the database. An edit made after the last Save used to be silently discarded
    // (and, worse, the chain could advance on stale data while the press reported an
    // error). Submit must save first, every time.
    open();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /submit for approval/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /submit for approval/i }));

    fireEvent.click(await screen.findByRole("button", { name: /^submit$/i }));

    await waitFor(() => expect(submitIssue).toHaveBeenCalledWith(1));
    expect(updateIssue).toHaveBeenCalledWith(1, expect.anything());
    expect(vi.mocked(updateIssue).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(submitIssue).mock.invocationCallOrder[0]);
  });
});
