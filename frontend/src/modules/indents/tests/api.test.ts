import { beforeEach, describe, expect, it, vi } from "vitest";
import { indentApi, indentKeys, masterApi, normalizeIndentQueryParams } from "../api";

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
        "acknowledge", "acknowledgments", "activity", "approve", "bookmark", "create",
        "delete", "deleteReceiptAttachment", "fulfilment", "get", "journey", "list",
        "myDeliveries", "notifications", "offices", "receiptAttachments", "regions",
        "reject", "resubmitCorrection", "returnForCorrection", "stats",
        "submit", "unbookmark", "update", "uploadReceiptAttachment", "vehicles",
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

  it("keys the All Requests query by pagination and every visible filter", () => {
    const scope = { employeeId: 1, activePositionId: 10 };
    const filters = {
      page: 2,
      size: 50,
      search: "Bolt",
      created_date_from: "2026-07-01",
      created_date_to: "2026-07-31",
      status: ["APPROVED"],
      priority: ["HIGH"],
    };

    expect(indentKeys.list(scope, filters)).toEqual([
      "indents-module",
      1,
      10,
      "list",
      filters,
    ]);
  });

  it("versions Journey cache entries so pre-evidence timelines cannot stay authoritative", () => {
    const scope = { employeeId: 1, activePositionId: 10 };

    expect(indentKeys.journey(scope, 42)).toEqual([
      "indents-module",
      1,
      10,
      "journey",
      5,
      42,
    ]);
    expect(indentKeys.journey(scope, 42)).not.toEqual([
      "indents-module",
      1,
      10,
      "journey",
      42,
    ]);
  });

  it("normalizes equivalent filter sets for stable query keys", () => {
    const normalized = normalizeIndentQueryParams({
      search: "",
      status: ["REJECTED", "DRAFT"],
      priority: [],
      department_id: [20, 10],
      page: 1,
    });

    expect(normalized).toEqual({
      status: ["DRAFT", "REJECTED"],
      department_id: [10, 20],
      page: 1,
    });
  });

  it("isolates Activity and Notification caches by employee and active position", () => {
    const filters = normalizeIndentQueryParams({
      status: ["REJECTED", "DRAFT"],
      page: 1,
      size: 20,
    });
    const firstScope = { employeeId: 1, activePositionId: 10 };
    const secondEmployee = { employeeId: 2, activePositionId: 10 };
    const secondPosition = { employeeId: 1, activePositionId: 20 };

    expect(indentKeys.activity(firstScope, filters)).not.toEqual(
      indentKeys.activity(secondEmployee, filters),
    );
    expect(indentKeys.activity(firstScope, filters)).not.toEqual(
      indentKeys.activity(secondPosition, filters),
    );
    expect(indentKeys.notifications(firstScope, filters)).not.toEqual(
      indentKeys.notifications(secondEmployee, filters),
    );
    expect(indentKeys.notifications(firstScope, filters)).not.toEqual(
      indentKeys.notifications(secondPosition, filters),
    );
  });

  it("passes AbortSignals to filter-sensitive requests", async () => {
    const listController = new AbortController();
    const statsController = new AbortController();
    const activityController = new AbortController();
    const notificationsController = new AbortController();

    await indentApi.list({ status: ["DRAFT"] }, listController.signal);
    await indentApi.stats({ status: ["DRAFT"] }, statsController.signal);
    await indentApi.activity(
      { transaction_type: "REQUEST_REJECTED" },
      activityController.signal,
    );
    await indentApi.notifications(
      { status: ["ALLOCATED"] },
      notificationsController.signal,
    );

    expect(apiMock.get).toHaveBeenNthCalledWith(1, "/api/indents", expect.objectContaining({
      signal: listController.signal,
    }));
    expect(apiMock.get).toHaveBeenNthCalledWith(2, "/api/indents/stats", expect.objectContaining({
      signal: statsController.signal,
    }));
    expect(apiMock.get).toHaveBeenNthCalledWith(3, "/api/indents/activity", expect.objectContaining({
      signal: activityController.signal,
    }));
    const activityParams = apiMock.get.mock.calls[2][1].params as URLSearchParams;
    expect(activityParams.get("transaction_type")).toBe("REQUEST_REJECTED");
    expect(activityParams.has("status")).toBe(false);
    expect(apiMock.get).toHaveBeenNthCalledWith(4, "/api/indents/notifications", expect.objectContaining({
      signal: notificationsController.signal,
    }));
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
