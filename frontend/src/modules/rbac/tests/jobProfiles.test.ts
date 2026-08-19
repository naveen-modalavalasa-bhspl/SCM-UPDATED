import { describe, expect, it } from "vitest";
import {
  buildAccessSections, buildClip, featureHint, pageDisplayName, pageHint,
  parseClip, sectionSummary,
} from "../pages/JobProfilesPage";
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
 * sees in the left rail. The two halves of the grant can disagree about its name —
 * the menu says "Settings" where the permission catalogue says "admin", and until
 * the rename it said "Purchasing" against "procurement". They must still land in one
 * card, or the module tick grants the screens and silently skips every action inside
 * them. Procurement is here as the case that now agrees on both sides: the grouping
 * has to keep working with no alias at all, not only through one.
 */
describe("buildAccessSections", () => {
  const parent = page("grp_purchasing", "Procurement", null);
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
    const procurement = sections.find((s) => s.name === "Procurement");
    expect(procurement?.pages.map((p) => p.code)).toEqual(["grp_purchasing", "po_list"]);
    expect(procurement?.features.map((f) => f.code)).toEqual(["po.create", "po.approve"]);
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
      .toEqual(["Home", "Procurement"]);
  });

  /* Logistics used to be a set of screens filed under Warehouse, and the alias that
     recorded that outlived it: once Logistics became a module row of its own, the two
     collapsed into one card — and because Logistics sorts first, the card was called
     Logistics and the Warehouse module vanished from the screen entirely. Two module
     rows in the rail are two cards here. */
  it("keeps Logistics and Warehouse as separate cards", () => {
    const logistics = page("grp_logistics", "Logistics", null);
    const warehouse = page("grp_warehouse", "Warehouse", null);
    const sections = buildAccessSections(
      [logistics, page("logistics_transport", "Transport Requests", logistics.id),
       warehouse, page("wh_grn", "Goods Receipt", warehouse.id)],
      [{ code: "transport.view", module: "logistics", description: "View transport" },
       { code: "receipt.view", module: "warehouse", description: "View receipts" }],
    );
    expect(sections.map((s) => s.name)).toEqual(["Logistics", "Warehouse"]);
    expect(sections[1].pages.map((p) => p.code))
      .toEqual(["grp_warehouse", "wh_grn"]);
    expect(sections[1].features.map((f) => f.code)).toEqual(["receipt.view"]);
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

describe("Indents screen help", () => {
  const indents = [
    page("grp_indents", "Indents", null),
    page("ind_dashboard", "Overview", null),
    page("ind_list", "All Requests", null),
    page("ind_deliveries", "My Deliveries", null),
    page("ind_ack", "Acknowledgments", null),
    page("ind_reports", "Activity Ledger", null),
    page("ind_notifications", "Notifications", null),
  ];

  it("gives every Indents option a short plain-language hover description", () => {
    expect(indents.map(pageHint)).toEqual([
      "Open the Indents module and use the screens selected below.",
      "See a quick summary of indent activity and recent requests.",
      "View all indent requests and check their current status.",
      "Track approved requests and confirm the items that were received.",
      "Confirm which requested items have been received.",
      "Review the history of indent activity and status changes.",
      "View alerts and updates about indent requests.",
    ]);
    expect(indents.map(pageHint).every((hint) => !hint.includes("Grants"))).toBe(true);
  });

  it("renames only the Notifications option in this matrix", () => {
    expect(indents.map(pageDisplayName)).toEqual([
      "Indents",
      "Overview",
      "All Requests",
      "My Deliveries",
      "Acknowledgments",
      "Activity Ledger",
      "Alerts and Notifications",
    ]);
    expect(indents.at(-1)?.code).toBe("ind_notifications");
  });
});

describe("Indents action help", () => {
  const actions = [
    ["indent.acknowledge", "Acknowledge receipt of indent goods"],
    ["indent.approve", "Approve indents"],
    ["indent.create", "Create indents"],
    ["indent.delete", "Delete indents"],
    ["indent.edit", "Edit indents"],
    ["indent.reject", "Reject indents"],
    ["indent.submit", "Submit indents for approval"],
    ["indent.view", "View indents"],
    ["indent.view.fulfilment", "View approved indents awaiting fulfilment, raised by anyone"],
  ].map(([code, description]) => ({ code, module: "indents", description }));

  it("gives every shown Indents action a simple hover description", () => {
    expect(actions.map(featureHint)).toEqual([
      "Confirm that the goods requested in an indent have been received.",
      "Review an indent and approve it so it can move to fulfilment.",
      "Create a new indent request for required goods or materials.",
      "Delete an indent request that is no longer needed.",
      "Change the details of an existing indent before it is processed.",
      "Reject an indent and stop it from moving forward.",
      "Send a created indent to the approver for review.",
      "Open and view indent requests and their details.",
      "See approved indents from any user that are waiting for goods to be issued.",
    ]);
    expect(actions.map(featureHint).every((hint) => !hint.includes("Grants"))).toBe(true);
  });
});

describe("plain-language help for the remaining modules", () => {
  const pageCodes = [
    "approvals", "approval_waiting", "approval_decisions",
    "grp_purchasing", "po_list",
    "grp_warehouse", "wh_dashboard", "wh_inward", "wh_grn", "wh_qc",
    "wh_putaway", "wh_picklist", "wh_issues", "wh_consignments", "wh_dispatch",
    "wh_returns", "wh_notifications", "wh_reports", "wh_masters",
    "grp_inventory", "inv_overview", "inv_balance", "inv_ledger",
    "inv_replenishment", "inv_transfers", "inv_fulfillment",
    "inv_allocation_approvals", "inv_stocking_points", "inv_mr", "inv_labels",
    "masters",
    "grp_reports", "rep_indents", "rep_approvals", "rep_inventory", "rep_warehouse",
    "grp_rbac", "rbac_access", "rbac_groups",
    "grp_settings", "admin", "admin_settings", "admin_rules", "admin_workflows",
    "admin_approvals_config", "admin_policies", "admin_numbering",
    "admin_notifications", "admin_audit", "admin_fallback", "admin_app_logs",
    "admin_code_formats",
  ];

  const actionCodes = [
    "po.view", "po.create", "po.edit", "po.submit", "po.approve", "po.reject",
    "po.send_vendor",
    "grn.view", "grn.create", "grn.qc",
    "stock.view", "stock.view.all", "stock.adjust", "stock.reserve",
    "stock.valuation.view", "stock.transfer", "stock.view.subtree",
    "stock.points.manage", "stock.transfer.approve",
    "allocation.view", "allocation.create", "allocation.approve", "allocation.reject",
    "allocation.submit", "allocation.approve_reserve",
    "mr.view", "mr.create", "mr.approve", "mr.reject",
    "issue.view", "issue.create", "issue.issue", "issue.forward",
    "receipt.view", "receipt.create", "receipt.post",
    "inspection.view", "inspection.execute", "putaway.view", "putaway.execute",
    "picking.view", "picking.pick", "dispatch.view", "dispatch.create",
    "dispatch.approve", "dispatch.gate_out", "dispatch.acknowledge",
    "return.view", "return.create", "return.approve", "warehouse.report.view",
    "receipt.delete", "inspection.delete", "putaway.delete", "picking.delete",
    "issue.delete", "dispatch.delete", "return.delete", "movement.delete",
    "master.item.manage", "master.vendor.manage", "master.category.manage",
    "master.uom.manage", "master.location.manage", "master.project.manage",
    "master.brand.manage", "master.class.manage", "master.packaging.manage",
    "master.feature.manage", "master.attribute.manage", "master.price.manage",
    "master.bom.manage", "master.spec.manage", "master.hsn.manage",
    "report.view", "report.export",
    "admin.roles.manage", "admin.workflow.manage", "admin.users.manage",
    "admin.groups.manage", "admin.rules.manage", "admin.numbering.manage",
    "admin.audit.view", "admin.notifications.manage", "admin.settings.manage",
    "admin.code_formats.manage",
  ];

  it("has simple help for every screen option in the requested modules", () => {
    const hints = pageCodes.map((code) => pageHint(page(code, "Option", null)));
    expect(hints).toHaveLength(pageCodes.length);
    expect(hints.every((hint) => !hint.includes("Grants"))).toBe(true);
    expect(hints.every((hint) => !hint.includes("Option"))).toBe(true);
  });

  it("has simple help for every action option in the requested modules", () => {
    const hints = actionCodes.map((code) => featureHint({
      code, module: "requested-module", description: "Option",
    }));
    expect(hints).toHaveLength(actionCodes.length);
    expect(hints.every((hint) => !hint.includes("Grants"))).toBe(true);
    expect(hints.every((hint) => !hint.includes("Option"))).toBe(true);
  });
});

/* Copying a profile's access onto another one. The clip is the wire format between
 * two screens-in-one-browser, so a malformed or stale one must be refused whole —
 * half a grant applied is worse than none. */
describe("permission set clipboard", () => {
  it("round-trips a profile's access", () => {
    const text = buildClip("Store Keeper", "OFFICE",
      ["page.b.view", "page.a.view"], ["stock.issue"]);
    const parsed = parseClip(text);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.clip.from).toBe("Store Keeper");
    expect(parsed.clip.scope).toBe("OFFICE");
    expect(parsed.clip.pages).toEqual(["page.a.view", "page.b.view"]);
    expect(parsed.clip.features).toEqual(["stock.issue"]);
  });

  it("refuses anything that is not a copied permission set", () => {
    expect(parseClip("hello")).toHaveProperty("error");
    expect(parseClip('{"pages":["page.a.view"]}')).toHaveProperty("error");
    expect(parseClip('{"kind":"scm-job-profile-access","v":2,"pages":[],"features":[]}'))
      .toHaveProperty("error");
    expect(parseClip('{"kind":"scm-job-profile-access","v":1,"pages":[]}'))
      .toHaveProperty("error");
  });
});
