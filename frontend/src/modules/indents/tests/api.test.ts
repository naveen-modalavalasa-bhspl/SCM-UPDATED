import { beforeEach, describe, expect, it, vi } from "vitest";
import { indentApi } from "../api";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/shared/api/client", () => ({
  api: apiMock,
}));

describe("indents api", () => {
  beforeEach(() => {
    apiMock.get.mockResolvedValue({ data: {} });
    apiMock.post.mockResolvedValue({ data: {} });
    apiMock.put.mockResolvedValue({ data: {} });
    apiMock.delete.mockResolvedValue({ data: undefined });
    vi.clearAllMocks();
  });

  it("exposes the indent operations", () => {
    expect(Object.keys(indentApi).sort()).toEqual(
      [
        "acknowledgments", "activity", "approve", "bookmark", "create", "get", "journey", "list",
        "delete", "notifications", "offices", "pendingApprovals", "reject", "stats", "submit", "unbookmark",
        "update",
      ].sort(),
    );
  });

  it("removes cleared filter values from API query parameters", async () => {
    await indentApi.list({
      search: "Bolt",
      created_date_from: undefined,
      created_date_to: "",
      required_by_from: "",
      required_by_to: undefined,
      status: ["DRAFT", ""],
      priority: [],
      page: 1,
    });

    const params = apiMock.get.mock.calls[0][1].params as URLSearchParams;
    expect(params.get("search")).toBe("Bolt");
    expect(params.getAll("status")).toEqual(["DRAFT"]);
    expect(params.get("page")).toBe("1");
    expect(params.has("created_date_from")).toBe(false);
    expect(params.has("created_date_to")).toBe(false);
    expect(params.has("required_by_from")).toBe(false);
    expect(params.has("required_by_to")).toBe(false);
    expect(params.has("priority")).toBe(false);
  });
});
