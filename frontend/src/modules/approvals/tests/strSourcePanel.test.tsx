import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/api/client", () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

import { api } from "@/shared/api/client";
import { StrSourcePanel } from "../components/StrSourcePanel";
import { isRejectedLine, signedTotal, wasReducedBelow } from "../quantityRules";
import { strDecision } from "../strDecision";
import type { ApprovalIndentLine, StrSourceReview } from "../types";

const mockGet = api.get as unknown as ReturnType<typeof vi.fn>;
const mockPost = api.post as unknown as ReturnType<typeof vi.fn>;

const review = (over: Partial<StrSourceReview> = {}): StrSourceReview => ({
  indent_id: 5, indent_no: "STR-0005",
  source: { warehouse_id: 20, warehouse_name: "LIP Two", tier_label: "Local Inventory Point", held_by: ["Ravi"] },
  destination: { warehouse_id: 10, warehouse_name: "LIP One", tier_label: "Local Inventory Point", held_by: [] },
  in_scope: true, is_last_level: false, stage_name: "OE",
  levels: [
    { sequence: 1, role_name: "OE", state: "CURRENT" },
    { sequence: 2, role_name: "District Manager", state: "NEXT" },
  ],
  next_level: { sequence: 2, role_name: "District Manager", state: "NEXT" },
  fully_served: false, allocated: [],
  lines_owing: 1,
  source_lines: [{ line_id: 1, owed_quantity: 10, free_quantity: 4 }],
  my_points: [], changes: [],
  ...over,
});

const myPoint = {
  warehouse_id: 30, warehouse_name: "My LIP", tier_label: "Local Inventory Point",
  covers_full: 1, covers_any: 1, lines: [{ line_id: 1, free_quantity: 12 }],
};

function renderPanel(props: Partial<Parameters<typeof StrSourcePanel>[0]> = {}) {
  const onForward = vi.fn();
  const onForwarded = vi.fn();
  const onAllocated = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <StrSourcePanel
        indentId={5}
        lines={{ 1: { name: "Gloves", unit: "NOS" } }}
        signed={[{ line_id: 1, approved_quantity: 10 }]}
        ready
        onForward={onForward}
        onForwarded={onForwarded}
        onAllocated={onAllocated}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onForward, onForwarded, onAllocated };
}

describe("StrSourcePanel", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  it("says approval ends with this approver when the source covers everything", async () => {
    mockGet.mockResolvedValue({ data: review({
      source_lines: [{ line_id: 1, owed_quantity: 10, free_quantity: 10 }],
    }) });
    renderPanel();
    expect(await screen.findByText(/approval ends with you/i)).toBeTruthy();
  });

  it("offers allocate-from-source in scope, says how much it gives, and where the rest goes", async () => {
    mockGet.mockResolvedValue({ data: review() });
    renderPanel();
    expect(await screen.findByText(/In your scope/i)).toBeTruthy();
    expect(screen.getByText("4 of 10 NOS")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Approve & allocate from LIP Two/i })).toBeTruthy();
    expect(screen.getByText(/stays owed and goes to District Manager/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /forward to next level/i })).toBeNull();
  });

  it("draws the ladder, marking the level signing now", async () => {
    mockGet.mockResolvedValue({ data: review() });
    renderPanel();
    const rail = await screen.findByRole("list", { name: /approval levels/i });
    expect(rail.textContent).toContain("OE");
    expect(rail.textContent).toContain("District Manager");
    expect(rail.querySelector('[aria-current="step"]')?.textContent).toContain("OE");
  });

  it("offers forward and change-source when the source is outside scope", async () => {
    mockGet.mockResolvedValue({ data: review({ in_scope: false, my_points: [myPoint] }) });
    const { onForward } = renderPanel();
    expect(await screen.findByText(/Outside your scope/i)).toBeTruthy();
    expect(screen.getByText(/held by Ravi/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Approve and forward to next level/i }));
    expect(onForward).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Change source to my point/i })).toBeTruthy();
  });

  it("asks for the missing level at the top of the ladder, and never offers to send it on", async () => {
    mockGet.mockResolvedValue({ data: review({ in_scope: false, is_last_level: true, next_level: null }) });
    renderPanel();
    expect(await screen.findByText(/no next level is configured/i)).toBeTruthy();
    expect(screen.getByText(/Settings > Approvals Config/i)).toBeTruthy();
    expect(screen.queryByText(/send to source/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /forward to next level/i })).toBeNull();
  });

  it("reads as a sign-off when everything is already allocated", async () => {
    mockGet.mockResolvedValue({ data: review({
      fully_served: true, lines_owing: 0, source_lines: [],
      allocated: [{ allocation_no: "ALL-1", signed: true, allocated_by_name: "Asha",
                    item_name: "Gloves", uom_code: "NOS", quantity: 10, warehouse_name: "LIP Two" }],
    }) });
    renderPanel();
    expect(await screen.findByText(/Everything is already allocated/i)).toBeTruthy();
    expect(screen.getByText(/Stock reserved/i)).toBeTruthy();
    expect(screen.getByText(/by Asha/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /allocate from/i })).toBeNull();
  });

  it("moves the source only with a reason, and sends the approver's quantities", async () => {
    mockGet.mockResolvedValue({ data: review({ in_scope: false, my_points: [myPoint] }) });
    mockPost.mockResolvedValue({ data: { closed: true, indent_id: 5 } });
    const { onAllocated } = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /Change source to my point/i }));
    const confirm = await screen.findByRole("button", { name: /Move to My LIP & allocate/i });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/chosen point is not under me/i),
                     { target: { value: "Closer to the site" } });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(onAllocated).toHaveBeenCalled());
    expect(mockPost).toHaveBeenCalledWith("/api/approvals/indents/5/str-allocate", {
      source_warehouse_id: 30, reason: "Closer to the site",
      items: [{ line_id: 1, approved_quantity: 10 }],
    });
  });

  it("can change the source and forward it without allocating", async () => {
    mockGet.mockResolvedValue({ data: review({ in_scope: false, my_points: [myPoint] }) });
    mockPost.mockResolvedValue({ data: {} });
    const { onForwarded, onAllocated } = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /Change source to my point/i }));
    fireEvent.click(await screen.findByRole("radio", { name: /Only change the source/i }));
    fireEvent.change(screen.getByPlaceholderText(/chosen point is not under me/i),
                     { target: { value: "Closer" } });
    fireEvent.click(screen.getByRole("button", { name: /Change source & forward/i }));
    await waitFor(() => expect(onForwarded).toHaveBeenCalled());
    expect(onAllocated).not.toHaveBeenCalled();
    expect(mockPost).toHaveBeenCalledWith("/api/approvals/indents/5/str-forward", {
      source_warehouse_id: 30, reason: "Closer", items: [{ line_id: 1, approved_quantity: 10 }],
    });
  });

  it("has no forward-only choice at the last level", async () => {
    mockGet.mockResolvedValue({ data: review({ in_scope: false, is_last_level: true, next_level: null, my_points: [myPoint] }) });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /Change source to my point/i }));
    await screen.findByRole("button", { name: /Move to My LIP & allocate/i });
    expect(screen.queryByRole("radio", { name: /Only change the source/i })).toBeNull();
  });
});

