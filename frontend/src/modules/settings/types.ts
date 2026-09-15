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
  warehouse: {
    /** What a stocking point does with an arriving consignment when it has not
     *  answered for itself. The per-point flag on the warehouse master wins. */
    requires_inward_default: boolean;
  };
  logistics: {
    /** Let the dispatch desk record a courier name without a logistics-vendor login. */
    manual_courier_dispatch: boolean;
  };
  security: {
    /** How long a vendor's one-time code stays good for, in seconds. Enforced by the
     *  server at verification time — the vendor's screen shows the window but never
     *  decides it, so a client that ignores the number gets no longer a life. */
    vendor_quote_otp_seconds: number;
    /** How long a "forgot password" link stays live, in minutes. Rejected server-side
     *  on redemption, so the number here is the rule and not a hint. */
    password_reset_minutes: number;
  };
}

/** GET/PUT /api/settings/code-formats — the asset & consumable code formula.
 *  Separate from AppSettings because it has its own permission. */
export interface CodeFormats {
  asset_format: string;
  consumable_format: string;
  /** The serial minted at goods-in for a unit that arrived without one. Cannot use
   *  {serial} — it IS the serial — and must include {seq}. */
  serial_format: string;
  new_flag: string;
  legacy_flag: string;
  /** ISO date. Items created before it render `legacy_flag` for {new_flag}. */
  legacy_before: string;
}

export interface CodeFormatToken {
  token: string;
  description: string;
}
