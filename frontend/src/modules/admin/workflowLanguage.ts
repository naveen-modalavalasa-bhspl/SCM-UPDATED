import type { WorkflowDefinition, WorkflowOptions, WorkflowStage } from "./types";

export const DOC_LABEL: Record<string, string> = {
  INDENT: "Indent",
  ALLOCATION: "Inventory allocation",
  WH_ISSUE: "Warehouse material issue",
  OWN_STOCK_ISSUE: "Material issue from your own point",
  OWN_STOCK_ALLOCATION: "Stock allocation from your own point",
  DISPATCH: "Warehouse dispatch",
  PURCHASE_RETURN: "Purchase return",
  MR: "Material request",
  PO: "Purchase order",
  GRN: "Goods receipt",
  ISSUE: "Material issue",
};

export const APPROVER_LABEL: Record<string, string> = {
  REPORTING_MANAGER: "The requester's reporting manager",
  DEPT_HEAD: "The department head",
  POSITION: "Everyone holding a position",
  ROLE: "Everyone with an SCM role",
  SPECIFIC_USER: "One specific employee",
};

export const MODE_LABEL: Record<string, string> = {
  ANY_ONE: "Any one may approve",
  ALL: "Everyone must approve",
  MAJORITY: "A majority must approve",
};

const optionName = (
  rows: { id: number; name: string }[],
  id?: number | null,
) => rows.find((row) => row.id === id)?.name;

export function approverSentence(stage: WorkflowStage, options?: WorkflowOptions): string {
  if (stage.approver_type === "POSITION") {
    return optionName(options?.positions ?? [], stage.position_id) ?? "the selected position";
  }
  if (stage.approver_type === "ROLE") {
    return optionName(options?.roles ?? [], stage.role_id) ?? "the selected role";
  }
  if (stage.approver_type === "SPECIFIC_USER") {
    return optionName(options?.employees ?? [], stage.employee_id) ?? "the selected employee";
  }
  return APPROVER_LABEL[stage.approver_type] ?? stage.approver_type;
}

export function workflowSentence(
  workflow: Pick<WorkflowDefinition, "doc_type" | "stages">,
  options?: WorkflowOptions,
): string {
  const document = DOC_LABEL[workflow.doc_type] ?? workflow.doc_type;
  if (!workflow.stages.length) return `${document} has no approval stages yet.`;
  const stages = workflow.stages
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map((stage) => `${stage.name}: ${approverSentence(stage, options)}`)
    .join(" → ");
  return `${document} → ${stages}.`;
}
