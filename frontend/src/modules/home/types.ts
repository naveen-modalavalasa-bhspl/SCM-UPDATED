export type HomeDateRange = "week" | "month" | "quarter";

export interface HomeKpi {
  key: string;
  label: string;
  value: number;
  detail: string;
  detail_tone: string;
  href: string;
  icon: string;
  tone: string;
}

export interface HomeAction {
  key: string;
  label: string;
  href: string;
  icon: string;
  tone: string;
}

export interface HomeModule {
  code: string;
  name: string;
  description: string;
  href: string;
  icon: string;
}

export interface AttentionSummary {
  key: string;
  label: string;
  count: number;
  href: string;
  icon: string;
  tone: string;
}

export interface RecentActivity {
  id: string;
  title: string;
  subtitle: string;
  occurred_at: string;
  href: string;
  icon: string;
  tone: string;
}

export interface HomeSummary {
  date_range: HomeDateRange;
  kpis: HomeKpi[];
  quick_actions: HomeAction[];
  modules: HomeModule[];
  needs_attention: AttentionSummary[];
  recent_activity: RecentActivity[];
}
