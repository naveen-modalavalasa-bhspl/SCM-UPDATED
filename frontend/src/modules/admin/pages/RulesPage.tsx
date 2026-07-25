import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Switch,
} from "@heroui/react";
import { AlertTriangle, Play, Plus, Trash2, X } from "lucide-react";
import {
  Button, Can, Field, Input, PageHeader, ResponsiveList, Select, type Column,
} from "@/shared/components";
import { adminApi } from "../api";
import type {
  ActionType, Conflict, Operator, Rule, RuleAction, RuleCondition, SimulateResult,
} from "../types";

/** Params each action type expects, so the builder asks for the right field. */
const ACTION_PARAM: Record<ActionType, { key: string; label: string; hint: string }> = {
  ROUTE_APPROVAL: { key: "workflow_code", label: "Workflow code", hint: "WF_INDENT_HIGH" },
  ROUTE_FULFILLMENT: { key: "target", label: "Target", hint: "INVENTORY | WAREHOUSE | PROCUREMENT" },
  SPLIT_FULFILLMENT: { key: "targets", label: "Targets (comma separated)", hint: "INVENTORY,WAREHOUSE" },
  NOTIFY: { key: "recipient", label: "Recipient", hint: "role or group code" },
  SET_FIELD: { key: "value", label: "Value", hint: "field=value" },
};

const emptyRule = (eventCode: string): Partial<Rule> => ({
  event_code: eventCode, name: "", priority: 100, stop_on_match: false,
  is_active: true, conditions: [], actions: [],
});

