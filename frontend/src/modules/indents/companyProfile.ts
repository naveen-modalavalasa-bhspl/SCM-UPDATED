/**
 * The letterhead moved to `shared/components/companyProfile.ts` when the printed
 * indent's design became the design every printed document uses: the purchase order,
 * the gate pass and the warehouse notes are on the same company's paper, and a second
 * copy of the particulars is a second company.
 *
 * Re-exported from here so `api.ts` and anything else inside the module keeps its
 * import. Nothing new should import it through this file.
 */
export {
  COMPANY_FALLBACK,
  resolveCompany,
  type CompanyProfile,
} from "@/shared/components/companyProfile";
