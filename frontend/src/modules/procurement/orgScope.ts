/** Whose paper a procurement document is on: copied from the document before it, or
 *  selected on this one, so a number raised from now on never reads NA. The rule itself
 *  lives in `procurement/org_scope.py`; these only decide what a form shows. */

import { api } from "@/shared/api/client";

export interface OrgScope {
  organization_id?: number | null;
  organization_code?: string | null;
  organization_name?: string | null;
  org_department_id?: number | null;
  org_department_name?: string | null;
  fiscal_year?: string | null;
}

export interface OrgDirectoryRow {
  id: number;
  code?: string | null;
  name: string;
  is_active: boolean;
  synced_at?: string | null;
}

const list = (url: string) =>
  api.get<{ items: OrgDirectoryRow[] }>(url).then((r) => r.data.items);

export const fetchOrganisations = () => list("/api/organisations");
export const fetchOrgDepartments = () => list("/api/org-departments");

/** Auto-raised requisitions wait under this until the buyer selects the organisation. */
export const isHoldingNumber = (number?: string | null) =>
  Boolean(number?.startsWith("DRAFT-"));

/** Raised before organisations: keeps the fields and the number it always had. */
export const isOlderDocument = (
  doc: { organization_id?: number | null } | null | undefined,
  number?: string | null,
) => Boolean(doc) && !doc?.organization_id && !isHoldingNumber(number);

/** A department from either source, for reading: the older HCM one only on older rows. */
export const departmentOf = (doc: {
  org_department_name?: string | null; department_name?: string | null;
}) => doc.org_department_name ?? doc.department_name ?? null;

export const orgLabel = (row: { code?: string | null; name: string }) =>
  (row.code ? `${row.code} — ${row.name}` : row.name);
