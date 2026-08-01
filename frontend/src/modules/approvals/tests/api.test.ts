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
    await approvalsApi.teamQueue();
    expect(apiMock.get.mock.calls.map((call) => call[0])).toEqual([
      "/api/approvals/pending",
      "/api/approvals/my-decisions",
      "/api/approvals/team-queue",
    ]);
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
      2, "/api/approvals/indents/12/return", { comments: "correct the item" },
    );
  });
});
