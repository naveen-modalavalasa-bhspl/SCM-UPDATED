import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  returnsApi: { relatedDocuments: vi.fn() },
}));

import { RelatedDocumentsSection } from "../components/RelatedDocumentsSection";
import ReturnTrailPage from "../pages/ReturnTrailPage";
import { returnsApi } from "../api";
import type { RelatedDocument, TrailChapter } from "../types";

const fetchTrail = returnsApi.relatedDocuments as unknown as ReturnType<typeof vi.fn>;

/** The served legs, under the names the application itself uses for the documents. */
const CHAPTERS: TrailChapter[] = [
  { key: "REQUEST", label: "Request", caption: "The indent it was asked for on.", count: 0 },
  { key: "COMMITMENT", label: "Allocation", caption: "What the store committed.", count: 0 },
  { key: "SOURCING", label: "Purchase", caption: "How it was sourced.", count: 0 },
  { key: "INBOUND", label: "Receipt", caption: "The delivery and the gate.", count: 0 },
  { key: "OUTBOUND", label: "Issue", caption: "Picked and handed over.", count: 0 },
  { key: "REVERSE", label: "Return", caption: "The load carrying it back.", count: 0 },
];

const doc = (
  docType: string,
  chapter: string,
  over: Partial<RelatedDocument> = {},
): RelatedDocument => ({
  doc_type: docType,
  doc_label: docType,
  chapter,
  doc_id: 1,
  doc_no: `${docType}-1`,
  status: null,
  date: null,
  vendor_name: null,
  warehouse_name: null,
  ...over,
});

/**
 * A real stock return: asked for, allocated off the shelf, issued, coming back. Nothing
 * was bought and nothing was received, because the warehouse already held it — which is
 * the case this whole module exists for and the one the screen has to read well.
 */
const stockReturn = (): RelatedDocument[] => [
  doc("INDENT", "REQUEST", { doc_id: 5, doc_no: "IND0012" }),
  doc("INTENT", "REQUEST", { doc_id: null, doc_no: null }),
  ...Array.from({ length: 4 }, (_, i) => doc("ALLOCATION", "COMMITMENT", {
    doc_id: 100 + i, doc_no: `ALC00${i}`,
  })),
  ...Array.from({ length: 5 }, (_, i) => doc("MATERIAL_ISSUE", "OUTBOUND", {
    doc_id: 200 + i, doc_no: `WHI00${i}`, warehouse_name: "Central Warehouse-1",
  })),
  ...Array.from({ length: 3 }, (_, i) => doc("CONSIGNMENT", "REVERSE", {
    doc_id: 300 + i, doc_no: `DSP00${i}`, vendor_name: "Bavya Traders",
  })),
];

