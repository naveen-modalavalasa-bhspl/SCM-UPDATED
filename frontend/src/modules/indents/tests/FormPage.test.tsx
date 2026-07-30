import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IndentFormPage } from "../pages/FormPage";

const mockItems = vi.hoisted(() => [
  { id: 1, code: "IT-ML", name: "Syrup", uom_code: "ml" },
  { id: 2, code: "IT-G", name: "Powder", uom_code: "g" },
  { id: 3, code: "IT-LT", name: "Disinfectant", uom_code: "lt" },
  { id: 4, code: "IT-NOS", name: "Needle", uom_code: "nos" },
  { id: 5, code: "IT-PACK", name: "Gloves", uom_code: "pack" },
  { id: 6, code: "IT-MISS", name: "Unknown unit", uom_code: null },
]);

vi.mock("@/shared/auth/AuthContext", () => ({
  useAuth: () => ({
    me: {
      employee: { id: 1, name: "Test User", office_id: 701, office_name: "Main Office" },
      active_position: {
        id: 10,
        name: "OE-TEST",
        office_id: 701,
        office_name: "Main Office",
        is_primary: true,
      },
      permissions: ["indent.create"],
    },
  }),
}));

vi.mock("../api", async () => {
  const React = await import("react");
  const ReactQuery = await import("@tanstack/react-query");
  const root = "indents-module";
  const scoped = (scope: { employeeId: number | null; activePositionId: number | null }) =>
    [root, scope.employeeId, scope.activePositionId] as const;
  const isIndentModuleQuery = (query: { queryKey: readonly unknown[] }) => query.queryKey[0] === root;
  return {
    indentKeys: {
      all: scoped,
      items: (scope: { employeeId: number | null; activePositionId: number | null }, context = "default") =>
        [...scoped(scope), "items", context] as const,
    },
    isIndentModuleQuery,
    useIndentAccountScope: () => ({ employeeId: 1, activePositionId: 10 }),
    useIndentAccountCacheIsolation: () => {
      const qc = ReactQuery.useQueryClient();
      React.useEffect(() => {
        qc.getQueryCache();
      }, [qc]);
    },
    indentApi: {
      create: vi.fn(() => Promise.resolve({
        id: 42,
        indent_no: "IND/2026/0042",
        status: "DRAFT",
        priority: "NORMAL",
        total_items: 1,
        total_qty: 1,
        is_bookmarked: "NO",
        can_submit: true,
        can_approve: false,
        can_reject: false,
        created_at: "2026-07-28T10:00:00Z",
        items: [],
      })),
    },
    masterApi: {
      items: vi.fn(() => Promise.resolve(mockItems)),
    },
  };
});

import { indentApi, masterApi } from "../api";

