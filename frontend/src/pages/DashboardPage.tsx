import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { FileText, Clock, CheckCircle2, CalendarDays, Plus } from "lucide-react";
import { Card, CardBody } from "@heroui/react";
import { PageHeader, StatCard, StatusPill, Button, Can } from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { indentApi } from "@/modules/indents/api";

export function DashboardPage() {
  const { me, can } = useAuth();
  const nav = useNavigate();
  const showIndents = can("indent.view");

  const { data: stats } = useQuery({
    queryKey: ["indent-stats"],
    queryFn: indentApi.stats,
    enabled: showIndents,
  });
  const { data: recent } = useQuery({
    queryKey: ["indents", ""],
    queryFn: () => indentApi.list({ size: 6 }),
    enabled: showIndents,
  });

  const KPI = [
    { label: "Total indents", value: stats?.total, icon: FileText, tone: "text-ink" },
    { label: "Awaiting approval", value: stats?.awaiting_approval, icon: Clock, tone: "text-warn" },
    { label: "Approved & active", value: stats?.approved_active, icon: CheckCircle2, tone: "text-ok" },
    { label: "This month", value: stats?.this_month, icon: CalendarDays, tone: "text-brand" },
  ];

  return (
    <>
      <PageHeader
        eyebrow={`Signed in as ${me?.roles.join(" · ")}`}
        title={`Hello, ${me?.employee.name?.split(" ")[0] ?? "there"}`}
        actions={
          <Can do="indent.create">
            <Button onClick={() => nav("/indents/new")}><Plus className="h-4 w-4" /> New indent</Button>
          </Can>
        }
      />

      {showIndents ? (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {KPI.map((k) => (
              <StatCard key={k.label} label={k.label} tone={k.tone}
                        icon={<k.icon className="h-4 w-4" />} value={k.value ?? "—"} />
            ))}
          </div>

          <Card shadow="sm" radius="lg" className="mt-5 border border-line/70 bg-content1">
            <CardBody className="p-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Recent indents</h2>
                <Link to="/indents" className="text-sm font-semibold text-brand hover:text-brand-600">View all</Link>
              </div>
              <div className="divide-y divide-line/70">
                {(recent?.items ?? []).map((i) => (
                  <button key={i.id} onClick={() => nav(`/indents/${i.id}`)}
                          className="flex w-full items-center justify-between py-2.5 text-left">
                    <div>
                      <div className="mono text-sm font-semibold text-ink">{i.indent_no}</div>
                      <div className="text-xs text-muted">{i.department_name ?? "—"}</div>
                    </div>
                    <StatusPill status={i.status} />
                  </button>
                ))}
                {recent?.items.length === 0 && (
                  <p className="py-6 text-center text-sm text-muted">No indents yet.</p>
                )}
              </div>
            </CardBody>
          </Card>
        </>
      ) : (
        <Card shadow="sm" radius="lg" className="border border-line/70 bg-content1">
          <CardBody className="px-6 py-16 text-center text-muted">
            Use the menu on the left to open a module.
          </CardBody>
        </Card>
      )}
    </>
  );
}
