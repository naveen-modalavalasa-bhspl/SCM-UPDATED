import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/api/client", () => ({
  api: { get: vi.fn() },
}));

import { api } from "@/shared/api/client";
import { adminApi } from "../api";

const mockGet = api.get as unknown as ReturnType<typeof vi.fn>;

describe("app logs api", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockResolvedValue({
      data: { items: [], total: 0, page: 1, size: 25 },
    });
  });

  it("calls the protected App Logs endpoint with every supported filter", async () => {
    const params = {
      source: "BACKEND",
      level: "ERROR",
      status_code: 500,
      search: "failure",
      endpoint: "/api/stock",
      source_file: "backend/app/service.py",
      function_name: "load_stock",
      message: "database",
      request_id: "request-123",
      page: 2,
      size: 25,
    };

    await adminApi.appLogs.list(params);

    expect(mockGet).toHaveBeenCalledWith(
      "/api/admin/app-logs",
      { params },
    );
  });
});
