/* RBAC > Job Profiles.
 *
 * The screen the Page/Feature Control matrices should have been. Those grant
 * against an HCM role, and HCM role 29 "MANAGER" covers fifteen unrelated jobs —
 * Inventory Manager, Chief Procurement Officer, Logistics Executive, four Senior
 * Executives. Tick Inventory there and all fifteen get Inventory.
 *
 * A job profile is the real job, derived from the position (see the backend
 * profiles.py for the rule). 3,733 live positions collapse to ~42 profiles:
 * DEO's 957 become one row, and MANAGER splits into the twelve it always was.
 *
 * Nothing here changes behaviour until a profile is saved. An unconfigured
 * profile still resolves through its old HCM role, which is why the list leads
 * with that badge — it is the only thing that tells you what is live.
 *
 * LAYOUT: one card per module, named exactly as the left rail names it, holding
 * BOTH halves of the grant — the screens under that module and the actions inside
 * it. They used to be two separate matrices, so every module appeared twice under
 * two different spellings ("Purchasing" in one, "procurement" in the other) and the
 * module tick in one half could not reach the other. A half-granted module is the
 * shape of an access bug, so the two now move together, under one name.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Tooltip } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, BarChart3, Boxes, Check, CheckCircle, ChevronRight, ClipboardPaste,
  Copy, Database, FileText, Home, Package, RotateCcw, Settings as SettingsIcon,
  Shield, ShoppingCart, Truck, Undo2, Users,
} from "lucide-react";
import {
  Button, Card, EmptyState, ErrorBanner, Field, Input, PageHeader, Select,
  ScrollBox, selectOnFocus, useToast,
} from "@/shared/components";
import { useDebouncedValue } from "@/shared/hooks/useDebouncedValue";
import { rbacApi } from "../api";
import type { JobProfileMatrix, ScopeRung } from "../types";

type MatrixPage = JobProfileMatrix["pages"][number];
type MatrixFeature = JobProfileMatrix["features"][number];

const SCOPE_HELP: Record<ScopeRung, string> = {
  SELF: "Only documents this person raised.",
  OFFICE: "Everything in their own office.",
  SUBTREE: "Their position and everyone reporting under it.",
  PROJECT: "Everything in their HCM project.",
  ALL: "The whole network. Nothing is hidden.",
};

const SCOPE_LABEL: Record<ScopeRung, string> = {
  SELF: "Own documents",
  OFFICE: "Own office",
  SUBTREE: "Own reporting line",
  PROJECT: "Own project",
  ALL: "Everything",
};

/* ---- Copy / paste a profile's access -------------------------------------
 * A grant is a set of codes, so it travels as one: copy Store Keeper, paste onto
 * the next profile, choose whether it ADDS to what is there or REPLACES it. The
 * clipboard string is versioned JSON so a stale one from an older build is
 * refused rather than half-applied. Nothing is saved by pasting — it only fills
 * the draft, and the existing Save button (and the backend check behind it) is
 * still the one thing that writes. Unknown codes are dropped and counted, so a
 * profile copied from a project that has a screen this one does not cannot smuggle
 * a code past the matrix.
 */
type AccessClip = {
  v: 1; kind: "scm-job-profile-access";
  from: string; scope: ScopeRung; pages: string[]; features: string[];
};

export const buildClip = (
  from: string, scope: ScopeRung, pages: string[], features: string[],
): string => JSON.stringify({
  v: 1, kind: "scm-job-profile-access", from, scope,
  pages: [...pages].sort(), features: [...features].sort(),
} satisfies AccessClip, null, 2);

/** Returns the clip, or a plain-English reason it cannot be used. */
export function parseClip(text: string): { clip: AccessClip } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    return { error: "That is not a copied permission set." };
  }
  const clip = raw as Partial<AccessClip>;
  if (!clip || clip.kind !== "scm-job-profile-access") {
    return { error: "That is not a copied permission set." };
  }
  if (clip.v !== 1) return { error: "That was copied by a different version." };
  if (!Array.isArray(clip.pages) || !Array.isArray(clip.features)) {
    return { error: "That copied permission set is incomplete." };
  }
  return { clip: clip as AccessClip };
}

/** Compared on letters alone: the menu says "Warehouse", the permission catalogue
 *  says "warehouse". */
const letters = (value: string) => value.replace(/[^a-z]/gi, "").toLowerCase();

/** The two halves of a grant name some modules differently. The menu name wins —
 *  it is the word the admin sees everywhere else in the app — so the permission
 *  catalogue's spelling is translated into it before anything is grouped.
 *  Without this, ticking a module granted its screens and none of its actions.
 *
 *  `procurement` used to be aliased to "purchasing" and no longer is: the menu row
 *  was renamed to Procurement, so both halves finally spell it the same way. */
const MODULE_ALIAS: Record<string, string> = {
  admin: "settings",           // menu: Settings
  indent: "indents",
  master: "masters",
  report: "reports",
  // `logistics` was aliased to "warehouse" back when the outward leg was a handful of
  // screens filed under the Warehouse group. It stopped being true on 2026-08-17, when
  // Logistics became a module row of its own (grp_logistics) — and the stale alias then
  // collapsed both modules into ONE card. Logistics sorts first (its children are
  // sort_order 1-7 against Warehouse's 40-59), so it won the card's name and the whole
  // Warehouse module — 17 screens and 29 actions — disappeared from Job Profiles.
  // Two module rows in the rail are two cards here; neither side needs an alias now.
};

const moduleKey = (name: string) => {
  const key = letters(name);
  return MODULE_ALIAS[key] ?? key;
};

const ICONS: Record<string, typeof Boxes> = {
  home: Home,
  indents: FileText,
  approvals: CheckCircle,
  procurement: ShoppingCart,
  warehouse: Truck,
  inventory: Package,
  masters: Database,
  reports: BarChart3,
  rbac: Shield,
  settings: SettingsIcon,
};

/** One module = one card: the screens filed under it, and the actions inside it. */
export interface AccessSection {
  /** Exactly the name the module carries in the left rail. */
  name: string;
  pages: MatrixPage[];
  features: MatrixFeature[];
}

/**
 * Group the whole grant by module, in menu order.
 *
 * Pages come already sorted by the backend (`sort_order`), so pushing them in order
 * keeps every card and every row reading the way the rail does. Actions join the
 * card their module names; an action whose module has no screens at all still gets
 * a card of its own rather than silently disappearing.
 */
export function buildAccessSections(
  pages: MatrixPage[], features: MatrixFeature[],
): AccessSection[] {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const sections: AccessSection[] = [];
  const index = new Map<string, AccessSection>();

  const section = (name: string) => {
    const key = moduleKey(name);
    const found = index.get(key);
    if (found) return found;
    const created: AccessSection = { name, pages: [], features: [] };
    index.set(key, created);
    sections.push(created);
    return created;
  };

  for (const page of pages) {
    const parent = page.parent_id ? byId.get(page.parent_id) : undefined;
    section(parent ? parent.name : page.name).pages.push(page);
  }
  for (const feature of features) {
    const key = moduleKey(feature.module);
    const target = index.get(key)
      ?? section(feature.module.charAt(0).toUpperCase() + feature.module.slice(1));
    target.features.push(feature);
  }
  return sections;
}

/**
 * The one line under a module name that answers "what will they actually see?"
 * without opening the card — the screens, by the names they carry in the app.
 * A module granted actions but no screens says so: that combination is almost
 * always a mistake, and it is invisible otherwise.
 */
export function sectionSummary(granted: string[], actionsOn: number): string {
  if (granted.length) {
    const shown = granted.slice(0, 3).join(", ");
    return `Sees ${shown}${granted.length > 3 ? ` +${granted.length - 3} more` : ""}`;
  }
  if (actionsOn) return `${actionsOn} action${actionsOn === 1 ? "" : "s"}, no screens`;
  return "No access";
}

/** Plain-language help for the screen options shown in Job Profiles. Keep this
 *  local to the matrix: these are explanatory labels, not permission identities. */
