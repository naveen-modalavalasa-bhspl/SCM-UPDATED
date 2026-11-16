import { describe, expect, it } from "vitest";
import { departmentOf, isHoldingNumber, isOlderDocument } from "../orgScope";
import { emptyOrgValue, orgMissing, orgPayload, orgValueCarried, orgValueFrom } from "../components/OrgFields";
import { blankPOHeader, poHeaderPayload } from "../components/POHeaderFields";

describe("organisation on a procurement document", () => {
  it("asks for the organisation, then for a project or a department", () => {
    const empty = emptyOrgValue();
    expect(orgMissing(empty)).toMatch(/organisation/);
    expect(orgMissing({ ...empty, organizationId: 2 })).toMatch(/project or the department/);
    expect(orgMissing({ ...empty, organizationId: 2, projectId: 7 })).toBeNull();
    expect(orgMissing({ ...empty, organizationId: 2, orgDepartmentId: 1 })).toBeNull();
  });

  it("tells an older document from an auto-raised draft waiting for its number", () => {
    expect(isHoldingNumber("DRAFT-37-A1B2C3")).toBe(true);
    expect(isHoldingNumber("NA/104/2026-27/REQ0001")).toBe(false);
    expect(isOlderDocument({ organization_id: null }, "NA/104/2026-27/REQ0001")).toBe(true);
    expect(isOlderDocument({ organization_id: null }, "DRAFT-37-A1B2C3")).toBe(false);
    expect(isOlderDocument({ organization_id: 2 }, "BAV/104/2026-27/REQ0001")).toBe(false);
  });

  it("an older document sends its old fields and nothing new", () => {
    const value = { ...emptyOrgValue(), departmentId: 9 as number, companyName: "BHS" };
    expect(orgPayload(value, true)).toEqual({
      warehouse_id: null, project_id: null, department_id: 9, company_name: "BHS",
    });
    expect(orgPayload({ ...emptyOrgValue(), organizationId: 2, orgDepartmentId: 1 })).toEqual({
      warehouse_id: null, project_id: null, organization_id: 2, org_department_id: 1,
      fiscal_year: null,
    });
  });

  it("a new document raised from another does not inherit its year", () => {
    const source = { organization_id: 2, project_id: 7, fiscal_year: "2025-26" };
    expect(orgValueFrom(source).fiscalYear).toBe("2025-26");
    expect(orgValueCarried(source).fiscalYear).toBe("");
    expect(orgValueCarried(source).organizationId).toBe(2);
  });

  it("a PO is booked to one of project and department", () => {
    const header = { ...blankPOHeader(), organizationId: 2 as number,
                     projectId: 7 as number, orgDepartmentId: 1 as number };
    const sent = poHeaderPayload(header);
    expect(sent.organization_id).toBe(2);
    expect(sent.project_id).toBe(7);
    expect(sent.org_department_id).toBeNull();
    expect(sent.department_id).toBeUndefined();
  });

  it("reads the department from whichever source the document has", () => {
    expect(departmentOf({ org_department_name: "HR", department_name: "Old" })).toBe("HR");
    expect(departmentOf({ department_name: "Old" })).toBe("Old");
    expect(departmentOf({})).toBeNull();
  });
});
