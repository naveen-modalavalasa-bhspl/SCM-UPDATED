import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { QuotationComparison } from "../components/QuotationComparison";
import type { Comparison, ComparisonCell, ComparisonTotal } from "../types";

vi.mock("@/shared/auth/AuthContext", () => ({
  useAuth: () => ({ can: () => true }),
}));

const cell = (quotationId: number, vendorId: number): ComparisonCell => ({
  quotation_id: quotationId,
  vendor_id: vendorId,
  vendor_name: `Supplier ${vendorId}`,
  quantity: 10,
  rate: 100,
  discount_percent: 0,
  discount_amount: 0,
  taxable_amount: 1000,
  tax_percent: 18,
  tax_amount: 180,
  line_total: 1180,
  is_best: quotationId === 11,
});

const total = (quotationId: number, vendorId: number): ComparisonTotal => ({
  quotation_id: quotationId,
  quotation_no: `Q-${quotationId}`,
  vendor_id: vendorId,
  vendor_name: `Supplier ${vendorId}`,
  status: "SUBMITTED",
  sub_total: 1000,
  discount_amount: 0,
  tax_amount: 180,
  freight_amount: 0,
  grand_total: 1180,
  revision_count: 0,
  best_line_count: quotationId === 11 ? 1 : 0,
  is_recommended: quotationId === 11,
});

const comparison = {
  rfq: { id: 1, items: [], vendors: [] },
  quotations: [],
  items: [{
    rfq_item_id: 101,
    item_id: 501,
    item_code: "IT-501",
    item_name: "Monitor",
    uom_code: "NOS",
    quantity: 10,
    cells: [cell(11, 21), cell(12, 22)],
  }],
  totals: [total(11, 21), total(12, 22)],
  evaluation_method: "LANDED_COST",
  responded: 2,
  recommended_quotation_id: 11,
  meets_three_quote_norm: false,
} as unknown as Comparison;

const renderComparison = (
  overrides: Partial<Parameters<typeof QuotationComparison>[0]> = {},
) => {
  const props = {
    comparison,
    onAward: vi.fn(),
    onAwardSplit: vi.fn(),
    onCreatePo: vi.fn(),
    onOpenPo: vi.fn(),
    ...overrides,
  };
  render(<QuotationComparison {...props} />);
  return props;
};