const PLAIN_PAGE_HELP: Record<string, { label?: string; hint: string }> = {
  grp_indents: {
    hint: "Open the Indents module and use the screens selected below.",
  },
  ind_dashboard: {
    hint: "See a quick summary of indent activity and recent requests.",
  },
  ind_list: {
    hint: "View all indent requests and check their current status.",
  },
  ind_deliveries: {
    hint: "Track approved requests and confirm the items that were received.",
  },
  ind_ack: {
    hint: "Confirm which requested items have been received.",
  },
  ind_reports: {
    hint: "Review the history of indent activity and status changes.",
  },
  ind_notifications: {
    label: "Alerts and Notifications",
    hint: "View alerts and updates about indent requests.",
  },
  approvals: {
    hint: "Open the Approvals module and use the approval screens selected below.",
  },
  approval_waiting: {
    hint: "See requests that are currently waiting for your approval.",
  },
  approval_decisions: {
    hint: "Review requests that you have already approved or rejected.",
  },
  grp_purchasing: {
    hint: "Open the Procurement module: requisitions, RFQs, quotations and POs.",
  },
  po_list: {
    hint: "View purchase orders and check their current status.",
  },
  grp_warehouse: {
    hint: "Open the Warehouse module and use the warehouse screens selected below.",
  },
  wh_dashboard: {
    hint: "See a quick summary of warehouse activity and pending work.",
  },
  wh_inward: {
    hint: "Record and track materials arriving at the warehouse.",
  },
  wh_grn: {
    hint: "Record goods received from a vendor against an order.",
  },
  wh_qc: {
    hint: "Check received goods and record whether they pass inspection.",
  },
  wh_qc_outward: {
    hint: "Check and complete quality inspections for outward material issues.",
  },
  wh_putaway: {
    hint: "See and complete tasks for placing received stock into storage bins.",
  },
  wh_picklist: {
    hint: "See which items must be picked from storage for fulfilment.",
  },
  wh_issues: {
    hint: "Record stock issued from the warehouse to a department.",
  },
  wh_material_returns: {
    hint: "Record stock coming back into the warehouse from a department.",
  },
  wh_segregation: {
    hint: "Split received stock into good, damaged and rejected before it is put away.",
  },
  wh_stock_movements: {
    hint: "Move stock between bins and storage areas inside the warehouse.",
  },
  wh_ack: {
    hint: "Confirm that a dispatched consignment arrived at the receiving site.",
  },
  wh_consignments: {
    hint: "Group and track goods that are being prepared for delivery.",
  },
  wh_dispatch: {
    hint: "Prepare and track goods leaving the warehouse.",
  },
  wh_returns: {
    hint: "Record and track goods being returned to a vendor.",
  },
  wh_notifications: {
    hint: "View alerts and updates about warehouse work.",
  },
  wh_reports: {
    hint: "View reports about warehouse receipts, issues, and dispatches.",
  },
  wh_masters: {
    hint: "Set up warehouse locations, storage areas, and related details.",
  },
  grp_inventory: {
    hint: "Open the Inventory module and use the inventory screens selected below.",
  },
  inv_overview: {
    hint: "See a quick summary of stock levels and inventory activity.",
  },
  inv_balance: {
    hint: "Check how much stock is currently available at each location.",
  },
  inv_ledger: {
    hint: "Review the history of stock received, moved, adjusted, or issued.",
  },
  inv_replenishment: {
    hint: "See items that may need more stock and plan replenishment.",
  },
  inv_transfers: {
    label: "Stock Transfer",
    hint: "Request stock (STR), serve it, and follow each transfer order (STO) to receipt. "
      + "Every tab has its own Stock Transfer action below, and each works ONLY on stock "
      + "transfer documents — never on an ordinary indent or warehouse issue.",
  },
  inv_fulfilment_desk: {
    hint: "Decide how much stock each indent gets, and sign it off — one screen.",
  },
  // Retired 2026-08-21, replaced by the Fulfilment Desk above. The hints stay: the
  // rows are only parked (is_active = 0), so an admin who un-parks one must still see
  // what it was for rather than a bare page code.
  inv_fulfillment: {
    hint: "Retired — replaced by the Fulfilment Desk.",
  },
  inv_allocation_approvals: {
    hint: "Retired — replaced by the Fulfilment Desk.",
  },
  inv_stocking_points: {
    hint: "Set up which positions are responsible for each stocking point.",
  },
  inv_mr: {
    hint: "Create and track requests for materials needed by inventory.",
  },
  inv_labels: {
    hint: "Create and print labels for stock items.",
  },
  inv_stock_edits: {
    label: "Stock Corrections",
    hint: "Correct a held batch (batch no., mfg / expiry date) or unit (serial, IMEI, asset / "
      + "consumable code). Every correction goes through the Stock Correction approval ladder.",
  },
  masters: {
    hint: "Set up the shared item, vendor, category, and other master records.",
  },
  grp_reports: {
    hint: "Open the Reports module and view records from across the system.",
  },
  rep_indents: {
    hint: "Review a report of indent requests and their current status.",
  },
  rep_approvals: {
    hint: "Review a report of approval steps and decisions.",
  },
  rep_inventory: {
    hint: "Review a report of stock quantities and stock movements.",
  },
  rep_warehouse: {
    hint: "Review a report of warehouse receipts, issues, and dispatches.",
  },
  grp_rbac: {
    hint: "Open access-control screens for roles, permissions, and user groups.",
  },
  rbac_access: {
    hint: "Choose which screens and actions each role or job profile can use.",
  },
  rbac_groups: {
    hint: "Create user groups and manage who belongs to each group.",
  },
  grp_settings: {
    hint: "Open system administration and configuration screens.",
  },
  admin: {
    hint: "Manage HCM synchronization and important system configuration.",
  },
  admin_settings: {
    hint: "Update company details and general application settings.",
  },
  admin_rules: {
    hint: "Set up rules that control automatic system decisions.",
  },
  admin_workflows: {
    hint: "Set up the approval steps used for different types of documents.",
  },
  admin_approvals_config: {
    hint: "Choose which positions approve each document for each project.",
  },
  admin_policies: {
    hint: "Configure approval policies and automatic processing rules.",
  },
  admin_numbering: {
    hint: "Set the numbering format used for business documents.",
  },
  admin_notifications: {
    hint: "Configure which system events create notifications.",
  },
  admin_audit: {
    hint: "Review a history of important actions performed in the system.",
  },
  admin_fallback: {
    hint: "Review cases where the system had to use a fallback process.",
  },
  admin_app_logs: {
    hint: "Review application messages used to investigate system problems.",
  },
  admin_code_formats: {
    hint: "Set the code format used for assets and consumable items.",
  },
};

export const pageDisplayName = (page: MatrixPage) =>
  PLAIN_PAGE_HELP[page.code]?.label ?? page.name;

/** What ticking a page actually does, said plainly. */
export const pageHint = (page: MatrixPage) => {
  const plainHint = PLAIN_PAGE_HELP[page.code]?.hint;
  if (plainHint) return plainHint;
  return page.always_on
    ? `${page.name} is always visible — every login can open it, and it cannot be `
      + "taken away here."
    : `Lets the holder open ${page.name} and see what is on it.`
      + (page.required_permission
         ? ` Grants "${page.required_permission}".`
         : " This screen has no permission of its own, so it is visible to anyone "
           + "who can reach the module.");
};

