import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  ArrowRight, CalendarDays, CheckCircle2, ChevronRight, CircleX,
  FilePlus2, LayoutGrid, PackageCheck, TriangleAlert, Warehouse,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "@/shared/auth/AuthContext";
import { MenuIcon } from "@/shared/layout/icons";
import { homeApi, homeKeys } from "../api";
import { fmtTime, parseIst } from "@/shared/datetime";
import type {
  AttentionSummary, HomeAction, HomeDateRange, HomeKpi, HomeModule,
  RecentActivity,
} from "../types";

const toneStyles: Record<string, { badge: string; text: string }> = {
  brand: { badge: "bg-brand-050 text-brand", text: "text-brand" },
  green: { badge: "bg-ok-bg text-ok", text: "text-ok" },
  purple: { badge: "bg-purple-50 text-purple-600", text: "text-purple-600" },
  cyan: { badge: "bg-cyan-50 text-cyan-600", text: "text-cyan-600" },
  orange: { badge: "bg-orange-50 text-orange-600", text: "text-orange-600" },
  red: { badge: "bg-bad-bg text-bad", text: "text-bad" },
  neutral: { badge: "bg-neutral-bg text-neutral", text: "text-neutral" },
};

const tone = (name: string) => toneStyles[name] ?? toneStyles.brand;

const homeIcons: Record<string, LucideIcon> = {
  "circle-check": CheckCircle2,
  "package-down": PackageCheck,
  "triangle-alert": TriangleAlert,
  "circle-x": CircleX,
  "file-plus": FilePlus2,
  warehouse: Warehouse,
  "layout-grid": LayoutGrid,
};

function HomeIcon({ name, className }: { name: string; className: string }) {
  const Icon = homeIcons[name];
  return Icon
    ? <Icon className={className} strokeWidth={2} />
    : <MenuIcon name={name} className={className} />;
}

function IconBadge({
  icon, toneName, large = false,
}: { icon: string; toneName: string; large?: boolean }) {
  return (
    <span className={`grid shrink-0 place-items-center rounded-xl ${tone(toneName).badge} ${
      large ? "h-10 w-10" : "h-8 w-8"
    }`}>
      <HomeIcon name={icon} className={large ? "h-5 w-5" : "h-4 w-4"} />
    </span>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-muted">
      {children}
    </h2>
  );
}

