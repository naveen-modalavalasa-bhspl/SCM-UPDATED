export interface AppSettings {
  company: {
    name: string;
    legal_name: string;
    gstin: string;
    address: string;
    phone: string;
    email: string;
  };
  regional: {
    fiscal_year: string;
    default_warehouse_id?: number | null;
    currency: string;
    date_format: string;
    timezone: string;
  };
  hcm_sync: {
    enabled: boolean;
    interval_minutes: number;
  };
  numbering: {
    fiscal_year_prefix: string;
    default_pattern: string;
    reset_policy: string;
  };
  notifications: {
    channels: string[];
    email_enabled: boolean;
    in_app_enabled: boolean;
  };
  fallback: {
    workflow_fallback_enabled: boolean;
    notify_admin_on_fallback: boolean;
    allow_auto_admin_fallback: boolean;
  };
}
