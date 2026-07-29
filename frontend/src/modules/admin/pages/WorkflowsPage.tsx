import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Switch,
} from "@heroui/react";
import { ArrowRight, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import {
  Button, Card, Field, Input, PageHeader, ResponsiveList, Select, type Column,
} from "@/shared/components";
import { adminApi } from "../api";
import type {
  ApproverType, ApprovalMode, Operator, WorkflowCondition, WorkflowDefinition,
  WorkflowStage,
} from "../types";
import {
  APPROVER_LABEL, DOC_LABEL, MODE_LABEL, approverSentence, workflowSentence,
} from "../workflowLanguage";

type Draft = Pick<WorkflowDefinition, "code" | "name" | "doc_type" | "is_active" | "stages">;

const newStage = (sequence: number): WorkflowStage => ({
  sequence,
  name: sequence === 1 ? "Manager approval" : `Approval ${sequence}`,
  approver_type: "REPORTING_MANAGER",
  approval_mode: "ANY_ONE",
  is_optional: false,
  can_edit_document: false,
  sla_hours: 24,
  conditions: [],
});

const cleanDraft = (workflow: WorkflowDefinition): Draft => ({
  code: workflow.code,
  name: workflow.name,
  doc_type: workflow.doc_type,
  is_active: true,
  stages: workflow.stages.map((stage) => ({
    ...stage,
    conditions: stage.conditions.map((condition) => ({ ...condition })),
  })),
});

export function WorkflowsPage() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [advancedStage, setAdvancedStage] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const definitions = useQuery({
    queryKey: ["admin", "workflows"],
    queryFn: adminApi.workflows.list,
  });
  const options = useQuery({
    queryKey: ["admin", "workflows", "options"],
    queryFn: adminApi.workflows.options,
  });

  const active = useMemo(
    () => (definitions.data?.items ?? []).filter((row) => row.is_active),
    [definitions.data],
  );

  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "workflows"] });
  const save = useMutation({
    mutationFn: () => editingId == null
      ? adminApi.workflows.create(draft!)
      : adminApi.workflows.update(editingId, draft!),
    onSuccess: () => {
      setDraft(null);
      setEditingId(null);
      refresh();
    },
    onError: (err: Error) => setError(err.message),
  });
  const deactivate = useMutation({
    mutationFn: adminApi.workflows.deactivate,
    onSuccess: () => {
      setDraft(null);
      refresh();
    },
    onError: (err: Error) => setError(err.message),
  });

  const openNew = () => {
    const docType = options.data?.doc_types[0] ?? "INDENT";
    setEditingId(null);
    setError(null);
    setAdvancedStage(null);
    setDraft({
      code: `WF-${docType}`,
      name: `${DOC_LABEL[docType] ?? docType} approval`,
      doc_type: docType,
      is_active: true,
      stages: [newStage(1)],
    });
  };

  const openEdit = async (row: WorkflowDefinition) => {
    const full = await adminApi.workflows.get(row.id);
    setEditingId(row.id);
    setError(null);
    setAdvancedStage(null);
    setDraft(cleanDraft(full));
  };

  const patch = (values: Partial<Draft>) => setDraft((current) => ({
    ...current!,
    ...values,
  }));
  const patchStage = (index: number, values: Partial<WorkflowStage>) => patch({
    stages: draft!.stages.map((stage, stageIndex) =>
      stageIndex === index ? { ...stage, ...values } : stage),
  });
  const patchCondition = (
    stageIndex: number,
    conditionIndex: number,
    values: Partial<WorkflowCondition>,
  ) => patchStage(stageIndex, {
    conditions: draft!.stages[stageIndex].conditions.map((condition, index) =>
      index === conditionIndex ? { ...condition, ...values } : condition),
  });

  const columns: Column<WorkflowDefinition>[] = [
    {
      key: "workflow",
      header: "Approval flow",
      render: (row) => (
        <div>
          <div className="font-semibold text-ink">{row.name}</div>
          <div className="mt-0.5 text-xs text-muted">
            {workflowSentence(row, options.data)}
          </div>
        </div>
      ),
    },
    {
      key: "version",
      header: "Version",
      render: (row) => <span className="text-muted">v{row.version}</span>,
    },
    {
      key: "state",
      header: "State",
      render: (row) => (
        <span className={`rounded-full px-2 py-1 text-[11px] font-semibold uppercase ${
          row.is_active ? "bg-ok-bg text-ok" : "bg-default text-muted"
        }`}>
          {row.is_active ? "Active" : "Previous"}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Approval Workflows"
        actions={<Button onClick={openNew}><Plus className="h-4 w-4" /> New workflow</Button>}
      />

      <div className="mb-5 rounded-xl border border-ok/25 bg-ok-bg p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-ok" />
          <div>
            <h2 className="font-semibold text-ink">The standard flow is protected</h2>
            <p className="mt-1 text-sm text-body">
              These settings customize who approves. If a workflow is missing or has
              nobody to approve it, the application uses the safe code-level flow below.
            </p>
          </div>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          {(options.data?.default_flow ?? []).map((flow) => (
            <div key={flow.doc_type} className="rounded-lg bg-content1 p-3">
              <div className="text-sm font-semibold text-ink">{flow.title}</div>
              <div className="mt-2 flex flex-wrap items-center gap-1 text-xs text-body">
                {flow.steps.map((step, index) => (
                  <span key={step} className="contents">
                    {index > 0 && <ArrowRight className="h-3 w-3 text-muted" />}
                    <span>{step}</span>
                  </span>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted">{flow.fallback}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mb-3">
        <h2 className="text-sm font-semibold text-ink">Configured workflows</h2>
        <p className="text-xs text-muted">
          There is one active version per document type. Opening an old version and
          saving it creates a new version; running documents are never changed.
        </p>
      </div>

      <Card className="p-2">
        <ResponsiveList
          data={definitions.data?.items ?? []}
          loading={definitions.isLoading}
          keyOf={(row) => row.id}
          columns={columns}
          onRowClick={openEdit}
          empty="No workflows are configured. The safe code-level flow will still operate."
          renderCard={(row) => (
            <div>
              <div className="flex items-start justify-between gap-2">
                <span className="font-semibold text-ink">{row.name}</span>
                <span className="text-xs text-muted">v{row.version}</span>
              </div>
              <p className="mt-1 text-xs text-muted">{workflowSentence(row, options.data)}</p>
            </div>
          )}
        />
      </Card>

      <Modal
        isOpen={draft !== null}
        onOpenChange={() => setDraft(null)}
        placement="center"
        scrollBehavior="inside"
        size="3xl"
      >
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>
                {editingId == null ? "Build an approval workflow" : "Create a new version"}
              </ModalHeader>
              <ModalBody className="gap-5">
                {error && (
                  <div className="rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">{error}</div>
                )}

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Document">
                    <Select
                      value={draft?.doc_type ?? ""}
                      options={(options.data?.doc_types ?? []).map((value) => ({
                        value, label: DOC_LABEL[value] ?? value,
                      }))}
                      onChange={(value) => {
                        const docType = String(value);
                        patch({
                          doc_type: docType,
                          code: editingId == null ? `WF-${docType}` : draft!.code,
                        });
                      }}
                    />
                  </Field>
                  <Field label="Workflow name">
                    <Input
                      value={draft?.name ?? ""}
                      onChange={(event) => patch({ name: event.target.value })}
                      placeholder="Inventory allocation approval"
                    />
                  </Field>
                </div>

                <div className="rounded-xl border border-brand/25 bg-brand-050 px-4 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-brand">
                    In plain words
                  </div>
                  <p className="mt-1 text-sm text-ink">
                    {draft ? workflowSentence(draft as WorkflowDefinition, options.data) : ""}
                  </p>
                </div>

                <div>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-ink">Approval stages</h3>
                      <p className="text-xs text-muted">They run from top to bottom.</p>
                    </div>
                    <Button
                      variant="ghost"
                      onClick={() => patch({
                        stages: [...draft!.stages, newStage(draft!.stages.length + 1)],
                      })}
                    >
                      <Plus className="h-4 w-4" /> Add stage
                    </Button>
                  </div>

                  <div className="space-y-3">
                    {(draft?.stages ?? []).map((stage, stageIndex) => {
                      const targetRows =
                        stage.approver_type === "POSITION" ? options.data?.positions :
                        stage.approver_type === "ROLE" ? options.data?.roles :
                        stage.approver_type === "SPECIFIC_USER" ? options.data?.employees :
                        undefined;
                      const targetValue =
                        stage.approver_type === "POSITION" ? stage.position_id :
                        stage.approver_type === "ROLE" ? stage.role_id :
                        stage.employee_id;

                      return (
                        <div key={stageIndex} className="rounded-xl border border-line p-4">
                          <div className="mb-3 flex items-center gap-2">
                            <span className="grid h-7 w-7 place-items-center rounded-full bg-brand text-xs font-bold text-white">
                              {stageIndex + 1}
                            </span>
                            <Input
                              value={stage.name}
                              onChange={(event) => patchStage(stageIndex, { name: event.target.value })}
                              placeholder="Stage name"
                            />
                            <button
                              type="button"
                              aria-label="Remove stage"
                              onClick={() => patch({
                                stages: draft!.stages
                                  .filter((_, index) => index !== stageIndex)
                                  .map((item, index) => ({ ...item, sequence: index + 1 })),
                              })}
                              className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-muted hover:bg-content2 hover:text-bad"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>

                          <div className="grid gap-3 sm:grid-cols-2">
                            <Field label="Who approves?">
                              <Select
                                value={stage.approver_type}
                                options={(options.data?.approver_types ?? []).map((value) => ({
                                  value, label: APPROVER_LABEL[value] ?? value,
                                }))}
                                onChange={(value) => patchStage(stageIndex, {
                                  approver_type: value as ApproverType,
                                  position_id: null,
                                  role_id: null,
                                  employee_id: null,
                                })}
                              />
                            </Field>
                            {targetRows && (
                              <Field label="Choose the approver">
                                <Select
                                  value={targetValue ?? ""}
                                  options={targetRows.map((row) => ({
                                    value: row.id, label: row.name,
                                  }))}
                                  onChange={(value) => patchStage(stageIndex, {
                                    position_id: stage.approver_type === "POSITION" ? Number(value) : null,
                                    role_id: stage.approver_type === "ROLE" ? Number(value) : null,
                                    employee_id: stage.approver_type === "SPECIFIC_USER" ? Number(value) : null,
                                  })}
                                  placeholder="Choose one"
                                />
                              </Field>
                            )}
                          </div>

                          <p className="mt-2 text-xs text-muted">
                            This stage goes to {approverSentence(stage, options.data)}.
                          </p>

                          <button
                            type="button"
                            onClick={() => setAdvancedStage(
                              advancedStage === stageIndex ? null : stageIndex,
                            )}
                            className="mt-3 text-sm font-medium text-brand hover:underline"
                          >
                            {advancedStage === stageIndex ? "Hide" : "Show"} stage options
                          </button>

                          {advancedStage === stageIndex && (
                            <div className="mt-3 space-y-3 rounded-lg bg-content2 p-3">
                              <div className="grid gap-3 sm:grid-cols-2">
                                <Field label="How is this stage approved?">
                                  <Select
                                    value={stage.approval_mode}
                                    options={(options.data?.approval_modes ?? []).map((value) => ({
                                      value, label: MODE_LABEL[value] ?? value,
                                    }))}
                                    onChange={(value) => patchStage(stageIndex, {
                                      approval_mode: value as ApprovalMode,
                                    })}
                                  />
                                </Field>
                                <Field label="Target time (hours)">
                                  <Input
                                    type="number"
                                    value={String(stage.sla_hours ?? 24)}
                                    onChange={(event) => patchStage(stageIndex, {
                                      sla_hours: Number(event.target.value) || 24,
                                    })}
                                  />
                                </Field>
                              </div>

                              <div className="flex items-center justify-between">
                                <div>
                                  <div className="text-sm font-medium text-body">Optional stage</div>
                                  <div className="text-xs text-muted">Skip if nobody is resolved.</div>
                                </div>
                                <Switch
                                  size="sm"
                                  isSelected={stage.is_optional}
                                  onValueChange={(value) => patchStage(stageIndex, {
                                    is_optional: value,
                                  })}
                                />
                              </div>

                              <div>
                                <div className="mb-2 flex items-center justify-between">
                                  <span className="text-sm font-medium text-body">Run only when…</span>
                                  <Button
                                    variant="ghost"
                                    onClick={() => patchStage(stageIndex, {
                                      conditions: [...stage.conditions, {
                                        field_name: "",
                                        operator: "EQ",
                                        field_value: "",
                                        logic: "AND",
                                      }],
                                    })}
                                  >
                                    <Plus className="h-4 w-4" /> Add condition
                                  </Button>
                                </div>
                                <div className="space-y-2">
                                  {stage.conditions.map((condition, conditionIndex) => (
                                    <div key={conditionIndex} className="flex flex-wrap gap-2">
                                      <Input
                                        value={condition.field_name}
                                        placeholder="Field, e.g. total_amount"
                                        onChange={(event) => patchCondition(
                                          stageIndex, conditionIndex,
                                          { field_name: event.target.value },
                                        )}
                                      />
                                      <div className="w-36">
                                        <Select
                                          value={condition.operator}
                                          options={(options.data?.operators ?? []).map((value) => ({
                                            value, label: value,
                                          }))}
                                          onChange={(value) => patchCondition(
                                            stageIndex, conditionIndex,
                                            { operator: value as Operator },
                                          )}
                                        />
                                      </div>
                                      <Input
                                        value={condition.field_value}
                                        placeholder="Value"
                                        onChange={(event) => patchCondition(
                                          stageIndex, conditionIndex,
                                          { field_value: event.target.value },
                                        )}
                                      />
                                      <button
                                        type="button"
                                        aria-label="Remove condition"
                                        onClick={() => patchStage(stageIndex, {
                                          conditions: stage.conditions.filter(
                                            (_, index) => index !== conditionIndex,
                                          ),
                                        })}
                                        className="grid h-11 w-11 place-items-center rounded-lg text-muted hover:text-bad"
                                      >
                                        <X className="h-4 w-4" />
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </ModalBody>

              <ModalFooter className="justify-between">
                <div>
                  {editingId != null && active.some((row) => row.id === editingId) && (
                    <Button
                      variant="ghost"
                      onClick={() => deactivate.mutate(editingId)}
                      disabled={deactivate.isPending}
                    >
                      {deactivate.isPending ? "Turning off…" : "Turn off this workflow"}
                    </Button>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={onClose}>Cancel</Button>
                  <Button
                    onClick={() => save.mutate()}
                    disabled={!draft?.name.trim() || !draft?.stages.length}
                  >
                    {save.isPending
                      ? "Saving…"
                      : editingId == null ? "Create workflow" : "Save as new version"}
                  </Button>
                </div>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </>
  );
}
