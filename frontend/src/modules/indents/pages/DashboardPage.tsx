import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus, FileText, Clock, CheckCircle2, XCircle, CalendarDays, PencilLine } from "lucide-react";
import { PageHeader, Card, Button, StatCard, StatusPill, Can } from "@/shared/components";
import { indentApi } from "../api";
import type { IndentStats } from "../types";

const KPI = [
  { key: "total", label: "Total indents", icon: FileText, tone: "text-ink" },
  { key: "awaiting_approval", label: "Awaiting approval", icon: Clock, tone: "text-warn" },
  { key: "approved_active", label: "Approved & active", icon: CheckCircle2, tone: "text-ok" },
  { key: "rejected", label: "Rejected", icon: XCircle, tone: "text-bad" },
  { key: "this_month", label: "Raised this month", icon: CalendarDays, tone: "text-brand" },
  { key: "draft", label: "In draft", icon: PencilLine, tone: "text-muted" },
] as const;

// status -> bar color, for the distribution strip
const BAR: Record<string, string> = {
  DRAFT: "bg-neutral", PENDING_APPROVAL: "bg-warn", APPROVED: "bg-ok",
  ORDERED: "bg-info", PARTIALLY_ORDERED: "bg-info", REJECTED: "bg-bad", CLOSED: "bg-neutral",
};

function StatusBar({ by }: { by: Record<string, number> }) {
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  if (!total) return <p className="text-sm text-muted">No indents yet.</p>;
  const entries = Object.entries(by).sort((a, b) => b[1] - a[1]);
  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full">
        {entries.map(([s, n]) => (
          <div key={s} className={BAR[s] ?? "bg-neutral"} style={{ width: `${(n / total) * 100}%` }} title={`${s}: ${n}`} />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {entries.map(([s, n]) => (
          <span key={s} className="flex items-center gap-1.5 text-xs text-muted">
            <span className={`h-2 w-2 rounded-full ${BAR[s] ?? "bg-neutral"}`} />
            {s.replace(/_/g, " ").toLowerCase()} · <span className="tabular font-semibold text-body">{n}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function IndentDashboardPage() {
  const nav = useNavigate();
  const { data: stats } = useQuery({ queryKey: ["indent-stats"], queryFn: indentApi.stats });
  const { data: recent } = useQuery({ queryKey: ["indents", ""], queryFn: () => indentApi.list({ size: 6 }) });

  return (
    <>
      <PageHeader
        eyebrow="Indents"
        title="Dashboard"
        actions={
          <Can do="indent.create">
            <Button onClick={() => nav("/indents/new")}><Plus className="h-4 w-4" /> New indent</Button>
          </Can>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        {KPI.map(({ key, label, icon: Icon, tone }) => (
          <StatCard
            key={key}
            label={label}
            tone={tone}
            icon={<Icon className="h-4 w-4" />}
            value={stats ? (stats[key as keyof IndentStats] as number) : "—"}
          />
        ))}
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted">Status breakdown</h2>
          {stats && <StatusBar by={stats.by_status} />}
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted">Recent</h2>
          <div className="divide-y divide-line/70">
            {(recent?.items ?? []).map((i) => (
              <button key={i.id} onClick={() => nav(`/indents/${i.id}`)} className="flex w-full items-center justify-between py-2.5 text-left">
                <span className="mono text-sm font-semibold text-ink">{i.indent_no}</span>
                <StatusPill status={i.status} />
              </button>
            ))}
            {recent?.items.length === 0 && <p className="py-4 text-center text-sm text-muted">No indents yet.</p>}
          </div>
        </Card>
      </div>
    </>
  );
}
