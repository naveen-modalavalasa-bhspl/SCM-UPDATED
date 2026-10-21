import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/shared/auth/AuthContext", () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock("@/shared/packing/api", async (orig) => ({
  ...(await orig<object>()),
  usePackOptions: () => ({ data: {
    7: [{ hierarchy_id: 1, name: "Strip of 10", base_uom: "TAB", levels: [
      { item_packaging_id: null, level: 0, name: "Loose", size: 1, ratio: 1, label: "" },
      { item_packaging_id: 11, level: 1, name: "Strip", size: 10, ratio: 10, label: "" },
      { item_packaging_id: 12, level: 2, name: "Box", size: 100, ratio: 10, label: "" }] }],
  } }),
}));
const rungs = [
  { id: 11, item_id: 7, hierarchy_id: 1, level: 1, package_id: 101, package_name: "Strip",
    quantity: 10, is_active: true },
  { id: 12, item_id: 7, hierarchy_id: 1, level: 2, package_id: 102, package_name: "Box",
    quantity: 10, is_active: true },
];
const list = vi.fn();
vi.mock("../api", () => ({
  mastersApi: {
    packHierarchies: {
      list: () => Promise.resolve({ items: [
        { id: 1, item_id: 7, name: "Strip of 10", is_default: true, is_active: true },
        { id: 2, item_id: 7, name: "Strip of 15", is_default: false, is_active: true }] }),
    },
    itemPackaging: {
      list: (p: unknown) => { list(p); return Promise.resolve({ items: rungs }); },
      breakdown: () => Promise.resolve([]),
    },
    packaging: {
      list: () => Promise.resolve({ items: [
        { id: 101, code: "STR", name: "Strip", is_active: true },
        { id: 102, code: "BOX", name: "Box", is_active: true },
        { id: 103, code: "CTN", name: "Carton", is_active: true }] }),
    },
  },
}));

const { ItemPackHierarchies } = await import("../components/ItemMasterTab");

describe("an item's pack hierarchies", () => {
  it("lists every hierarchy with its ladder, and edits the default's levels", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ItemPackHierarchies itemId={7} itemName="Paracetamol" baseUom="TAB" />
      </QueryClientProvider>);
    // One dropdown of hierarchies, each option naming its ladder; the default is chosen.
    let options: (string | null)[] = [];
    await waitFor(() => {
      options = Array.from(document.querySelectorAll("select option")).map((o) => o.textContent);
      expect(options).toContain("Strip of 10 (default) — Strip 10 › Box 100 TAB");
    });
    expect(options.some((t) => t?.startsWith("Strip of 15"))).toBe(true);
    expect(screen.getByText("Default")).toBeTruthy();
    // The level list is read for the SELECTED hierarchy, not the whole item.
    await waitFor(() => expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ item_id: 7, hierarchy_id: 1 })));
  });

  it("does not offer a container this hierarchy already uses", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ItemPackHierarchies itemId={7} itemName="Paracetamol" baseUom="TAB" />
      </QueryClientProvider>);
    expect(await screen.findByText(/Containers already in "Strip of 10" are not offered/))
      .toBeTruthy();
    // Strip and Box are used; only Carton is left to choose for level 3.
    // HeroUI keeps every option in a hidden native <select> beside its trigger.
    // Two dropdowns now (hierarchy, container); the container's is the one offering codes.
    let offered: (string | null)[] = [];
    await waitFor(() => {
      offered = Array.from(document.querySelectorAll("select option"))
        .map((o) => o.textContent).filter((t) => !t?.startsWith("Strip of"));
      expect(offered.length).toBeGreaterThan(0);
    });
    expect(offered.some((t) => t?.includes("CTN"))).toBe(true);
    expect(offered.some((t) => t?.includes("BOX") || t?.includes("STR"))).toBe(false);
  });
});
