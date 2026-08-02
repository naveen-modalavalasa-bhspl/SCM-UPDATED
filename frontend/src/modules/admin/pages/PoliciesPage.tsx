import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Modal, ModalBody, ModalContent, ModalFooter, ModalHeader,
} from "@heroui/react";
import {
  ArrowRight, Boxes, Check, ChevronRight, ClipboardCheck, FileText,
  PackageCheck, Plus, ShieldCheck, Sparkles,
} from "lucide-react";
import { Button, Card, Field, Input, PageHeader, Select } from "@/shared/components";
import { adminApi } from "../api";
import type {
  ActionType, ApproverType, Operator, WorkflowDefinition, WorkflowStage,
} from "../types";
import { APPROVER_LABEL, DOC_LABEL } from "../workflowLanguage";
import {
  ACTION_PARAM, EVENT_TITLE, OPERATOR_LABEL, fieldLabel,
  operatorsFor, ruleSentence,
} from "../ruleLanguage";

type TemplateKey = "STANDARD_INDENT" | "LARGE_INDENT" | "ALLOCATION" | "SHORTAGE";

interface Template {
  key: TemplateKey;
  name: string;
  description: string;
  docType: "INDENT" | "ALLOCATION" | "MR";
  icon: typeof FileText;
}

const TEMPLATES: Template[] = [
  {
    key: "STANDARD_INDENT",
    name: "Standard request approval",
    description: "The request goes through the employee's reporting manager.",
    docType: "INDENT",
    icon: FileText,
  },
  {
    key: "LARGE_INDENT",
    name: "Extra approval for large requests",
    description: "Add Department Head and senior approval only above chosen quantities.",
    docType: "INDENT",
    icon: ClipboardCheck,
  },
  {
    key: "ALLOCATION",
    name: "Inventory allocation approval",
    description: "An Inventory Executive decides quantity; their manager approves it.",
    docType: "ALLOCATION",
    icon: Boxes,
  },
  {
    key: "SHORTAGE",
    name: "Large shortage approval",
    description: "A shortage MR gets an extra senior approval above a chosen quantity.",
    docType: "MR",
    icon: PackageCheck,
  },
];

const stage = (
  sequence: number,
  name: string,
  approverType: ApproverType,
  values: Partial<WorkflowStage> = {},
): WorkflowStage => ({
  sequence,
  name,
  approver_type: approverType,
  approval_mode: "ANY_ONE",
  is_optional: false,
  can_edit_document: false,
  sla_hours: 24,
  conditions: [],
  ...values,
});

const thresholdCondition = (value: string) => [{
  field_name: "total_quantity",
  operator: "GTE" as Operator,
  field_value: value,
  logic: "AND" as const,
}];

function flowText(stages: WorkflowStage[], positions: { id: number; name: string }[]) {
  const who = (item: WorkflowStage) => {
    if (item.approver_type === "POSITION") {
      return positions.find((row) => row.id === item.position_id)?.name ?? "chosen senior";
    }
    return APPROVER_LABEL[item.approver_type] ?? item.approver_type;
  };
  return stages.map((item) => {
    const condition = item.conditions[0];
    return condition
      ? `${who(item)} when quantity is at least ${condition.field_value}`
      : who(item);
  });
}

