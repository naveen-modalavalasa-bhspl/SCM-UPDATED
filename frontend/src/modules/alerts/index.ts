/* Alerts module — popup alerts and confirms.
 *
 *   import { alerts, useAlert } from "@/modules/alerts";
 *
 *   if (!(await alerts.confirm("po.cancel", { number: po.number }))) return;
 *   await cancelPO(po.id);
 *   alerts.success("grn.posted", { number: grn.grn_no });
 *
 * Copy lives in `catalog.ts` (mirroring the backend module), not at the call site.
 */
export { AlertProvider } from "./AlertProvider";
export { alerts, type Alerts } from "./alerts";
export { useAlert } from "./useAlert";
export { DEFAULT_CATALOG, AUTO_CLOSE_MS } from "./catalog";
export type {
  AlertVariant, AlertMode, AlertDef, AlertOptions, AlertParams, ActiveAlert,
} from "./types";