/** Plain-language hover help for the actions shown in this matrix. */
const PLAIN_FEATURE_HELP: Record<string, string> = {
  "indent.acknowledge":
    "Confirm that the goods requested in an indent have been received.",
  "indent.approve":
    "Review an indent and approve it so it can move to fulfilment.",
  "indent.create":
    "Create a new indent request for required goods or materials.",
  "indent.delete":
    "Delete an indent request that is no longer needed.",
  "indent.edit":
    "Change the details of an existing indent before it is processed.",
  "indent.reject":
    "Reject an indent and stop it from moving forward.",
  "indent.submit":
    "Send a created indent to the approver for review.",
  "indent.view":
    "Open and view indent requests and their details.",
  "indent.view.fulfilment":
    "See approved indents from any user that are waiting for goods to be issued.",
  "po.view":
    "Open and review purchase orders and their current status.",
  "po.create":
    "Create a new purchase order for goods or services.",
  "po.edit":
    "Change the details of an existing purchase order before it is completed.",
  "po.submit":
    "Send a purchase order to the approver for review.",
  "po.approve":
    "Review a purchase order and approve it to move forward.",
  "po.reject":
    "Reject a purchase order and stop it from moving forward.",
  "po.send_vendor":
    "Send an approved purchase order to the selected vendor.",
  "grn.view":
    "Open and review goods receipt notes.",
  "grn.create":
    "Create a goods receipt note for items received from a vendor.",
  "grn.qc":
    "Record whether received goods pass or fail the quality check.",
  "stock.view":
    "See current stock quantities and item availability.",
  "stock.view.all":
    "See stock in every warehouse, not only the user's own office.",
  "stock.adjust":
    "Correct a stock quantity when the recorded balance is wrong.",
  "stock.edit.view":
    "See stock correction requests and their approval status.",
  "stock.edit.create":
    "Raise a correction to a batch's number or dates, or a unit's serial, IMEI or code.",
  "stock.edit.approve":
    "Approve or reject a stock correction. Approving writes the corrected values.",
  "stock.reserve":
    "Set stock aside so it can be used for a specific request or document.",
  "stock.valuation.view":
    "See the quantity, cost, and total value of stock.",
  "stock.transfer":
    "Raise a stock transfer order (STO) directly — send stock from a point you hold, without a request.",
  "stock.view.subtree":
    "See stock at locations that report under the user's position.",
  "stock.points.manage":
    "Tag positions to stocking points and grant or revoke additional floor access.",
  "stock.transfer.view":
    "See Inventory > Stock Transfer's requests (STR), orders (STO) and their history.",
  "stock.transfer.request":
    "Raise a stock transfer request (STR) — ask another point to send stock here. It is approved on the STR ladder (Settings > Approvals Config).",
  "stock.transfer.str_approve":
    "Approve, reject or return a stock transfer request (STR). Only STRs — not ordinary indents.",
  "stock.transfer.serve":
    "Serve a stock transfer request: pick which of your points gives what (the To serve tab). Only STRs.",
  "stock.transfer.serve_approve":
    "Approve or reject how an STR is being served. Only STRs — not ordinary indent allocations.",
  "stock.transfer.issue":
    "Work a stock transfer's material issue — batch, bay, serials, submit. Only transfer issues.",
  "stock.transfer.issue_post":
    "Approve and post a stock transfer's material issue — the stock leaves the point. Only transfer issues.",
  "stock.transfer.qc":
    "Run the outward QC of a stock transfer (the Outward QC tab). Only transfer QCs.",
  "stock.transfer.qc_approve":
    "Complete, approve or reject a stock transfer's outward QC. Only transfer QCs.",
  "stock.transfer.receive":
    "Acknowledge a stock transfer when it arrives — this credits your point's stock. Only STRs.",
  "stock.transfer.approve":
    "Approve or reject a stock transfer order (STO), on the STO ladder (Settings > Approvals Config).",
  "allocation.view":
    "Open and review how stock has been allocated to indents.",
  "allocation.create":
    "Decide how much available stock should be given to each indent.",
  "allocation.approve":
    "Review and approve a proposed stock allocation.",
  "allocation.reject":
    "Reject a proposed stock allocation so it can be corrected.",
  "allocation.submit":
    "Send a stock allocation from the Fulfilment Queue for approval.",
  "allocation.approve_reserve":
    "Approve a stock allocation and reserve the approved quantity.",
  "mr.view":
    "Open and review material requests and their current status.",
  "mr.create":
    "Create a request for materials needed by inventory.",
  "mr.approve":
    "Review and approve a material request.",
  "mr.reject":
    "Reject a material request and stop it from moving forward.",
  "issue.view":
    "Open and review records of stock issued from the warehouse.",
  "issue.create":
    "Create a new record for stock that will be issued.",
  "issue.issue":
    "Confirm that stock has been issued to a department.",
  "issue.forward":
    "Forward an arrived consignment to a stocking point below the current one.",
  "receipt.view":
    "Open and review records of goods received at the warehouse.",
  "receipt.create":
    "Record goods that have arrived at the warehouse.",
  "receipt.post":
    "Finalize a goods receipt and add the received quantity to stock.",
  "inspection.view":
    "Open and review quality inspections for received goods.",
  "inspection.execute":
    "Record the quality inspection result for received goods.",
  "putaway.view":
    "See tasks for placing received stock into storage bins.",
  "putaway.execute":
    "Confirm that received stock has been placed into its storage bin.",
  "picking.view":
    "See fulfilments that require items to be picked from storage.",
  "picking.pick":
    "Record the items picked from storage for a fulfilment.",
  "dispatch.view":
    "Open and review goods being dispatched from the warehouse.",
  "dispatch.create":
    "Create a dispatch for goods that are ready to leave the warehouse.",
  "dispatch.approve":
    "Review and approve a dispatch before it leaves the warehouse.",
  "dispatch.gate_out":
    "Confirm that a dispatch has left the plant gate.",
  "dispatch.acknowledge":
    "Confirm that the dispatched goods reached their destination.",
  "return.view":
    "Open and review goods being returned to vendors.",
  "return.create":
    "Create a return for goods that must be sent back to a vendor.",
  "return.approve":
    "Review and approve goods before they are returned to a vendor.",
  "warehouse.report.view":
    "View reports about warehouse receipts, issues, and dispatches.",
  "receipt.delete":
    "Delete an unfinished goods receipt that is still a draft.",
  "inspection.delete":
    "Delete an unfinished quality inspection that is still a draft.",
  "putaway.delete":
    "Delete an unfinished put-away task that is still a draft.",
  "picking.delete":
    "Delete an unfinished picklist that is still a draft.",
  "issue.delete":
    "Delete an unfinished stock issue that is still a draft.",
  "dispatch.delete":
    "Delete an unfinished dispatch that is still a draft.",
  "return.delete":
    "Delete an unfinished purchase return that is still a draft.",
  "movement.view":
    "Open and review stock movement orders.",
  "movement.create":
    "Create a new stock movement order to move items between bins.",
  "movement.update":
    "Update an existing stock movement order.",
  "movement.approve":
    "Approve a pending stock movement order.",
  "movement.inspect":
    "Verify approved quantities and tracked identifiers before stock is moved.",
  "movement.complete":
    "Post an inspected movement and transfer stock to its destination locations.",
  "movement.delete":
    "Delete an unfinished stock movement that is still a draft.",
  "master.item.manage":
    "Create and update the items used across purchasing, stock, and warehouse work.",
  "master.vendor.manage":
    "Create and update vendor records and their details.",
  "master.category.manage":
    "Create and update categories used to organize items.",
  "master.uom.manage":
    "Create and update units such as pieces, kilograms, and litres.",
  "master.location.manage":
    "Create and update warehouses, storage areas, and bins.",
  "master.project.manage":
    "Create and update the projects used to organize business records.",
  "master.brand.manage":
    "Create and update the brands assigned to items.",
  "master.class.manage":
    "Create and update the classes used to group similar items.",
  "master.packaging.manage":
    "Create and update packaging types and pack sizes for items.",
  "master.feature.manage":
    "Create and update reusable features that describe items.",
  "master.attribute.manage":
    "Create item attributes and choose which items or categories use them.",
  "master.price.manage":
    "Create and update price lists used for items and vendors.",
  "master.bom.manage":
    "Create and update bills of material that list the items needed for a kit or job.",
  "master.spec.manage":
    "Create and update detailed specifications for items.",
  "master.hsn.manage":
    "Create and update HSN codes and the tax rates linked to them.",
  "report.view":
    "Open and review report ledgers from across the system.",
  "report.export":
    "Download a report ledger as an Excel or CSV file.",
  "admin.roles.manage":
    "Create roles and choose which screens and actions they can use.",
  "admin.workflow.manage":
    "Create and update the approval steps used for business documents.",
  "admin.users.manage":
    "Manage application users and synchronize user details from HCM.",
  "admin.groups.manage":
    "Create user groups and manage who belongs to each group.",
  "admin.rules.manage":
    "Create and update rules that control automatic system decisions.",
  "admin.numbering.manage":
    "Set the numbering formats used for business documents.",
  "admin.audit.view":
    "Review the history of important actions performed in the system.",
  "admin.notifications.manage":
    "Choose which system events create notifications and how they are handled.",
  "admin.settings.manage":
    "Update company details and general application settings.",
  "consolidation.view":
    "Open the consolidated purchase sheets that group requisitions together.",
  "consolidation.create":
    "Roll several purchase requisitions into one consolidated buying sheet.",
  "consolidation.approve":
    "Approve or reject a consolidated purchase sheet before buying starts.",
  "requisition.view":
    "Open purchase requisitions and read what has been asked for.",
  "requisition.create":
    "Raise a purchase requisition and send it for approval.",
  "requisition.approve":
    "Approve or reject a purchase requisition.",
  "rfq.view":
    "Open requests for quotation and read the vendor replies.",
  "rfq.create":
    "Create a request for quotation and send it out to vendors.",
  "rfq.approve":
    "Approve a request for quotation so that it reaches its vendors.",
  "rfq.compare":
    "Open the sheet that puts every vendor quotation side by side.",
  "rfq.award":
    "Choose the winning vendor for a request for quotation.",
  "qc_outward.view":
    "Open the quality checks made on goods before they leave the warehouse.",
  "qc_outward.create":
    "Start a quality check on goods that are about to be sent out.",
  "qc_outward.update":
    "Change an outward quality check while it is still a draft.",
  "qc_outward.approve":
    "Complete an outward quality check and record the result.",
  "qc_outward.export":
    "Download outward quality check records as a file.",
  "qc_outward.delete":
    "Delete an outward quality check that is still a draft.",
  "transport.view":
    "Open shipments and see how goods are travelling.",
  "transport.create":
    "Raise a shipment for a consignment that is ready to move.",
  "transport.approve":
    "Approve or reject a shipment before it is arranged.",
  "transport.award":
    "Give the job to one carrier at an agreed price. The carrier still has to accept it.",
  "transport.track":
    "Keep a shipment up to date while it travels: its docket number, where it has reached, and when it arrived.",
  "transport.acknowledge":
    "Sign at the receiving site to confirm what actually arrived.",
  "transport.exception":
    "Report goods that arrived damaged or short, and close the case once it is settled.",
  "transport.delete":
    "Delete a shipment that is still a draft.",
  "logistics.partner.view":
    "Open the register of transport partners the company uses.",
  "logistics.partner.manage":
    "Add transport partners and issue their portal logins.",
  "vendor.portal.manage":
    "Issue and reset the portal logins that suppliers and carriers sign in with.",
  "return.decide":
    "Decide where returned material should go.",
  "return.endorse":
    "Agree with or object to a decision made on a return.",
  "return.config.manage":
    "Choose which posts receive returned material.",
  "mail.view":
    "Read the company mailbox and the record of mail already sent.",
  "mail.send":
    "Send mail from the company address.",
  "integration.view":
    "See the outside applications connected to this system.",
  "integration.manage":
    "Connect outside applications and set up how they exchange data.",
  "integration.keys.manage":
    "Issue and withdraw the API keys outside applications sign in with.",
  "admin.code_formats.manage":
    "Set how codes are created for assets and consumable items.",
};

