import { beforeEach, describe, expect, it, vi } from "vitest";
import { indentApi, masterApi } from "../api";

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

  it("reads BOM choices without requesting the Item Group API", async () => {
    apiMock.get
      .mockResolvedValueOnce({ data: { items: [{ id: 1, name: "Kit", is_active: true }] } })
      .mockResolvedValueOnce({ data: { items: [{ id: 2, bom_id: 1, item_id: 9 }] } });

    await masterApi.boms();
    await masterApi.bomItems(1);

    expect(apiMock.get).toHaveBeenNthCalledWith(1, "/api/boms", {
      params: { size: 500 },
    });
    expect(apiMock.get).toHaveBeenNthCalledWith(2, "/api/bom-items", {
      params: { bom_id: 1, size: 500 },
    });
    expect(apiMock.get).not.toHaveBeenCalledWith(
      "/api/item-groups",
      expect.anything(),
    );
  });
});
