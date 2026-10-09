import { describe, expect, it } from "vitest";
import { rbacApi } from "../api";

describe("RBAC api", () => {
  it("owns users, groups, roles, access controls, matrix and reporting", () => {
    expect(Object.keys(rbacApi).sort()).toEqual([
      "featureAccess", "groups", "hcmRoles", "jobProfiles", "matrix", "orgTree",
      "pageAccess", "permissionHolders", "reporting", "roles", "setFeatureAccess",
      "setPageAccess", "users", "viewAs",
    ]);
  });

  it("exposes user-access operations", () => {
    expect(Object.keys(rbacApi.users).sort()).toEqual(
      ["filters", "grant", "list", "resetPassword", "revoke", "setRoles", "summary"],
    );
  });

  it("exposes role lifecycle + matrix operations", () => {
    expect(Object.keys(rbacApi.matrix).sort()).toEqual([
      "cloneRole", "createRole", "deleteRole", "permissions", "roles",
      "setPermissions", "updateRole",
    ]);
  });

  it("groups own their region source", () => {
    expect(typeof rbacApi.groups.regions).toBe("function");
    expect(typeof rbacApi.reporting).toBe("function");
  });
});
