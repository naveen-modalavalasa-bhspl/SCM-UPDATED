import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle, ClipboardCheck, FileText, PackageSearch, ShoppingCart,
} from "lucide-react";
import { PageHeader, ResponsiveList, StatCard, StatusPill, type Column } from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { homeApi } from "@/modules/home/api";
import type { AttentionItem, HomeKpi } from "@/modules/home/types";

const toneClass: Record<string, string> = {
  warning: "text-warn",
  danger: "text-bad",
  brand: "text-brand",
  neutral: "text-ink",
};

function iconFor(key: string) {
  if (key.includes("approval")) return ClipboardCheck;
  if (key.includes("stock")) return PackageSearch;
  if (key.includes("mr")) return ShoppingCart;
  if (key.includes("grn")) return AlertTriangle;
  return FileText;
}

function KpiCard({ kpi }: { kpi: HomeKpi }) {
  const Icon = iconFor(kpi.key);
  return (
    <StatCard
      label={kpi.label}
      value={kpi.value}
      tone={toneClass[kpi.tone] ?? "text-ink"}
      icon={<Icon className="h-4 w-4" />}
    />
  );
}

export function DashboardPage() {
  const { me } = useAuth();
  const nav = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ["home-summary"],
    queryFn: homeApi.summary,
  });

  const columns: Column<AttentionItem>[] = [
    {
      key: "title",
      header: "Item",
      render: (row) => (
        <div>
          <div className="mono font-semibold text-ink">{row.title}</div>
          <div className="text-xs text-muted">{row.subtitle ?? row.module}</div>
        </div>
      ),
    },
    { key: "module", header: "Module", hideOnNarrow: true, render: (row) => row.module },
    {
      key: "status",
      header: "Status",
      render: (row) => row.status ? <StatusPill status={row.status} /> : "-",
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow={`Signed in as ${me?.roles.join(" - ")}`}
        title={`Hello, ${me?.employee.name?.split(" ")[0] ?? "there"}`}
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {(data?.kpis ?? []).map((kpi) => <KpiCard key={kpi.key} kpi={kpi} />)}
        {!data?.kpis.length && !isLoading && (
          <StatCard label="Work items" value={0} tone="text-muted" icon={<FileText className="h-4 w-4" />} />
        )}
      </div>

      <div className="mt-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Needs your attention</h2>
        </div>
        <ResponsiveList
          data={data?.needs_attention ?? []}
          columns={columns}
          keyOf={(row) => row.id}
          loading={isLoading}
          onRowClick={(row) => nav(row.href)}
          empty="Nothing needs attention right now."
          renderCard={(row) => (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="mono truncate font-semibold text-ink">{row.title}</div>
                <div className="truncate text-xs text-muted">{row.subtitle ?? row.module}</div>
              </div>
              {row.status && <StatusPill status={row.status} />}
            </div>
          )}
        />
      </div>
    </>
  );
}
