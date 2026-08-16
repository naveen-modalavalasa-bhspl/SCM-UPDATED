/** How a transport mode reads on screen.
 *
 * The RULES (what a mode requires, whether it is tendered) come from the backend at
 * `/api/transport/modes` and are never duplicated here — this file is only the short
 * label and the tint, which are presentation and have no business meaning.
 */
import type { TransportMode } from "../transportTypes";

export const MODE_LABEL: Record<TransportMode, string> = {
  DIRECT: "Hand-over",
  COURIER: "Courier",
  OWN_VEHICLE: "Own vehicle",
  THIRD_PARTY: "3PL",
};

/** Tailwind classes for the mode chip. Deliberately not `StatusPill`: a mode is not
 * a status, and colouring it like one makes a DIRECT request look "approved". */
export const MODE_TINT: Record<TransportMode, string> = {
  DIRECT: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  COURIER: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
  OWN_VEHICLE: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  THIRD_PARTY: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
};

export const modeLabel = (mode: string) =>
  MODE_LABEL[mode as TransportMode] ?? mode;

export const modeTint = (mode: string) =>
  MODE_TINT[mode as TransportMode] ?? MODE_TINT.DIRECT;

export const money = (n?: number | null) =>
  `₹${Number(n ?? 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

/** Statuses, in the order the flow actually runs, for the filter dropdown. */
export const TR_STATUSES = [
  { value: "", label: "All statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "PENDING_APPROVAL", label: "Pending approval" },
  { value: "QUOTING", label: "Out to carriers" },
  { value: "READY", label: "Ready to dispatch" },
  { value: "IN_TRANSIT", label: "In transit" },
  { value: "DELIVERED", label: "Delivered" },
  { value: "CLOSED", label: "Closed" },
  { value: "REJECTED", label: "Rejected" },
  { value: "CANCELLED", label: "Cancelled" },
];
