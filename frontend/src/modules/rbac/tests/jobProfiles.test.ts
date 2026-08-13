import { describe, expect, it } from "vitest";
import { buildAccessSections, sectionSummary } from "../pages/JobProfilesPage";
import type { JobProfileMatrix } from "../types";

type MatrixPage = JobProfileMatrix["pages"][number];

let nextId = 1;
const page = (
  code: string, name: string, parent_id: number | null,
  required_permission: string | null = `page.${code}.view`,
): MatrixPage => ({
  id: nextId++, code, name, parent_id, module: null,
  always_on: required_permission === null, required_permission,
});

/**
 * A job profile is granted per MODULE, and the module has to be the one the admin
 * sees in the left rail. The two halves of the grant disagree about its name: the
 * menu says "Purchasing" and "Settings", the permission catalogue says
 * "procurement" and "admin". They must still land in one card, or the module tick
 * grants the screens and silently skips every action inside them.
 */
describe("buildAccessSections", () => {
  const parent = page("grp_purchasing", "Purchasing", null);
  const pages = [
    page("home", "Home", null, null),
    parent,
    page("po_list", "Purchase Orders", parent.id),
  ];
  const features = [
    { code: "po.create", module: "procurement", description: "Create purchase orders" },
    { code: "po.approve", module: "procurement", description: "Approve purchase orders" },
  ];

  it("files a module's actions under the name the menu gives it", () => {
    const sections = buildAccessSections(pages, features);
    const purchasing = sections.find((s) => s.name === "Purchasing");
    expect(purchasing?.pages.map((p) => p.code)).toEqual(["grp_purchasing", "po_list"]);
    expect(purchasing?.features.map((f) => f.code)).toEqual(["po.create", "po.approve"]);
    expect(sections.some((s) => s.name === "procurement")).toBe(false);
  });

  it("puts admin actions on the Settings card", () => {
    const settings = page("grp_settings", "Settings", null);
    const sections = buildAccessSections(
      [settings],
      [{ code: "admin.audit.view", module: "admin", description: "View the audit log" }],
    );
    expect(sections).toHaveLength(1);
    expect(sections[0].name).toBe("Settings");
    expect(sections[0].features).toHaveLength(1);
  });

  it("keeps a top-level page in a card of its own", () => {
    const sections = buildAccessSections(pages, features);
    expect(sections.find((s) => s.name === "Home")?.pages.map((p) => p.code))
      .toEqual(["home"]);
  });

  /* Menu order is the backend's sort_order. Cards must follow it, so the screen
     reads top to bottom the way the rail does. */
  it("keeps the order the pages arrived in", () => {
    expect(buildAccessSections(pages, features).map((s) => s.name))
      .toEqual(["Home", "Purchasing"]);
  });

  it("loses no action when its module has no screens at all", () => {
    const sections = buildAccessSections(
      [], [{ code: "x.do", module: "orphan", description: "Do x" }],
    );
    expect(sections.map((s) => s.name)).toEqual(["Orphan"]);
    expect(sections[0].features).toHaveLength(1);
  });
});

describe("sectionSummary", () => {
  it("names the screens, then counts the rest", () => {
    expect(sectionSummary(["Overview", "All Requests"], 0))
      .toBe("Sees Overview, All Requests");
    expect(sectionSummary(["A", "B", "C", "D", "E"], 0)).toBe("Sees A, B, C +2 more");
  });

  it("calls out actions granted without a screen to open", () => {
    expect(sectionSummary([], 1)).toBe("1 action, no screens");
    expect(sectionSummary([], 3)).toBe("3 actions, no screens");
  });

  it("says nothing is granted plainly", () => {
    expect(sectionSummary([], 0)).toBe("No access");
  });
});
