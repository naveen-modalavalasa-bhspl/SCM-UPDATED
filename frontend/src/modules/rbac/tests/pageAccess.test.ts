import { describe, expect, it } from "vitest";
import { groupPagesByPermission } from "../pages/UsersPage";
import type { PageAccessMatrix } from "../types";

type AccessPage = PageAccessMatrix["pages"][number];

const page = (
  code: string, name: string, required_permission: string | null,
): AccessPage => ({ code, name, required_permission, always_on: required_permission === null });

/**
 * Access lives in rbac_role_permissions only — there is no per-page grant. Pages that
 * share a required_permission are therefore one switch, and the matrix has to say so.
 */
describe("groupPagesByPermission", () => {
  const pages = [
    page("ind_list", "All requests", "indent.view"),
    page("ind_board", "Board", "indent.view"),
    page("approvals", "Waiting for me", "indent.view"),
    page("inv_balance", "Stock Balance", "stock.view"),
    page("home", "My Desk", null),
  ];

  it("collapses pages sharing one permission into a single column", () => {
    const groups = groupPagesByPermission(pages);
    expect(groups).toHaveLength(3);
    expect(groups[0].permission).toBe("indent.view");
    expect(groups[0].pages.map((p) => p.code)).toEqual(["ind_list", "ind_board", "approvals"]);
    expect(groups[1].pages.map((p) => p.code)).toEqual(["inv_balance"]);
  });

  it("keeps always-on pages standing alone and read-only", () => {
    const always = groupPagesByPermission(pages).filter((g) => g.alwaysOn);
    expect(always).toHaveLength(1);
    expect(always[0].pages.map((p) => p.code)).toEqual(["home"]);
    expect(always[0].permission).toBeNull();
  });

  /* Two always-on pages must not merge into one column just because both have a null
     permission — they are unrelated, they simply cannot be switched off. */
  it("does not merge separate always-on pages", () => {
    const groups = groupPagesByPermission([
      page("home", "My Desk", null),
      page("profile", "Profile", null),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("loses no page", () => {
    const total = groupPagesByPermission(pages).reduce((n, g) => n + g.pages.length, 0);
    expect(total).toBe(pages.length);
  });
});
