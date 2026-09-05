/**
 * The letterhead a printed indent carries.
 *
 * Two sources, in this order: whatever an admin has written on Settings > Company
 * (served by `GET /api/settings/company` to any signed-in user, because a printed
 * document's header is not an admin secret), and — for any field left blank there —
 * the registered particulars below.
 *
 * The fallbacks are the company's public MCA/GST record, not invented copy: a
 * printed indent leaves the building and an incomplete settings row must not put a
 * blank letterhead on it. `cin` has no home in `CompanySettings` on the backend, so
 * it is a constant here only; if the letterhead ever needs to differ per project,
 * it belongs in sys_settings, not in this file.
 */
export interface CompanyProfile {
  name: string;
  legal_name: string;
  gstin: string;
  cin: string;
  address: string;
  phone: string;
  email: string;
}

export const COMPANY_FALLBACK: CompanyProfile = {
  name: "Bavya Health Services",
  legal_name: "Bavya Health Services Private Limited",
  gstin: "37AADCB5486B1ZR",
  cin: "U85120AP2008PTC058143",
  // The operating address the business gave us, not the MCA registered-office one —
  // this is what the company puts on paper.
  address:
    "59A-21/7-10, 1st Floor, Ramdev Apartments, Panta Kaluva Rd, "
    + "Patamata, Vijayawada, Andhra Pradesh 520007",
  phone: "",
  email: "",
};

/** Settings wins field by field; an empty string there means "not configured". */
export function resolveCompany(settings?: Partial<CompanyProfile> | null): CompanyProfile {
  const pick = (key: keyof CompanyProfile) =>
    (settings?.[key] ?? "").toString().trim() || COMPANY_FALLBACK[key];
  return {
    name: pick("name"),
    legal_name: pick("legal_name"),
    gstin: pick("gstin"),
    cin: pick("cin"),
    address: pick("address"),
    phone: pick("phone"),
    email: pick("email"),
  };
}