/** An action is a verb, not a screen: it decides whether the button works. */
export const featureHint = (feature: MatrixFeature) =>
  PLAIN_FEATURE_HELP[feature.code]
  ?? `${feature.description}. Grants "${feature.code}" — the backend checks this on every `
    + "request, so it is the real permission, not just a visible button.";

export function featureGroup(code: string): string {
  if (["movement.view", "movement.approve", "movement.inspect", "movement.complete"].includes(code)) return "Actions and settings";
  if (/(^|\.)view([._]|$)/.test(code)) return "Visibility and data access";
  if (/(^|\.)(approve|reject)([._]|$)/.test(code)) return "Approval decisions";
  return "Actions and settings";
}

// Only name controls verified in their screens; a scope has no matching button.
export const ACTION_LOCATIONS: Record<string, { button: string; where: string }> = {
  "indent.create": { button: "New indent", where: "Indents > Dashboard or All Requests" },
  "indent.edit": { button: "Edit Indent", where: "Indents > All Requests > Open an editable indent" },
  "po.create": { button: "New purchase order", where: "Procurement > Purchase Orders" },
  "po.approve": { button: "Approve", where: "Procurement > Purchase Orders > Open an order > Approve this order" },
  "po.reject": { button: "Reject", where: "Procurement > Purchase Orders > Open an order > Approve this order" },
  "issue.create": { button: "New issue", where: "Warehouse > Material Issues (the same button also submits a draft for approval)" },
  "issue.issue": { button: "Issue from stock", where: "Warehouse > Material Issues > Open an approved issue (the same code carries Approve / Reject while the issue is pending)" },
  "po.send_vendor": { button: "Send to vendor", where: "Procurement > Purchase Orders > Open an approved order" },
  "rfq.create": { button: "New RFQ", where: "Procurement > RFQs (also [Create RFQ] on an approved requisition or consolidation)" },
  "transport.create": { button: "Dispatch", where: "Logistics > Dispatch > a consignment row" },
  "stock.points.manage": { button: "Tag / Access / Grant access", where: "Inventory > Stocking Points > Position row > Access" },
  "stock.transfer.view": { button: "Requests / Orders / History tabs", where: "Inventory > Stock Transfer" },
  "stock.transfer.request": { button: "New STR", where: "Inventory > Stock Transfer > Requests (STR)" },
  "stock.transfer": { button: "New STO", where: "Inventory > Stock Transfer > Orders (STO / SMO)" },
  "stock.transfer.approve": { button: "Approve / Reject", where: "Inventory > Stock Transfer > Orders > Open a pending order" },
  "stock.transfer.serve": { button: "Allocate", where: "Inventory > Stock Transfer > To serve" },
  "stock.transfer.qc": { button: "New inspection / Outward QC", where: "Inventory > Stock Transfer > Outward QC (or an order's Outward QC button)" },
  "stock.transfer.issue": { button: "Open material issue", where: "Inventory > Stock Transfer > Orders > Open an order" },
  "stock.transfer.receive": { button: "Confirm receipt", where: "Inventory > Stock Transfer > Acknowledgements" },
  "movement.view": { button: "View Stock Movements", where: "Warehouse > Stock Movements" },
  "movement.create": { button: "New order / Save draft", where: "Warehouse > Stock Movements" },
  "movement.approve": { button: "Approve", where: "Warehouse > Stock Movements > Open a pending order" },
  "movement.inspect": { button: "Complete inspection", where: "Warehouse > Stock Movements > Open an approved order" },
  "movement.complete": { button: "Complete movement", where: "Warehouse > Stock Movements > Open an inspected order" },
};

/* A picture of the control, for the profile builder who has never opened the screen.
   Files live in `frontend/public/rbac/`, captured against the running app and cropped
   to the toolbar the button sits in — a whole 1440px screen is unreadable in a hover
   card. Keyed by permission code for an action and by page code for a screen; a code
   with no shot simply shows the words, which is why this map may lag the other two. */
export const SHOTS: Record<string, string> = {
  "indent.create": "/rbac/indent.create.png",
  "indent.edit": "/rbac/indent.edit.png",
  "po.create": "/rbac/po.create.png",
  "po.approve": "/rbac/po.approve.png",
  "po.reject": "/rbac/po.reject.png",
  "issue.create": "/rbac/issue.create.png",
  "issue.issue": "/rbac/issue.issue.png",
  "stock.points.manage": "/rbac/stock.points.manage.png",
  "rfq.create": "/rbac/rfq.create.png",
  // No transport.create shot: on this data every Dispatch row sits at "Checking…"
  // and the button never renders, so there is nothing honest to photograph yet.
  ind_list: "/rbac/page.ind_list.png",
  po_list: "/rbac/page.po_list.png",
  wh_issues: "/rbac/page.wh_issues.png",
  inv_stocking_points: "/rbac/page.inv_stocking_points.png",
};

export const shotFor = (code: string): string | undefined => SHOTS[code];

export function featureGuidance(feature: MatrixFeature): string {
  const location = ACTION_LOCATIONS[feature.code];
  const group = featureGroup(feature.code);
  const detail = PLAIN_FEATURE_HELP[feature.code] ?? feature.description;
  if (group === "Visibility and data access")
    return `${detail} This controls readable data; it has no separate action button. Other access rules still apply.`;
  if (group === "Approval decisions")
    return `${detail}${location ? ` Find it: ${location.where}. Button: [${location.button}].` : ""} The person must also be eligible at the document's current approval step. This permission does not bypass the approval flow.`;
  return `${detail}${location ? ` Find it: ${location.where}. Button: [${location.button}].` : " Availability also depends on the document status and assigned access."}`;
}

/* --------------------------------------------------------------------------- *
 *  Small local controls. Nothing here restyles a shared primitive — they are
 *  compositions of tokens the kit does not carry a component for.
 * --------------------------------------------------------------------------- */

function Tick({
  checked, indeterminate, disabled, onChange, label, hint, shot,
}: {
  checked: boolean; indeterminate?: boolean; disabled?: boolean;
  onChange: () => void; label: ReactNode; hint?: string; shot?: string;
}) {
  return (
    <Tooltip
      content={
        <div className="max-w-md whitespace-normal p-1 text-sm">
          {hint}
          {/* Lazy, and it fails quietly: a missing file leaves the words, which are
              the answer. An <img> that 404s must never blank the help around it. */}
          {shot && (
            <img
              src={shot}
              alt=""
              loading="lazy"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
              className="mt-2 max-h-40 w-auto max-w-full rounded-lg border border-default bg-white object-contain p-1"
            />
          )}
        </div>
      }
      isDisabled={!hint}
    >
    <label
      title={hint}
      className={`flex min-h-9 items-start gap-2.5 rounded-lg px-2 py-1.5 text-sm
        ${disabled ? "cursor-default" : "cursor-pointer hover:bg-brand-050/70"}`}
    >
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 accent-brand"
        disabled={disabled}
        checked={checked}
        ref={(el) => { if (el) el.indeterminate = !!indeterminate && !checked; }}
        onChange={onChange}
        aria-description={hint}
      />
      <span className={disabled ? "text-muted" : "text-body"}>{label}</span>
    </label>
    </Tooltip>
  );
}