const payload = (documents: RelatedDocument[]) => ({
  return_id: 8,
  return_no: "BHS/NA/2026-27/RET0008",
  originating_warehouse_id: 1,
  originating_warehouse_name: "CENTRAL WAREHOUSE-1 - MAIN",
  originating_source_doc: "Material issue WHI0022",
  originating_is_resolved: true,
  current_warehouse_id: 2,
  current_warehouse_name: "AP-104-MMU-Chilamathur - LIP",
  material_issue_no: "BHS/104/2026-27/WHI0022",
  material_issue_id: 200,
  intent: "RETURN",
  intent_label: "Return only",
  items: [],
  documents,
  chapters: CHAPTERS,
  documents_note: null,
  purchase_return_category: "LIP",
  purchase_return_category_label: "From LIP",
  purchase_return_source_detail: "AP-104-MMU-Chilamathur - LIP is a Local Inventory Point.",
  purchase_return_source_tier: "LIP",
  purchase_return_source_resolved: true,
  qc_rejected_tag: false,
  vehicle_options: [],
  vehicle_type: null,
  logistics_mode: null,
  warehouse_return_no: null,
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const mountSummary = () => render(
  <QueryClientProvider client={client()}>
    <MemoryRouter>
      <RelatedDocumentsSection returnId={8} />
    </MemoryRouter>
  </QueryClientProvider>,
);

const mountPage = () => render(
  <QueryClientProvider client={client()}>
    <MemoryRouter initialEntries={["/returns/8/trail"]}>
      <Routes>
        <Route path="/returns/:id/trail" element={<ReturnTrailPage />} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>,
);

const legs = () => screen.getAllByLabelText("The legs this material travelled");
const timeline = () => screen.getByLabelText("This material's history, leg by leg");
const searchBox = () => screen.getByLabelText("Search this material's history");
/* The indent's number is on the page TWICE by design — once lifted into the facts strip
 * as the document anybody opens, once in its own row on the trail — so the page's tests
 * wait on the timeline itself and read rows inside it. */
const drawn = () => screen.findByLabelText("This material's history, leg by leg");

beforeEach(() => {
  vi.clearAllMocks();
  fetchTrail.mockResolvedValue(payload(stockReturn()));
});

/**
 * The trail at its two zooms.
 *
 * What is pinned is what fails SILENTLY. A summary that quietly grows back into a
 * twenty-six row wall is the complaint this split answered; a leg dropped from the
 * timeline with nothing saying so is a document a reviewer never learns exists; and a
 * search that can make "it was never bought" and "you are not looking at it" read the
 * same is the one way this screen can actively mislead.
 */
describe("Behind this material — the summary on the return", () => {
  it("shows the shape and the way in, and never the documents themselves", async () => {
    mountSummary();
    await waitFor(() => expect(legs()[0]).toBeInTheDocument());

    // The legs with their sizes, at a glance.
    expect(within(legs()[0]).getByText("Request")).toBeInTheDocument();
    expect(within(legs()[0]).getByText("Issue")).toBeInTheDocument();
    // Not one document row. That is the whole point of the split.
    expect(screen.queryByText("ALC000")).not.toBeInTheDocument();
    expect(screen.queryByText("DSP000")).not.toBeInTheDocument();
    // One way in.
    expect(screen.getByRole("link", { name: /View all 14 documents/ }))
      .toHaveAttribute("href", "/returns/8/trail");
  });

  it("drops the legs this material never went through, and says which in a sentence", async () => {
    mountSummary();
    await waitFor(() => expect(legs()[0]).toBeInTheDocument());

    // Stock served off the shelf: nothing was bought and nothing arrived. Two permanent
    // grey rows saying so on every return is a fact being repeated, not reported.
    expect(within(legs()[0]).queryByText("Purchase")).toBeNull();
    expect(within(legs()[0]).queryByText("Receipt")).toBeNull();
    expect(screen.getByText(/Purchase and Receipt are not part of this trail/))
      .toBeInTheDocument();
  });

  it("keeps a leg that really was travelled, with its documents behind it", async () => {
    fetchTrail.mockResolvedValue(payload([
      doc("INDENT", "REQUEST", { doc_no: "IND0012" }),
      doc("PO", "SOURCING", { doc_no: "PO0013" }),
      doc("MATERIAL_ISSUE", "OUTBOUND", { doc_no: "WHI0022" }),
    ]));
    mountSummary();
    await waitFor(() => expect(legs()[0]).toBeInTheDocument());

    // The rule is derived, not configured: this material WAS bought, so Purchase stands.
    expect(within(legs()[0]).getByText("Purchase")).toBeInTheDocument();
    // And Receipt, between a PO and an issue, is genuinely skipped.
    expect(within(legs()[0]).queryByText("Receipt")).toBeNull();
  });

  it("puts the two documents anybody opens on the screen already addressed", async () => {
    mountSummary();
    expect(await screen.findByRole("link", { name: /IND0012/ }))
      .toHaveAttribute("href", "/indents/5");
    expect(screen.getByRole("link", { name: /WHI0022/ }))
      .toHaveAttribute("href", "/warehouse/material-issues/200");
  });
});

describe("Behind this material — the full page", () => {
  it("draws every document, with no leg left closed", async () => {
    mountPage();
    await drawn();
    expect(within(timeline()).getByText("IND0012")).toBeInTheDocument();
    expect(screen.getByText("ALC000")).toBeInTheDocument();
    expect(screen.getByText("DSP002")).toBeInTheDocument();
    expect(screen.getByText("BHS/NA/2026-27/RET0008")).toBeInTheDocument();
  });

  it("names the legs the material skipped rather than leaving them silently missing", async () => {
    mountPage();
    await drawn();
    expect(within(timeline()).queryByText("Purchase")).toBeNull();
    expect(screen.getAllByText(/Purchase and Receipt/).length).toBeGreaterThan(0);
  });

  it("narrows to a search, and says so per leg rather than redrawing the history", async () => {
    mountPage();
    await drawn();
    fireEvent.change(searchBox(), { target: { value: "bavya" } });

    await waitFor(() => expect(screen.getByText("DSP000")).toBeInTheDocument());
    expect(within(timeline()).queryByText("IND0012")).not.toBeInTheDocument();
    // Request, Allocation and Issue all hold documents and matched none of them. That is
    // a fact about the search — and it must never wear the words that mean "this never
    // happened".
    expect(within(timeline()).getAllByText("Nothing here matches")).toHaveLength(3);
    expect(within(timeline()).queryByText("Never went through this leg")).toBeNull();
    // And the legs themselves do not move: the timeline is the same four it was before a
    // key was pressed, or the page changes shape while somebody is typing into it.
    expect(within(timeline()).getAllByRole("heading").map((h) => h.textContent))
      .toEqual(["Request", "Allocation", "Issue", "Return"]);
  });

  it("says nothing matched, and hands the whole trail back", async () => {
    mountPage();
    await drawn();
    fireEvent.change(searchBox(), { target: { value: "zzzz" } });

    expect(await screen.findByText(/No document on this trail matches/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Show all 14 again"));
    await drawn();
    expect(within(timeline()).getByText("IND0012")).toBeInTheDocument();
  });

  it("makes the document number the link, and leaves one with no screen as plain text", async () => {
    mountPage();
    await drawn();
    const link = screen.getByRole("link", { name: "Open IND0012" });
    expect(link).toHaveAttribute("href", "/indents/5");
    expect(link).toHaveAttribute("target", "_blank");
    // Only the indent carries a stage-by-stage screen of its own.
    expect(screen.getByRole("link", { name: /The complete journey of IND0012/ }))
      .toHaveAttribute("href", "/indents/5/journey");
    // The intent addresses nothing: a claim the return makes, not a document.
    expect(screen.queryByRole("link", { name: /Open INTENT/ })).toBeNull();
  });

  it("leads back to the return it belongs to", async () => {
    mountPage();
    await drawn();
    expect(screen.getByRole("button", { name: /Back to return details/ }))
      .toBeInTheDocument();
  });
});
