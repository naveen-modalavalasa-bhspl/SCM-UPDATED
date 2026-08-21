/** WHICH transport details a leg actually records — the one place that decides it.
 *
 * A gate pass is read at a barrier by somebody with the load already on the weighbridge,
 * so every line on it has to be a line that can be answered for THIS leg. A hand-over
 * has no LR number, an own vehicle has no carrier reference, and a courier parcel has
 * no employee id — printing all seventeen fields on all four modes made the guard read
 * past ten dashes to find the two lines that matter.
 *
 * The allocation is DERIVED from the mode's own rule as served at
 * `/api/transport/modes` (`needs_carrier`, `needs_quotes`, `required_fields`), never
 * from a second copy of the mode table: the same predicates the dispatch form already
 * branches on decide what the pass prints, so a mode that changes what it asks for
 * changes what it shows without anybody editing this file.
 */
import { fmtDate } from "@/shared/datetime";
import { money } from "./modeCopy";
import type { ModeRule } from "../transportTypes";

export type CarryingField =
  | "carrier_name" | "freight_amount" | "expected_delivery"
  | "vehicle_number" | "driver_name" | "driver_phone" | "driver_licence_no"
  | "trip_reference"
  | "lr_no" | "docket_no" | "tracking_url" | "eway_bill_no" | "carrier_reference"
  | "handed_over_by_name" | "handed_over_employee_id" | "handed_over_aadhaar"
  | "handed_over_phone";

/** What each field is called on the pass. Short, because it is a label on a form the
 *  guard scans rather than a sentence. */
export const CARRYING_LABEL: Record<CarryingField, string> = {
  carrier_name: "Provider",
  freight_amount: "Freight",
  expected_delivery: "Expected delivery",
  vehicle_number: "Vehicle no",
  driver_name: "Driver",
  driver_phone: "Driver phone",
  driver_licence_no: "Licence no",
  trip_reference: "Trip reference",
  lr_no: "LR no",
  docket_no: "Docket no",
  tracking_url: "Tracking link",
  eway_bill_no: "E-way bill",
  carrier_reference: "Carrier reference",
  handed_over_by_name: "Handed over to",
  handed_over_employee_id: "Employee ID",
  handed_over_aadhaar: "Aadhaar",
  handed_over_phone: "Phone",
};

/** Everything, for the moment before the mode table has arrived. A pass that hides
 *  fields because a fetch has not landed is worse than one that shows too many. */
const ALL = Object.keys(CARRYING_LABEL) as CarryingField[];

/** The two numbers that pin a person down, and only ever one of them is filled: an
 *  employee by their employee id, anybody else by an Aadhaar. Whichever was NOT used
 *  is dropped rather than printed blank — a dash beside "Aadhaar" on an employee's
 *  hand-over says nothing at all. */
const IDENTITY: readonly CarryingField[] = [
  "handed_over_employee_id", "handed_over_aadhaar",
];

/** Anything the fields can be read off — the shipment itself, or the flattened link
 *  the dispatch queue already holds. Only the keys matter. */
export type CarryingSource = Partial<Record<CarryingField, unknown>>;

/** What a field READS as, formatted once so the screen and the printed sheet can
 *  never disagree about a date or an amount. Empty is null, never "" or "0". */
export function carryingValue(
  field: CarryingField, doc?: CarryingSource | null,
): string | null {
  const raw = doc?.[field];
  if (!answered(raw)) return null;
  if (field === "freight_amount") return money(Number(raw));
  if (field === "expected_delivery") return fmtDate(String(raw));
  return String(raw);
}

const answered = (value: unknown) =>
  value !== null && value !== undefined && String(value).trim() !== "";

export function carryingFields(
  rule: ModeRule | undefined | null,
  doc?: CarryingSource | null,
): CarryingField[] {
  const fields = allocated(rule);
  // Only one half of the identity pair is ever answered; drop the other once either
  // has been. Before anybody has answered, the first stands for the pair.
  const identityAnswered = IDENTITY.filter((field) => answered(doc?.[field]));
  if (identityAnswered.length === 0) {
    return fields.filter((field) => field !== "handed_over_aadhaar");
  }
  return fields.filter((field) =>
    !IDENTITY.includes(field) || identityAnswered.includes(field));
}

function allocated(rule: ModeRule | undefined | null): CarryingField[] {
  if (!rule) return ALL;
  const requires = (field: string) => rule.required_fields.includes(field);

  // An outside provider carries it: who they are, what it costs, and the two papers
  // the receiving site chases it on.
  if (rule.needs_carrier) {
    return [
      "carrier_name",
      ...(rule.needs_quotes ? ["freight_amount" as const] : []),
      "expected_delivery",
      "vehicle_number", "driver_name", "driver_phone", "driver_licence_no",
      "lr_no", "docket_no", "tracking_url", "eway_bill_no", "carrier_reference",
    ];
  }

  // One of ours drives it. No carrier, no freight and no LR — the trip it was already
  // making is the whole reason this leg costs the shipment nothing.
  if (requires("vehicle_number")) {
    return [
      "vehicle_number", "driver_name", "driver_phone",
      "handed_over_employee_id", "handed_over_aadhaar",
      "trip_reference", "expected_delivery",
    ];
  }

  // A person walks out with it. Who took custody is the entire record.
  if (requires("handed_over_by_name")) {
    return [
      "handed_over_by_name",
      "handed_over_employee_id", "handed_over_aadhaar", "handed_over_phone",
      "expected_delivery",
    ];
  }

  return ALL;
}