function Badge({ tone, children }: { tone: "ok" | "brand" | "warn" | "muted";
                                     children: ReactNode }) {
  const TONE = {
    ok: "bg-ok-bg text-ok",
    brand: "bg-brand-050 text-brand",
    warn: "bg-warn-bg text-warn",
    muted: "bg-neutral-bg text-neutral",
  }[tone];
  return (
    <span className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px]
                      font-bold uppercase tracking-wide ${TONE}`}>
      {children}
    </span>
  );
}

/** Plain-text button for the small "all / none" links inside a card. */
function MiniButton({ onClick, children }: { onClick: () => void;
                                             children: ReactNode }) {
  return (
    <button type="button" onClick={onClick}
            className="rounded-md px-1.5 py-0.5 text-xs font-semibold text-brand
                       hover:bg-brand-050">
      {children}
    </button>
  );
}

export function JobProfilesPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["rbac", "job-profiles"],
    queryFn: rbacApi.jobProfiles.matrix,
  });

  const [search, setSearch] = useState("");
  // "" = every project. A profile is keyed by project, so this is the axis the list
  // is actually organised along — not a convenience filter.
  const [project, setProject] = useState("");
  const [status, setStatus] = useState<"all" | "live" | "hcm">("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [pageCodes, setPageCodes] = useState<Set<string>>(new Set());
  const [featureCodes, setFeatureCodes] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<ScopeRung>("SELF");
  const [showHolders, setShowHolders] = useState(false);
  const [matrixSearch, setMatrixSearch] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  // The paste box: closed until asked for, and cleared whenever the selection moves.
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  // "Who has this?" run backwards: type a person, get the profile that grants them.
  const [peopleSearch, setPeopleSearch] = useState("");
  // Narrows the holders panel. A Store Keeper profile seats nearly two thousand
  // people, and a flat list of them answers no question anybody actually has.
  const [holderSearch, setHolderSearch] = useState("");

  const profiles = data?.items ?? [];
  const selected = useMemo(
    () => profiles.find((p) => p.key === selectedKey) ?? null,
    [profiles, selectedKey],
  );

  /** Puts the draft back to what is saved — both on selecting a profile and on
   *  "Discard changes". */
  const loadDraft = () => {
    if (!selected) return;
    setPageCodes(new Set(selected.page_codes));
    setFeatureCodes(new Set(selected.permission_codes));
    setScope(selected.scope);
  };

  // Land on the first profile, and reload the draft whenever the selection moves.
  useEffect(() => {
    if (!selectedKey && profiles.length) setSelectedKey(profiles[0].key);
  }, [profiles, selectedKey]);
  useEffect(() => {
    if (!selected) return;
    setPageCodes(new Set(selected.page_codes));
    setFeatureCodes(new Set(selected.permission_codes));
    setScope(selected.scope);
    setShowHolders(false);
    setHolderSearch("");
    setOpen(new Set());
    // FIXED 2026-08-26 — this used to clear the paste box on every selection change,
    // which broke the ONE thing copy/paste is for. The workflow is copy on profile A,
    // MOVE TO profile B, paste; wiping the box on the move threw the clip away before
    // it could ever be used, so "Copy permissions" looked like it did nothing.
    //
    // It survived locally because localhost is a secure context: `navigator.clipboard`
    // works there, so the OS clipboard still held the clip and Ctrl+V into the box
    // rescued it. The deployed app is served over plain http, where
    // `navigator.clipboard` is undefined and the in-app box is the ONLY carrier — so
    // there the copy was simply lost, which is exactly what was reported.
    //
    // The box is now left exactly as the admin left it. Nothing it holds can be saved
    // by accident: pasting only fills the draft, and Save is still the only write.
  }, [selected]);

  const holders = useQuery({
    queryKey: ["rbac", "job-profiles", selectedKey, "holders"],
    queryFn: () => rbacApi.jobProfiles.holders(selectedKey as string),
    enabled: showHolders && !!selectedKey,
  });

  const debouncedPeople = useDebouncedValue(peopleSearch, 250);
  const people = useQuery({
    queryKey: ["rbac", "job-profiles", "find", debouncedPeople],
    queryFn: () => rbacApi.jobProfiles.findPeople(debouncedPeople),
    // Two characters is the server's own floor; asking below it just returns nothing.
    enabled: debouncedPeople.trim().length >= 2,
  });

  /** The holders panel, narrowed by name or employee code. */
  const visibleHolders = useMemo(() => {
    const rows = holders.data?.items ?? [];
    const needle = holderSearch.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((h) => (h.name ?? "").toLowerCase().includes(needle)
      || (h.emp_code ?? "").toLowerCase().includes(needle)
      || (h.position_name ?? "").toLowerCase().includes(needle));
  }, [holders.data, holderSearch]);

  const save = useMutation({
    mutationFn: () => rbacApi.jobProfiles.setAccess(selected!.key, {
      page_codes: [...pageCodes],
      permission_codes: [...featureCodes],
      scope,
      name: selected!.name,
    }),
    onSuccess: () => {
      toast.success(`${selected?.name} saved`);
      queryClient.invalidateQueries({ queryKey: ["rbac", "job-profiles"] });
    },
    onError: () => toast.error("Job profile not saved. Try again."),
  });

  const reset = useMutation({
    mutationFn: () => rbacApi.jobProfiles.reset(selected!.key),
    onSuccess: () => {
      toast.success(`${selected?.name} handed back to its HCM role`);
      queryClient.invalidateQueries({ queryKey: ["rbac", "job-profiles"] });
    },
    onError: () => toast.error("Job profile not reset. Try again."),
  });

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return profiles.filter((p) => {
      // An approval post belongs to no HCM project, so a project filter must not
      // hide it — it is the one profile that applies everywhere.
      if (project && !p.is_approval_post && String(p.project_id) !== project) {
        return false;
      }
      if (status === "live" && !p.configured) return false;
      if (status === "hcm" && p.configured) return false;
      if (!needle) return true;
      return p.key.toLowerCase().includes(needle)
        || p.name.toLowerCase().includes(needle)
        || p.project_name.toLowerCase().includes(needle)
        || p.hcm_roles.some((r) => r.toLowerCase().includes(needle))
        || p.positions.some((pos) => pos.name.toLowerCase().includes(needle));
    });
  }, [profiles, search, project, status]);

  // Counted off the unfiltered list so the numbers stay put while you filter.
  const perProject = useMemo(() => {
    const counts = new Map<number, number>();
    // Approval posts have no HCM project, so they are not counted against one — the
    // project chips count what each project actually derived.
    for (const p of profiles) {
      if (p.project_id == null) continue;
      counts.set(p.project_id, (counts.get(p.project_id) ?? 0) + 1);
    }
    return counts;
  }, [profiles]);

  const sections = useMemo(
    () => buildAccessSections(data?.pages ?? [], data?.features ?? []),
    [data?.pages, data?.features],
  );

  /** Typing in the matrix search narrows every card to the rows that match, and
   *  drops the cards left with nothing. */
  const visibleSections = useMemo(() => {
    const needle = matrixSearch.trim().toLowerCase();
    if (!needle) return sections;
    const hit = (text: string) => text.toLowerCase().includes(needle);
    return sections
      .map((section) => ({
        ...section,
        pages: hit(section.name)
          ? section.pages
          : section.pages.filter((p) => hit(pageDisplayName(p)) || hit(p.code)),
        features: hit(section.name)
          ? section.features
          : section.features.filter((f) => hit(f.description) || hit(f.code)),
      }))
      .filter((section) => section.pages.length || section.features.length);
  }, [sections, matrixSearch]);

  const fullSections = useMemo(
    () => new Map(sections.map((section) => [section.name, section])),
    [sections],
  );

  const selectablePages = (section: AccessSection) =>
    section.pages.filter((page) => !page.always_on).map((page) => page.code);

  const sectionState = (section: AccessSection) => {
    const pages = selectablePages(section);
    const features = section.features.map((f) => f.code);
    const total = pages.length + features.length;
    const on = pages.filter((c) => pageCodes.has(c)).length
      + features.filter((c) => featureCodes.has(c)).length;
    return { total, on, all: total > 0 && on === total, some: on > 0 && on < total };
  };

  const apply = (current: Set<string>, codes: string[], on: boolean) => {
    const next = new Set(current);
    for (const code of codes) on ? next.add(code) : next.delete(code);
    return next;
  };

  /** One tick for a whole module: every screen under it AND every action in it. Two
   *  half-granted modules is the shape of an access bug, so they move together. */
  const setSection = (section: AccessSection, on: boolean) => {
    setPageCodes(apply(pageCodes, selectablePages(section), on));
    setFeatureCodes(apply(featureCodes, section.features.map((f) => f.code), on));
  };

  const toggle = (set: Set<string>, code: string, put: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    put(next);
  };

  const toggleOpen = (name: string) => {
    const next = new Set(open);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setOpen(next);
  };

  // A search is a request to see what matched — no point making the admin open ten
  // cards to find it.
  const isOpen = (name: string) => !!matrixSearch.trim() || open.has(name);

  const totals = useMemo(() => {
    const pages = (data?.pages ?? []).filter((p) => !p.always_on);
    return {
      pages: pages.length,
      pagesOn: pages.filter((p) => pageCodes.has(p.code)).length,
      features: data?.features.length ?? 0,
      featuresOn: featureCodes.size,
    };
  }, [data?.pages, data?.features, pageCodes, featureCodes]);

  /** Which profile the text in the box was copied from, or null if it is not a clip
   *  (empty box, or something the admin pasted in by hand that we cannot read). */
  const clipOrigin = useMemo(() => {
    if (!pasteText.trim()) return null;
    const parsed = parseClip(pasteText);
    return "clip" in parsed ? parsed.clip.from : null;
  }, [pasteText]);

  /** Copy fills the box AND the OS clipboard: the box is what makes this work on a
   *  plain-http LAN host, where navigator.clipboard is not available at all.
   *
   *  The success toast has to be raised on BOTH paths. `navigator.clipboard?.write…`
   *  short-circuits the whole chain when the API is missing, so on the deployed
   *  plain-http host the `.then` never ran and the button gave no feedback of any
   *  kind — which is half of why it read as broken. */
  const copyAccess = () => {
    if (!selected) return;
    const text = buildClip(selected.name, scope, [...pageCodes], [...featureCodes]);
    setPasteText(text);
    setPasteOpen(true);
    const done = `${selected.name}'s permissions copied — open another profile, then`
      + " Add or Replace.";
    const written = navigator.clipboard?.writeText(text);
    if (!written) { toast.success(done); return; }
    written.then(
      () => toast.success(done),
      () => toast.success(`${done} They are in the box below if you need them.`),
    );
  };

  /** APPEND adds the copied codes to what this profile already has; REPLACE makes it
   *  exactly the copied set (and takes its scope with it, because a grant read at a
   *  different reach is a different grant). Neither saves. */
  const applyClip = (mode: "append" | "replace") => {
    const parsed = parseClip(pasteText);
    if ("error" in parsed) { toast.error(parsed.error); return; }
    const { clip } = parsed;
    // always_on pages are granted to everyone and are not selectable here, so a clip
    // carrying one must not put a code in the draft the matrix cannot show or clear.
    const knownPages = new Set((data?.pages ?? [])
      .filter((page) => !page.always_on).map((page) => page.code));
    const knownFeatures = new Set((data?.features ?? []).map((f) => f.code));
    const pages = clip.pages.filter((code) => knownPages.has(code));
    const features = clip.features.filter((code) => knownFeatures.has(code));
    const skipped = (clip.pages.length - pages.length)
      + (clip.features.length - features.length);

    if (mode === "replace") {
      setPageCodes(new Set(pages));
      setFeatureCodes(new Set(features));
      if (clip.scope) setScope(clip.scope);
    } else {
      setPageCodes(new Set([...pageCodes, ...pages]));
      setFeatureCodes(new Set([...featureCodes, ...features]));
    }
    setPasteOpen(false);
    toast.success(
      `${mode === "replace" ? "Replaced with" : "Added"} ${clip.from}'s access`
      + ` — ${pages.length} screens, ${features.length} actions`
      + (skipped ? `, ${skipped} unknown code${skipped > 1 ? "s" : ""} skipped` : "")
      + ". Not saved yet.",
    );
  };

  const dirty = !!selected && (
    scope !== selected.scope
    || [...pageCodes].sort().join() !== [...selected.page_codes].sort().join()
    || [...featureCodes].sort().join() !== [...selected.permission_codes].sort().join()
  );

  if (error) return <ErrorBanner error={error} />;

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="RBAC"
        title="Job Profiles"
        actions={data && (
          <span className="text-sm text-muted">
            <b className="text-ink tabular">{data.total}</b> jobs from{" "}
            <b className="text-ink tabular">{data.position_total}</b> HCM positions
          </span>
        )}
      />
      <p className="-mt-3 text-sm text-muted">
        Pick a job on the left, then tick the screens and actions it should have.
        Saving here replaces whatever the position's HCM role was granting.
      </p>

      <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        {/* ------------------------------ profiles ------------------------------ */}
        <Card className="overflow-hidden p-0">
          <div className="space-y-2.5 border-b border-line bg-content1 p-3">
            <Input
              aria-label="Search job profiles"
              placeholder="Search job, project, HCM role, position…"
              value={search}
              onFocus={selectOnFocus}
              onChange={(e) => setSearch(e.target.value)}
            />
            {/* The same list, asked from the other side. The search above matches what
             *  a profile is MADE of; this one matches a PERSON and answers which
             *  profile grants them — which is the form an access question actually
             *  arrives in ("why can Ramesh see this?", "where is EMP1043 set up?"). */}
            <Input
              aria-label="Find a person by employee code or name"
              placeholder="Or find a person — employee code or name…"
              value={peopleSearch}
              onChange={(e) => setPeopleSearch(e.target.value)}
            />
            {peopleSearch.trim().length >= 2 && (
              <div className="rounded-lg border border-line bg-content2/40">
                {people.isLoading && (
                  <div className="px-3 py-2 text-xs text-muted">Searching…</div>
                )}
                {!people.isLoading && !people.data?.items.length && (
                  <div className="px-3 py-2 text-xs text-muted">
                    Nobody active matches that code or name.
                  </div>
                )}
                <ul className="divide-y divide-line">
                  {(people.data?.items ?? []).map((person) => (
                    <li key={`${person.employee_id}-${person.position_id}`}>
                      <button
                        type="button"
                        className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-content2"
                        onClick={() => {
                          setSelectedKey(person.key);
                          setPeopleSearch("");
                        }}
                      >
                        <span className="truncate text-sm font-medium text-ink">
                          {person.name}
                          <span className="text-muted"> · {person.emp_code}</span>
                        </span>
                        <span className="truncate text-[11px] text-muted">
                          {person.position_name} · {person.project_name}
                        </span>
                        <span className="truncate text-[11px] font-medium text-brand">
                          {person.configured
                            ? `Granted through ${person.profile_name}`
                            : `${person.profile_name} — not set up, still on its HCM role`}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <Select
              ariaLabel="Project"
              value={project}
              onChange={setProject}
              placeholder="All projects"
              // Explicit "All projects" row: the placeholder only shows while nothing
              // is picked, so without it there is no way back out of a project.
              options={[
                { value: "", label: `All projects (${profiles.length})` },
                ...(data?.projects ?? []).map(([id, name]) => ({
                  value: String(id),
                  label: `${name} (${perProject.get(id) ?? 0})`,
                })),
              ]}
            />
            {/* Says what it filters on in the same words the rows are badged with,
             *  so picking one is never a guess about what it means. */}
            <div className="flex rounded-lg border border-line p-0.5">
              {([
                ["all", "All jobs"],
                ["live", "Set up here"],
                ["hcm", "On HCM role"],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setStatus(value)}
                  className={`min-h-9 flex-1 rounded-md px-1 text-xs font-semibold
                    transition ${status === value
                      ? "bg-brand text-white"
                      : "text-muted hover:bg-brand-050 hover:text-brand"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="text-[11px] leading-4 text-muted">
              <b className="text-ok">Set up here</b> — access comes from this screen.{" "}
              <b className="text-neutral">On HCM role</b> — nothing saved yet, so the
              old HCM role still decides.
            </p>
          </div>
          <ScrollBox className="max-h-[68vh] overflow-y-auto">
            {isLoading && <div className="p-4 text-sm text-muted">Loading…</div>}
            {!isLoading && !filtered.length && (
              <EmptyState title="No job profile matches that" />
            )}
            <ul className="divide-y divide-line">
              {filtered.map((profile) => (
                <li key={profile.key}>
                  <button
                    type="button"
                    onClick={() => setSelectedKey(profile.key)}
                    aria-current={profile.key === selectedKey}
                    className={`min-h-11 w-full border-l-[3px] px-3.5 py-2.5 text-left
                      transition ${profile.key === selectedKey
                        ? "border-brand bg-brand-050"
                        : "border-transparent hover:bg-surface"}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold text-ink">
                        {profile.name}
                      </span>
                      {profile.is_approval_post
                        ? <Badge tone={profile.configured ? "ok" : "warn"}>
                            {profile.configured ? "Post" : "Post · not set"}
                          </Badge>
                        : profile.configured
                          ? <Badge tone="ok">Set up</Badge>
                          : <Badge tone="muted">HCM role</Badge>}
                    </div>
                    {/* The project is half the profile's identity, not a detail:
                     *  "4:DEO" and "6:DEO" are two grant units, and the name alone
                     *  cannot tell them apart. Always shown, never truncated away. */}
                    <div className="truncate text-[11px] font-medium text-brand">
                      {profile.project_name}
                    </div>
                    {profile.is_approval_post ? (
                      <div className="mt-0.5 truncate text-xs text-muted">
                        {profile.holder_count} seated · created here, not from HCM
                      </div>
                    ) : (
                      <>
                        <div className="mt-0.5 truncate text-xs text-muted">
                          {profile.holder_count} people · {profile.position_count} positions
                        </div>
                        <div className="truncate text-[11px] text-muted/80">
                          was: {profile.hcm_roles.join(", ") || "—"}
                        </div>
                      </>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </ScrollBox>
        </Card>

        {/* ------------------------------- matrix ------------------------------- */}
        <div className="space-y-4">
          {!selected && <Card className="p-6"><EmptyState title="Pick a job profile" /></Card>}

          {selected && (
            <>
              <Card className="space-y-4 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-display text-xl font-bold text-ink">
                        {selected.name}
                      </h2>
                      {selected.configured
                        ? <Badge tone="ok">Set up here</Badge>
                        : <Badge tone="muted">On HCM role</Badge>}
                      <code className="mono text-[11px] text-muted">{selected.key}</code>
                    </div>
                    {(
                      <>
                        <p className="mt-1 text-sm text-muted">
                          <span className="font-semibold text-brand">
                            {selected.project_name}
                          </span>
                          {" · "}
                          {selected.holder_count} people across {selected.position_count}{" "}
                          position{selected.position_count === 1 ? "" : "s"}
                          {selected.hcm_roles.length
                            ? ` · currently inside HCM role ${selected.hcm_roles.join(", ")}`
                            : ""}
                        </p>
                        {/* Saving grants this job in THIS project only. Worth saying
                         *  out loud: the list shows one row per project, so the same
                         *  job name can appear more than once, granted separately. */}
                        <p className="mt-0.5 text-xs text-muted">
                          Grants apply to {selected.job} in {selected.project_name} only.
                        </p>
                      </>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="subtle" onClick={() => setShowHolders((v) => !v)}>
                      <Users className="h-4 w-4" />
                      {showHolders ? "Hide people" : "Who is this?"}
                    </Button>
                    {selected.configured && (
                      <Button
                        variant="dangerSoft"
                        disabled={reset.isPending}
                        onClick={() => reset.mutate()}
                      >
                        <RotateCcw className="h-4 w-4" /> Hand back to HCM role
                      </Button>
                    )}
                    <Button
                      disabled={!dirty || save.isPending}
                      onClick={() => save.mutate()}
                    >
                      <Check className="h-4 w-4" /> Save
                    </Button>
                  </div>
                </div>

                {!selected.configured && (
                  <div className="flex gap-2 rounded-xl bg-warn-bg p-3 text-sm text-warn">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      Not live yet. These {selected.holder_count} people still get whatever
                      HCM role <b>{selected.hcm_roles.join(", ") || "—"}</b> grants — shared
                      with every other job in that role. Saving once takes them off it.
                    </span>
                  </div>
                )}

                {!pageCodes.size && (
                  <div className="rounded-xl bg-neutral-bg p-3 text-sm text-body">
                    No screens ticked — these {selected.holder_count} people will see the
                    Home screen and nothing else once you save.
                  </div>
                )}

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Data scope" hint={SCOPE_HELP[scope]}>
                    <Select
                      ariaLabel="Data scope"
                      value={scope}
                      onChange={(value) => setScope(value as ScopeRung)}
                      options={(data?.scopes ?? []).map((rung) => ({
                        value: rung, label: SCOPE_LABEL[rung],
                      }))}
                    />
                  </Field>
                  <div className="self-end pb-2 text-xs text-muted">
                    HCM suggests <b className="text-body">
                      {SCOPE_LABEL[selected.suggested_scope]}
                    </b> from {selected.office_levels.join(", ") || "no office level"}.
                    <br />
                    Scope is recorded now; list filtering lands with the scope filter.
                  </div>
                </div>

                {showHolders && (
                  <ScrollBox className="max-h-56 rounded-xl border border-line">
                    {holders.isLoading && <div className="p-3 text-sm">Loading…</div>}
                    {!holders.isLoading && (holders.data?.items.length ?? 0) > 0 && (
                      <div className="border-b border-line p-2">
                        <Input
                          aria-label="Find a person in this profile"
                          placeholder="Find a person — name, code or position…"
                          value={holderSearch}
                          onChange={(e) => setHolderSearch(e.target.value)}
                        />
                        <div className="px-1 pt-1.5 text-[11px] text-muted">
                          {visibleHolders.length} of {holders.data?.total ?? 0} shown
                          {(holders.data?.total ?? 0) >= 200
                            ? " · capped at 200 — narrow the search to find someone"
                            : ""}
                        </div>
                      </div>
                    )}
                    <ul className="divide-y divide-line">
                      {visibleHolders.map((h) => (
                        <li key={`${h.employee_id}-${h.position_name}`}
                            className="flex justify-between gap-3 px-3 py-2 text-sm">
                          <span className="truncate text-body">{h.name}
                            <span className="text-muted"> · {h.emp_code}</span></span>
                          <span className="truncate text-right text-muted">
                            {h.position_name}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {!holders.isLoading && !holders.data?.items.length && (
                      <div className="p-3 text-sm text-muted">
                        No active holders — the positions exist but nobody is in them.
                      </div>
                    )}
                    {!holders.isLoading && !!holders.data?.items.length
                      && !visibleHolders.length && (
                      <div className="p-3 text-sm text-muted">
                        Nobody in this profile matches “{holderSearch}”.
                      </div>
                    )}
                  </ScrollBox>
                )}
              </Card>

              {/* --------------------------- access cards --------------------------- */}
              <Card className="p-3 sm:p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm text-muted">
                    <b className="text-ink tabular">{totals.pagesOn}</b> of {totals.pages}{" "}
                    screens · <b className="text-ink tabular">{totals.featuresOn}</b> of{" "}
                    {totals.features} actions
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="w-full sm:w-60">
                      <Input
                        aria-label="Find a screen or action"
                        placeholder="Find a screen or action…"
                        value={matrixSearch}
                        onChange={(e) => setMatrixSearch(e.target.value)}
                      />
                    </div>
                    <Button
                      variant="subtle"
                      onClick={() => setOpen(new Set(
                        open.size === sections.length ? [] : sections.map((s) => s.name),
                      ))}
                    >
                      {open.size === sections.length ? "Collapse all" : "Expand all"}
                    </Button>
                  </div>
                </div>

                <div className="mt-3 space-y-2">
                  {visibleSections.map((section) => {
                    // The card body shows what the search matched; its header always
                    // speaks for the whole module, or the tick would quietly mean
                    // "everything I can currently see".
                    const full = fullSections.get(section.name) ?? section;
                    const state = sectionState(full);
                    const granted = full.pages
                      .filter((p) => p.always_on || pageCodes.has(p.code))
                      .map(pageDisplayName);
                    const Icon = ICONS[moduleKey(section.name)] ?? Boxes;
                    return (
                      <div
                        key={section.name}
                        className={`overflow-hidden rounded-xl border transition
                          ${state.on ? "border-brand/40 bg-brand-050/30" : "border-line"}`}
                      >
                        {/* Header: the module tick and the summary, both readable
                         *  without opening the card. */}
                        <div className="flex items-center gap-2 px-2 py-2 sm:px-3">
                          <input
                            type="checkbox"
                            aria-label={`Give this job the whole ${section.name} module`}
                            title={`Turn the whole ${section.name} module on or off — `
                              + "every screen under it and every action in it."}
                            className="h-4.5 w-4.5 shrink-0 accent-brand"
                            checked={state.all}
                            ref={(el) => {
                              if (el) el.indeterminate = state.some;
                            }}
                            onChange={() => setSection(section, !state.all)}
                          />
                          <button
                            type="button"
                            onClick={() => toggleOpen(section.name)}
                            aria-expanded={isOpen(section.name)}
                            className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5
                                       rounded-lg px-1 text-left"
                          >
                            <Icon className={`h-4.5 w-4.5 shrink-0
                              ${state.on ? "text-brand" : "text-muted"}`} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-bold text-ink">
                                {section.name}
                              </span>
                              <span className="block truncate text-xs text-muted">
                                {sectionSummary(
                                  granted,
                                  section.features
                                    .filter((f) => featureCodes.has(f.code)).length,
                                )}
                              </span>
                            </span>
                            <span className="shrink-0 tabular text-xs font-semibold text-muted">
                              {state.on}/{state.total}
                            </span>
                            <ChevronRight
                              className={`h-4 w-4 shrink-0 text-muted transition-transform
                                ${isOpen(section.name) ? "rotate-90" : ""}`}
                            />
                          </button>
                        </div>

                        {isOpen(section.name) && (
                          <div className="grid gap-4 border-t border-line bg-content1 px-2
                                          py-3 sm:px-3 md:grid-cols-2">
                            <div>
                              <div className="mb-1 flex items-center justify-between gap-2
                                              px-2">
                                <span className="text-[11px] font-bold uppercase
                                                 tracking-wider text-muted">
                                  Screens they can open
                                </span>
                                <span className="flex gap-1">
                                  <MiniButton onClick={() => setPageCodes(apply(
                                    pageCodes, selectablePages(section), true))}>
                                    All
                                  </MiniButton>
                                  <MiniButton onClick={() => setPageCodes(apply(
                                    pageCodes, selectablePages(section), false))}>
                                    None
                                  </MiniButton>
                                </span>
                              </div>
                              {!section.pages.length && (
                                <p className="px-2 text-xs text-muted">
                                  No screens of its own.
                                </p>
                              )}
                              {section.pages.map((page) => (
                                <Tick
                                  key={page.code}
                                  hint={pageHint(page)}
                                  shot={shotFor(page.code)}
                                  disabled={page.always_on}
                                  checked={page.always_on || pageCodes.has(page.code)}
                                  onChange={() =>
                                    toggle(pageCodes, page.code, setPageCodes)}
                                  label={
                                    <>
                                      {pageDisplayName(page)}
                                      {page.always_on && (
                                        <span className="ml-1.5 text-[11px] text-muted">
                                          (always on)
                                        </span>
                                      )}
                                    </>
                                  }
                                />
                              ))}
                            </div>

                            <div className="md:border-l md:border-line md:pl-3">
                              <div className="mb-1 flex items-center justify-between gap-2
                                              px-2">
                                <span className="text-[11px] font-bold uppercase
                                                 tracking-wider text-muted">
                                  What they can do
                                </span>
                                <span className="flex gap-1">
                                  <MiniButton onClick={() => setFeatureCodes(apply(
                                    featureCodes,
                                    section.features.map((f) => f.code), true))}>
                                    All
                                  </MiniButton>
                                  <MiniButton onClick={() => setFeatureCodes(apply(
                                    featureCodes,
                                    section.features.map((f) => f.code), false))}>
                                    None
                                  </MiniButton>
                                </span>
                              </div>
                              {!section.features.length && (
                                <p className="px-2 text-xs text-muted">
                                  Nothing to switch on beyond the screens.
                                </p>
                              )}
                              {["Actions and settings", "Approval decisions", "Visibility and data access"].map((group) => (
                                <div key={group}>
                                {section.features.some((feature) => featureGroup(feature.code) === group) &&
                                  <p className="mt-3 px-2 text-xs font-semibold text-muted">{group}</p>}
                              {section.features.filter((feature) => featureGroup(feature.code) === group).map((feature) => (
                                <Tick
                                  key={feature.code}
                                  hint={featureGuidance(feature)}
                                  shot={shotFor(feature.code)}
                                  checked={featureCodes.has(feature.code)}
                                  onChange={() =>
                                    toggle(featureCodes, feature.code, setFeatureCodes)}
                                  label={<span>{feature.description}
                                    {ACTION_LOCATIONS[feature.code] && <span className="ml-1 text-xs text-brand">[{ACTION_LOCATIONS[feature.code].button}]</span>}
                                    <span className="mt-0.5 block text-xs text-muted">{PLAIN_FEATURE_HELP[feature.code] ?? feature.description}</span>
                                  </span>}
                                />
                              ))}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {!visibleSections.length && (
                    <EmptyState title="Nothing matches that" />
                  )}
                </div>

                <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setPageCodes(new Set((data?.pages ?? [])
                        .filter((p) => !p.always_on).map((p) => p.code)));
                      setFeatureCodes(new Set((data?.features ?? []).map((f) => f.code)));
                    }}
                  >
                    Give everything
                  </Button>
                  {/* Clearing leaves Home, which has no required_permission — this is
                   *  how you make someone who only needs to log in see nothing else. */}
                  <Button
                    variant="ghost"
                    onClick={() => { setPageCodes(new Set()); setFeatureCodes(new Set()); }}
                  >
                    Take everything away
                  </Button>
                  {/* Copy one profile's access, paste it onto the next. Nothing here
                   *  writes: it fills the draft and Save is still the only write. */}
                  <Button variant="ghost" onClick={copyAccess}>
                    <Copy className="h-4 w-4" /> Copy permissions
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => { setPasteOpen(!pasteOpen); }}
                  >
                    <ClipboardPaste className="h-4 w-4" /> Paste permissions
                  </Button>
                </div>

                {pasteOpen && (
                  <div className="mt-3 space-y-2 rounded-xl border border-brand/40
                                  bg-content2/50 p-3">
                    {/* Names where the clip CAME FROM, not the profile being looked
                      *  at. The box deliberately survives a change of profile — that
                      *  move is the whole workflow — so labelling it with the current
                      *  profile said "Permission set for B" over B's own contents and
                      *  read as though pasting would do nothing. */}
                    <p className="text-sm font-semibold text-ink">
                      {clipOrigin
                        ? (clipOrigin === selected.name
                            ? `Copied from ${clipOrigin} — open another profile to paste it`
                            : `Copied from ${clipOrigin} — Add or Replace applies it to ${selected.name}`)
                        : `Paste a permission set to apply to ${selected.name}`}
                    </p>
                    <textarea
                      value={pasteText}
                      onChange={(event) => setPasteText(event.target.value)}
                      placeholder="Paste a copied permission set here"
                      spellCheck={false}
                      className="min-h-28 w-full rounded-lg border border-line
                                 bg-content1 p-3 font-mono text-xs text-ink"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="ghost"
                        disabled={!pasteText.trim()}
                        onClick={() => applyClip("append")}
                      >
                        Add to this profile
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={!pasteText.trim()}
                        onClick={() => applyClip("replace")}
                      >
                        Replace this profile
                      </Button>
                      <Button variant="ghost" onClick={() => setPasteOpen(false)}>
                        Cancel
                      </Button>
                      <span className="text-xs text-muted">
                        Add keeps what {selected.name} already has. Replace makes it
                        exactly the copied set, scope included. Neither saves until you
                        press Save changes.
                      </span>
                    </div>
                  </div>
                )}
              </Card>

              {/* The list above runs long, so Save follows you down it. Cleared of the
               *  phone's bottom module bar. */}
              {dirty && (
                <div className="sticky bottom-19 z-10 md:bottom-4">
                  <div className="flex flex-wrap items-center justify-between gap-3
                                  rounded-xl border border-brand/40 bg-content1/95 px-3
                                  py-2.5 shadow-lg backdrop-blur">
                    <span className="text-sm font-semibold text-ink">
                      Unsaved changes to {selected.name}
                    </span>
                    <div className="flex gap-2">
                      <Button variant="ghost" onClick={loadDraft}>
                        <Undo2 className="h-4 w-4" /> Discard
                      </Button>
                      <Button disabled={save.isPending} onClick={() => save.mutate()}>
                        <Check className="h-4 w-4" /> Save changes
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
