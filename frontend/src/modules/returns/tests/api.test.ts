import { describe, expect, it, vi, beforeEach } from "vitest";
import { returnsApi } from "../api";
import { api } from "@/shared/api/client";

vi.mock("@/shared/api/client", () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

const mocked = api as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocked.get.mockResolvedValue({ data: { items: [], total: 0, page: 1, size: 20 } });
  mocked.post.mockResolvedValue({ data: { id: 1 } });
  mocked.put.mockResolvedValue({ data: { id: 1 } });
  mocked.delete.mockResolvedValue({ data: null });
});

describe("returns api", () => {
  it("drops empty filters instead of sending them", async () => {
    // `status=""` reads on the backend as a status nobody has, which emptied the grid
    // the moment a filter was cleared.
    await returnsApi.list({ page: 2, status: "", search: "", mine_only: false });
    expect(mocked.get).toHaveBeenCalledWith("/api/returns", { params: { page: 2 } });
  });

  it("keeps the filters that were actually set", async () => {
    await returnsApi.list({ status: "PENDING_APPROVAL", search: "RET", mine_only: true });
    expect(mocked.get).toHaveBeenCalledWith("/api/returns", {
      params: { status: "PENDING_APPROVAL", search: "RET", mine_only: true },
    });
  });

  it("posts a rejection comment where the backend reads it", async () => {
    await returnsApi.reject(7, "wrong item");
    expect(mocked.post).toHaveBeenCalledWith("/api/returns/7/reject", {
      comments: "wrong item",
    });
  });

  it("uploads under the field name the endpoint reads", async () => {
    const file = new File(["x"], "damage.jpg", { type: "image/jpeg" });
    await returnsApi.upload(3, file, "RETURN_PHOTO");

    const [url, form, config] = mocked.post.mock.calls[0];
    expect(url).toBe("/api/returns/3/attachments");
    expect(form).toBeInstanceOf(FormData);
    // `file`, not `upload`: FastAPI reads the part by name and a mismatch is a 422.
    expect((form as FormData).get("file")).toBe(file);
    expect(config).toEqual({ params: { doc_category: "RETURN_PHOTO" } });
  });

  it("reads a return by id", async () => {
    mocked.get.mockResolvedValue({ data: { id: 5, return_no: "RET-2026-00005" } });
    const doc = await returnsApi.get(5);
    expect(mocked.get).toHaveBeenCalledWith("/api/returns/5");
    expect(doc.return_no).toBe("RET-2026-00005");
  });
});
