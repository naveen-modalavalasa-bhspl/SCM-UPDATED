import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/api/client", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import { api } from "@/shared/api/client";
import { ToastProvider } from "@/shared/components";
import { EndpointsPanel } from "../components/EndpointsPanel";

const mockGet = api.get as unknown as ReturnType<typeof vi.fn>;
const mockPost = api.post as unknown as ReturnType<typeof vi.fn>;

/** A clip shaped exactly like `export_endpoints` produces one. */
const CLIP = JSON.stringify({
  kind: "scm-api-endpoints",
  v: 1,
  endpoints: [{ slug: "hcm-employees", name: "Employees", table: "hcm_employees" }],
});

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockGet.mockImplementation((url: string) => {
    if (url.includes("/endpoints")) return Promise.resolve({ data: [] });
    if (url.includes("/tables")) return Promise.resolve({ data: [] });
    return Promise.resolve({ data: [] });
  });
});

const renderPanel = () =>
  render(
    <QueryClientProvider client={new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })}>
      <ToastProvider>
        <EndpointsPanel clientCode="AIMS" />
      </ToastProvider>
    </QueryClientProvider>,
  );

const openTheBox = async () => {
  fireEvent.click(await screen.findByText("Paste APIs"));
  fireEvent.change(screen.getByPlaceholderText("Paste a copied set of APIs here"),
                   { target: { value: CLIP } });
};

describe("Pasting a set of APIs", () => {
  /**
   * The refusal is the whole point of the all-or-nothing rule, and it is the ONLY
   * thing that tells somebody why nothing happened. Before this, the server's reason
   * was written to state rendered only inside the Build-an-API dialog — closed during
   * a paste — so pressing the button produced no error, no toast and no change, and
   * read as a dead button.
   */
  it("shows the server's reason when the whole clip is refused", async () => {
    mockPost.mockRejectedValue({
      response: {
        data: {
          error: "1 of 1 endpoints could not be imported, so none were: "
                 + "hcm-employees: that address already belongs to BCAMS",
        },
      },
    });

    renderPanel();
    await openTheBox();
    fireEvent.click(screen.getByText("Add to this application"));

    await waitFor(() =>
      expect(screen.getByText(/already belongs to BCAMS/)).toBeInTheDocument());
  });

  it("shows the reason for a Replace too, not only for an Add", async () => {
    mockPost.mockRejectedValue({
      response: { data: { error: "that address already belongs to BCAMS" } },
    });

    renderPanel();
    await openTheBox();
    fireEvent.click(screen.getByText("Replace everything here"));

    await waitFor(() =>
      expect(screen.getByText(/already belongs to BCAMS/)).toBeInTheDocument());
  });

  it("says so when the box does not hold a copied set at all", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("Paste APIs"));
    fireEvent.change(screen.getByPlaceholderText("Paste a copied set of APIs here"),
                     { target: { value: "not json" } });
    fireEvent.click(screen.getByText("Add to this application"));

    await waitFor(() =>
      expect(screen.getByText(/not a copied set of APIs/)).toBeInTheDocument());
    expect(mockPost).not.toHaveBeenCalled();
  });

  /**
   * Seeding a second application is the whole point of the clip, and it now needs no
   * renaming: an address is filed under its application, so AIMS gets its own
   * /hcm-employees beside BCAMS'.
   */
  it("sends the clip with its addresses untouched", async () => {
    mockPost.mockResolvedValue({
      data: { created: 1, updated: 0, retired: 0, total: 1 },
    });

    renderPanel();
    await openTheBox();
    fireEvent.click(screen.getByText("Add to this application"));

    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    const [url, body] = mockPost.mock.calls[0];
    expect(url).toContain("/clients/AIMS/endpoints/import");
    expect(body).toMatchObject({ replace: false });
    expect((body as { clip: { endpoints: { slug: string }[] } }).clip.endpoints[0].slug)
      .toBe("hcm-employees");
  });

  it("clears the last refusal when a fresh paste succeeds", async () => {
    mockPost.mockRejectedValueOnce({
      response: { data: { error: "already belongs to BCAMS" } },
    });
    renderPanel();
    await openTheBox();
    fireEvent.click(screen.getByText("Add to this application"));
    await waitFor(() =>
      expect(screen.getByText(/already belongs to BCAMS/)).toBeInTheDocument());

    mockPost.mockResolvedValueOnce({
      data: { created: 1, updated: 0, retired: 0, total: 1 },
    });
    fireEvent.click(screen.getByText("Add to this application"));

    await waitFor(() =>
      expect(screen.queryByText(/already belongs to BCAMS/)).not.toBeInTheDocument());
  });
});
