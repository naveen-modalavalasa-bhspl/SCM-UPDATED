import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Clock, Check, AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { Spinner, Switch } from "@heroui/react";
import { PageHeader, Card, Button, Field, Input } from "@/shared/components";
import { fmtDateTime, fmtRelative } from "@/shared/datetime";
import { adminApi } from "../api";
import type { SyncFollowUp, SyncResult } from "../types";
import { syncOutcome } from "../syncOutcome";
import type { SyncOutcome, SyncTone } from "../syncOutcome";

const PRESETS = [
  { label: "Hourly", minutes: 60 },
  { label: "Every 6h", minutes: 360 },
  { label: "Every 12h", minutes: 720 },
  { label: "Daily", minutes: 1440 },
];

// Display order = the sync order. These are `sync.NEEDED_ENTITIES`, and nothing else:
// the card used to list `position_assignments`, which is deliberately never pulled
// (seats are derived from each position's `assigned_employee`), so it sat at "—" for
// ever; and it omitted sections, roles and projects, which every run does pull.
const ENTITIES = [
  ["offices", "Offices"],
  ["departments", "Departments"],
  ["sections", "Sections"],
  ["roles", "Roles"],
  ["position_levels", "Position levels"],
  ["projects", "Projects"],
  ["positions", "Positions"],
  ["employees", "Employees"],
] as const;

function latestByEntity(items: SyncResult[]): Record<string, SyncResult> {
  const map: Record<string, SyncResult> = {};
  for (const it of items) if (!map[it.entity]) map[it.entity] = it; // items are newest-first
  return map;
}

function EntityRow({ label, r }: { label: string; r?: SyncResult }) {
  const status = r?.status;
  return (
    <div className="border-b border-line/60 py-2.5 last:border-0">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          {status === "RUNNING" && <Spinner size="sm" color="primary" />}
          {status === "SUCCESS" && <Check className="h-4 w-4 text-ok" />}
          {status === "FAILED" && <AlertTriangle className="h-4 w-4 text-bad" />}
          {!status && <span className="h-2 w-2 rounded-full bg-line" />}
          <span className="text-sm font-medium text-body">{label}</span>
        </div>
        <div className="flex items-center gap-2 text-xs tabular text-muted">
          {/* WHEN, next to WHAT. The card shows the newest row per entity, so a
              success from a run two days ago sat under today's failures and read as
              part of the same run — which is how a broken sync looked half-green. */}
          {status && status !== "RUNNING" && (
            <span title={fmtDateTime(r?.finished_at ?? r?.started_at)}>
              {fmtRelative(r?.finished_at ?? r?.started_at)}
            </span>
          )}
          {status === "SUCCESS" && <span>{r?.records_upserted} synced</span>}
          {status === "RUNNING" && <span>syncing…</span>}
          {status === "FAILED" && <span className="text-bad">failed</span>}
          {!status && <span>—</span>}
        </div>
      </div>
      {/* `sys_hcm_sync_log` has stored the reason all along — a bad key, a refused
          connection, a mapper that met a field HCM renamed. The screen said only
          "failed", so every diagnosis started with a query against the table. */}
      {status === "FAILED" && r?.error_message && (
        <p className="mt-1 break-words pl-6 text-[11px] text-bad">{r.error_message}</p>
      )}
    </div>
  );
}

/** Follow-up work the sync triggers. Shown beside the entities because a sync whose
 *  entities are all green can still have left the stocking-point links unwritten, and
 *  the only previous symptom was a storekeeper who could not see their own store. */
function FollowUpRow({ f }: { f: SyncFollowUp }) {
  return (
    <div className="border-b border-line/60 py-2.5 last:border-0">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          {f.ok
            ? <Check className="h-4 w-4 text-ok" />
            : <AlertTriangle className="h-4 w-4 text-bad" />}
          <span className="text-sm font-medium text-body">{f.label}</span>
        </div>
        <span className={`text-xs tabular ${f.ok ? "text-muted" : "text-bad"}`}>{f.detail}</span>
      </div>
    </div>
  );
}

const TONE_STYLE: Record<SyncTone, { box: string; icon: typeof Check }> = {
  success: { box: "border-ok/30 bg-ok-bg text-ok", icon: CheckCircle2 },
  warning: { box: "border-warn/30 bg-warn-bg text-warn", icon: AlertTriangle },
  error: { box: "border-bad/30 bg-bad-bg text-bad", icon: XCircle },
  info: { box: "border-brand/20 bg-brand-050 text-brand", icon: Info },
};

/** One sentence, one colour: green worked, amber worked with a follow-up to check,
 *  red failed (SCM_0197). `role="status"` so a screen reader hears the result too. */
function OutcomeBanner({ outcome, onClose }: { outcome: SyncOutcome; onClose: () => void }) {
  const { box, icon: Icon } = TONE_STYLE[outcome.tone];
  return (
    <div role={outcome.tone === "error" ? "alert" : "status"}
         className={`mb-5 flex items-start gap-3 rounded-xl border px-4 py-3 ${box}`}>
      <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{outcome.title}</p>
        {outcome.detail && <p className="mt-0.5 break-words text-xs text-body">{outcome.detail}</p>}
      </div>
      <button type="button" onClick={onClose} aria-label="Dismiss"
              className="-m-1 rounded-lg p-1 text-xs font-medium opacity-70 hover:opacity-100">
        ✕
      </button>
    </div>
  );
}

const ENTITY_LABELS: Record<string, string> = Object.fromEntries(ENTITIES);

