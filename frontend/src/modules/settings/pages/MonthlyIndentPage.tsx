/** Settings > Monthly Indent — the month, and what the system does during it.
 *
 *  This screen configures a rhythm, not a record: a window each month when stores
 *  send their indent, a few nudges inside it, and a follow-up to a manager when a
 *  nudge is ignored. It was drawn as four stacked cards of labelled number boxes,
 *  which is the right shape for a document and the wrong one for a schedule — every
 *  question an admin actually arrives with ("does the reminder land inside the
 *  window", "what goes out on the 25th", "is anything switched on at all") had to be
 *  worked out in the head from integers sitting in separate boxes.
 *
 *  So the month leads, drawn as a ribbon with the window as a band and every
 *  scheduled event marked on the day it fires (`MonthRibbon`), and under it the same
 *  schedule read top to bottom as sentences (`buildAgenda`). Both come from
 *  `monthlyIndentPlan`, which mirrors the server's own date arithmetic — the picture
 *  is the schedule, not an illustration of it.
 *
 *  Two rules this screen keeps that the old one did not:
 *
 *  - **One save.** There were three buttons — Save cycle, Save approval flow, Save
 *    approval setting — two of which wrote the same row, so an admin who changed the
 *    window and the flow could press the wrong one and lose half the change with no
 *    warning. Edits now collect in a draft and one bar at the foot saves whatever is
 *    actually different, naming it.
 *  - **No code on screen.** NOT_SUBMITTED, HCM_ROLE and REPORTING_MANAGER were shown
 *    to the person configuring them. Every one of those is a sentence now, and the
 *    sentences live in `monthlyIndentPlan` so the list, the editor and the day panel
 *    cannot word the same condition three ways.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Switch } from "@heroui/react";
import {
  AlertTriangle, ArrowRight, BellRing, CalendarDays, CalendarRange, CheckCircle2,
  ChevronDown, Clock, Flag, FlagOff, Plus, RefreshCw, RotateCcw, Save, Send,
  SlidersHorizontal, Undo2, Users,
} from "lucide-react";

import {
  Alert, Button, Card, ErrorBanner, Field, Input, PageHeader, Select, useToast,
} from "@/shared/components";
import { StepList, stepKey } from "@/modules/admin/components/StepList";
import { adminApi } from "@/modules/admin/api";
import type { CustomLadderStep, FlowRung, StepKind } from "@/modules/admin/types";
import { monthlyIndentApi } from "../api";
import type { MonthlyIndentCycle, MonthlyIndentLog, MonthlyIndentRule } from "../types";
import {
  CONDITION_CHIP, buildAgenda, dateKey, everyPhrase, longDate, prettyTime, shortDate,
} from "../monthlyIndentPlan";
import type { AgendaItem } from "../monthlyIndentPlan";
import { MonthRibbon, type DayMark } from "../components/MonthRibbon";
import {
  ReminderEditor, emptyReminder, type Choice,
} from "../components/ReminderEditor";

const DOC_TYPE = "MONTHLY_INDENT";

const WHICH_MONTH = [
  { value: 0, label: "This month" },
  { value: 1, label: "Next month" },
  { value: 2, label: "The month after next" },
];

const TIMEZONES = ["Asia/Kolkata", "UTC", "Asia/Dubai", "Europe/London"]
  .map((value) => ({ value, label: value }));

const HOW_OFTEN = [
  { value: 15, label: "Every 15 minutes" },
  { value: 30, label: "Every 30 minutes" },
  { value: 60, label: "Every hour" },
  { value: 180, label: "Every 3 hours" },
  { value: 720, label: "Twice a day" },
  { value: 1440, label: "Once a day" },
];

/** A dropdown must be able to show what is actually stored.
 *
 *  `scheduler_interval_minutes` is any number from 5 to 1440 and `timezone` is any
 *  IANA name — the lists above are the sensible choices, not the permitted ones. A
 *  site sitting on 45 minutes or Asia/Singapore would otherwise open this screen to a
 *  blank box reading as "nothing is set", and the first thing anyone does with a blank
 *  box is fill it, quietly replacing a setting they never meant to touch. */
function withCurrent<T extends string | number>(
  options: { value: T; label: string }[], current: T, label: (value: T) => string,
) {
  return options.some((option) => option.value === current)
    ? options : [...options, { value: current, label: label(current) }];
}

