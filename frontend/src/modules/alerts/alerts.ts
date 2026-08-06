import { clearAlerts, pushAlert } from "./store";
import type { AlertOptions, AlertParams } from "./types";

/**
 * The call site's API.
 *
 * Two ways in, and the first is the one to reach for:
 *
 *   await alerts.confirm("po.cancel", { number: po.number })   // catalog code
 *   alerts.success("grn.posted", { number: grn.number })
 *
 *   alerts.show({ variant: "error", title: "…", message: "…" })  // one-off
 *
 * A code keeps the wording in one place and identical on every screen that
 * raises the same event; the free-form form is the escape hatch for something
 * genuinely local.
 *
 * Everything returns a promise resolving `true` only when the primary button was
 * pressed, so a destructive handler reads top to bottom:
 *
 *   if (!(await alerts.confirm("item.delete", { name: item.name }))) return;
 *   await remove(item.id);
 */
export const alerts = {
  /** Catalog-driven. `overrides` wins over the catalog entry for this one call. */
  from: (code: string, params?: AlertParams, overrides?: AlertOptions) =>
    pushAlert(code, { ...overrides, params }),

  /** Free-form dialog, no catalog entry. */
  show: (options: AlertOptions) => pushAlert(null, options),

  /** Asks a question and waits. Never closes itself. */
  confirm: (code: string, params?: AlertParams, overrides?: AlertOptions) =>
    pushAlert(code, { ...overrides, params, mode: "confirm" }),

  success: (code: string, params?: AlertParams, overrides?: AlertOptions) =>
    pushAlert(code, { variant: "success", ...overrides, params, mode: "alert" }),

  info: (code: string, params?: AlertParams, overrides?: AlertOptions) =>
    pushAlert(code, { variant: "info", ...overrides, params, mode: "alert" }),

  /** Stays on screen: a warning nobody read is a warning that did not happen. */
  warning: (code: string, params?: AlertParams, overrides?: AlertOptions) =>
    pushAlert(code, { variant: "warning", autoCloseMs: null, ...overrides, params, mode: "alert" }),

  /** Stays on screen. A failure that vanishes reads as a success. */
  error: (code: string, params?: AlertParams, overrides?: AlertOptions) =>
    pushAlert(code, { variant: "error", autoCloseMs: null, ...overrides, params, mode: "alert" }),

  /** Close every open dialog — call on sign-out. */
  clear: clearAlerts,
};

export type Alerts = typeof alerts;
