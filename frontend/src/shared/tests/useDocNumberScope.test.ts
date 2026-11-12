import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDocNumberScope } from "../useDocNumberScope";

/** The number card on a document that MAY have one before it (2026-11-12) — purchase
 *  return, indent return, transport request, vendor payment. Mirrors the server's
 *  `scope.carry_or_select`. */
const po = {
  organization_id: 2, organization_name: "BAVYA", project_id: 77, project_name: "104-MMU",
  org_department_id: null, org_department_name: null, fiscal_year: "2025-26",
};

describe("useDocNumberScope", () => {
  it("copies an organised source, locks it, and leaves the year to this document", () => {
    const { result } = renderHook(() => useDocNumberScope({
      editing: false, carried: po, carriedLabel: "PO0012" }));
    expect(result.current.value.organizationId).toBe(2);
    expect(result.current.value.projectId).toBe(77);
    expect(result.current.value.fiscalYear).toBe("");          // never the source's year
    expect(result.current.locks).toMatchObject({ organisation: true, project: true });
    expect(result.current.source).toEqual({ label: "PO0012" });
    expect(result.current.ready).toBe(false);                  // no defaults over a copy
  });

  it("is open, and fills its defaults, with nothing behind it", () => {
    const { result } = renderHook(() => useDocNumberScope({ editing: false, carried: null }));
    expect(result.current.locks).toEqual({});
    expect(result.current.ready).toBe(true);
    expect(result.current.source).toBeNull();
  });

  it("waits for a source still loading before it fills defaults", () => {
    const { result } = renderHook(() => useDocNumberScope({
      editing: false, carried: null, sourceLoading: true }));
    expect(result.current.ready).toBe(false);
  });

  it("shows a saved document fixed, and an older one not at all", () => {
    const saved = renderHook(() => useDocNumberScope({ editing: true, saved: po }));
    expect(saved.result.current.locks).toEqual({ all: true });
    expect(saved.result.current.value.fiscalYear).toBe("2025-26"); // its own year
    const older = renderHook(() => useDocNumberScope({
      editing: true, saved: { organization_id: null } }));
    expect(older.result.current.older).toBe(true);
  });
});