function normalizeCycle(cycle: MonthlyIndentCycle): MonthlyIndentCycle {
  return {
    ...cycle,
    is_enabled: Boolean(cycle.is_enabled),
    scheduler_enabled: Boolean(cycle.scheduler_enabled),
    approval_flow_enabled: Boolean(cycle.approval_flow_enabled),
    cycle_month_offset: Number(cycle.cycle_month_offset ?? 0),
    start_day: Number(cycle.start_day ?? 1),
    end_day: Number(cycle.end_day ?? 31),
    scheduler_interval_minutes: Number(cycle.scheduler_interval_minutes ?? 30),
  };
}

/** The eight settings the cycle row actually stores. Compared field by field rather
 *  than by identity, because the draft is a fresh object on every keystroke and the
 *  save bar must appear only when something genuinely differs. */
const CYCLE_FIELDS: (keyof MonthlyIndentCycle)[] = [
  "is_enabled", "approval_flow_enabled", "cycle_month_offset", "start_day", "end_day",
  "timezone", "scheduler_enabled", "scheduler_interval_minutes",
];

function cycleChanged(a: MonthlyIndentCycle | null, b: MonthlyIndentCycle | null): boolean {
  if (!a || !b) return false;
  return CYCLE_FIELDS.some((field) => a[field] !== b[field]);
}

const stepSignature = (steps: CustomLadderStep[]) => steps.map(stepKey).join("|");

