/** Writing a reminder, with the month still on screen.
 *
 *  A reminder is four decisions — which day, who, what we are checking, and what the
 *  message says — and the one that used to be impossible to get right was the first,
 *  because "trigger day 25" told the admin nothing about whether the 25th was inside
 *  the collection window, before or after the other reminders, or a Sunday. So the
 *  ribbon rides at the top of this panel and the pins move as the numbers are typed:
 *  the answer to "when does this actually go out" is visible while the decision is
 *  being taken, not after saving and going back to look.
 *
 *  The draft is LOCAL. The page hands in a starting value and gets one back on save,
 *  so typing a message does not re-render the ribbon, the agenda and the log behind
 *  the panel on every keystroke.
 */
import { useMemo, useState } from "react";
import {
  Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Switch,
} from "@heroui/react";
import { Eye, Save, Trash2 } from "lucide-react";

import {
  Alert, Button, ErrorBanner, Field, Input, Select, Textarea,
} from "@/shared/components";
import type { MonthlyIndentRule } from "../types";
import {
  CONDITION_CLAUSE, CONDITION_OPTIONS, ESCALATION_OPTIONS, TARGET_OPTIONS,
  TEMPLATE_VARIABLES, chasePhrase, chaseStepPhrase, dueDate, escalationSteps,
  isDayOutsideWindow, longDate, prettyTime, timeValue, whoPhrase,
} from "../monthlyIndentPlan";
import type { CycleWindow } from "../monthlyIndentPlan";
import { MonthRibbon, type DayMark } from "./MonthRibbon";

export interface Choice { value: number; label: string }

export function emptyReminder(day: number): Partial<MonthlyIndentRule> {
  return {
    name: "",
    is_active: true,
    trigger_day: day,
    trigger_time: "10:00",
    target_type: "HCM_ROLE",
    target_ref_id: 0,
    condition: "NOT_SUBMITTED",
    message_template:
      "Hello {{employee_name}}, your {{month}} indent has not reached us yet."
      + " Please send it before {{cycle_end}}.",
    escalation_enabled: false,
    escalation_day: null,
    // "Tell the manager the next day" is the follow-up people ask for, so a new
    // reminder counts from itself rather than from a fixed day of the month.
    escalation_after_days: 1,
    escalation_levels: 1,
    escalation_time: "10:00",
    escalation_target_type: "REPORTING_MANAGER",
    escalation_target_ref_id: null,
    escalation_message_template: "",
  };
}

/** Everything that must be filled in before the server would accept it. Mirrors
 *  `service._validate_rule`, so Save is offered exactly when it would work. */
export function reminderIsComplete(rule: Partial<MonthlyIndentRule>): boolean {
  if (!rule.name?.trim() || !rule.target_ref_id || !rule.message_template?.trim()) return false;
  if (!rule.escalation_enabled) return true;
  if (!rule.escalation_target_type) return false;
  if (!rule.escalation_after_days && (!rule.escalation_day || !rule.escalation_time)) return false;
  return rule.escalation_target_type === "REPORTING_MANAGER"
    || Boolean(rule.escalation_target_ref_id);
}

const AFTER_DAYS = [1, 2, 3, 4, 5, 7, 10, 14].map((value) => ({
  value, label: value === 1 ? "The next day" : `${value} days later`,
}));

const LEVELS = [1, 2, 3, 4, 5].map((value) => ({
  value,
  label: value === 1 ? "Their manager only"
    : `${value} levels — one more manager up each step`,
}));