export function PoliciesPage() {
  const qc = useQueryClient();
  const [templateKey, setTemplateKey] = useState<TemplateKey | null>(null);
  const [policyName, setPolicyName] = useState("");
  const [departmentThreshold, setDepartmentThreshold] = useState("100");
  const [seniorThreshold, setSeniorThreshold] = useState("200");
  const [seniorPositionId, setSeniorPositionId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [automationOpen, setAutomationOpen] = useState(false);
  const [automationName, setAutomationName] = useState("Special handling");
  const [eventCode, setEventCode] = useState("INDENT_APPROVED");
  const [conditionField, setConditionField] = useState("priority");
  const [conditionOperator, setConditionOperator] = useState<Operator>("EQ");
  const [conditionValue, setConditionValue] = useState("");
  const [actionType, setActionType] = useState<ActionType>("ROUTE_FULFILLMENT");
  const [actionValue, setActionValue] = useState("INVENTORY");

  const options = useQuery({
    queryKey: ["admin", "workflows", "options"],
    queryFn: adminApi.workflows.options,
  });
  const workflows = useQuery({
    queryKey: ["admin", "workflows"],
    queryFn: adminApi.workflows.list,
  });
  const vocabulary = useQuery({
    queryKey: ["admin", "rules", "vocabulary"],
    queryFn: adminApi.rules.vocabulary,
  });
  const rules = useQuery({
    queryKey: ["admin", "rules", "policies"],
    queryFn: () => adminApi.rules.list({ size: 100 }),
  });

  const template = TEMPLATES.find((item) => item.key === templateKey);
  const builtStages = useMemo<WorkflowStage[]>(() => {
    if (!template) return [];
    if (template.key === "STANDARD_INDENT") {
      return [stage(1, "Reporting manager approval", "REPORTING_MANAGER")];
    }
    if (template.key === "ALLOCATION") {
      return [stage(1, "Inventory Manager approval", "REPORTING_MANAGER")];
    }
    if (template.key === "LARGE_INDENT") {
      return [
        stage(1, "Reporting manager approval", "REPORTING_MANAGER"),
        stage(2, "Department Head approval", "DEPT_HEAD", {
          conditions: thresholdCondition(departmentThreshold),
        }),
        stage(3, "Senior approval", "POSITION", {
          position_id: seniorPositionId ? Number(seniorPositionId) : null,
          conditions: thresholdCondition(seniorThreshold),
        }),
      ];
    }
    return [
      stage(1, "Shortage approval", "REPORTING_MANAGER"),
      stage(2, "Senior shortage approval", "POSITION", {
        position_id: seniorPositionId ? Number(seniorPositionId) : null,
        conditions: thresholdCondition(seniorThreshold),
      }),
    ];
  }, [departmentThreshold, seniorPositionId, seniorThreshold, template]);

  const openTemplate = (item: Template) => {
    setTemplateKey(item.key);
    setPolicyName(item.name);
    setDepartmentThreshold("100");
    setSeniorThreshold(item.key === "SHORTAGE" ? "100" : "200");
    setSeniorPositionId("");
    setError(null);
    setMessage(null);
  };

  const createWorkflow = useMutation({
    mutationFn: () => adminApi.workflows.create({
      code: `POLICY-${template!.docType}-${Date.now()}`,
      name: policyName,
      doc_type: template!.docType,
      is_active: true,
      stages: builtStages,
    }),
    onSuccess: () => {
      setTemplateKey(null);
      setMessage(`${policyName} is now active.`);
      qc.invalidateQueries({ queryKey: ["admin", "workflows"] });
    },
    onError: (reason: Error) => setError(reason.message),
  });

  const needsSenior = templateKey === "LARGE_INDENT" || templateKey === "SHORTAGE";
  const canSave = Boolean(
    policyName.trim()
    && (!needsSenior || seniorPositionId)
    && Number(seniorThreshold) > 0
    && (templateKey !== "LARGE_INDENT" || Number(departmentThreshold) > 0),
  );
  const activeWorkflows = (workflows.data?.items ?? []).filter((row) => row.is_active);
  const activeEvent = vocabulary.data?.items.find((item) => item.code === eventCode);
  const conditionType = activeEvent?.context_schema[conditionField];
  const actionParam = ACTION_PARAM[actionType];
  const automationConditions = conditionField && conditionValue ? [{
    field_name: conditionField,
    operator: conditionOperator,
    field_value: conditionValue,
    logic: "AND" as const,
  }] : [];
  const automationActions = [{
    seq: 1,
    action_type: actionType,
    params: { [actionParam.key]: actionValue },
  }];

  const resetAutomation = () => {
    setAutomationName("Special handling");
    setEventCode("INDENT_APPROVED");
    setConditionField("priority");
    setConditionOperator("EQ");
    setConditionValue("");
    setActionType("ROUTE_FULFILLMENT");
    setActionValue("INVENTORY");
    setError(null);
    setMessage(null);
    setAutomationOpen(true);
  };

  const createAutomation = useMutation({
    mutationFn: () => adminApi.rules.create({
      event_code: eventCode,
      name: automationName,
      priority: 100,
      stop_on_match: true,
      is_active: true,
      conditions: automationConditions,
      actions: automationActions,
    }),
    onSuccess: () => {
      setAutomationOpen(false);
      setMessage(`${automationName} is now active.`);
      qc.invalidateQueries({ queryKey: ["admin", "rules"] });
    },
    onError: (reason: Error) => setError(reason.message),
  });

  return (
    <>
      <PageHeader eyebrow="Admin" title="Approval & Automation" />

      <div className="mb-6 overflow-hidden rounded-2xl border border-brand/20 bg-gradient-to-br from-brand-050 to-content1 p-5 sm:p-6">
        <div className="flex items-start gap-4">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand text-white">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <h2 className="font-display text-xl font-bold text-ink">Describe the policy, not the engine</h2>
            <p className="mt-1 max-w-3xl text-sm text-body">
              Choose a ready-made policy, answer a few business questions, and review
              the sentence before activating it. Technical workflow codes and rule
              fields stay underneath.
            </p>
          </div>
        </div>
      </div>

      {message && (
        <div className="mb-5 flex items-center gap-2 rounded-xl bg-ok-bg px-4 py-3 text-sm text-ok">
          <Check className="h-4 w-4" /> {message}
        </div>
      )}

      <section className="mb-8">
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-ink">Create an approval policy</h2>
          <p className="text-sm text-muted">Start with the situation closest to what you need.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {TEMPLATES.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => openTemplate(item)}
                className="group rounded-xl border border-line bg-content1 p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-md"
              >
                <div className="mb-4 flex items-start justify-between gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-lg bg-brand-050 text-brand">
                    <Icon className="h-5 w-5" />
                  </span>
                  <ChevronRight className="h-4 w-4 text-muted transition group-hover:translate-x-0.5 group-hover:text-brand" />
                </div>
                <div className="font-semibold text-ink">{item.name}</div>
                <p className="mt-1 text-sm text-muted">{item.description}</p>
              </button>
            );
          })}
        </div>
      </section>

      <section className="mb-8">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-ink">Automation</h2>
            <p className="text-sm text-muted">
              The standard actions need no setup. Add a policy only for an exception.
            </p>
          </div>
          <Button variant="subtle" onClick={resetAutomation}>
            <Plus className="h-4 w-4" /> Add exception
          </Button>
        </div>
        <Card className="p-4 sm:p-5">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
            Already protecting the flow
          </div>
          <div className="grid gap-3 lg:grid-cols-3">
            {[
              ["Approved indent", "Send to Inventory for a quantity decision"],
              ["Allocation shortage", "Create one Material Request automatically"],
              ["Approved MR", "Make it available to Procurement"],
            ].map(([when, then], index) => (
              <div key={when} className="flex items-start gap-3 rounded-xl bg-content2 p-3">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-ok-bg text-xs font-bold text-ok">
                  {index + 1}
                </span>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted">When {when}</div>
                  <div className="mt-1 text-sm font-medium text-ink">{then}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-line px-3 py-2 text-xs text-muted">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
            Routing to Inventory is connected now. Notification, approval-selection,
            and field-changing policies can be saved and tested, but their business
            action connections are still pending.
          </div>
        </Card>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-ink">What is active now</h2>
            <p className="text-sm text-muted">A simple summary of both engines.</p>
          </div>
          <div className="text-xs text-muted">
            {activeWorkflows.length} approval policies · {rules.data?.total ?? 0} automation rules
          </div>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          {activeWorkflows.map((workflow: WorkflowDefinition) => (
            <Card key={workflow.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold text-ink">{workflow.name}</div>
                  <div className="mt-1 text-xs text-muted">
                    Applies to {DOC_LABEL[workflow.doc_type] ?? workflow.doc_type}
                  </div>
                </div>
                <span className="rounded-full bg-ok-bg px-2 py-1 text-[11px] font-semibold text-ok">
                  Active
                </span>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1 text-sm text-body">
                {workflow.stages.map((item, index) => (
                  <span key={`${workflow.id}-${item.sequence}`} className="contents">
                    {index > 0 && <ArrowRight className="h-3.5 w-3.5 text-muted" />}
                    <span>{item.name}</span>
                  </span>
                ))}
              </div>
            </Card>
          ))}
          {!activeWorkflows.length && !workflows.isLoading && (
            <Card className="p-5">
              <div className="font-semibold text-ink">Protected standard flow</div>
              <p className="mt-1 text-sm text-muted">
                No custom approval policy is active. The safe built-in flow is running.
              </p>
            </Card>
          )}
        </div>
      </section>

      <Modal
        isOpen={templateKey !== null}
        onOpenChange={() => setTemplateKey(null)}
        placement="center"
        scrollBehavior="inside"
        size="2xl"
      >
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>Create from “{template?.name}”</ModalHeader>
              <ModalBody className="gap-5">
                {error && (
                  <div className="rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">{error}</div>
                )}

                {/* mobile-ok: three one-word step labels at text-xs, ~110px each at 375px. */}
                <div className="grid grid-cols-3 gap-2 text-xs">
                  {["Choose", "Answer", "Review"].map((label, index) => (
                    <div key={label} className="rounded-lg bg-brand-050 px-3 py-2 text-center font-semibold text-brand">
                      <span className="mr-1 opacity-70">{index + 1}.</span>{label}
                    </div>
                  ))}
                </div>

                <Field label="What should this policy be called?">
                  <Input
                    value={policyName}
                    onChange={(event) => setPolicyName(event.target.value)}
                    placeholder="Large request approval"
                  />
                </Field>

                {templateKey === "LARGE_INDENT" && (
                  <Field
                    label="From what quantity should the Department Head approve?"
                    hint="For example, enter 100 to add this approval for 100 or more."
                  >
                    <Input
                      type="number"
                      min="1"
                      value={departmentThreshold}
                      onChange={(event) => setDepartmentThreshold(event.target.value)}
                    />
                  </Field>
                )}

                {needsSenior && (
                  <>
                    <Field label="Who gives the senior approval?">
                      <Select
                        value={seniorPositionId}
                        options={(options.data?.positions ?? []).map((row) => ({
                          value: row.id, label: row.name,
                        }))}
                        onChange={setSeniorPositionId}
                        placeholder="Choose a position"
                      />
                    </Field>
                    <Field
                      label="From what quantity is that senior approval needed?"
                      hint="Requests below this quantity skip the senior approval."
                    >
                      <Input
                        type="number"
                        min="1"
                        value={seniorThreshold}
                        onChange={(event) => setSeniorThreshold(event.target.value)}
                      />
                    </Field>
                  </>
                )}

                <div className="rounded-xl border border-brand/25 bg-brand-050 p-4">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-brand">
                    This is what will happen
                  </div>
                  <div className="space-y-2">
                    {flowText(builtStages, options.data?.positions ?? []).map((text, index) => (
                      <div key={`${text}-${index}`} className="flex items-center gap-3">
                        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand text-xs font-bold text-white">
                          {index + 1}
                        </span>
                        <span className="text-sm font-medium text-ink">{text}</span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-3 text-xs text-muted">
                    New documents use this policy. Documents already awaiting approval
                    continue safely on their existing version.
                  </p>
                </div>
              </ModalBody>
              <ModalFooter>
                <Button variant="ghost" onClick={onClose}>Cancel</Button>
                <Button
                  onClick={() => createWorkflow.mutate()}
                  disabled={!canSave || createWorkflow.isPending}
                >
                  {createWorkflow.isPending ? "Activating…" : "Activate policy"}
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      <Modal
        isOpen={automationOpen}
        onOpenChange={setAutomationOpen}
        placement="center"
        scrollBehavior="inside"
        size="2xl"
      >
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>Add an automation exception</ModalHeader>
              <ModalBody className="gap-5">
                {error && (
                  <div className="rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">{error}</div>
                )}

                <Field label="What should this exception be called?">
                  <Input
                    value={automationName}
                    onChange={(event) => setAutomationName(event.target.value)}
                    placeholder="Urgent large request"
                  />
                </Field>

                <div className="rounded-xl border border-line p-4">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
                    When this happens
                  </div>
                  <Select
                    value={eventCode}
                    options={(vocabulary.data?.items ?? []).map((item) => ({
                      value: item.code,
                      label: EVENT_TITLE[item.code] ?? item.name,
                    }))}
                    onChange={(value) => {
                      const nextEvent = vocabulary.data?.items.find((item) => item.code === value);
                      const nextField = Object.keys(nextEvent?.context_schema ?? {})[0] ?? "";
                      const nextType = nextEvent?.context_schema[nextField];
                      setEventCode(value);
                      setConditionField(nextField);
                      setConditionOperator(nextType === "number" ? "GTE" : "EQ");
                      setConditionValue("");
                    }}
                  />
                </div>

                <div className="rounded-xl border border-line p-4">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
                    Only when
                  </div>
                  <div className="grid gap-3 sm:grid-cols-[1fr_180px_1fr]">
                    <Select
                      value={conditionField}
                      options={Object.keys(activeEvent?.context_schema ?? {}).map((field) => ({
                        value: field, label: fieldLabel(field),
                      }))}
                      onChange={(value) => {
                        const nextType = activeEvent?.context_schema[value];
                        setConditionField(value);
                        setConditionOperator(nextType === "number" ? "GTE" : "EQ");
                        setConditionValue("");
                      }}
                    />
                    <Select
                      value={conditionOperator}
                      options={operatorsFor(conditionType).map((operator) => ({
                        value: operator, label: OPERATOR_LABEL[operator],
                      }))}
                      onChange={(value) => setConditionOperator(value as Operator)}
                    />
                    <Input
                      value={conditionValue}
                      onChange={(event) => setConditionValue(event.target.value)}
                      placeholder={conditionType === "number" ? "Enter a number" : "Enter a value"}
                    />
                  </div>
                </div>

                <div className="rounded-xl border border-line p-4">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
                    Then do this
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Select
                      value={actionType}
                      options={[
                        { value: "ROUTE_FULFILLMENT", label: "Send the work to Inventory" },
                        { value: "NOTIFY", label: "Notify a role or group" },
                        { value: "ROUTE_APPROVAL", label: "Use a chosen approval policy" },
                        { value: "SET_FIELD", label: "Set a document value" },
                      ]}
                      onChange={(value) => {
                        const nextType = value as ActionType;
                        setActionType(nextType);
                        setActionValue(
                          nextType === "ROUTE_FULFILLMENT" ? "INVENTORY" : "",
                        );
                      }}
                    />
                    {actionType === "ROUTE_APPROVAL" ? (
                      <Select
                        value={actionValue}
                        options={activeWorkflows.map((workflow) => ({
                          value: workflow.code, label: workflow.name,
                        }))}
                        onChange={setActionValue}
                        placeholder="Choose an approval policy"
                      />
                    ) : (
                      <Input
                        value={actionValue}
                        disabled={actionType === "ROUTE_FULFILLMENT"}
                        onChange={(event) => setActionValue(event.target.value)}
                        placeholder={actionParam.hint || actionParam.label}
                      />
                    )}
                  </div>
                  {actionType !== "ROUTE_FULFILLMENT" && (
                    <p className="mt-2 text-xs text-warn">
                      This policy will evaluate and appear in the execution log. Its
                      business action connection is not active yet.
                    </p>
                  )}
                </div>

                <div className="rounded-xl border border-brand/25 bg-brand-050 p-4">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-brand">
                    In plain words
                  </div>
                  <p className="text-sm font-medium text-ink">
                    {ruleSentence(eventCode, automationConditions, automationActions)}
                  </p>
                </div>
              </ModalBody>
              <ModalFooter>
                <Button variant="ghost" onClick={onClose}>Cancel</Button>
                <Button
                  onClick={() => createAutomation.mutate()}
                  disabled={
                    createAutomation.isPending
                    || !automationName.trim()
                    || !conditionField
                    || !conditionValue.trim()
                    || !actionValue.trim()
                  }
                >
                  {createAutomation.isPending ? "Activating…" : "Activate automation"}
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </>
  );
}
