/** Tone of a dialog — drives icon, tint and button colour. */
export type AlertVariant = "success" | "info" | "warning" | "danger" | "error";

/** `alert` tells the user something. `confirm` asks, and waits for an answer. */
export type AlertMode = "alert" | "confirm";

/** A catalog entry, mirroring `backend/app/modules/alerts/schemas.py`. */
export interface AlertDef {
  code: string;
  variant: AlertVariant;
  mode: AlertMode;
  title: string;
  message: string;
  confirm_label?: string | null;
  cancel_label?: string | null;
  /** null = stays until dismissed. */
  auto_close_ms?: number | null;
}

export interface AlertCatalogResponse {
  items: Record<string, AlertDef>;
  total: number;
}

/** Values substituted into `{placeholders}` in a catalog message or title. */
export type AlertParams = Record<string, string | number | null | undefined>;

/** Everything a call site may override on top of the catalog entry. */
export interface AlertOptions {
  variant?: AlertVariant;
  mode?: AlertMode;
  title?: string;
  message?: string;
  confirmLabel?: string | null;
  cancelLabel?: string | null;
  /** ms, or null to keep it on screen until dismissed. */
  autoCloseMs?: number | null;
  params?: AlertParams;
}

/** A dialog currently on screen. */
export interface ActiveAlert {
  id: number;
  variant: AlertVariant;
  mode: AlertMode;
  title: string;
  message: string;
  confirmLabel: string | null;
  cancelLabel: string | null;
  autoCloseMs: number | null;
}