describe("strDecision", () => {
  it("blocks only at the top of the ladder, outside scope, with something owed", () => {
    const blocked = strDecision(review({ in_scope: false, is_last_level: true, next_level: null }));
    expect(blocked.canApprove).toBe(false);
    expect(blocked.message).toMatch(/Approvals Config/);

    expect(strDecision(review({ in_scope: true, is_last_level: true })).canApprove).toBe(true);
    expect(strDecision(review({ in_scope: false, is_last_level: false })).canApprove).toBe(true);
    expect(strDecision(review({ in_scope: false, is_last_level: true, lines_owing: 0 })).canApprove).toBe(true);
  });

  it("asks a reason only of someone forwarding a source that is not theirs", () => {
    expect(strDecision(review({ in_scope: false })).needsReason).toBe(true);
    expect(strDecision(review({ in_scope: true })).needsReason).toBe(false);
    expect(strDecision(review({ in_scope: false, lines_owing: 0 })).needsReason).toBe(false);
  });

  it("names the button for what it does, and never says send to source", () => {
    expect(strDecision(review()).label).toBe("Approve and forward to next level");
    expect(strDecision(review({ lines_owing: 0 })).label).toBe("Approve");
    expect(strDecision(review({ is_last_level: true, lines_owing: 0 })).label).toBe("Approve");
    expect(strDecision(review({ is_last_level: true })).label).toBe("Approve without allocating");
    expect(strDecision(undefined).label).toBe("Approve");
  });
});

describe("a line part-served by a level below", () => {
  const line = (over: Partial<ApprovalIndentLine> = {}): ApprovalIndentLine => ({
    id: 1, item_id: 1, requested_quantity: 10, approved_quantity: 4, max_quantity: 4,
    served_quantity: 6, ...over,
  });

  it("signs the whole line, so what is still owed survives", () => {
    expect(signedTotal(line(), "4")).toBe(10);
    expect(signedTotal(line(), "3")).toBe(9);
    expect(signedTotal(line({ served_quantity: undefined }), "4")).toBe(4);
  });

  it("is not mistaken for a cut or a rejection", () => {
    expect(wasReducedBelow(line())).toBe(false);
    expect(wasReducedBelow(line({ served_quantity: 3 }))).toBe(true);
    expect(isRejectedLine(line({ max_quantity: 0 }), "0")).toBe(false);
    expect(isRejectedLine(line({ served_quantity: 0 }), "0")).toBe(true);
  });
});