function KpiCard({ item }: { item: HomeKpi }) {
  return (
    <Link
      to={item.href}
      className="group flex min-h-44 flex-col rounded-2xl border border-line bg-content1 p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-brand/30 hover:shadow-md"
    >
      <div className="flex items-center gap-3">
        <IconBadge icon={item.icon} toneName={item.tone} />
        <span className="text-[11px] font-semibold uppercase leading-tight text-ink-500">
          {item.label}
        </span>
      </div>
      <div className="mt-4 text-3xl font-bold tabular text-ink">{item.value}</div>
      <div className={`mt-1 text-xs font-medium ${tone(item.detail_tone).text}`}>
        {item.detail}
      </div>
      <span className="mt-auto inline-flex items-center gap-2 pt-4 text-xs font-semibold text-brand">
        View all
        <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}

function QuickAction({ item }: { item: HomeAction }) {
  return (
    <Link
      to={item.href}
      className="group flex min-h-16 items-center gap-3 rounded-xl border border-line bg-content1 px-4 py-3 shadow-sm transition hover:border-brand/30 hover:shadow-md"
    >
      <IconBadge icon={item.icon} toneName={item.tone} large />
      <span className="text-sm font-medium text-ink">{item.label}</span>
      <ChevronRight className="ml-auto h-4 w-4 text-muted opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
    </Link>
  );
}

function ModuleCard({ item }: { item: HomeModule }) {
  return (
    <Link
      to={item.href}
      className="group flex min-h-24 items-start gap-3 rounded-xl border border-line bg-content1 p-3 transition hover:border-brand/30 hover:bg-brand-050/30"
    >
      <IconBadge icon={item.icon} toneName="brand" large />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">{item.name}</span>
        <span className="mt-1 block text-xs leading-5 text-muted">{item.description}</span>
      </span>
      <ChevronRight className="mt-3 h-4 w-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

function AttentionRow({ item }: { item: AttentionSummary }) {
  return (
    <Link
      to={item.href}
      className="group flex min-h-12 items-center gap-3 border-b border-line/80 py-2 last:border-0"
    >
      <IconBadge icon={item.icon} toneName={item.tone} />
      <span className="min-w-0 flex-1 truncate text-sm text-ink">{item.label}</span>
      <span className="tabular text-sm font-semibold text-ink">{item.count}</span>
      <ChevronRight className="h-4 w-4 text-muted transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

function formatActivityTime(value: string) {
  const date = parseIst(value);
  if (!date) return "—";
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
  const day = sameDay(date, today) ? "Today" : sameDay(date, yesterday)
    ? "Yesterday" : date.toLocaleDateString("en-IN",
      { month: "short", day: "numeric", timeZone: "Asia/Kolkata" });
  return `${day}, ${fmtTime(date)}`;
}

function ActivityItem({ item }: { item: RecentActivity }) {
  return (
    <Link to={item.href} className="group flex min-w-0 items-center gap-3">
      <IconBadge icon={item.icon} toneName={item.tone} large />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-ink">{item.title}</span>
        <span className="mt-1 block truncate text-xs text-muted">
          {formatActivityTime(item.occurred_at)} · {item.subtitle}
        </span>
      </span>
    </Link>
  );
}

function HomeSkeleton() {
  return (
    <div aria-label="Loading home dashboard" className="animate-pulse space-y-6">
      <div className="h-20 rounded-2xl bg-default" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="h-44 rounded-2xl bg-default" />
        ))}
      </div>
      <div className="h-72 rounded-2xl bg-default" />
    </div>
  );
}

export function HomePage() {
  const { me } = useAuth();
  const [dateRange, setDateRange] = useState<HomeDateRange>("week");
  const [showAllModules, setShowAllModules] = useState(false);
  const accountScope = {
    employeeId: me?.employee.id ?? null,
    activePositionId: me?.active_position?.id ?? null,
  };
  const { data, isLoading, isError } = useQuery({
    queryKey: homeKeys.summary(accountScope, dateRange),
    queryFn: () => homeApi.summary(dateRange),
    enabled: accountScope.employeeId !== null,
  });

  if (isLoading) return <HomeSkeleton />;

  const modules = showAllModules ? data?.modules ?? [] : (data?.modules ?? []).slice(0, 6);
  const firstName = me?.employee.name?.trim().split(/\s+/)[0] || "there";

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-3xl font-bold text-ink">Hello, {firstName}</h1>
          <p className="mt-1 text-sm text-muted">
            Here&apos;s what&apos;s happening in your supply chain today.
          </p>
        </div>
        <label className="w-full sm:w-auto">
          <span className="mb-1 block text-xs font-medium text-muted">Date range</span>
          <span className="flex h-10 items-center gap-2 rounded-lg border border-line bg-content1 px-3">
            <CalendarDays className="h-4 w-4 text-muted" />
            <select
              aria-label="Date range"
              value={dateRange}
              onChange={(event) => setDateRange(event.target.value as HomeDateRange)}
              className="min-w-28 bg-transparent text-sm text-ink outline-none"
            >
              <option value="week">This Week</option>
              <option value="month">This Month</option>
              <option value="quarter">This Quarter</option>
            </select>
          </span>
        </label>
      </div>

      {isError && (
        <div className="rounded-xl border border-bad/30 bg-bad-bg p-4 text-sm text-bad">
          The home summary could not be loaded. Please refresh and try again.
        </div>
      )}

      {!!data?.kpis.length && (
        <section>
          <SectionLabel>Overview</SectionLabel>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
            {data.kpis.map((item) => <KpiCard key={item.key} item={item} />)}
          </div>
        </section>
      )}

      {!!data?.quick_actions.length && (
        <section>
          <SectionLabel>Quick Actions</SectionLabel>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {data.quick_actions.map((item) => <QuickAction key={item.key} item={item} />)}
          </div>
        </section>
      )}

      <div className="grid gap-5 lg:grid-cols-[1.25fr_1fr]">
        {!!data?.modules.length && (
          <section className="rounded-2xl border border-line bg-content1 p-4 shadow-sm">
            <SectionLabel>My Modules</SectionLabel>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {modules.map((item) => <ModuleCard key={item.code} item={item} />)}
            </div>
            {data.modules.length > 6 && (
              <div className="mt-4 flex justify-center">
                <button
                  type="button"
                  onClick={() => setShowAllModules((current) => !current)}
                  className="inline-flex h-10 items-center gap-2 rounded-lg border border-line px-4 text-sm font-semibold text-brand hover:bg-brand-050"
                >
                  <LayoutGrid className="h-4 w-4" />
                  {showAllModules ? "Show fewer modules" : "View all modules"}
                </button>
              </div>
            )}
          </section>
        )}

        {!!data?.needs_attention.length && (
          <section className="rounded-2xl border border-line bg-content1 p-4 shadow-sm">
            <SectionLabel>Needs Your Attention</SectionLabel>
            <div>
              {data.needs_attention.map((item) => (
                <AttentionRow key={item.key} item={item} />
              ))}
            </div>
          </section>
        )}
      </div>

      {!!data?.recent_activity.length && (
        <section className="rounded-2xl border border-line bg-content1 p-4 shadow-sm">
          <SectionLabel>Recent Activity</SectionLabel>
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {data.recent_activity.map((item) => <ActivityItem key={item.id} item={item} />)}
          </div>
        </section>
      )}

      {data && !data.kpis.length && !data.modules.length && (
        <div className="rounded-2xl border border-line bg-content1 px-6 py-14 text-center">
          <LayoutGrid className="mx-auto h-8 w-8 text-muted" />
          <p className="mt-3 text-sm font-medium text-ink">No modules are assigned yet.</p>
          <p className="mt-1 text-xs text-muted">
            Ask an administrator to assign the access needed for your role.
          </p>
        </div>
      )}
    </div>
  );
}
