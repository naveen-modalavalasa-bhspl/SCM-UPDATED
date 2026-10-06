import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Switch,
} from "@heroui/react";
import { AlertTriangle, Play, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import {
  Button, Can, Field, Input, PageHeader, Select, type Column,
} from "@/shared/components";
import { ResponsiveList } from "@/shared/components";
import { adminApi } from "../api";
import {
  ACTION_LABEL, ACTION_PARAM, EVENT_SENTENCE, EVENT_TITLE, TEAM_LABEL,
  OPERATOR_LABEL, fieldLabel, operatorsFor, ruleSentence, valueHint,
} from "../ruleLanguage";
import type {
  ActionType, Conflict, Operator, Rule, RuleAction, RuleCondition, SimulateResult,
} from "../types";

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
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [simContext, setSimContext] = useState("{}");
  const [simResult, setSimResult] = useState<SimulateResult | null>(null);
  const [simOpen, setSimOpen] = useState(false);

  const vocab = useQuery({ queryKey: ["admin", "rules", "vocab"], queryFn: adminApi.rules.vocabulary });
  const events = useMemo(() => vocab.data?.items ?? [], [vocab.data]);

  // Counts drive both the dropdown labels and which event the page opens on. Opening
  // on an event with no rules made the screen look broken and empty.
  const counts = useQuery({
    queryKey: ["admin", "rules", "counts", events.map((e) => e.code).join()],
    queryFn: async () => {
      const pairs = await Promise.all(events.map(async (e) => {
        const page = await adminApi.rules.list({ event_code: e.code, size: 1 });
        return [e.code, page.total] as const;
      }));
      return Object.fromEntries(pairs) as Record<string, number>;
    },
    enabled: events.length > 0,
  });

  useEffect(() => {
    if (eventCode || !events.length) return;
    const withRules = events.find((e) => (counts.data?.[e.code] ?? 0) > 0);
    setEventCode((withRules ?? events[0]).code);
  }, [events, counts.data, eventCode]);

  const activeEvent = eventCode || events[0]?.code || "";
  const activeSchema = events.find((e) => e.code === activeEvent)?.context_schema ?? {};

  const rules = useQuery({
    queryKey: ["admin", "rules", activeEvent],
    queryFn: () => adminApi.rules.list({ event_code: activeEvent, size: 100 }),
    enabled: Boolean(activeEvent),
  });

  const draftSchema = events.find(
    (e) => e.code === (draft?.event_code ?? activeEvent))?.context_schema ?? {};
  const fieldOptions = Object.keys(draftSchema)
    .map((f) => ({ value: f, label: fieldLabel(f) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "rules"] });

  const save = useMutation({
    mutationFn: (force: boolean) => {
      const body = { ...draft, force } as Partial<Rule> & { force: boolean };
      return editingId == null
        ? adminApi.rules.create(body)
        : adminApi.rules.update(editingId, body);
    },
    onSuccess: (r) => { setConflicts(r.warnings ?? []); setDraft(null); refresh(); },
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
    onError: () => setError("The example text has a mistake. Check every { } and comma."),
  });

  const openNew = () => {
    setEditingId(null); setDraft(emptyRule(activeEvent));
    setConflicts([]); setError(null); setShowAdvanced(false);
  };
  const openEdit = async (row: Rule) => {
    const full = await adminApi.rules.get(row.id);
    setEditingId(row.id); setDraft(full);
    setConflicts([]); setError(null); setShowAdvanced(false);
  };

  const patch = (p: Partial<Rule>) => setDraft((d) => ({ ...d!, ...p }));
  const setCondition = (i: number, c: Partial<RuleCondition>) =>
    patch({ conditions: draft!.conditions!.map((x, j) => (j === i ? { ...x, ...c } : x)) });
  const setAction = (i: number, a: Partial<RuleAction>) =>
    patch({ actions: draft!.actions!.map((x, j) => (j === i ? { ...x, ...a } : x)) });

  const columns: Column<Rule>[] = [
    {
      key: "rule",
      header: "Rule",
      render: (r) => (
        <div className="min-w-0">
          <div className="font-semibold text-ink">{r.name}</div>
          <div className="mt-0.5 text-xs text-muted">
            {ruleSentence(r.event_code, r.conditions, r.actions)}
          </div>
        </div>
      ),
    },
    {
      key: "state",
      header: "",
      render: (r) => (
        <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
          r.is_active ? "bg-ok-bg text-ok" : "bg-default text-muted"
        }`}>
          {r.is_active ? "On" : "Off"}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader eyebrow="Admin" title="Rules" />

      {conflicts.length > 0 && (
        <div className="mb-4 rounded-xl border border-warn/30 bg-warn-bg px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-warn">
            <AlertTriangle className="h-4 w-4" /> Saved, but two rules can both apply
          </div>
          <ul className="mt-1.5 space-y-1 text-xs text-body">
            {conflicts.map((c, i) => <li key={i}>{c.message}</li>)}
          </ul>
        </div>
      )}

      <p className="mb-4 max-w-[70ch] text-sm text-body">
        A rule tells the system what to do on its own. Pick a moment below, and the
        rules for that moment are listed underneath.
      </p>

      <div className="mb-4 flex items-start gap-3 rounded-xl border border-ok/25 bg-ok-bg px-4 py-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-ok" />
        <div>
          <div className="text-sm font-semibold text-ink">Rules customize a safe default</div>
          <p className="mt-0.5 text-xs text-body">
            If no rule matches, or a route is incomplete, an approved indent still
            goes to Inventory for a human allocation decision. Rules may refine the
            route; they cannot strand the document or skip that safety step.
          </p>
        </div>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 sm:max-w-sm">
          <Select
            value={activeEvent}
            options={events.map((e) => ({
              value: e.code,
              label: `${EVENT_TITLE[e.code] ?? e.name}  (${counts.data?.[e.code] ?? 0})`,
            }))}
            onChange={(v) => setEventCode(String(v))}
            placeholder="Choose a moment…"
          />
        </div>
        <Button variant="ghost" onClick={() => { setSimResult(null); setSimOpen(true); }}>
          <Play className="h-4 w-4" /> Try it out
        </Button>
        <Can do="admin.rules.manage">
          <Button onClick={openNew}><Plus className="h-4 w-4" /> Add a rule</Button>
        </Can>
      </div>

      <div className="mb-4 rounded-xl bg-content2 px-4 py-3 text-sm text-body">
        These rules run <strong>when {EVENT_SENTENCE[activeEvent] ?? "this happens"}</strong>.
      </div>

      <ResponsiveList
        data={rules.data?.items ?? []}
        loading={rules.isLoading}
        keyOf={(r) => r.id}
        columns={columns}
        onRowClick={openEdit}
        empty={`No custom rules yet for when ${EVENT_SENTENCE[activeEvent] ?? "this happens"}. The protected code-level default still applies.`}
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-start justify-between gap-2">
              <span className="font-semibold text-ink">{r.name}</span>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase ${
                r.is_active ? "bg-ok-bg text-ok" : "bg-default text-muted"
              }`}>{r.is_active ? "On" : "Off"}</span>
            </div>
            <div className="text-xs text-muted">
              {ruleSentence(r.event_code, r.conditions, r.actions)}
            </div>
          </div>
        )}
      />

      {/* ------------------------- the builder ------------------------- */}
      <Modal isOpen={draft !== null} onOpenChange={() => setDraft(null)}
             placement="center" scrollBehavior="inside" size="2xl">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>{editingId == null ? "Add a rule" : "Edit rule"}</ModalHeader>
              <ModalBody className="gap-5">
                {error && (
                  <div className="rounded-lg bg-bad-bg px-3 py-2 text-sm font-medium text-bad">
                    {error}
                  </div>
                )}

                <Field label="Give this rule a name">
                  <Input value={draft?.name ?? ""}
                         onChange={(e) => patch({ name: e.target.value })}
                         placeholder="Send big requests to Purchasing" />
                </Field>

                {/* Reading the rule back is what makes it checkable by a non-technical
                    person. It updates as they build, so they never have to imagine it. */}
                <div className="rounded-xl border border-brand/25 bg-brand-050 px-4 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-brand">
                    In plain words
                  </div>
                  <p className="mt-1 text-sm text-ink">
                    {ruleSentence(draft?.event_code ?? activeEvent,
                                  draft?.conditions ?? [], draft?.actions ?? [])}
                  </p>
                </div>

                {/* ---- WHEN ---- */}
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-sm font-semibold text-ink">Only when…</span>
                    <Button variant="ghost" onClick={() => patch({
                      conditions: [...(draft!.conditions ?? []), {
                        field_name: fieldOptions[0]?.value ?? "",
                        operator: "EQ" as Operator, field_value: "", logic: "AND",
                      }],
                    })}>
                      <Plus className="h-4 w-4" /> Add a check
                    </Button>
                  </div>
                  <p className="mb-2 text-xs text-muted">
                    Leave this empty and the rule runs every time.
                  </p>

                  <div className="space-y-2">
                    {(draft?.conditions ?? []).map((c, i) => {
                      const type = draftSchema[c.field_name];
                      const hint = valueHint(c.operator);
                      return (
                        <div key={i} className="flex flex-wrap items-center gap-2">
                          {i > 0 && (
                            <div className="w-20">
                              <Select value={c.logic}
                                      options={[{ value: "AND", label: "and" },
                                                { value: "OR", label: "or" }]}
                                      onChange={(v) => setCondition(i, { logic: v as "AND" | "OR" })} />
                            </div>
                          )}
                          <div className="min-w-[9rem] flex-1">
                            <Select value={c.field_name} options={fieldOptions}
                                    onChange={(v) => setCondition(i, { field_name: String(v) })}
                                    placeholder="Choose something" />
                          </div>
                          <div className="w-36">
                            <Select
                              value={c.operator}
                              options={operatorsFor(type).map((o) => ({
                                value: o, label: OPERATOR_LABEL[o],
                              }))}
                              onChange={(v) => setCondition(i, { operator: v as Operator })}
                            />
                          </div>
                          <div className="w-36">
                            <Input value={c.field_value} placeholder={hint || "value"}
                                   onChange={(e) => setCondition(i, { field_value: e.target.value })} />
                          </div>
                          <button
                            type="button"
                            aria-label="Remove this check"
                            onClick={() => patch({
                              conditions: draft!.conditions!.filter((_, j) => j !== i),
                            })}
                            className="grid h-11 w-11 place-items-center rounded-lg text-muted hover:bg-content2 hover:text-bad"
                          >
                            <X className="h-4 w-4" />
                          </button>
                          {hint && (
                            <p className="w-full pl-1 text-xs text-muted">{hint}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* ---- THEN ---- */}
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-sm font-semibold text-ink">Then the system will…</span>
                    <Button variant="ghost" onClick={() => patch({
                      actions: [...(draft!.actions ?? []), {
                        seq: (draft!.actions?.length ?? 0) + 1,
                        action_type: "ROUTE_FULFILLMENT" as ActionType, params: {},
                      }],
                    })}>
                      <Plus className="h-4 w-4" /> Add a step
                    </Button>
                  </div>

                  <div className="space-y-2">
                    {(draft?.actions ?? []).map((a, i) => {
                      const spec = ACTION_PARAM[a.action_type];
                      const current = String(a.params?.[spec.key] ?? "");
                      return (
                        <div key={i} className="flex flex-wrap items-center gap-2">
                          <div className="min-w-[11rem] flex-1">
                            <Select
                              value={a.action_type}
                              options={(vocab.data?.action_types ?? []).map((t) => ({
                                value: t, label: ACTION_LABEL[t] ?? t,
                              }))}
                              onChange={(v) => setAction(i, {
                                action_type: v as ActionType, params: {},
                              })}
                            />
                          </div>
                          <div className="min-w-[11rem] flex-1">
                            {spec.options ? (
                              <Select
                                value={current}
                                options={spec.options.map((o) => ({
                                  value: o, label: TEAM_LABEL[o] ?? o,
                                }))}
                                onChange={(v) => setAction(i, {
                                  params: { ...a.params, [spec.key]: v },
                                })}
                                placeholder={spec.label}
                              />
                            ) : (
                              <Input value={current} placeholder={spec.label}
                                     onChange={(e) => setAction(i, {
                                       params: { ...a.params, [spec.key]: e.target.value },
                                     })} />
                            )}
                          </div>
                          <button
                            type="button"
                            aria-label="Remove this step"
                            onClick={() => patch({
                              actions: draft!.actions!.filter((_, j) => j !== i),
                            })}
                            className="grid h-11 w-11 place-items-center rounded-lg text-muted hover:bg-content2 hover:text-bad"
                          >
                            <X className="h-4 w-4" />
                          </button>
                          {spec.hint && !spec.options && (
                            <p className="w-full pl-1 text-xs text-muted">{spec.hint}</p>
                          )}
                        </div>
                      );
                    })}
                    {!draft?.actions?.length && (
                      <p className="rounded-lg bg-content2 px-3 py-2 text-xs text-muted">
                        Add at least one step, or the rule does nothing.
                      </p>
                    )}
                  </div>
                </div>

                {/* ---- on/off, and the settings most people never need ---- */}
                <label className="flex items-center justify-between rounded-xl bg-content2 px-4 py-3">
                  <span>
                    <span className="text-sm font-semibold text-ink">Rule is on</span>
                    <span className="block text-xs text-muted">
                      Turn off to stop it without deleting it.
                    </span>
                  </span>
                  <Switch size="sm" color="primary" isSelected={draft?.is_active ?? true}
                          onValueChange={(v) => patch({ is_active: v })} />
                </label>

                <div>
                  <button type="button" onClick={() => setShowAdvanced((s) => !s)}
                          className="text-sm font-medium text-brand hover:underline">
                    {showAdvanced ? "Hide" : "Show"} advanced settings
                  </button>
                  {showAdvanced && (
                    <div className="mt-3 space-y-3 rounded-xl border border-line p-4">
                      <Field label="Which rule wins if two apply (lower number goes first)">
                        <Input type="number" value={String(draft?.priority ?? 100)}
                               onChange={(e) => patch({ priority: Number(e.target.value) })} />
                      </Field>
                      <label className="flex items-center justify-between">
                        <span>
                          <span className="text-sm font-medium text-body">
                            Stop after this rule
                          </span>
                          <span className="block text-xs text-muted">
                            Skip every rule below this one once this one applies.
                          </span>
                        </span>
                        <Switch size="sm" color="primary"
                                isSelected={Boolean(draft?.stop_on_match)}
                                onValueChange={(v) => patch({ stop_on_match: v })} />
                      </label>
                    </div>
                  )}
                </div>
              </ModalBody>

              <ModalFooter className="justify-between">
                <div>
                  {editingId != null && (
                    <Can do="admin.rules.manage">
                      <Button variant="ghost" className="text-bad hover:bg-bad-bg"
                              onClick={() => deactivate.mutate(editingId)}>
                        <Trash2 className="h-4 w-4" /> Turn off
                      </Button>
                    </Can>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={onClose}>Cancel</Button>
                  {/* Only offered after the server refuses, so overriding is a
                      second, deliberate click rather than a checkbox to tick. */}
                  {error?.toLowerCase().includes("conflict") && (
                    <Button variant="ghost" className="text-warn"
                            onClick={() => { setError(null); save.mutate(true); }}>
                      Save it anyway
                    </Button>
                  )}
                  <Button onClick={() => { setError(null); save.mutate(false); }}
                          disabled={save.isPending}>
                    {save.isPending ? "Saving…" : "Save rule"}
                  </Button>
                </div>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      {/* ------------------------- try it out ------------------------- */}
      <Modal isOpen={simOpen} onOpenChange={setSimOpen} placement="center">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="flex-col items-start gap-0.5">
                <span>Try it out</span>
                <span className="text-xs font-normal text-muted">
                  A practice run. Nothing is saved and no real request is touched.
                </span>
              </ModalHeader>
              <ModalBody className="gap-3">
                <p className="text-sm text-body">
                  Describe a pretend {EVENT_SENTENCE[activeEvent] ?? "event"} and see
                  which rules would apply.
                </p>
                <Field label="Example details">
                  <textarea
                    value={simContext}
                    onChange={(e) => setSimContext(e.target.value)}
                    rows={5}
                    className="mono w-full rounded-xl border border-line bg-content1 p-3 text-sm outline-none focus:border-brand"
                    placeholder={'{"quantity": 500}'}
                  />
                </Field>
                <div className="text-xs text-muted">
                  You can use: {Object.keys(activeSchema).map(fieldLabel).join(", ") || "—"}
                </div>

                {simResult && (
                  <div className={`rounded-lg px-3 py-2.5 ${
                    simResult.matched ? "bg-ok-bg" : "bg-content2"
                  }`}>
                    <div className={`text-sm font-semibold ${
                      simResult.matched ? "text-ok" : "text-muted"
                    }`}>
                      {simResult.matched
                        ? "This is what would happen:"
                        : "No rule applies. Nothing would happen automatically."}
                    </div>
                    <ul className="mt-1 space-y-1 text-sm text-body">
                      {simResult.actions.map((a, i) => (
                        <li key={i}>
                          {ACTION_LABEL[a.action_type as ActionType] ?? a.action_type}{" "}
                          <strong>
                            {TEAM_LABEL[String(Object.values(a.params ?? {})[0] ?? "")]
                              ?? String(Object.values(a.params ?? {})[0] ?? "")}
                          </strong>
                          <span className="text-muted"> — from “{a.rule_name}”</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </ModalBody>
              <ModalFooter>
                <Button variant="ghost" onClick={onClose}>Close</Button>
                <Button onClick={() => simulate.mutate()} disabled={simulate.isPending}>
                  <Play className="h-4 w-4" /> {simulate.isPending ? "Checking…" : "Check"}
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </>
  );
}