export function RulesPage() {
  const qc = useQueryClient();
  const [eventCode, setEventCode] = useState<string>("");
  const [draft, setDraft] = useState<Partial<Rule> | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [simContext, setSimContext] = useState("{}");
  const [simResult, setSimResult] = useState<SimulateResult | null>(null);
  const [simOpen, setSimOpen] = useState(false);

  const vocab = useQuery({ queryKey: ["admin", "rules", "vocab"], queryFn: adminApi.rules.vocabulary });
  const events = vocab.data?.items ?? [];
  const activeEvent = eventCode || events[0]?.code || "";

  const rules = useQuery({
    queryKey: ["admin", "rules", activeEvent],
    queryFn: () => adminApi.rules.list({ event_code: activeEvent || undefined, size: 100 }),
    enabled: Boolean(activeEvent),
  });

  const contextFields = useMemo(() => {
    const schema = events.find((e) => e.code === (draft?.event_code ?? activeEvent))?.context_schema ?? {};
    return Object.keys(schema).map((f) => ({ value: f, label: f }));
  }, [events, draft?.event_code, activeEvent]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "rules"] });

  const save = useMutation({
    mutationFn: (force: boolean) => {
      const body = { ...draft, force } as Partial<Rule> & { force: boolean };
      return editingId == null
        ? adminApi.rules.create(body)
        : adminApi.rules.update(editingId, body);
    },
    onSuccess: (r) => {
      // A same-priority clash is refused outright; a lower-severity one comes back
      // as a warning so the admin sees it without being blocked.
      setConflicts(r.warnings ?? []);
      setDraft(null);
      refresh();
    },
    onError: (e: Error) => setError(e.message),
  });

  const deactivate = useMutation({
    mutationFn: (id: number) => adminApi.rules.deactivate(id),
    onSuccess: () => { setDraft(null); refresh(); },
    onError: (e: Error) => setError(e.message),
  });

  const simulate = useMutation({
    mutationFn: () => adminApi.rules.simulate(activeEvent, JSON.parse(simContext || "{}")),
    onSuccess: setSimResult,
    onError: (e: Error) => setError(`Simulate failed: ${e.message}`),
  });

  const openNew = () => {
    setEditingId(null); setDraft(emptyRule(activeEvent));
    setConflicts([]); setError(null);
  };

  const openEdit = async (row: Rule) => {
    const full = await adminApi.rules.get(row.id);
    setEditingId(row.id); setDraft(full); setConflicts([]); setError(null);
  };

  const patch = (p: Partial<Rule>) => setDraft((d) => ({ ...d!, ...p }));

  const setCondition = (i: number, c: Partial<RuleCondition>) =>
    patch({ conditions: draft!.conditions!.map((x, j) => (j === i ? { ...x, ...c } : x)) });
  const setAction = (i: number, a: Partial<RuleAction>) =>
    patch({ actions: draft!.actions!.map((x, j) => (j === i ? { ...x, ...a } : x)) });

  const columns: Column<Rule>[] = [
    { key: "priority", header: "Priority",
      render: (r) => <span className="mono font-semibold text-ink">{r.priority}</span> },
    { key: "name", header: "Rule", render: (r) => r.name },
    { key: "stop", header: "", hideOnNarrow: true,
      render: (r) => (r.stop_on_match ? "Stops here" : "") },
    { key: "active", header: "Status",
      render: (r) => (
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
          r.is_active ? "bg-ok-bg text-ok" : "bg-default text-muted"
        }`}>
          {r.is_active ? "Active" : "Inactive"}
        </span>
      ) },
  ];

  return (
    <>
      <PageHeader eyebrow="Admin" title="Rules engine" />

      {conflicts.length > 0 && (
        <div className="mb-4 rounded-xl border border-warn/30 bg-warn-bg px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-warn">
            <AlertTriangle className="h-4 w-4" /> Saved with overlapping rules
          </div>
          <ul className="mt-1.5 space-y-1 text-xs text-body">
            {conflicts.map((c, i) => <li key={i}>{c.message}</li>)}
          </ul>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 sm:max-w-md">
          <Select
            value={activeEvent}
            options={events.map((e) => ({ value: e.code, label: `${e.name} (${e.code})` }))}
            onChange={(v) => setEventCode(String(v))}
            placeholder="Choose an event…"
          />
        </div>
        <Button variant="ghost" onClick={() => { setSimResult(null); setSimOpen(true); }}>
          <Play className="h-4 w-4" /> Simulate
        </Button>
        <Can do="admin.rules.manage">
          <Button onClick={openNew}><Plus className="h-4 w-4" /> New rule</Button>
        </Can>
      </div>

      <p className="mb-4 text-sm text-muted">
        {events.find((e) => e.code === activeEvent)?.description ??
          "Rules match on the event's context and return actions. Lower priority runs first."}
      </p>

      <ResponsiveList
        data={rules.data?.items ?? []}
        loading={rules.isLoading}
        keyOf={(r) => r.id}
        columns={columns}
        onRowClick={openEdit}
        empty="No rules for this event yet."
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="mono font-semibold text-ink">#{r.priority}</span>
              <span className="text-xs text-muted">{r.is_active ? "Active" : "Inactive"}</span>
            </div>
            <div className="text-sm text-body">{r.name}</div>
          </div>
        )}
      />

      {/* ---------------- rule builder ---------------- */}
      <Modal isOpen={draft !== null} onOpenChange={() => setDraft(null)}
             placement="center" scrollBehavior="inside" size="2xl">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>{editingId == null ? "New rule" : "Edit rule"}</ModalHeader>
              <ModalBody className="gap-4">
                {error && (
                  <div className="rounded-lg bg-bad-bg px-3 py-2 text-sm font-medium text-bad">
                    {error}
                  </div>
                )}

                <Field label="Rule name">
                  <Input value={draft?.name ?? ""}
                         onChange={(e) => patch({ name: e.target.value })}
                         placeholder="Bulk consumables go to the warehouse" />
                </Field>

                <div className="grid grid-cols-2 gap-3">
                  <Field label="Priority (lower runs first)">
                    <Input type="number" value={String(draft?.priority ?? 100)}
                           onChange={(e) => patch({ priority: Number(e.target.value) })} />
                  </Field>
                  <div className="flex items-end gap-4 pb-2">
                    <label className="flex items-center gap-2 text-sm text-body">
                      <Switch size="sm" color="primary"
                              isSelected={Boolean(draft?.stop_on_match)}
                              onValueChange={(v) => patch({ stop_on_match: v })} />
                      Stop here
                    </label>
                    <label className="flex items-center gap-2 text-sm text-body">
                      <Switch size="sm" color="primary"
                              isSelected={draft?.is_active ?? true}
                              onValueChange={(v) => patch({ is_active: v })} />
                      Active
                    </label>
                  </div>
                </div>

                {/* ---- conditions ---- */}
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-semibold text-ink">
                      When (no conditions = always)
                    </span>
                    <Button variant="ghost" onClick={() => patch({
                      conditions: [...(draft!.conditions ?? []), {
                        field_name: contextFields[0]?.value ?? "", operator: "EQ" as Operator,
                        field_value: "", logic: "AND",
                      }],
                    })}>
                      <Plus className="h-4 w-4" /> Condition
                    </Button>
                  </div>
                  <div className="space-y-2">
                    {(draft?.conditions ?? []).map((c, i) => (
                      <div key={i} className="flex flex-wrap items-center gap-2">
                        {i > 0 && (
                          <div className="w-16">
                            <Select value={c.logic} options={[{ value: "AND", label: "AND" },
                                                              { value: "OR", label: "OR" }]}
                                    onChange={(v) => setCondition(i, { logic: v as "AND" | "OR" })} />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <Select value={c.field_name} options={contextFields}
                                  onChange={(v) => setCondition(i, { field_name: String(v) })}
                                  placeholder="Field" />
                        </div>
                        <div className="w-28">
                          <Select value={c.operator}
                                  options={(vocab.data?.operators ?? []).map((o) => ({ value: o, label: o }))}
                                  onChange={(v) => setCondition(i, { operator: v as Operator })} />
                        </div>
                        <div className="w-32">
                          <Input value={c.field_value}
                                 placeholder={c.operator === "BETWEEN" ? "10,50" : "value"}
                                 onChange={(e) => setCondition(i, { field_value: e.target.value })} />
                        </div>
                        <Button variant="ghost"
                                onClick={() => patch({
                                  conditions: draft!.conditions!.filter((_, j) => j !== i),
                                })}>
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>

                {/* ---- actions ---- */}
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-semibold text-ink">Then</span>
                    <Button variant="ghost" onClick={() => patch({
                      actions: [...(draft!.actions ?? []), {
                        seq: (draft!.actions?.length ?? 0) + 1,
                        action_type: "ROUTE_FULFILLMENT" as ActionType, params: {},
                      }],
                    })}>
                      <Plus className="h-4 w-4" /> Action
                    </Button>
                  </div>
                  <div className="space-y-2">
                    {(draft?.actions ?? []).map((a, i) => {
                      const spec = ACTION_PARAM[a.action_type];
                      return (
                        <div key={i} className="flex flex-wrap items-center gap-2">
                          <div className="min-w-0 flex-1">
                            <Select value={a.action_type}
                                    options={(vocab.data?.action_types ?? []).map((t) => ({ value: t, label: t }))}
                                    onChange={(v) => setAction(i, {
                                      action_type: v as ActionType, params: {},
                                    })} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <Input
                              value={String(a.params?.[spec.key] ?? "")}
                              placeholder={spec.hint}
                              onChange={(e) => setAction(i, {
                                params: { ...a.params, [spec.key]: e.target.value },
                              })}
                            />
                          </div>
                          <Button variant="ghost"
                                  onClick={() => patch({
                                    actions: draft!.actions!.filter((_, j) => j !== i),
                                  })}>
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      );
                    })}
                    {!draft?.actions?.length && (
                      <p className="text-xs text-muted">A rule needs at least one action.</p>
                    )}
                  </div>
                </div>
              </ModalBody>

              <ModalFooter className="justify-between">
                <div>
                  {editingId != null && (
                    <Can do="admin.rules.manage">
                      <Button variant="ghost" className="text-bad hover:bg-bad-bg"
                              onClick={() => deactivate.mutate(editingId)}>
                        <Trash2 className="h-4 w-4" /> Deactivate
                      </Button>
                    </Can>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={onClose}>Cancel</Button>
                  {/* force=true is offered only after the server refuses, so the
                      override is a deliberate second action. */}
                  {error?.toLowerCase().includes("conflict") && (
                    <Button variant="ghost" className="text-warn"
                            onClick={() => { setError(null); save.mutate(true); }}>
                      Save anyway
                    </Button>
                  )}
                  <Button onClick={() => { setError(null); save.mutate(false); }}
                          disabled={save.isPending}>
                    {save.isPending ? "Saving…" : "Save"}
                  </Button>
                </div>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      {/* ---------------- simulator ---------------- */}
      <Modal isOpen={simOpen} onOpenChange={setSimOpen} placement="center">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="flex-col items-start gap-0.5">
                <span>Simulate {activeEvent}</span>
                <span className="text-xs font-normal text-muted">
                  Dry run. Nothing is recorded and no document is touched.
                </span>
              </ModalHeader>
              <ModalBody className="gap-3">
                <Field label="Context (JSON)">
                  <textarea
                    value={simContext}
                    onChange={(e) => setSimContext(e.target.value)}
                    rows={6}
                    className="mono w-full rounded-xl border border-line bg-content1 p-3 text-sm outline-none focus:border-brand"
                    placeholder='{"quantity": 500, "category_code": "CONSUMABLE"}'
                  />
                </Field>
                <div className="text-xs text-muted">
                  Fields: {contextFields.map((f) => f.value).join(", ") || "—"}
                </div>
                {simResult && (
                  <div className={`rounded-lg px-3 py-2.5 ${
                    simResult.matched ? "bg-ok-bg" : "bg-default"
                  }`}>
                    <div className={`text-sm font-semibold ${
                      simResult.matched ? "text-ok" : "text-muted"
                    }`}>
                      {simResult.matched ? "Matched" : "No rule matched"}
                    </div>
                    <ul className="mt-1 space-y-1 text-xs text-body">
                      {simResult.actions.map((a, i) => (
                        <li key={i}>
                          <span className="mono font-semibold">{a.action_type}</span>{" "}
                          {JSON.stringify(a.params)} — {a.rule_name}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </ModalBody>
              <ModalFooter>
                <Button variant="ghost" onClick={onClose}>Close</Button>
                <Button onClick={() => simulate.mutate()} disabled={simulate.isPending}>
                  <Play className="h-4 w-4" /> {simulate.isPending ? "Running…" : "Run"}
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </>
  );
}
