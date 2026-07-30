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
      detail: (scope: { employeeId: number | null; activePositionId: number | null }, id: number) =>
        [...scoped(scope), "detail", id] as const,
      offices: (scope: { employeeId: number | null; activePositionId: number | null }) =>
        [...scoped(scope), "offices"] as const,
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
      get: vi.fn(),
      offices: vi.fn(() => Promise.resolve([
        { id: 701, name: "Main Office" },
        { id: 702, name: "Branch Office" },
      ])),
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
      update: vi.fn(),
    },
    masterApi: {
      items: vi.fn(() => Promise.resolve(mockItems)),
    },
  };
});

import { indentApi, masterApi } from "../api";

function renderForm(route = "/indents/new", ui: ReactElement = <IndentFormPage />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
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

async function selectItemInRow(rowIndex: number, name: RegExp | string) {
  const items = await screen.findAllByRole("combobox", { name: "Item" });
  const item = items[rowIndex];
  await waitFor(() => expect(masterApi.items).toHaveBeenCalledWith());
  fireEvent.focus(item);
  fireEvent.change(item, { target: { value: queryTextForItem(name) } });
  fireEvent.click(await screen.findByRole("option", { name }));
}

async function selectItem(name: RegExp | string) {
  await selectItemInRow(0, name);
}

async function selectFirstItemAndQuantity(quantity = "16") {
  await selectItem(/Syrup/i);
  const qty = screen.getByRole("spinbutton", { name: "Quantity (ml)" });
  fireEvent.change(qty, { target: { value: quantity } });
  fireEvent.change(screen.getByLabelText("Required date"), {
    target: { value: "2026-07-28" },
  });
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

  it("prefills a Draft and updates the same indent in edit mode", async () => {
    const draft = {
      id: 42,
      indent_no: "IND/2026/0042",
      required_date: "2026-08-02",
      requested_by_id: 1,
      office_id: 701,
      office_name: "Main Office",
      status: "DRAFT",
      priority: "URGENT",
      total_items: 1,
      total_qty: 5,
      remarks: "Original remarks",
      is_bookmarked: "NO",
      can_submit: true,
      can_approve: false,
      can_reject: false,
      created_at: "2026-07-28T10:00:00Z",
      items: [{
        id: 10,
        item_id: 1,
        item_code: "IT-ML",
        item_name: "Syrup",
        uom_code: "ml",
        quantity: 5,
        ordered_quantity: 0,
        received_quantity: 0,
      }],
    };
    vi.mocked(indentApi.get).mockResolvedValue(draft);
    vi.mocked(indentApi.update).mockResolvedValueOnce({ ...draft, total_qty: 7 });

    renderForm("/indents/new?edit=42");

    expect(await screen.findByText("Edit IND/2026/0042")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("spinbutton", { name: "Quantity (ml)" })).toHaveValue(5);
    });
    expect(screen.getByLabelText("Required date")).toHaveValue("2026-08-02");
    expect(screen.getByPlaceholderText("Optional")).toHaveValue("Original remarks");
    expect(screen.getByRole("combobox", {
      name: "Office is assigned from your position",
    })).not.toBeDisabled();

    fireEvent.change(screen.getByLabelText("Required date"), { target: { value: "" } });
    expect(screen.queryByText("Required date is mandatory.")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Required date")).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Save changes" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByText("Required date is mandatory.")).toBeInTheDocument();
    expect(screen.getByLabelText("Required date")).toHaveAttribute("aria-invalid", "true");
    expect(indentApi.update).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Required date"), {
      target: { value: "2026-08-02" },
    });
    expect(screen.queryByText("Required date is mandatory.")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("spinbutton", { name: "Quantity (ml)" }), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(indentApi.update).toHaveBeenCalledWith(42, {
      priority: "URGENT",
      required_date: "2026-08-02",
      office_id: 701,
      remarks: "Original remarks",
      items: [{ item_id: 1, quantity: 7 }],
    }));
    expect(indentApi.create).not.toHaveBeenCalled();
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

  it("clears only the current row and allows a different item to be selected", async () => {
    renderForm();

    await selectFirstItemAndQuantity("5");
    fireEvent.click(screen.getByRole("button", { name: "Add line" }));
    await selectItemInRow(1, /Powder/i);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Quantity (g)" }), {
      target: { value: "3" },
    });

    const firstItem = screen.getAllByRole("combobox", { name: "Item" })[0];
    fireEvent.change(firstItem, { target: { value: "" } });

    expect(firstItem).toHaveValue("");
    expect(screen.getByRole("spinbutton", { name: "Quantity" })).toHaveValue(null);
    expect(screen.queryByText("ml")).not.toBeInTheDocument();
    expect(
      (screen.getAllByRole("combobox", { name: "Item" })[1] as HTMLInputElement).value,
    ).toContain("Powder");
    expect(screen.getByRole("spinbutton", { name: "Quantity (g)" })).toHaveValue(3);

    fireEvent.focus(firstItem);
    expect(firstItem).toHaveValue("");
    expect(screen.getByRole("option", { name: /Syrup/i })).toHaveAttribute(
      "aria-selected",
      "false",
    );

    fireEvent.change(firstItem, { target: { value: "Gloves" } });
    fireEvent.click(await screen.findByRole("option", { name: /Gloves/i }));

    expect((firstItem as HTMLInputElement).value).toContain("Gloves");
    expect(screen.getByRole("spinbutton", { name: "Quantity (pack)" })).toHaveValue(null);
    expect(screen.getByRole("spinbutton", { name: "Quantity (g)" })).toHaveValue(3);

    fireEvent.change(screen.getByRole("spinbutton", { name: "Quantity (pack)" }), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create indent" }));

    await waitFor(() => expect(indentApi.create).toHaveBeenCalledWith(expect.objectContaining({
      items: [
        { item_id: 5, quantity: 4 },
        { item_id: 2, quantity: 3 },
      ],
    })));
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

  it("rejects and highlights an item already selected in another row", async () => {
    renderForm();

    await selectFirstItemAndQuantity("5");
    fireEvent.click(screen.getByRole("button", { name: "Add line" }));

    const secondItem = screen.getAllByRole("combobox", { name: "Item" })[1];
    fireEvent.focus(secondItem);
    fireEvent.change(secondItem, { target: { value: "Syrup" } });
    const duplicateOption = await screen.findByRole("option", { name: /Syrup/i });

    expect(duplicateOption).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(duplicateOption);

    expect(secondItem).toHaveValue("");
    expect(secondItem).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("This item is already added to the indent.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create indent" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Create indent" }));
    expect(indentApi.create).not.toHaveBeenCalled();
  });

  it("clears the duplicate warning when a different item_id is selected", async () => {
    renderForm();

    await selectFirstItemAndQuantity("5");
    fireEvent.click(screen.getByRole("button", { name: "Add line" }));
    await selectItemInRow(1, /Syrup/i);
    expect(screen.getByText("This item is already added to the indent.")).toBeInTheDocument();

    await selectItemInRow(1, /Powder/i);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Quantity (g)" }), {
      target: { value: "3" },
    });

    expect(screen.queryByText("This item is already added to the indent.")).not.toBeInTheDocument();
    expect(screen.getAllByRole("combobox", { name: "Item" })[1]).not.toHaveAttribute(
      "aria-invalid",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Create indent" }));
    await waitFor(() => expect(indentApi.create).toHaveBeenCalledWith(expect.objectContaining({
      items: [
        { item_id: 1, quantity: 5 },
        { item_id: 2, quantity: 3 },
      ],
    })));
  });

  it("makes an item available again when the row selecting it is removed", async () => {
    renderForm();

    await selectFirstItemAndQuantity("5");
    fireEvent.click(screen.getByRole("button", { name: "Add line" }));
    await selectItemInRow(1, /Syrup/i);
    expect(screen.getByText("This item is already added to the indent.")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Remove line" })[0]);

    expect(screen.queryByText("This item is already added to the indent.")).not.toBeInTheDocument();
    const remainingItem = screen.getByRole("combobox", { name: "Item" });
    fireEvent.focus(remainingItem);
    fireEvent.change(remainingItem, { target: { value: "Syrup" } });
    const availableOption = await screen.findByRole("option", { name: /Syrup/i });
    expect(availableOption).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(availableOption);
    expect((remainingItem as HTMLInputElement).value).toContain("Syrup");
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
      await selectFirstItemAndQuantity("5");

      const requiredDate = screen.getByLabelText("Required date");
      expect(requiredDate).toHaveAttribute("min", "2026-07-28");

      fireEvent.change(requiredDate, { target: { value: pastDate } });

      expect(screen.queryByText("Required date cannot be earlier than today")).not.toBeInTheDocument();
      expect(requiredDate).not.toHaveAttribute("aria-invalid", "true");

      fireEvent.click(screen.getByRole("button", { name: "Create indent" }));

      expect(screen.getByText("Required date cannot be earlier than today")).toBeInTheDocument();
      expect(requiredDate).toHaveAttribute("aria-invalid", "true");
      expect(indentApi.create).not.toHaveBeenCalled();
    },
  );

  it("blocks creation until a required date is selected", async () => {
    renderForm();

    await selectItem(/Syrup/i);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Quantity (ml)" }), {
      target: { value: "5" },
    });

    const requiredDate = screen.getByLabelText("Required date");
    expect(requiredDate).toBeRequired();
    expect(requiredDate).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByText("Required date is mandatory.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create indent" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Create indent" }));

    expect(requiredDate).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Required date is mandatory.")).toBeInTheDocument();
    expect(indentApi.create).not.toHaveBeenCalled();

    fireEvent.change(requiredDate, { target: { value: "2026-08-02" } });

    expect(screen.queryByText("Required date is mandatory.")).not.toBeInTheDocument();
    expect(requiredDate).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Create indent" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Create indent" }));
    await waitFor(() => expect(indentApi.create).toHaveBeenCalledWith(expect.objectContaining({
      required_date: "2026-08-02",
    })));
  });

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

  // ── Quantity-required validation ───────────────────────────────────────────

  it("blocks submit when a selected item has no quantity", async () => {
    renderForm();

    await selectItem(/Syrup/i);
    fireEvent.change(screen.getByLabelText("Required date"), {
      target: { value: "2026-07-28" },
    });

    expect(screen.queryByText("Quantity is required for this item.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create indent" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Create indent" }));

    expect(screen.getByText("Quantity is required for this item.")).toBeInTheDocument();
    expect(indentApi.create).not.toHaveBeenCalled();
  });

  it("shows missing quantity and required date errors only after submit", async () => {
    renderForm();

    await selectItem(/Syrup/i);
    const qty = screen.getByRole("spinbutton", { name: "Quantity (ml)" });
    const requiredDate = screen.getByLabelText("Required date");

    expect(screen.queryByText("Quantity is required for this item.")).not.toBeInTheDocument();
    expect(screen.queryByText("Required date is mandatory.")).not.toBeInTheDocument();
    expect(qty).not.toHaveAttribute("aria-invalid", "true");
    expect(requiredDate).not.toHaveAttribute("aria-invalid", "true");

    fireEvent.click(screen.getByRole("button", { name: "Create indent" }));

    expect(screen.getByText("Quantity is required for this item.")).toBeInTheDocument();
    expect(screen.getByText("Required date is mandatory.")).toBeInTheDocument();
    expect(qty).toHaveAttribute("aria-invalid", "true");
    expect(requiredDate).toHaveAttribute("aria-invalid", "true");
    expect(indentApi.create).not.toHaveBeenCalled();
  });

  it("clears the quantity error and enables submit after entering a valid quantity", async () => {
    renderForm();

    await selectItem(/Syrup/i);
    fireEvent.change(screen.getByLabelText("Required date"), {
      target: { value: "2026-07-28" },
    });
    expect(screen.queryByText("Quantity is required for this item.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create indent" }));
    expect(screen.getByText("Quantity is required for this item.")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("spinbutton", { name: "Quantity (ml)" }), {
      target: { value: "5" },
    });

    expect(screen.queryByText("Quantity is required for this item.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create indent" })).not.toBeDisabled();
  });

  it("does not show a quantity error for empty rows with no item selected", async () => {
    renderForm();

    // No item selected in the initial empty row
    expect(screen.queryByText("Quantity is required for this item.")).not.toBeInTheDocument();
    // Button is still disabled (no valid lines), but NOT because of the qty error
    expect(screen.getByRole("button", { name: "Create indent" })).toBeDisabled();
  });

  it("blocks submit when one of two rows has an item but no quantity", async () => {
    renderForm();

    await selectFirstItemAndQuantity("5");
    fireEvent.click(screen.getByRole("button", { name: "Add line" }));
    await selectItemInRow(1, /Powder/i);

    expect(screen.queryByText("Quantity is required for this item.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create indent" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Create indent" }));

    expect(screen.getAllByText("Quantity is required for this item.")).toHaveLength(1);
    expect(indentApi.create).not.toHaveBeenCalled();
  });

  it("submits successfully after all selected items have valid quantities", async () => {
    renderForm();

    await selectFirstItemAndQuantity("5");
    fireEvent.click(screen.getByRole("button", { name: "Create indent" }));

    await waitFor(() =>
      expect(indentApi.create).toHaveBeenCalledWith(
        expect.objectContaining({ items: [{ item_id: 1, quantity: 5 }] }),
      ),
    );
    expect(screen.queryByText("Quantity is required for this item.")).not.toBeInTheDocument();
  });
});
