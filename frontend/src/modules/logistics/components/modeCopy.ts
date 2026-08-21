/** How a transport mode reads on screen.
 *
 * The RULES (what a mode requires, whether it is tendered) come from the backend at
 * `/api/transport/modes` and are never duplicated here — this file is only the short
 * label and the tint, which are presentation and have no business meaning.
 */
import type { CarriageMode, TransportMode } from "../transportTypes";

export const MODE_LABEL: Record<TransportMode, string> = {
  DIRECT: "Hand-over",
  COURIER: "Courier",
  OWN_VEHICLE: "Own vehicle",
  // "Third-party", never "3PL": the desk chooses it by that name, the mode filter on
  // Shipments has always read it that way, and a screen that abbreviates it
  // in the picker and spells it out in the filter reads as two different modes.
  THIRD_PARTY: "Third-party",
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

/** The other half of "how does this travel": what it is carried ON. Same arrangement
 * as the mode above — the RULE (which arrangements each carriage allows) is served at
 * `/api/transport/carriage-modes` and never restated here; this is the short chip
 * label for reading a carriage BACK off a document, where no catalogue was fetched. */
export const CARRIAGE_LABEL: Record<CarriageMode, string> = {
  ROAD: "Road", RAIL: "Rail", AIR: "Air", SEA: "Sea",
};

export const CARRIAGE_TINT: Record<CarriageMode, string> = {
  ROAD: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  RAIL: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  AIR: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
  SEA: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
};

/** Nothing recorded reads as Road, because that is what an unstated leg has always
 * been — the same fallback the service applies when the column is empty. */
export const carriageLabel = (carriage?: string | null) =>
  CARRIAGE_LABEL[(carriage ?? "ROAD") as CarriageMode] ?? String(carriage);

export const carriageTint = (carriage?: string | null) =>
  CARRIAGE_TINT[(carriage ?? "ROAD") as CarriageMode] ?? CARRIAGE_TINT.ROAD;

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
  { value: "AWAITING_CARRIER", label: "Awaiting carrier" },
  { value: "READY", label: "Ready to dispatch" },
  { value: "IN_TRANSIT", label: "In transit" },
  { value: "DELIVERED", label: "Delivered" },
  { value: "ACKNOWLEDGED", label: "Acknowledged" },
  { value: "CLOSED", label: "Closed" },
  { value: "REJECTED", label: "Rejected" },
  { value: "CANCELLED", label: "Cancelled" },
];

/** What the desk should DO about a request in this status, in four words.
 *
 * Every list in this module shows it next to the status pill. A status names the
 * state; this names the next move, and a desk working a queue needs the second one. */
export const NEXT_MOVE: Record<string, string> = {
  DRAFT: "Finish and send for approval",
  PENDING_APPROVAL: "Waiting on the approver",
  QUOTING: "Invite carriers and award",
  AWAITING_CARRIER: "Carrier has not confirmed yet",
  READY: "Dispatch it — gate pass and LR",
  IN_TRANSIT: "Waiting for the site to sign",
  DELIVERED: "Waiting for the site to sign",
  ACKNOWLEDGED: "Close the shipment",
  CLOSED: "Done",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
};

export const nextMove = (status: string) => NEXT_MOVE[status] ?? "";

/** Tailwind tint per status, for the board tiles and the stepper. `StatusPill` is
 * still the pill everywhere a status is only being reported; these are for the
 * surfaces that are about the flow itself. */
export const STATUS_TINT: Record<string, string> = {
  DRAFT: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  PENDING_APPROVAL: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  QUOTING: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  AWAITING_CARRIER: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  READY: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
  IN_TRANSIT: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  DELIVERED: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
  ACKNOWLEDGED: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  CLOSED: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
  REJECTED: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  CANCELLED: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
};

export const statusTint = (status: string) =>
  STATUS_TINT[status] ?? STATUS_TINT.DRAFT;

export const humanStatus = (status: string) =>
  status.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());

/** kg / m³ / package counts, printed the same way everywhere. */
export const load = (packages?: number | null, weightKg?: number | null) =>
  `${Number(packages ?? 0)} pkg · ${Number(weightKg ?? 0).toLocaleString("en-IN")} kg`;
