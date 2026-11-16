import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalsApi } from "../api";

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));

vi.mock("@/shared/api/client", () => ({ api: apiMock }));

describe("approvals api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.get.mockResolvedValue({ data: { items: [] } });
    apiMock.post.mockResolvedValue({ data: {} });
    apiMock.put.mockResolvedValue({ data: {} });
  });

  it("uses only the approvals module for the operational approval queue", async () => {
    await approvalsApi.pending();
    await approvalsApi.decisions();
    await approvalsApi.consolidation();
    expect(apiMock.get.mock.calls.map((call) => call[0])).toEqual([
      "/api/approvals/pending",
      "/api/approvals/my-decisions",
      "/api/approvals/consolidation",
    ]);
  });

  it("sends consolidation filters as query params on the one consolidation call", async () => {
    // One request carries every applied dimension — the screen must never fan out
    // into a call per filter, and the dropdown contents ride back on the same response.
    await approvalsApi.consolidation({ cycle: "2026-08", region_id: "5", item_id: "9" });
    expect(apiMock.get).toHaveBeenCalledWith("/api/approvals/consolidation", {
      params: { cycle: "2026-08", region_id: "5", item_id: "9" },
    });
    expect(apiMock.get).toHaveBeenCalledTimes(1);
  });

  it("sends editable quantities with an indent approval", async () => {
    await approvalsApi.approveIndent(12, [{ line_id: 8, approved_quantity: 3 }], "checked");
    expect(apiMock.post).toHaveBeenCalledWith("/api/approvals/indents/12/approve", {
      items: [{ line_id: 8, approved_quantity: 3 }],
      comments: "checked",
    });
  });

  it("sends pagination and queue filters to the backend", async () => {
    await approvalsApi.pending(3, 20, { doc_type: "INDENT", search: "IND/12" });
    await approvalsApi.decisions(2, 20, { decision: "REJECTED" });
    expect(apiMock.get).toHaveBeenNthCalledWith(1, "/api/approvals/pending", {
      params: { page: 3, size: 20, doc_type: "INDENT", search: "IND/12" },
    });
    expect(apiMock.get).toHaveBeenNthCalledWith(2, "/api/approvals/my-decisions", {
      params: { page: 2, size: 20, decision: "REJECTED" },
    });
  });

  it("sends rejection reasons and correction instructions", async () => {
    await approvalsApi.rejectIndent(12, "wrong quantity");
    await approvalsApi.returnIndent(12, "correct the item");
    expect(apiMock.post).toHaveBeenNthCalledWith(
      1, "/api/approvals/indents/12/reject", { comments: "wrong quantity" },
    );
    expect(apiMock.post).toHaveBeenNthCalledWith(
      // Return for correction is an indents-module route: it pauses the approval on
      // the same instance rather than ending it, so the indent owns the transition.
      2, "/api/indents/12/return-for-correction", { comments: "correct the item" },
    );
  });

  it("sends the chosen step when an indent is returned to an earlier one", async () => {
    await approvalsApi.returnIndent(12, "start again", 0);
    await approvalsApi.returnIndent(12, "fix the item", 2);
    // Step 0 is the requester. It is a real answer, so it must be sent, not dropped.
    expect(apiMock.post).toHaveBeenNthCalledWith(
      1, "/api/indents/12/return-for-correction", { comments: "start again", target_sequence: 0 },
    );
    expect(apiMock.post).toHaveBeenNthCalledWith(
      2, "/api/indents/12/return-for-correction", { comments: "fix the item", target_sequence: 2 },
    );
  });

  it("asks the indents module which earlier steps a return can go to", async () => {
    apiMock.get.mockResolvedValueOnce({ data: [{ sequence: 0, is_requester: true, is_default: false }] });
    const targets = await approvalsApi.returnTargets(12);
    expect(apiMock.get).toHaveBeenCalledWith("/api/indents/12/return-targets");
    expect(targets).toEqual([{ sequence: 0, is_requester: true, is_default: false }]);
  });
});