export function AdminPage() {
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(false);
  const [interval, setIntervalMinutes] = useState(1440);
  const [msg, setMsg] = useState<SyncOutcome | null>(null);
  // When THIS screen's press started a run: its result is judged on the rows written
  // from then on, and only once the run has finished.
  const [pressedAt, setPressedAt] = useState<number | null>(null);

  const schedule = useQuery({ queryKey: ["hcm-schedule"], queryFn: adminApi.getSchedule });

  // Poll status; when a sync is running, refetch every 2.5s. Survives refresh because
  // progress lives server-side in the sync log.
  const status = useQuery({
    queryKey: ["hcm-sync-status"],
    queryFn: adminApi.syncStatus,
    refetchInterval: (q) => (q.state.data?.running ? 2500 : false),
  });
  const running = status.data?.running ?? false;
  const byEntity = latestByEntity(status.data?.items ?? []);
  const followUp = status.data?.follow_up ?? [];

  useEffect(() => {
    if (pressedAt === null || running) return;
    const outcome = syncOutcome(status.data?.items ?? [], pressedAt, ENTITY_LABELS);
    if (outcome) {
      setMsg(outcome);
      setPressedAt(null);
    }
  }, [pressedAt, running, status.data]);

  useEffect(() => {
    if (schedule.data) {
      setEnabled(schedule.data.enabled);
      setIntervalMinutes(schedule.data.interval_minutes);
    }
  }, [schedule.data]);

  const syncNow = useMutation({
    mutationFn: adminApi.syncNow,
    onSuccess: (r) => {
      setMsg(r.started
        ? { tone: "info", title: "Sync started", detail: "Tracking progress below — you can leave this page." }
        : { tone: "info", title: "A sync is already running", detail: "Its result appears here when it finishes." });
      qc.invalidateQueries({ queryKey: ["hcm-sync-status"] });
    },
    onError: (e: Error) => {
      setPressedAt(null);
      setMsg({ tone: "error", title: "Sync could not start", detail: e.message });
    },
  });

  const saveSchedule = useMutation({
    mutationFn: () => adminApi.setSchedule({ enabled, interval_minutes: interval }),
    onSuccess: (s) => {
      setMsg({ tone: "success", title: s.enabled
        ? `Auto-sync on, every ${s.interval_minutes} min.` : "Auto-sync off." });
      qc.setQueryData(["hcm-schedule"], s);
    },
    onError: (e: Error) => setMsg({ tone: "error", title: "Schedule not saved", detail: e.message }),
  });

  return (
    <>
      <PageHeader eyebrow="Admin" title="HCM data sync" />

      {msg && <OutcomeBanner outcome={msg} onClose={() => setMsg(null)} />}

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Manual sync + live progress */}
        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Sync from HCM</h2>
            {running && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-warn-bg px-2.5 py-1 text-xs font-semibold text-warn">
                <Spinner size="sm" color="warning" /> in progress
              </span>
            )}
          </div>
          <p className="mb-4 text-sm text-muted">
            Pull employees, positions, departments and offices into the local mirror. Runs in the
            background — you can leave or refresh this page.
          </p>
          <Button onClick={() => { setMsg(null); setPressedAt(Date.now()); syncNow.mutate(); }} disabled={running || syncNow.isPending}>
            <RefreshCw className={`h-4 w-4 ${running ? "animate-spin" : ""}`} />
            {running ? "Syncing…" : "Sync now"}
          </Button>

          <div className="mt-4">
            {ENTITIES.map(([key, label]) => <EntityRow key={key} label={label} r={byEntity[key]} />)}
          </div>

          {followUp.length > 0 && (
            <div className="mt-4 border-t border-line pt-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">After the sync</p>
              {followUp.map((f) => <FollowUpRow key={f.label} f={f} />)}
            </div>
          )}
        </Card>

        {/* Scheduled sync */}
        <Card className="p-5">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-muted">Automatic</h2>
          <p className="mb-4 text-sm text-muted">Run the sync on a fixed interval.</p>

          <div className="mb-4 flex items-center justify-between">
            <span className="text-sm font-medium text-body">Enable auto-sync</span>
            <Switch isSelected={enabled} onValueChange={setEnabled} color="primary" size="sm" />
          </div>

          <Field label="Interval (minutes)">
            <Input type="number" min={5} value={interval}
                   onChange={(e) => setIntervalMinutes(Number(e.target.value) || 0)} disabled={!enabled} />
          </Field>
          <div className="mt-2 flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button key={p.minutes} type="button" disabled={!enabled}
                      onClick={() => setIntervalMinutes(p.minutes)}
                      className={`rounded-full border px-3 py-1 text-xs font-medium disabled:opacity-40 ${
                        interval === p.minutes ? "border-brand bg-brand-050 text-brand" : "border-line text-muted hover:text-body"
                      }`}>
                {p.label}
              </button>
            ))}
          </div>

          {schedule.data?.next_run && enabled && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-muted">
              <Clock className="h-3.5 w-3.5" /> Next run {new Date(schedule.data.next_run).toLocaleString()}
            </p>
          )}

          <Button variant="subtle" className="mt-4" onClick={() => { setMsg(null); saveSchedule.mutate(); }}
                  disabled={saveSchedule.isPending || (enabled && interval < 5)}>
            {saveSchedule.isPending ? "Saving…" : "Save schedule"}
          </Button>
        </Card>
      </div>
    </>
  );
}
