import { describe, expect, it } from "vitest";
import {
  docNumberPayload, numberWillChange, openingValues, raiserScope,
  type DocNumberCardData, type DocNumberValue,
} from "../documentNumber";

const card = (over: Partial<DocNumberCardData> = {}): DocNumberCardData => ({
  doc_type: "po", pattern: "{COMPANY}/{PROJECT}/{FY}/{PREFIX}{SEQ:4}", prefix: "PO",
  fields: [], fiscal_years: ["2026-27", "2025-26"], current_fiscal_year: "2026-27",
  organisations: [{ id: 2, name: "BAVYA" }, { id: 1, name: "Sample Org" }],
  departments: [{ id: 2, name: "HUMAN RESOURCES" }],
  projects: [{ id: 7, name: "104" }, { id: 8, name: "108" }, { id: 9, name: "MMU" }],
  default_organization_id: 2, own_project_id: null,
  ...over,
});
const empty: DocNumberValue = { organizationId: "", projectId: "", orgDepartmentId: "", fiscalYear: "" };

describe("what a new document opens on", () => {
  it("takes the configured organisation and today's year, and does not ask to check them", () => {
    const { patch, guessed } = openingValues(card(), empty, { defaultProject: false });
    expect(patch).toEqual({ organizationId: 2, fiscalYear: "2026-27" });
    expect(guessed).toEqual([]);
  });

  it("asks to check an organisation that is only the first in the list", () => {
    const { patch, guessed } = openingValues(card({ default_organization_id: null }), empty);
    expect(patch.organizationId).toBe(2);
    expect(guessed).toContain("organisation");
  });

  it("prefers the person's own project, then their last choice, then a checked guess", () => {
    expect(openingValues(card({ own_project_id: 8 }), empty, { lastProject: 9 }).patch.projectId).toBe(8);
    expect(openingValues(card(), empty, { lastProject: 9 }).patch.projectId).toBe(9);
    const first = openingValues(card(), empty);
    expect(first.patch.projectId).toBe(7);
    expect(first.guessed).toContain("project");
  });

  it("ignores a remembered project that is no longer offered", () => {
    expect(openingValues(card(), empty, { lastProject: 500 }).patch.projectId).toBe(7);
  });

  it("never overwrites what the document before it supplied", () => {
    const carried = { ...empty, organizationId: 1 as const, projectName: "104" };
    const { patch } = openingValues(card(), carried);
    expect(patch).toEqual({ fiscalYear: "2026-27" });
    const byDepartment = { ...empty, organizationId: 1 as const, orgDepartmentId: 2 as const };
    expect(openingValues(card(), byDepartment).patch.projectId).toBeUndefined();
  });

  it("leaves locked fields alone", () => {
    const { patch } = openingValues(card(), empty, { locks: { organisation: true, project: true } });
    expect(patch).toEqual({ fiscalYear: "2026-27" });
  });
});

describe("a saved draft's number", () => {
  it("stays while the selection prints the same", () => {
    expect(numberWillChange("BAV/104/2026-27/PO0007", "BAV/104/2026-27/PO####")).toBe(false);
  });

  it("changes when any printed part moves, including the year", () => {
    expect(numberWillChange("BAV/104/2026-27/PO0007", "SAM/104/2026-27/PO####")).toBe(true);
    expect(numberWillChange("BAV/104/2026-27/PO0007", "BAV/104/2025-26/PO####")).toBe(true);
  });

  it("has nothing to lose on a holding reference or before anything is complete", () => {
    expect(numberWillChange("DRAFT-37-A1B2C3", "BAV/104/2026-27/REQ####")).toBe(false);
    expect(numberWillChange("BAV/104/2026-27/PO0007", null)).toBe(false);
    expect(numberWillChange(null, "BAV/104/2026-27/PO####")).toBe(false);
  });
});

// Indents, STRs and monthly indents (2026-11-09): what HCM fixes for the raiser is filled
// and locked, the same values `scope.resolve_for_raiser` fixes on save.

describe("what HCM fixes for the person raising", () => {
  it("locks the configured organisation and the person's project, and keeps the department out", () => {
    const { locks, patch } = raiserScope(card({
      organisation_fixed: true, mapped_project_id: 8, mapped_project_name: "108",
    }));
    expect(locks.organisation && locks.project && locks.department).toBe(true);
    expect(patch).toMatchObject({ organizationId: 2, projectId: 8, orgDepartmentId: "" });
  });

  it("falls back to the department when there is no project", () => {
    const { locks, patch } = raiserScope(card({
      mapped_org_department_id: 2, mapped_org_department_name: "HUMAN RESOURCES",
    }));
    expect(locks.department && locks.project).toBe(true);
    expect(patch).toMatchObject({ orgDepartmentId: 2, projectId: "" });
    expect(locks.organisation).toBeFalsy();   // no default configured: still selectable
  });

  it("leaves both open when HCM fixes neither", () => {
    const { locks, patch } = raiserScope(card());
    expect(locks.project || locks.department).toBeFalsy();
    expect(patch.projectId).toBeUndefined();
  });
});

describe("what goes on the wire", () => {
  it("sends the project, or the department when there is none, never both", () => {
    expect(docNumberPayload({ ...empty, organizationId: 2, projectId: 7, orgDepartmentId: 2 }))
      .toEqual({ organization_id: 2, project_id: 7, org_department_id: null, fiscal_year: null });
    expect(docNumberPayload({ ...empty, organizationId: 2, orgDepartmentId: 2, fiscalYear: "2026-27" }))
      .toEqual({ organization_id: 2, project_id: null, org_department_id: 2, fiscal_year: "2026-27" });
  });
});
