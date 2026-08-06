import type { Option } from "../components/MasterCrud";
import type { UomClass } from "../types";

/** Plain values shared by the tab files.
 *
 *  They live apart from the components on purpose: a module that exports both a
 *  component and a constant cannot be Fast Refreshed, so editing any tab forced a
 *  full page reload ("CODE_RULE export is incompatible"). Constants here,
 *  components there, and HMR works again. */

/** A short item-identity code. Imported masters use segments such as GN-003. */
export const CODE_RULE = {
  maxLength: 10,
  pattern: /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/,
  patternMessage: "Use letters, numbers and internal hyphens only",
} as const;

export const RATE_RULE = { type: "number", min: 0, max: 100 } as const;

export const WAREHOUSE_TYPES: Option[] = ["MAIN", "LIP", "MDP", "TRANSIT", "QUARANTINE", "SCRAP"]
  .map((v) => ({ value: v, label: v }));

export const BIN_TYPES: Option[] = ["ZONE", "RACK", "SHELF", "STORAGE", "STAGING"]
  .map((v) => ({ value: v, label: v }));

// The live column is free text, not an enum. These are the values already in it —
// offered as a dropdown so a third spelling of "TRANSPORT" never appears.
export const VENDOR_TYPES: Option[] = [
  { value: "MATERIAL", label: "Material" },
  { value: "TRANSPORT", label: "Transport" },
  { value: "SERVICE", label: "Service" },
];

export const UOM_CLASSES: UomClass[] = ["COUNT", "LENGTH", "AREA", "VOLUME", "WEIGHT",
  "TEMPERATURE", "TIME", "PRESSURE", "ENERGY", "PACKAGING"];

export const UOM_CLASS_OPTS: Option[] = UOM_CLASSES.map((v) => ({
  value: v, label: v.charAt(0) + v.slice(1).toLowerCase(),
}));

export const DATA_TYPES: Option[] = ["TEXT", "NUMBER", "BOOLEAN", "DATE", "LIST"]
  .map((v) => ({ value: v, label: v }));
