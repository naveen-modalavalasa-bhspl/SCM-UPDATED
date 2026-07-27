import { describe, expect, it } from "vitest";
import { rbacApi } from "../api";

describe("RBAC api", () => {
  it("owns users, groups, roles and access controls", () => {
    expect(Object.keys(rbacApi).sort()).toEqual([
      "featureAccess", "groups", "hcmRoles", "pageAccess", "roles",
      "setFeatureAccess", "setPageAccess", "users",
    ]);
  });

  it("exposes user-access operations", () => {
    expect(Object.keys(rbacApi.users).sort()).toEqual(
      ["grant", "list", "resetPassword", "revoke", "setRoles", "summary"],
    );
  });
});
