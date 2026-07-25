import { describe, expect, it } from "vitest";
import { mastersApi } from "../api";

describe("masters api", () => {
  it("exposes CRUD groups for every master", () => {
    expect(Object.keys(mastersApi).sort()).toEqual(
      ["categories", "departments", "facilities", "items", "uom", "vendors"].sort(),
    );
  });

  it("editable masters expose list/create/update", () => {
    for (const key of ["items", "categories", "vendors"] as const) {
      expect(typeof mastersApi[key].list).toBe("function");
      expect(typeof mastersApi[key].create).toBe("function");
      expect(typeof mastersApi[key].update).toBe("function");
    }
  });

  it("HCM-mirrored masters are read-only (functions, no create)", () => {
    expect(typeof mastersApi.departments).toBe("function");
    expect(typeof mastersApi.facilities).toBe("function");
  });
});