function renderForm(ui: ReactElement = <IndentFormPage />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/indents/new"]}>
        <Routes>
          <Route path="/indents/new" element={ui} />
          <Route path="/indents/:id" element={<output aria-label="detail route" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function queryTextForItem(name: RegExp | string) {
  return typeof name === "string" ? name : name.source.replace(/\\s/g, " ");
}

async function selectItem(name: RegExp | string) {
  const item = await screen.findByRole("combobox", { name: "Item" });
  await waitFor(() => expect(masterApi.items).toHaveBeenCalledWith());
  fireEvent.focus(item);
  fireEvent.change(item, { target: { value: queryTextForItem(name) } });
  fireEvent.click(await screen.findByRole("option", { name }));
}

async function selectFirstItemAndQuantity(quantity = "16") {
  await selectItem(/Syrup/i);
  const qty = screen.getByRole("spinbutton", { name: "Quantity (ml)" });
  fireEvent.change(qty, { target: { value: quantity } });
  return qty;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 6, 28, 10, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("IndentFormPage", () => {
  it("loads the existing item list when the form opens", async () => {
    renderForm();

    await waitFor(() => expect(masterApi.items).toHaveBeenCalledWith());
    expect(screen.getByText("Indents")).toBeInTheDocument();
    expect(screen.queryByText("Attachments")).not.toBeInTheDocument();
    expect(screen.queryByText("Stock availability not checked")).not.toBeInTheDocument();
  });

  it("keeps the original client-side item filtering", async () => {
    renderForm();

    const item = await screen.findByRole("combobox", { name: "Item" });
    await waitFor(() => expect(masterApi.items).toHaveBeenCalledWith());
    fireEvent.focus(item);
    fireEvent.change(item, { target: { value: "Sy" } });

    expect(await screen.findByRole("option", { name: /Syrup/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Powder/i })).not.toBeInTheDocument();
    expect(masterApi.items).toHaveBeenCalledTimes(1);
  });

  it.each([
    [/Syrup/i, "ml"],
    [/Powder/i, "g"],
    [/Disinfectant/i, "lt"],
    [/Needle/i, "nos"],
    [/Gloves/i, "pack"],
  ])("shows the selected item %s UOM suffix", async (itemName, uom) => {
    renderForm();

    await selectItem(itemName);

    expect(screen.getByRole("spinbutton", { name: `Quantity (${uom})` })).toBeInTheDocument();
    expect(screen.getByText(uom)).toBeInTheDocument();
  });

  it("keeps the complete UOM visible in a non-shrinking, right-aligned suffix", async () => {
    renderForm();

    await selectItem(/Gloves/i);

    const suffix = screen.getByText("pack");
    expect(suffix).toHaveClass(
      "pointer-events-none",
      "inline-flex",
      "min-w-[2.5rem]",
      "shrink-0",
      "justify-end",
      "whitespace-nowrap",
      "text-muted",
    );
    expect(suffix).not.toHaveClass("truncate", "overflow-hidden", "text-ellipsis");
  });

  it("updates the UOM suffix immediately when the item changes", async () => {
    renderForm();

    await selectItem(/Syrup/i);
    expect(screen.getByRole("spinbutton", { name: "Quantity (ml)" })).toBeInTheDocument();

    const item = screen.getByRole("combobox", { name: "Item" });
    fireEvent.focus(item);
    fireEvent.change(item, { target: { value: "Gloves" } });
    fireEvent.click(await screen.findByRole("option", { name: /Gloves/i }));

    expect(screen.getByRole("spinbutton", { name: "Quantity (pack)" })).toBeInTheDocument();
    expect(screen.queryByText("ml")).not.toBeInTheDocument();
  });

  it("keeps quantity numeric while the UOM is display-only", async () => {
    renderForm();

    const qty = await selectFirstItemAndQuantity("16");
    fireEvent.click(screen.getByRole("button", { name: "Create indent" }));

    await waitFor(() => expect(indentApi.create).toHaveBeenCalledWith(expect.objectContaining({
      items: [{ item_id: 1, quantity: 16 }],
    })));
    expect(qty).toHaveValue(16);
  });

  it("shows UOM unavailable when the selected item has no UOM", async () => {
    renderForm();

    await selectItem(/Unknown unit/i);

    expect(screen.getByRole("spinbutton", { name: "Quantity (UOM unavailable)" })).toBeInTheDocument();
    expect(screen.getByText("UOM unavailable")).toBeInTheDocument();
  });

  it.each(["2026-07-27", "2026-07-26"])(
    "sets the date minimum and rejects the earlier date %s if manually entered",
    async (pastDate) => {
      renderForm();

      const requiredDate = screen.getByLabelText("Required date");
      expect(requiredDate).toHaveAttribute("min", "2026-07-28");

      fireEvent.change(requiredDate, { target: { value: pastDate } });

      expect(await screen.findByText("Required date cannot be earlier than today")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Create indent" })).toBeDisabled();
    },
  );

  it("accepts today as a required date", async () => {
    renderForm();

    await selectFirstItemAndQuantity("5");
    fireEvent.change(screen.getByLabelText("Required date"), { target: { value: "2026-07-28" } });
    fireEvent.click(screen.getByRole("button", { name: "Create indent" }));

    await waitFor(() => expect(indentApi.create).toHaveBeenCalledWith(expect.objectContaining({
      required_date: "2026-07-28",
    })));
  });

  it("accepts a future required date", async () => {
    renderForm();

    await selectFirstItemAndQuantity("5");
    fireEvent.change(screen.getByLabelText("Required date"), { target: { value: "2026-08-02" } });
    fireEvent.click(screen.getByRole("button", { name: "Create indent" }));

    await waitFor(() => expect(indentApi.create).toHaveBeenCalledWith(expect.objectContaining({
      required_date: "2026-08-02",
    })));
  });

  it("blocks manual past-date entry before submission", async () => {
    renderForm();

    await selectFirstItemAndQuantity("5");
    fireEvent.change(screen.getByLabelText("Required date"), { target: { value: "2026-07-27" } });
    fireEvent.click(screen.getByRole("button", { name: "Create indent" }));

    expect(screen.getByText("Required date cannot be earlier than today")).toBeInTheDocument();
    expect(indentApi.create).not.toHaveBeenCalled();
  });
});
