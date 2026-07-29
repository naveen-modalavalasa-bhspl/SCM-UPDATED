/**
 * Plain-English words for the rules engine.
 *
 * The database stores codes — EQ, ROUTE_APPROVAL, category_code — because they have
 * to be stable. Storekeepers should never see them. Everything a person reads on the
 * Rules screen is translated through this file, so the wording is fixed in one place
 * instead of being scattered across the page.
 */
import type { ActionType, Operator, RuleAction, RuleCondition } from "./types";

/** "When ..." — the moment a rule is checked. */
export const EVENT_SENTENCE: Record<string, string> = {
  INDENT_SUBMITTED: "someone raises a request",
  INDENT_APPROVED: "a request finishes all its approvals",
  ALLOCATION_APPROVED: "an Inventory Manager approves a stock allocation",
  MR_RAISED: "a stock shortage creates a Material Request",
  MR_APPROVED: "a Material Request is approved for Procurement",
  PO_SUBMITTED: "a purchase order is sent for approval",
  GRN_RECEIVED: "goods arrive at a warehouse",
  STOCK_BELOW_THRESHOLD: "an item runs low in stock",
};

export const EVENT_TITLE: Record<string, string> = {
  INDENT_SUBMITTED: "Request raised",
  INDENT_APPROVED: "Request fully approved",
  ALLOCATION_APPROVED: "Stock allocation approved",
  MR_RAISED: "Material Request raised",
  MR_APPROVED: "Material Request approved",
  PO_SUBMITTED: "Purchase order sent for approval",
  GRN_RECEIVED: "Goods received",
  STOCK_BELOW_THRESHOLD: "Stock running low",
};

/** Field names, as a person would say them. */
export const FIELD_LABEL: Record<string, string> = {
  quantity: "Quantity",
  estimated_value: "Estimated value",
  total_amount: "Total amount",
  category_code: "Item category",
  item_id: "Item",
  indent_id: "Request",
  indent_no: "Request number",
  po_id: "Purchase order",
  po_no: "Purchase order number",
  grn_id: "Goods receipt",
  requester_id: "Who raised it",
  requester_position_id: "Their position",
  buyer_id: "Buyer",
  vendor_id: "Supplier",
  department_id: "Department",
  warehouse_id: "Warehouse",
  project_id: "Project",
  priority: "Urgency",
  accepted_quantity: "Quantity accepted",
  available_qty: "Quantity in stock",
  given_qty: "Quantity allocated",
  allocation_id: "Allocation",
  mr_id: "Material Request",
  status: "Resulting status",
  reorder_level: "Reorder level",
  item_code: "Item code",
};

export const fieldLabel = (field: string) =>
  FIELD_LABEL[field] ?? field.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Comparisons, written the way you would say them out loud. */
export const OPERATOR_LABEL: Record<Operator, string> = {
  EQ: "is",
  NEQ: "is not",
  GT: "is more than",
  GTE: "is at least",
  LT: "is less than",
  LTE: "is at most",
  IN: "is any of",
  NOT_IN: "is none of",
  BETWEEN: "is between",
};

/** Operators that read better on text than on numbers, and vice versa. */
export const TEXT_OPERATORS: Operator[] = ["EQ", "NEQ", "IN", "NOT_IN"];
export const NUMBER_OPERATORS: Operator[] =
  ["EQ", "NEQ", "GT", "GTE", "LT", "LTE", "BETWEEN"];

export function operatorsFor(dataType?: string): Operator[] {
  return dataType === "number" ? NUMBER_OPERATORS : TEXT_OPERATORS;
}

/** What to write in the value box, so nobody has to guess the format. */
export function valueHint(operator: Operator): string {
  if (operator === "BETWEEN") return "two numbers, e.g. 10,50";
  if (operator === "IN" || operator === "NOT_IN") return "separate with commas";
  return "";
}

/** Actions, written as instructions. */
export const ACTION_LABEL: Record<ActionType, string> = {
  ROUTE_APPROVAL: "Send it for approval using",
  ROUTE_FULFILLMENT: "Give the work to",
  SPLIT_FULFILLMENT: "Split the work between",
  NOTIFY: "Tell",
  SET_FIELD: "Set",
};

/** The one detail each action needs, described rather than named. */
export const ACTION_PARAM: Record<
  ActionType, { key: string; label: string; hint: string; options?: string[] }
> = {
  ROUTE_APPROVAL: {
    key: "workflow_code",
    label: "which approval flow",
    hint: "the code of an approval flow, e.g. WF-INDENT-REPORTING-MANAGER",
  },
  ROUTE_FULFILLMENT: {
    key: "target",
    label: "which team",
    hint: "",
    options: ["INVENTORY", "WAREHOUSE", "PROCUREMENT"],
  },
  SPLIT_FULFILLMENT: {
    key: "targets",
    label: "which teams",
    hint: "separate with commas, e.g. INVENTORY,WAREHOUSE",
  },
  NOTIFY: { key: "recipient", label: "who to tell", hint: "a role or group code" },
  SET_FIELD: { key: "value", label: "what to set", hint: "field=value" },
};

export const TEAM_LABEL: Record<string, string> = {
  INVENTORY: "Inventory team",
  WAREHOUSE: "Warehouse team",
  PROCUREMENT: "Purchasing team",
};

export const teamLabel = (value: string) => TEAM_LABEL[value] ?? value;

/** One condition, read aloud: "Quantity is more than 100". */
export function conditionSentence(c: RuleCondition): string {
  const value = c.operator === "BETWEEN"
    ? c.field_value.split(",").map((s) => s.trim()).join(" and ")
    : c.field_value;
  return `${fieldLabel(c.field_name)} ${OPERATOR_LABEL[c.operator] ?? c.operator} ${value}`;
}

/** One action, read aloud: "Give the work to Warehouse team". */
export function actionSentence(a: RuleAction): string {
  const spec = ACTION_PARAM[a.action_type];
  const raw = spec ? String(a.params?.[spec.key] ?? "") : "";
  const value = a.action_type === "ROUTE_FULFILLMENT" ? teamLabel(raw) : raw;
  return `${ACTION_LABEL[a.action_type] ?? a.action_type} ${value}`.trim();
}

/**
 * The whole rule as one readable line. This is what the list shows, so somebody can
 * scan the page and understand every rule without opening any of them.
 */
export function ruleSentence(
  eventCode: string,
  conditions: RuleCondition[] = [],
  actions: RuleAction[] = [],
): string {
  const when = EVENT_SENTENCE[eventCode] ?? eventCode;
  const ifPart = conditions.length
    ? conditions
        .map((c, i) => (i === 0 ? "" : c.logic === "OR" ? "or " : "and ") + conditionSentence(c))
        .join(" ")
    : "";
  const thenPart = actions.length
    ? actions.map(actionSentence).join(", then ")
    : "do nothing yet";
  return ifPart
    ? `When ${when}, and ${ifPart} — ${thenPart}.`
    : `Whenever ${when} — ${thenPart}.`;
}