describe("QuotationComparison awards", () => {
  it("submits item shares without creating POs as part of the award", () => {
    const props = renderComparison();

    fireEvent.click(screen.getByRole("button", {
      name: "Share items between suppliers",
    }));
    fireEvent.change(screen.getByLabelText("Quantity for Supplier 21 on Monitor"), {
      target: { value: "4" },
    });
    fireEvent.change(screen.getByLabelText("Quantity for Supplier 22 on Monitor"), {
      target: { value: "6" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Award & generate POs" }));

    expect(props.onAwardSplit).toHaveBeenCalledWith([
      { item_id: 501, vendor_id: 21, quantity: 4 },
      { item_id: 501, vendor_id: 22, quantity: 6 },
    ]);
    expect(props.onCreatePo).not.toHaveBeenCalled();
  });

  it("blocks over-allocation and keeps complete-quote awards singular", () => {
    const props = renderComparison();
    fireEvent.click(screen.getByRole("button", {
      name: "Share items between suppliers",
    }));
    fireEvent.change(screen.getByLabelText("Quantity for Supplier 21 on Monitor"), {
      target: { value: "7" },
    });
    fireEvent.change(screen.getByLabelText("Quantity for Supplier 22 on Monitor"), {
      target: { value: "7" },
    });
    expect(screen.getByRole("button", { name: "Award & generate POs" })).toBeDisabled();
    expect(screen.getByText("Monitor is over-allocated.")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", {
      name: "Award complete quote",
    })[0]);
    expect(props.onAward).toHaveBeenCalledWith([11]);
  });

  it("shows live PO allocations before re-share and starts re-share from them", () => {
    const props = renderComparison({
      awardedQuotationIds: [11, 12],
      reawardable: true,
      liveAllocatedQuantities: {
        21: { "501": 4 },
        22: { "501": 5 },
      },
      purchaseOrders: [
        { id: 301, po_no: "PO-301", quotation_id: 11, item_quantities: { "501": 4 } },
        { id: 302, po_no: "PO-302", quotation_id: 12, item_quantities: { "501": 5 } },
      ],
    });

    expect(screen.getByText("Allocated 9 / 10")).toBeInTheDocument();
    expect(screen.getByText("Allocated 4")).toBeInTheDocument();
    expect(screen.getByText("Allocated 5")).toBeInTheDocument();
    // The saved PO quantity is printed under this supplier's item cell, rather
    // than making the buyer open the PO just to understand the live allocation.
    fireEvent.click(screen.getByTitle("Open PO-302"));
    expect(props.onOpenPo).toHaveBeenCalledWith(302);

    fireEvent.click(screen.getByRole("button", {
      name: "Re-share the unordered items",
    }));
    const firstAdditional = screen.getByLabelText("Quantity for Supplier 21 on Monitor");
    const secondAdditional = screen.getByLabelText("Quantity for Supplier 22 on Monitor");
    expect((firstAdditional as HTMLInputElement).value).toBe("");
    expect((secondAdditional as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "Award & generate POs" })).toBeDisabled();

    // This is an ADDITION, not a replacement total. Adding one to Supplier 22
    // produces a final award of 6 while the live allocation remains the prior 9.
    fireEvent.change(secondAdditional, { target: { value: "1" } });
    expect(screen.getByText("After this award 10 / 10")).toBeInTheDocument();
    expect(screen.getByText("Allocated 9 / 10")).toBeInTheDocument();

    fireEvent.change(secondAdditional, { target: { value: "" } });
    expect(screen.getByText("Allocated 9 / 10")).toBeInTheDocument();
    expect(screen.getByText("Allocated 4")).toBeInTheDocument();
    expect(screen.getByText("Allocated 5")).toBeInTheDocument();
  });

  it("adds a new five-unit PO to an earlier five-unit allocation", () => {
    const props = renderComparison({
      awardedQuotationIds: [11],
      reawardable: true,
      liveAllocatedQuantities: { 21: { "501": 5 } },
      purchaseOrders: [
        { id: 301, po_no: "PO-301", quotation_id: 11, item_quantities: { "501": 5 } },
      ],
    });

    expect(screen.getByText("Allocated 5 / 10")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {
      name: "Re-share the unordered items",
    }));
    fireEvent.change(screen.getByLabelText("Quantity for Supplier 21 on Monitor"), {
      target: { value: "5" },
    });
    expect(screen.getByText("After this award 10 / 10")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Award & generate POs" }));
    expect(props.onAwardSplit).toHaveBeenCalledWith([
      { item_id: 501, vendor_id: 21, quantity: 10 },
    ]);
  });

  it("keeps an earlier PO allocation visible if the derived RFQ map is temporarily absent", () => {
    renderComparison({
      awardedQuotationIds: [11],
      reawardable: true,
      purchaseOrders: [
        {
          id: 301, po_no: "PO-301", quotation_id: 11, vendor_id: 21,
          item_quantities: { "501": 4 },
        },
      ],
    });

    expect(screen.getByText("Allocated 4 / 10")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {
      name: "Re-share the unordered items",
    }));
    const additional = screen.getByLabelText(
      "Quantity for Supplier 21 on Monitor",
    ) as HTMLInputElement;
    expect(additional.value).toBe("");
  });

  it("automatically fills the RFQ quantity for an item mapped to a single supplier and allows editing it", () => {
    const singleSupplierComparison = {
      ...comparison,
      items: [{
        rfq_item_id: 102,
        item_id: 502,
        item_code: "IT-502",
        item_name: "Keyboard",
        uom_code: "NOS",
        quantity: 15,
        cells: [cell(11, 21)], // Only Supplier 21 quoted Keyboard
      }],
    } as unknown as Comparison;

    renderComparison({ comparison: singleSupplierComparison });

    fireEvent.click(screen.getByRole("button", {
      name: "Share items between suppliers",
    }));

    const input = screen.getByLabelText("Quantity for Supplier 21 on Keyboard") as HTMLInputElement;
    expect(input.value).toBe("15");

    // Ensure it is editable
    fireEvent.change(input, { target: { value: "10" } });
    expect(input.value).toBe("10");
  });
});
