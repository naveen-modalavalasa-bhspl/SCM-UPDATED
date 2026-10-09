import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PutawayCodes, PutawayUnitCode } from "../types";

/**
 * The label sheet for the codes a putaway minted.
 *
 * What is pinned here is what would fail silently otherwise:
 *
 * - the code is written out UNDER the symbol — a sticker is read by eye at least as
 *   often as it is scanned, and a label that is only a QR square tells a storekeeper
 *   nothing with a flat scanner;
 * - the size control changes the label's PHYSICAL size, because a preview at anything
 *   else is a lie about what comes out of the printer;
 * - the codes page, and the full set is fetched only at the press of Print or Download
 *   — which is the entire reason the list is paged;
 * - a barcode too tight to scan says so rather than printing quietly.
 */

vi.mock("@/shared/api/client", () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

const head: PutawayCodes = {
  putaway_id: 58,
  putaway_no: "BHS/NA/2026-27/PUT0029",
  status: "COMPLETED",
  item_id: 7,
  item_code: "304010-FRIDGE-GODREJ-GODREJ-0001",
  item_name: "Godrej 190L refrigerator",
  uom_code: "NOS",
  batch_id: 3,
  batch_no: "56321",
  expiry_date: "2026-09-04",
  is_asset: true,
  warehouse_id: 1,
  warehouse_name: "CENTRAL WAREHOUSE-1",
  bin_id: 20,
  bin_code: "F1-A1-R1-B3",
  bin_path: "F1 / F1-A1 / F1-A1-R1 / F1-A1-R1-B3",
  lot_no: "LOT/WH982/F1-A1-R1-B3/2026-27/00057",
  qty: 30,
  completed_at: "2026-09-02T15:34:00",
  is_code_tracked: true,
  code_type: "ASSET",
  total_codes: 30,
  reason: null,
};

/** 30 units, the shape `_place_unit_codes` mints them in. */
const ALL: PutawayUnitCode[] = Array.from({ length: 30 }, (_, i) => ({
  id: i + 1,
  code: `FRIDGE-GODREJ-GODREJ-0001-1-${String(i + 101).padStart(8, "0")}`,
  code_type: "ASSET",
  scope: "UNIT",
  serial_number: null,
  imei: null,
  status: "available",
}));

const putawayCodes = vi.fn();
const putawayCodeUnits = vi.fn();
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    putawayCodes: (id: number) => putawayCodes(id),
    putawayCodeUnits: (id: number, params: Record<string, unknown>) =>
      putawayCodeUnits(id, params),
  };
});

const downloadBlob = vi.fn();
vi.mock("../codeLabels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../codeLabels")>();
  // Only the handing-a-file-to-the-browser step is stubbed; every calculation the
  // download depends on is the real one, and is covered by codeLabels.test.ts.
  return { ...actual, downloadBlob: (...args: unknown[]) => downloadBlob(...args) };
});

import { UnitCodeLabels } from "../components/UnitCodeLabels";

const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })}>
    {ui}
  </QueryClientProvider>
);

const page = (params: { page?: number; size?: number; search?: string }) => {
  const size = params.size ?? 24;
  const p = params.page ?? 1;
  const pool = params.search
    ? ALL.filter((u) => u.code.includes(params.search as string))
    : ALL;
  return {
    items: pool.slice((p - 1) * size, p * size),
    total: pool.length,
    page: p,
    size,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  putawayCodes.mockResolvedValue(head);
  putawayCodeUnits.mockImplementation((_id, params) => Promise.resolve(page(params)));
});

const firstCode = ALL[0].code;

