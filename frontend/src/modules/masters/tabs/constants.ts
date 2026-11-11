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

// Mirrors WarehouseType in backend/app/shared/enums.py — the backend rejects
// anything not in that enum, so a value offered here and missing there is a save
// that fails after the user has filled the form.
export const WAREHOUSE_TYPES: Option[] = [
  "MAIN", "CENTRAL", "REGIONAL", "LIP", "MDP", "TRANSIT", "QUARANTINE", "SCRAP",
].map((v) => ({ value: v, label: v }));

export const BIN_TYPES: Option[] = ["ZONE", "RACK", "SHELF", "STORAGE", "STAGING"]
  .map((v) => ({ value: v, label: v }));

// The live column is free text, not an enum. These are the values already in it —
// offered as a dropdown so a third spelling of "TRANSPORT" never appears.
// TRANSPORT, LOGISTICS and COURIER are the three the Dispatch dropdown filters on
// (`logistics/enums.py` CARRIER_VENDOR_TYPES). Offering only one of them here meant a
// vendor typed in as a logistics aggregator never reached the dropdown, and nothing
// on this form said why. Those three are better set on Settings › Logistics Vendors,
// which mints the portal login in the same press; they stay listed so an existing row
// can be corrected without leaving Masters.
export const VENDOR_TYPES: Option[] = [
  { value: "MATERIAL", label: "Material" },
  { value: "TRANSPORT", label: "Transport / freight" },
  { value: "LOGISTICS", label: "Logistics aggregator" },
  { value: "COURIER", label: "Courier / parcel" },
  { value: "SERVICE", label: "Service" },
];

export const UOM_CLASSES: UomClass[] = ["COUNT", "LENGTH", "AREA", "VOLUME", "WEIGHT",
  "TEMPERATURE", "TIME", "PRESSURE", "ENERGY", "PACKAGING"];

export const UOM_CLASS_OPTS: Option[] = UOM_CLASSES.map((v) => ({
  value: v, label: v.charAt(0) + v.slice(1).toLowerCase(),
}));

export const DATA_TYPES: Option[] = ["TEXT", "NUMBER", "BOOLEAN", "DATE", "LIST"]
  .map((v) => ({ value: v, label: v }));

/** Masters whose code is exactly three letters (ERB for Erba), keyed by the tab's
 *  queryKey, valued by the API path that suggests one from a name. A row saved
 *  before the rule keeps its old code; only a new or changed code must fit. */
export const SHORT_CODE_PATHS: Record<string, string> = {
  categories: "/api/item-categories", "general-names": "/api/general-names",
  brands: "/api/brands", manufacturers: "/api/manufacturers",
  "item-classes": "/api/item-classes", "item-subclasses": "/api/item-sub-classes",
  "dosage-forms": "/api/dosage-forms", attributes: "/api/attributes",
  specs: "/api/specs", features: "/api/features", packaging: "/api/packaging",
  uom: "/api/uom", boms: "/api/boms",
  "vendor-categories": "/api/vendor-categories",
};
