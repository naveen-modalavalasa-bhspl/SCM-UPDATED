/** WHO took custody of a hand-over — the four boxes, and the one rule behind them.
 *
 * A direct hand-over has no LR and no docket. Nobody issues a lorry receipt for a
 * storekeeper walking a carton out to the requester, so this block IS the leg's
 * tracking handle: it is the entire record of where the goods went and who to ring
 * about them. That makes it the one thing the "It has left" press must be able to
 * correct, because the person who actually collects on the day is frequently not the
 * one named when the leg was booked.
 *
 * Written once here rather than twice — the booking form asks these questions and so
 * does the dispatch dialog, and two copies of "which number identifies this person"
 * is two screens that disagree the first time one is changed.
 */
import { Field, Input, Select } from "@/shared/components";
import { PHONE_HINT, phoneError, sanitizePhone } from "./validate";

/** Who is carrying it. One of ours or somebody else — the only thing that changes is
 *  which number identifies them, because an outsider has no employee id. */
export const HANDOVER_PERSONS = [
  { value: "EMPLOYEE", label: "Employee" },
  { value: "OTHERS", label: "Others" },
];

export type PersonKind = "EMPLOYEE" | "OTHERS";

/** The four boxes, as a form holds them: strings, never null, so an input is never
 *  uncontrolled. `custodyOf` is what turns a saved shipment into one of these. */
export type CustodyValue = {
  handed_over_by_name: string;
  handed_over_employee_id: string;
  handed_over_aadhaar: string;
  handed_over_phone: string;
};

/** Twelve digits, never starting 0 or 1 — UIDAI issues neither. Here rather than in
 *  `validate.ts` because this is the only block an Aadhaar is ever typed into. */
export const aadhaarError = (value: string | null | undefined): string | null => {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length !== 12) return "Aadhaar must be 12 digits";
  if (/^[01]/.test(digits)) return "Aadhaar does not start with 0 or 1";
  return null;
};

/** Which kind of person a SAVED shipment recorded. Read off the Aadhaar rather than
 *  stored as its own column: the two id boxes are exclusive, so whichever was filled
 *  is itself the answer to which question was asked. */
export const personKindOf = (
  doc: { handed_over_aadhaar?: string | null } | null | undefined,
): PersonKind => (doc?.handed_over_aadhaar ? "OTHERS" : "EMPLOYEE");

/** What the shipment carries, as this form holds it. */
export const custodyOf = (doc: Partial<Record<keyof CustodyValue, string | null>>
  | null | undefined): CustodyValue => ({
  handed_over_by_name: doc?.handed_over_by_name ?? "",
  handed_over_employee_id: doc?.handed_over_employee_id ?? "",
  handed_over_aadhaar: doc?.handed_over_aadhaar ?? "",
  handed_over_phone: doc?.handed_over_phone ?? "",
});

/** Everything standing between this block and a press, in the order a reader meets
 *  it. The same rule `_check_custody` enforces on the service — read forward, so the
 *  desk is told which box is wrong before the round trip rather than after it. */
export function custodyProblems(person: PersonKind,
                                value: CustodyValue): string[] {
  const gaps: string[] = [];
  if (!value.handed_over_by_name.trim()) gaps.push("Name who hands it over");
  if (person === "EMPLOYEE") {
    if (!value.handed_over_employee_id.trim()) gaps.push("Record their employee ID");
  } else if (!value.handed_over_aadhaar.trim()) {
    gaps.push("Record their Aadhaar number");
  }
  if (!value.handed_over_phone.trim()) gaps.push("Record a phone number");
  const bad = [aadhaarError(person === "OTHERS" ? value.handed_over_aadhaar : ""),
               phoneError(value.handed_over_phone, "Phone")];
  return [...gaps, ...bad.filter((e): e is string => Boolean(e))];
}

export function HandoverCustody({
  person, onPerson, value, onChange,
}: {
  person: PersonKind;
  onPerson: (person: PersonKind) => void;
  value: CustodyValue;
  onChange: (value: CustodyValue) => void;
}) {
  const set = (patch: Partial<CustodyValue>) => onChange({ ...value, ...patch });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {/* Asked FIRST: which number identifies this person is decided before it can be
          typed, and the box it decides sits beside it — a row apart, the Aadhaar
          looks like it belongs to whatever is above it. */}
      <Field label="Person" required>
        <Select
          value={person}
          onChange={(next) => {
            if (!next) return;
            onPerson(next as PersonKind);
            // The id boxes are exclusive: keeping the one that is no longer asked for
            // is how an Aadhaar ends up filed against an employee.
            set({ handed_over_employee_id: "", handed_over_aadhaar: "" });
          }}
          options={HANDOVER_PERSONS}
          ariaLabel="Who hands it over"
        />
      </Field>

      <Field label="Handed over by" required>
        <Input value={value.handed_over_by_name}
          onChange={(e) => set({ handed_over_by_name: e.target.value })} />
      </Field>

      {/* An outsider has no employee id, and an employee's Aadhaar is not ours to
          hold when HCM already knows who they are. */}
      {person === "EMPLOYEE" ? (
        <Field label="Employee ID" required>
          <Input value={value.handed_over_employee_id}
            onChange={(e) => set({ handed_over_employee_id: e.target.value })} />
        </Field>
      ) : (
        <Field label="Aadhaar number" required
          hint={aadhaarError(value.handed_over_aadhaar) ?? "12 digits"}>
          <Input value={value.handed_over_aadhaar} inputMode="numeric" maxLength={12}
            onChange={(e) => set({
              handed_over_aadhaar: e.target.value.replace(/\D/g, "").slice(0, 12),
            })} />
        </Field>
      )}

      <Field label="Phone number" required
        hint={phoneError(value.handed_over_phone, "Phone") ?? PHONE_HINT}>
        <Input value={value.handed_over_phone} inputMode="numeric" maxLength={18}
          onChange={(e) => set({
            handed_over_phone: sanitizePhone(e.target.value),
          })} />
      </Field>
    </div>
  );
}
