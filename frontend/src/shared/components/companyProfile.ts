/**
 * The letterhead every printed document carries.
 *
 * Two sources, in this order: whatever an admin has written on Settings > Company
 * (served by `GET /api/settings/company` to any signed-in user, because a printed
 * document's header is not an admin secret), and — for any field left blank there —
 * the registered particulars below.
 *
 * The fallbacks are the company's public MCA/GST record, not invented copy: a
 * printed document leaves the building and an incomplete settings row must not put a
 * blank letterhead on it. `cin` has no home in `CompanySettings` on the backend, so
 * it is a constant here only; if the letterhead ever needs to differ per project,
 * it belongs in sys_settings, not in this file.
 *
 * This lives in `shared/` rather than in `modules/indents/` because the indent is not
 * the only document that leaves the building — the purchase order a vendor reads, the
 * gate pass a guard checks and every warehouse note are all on the same paper, and a
 * second copy of the letterhead is a second company.
 *
 * **Read it from `/api/settings/company`, never from `/api/settings`.** The latter is
 * gated on `admin.settings.manage`, so a storekeeper printing a GRN got a 403, the
 * `.catch` swallowed it and the note went out with no legal name, no address and no
 * GSTIN on it — silently, and only for the accounts that actually do the printing.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/shared/api/client";

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

export const companyProfileKey = ["print", "company-letterhead"] as const;

/**
 * The letterhead, for a print sheet that has not been handed one.
 *
 * A failure is not fatal — the registered particulars stand — but the sheet still has
 * to WAIT for the answer before the print dialog opens, or the paper goes out under a
 * header that arrived one paint too late. `isPending` is what the sheet gates on.
 */
export function useCompanyProfile(enabled = true) {
  const query = useQuery({
    queryKey: companyProfileKey,
    queryFn: ({ signal }) =>
      api.get<Partial<CompanyProfile>>("/api/settings/company", { signal })
        .then((r) => r.data ?? {})
        .catch(() => ({} as Partial<CompanyProfile>)),
    enabled,
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
  return { company: resolveCompany(query.data), settled: !enabled || !query.isLoading };
}