export function ReminderEditor({
  initial, isNew, window: win, today, roles, positions, choicesLoading,
  saving, saveError, onSave, onClose, onTurnOff, onPreview,
}: {
  initial: Partial<MonthlyIndentRule>;
  isNew: boolean;
  window: CycleWindow;
  today: Date;
  roles: Choice[];
  positions: Choice[];
  choicesLoading: boolean;
  saving: boolean;
  saveError: unknown;
  onSave: (rule: Partial<MonthlyIndentRule>) => void;
  onClose: () => void;
  onTurnOff?: () => void;
  onPreview: (template: string) => Promise<string>;
}) {
  const [rule, setRule] = useState<Partial<MonthlyIndentRule>>(initial);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const set = <K extends keyof MonthlyIndentRule>(key: K, value: MonthlyIndentRule[K]) =>
    setRule((prev) => ({ ...prev, [key]: value }));

  const remindOn = dueDate(win, rule.trigger_day ?? 1);
  const remindMoved = isDayOutsideWindow(win, rule.trigger_day ?? 1);
  const steps = escalationSteps(win, rule);
  const chaseOn = steps[0]?.date ?? null;
  const chaseMoved = steps.some((step) => step.moved);
  const relative = Boolean(rule.escalation_after_days);
  const climbs = rule.escalation_target_type === "REPORTING_MANAGER";

  // Just this rule's own pins, so the panel shows the day being edited rather than
  // the whole month's traffic.
  const marks = useMemo(() => {
    const map = new Map<string, DayMark>();
    const put = (date: Date, field: "remind" | "chase", moved: boolean) => {
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      const at = map.get(key) ?? { remind: 0, chase: 0, moved: false };
      map.set(key, { ...at, [field]: at[field] + 1, moved: at.moved || moved });
    };
    put(remindOn, "remind", remindMoved);
    for (const step of steps) put(step.date, "chase", step.moved);
    return map;
  }, [remindOn, remindMoved, steps]);

  const targetChoices = rule.target_type === "POSITION" ? positions : roles;
  const named = rule.target_type === "EMPLOYEE";

  function pickDay(date: Date) {
    // Clicking the ribbon sets whichever day is "in play": a pinned follow-up if it is
    // switched on and the click is after the reminder, the reminder otherwise. A
    // follow-up counted from the reminder moves with it, so it has no day to set.
    if (rule.escalation_enabled && !relative && date > remindOn) {
      set("escalation_day", date.getDate());
    } else {
      set("trigger_day", date.getDate());
    }
  }

  async function runPreview() {
    setPreviewing(true);
    try {
      setPreview(await onPreview(rule.message_template ?? ""));
    } finally {
      setPreviewing(false);
    }
  }

  const complete = reminderIsComplete(rule);

  return (
    <Modal isOpen onOpenChange={onClose} placement="center" scrollBehavior="inside" size="3xl">
      <ModalContent>
        <ModalHeader className="flex-col items-start gap-0.5">
          <span className="font-display text-lg font-bold text-ink">
            {isNew ? "New reminder" : "Edit reminder"}
          </span>
          <span className="text-xs font-normal text-muted">
            Set the day, choose who it goes to, and write what it says.
          </span>
        </ModalHeader>

        <ModalBody className="gap-5">
          <ErrorBanner error={saveError} />

          {/* ① The month, live. The pins move while the day is being typed. */}
          <section className="rounded-xl border border-line bg-content2/60 p-3">
            <MonthRibbon window={win} marks={marks} selected={remindOn}
                         today={today} onSelect={pickDay} />
            <p className="mt-3 text-sm text-body">
              Goes out on <strong>{longDate(remindOn)}</strong> at{" "}
              <strong>{prettyTime(rule.trigger_time)}</strong>
              {chaseOn && (
                <>
                  , and if there is still nothing by <strong>{longDate(chaseOn)}</strong> at{" "}
                  <strong>{prettyTime(steps[0].time)}</strong> we tell{" "}
                  <strong>{chasePhrase(rule)}</strong>
                </>
              )}
              .
            </p>
            {steps.length > 1 && (
              <ul className="mt-1.5 space-y-0.5 text-sm text-body">
                {steps.slice(1).map((step) => (
                  <li key={step.level}>
                    Still nothing by <strong>{longDate(step.date)}</strong>: tell{" "}
                    <strong>{chaseStepPhrase(rule, step.level)}</strong>.
                  </li>
                ))}
              </ul>
            )}
            {(remindMoved || chaseMoved) && (
              <p className="mt-2 text-xs font-medium text-warn">
                That day is outside the collection window, so it will run on the nearest
                day inside it instead.
              </p>
            )}
          </section>

          <Field label="Name this reminder" required
                 hint="Only you see this — it is how the reminder is listed.">
            <Input
              value={rule.name ?? ""}
              placeholder="First nudge to store keepers"
              onChange={(event) => set("name", event.target.value)}
            />
          </Field>

          <Beat step={1} title="When it goes out">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Day of the month" required>
                <Input type="number" min={1} max={31} value={rule.trigger_day ?? 1}
                       onChange={(event) => set("trigger_day", Number(event.target.value))} />
              </Field>
              <Field label="Time of day" required>
                <Input type="time" value={timeValue(rule.trigger_time)}
                       onChange={(event) => set("trigger_time", event.target.value)} />
              </Field>
            </div>
          </Beat>

          <Beat step={2} title="Who it goes to, and why">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Send it to" required>
                <Select
                  value={rule.target_type ?? "HCM_ROLE"}
                  options={TARGET_OPTIONS}
                  onChange={(value) => setRule((prev) => ({
                    ...prev,
                    target_type: value as MonthlyIndentRule["target_type"],
                    target_ref_id: 0,
                    target_name: null,
                  }))}
                />
              </Field>
              {named ? (
                <Field label="Employee ID" required
                       hint="The person's ID number in HCM.">
                  <Input type="number" value={rule.target_ref_id || ""}
                         onChange={(event) => set("target_ref_id", Number(event.target.value))} />
                </Field>
              ) : (
                <Field label={rule.target_type === "POSITION" ? "Which post" : "Which job role"}
                       required>
                  <Select
                    value={rule.target_ref_id || ""}
                    options={targetChoices}
                    placeholder={choicesLoading ? "Loading…" : "Choose one"}
                    onChange={(value) => {
                      const id = Number(value);
                      set("target_ref_id", id);
                      set("target_name",
                          targetChoices.find((c) => c.value === id)?.label ?? null);
                    }}
                  />
                </Field>
              )}
            </div>
            <Field label="Only if the person…" required>
              <Select
                value={rule.condition ?? "NOT_SUBMITTED"}
                options={CONDITION_OPTIONS}
                onChange={(value) => set("condition", value as MonthlyIndentRule["condition"])}
              />
            </Field>
            <p className="rounded-lg bg-content2 px-3 py-2 text-sm text-body">
              {rule.target_ref_id ? (
                <>
                  In plain words: remind{" "}
                  <strong>{whoPhrase(rule as MonthlyIndentRule)}</strong> who{" "}
                  {CONDITION_CLAUSE[rule.condition ?? "NOT_SUBMITTED"]}.
                </>
              ) : (
                <span className="text-muted">
                  Choose who this goes to, and the reminder will read back here as a
                  sentence.
                </span>
              )}
            </p>
          </Beat>

          <Beat step={3} title="What it says">
            <Field label="Message" required>
              <Textarea
                value={rule.message_template ?? ""}
                minRows={4}
                placeholder="Hello {{employee_name}}, your {{month}} indent is not in yet."
                onChange={(event) => set("message_template", event.target.value)}
              />
            </Field>
            <VariableChips
              onPick={(token) => set("message_template",
                `${(rule.message_template ?? "").trimEnd()} {{${token}}}`.trim())}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="subtle" onClick={runPreview} disabled={previewing}>
                <Eye className="h-4 w-4" /> {previewing ? "Checking…" : "Show me an example"}
              </Button>
              {preview && (
                <span className="text-xs text-muted">
                  Filled in with sample details.
                </span>
              )}
            </div>
            {preview && (
              <Alert tone="info" title="This is how it will read">
                {preview}
              </Alert>
            )}
          </Beat>

          <Beat step={4} title="If nobody responds" optional>
            <label className="flex min-h-11 items-center justify-between gap-3 rounded-lg
                              border border-line bg-content1 px-3 py-2">
              <span className="text-sm text-body">
                Tell someone else when the indent still has not arrived
              </span>
              <Switch
                size="sm"
                isSelected={Boolean(rule.escalation_enabled)}
                onValueChange={(value) => setRule((prev) => ({
                  ...prev,
                  escalation_enabled: value,
                  // Nothing chosen yet: count from the reminder, one day later.
                  escalation_after_days: value && !prev.escalation_day
                    ? prev.escalation_after_days ?? 1 : prev.escalation_after_days,
                }))}
              />
            </label>
            {rule.escalation_enabled && (
              <div className="space-y-3 rounded-lg border border-line bg-content2/60 p-3">
                <Field label="When">
                  <Select
                    value={relative ? "after" : "day"}
                    options={[
                      { value: "after", label: "Counted from the reminder" },
                      { value: "day", label: "On a fixed day of the month" },
                    ]}
                    onChange={(value) => setRule((prev) => (value === "after"
                      ? { ...prev, escalation_after_days: prev.escalation_after_days || 1 }
                      : {
                        ...prev,
                        escalation_after_days: null,
                        escalation_day: prev.escalation_day
                          ?? Math.min((prev.trigger_day ?? 1) + 1, 31),
                        escalation_time: prev.escalation_time || prev.trigger_time || "10:00",
                      }))}
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  {relative ? (
                    <Field label="How long after the reminder" required>
                      <Select
                        value={Number(rule.escalation_after_days) || 1}
                        options={AFTER_DAYS.some(
                          (option) => option.value === Number(rule.escalation_after_days))
                          ? AFTER_DAYS
                          : [...AFTER_DAYS, {
                            value: Number(rule.escalation_after_days),
                            label: `${rule.escalation_after_days} days later`,
                          }]}
                        onChange={(value) => set("escalation_after_days", Number(value))}
                      />
                    </Field>
                  ) : (
                    <Field label="Day of the month" required>
                      <Input type="number" min={1} max={31} value={rule.escalation_day ?? 1}
                             onChange={(event) => set(
                               "escalation_day", Number(event.target.value))} />
                    </Field>
                  )}
                  <Field label="Time of day" required={!relative}
                         hint={relative ? "Blank uses the reminder's own time." : undefined}>
                    <Input type="time" value={timeValue(rule.escalation_time)}
                           onChange={(event) => set(
                             "escalation_time", event.target.value || null)} />
                  </Field>
                </div>
                <Field label="Tell" required>
                  <Select
                    value={rule.escalation_target_type ?? "REPORTING_MANAGER"}
                    options={ESCALATION_OPTIONS}
                    onChange={(value) => setRule((prev) => ({
                      ...prev,
                      escalation_target_type:
                        value as MonthlyIndentRule["escalation_target_type"],
                      escalation_target_ref_id: null,
                      escalation_target_name: null,
                      // A job role or a named person has no "next one up".
                      escalation_levels: value === "REPORTING_MANAGER"
                        ? prev.escalation_levels ?? 1 : 1,
                    }))}
                  />
                </Field>
                {climbs && (
                  <Field label="How far up the reporting line"
                         hint={relative
                           ? "Each further level goes out the same number of days after the last."
                           : "Each further level goes out one day after the last."}>
                    <Select
                      value={Number(rule.escalation_levels) || 1}
                      options={LEVELS}
                      onChange={(value) => set("escalation_levels", Number(value))}
                    />
                  </Field>
                )}
                {rule.escalation_target_type === "EMPLOYEE" ? (
                  <Field label="Employee ID" required>
                    <Input type="number" value={rule.escalation_target_ref_id || ""}
                           onChange={(event) => set(
                             "escalation_target_ref_id", Number(event.target.value))} />
                  </Field>
                ) : (
                  <Field
                    label={rule.escalation_target_type === "HCM_ROLE"
                      ? "Which job role" : "Stop at this level (optional)"}
                    hint={rule.escalation_target_type === "HCM_ROLE" ? undefined
                      : "Leave blank to tell whoever is directly above them."}
                  >
                    <Select
                      value={rule.escalation_target_ref_id ?? ""}
                      options={rule.escalation_target_type === "HCM_ROLE"
                        ? roles
                        : [{ value: "", label: "Whoever is directly above them" }, ...roles]}
                      placeholder={choicesLoading ? "Loading…" : "Choose one"}
                      onChange={(value) => {
                        const id = value ? Number(value) : null;
                        set("escalation_target_ref_id", id);
                        set("escalation_target_name",
                            id == null ? null : roles.find((c) => c.value === id)?.label ?? null);
                      }}
                    />
                  </Field>
                )}
                <Field label="Message to them"
                       hint="Leave blank to reuse the message above.">
                  <Textarea
                    value={rule.escalation_message_template ?? ""}
                    minRows={3}
                    placeholder="{{employee_name}} has still not sent the {{month}} indent."
                    onChange={(event) => set(
                      "escalation_message_template", event.target.value)}
                  />
                </Field>
              </div>
            )}
          </Beat>

          <label className="flex min-h-11 items-center justify-between gap-3 rounded-lg
                            border border-line bg-content1 px-3 py-2">
            <span className="text-sm text-body">
              Switch this reminder on
              <span className="block text-xs text-muted">
                Off keeps the settings but sends nothing.
              </span>
            </span>
            <Switch
              size="sm"
              isSelected={Boolean(rule.is_active)}
              onValueChange={(value) => set("is_active", value)}
            />
          </label>
        </ModalBody>

        <ModalFooter className="justify-between">
          <div>
            {onTurnOff && (
              <Button variant="ghost" className="text-bad" onClick={onTurnOff}>
                <Trash2 className="h-4 w-4" /> Turn off
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={() => onSave(rule)} disabled={saving || !complete}>
              <Save className="h-4 w-4" /> {saving ? "Saving…" : "Save reminder"}
            </Button>
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

/** One numbered decision. Four short steps read as a task; one long form reads as
 *  paperwork, which is what this screen was. */
function Beat({ step, title, optional, children }: {
  step: number;
  title: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-brand-050
                         text-[11px] font-bold text-brand">
          {step}
        </span>
        {title}
        {optional && <span className="text-xs font-normal text-muted">— optional</span>}
      </h3>
      {children}
    </section>
  );
}

/** The placeholders, as things to tap rather than a list to copy by hand. */
function VariableChips({ onPick }: { onPick: (token: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted">Tap to add:</span>
      {TEMPLATE_VARIABLES.map((variable) => (
        <button
          key={variable.token}
          type="button"
          title={`Becomes: ${variable.example}`}
          onClick={() => onPick(variable.token)}
          className="inline-flex min-h-8 items-center rounded-full border border-line
                     bg-content1 px-2.5 text-xs font-medium text-body transition-colors
                     hover:border-brand hover:bg-brand-050 hover:text-brand"
        >
          {variable.label}
        </button>
      ))}
    </div>
  );
}