describe("UnitCodeLabels", () => {
  it("writes the code under the symbol and selects everything by default", async () => {
    render(wrap(<UnitCodeLabels taskId={58} />));

    await waitFor(() => expect(screen.getAllByText(firstCode).length).toBeGreaterThan(0));
    // Nothing is fetched twice on open: the header is a count, and one page of codes is
    // read behind it. The other 6 arrive only if somebody asks.
    expect(putawayCodeUnits).toHaveBeenCalledTimes(1);
    expect(screen.getByText("30 of 30 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Print 30 labels/ })).toBeEnabled();
  });

  it("pages the codes instead of drawing a thousand of them", async () => {
    render(wrap(<UnitCodeLabels taskId={58} />));
    await waitFor(() => expect(screen.getByText(/Showing/)).toBeInTheDocument());

    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("1–24")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(screen.getByText("Page 2 of 2")).toBeInTheDocument());
    expect(putawayCodeUnits).toHaveBeenLastCalledWith(58, expect.objectContaining({
      page: 2, size: 24,
    }));
    // Paging is not selecting: what will print is still every code, not the 24 seen.
    expect(screen.getByText("30 of 30 selected")).toBeInTheDocument();
  });

  it("keeps a deselected code deselected while the page changes under it", async () => {
    render(wrap(<UnitCodeLabels taskId={58} />));
    await waitFor(() => expect(screen.getAllByText(firstCode).length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole("button", { name: `Exclude ${firstCode}` }));
    expect(screen.getByText("29 of 30 selected")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(screen.getByText("Page 2 of 2")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    await waitFor(() => expect(screen.getByText("Page 1 of 2")).toBeInTheDocument());

    // Selection is a default plus the ids that differ from it, so a round trip through
    // the pager cannot quietly put a code back in the run.
    expect(screen.getByText("29 of 30 selected")).toBeInTheDocument();
  });

  it("searches the whole set on the server, not the page on screen", async () => {
    render(wrap(<UnitCodeLabels taskId={58} />));
    await waitFor(() => expect(screen.getAllByText(firstCode).length).toBeGreaterThan(0));

    fireEvent.change(screen.getByLabelText("Find a code"), {
      target: { value: "00000130" },
    });
    await waitFor(() => expect(putawayCodeUnits).toHaveBeenLastCalledWith(58,
      expect.objectContaining({ search: "00000130", page: 1 })));
  });

  it("prints at the size that was picked, in real millimetres", async () => {
    render(wrap(<UnitCodeLabels taskId={58} />));
    await waitFor(() => expect(screen.getAllByText(firstCode).length).toBeGreaterThan(0));

    const label = () => document.querySelector(".unit-label") as HTMLElement;
    expect(label().style.width).toBe("70mm");

    fireEvent.click(screen.getByRole("button", { name: "100 × 50" }));
    expect(label().style.width).toBe("100mm");
    expect(label().style.height).toBe("50mm");

    // Custom is the point of the control: label stock is whatever the store bought.
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    fireEvent.change(screen.getByLabelText("Width in millimetres"), {
      target: { value: "45" },
    });
    expect(label().style.width).toBe("45mm");
  });

  it("swaps the QR for a barcode, and warns when one cannot be scanned", async () => {
    render(wrap(<UnitCodeLabels taskId={58} />));
    await waitFor(() => expect(screen.getAllByText(firstCode).length).toBeGreaterThan(0));

    // A QR draws a single path; jsbarcode draws a rect per bar. Asserting on the shape
    // of the symbol is how the swap is checked at all — both are <svg>.
    const symbol = () => document.querySelector("[data-symbol] svg") as SVGElement;
    expect(symbol().querySelector("path")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Barcode/ }));
    await waitFor(() => expect(symbol().querySelector("rect")).not.toBeNull());

    // 41 characters of Code 128 on a 70mm label is well under the width a scanner can
    // read — the exact trap BUG_SCM_INV_042 and 058 both fell into.
    expect(screen.getByText(/under the 0.19 mm most scanners can read/))
      .toBeInTheDocument();

    // And the warning is actionable, not just a complaint.
    fireEvent.click(screen.getByRole("button", { name: "38 × 25" }));
    expect(screen.getByText(/Use a label at least \d+ mm wide/)).toBeInTheDocument();
  });

  it("fetches every code only when one is actually being printed", async () => {
    render(wrap(<UnitCodeLabels taskId={58} />));
    await waitFor(() => expect(screen.getAllByText(firstCode).length).toBeGreaterThan(0));
    expect(putawayCodeUnits).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Print 30 labels/ }));

    // One more call, for the whole set at the server's own page ceiling.
    await waitFor(() => expect(putawayCodeUnits).toHaveBeenLastCalledWith(58,
      expect.objectContaining({ size: 500, page: 1 })));
  });

  it("downloads the codes as a spreadsheet", async () => {
    render(wrap(<UnitCodeLabels taskId={58} />));
    await waitFor(() => expect(screen.getAllByText(firstCode).length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole("button", { name: /CSV/ }));

    await waitFor(() => expect(downloadBlob).toHaveBeenCalled());
    const [, filename] = downloadBlob.mock.calls[0];
    // A putaway number is a perfectly good document number and a completely illegal
    // filename.
    expect(filename).toBe("BHS-NA-2026-27-PUT0029-codes.csv");
  });

  it("says why there is nothing to print rather than showing an empty sheet", async () => {
    putawayCodes.mockResolvedValue({
      ...head,
      total_codes: 0,
      reason: "BHS/NA/2026-27/PUT0029 is pending. Codes are minted when the stock is "
        + "placed in its bin.",
    });
    render(wrap(<UnitCodeLabels taskId={58} />));

    await waitFor(() => expect(screen.getByText("No codes to print")).toBeInTheDocument());
    // The server's sentence, not one composed here: three different things cause an
    // empty sheet and they have three different fixes.
    expect(screen.getByText(/Codes are minted when the stock is placed in its bin/))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Print/ })).not.toBeInTheDocument();
    // And it never asks for a page of a list it has been told is empty.
    expect(putawayCodeUnits).not.toHaveBeenCalled();
  });
});
