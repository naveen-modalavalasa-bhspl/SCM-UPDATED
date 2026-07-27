export interface HomeKpi {
  key: string;
  label: string;
  value: number;
  tone: "neutral" | "brand" | "warning" | "danger" | string;
}

export interface AttentionItem {
  id: string;
  title: string;
  subtitle?: string | null;
  module: string;
  href: string;
  status?: string | null;
  priority?: string | null;
  count?: number | null;
}

export interface HomeSummary {
  role_context: string[];
  kpis: HomeKpi[];
  needs_attention: AttentionItem[];
  pending_approvals: AttentionItem[];
  open_indents: AttentionItem[];
  waiting_on_me: AttentionItem[];
  stock_below_reorder: AttentionItem[];
  mrs_waiting_procurement: AttentionItem[];
  pos_due: AttentionItem[];
  grns_pending_qc: AttentionItem[];
}
