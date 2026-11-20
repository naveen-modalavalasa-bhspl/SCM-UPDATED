/** "day" is a rolling 24 hours, not "since midnight"; "custom" is the only value
 *  that carries dates with it. */
export type HomeDateRange = "day" | "week" | "month" | "quarter" | "custom";

/** The two dates a custom range needs. Empty strings mean "open at that end". */
export interface HomeCustomRange {
  from: string;
  to: string;
}

export interface HomeKpi {
  key: string;
  label: string;
  value: number;
  detail: string;
  detail_tone: string;
  href: string;
  icon: string;
  tone: string;
  /** Highlighted lines under the figure (2026-11-20): the Approvals card's "stuck at
   *  final approval" (red) and "waiting over 12 h" (amber), each a link of its own. */
  highlights?: HomeKpiHighlight[];
}

export interface HomeKpiHighlight {
  text: string;
  tone: "red" | "amber";
  href: string;
  hint?: string;
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