export function MonthlyIndentPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const today = useMemo(() => new Date(), []);

  const settings = useQuery({ queryKey: ["monthly-indent"], queryFn: monthlyIndentApi.get });

  const [cycle, setCycle] = useState<MonthlyIndentCycle | null>(null);
  const [steps, setSteps] = useState<CustomLadderStep[]>([]);
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [editing, setEditing] = useState<{ rule: Partial<MonthlyIndentRule>; id: number | null }
    | null>(null);
  const [showHowItRuns, setShowHowItRuns] = useState(false);
  const [needChoices, setNeedChoices] = useState(false);

  const customFlow = Boolean(cycle?.approval_flow_enabled);

  const chain = useQuery({
    queryKey: ["approval-flow-chain", null, DOC_TYPE, null],
    queryFn: () => adminApi.flow.chain(null, DOC_TYPE, null),
    enabled: customFlow,
  });
  const rungs = useQuery({
    queryKey: ["approval-flow-rungs", null, ""],
    queryFn: () => adminApi.flow.rungs(null, ""),
    enabled: customFlow || needChoices,
  });

  const serverCycle = settings.data ? normalizeCycle(settings.data.cycle) : null;
  const serverSignature = serverCycle
    ? CYCLE_FIELDS.map((field) => String(serverCycle[field])).join("|") : null;
  const chainSignature = chain.data ? stepSignature(chain.data.steps ?? []) : null;

  /* The draft survives a refetch.
   *
   * Keying these off the query's DATA reset the draft every time the object identity
   * changed — which TanStack does on every background refetch, so a tab regaining
   * focus threw away whatever had been typed and the screen simply looked as though
   * the edit had never happened. Keyed off the VALUES instead, the draft is replaced
   * only when the server's answer genuinely differs from the one already in hand:
   * after this screen's own save, or after somebody else's. */
  const lastCycle = useRef<string | null>(null);
  useEffect(() => {
    if (serverCycle == null || serverSignature === lastCycle.current) return;
    lastCycle.current = serverSignature;
    setCycle(serverCycle);
    // serverCycle is rebuilt every render; the signature is what says it moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverSignature]);

  const lastChain = useRef<string | null>(null);
  useEffect(() => {
    // Switched back to the normal approvals: drop the draft chain AND the memory of
    // which one was loaded, or switching on again would compare an empty list against
    // a chain still on the server and report a change nobody made.
    if (!customFlow) {
      lastChain.current = null;
      setSteps([]);
      return;
    }
    if (chainSignature == null || chainSignature === lastChain.current) return;
    lastChain.current = chainSignature;
    setSteps(chain.data?.steps ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customFlow, chainSignature]);

  const cycleDirty = cycleChanged(cycle, serverCycle);
  const flowDirty = customFlow && chain.data != null
    && stepSignature(steps) !== stepSignature(chain.data.steps ?? []);
  const dirty = cycleDirty || flowDirty;

  const rules = useMemo(() => settings.data?.rules ?? [], [settings.data]);
  const activeRules = rules.filter((rule) => rule.is_active);

  const { window: win, items: agenda } = useMemo(
    () => buildAgenda(cycle ?? { cycle_month_offset: 0, start_day: 1, end_day: 31 },
                      rules, today),
    [cycle, rules, today],
  );

  const marks = useMemo(() => {
    const map = new Map<string, DayMark>();
    for (const item of agenda) {
      if (item.kind !== "remind" && item.kind !== "chase") continue;
      const key = dateKey(item.date);
      const at = map.get(key) ?? { remind: 0, chase: 0, moved: false };
      map.set(key, {
        ...at,
        [item.kind === "remind" ? "remind" : "chase"]:
          at[item.kind === "remind" ? "remind" : "chase"] + 1,
        moved: at.moved || Boolean(item.moved),
      });
    }
    return map;
  }, [agenda]);

  /* ---- writes ---------------------------------------------------------- */

  const saveAll = useMutation({
    mutationFn: async () => {
      if (cycleDirty) await monthlyIndentApi.updateCycle(cycle!);
      if (flowDirty && steps.length > 0) {
        await adminApi.flow.save(null, DOC_TYPE, steps, {
          self_approval_policy: chain.data?.self_approval_policy ?? "INDEPENDENT",
          fallback_position_id: chain.data?.fallback_position_id ?? null,
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["monthly-indent"] });
      qc.invalidateQueries({ queryKey: ["approval-flow-chain"] });
      qc.invalidateQueries({ queryKey: ["approval-flow"] });
      toast.success("Saved");
    },
  });

  const saveRule = useMutation({
    mutationFn: ({ rule, id }: { rule: Partial<MonthlyIndentRule>; id: number | null }) =>
      (id ? monthlyIndentApi.updateRule(id, rule) : monthlyIndentApi.createRule(rule)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["monthly-indent"] });
      setEditing(null);
      toast.success("Reminder saved");
    },
  });

  const turnOffRule = useMutation({
    mutationFn: monthlyIndentApi.deleteRule,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["monthly-indent"] });
      setEditing(null);
      toast.success("Reminder switched off");
    },
  });

  const runNow = useMutation({
    mutationFn: monthlyIndentApi.runNow,
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["monthly-indent"] });
      toast.success(
        result.sent === 0 && result.skipped === 0
          ? `Looked at ${result.checked} ${result.checked === 1 ? "person" : "people"} —`
            + " nothing was due, so nothing was sent."
          : `Looked at ${result.checked}, sent ${result.sent}, skipped ${result.skipped}.`,
      );
    },
  });

  /* ---- option lists ----------------------------------------------------- */

  const roleChoices: Choice[] = useMemo(() => {
    const map = new Map<number, string>();
    for (const item of [...(rungs.data?.ranks ?? []), ...(rungs.data?.shared_ranks ?? [])]) {
      map.set(item.id, item.name);
    }
    return [...map.entries()].map(([value, label]) => ({ value, label }));
  }, [rungs.data]);

  const positionChoices: Choice[] = useMemo(
    () => (rungs.data?.hcm ?? []).map((item) => ({ value: item.id, label: item.name })),
    [rungs.data],
  );

  function openEditor(rule: Partial<MonthlyIndentRule>, id: number | null) {
    setNeedChoices(true);
    saveRule.reset();
    setEditing({ rule, id });
  }

  function addStep(kind: StepKind, rung: FlowRung) {
    const next: CustomLadderStep = {
      sequence: steps.length + 1,
      name: rung.name,
      kind,
      position_id: kind === "hcm" ? rung.id : null,
      post_id: kind === "local" ? rung.id : null,
      position_role_id: kind === "rank" || kind === "shared_rank" ? rung.id : null,
      holders: rung.members ?? [],
    };
    if (!steps.some((step) => stepKey(step) === stepKey(next))) setSteps([...steps, next]);
  }

  /* ---- loading / failure ------------------------------------------------ */

  if (settings.error) {
    return (
      <>
        <PageHeader
          title="Monthly Indent"
          actions={(
            <Button variant="ghost" disabled={settings.isFetching}
                    onClick={() => settings.refetch()}>
              <RefreshCw className="h-4 w-4" /> Try again
            </Button>
          )}
        />
        <ErrorBanner error={settings.error} />
      </>
    );
  }

  if (settings.isLoading || !cycle) {
    return (
      <>
        <PageHeader title="Monthly Indent" />
        <Card className="p-6 text-sm text-muted">
          {settings.isLoading ? "Loading the month…" : "These settings could not be loaded."}
        </Card>
      </>
    );
  }

  const selectedItems = selectedDay
    ? agenda.filter((item) => dateKey(item.date) === dateKey(selectedDay))
    : [];

  return (
    <div className="mx-auto max-w-5xl pb-4">
      <PageHeader
        title="Monthly Indent"
        actions={(
          <Button variant="soft" onClick={() => runNow.mutate()} disabled={runNow.isPending}>
            <Send className="h-4 w-4" />
            {runNow.isPending ? "Checking…" : "Check and send now"}
          </Button>
        )}
      />

      <div className="space-y-5">
        {/* ── The standing sentence ───────────────────────────────────────
            One paragraph that says what is set up, before any control. An admin
            arriving to check whether this is on should never have to read a form
            to find out. */}
        <Card className="overflow-hidden p-0">
          <div className="h-1 w-full bg-brand" />
          <div className="flex flex-wrap items-start justify-between gap-4 p-4 sm:p-5">
            <div className="min-w-0 flex-1">
              <p className="font-display text-lg leading-snug text-ink">
                {cycle.is_enabled ? (
                  <>
                    Stores send their indent between{" "}
                    <strong className="text-brand">{longDate(win.start)}</strong> and{" "}
                    <strong className="text-brand">{longDate(win.end)}</strong>.
                  </>
                ) : (
                  <>Monthly indent collection is switched off. Nothing is being sent.</>
                )}
              </p>
              <p className="mt-1.5 text-sm text-muted">
                {activeRules.length === 0
                  ? "No reminders are set up yet, so nobody will be nudged."
                  : `${activeRules.length} reminder${activeRules.length === 1 ? "" : "s"} `
                    + `set up. The system looks ${everyPhrase(cycle.scheduler_interval_minutes)}`
                    + `${cycle.scheduler_enabled ? "" : ", but automatic checking is paused"}.`}
                {settings.data?.next_run && cycle.scheduler_enabled && (
                  <> Next look at <strong className="text-body">
                    {new Date(settings.data.next_run).toLocaleTimeString([],
                      { hour: "2-digit", minute: "2-digit" })}
                  </strong>.</>
                )}
              </p>
            </div>
            <label className="flex shrink-0 items-center gap-3 rounded-full border border-line
                              bg-content1 px-4 py-2">
              <span className="text-sm font-semibold text-body">
                {cycle.is_enabled ? "On" : "Off"}
              </span>
              <Switch
                size="sm"
                isSelected={cycle.is_enabled}
                aria-label="Monthly indent collection"
                onValueChange={(value) => setCycle({ ...cycle, is_enabled: value })}
              />
            </label>
          </div>
        </Card>

        {!cycle.is_enabled && (
          <Alert tone="warning" title="Everything below is saved but paused">
            Reminders will not go out and the collection window is not enforced until
            this is switched back on.
          </Alert>
        )}

        {/* ── The month ───────────────────────────────────────────────────── */}
        <Card className="p-4 sm:p-5">
          <Heading icon={CalendarRange} title="The month"
                   hint="Tap any day to see what happens on it, or to move the window." />

          <MonthRibbon window={win} marks={marks} selected={selectedDay}
                       today={today} onSelect={setSelectedDay} />

          {selectedDay && (
            <DayPanel
              date={selectedDay}
              items={selectedItems}
              isStart={dateKey(selectedDay) === dateKey(win.start)}
              isEnd={dateKey(selectedDay) === dateKey(win.end)}
              onOpenHere={() => setCycle({ ...cycle, start_day: selectedDay.getDate() })}
              onCloseHere={() => setCycle({ ...cycle, end_day: selectedDay.getDate() })}
              onAddReminder={() =>
                openEditor(emptyReminder(selectedDay.getDate()), null)}
              onEdit={(rule) => openEditor(rule, rule.id)}
              onDismiss={() => setSelectedDay(null)}
            />
          )}

          <div className="mt-5 grid gap-3 border-t border-line pt-4 sm:grid-cols-3">
            <Field label="Collection opens on day">
              <Input type="number" min={1} max={31} value={cycle.start_day}
                     onChange={(event) => setCycle({
                       ...cycle, start_day: Number(event.target.value) })} />
            </Field>
            <Field label="Collection closes on day"
                   hint={win.wraps ? "Earlier than the opening day, so it runs into the next month."
                     : undefined}>
              <Input type="number" min={1} max={31} value={cycle.end_day}
                     onChange={(event) => setCycle({
                       ...cycle, end_day: Number(event.target.value) })} />
            </Field>
            <Field label="These indents are for"
                   hint="Which month the stock is being asked for.">
              <Select
                value={cycle.cycle_month_offset}
                options={WHICH_MONTH}
                onChange={(value) => setCycle({
                  ...cycle, cycle_month_offset: Number(value) })}
              />
            </Field>
          </div>
        </Card>

        {/* ── The agenda: the same schedule, read as sentences ─────────────── */}
        <Card className="p-4 sm:p-5">
          <Heading
            icon={BellRing}
            title="What happens, in order"
            hint="Everything the system will do this month, on the day it does it."
            action={(
              <Button variant="soft"
                      onClick={() => openEditor(emptyReminder(win.start.getDate()), null)}>
                <Plus className="h-4 w-4" /> Add a reminder
              </Button>
            )}
          />
          <Agenda items={agenda} today={today} onEdit={(rule) => openEditor(rule, rule.id)} />

          {/* The bookends always draw, so this card never looks empty — which is
              exactly why it has to SAY that no reminder is set up. Naming what a
              reminder is addressed to (a job role, a post, a person) is the point:
              that choice lives inside the editor, and with nothing on the list there
              was no sign on this screen that it existed at all. */}
          {activeRules.length === 0 && (
            <div className="mt-3 rounded-xl border border-dashed border-brand/40 bg-brand-050/40
                            px-4 py-5 text-center">
              <p className="text-sm font-semibold text-ink">
                No reminders yet, so nobody is nudged.
              </p>
              <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted">
                A reminder is addressed to a <strong>job role</strong> (every Store Keeper),
                a <strong>post</strong>, or <strong>one named person</strong> — you pick which
                when you add it.
              </p>
              <div className="mt-3">
                <Button onClick={() => openEditor(emptyReminder(win.start.getDate()), null)}>
                  <Plus className="h-4 w-4" /> Add the first reminder
                </Button>
              </div>
            </div>
          )}

          {rules.length > activeRules.length && (
            <div className="mt-4 border-t border-line pt-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
                Switched off — kept, but never sent
              </p>
              <div className="flex flex-wrap gap-2">
                {rules.filter((rule) => !rule.is_active).map((rule) => (
                  <button
                    key={rule.id}
                    type="button"
                    onClick={() => openEditor(rule, rule.id)}
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-full border
                               border-dashed border-line px-3 text-xs text-muted
                               transition-colors hover:border-brand hover:text-brand"
                  >
                    <FlagOff className="h-3 w-3" /> {rule.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </Card>

        {/* ── Approvals ───────────────────────────────────────────────────── */}
        <Card className="p-4 sm:p-5">
          <Heading icon={Users} title="Who approves a monthly indent" />
          <ErrorBanner error={chain.error} />
          <div className="grid gap-3 sm:grid-cols-2">
            <ChoiceTile
              selected={!customFlow}
              title="The normal indent approvals"
              body="A monthly indent is approved by exactly the same people as any other
                    indent. Nothing extra to set up."
              onSelect={() => setCycle({ ...cycle, approval_flow_enabled: false })}
            />
            <ChoiceTile
              selected={customFlow}
              title="A separate list, just for monthly indents"
              body="Monthly indents go to the people listed below instead. Every other
                    indent is unaffected."
              onSelect={() => setCycle({ ...cycle, approval_flow_enabled: true })}
            />
          </div>

          {customFlow && (
            <div className="mt-4 grid gap-4 border-t border-line pt-4 lg:grid-cols-[1fr_19rem]">
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
                  They approve in this order
                </p>
                <StepList steps={steps} onChange={setSteps} />
                {steps.length === 0 && (
                  <p className="mt-2 text-xs text-warn">
                    Add at least one approver, or switch back to the normal approvals.
                  </p>
                )}
              </div>
              <div className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted">
                  Add an approver
                </p>
                {rungs.isLoading && <p className="text-sm text-muted">Loading the list…</p>}
                <RungGroup title="Reporting line" items={rungs.data?.ranks ?? []}
                           kind="rank" onAdd={addStep} />
                <RungGroup title="Shared chairs" items={rungs.data?.shared_ranks ?? []}
                           kind="shared_rank" onAdd={addStep} />
                <RungGroup title="HCM posts" items={rungs.data?.hcm ?? []}
                           kind="hcm" onAdd={addStep} />
              </div>
            </div>
          )}
        </Card>

        {/* ── How it runs: rarely touched, so folded away ──────────────────── */}
        <Card className="p-4 sm:p-5">
          <button
            type="button"
            onClick={() => setShowHowItRuns((open) => !open)}
            className="flex w-full items-center justify-between gap-3 text-left"
          >
            <span className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-muted" />
              <span className="font-display text-base font-bold text-ink">How it runs</span>
              <span className="text-xs text-muted">
                {cycle.timezone} · {everyPhrase(cycle.scheduler_interval_minutes)}
                {cycle.scheduler_enabled ? "" : " · paused"}
              </span>
            </span>
            <ChevronDown className={`h-4 w-4 shrink-0 text-muted transition-transform ${
              showHowItRuns ? "rotate-180" : ""}`} />
          </button>
          {showHowItRuns && (
            <div className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-3">
              <Field label="Clock to use"
                     hint="Days and times above are read in this timezone.">
                <Select
                  value={cycle.timezone}
                  options={withCurrent(TIMEZONES, cycle.timezone, (value) => value)}
                  onChange={(value) => setCycle({ ...cycle, timezone: value })}
                />
              </Field>
              <Field label="How often to check"
                     hint="How soon after a due time a message goes out.">
                <Select
                  value={cycle.scheduler_interval_minutes}
                  options={withCurrent(HOW_OFTEN, cycle.scheduler_interval_minutes,
                                       (value) => `Every ${value} minutes`)}
                  onChange={(value) => setCycle({
                    ...cycle, scheduler_interval_minutes: Number(value) })}
                />
              </Field>
              <label className="flex min-h-11 items-center justify-between gap-3 self-end
                                rounded-lg border border-line bg-content1 px-3 py-2">
                <span className="text-sm text-body">Check automatically</span>
                <Switch
                  size="sm"
                  isSelected={cycle.scheduler_enabled}
                  onValueChange={(value) => setCycle({ ...cycle, scheduler_enabled: value })}
                />
              </label>
            </div>
          )}
        </Card>

        {/* ── What actually went out ───────────────────────────────────────── */}
        <Card className="p-4 sm:p-5">
          <Heading icon={Clock} title="What has gone out"
                   hint="The most recent messages this screen has sent." />
          <ActivityLog logs={settings.data?.logs ?? []} />
        </Card>
      </div>

      {/* ── One save, for whatever is different ───────────────────────────── */}
      {dirty && (
        <div className="sticky bottom-4 z-20 mt-5">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border
                          border-brand/30 bg-content1 px-4 py-3 shadow-lg">
            <p className="text-sm text-body">
              <strong className="text-ink">Not saved yet.</strong>{" "}
              {[cycleDirty ? "the month settings" : null,
                flowDirty ? "the approver list" : null]
                .filter(Boolean).join(" and ")} changed.
            </p>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  if (serverCycle) setCycle(serverCycle);
                  if (chain.data) setSteps(chain.data.steps ?? []);
                }}
              >
                <Undo2 className="h-4 w-4" /> Undo changes
              </Button>
              <Button
                onClick={() => saveAll.mutate()}
                disabled={saveAll.isPending || (customFlow && steps.length === 0)}
              >
                <Save className="h-4 w-4" /> {saveAll.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
          <ErrorBanner error={saveAll.error} className="mt-2" />
        </div>
      )}

      {editing && (
        <ReminderEditor
          key={editing.id ?? "new"}
          initial={editing.rule}
          isNew={editing.id == null}
          window={win}
          today={today}
          roles={roleChoices}
          positions={positionChoices}
          choicesLoading={rungs.isLoading}
          saving={saveRule.isPending}
          saveError={saveRule.error}
          onSave={(rule) => saveRule.mutate({ rule, id: editing.id })}
          onClose={() => setEditing(null)}
          onTurnOff={editing.id
            ? () => turnOffRule.mutate(editing.id as number)
            : undefined}
          onPreview={monthlyIndentApi.preview}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Pieces
 * ------------------------------------------------------------------------- */

function Heading({ icon: Icon, title, hint, action }: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg
                         bg-brand-050 text-brand">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h2 className="font-display text-base font-bold text-ink">{title}</h2>
          {hint && <p className="text-xs text-muted">{hint}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

/** What a tapped day carries, and the two ways to move the window onto it.
 *
 *  The window edges are set HERE rather than only in the number boxes below because
 *  "close the collection on this day" is the sentence in the admin's head; "end_day =
 *  25" is a translation of it they should not have to make. The boxes stay for the
 *  admin who already knows the number. */
function DayPanel({
  date, items, isStart, isEnd, onOpenHere, onCloseHere, onAddReminder, onEdit, onDismiss,
}: {
  date: Date;
  items: AgendaItem[];
  isStart: boolean;
  isEnd: boolean;
  onOpenHere: () => void;
  onCloseHere: () => void;
  onAddReminder: () => void;
  onEdit: (rule: MonthlyIndentRule) => void;
  onDismiss: () => void;
}) {
  return (
    <div className="mt-4 rounded-xl border border-brand/25 bg-brand-050/50 p-3 sm:p-4">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h3 className="font-display text-sm font-bold text-ink">{longDate(date)}</h3>
        <button type="button" onClick={onDismiss}
                className="min-h-8 text-xs font-medium text-muted hover:text-body">
          Close
        </button>
      </div>

      {items.length === 0 ? (
        <p className="mb-3 text-sm text-muted">Nothing is scheduled for this day.</p>
      ) : (
        <ul className="mb-3 space-y-1.5">
          {items.map((item) => (
            <li key={item.key} className="flex items-start gap-2 text-sm text-body">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
              <span>
                <strong>{prettyTime(item.time)}</strong> — {item.detail}
                {item.rule && (
                  <button type="button" onClick={() => onEdit(item.rule!)}
                          className="ml-1.5 font-medium text-brand underline-offset-2 hover:underline">
                    Edit
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <Button variant="subtle" onClick={onAddReminder}>
          <Plus className="h-4 w-4" /> Add a reminder here
        </Button>
        {!isStart && (
          <Button variant="ghost" onClick={onOpenHere}>
            <Flag className="h-4 w-4" /> Open collection on this day
          </Button>
        )}
        {!isEnd && (
          <Button variant="ghost" onClick={onCloseHere}>
            <FlagOff className="h-4 w-4" /> Close collection on this day
          </Button>
        )}
      </div>
    </div>
  );
}

const AGENDA_LOOK: Record<AgendaItem["kind"], {
  icon: React.ComponentType<{ className?: string }>;
  dot: string;
  chip: string;
}> = {
  open: { icon: Flag, dot: "bg-ok", chip: "bg-ok-bg text-ok" },
  remind: { icon: BellRing, dot: "bg-brand", chip: "bg-brand-050 text-brand" },
  chase: { icon: AlertTriangle, dot: "bg-warn", chip: "bg-warn-bg text-warn" },
  close: { icon: CheckCircle2, dot: "bg-neutral", chip: "bg-neutral-bg text-neutral" },
};

/** The month as a vertical track. Same data as the ribbon, read as sentences — the
 *  ribbon answers "when", this answers "what". */
function Agenda({ items, today, onEdit }: {
  items: AgendaItem[];
  today: Date;
  onEdit: (rule: MonthlyIndentRule) => void;
}) {
  return (
    <ol className="relative space-y-0">
      {/* The spine. Inset to sit under the dots, and stopped short of the last row so
          the track ends at the final event rather than trailing past it. */}
      <span aria-hidden className="absolute left-[7px] top-3 bottom-6 w-px bg-line" />
      {items.map((item) => {
        const look = AGENDA_LOOK[item.kind];
        const past = item.date < today;
        return (
          <li key={item.key} className="relative flex gap-3 py-2.5 pl-0">
            <span className={`relative z-10 mt-1.5 h-[15px] w-[15px] shrink-0 rounded-full
                              ring-4 ring-content1 ${look.dot} ${past ? "opacity-45" : ""}`} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="font-display text-sm font-bold text-ink">
                  {shortDate(item.date)}
                </span>
                <span className="text-xs text-muted">{prettyTime(item.time)}</span>
                {item.rule && (
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${look.chip}`}>
                    {CONDITION_CHIP[item.rule.condition]}
                  </span>
                )}
                {item.moved && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-warn">
                    <RotateCcw className="h-3 w-3" /> moved into the window
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-sm text-body">{item.detail}</p>
              {item.rule && (
                <button
                  type="button"
                  onClick={() => onEdit(item.rule!)}
                  className="mt-1 inline-flex min-h-8 items-center gap-1 text-xs font-semibold
                             text-brand underline-offset-2 hover:underline"
                >
                  {item.rule.name} <ArrowRight className="h-3 w-3" />
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function ChoiceTile({ selected, title, body, onSelect }: {
  selected: boolean;
  title: string;
  body: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`rounded-xl border p-3.5 text-left transition-colors ${
        selected
          ? "border-brand bg-brand-050"
          : "border-line bg-content1 hover:border-brand/40 hover:bg-content2"
      }`}
    >
      <span className="flex items-start gap-2.5">
        <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border-2 ${
          selected ? "border-brand" : "border-line"}`}
        >
          {selected && <span className="h-2 w-2 rounded-full bg-brand" />}
        </span>
        <span className="min-w-0">
          <span className={`block text-sm font-semibold ${selected ? "text-brand" : "text-ink"}`}>
            {title}
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-muted">{body}</span>
        </span>
      </span>
    </button>
  );
}

function RungGroup({ title, items, kind, onAdd }: {
  title: string;
  items: FlowRung[];
  kind: StepKind;
  onAdd: (kind: StepKind, rung: FlowRung) => void;
}) {
  if (!items.length) return null;
  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
        {title}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {items.slice(0, 18).map((item) => (
          <button
            key={`${kind}-${item.id}`}
            type="button"
            onClick={() => onAdd(kind, item)}
            className="inline-flex min-h-9 items-center rounded-full border border-line/70
                       px-2.5 text-xs text-body transition-colors hover:border-brand
                       hover:bg-brand-050 hover:text-brand"
          >
            <Plus className="mr-1 h-3 w-3" /> {item.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Grouped by day, because a run sends a burst and an ungrouped list repeats the
 *  same date down thirty rows. */
function ActivityLog({ logs }: { logs: MonthlyIndentLog[] }) {
  const groups = useMemo(() => {
    const map = new Map<string, MonthlyIndentLog[]>();
    for (const log of logs) {
      const day = new Date(log.sent_at).toDateString();
      map.set(day, [...(map.get(day) ?? []), log]);
    }
    return [...map.entries()];
  }, [logs]);

  if (groups.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line py-8 text-center text-sm text-muted">
        Nothing has been sent yet.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {groups.map(([day, rows]) => (
        <div key={day}>
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase
                        tracking-wider text-muted">
            <CalendarDays className="h-3 w-3" /> {day}
          </p>
          <div className="divide-y divide-line/60 rounded-lg border border-line">
            {rows.map((log) => (
              <div key={log.id}
                   className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                  log.status === "SENT" ? "bg-ok-bg text-ok" : "bg-warn-bg text-warn"}`}>
                  {log.status === "SENT" ? "Sent" : "Not sent"}
                </span>
                <span className="min-w-0 flex-1 text-body">
                  {log.kind === "ESCALATION" ? (
                    <>
                      {log.recipient_employee_name
                        ? <>Told <strong>{log.recipient_employee_name}</strong></>
                        : "Nobody to tell"}
                      {" "}about <strong>{log.target_employee_name}</strong>
                    </>
                  ) : (
                    <>Reminded <strong>{log.target_employee_name}</strong></>
                  )}
                  {log.reason && <span className="text-muted"> — {log.reason}</span>}
                </span>
                <span className="text-xs tabular text-muted">
                  {new Date(log.sent_at).toLocaleTimeString([],
                    { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
