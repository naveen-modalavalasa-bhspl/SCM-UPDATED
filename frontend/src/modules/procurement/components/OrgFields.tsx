import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Field, Select } from "@/shared/components";
import { ItemCombobox } from "@/modules/indents/components/ItemCombobox";
import { api } from "@/shared/api/client";
import { useAuth } from "@/shared/auth/AuthContext";

/**
 * Where a purchase is delivered, and on a document older than organisations what it
 * always asked. Organisation, project, department and year sit on the shared
 * `DocumentNumberCard` at the top of the form; `OrgValue` holds both, so a form keeps one
 * state and one payload.
 *
 * One component because three forms ask (a requisition, a material-request consolidation
 * and an RFQ) and the pickers are not trivial:
 *
 *  - **Shipment Address searches the server, and only for warehouses.** The master
 *    holds 983 stocking points, 948 of them LIP field points; a plain dropdown loads
 *    one page and the two MAIN warehouses — the ones a buyer actually orders into —
 *    sort last and never arrive. `ItemCombobox` sends the query to
 *    `/api/warehouses?search=`, and `kind=SHIPMENT_ADDRESS` drops the field points
 *    entirely, because no purchase is ever delivered to one.
 *  - **An older document keeps what it always had** (`legacy`): HCM's departments, by
 *    name, and the company from Settings. It is not asked for anything new.
 */

export interface OrgValue {
  organizationId: number | "";
  orgDepartmentId: number | "";
  departmentId: number | "";
  warehouseId: number | "";
  projectId: number | "";
  companyName: string;
  fiscalYear: string;
  organizationName?: string;
  projectName?: string;
  departmentName?: string;
  /** The selected warehouse's name, as the source document already recorded it.
   *  Carried so the box can show what is selected before the search that would
   *  contain it has been typed — see `warehouseOptions` below. */
  warehouseName?: string;
}

export const emptyOrgValue = (): OrgValue => ({
  organizationId: "", orgDepartmentId: "", departmentId: "", warehouseId: "", projectId: "",
  companyName: "", fiscalYear: "",
});

/** A saved document's fields, in the shape the form edits. */
export const orgValueFrom = (doc: {
  organization_id?: number | null; org_department_id?: number | null;
  department_id?: number | null; warehouse_id?: number | null;
  warehouse_name?: string | null; project_id?: number | null; company_name?: string | null;
  organization_name?: string | null; project_name?: string | null;
  org_department_name?: string | null; fiscal_year?: string | null;
}): OrgValue => ({
  organizationId: doc.organization_id ?? "",
  orgDepartmentId: doc.org_department_id ?? "",
  departmentId: doc.department_id ?? "",
  warehouseId: doc.warehouse_id ?? "",
  warehouseName: doc.warehouse_name ?? "",
  projectId: doc.project_id ?? "",
  companyName: doc.company_name ?? "",
  fiscalYear: doc.fiscal_year ?? "",
  organizationName: doc.organization_name ?? "",
  projectName: doc.project_name ?? "",
  departmentName: doc.org_department_name ?? "",
});

/** The same values on a NEW document raised from `doc`: a year is never inherited, it
 *  belongs to the day the new document is raised. */
export const orgValueCarried: typeof orgValueFrom = (doc) => ({
  ...orgValueFrom(doc), fiscalYear: "",
});

/** What goes on the wire. An older document sends its old fields and nothing new. */
export const orgPayload = (value: OrgValue, legacy = false) => ({
  warehouse_id: value.warehouseId === "" ? null : value.warehouseId,
  project_id: value.projectId === "" ? null : value.projectId,
  ...(legacy
    ? {
      department_id: value.departmentId === "" ? null : value.departmentId,
      company_name: value.companyName || null,
    }
    : {
      organization_id: value.organizationId === "" ? null : value.organizationId,
      org_department_id: value.orgDepartmentId === "" ? null : value.orgDepartmentId,
      fiscal_year: value.fiscalYear || null,
    }),
});

/** The sentence to show when the selection cannot be saved, or null. The server refuses
 *  the same. `carriedProject`: a project the source supplies, for a form with none. */
export function orgMissing(value: OrgValue, carriedProject = false): string | null {
  if (value.organizationId === "") return "Select the organisation this document belongs to.";
  if (value.projectId === "" && value.orgDepartmentId === "" && !carriedProject) {
    return "Select the project or the department this document is for.";
  }
  return null;
}

interface NamedRow { id: number; code?: string | null; name: string }

export function useCompanyName() {
  // FIXED 2026-08-20 — this used to fetch /api/settings, which is gated on
  // `admin.settings.manage`: the permission to EDIT the settings screen. A buyer
  // opening an RFQ, PO or requisition form got a 403 for one string, the catch
  // swallowed it, and the Company field rendered "Not configured" and disabled
  // itself — indistinguishable from the setting never having been saved.
  //
  // WITHOUT this the field can only ever be filled by an administrator, on forms
  // administrators do not raise. /me carries the name for every login and costs no
  // request of its own.
  const { me } = useAuth();
  return me?.company_name ?? "";
}

export function OrgFields({
  value, onChange, disabled = false, legacy = false,
}: {
  value: OrgValue;
  onChange: (patch: Partial<OrgValue>) => void;
  disabled?: boolean;
  /** Raised before organisations: the old fields, and nothing new is asked. */
  legacy?: boolean;
}) {
  const [warehouseQuery, setWarehouseQuery] = useState("");
  const company = useCompanyName();

  // `kind=SHIPMENT_ADDRESS` narrows 983 stocking points to the warehouses a purchase
  // can actually be delivered to — the server decides which types those are, this
  // screen only says what it is asking for. The same rule is enforced again on save,
  // because a narrowed dropdown is a courtesy and a hand-made POST never sees it.
  const { data: warehouses = [], isLoading: loadingWarehouses } = useQuery({
    queryKey: ["org-warehouses", warehouseQuery],
    queryFn: () =>
      api.get<{ items: NamedRow[] }>("/api/warehouses", {
        params: {
          search: warehouseQuery || undefined, size: 50, is_active: true,
          kind: "SHIPMENT_ADDRESS",
        },
      }).then((r) => r.data.items),
  });

  const { data: projects = [] } = useQuery({
    queryKey: ["org-projects"],
    enabled: legacy,
    queryFn: () =>
      api.get<{ items: NamedRow[] }>("/api/projects", {
        params: { size: 200, is_active: true },
      }).then((r) => r.data.items),
  });

  // Departments are deduplicated by name: HCM has 2,118 rows and hundreds share one.
  const { data: hcmDepartments = [] } = useQuery({
    queryKey: ["org-departments"],
    enabled: legacy,
    queryFn: () =>
      api.get<{ items: NamedRow[] }>("/api/departments").then((r) => {
        const seen = new Map<string, NamedRow>();
        for (const row of r.data.items) if (!seen.has(row.name)) seen.set(row.name, row);
        return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
      }),
  });

  // The selected warehouse may not be in the current search result — keep its option
  // present or the box would blank itself the moment the query changes.
  //
  // That is also why a warehouse carried from a requisition looked like it had not
  // arrived: there are 983 stocking points, the first page of 50 rarely holds the one
  // the document names, and a Select with a value that matches no option renders the
  // placeholder. The value was there and saved correctly all along — the box just had
  // nothing to draw. The document's own snapshot fills that in.
  const selected = warehouses.find((w) => w.id === value.warehouseId);
  const warehouseOptions = [
    ...(value.warehouseId !== "" && !selected
      ? [{ value: value.warehouseId, label: value.warehouseName || "Selected warehouse" }]
      : []),
    ...warehouses.map((w) => ({
      value: w.id, label: w.code ? `${w.code} — ${w.name}` : w.name,
    })),
  ];

  return (
    <div className="space-y-3">
      <div className={`grid grid-cols-1 gap-4 ${legacy ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-2"}`}>
        {legacy && (
          <Field label="Department" hint="Who the purchase is for.">
            <Select
              value={value.departmentId === "" ? "" : String(value.departmentId)}
              placeholder="Not stated"
              isDisabled={disabled}
              options={hcmDepartments.map((d) => ({ value: String(d.id), label: d.name }))}
              onChange={(v) => onChange({ departmentId: v ? Number(v) : "" })}
            />
          </Field>
        )}

        {/* "Shipment Address", not "Warehouse" (2026-09-07). The field names where the
            goods are to be delivered, which is what a buyer and a vendor both call it;
            "Warehouse" described the record it points at rather than the job it does on
            the document. The LABEL is all that changed — `warehouseId` on the wire and
            `warehouse_id` in the database are untouched, so nothing already reading
            either has to know. */}
        <Field label="Shipment Address" hint="Warehouses only — not LIP or MDP field points.">
          <ItemCombobox
            value={value.warehouseId}
            options={warehouseOptions}
            isLoading={loadingWarehouses}
            onQueryChange={setWarehouseQuery}
            onChange={(v) => onChange({ warehouseId: v })}
            placeholder="Search shipment addresses…"
          />
        </Field>

        {legacy && (
          <Field label="Project" hint="What the spend is booked against.">
            <Select
              value={value.projectId === "" ? "" : String(value.projectId)}
              placeholder="Not stated"
              isDisabled={disabled}
              options={projects.map((p) => ({
                value: String(p.id), label: p.code ? `${p.code} — ${p.name}` : p.name,
              }))}
              onChange={(v) => onChange({ projectId: v ? Number(v) : "" })}
            />
          </Field>
        )}

        {legacy && (
          <Field label="Company" hint="From Settings. One today; the field is here to say so.">
            <Select
              value={value.companyName || company}
              placeholder={company || "Not configured"}
              isDisabled={disabled || !company}
              options={company ? [{ value: company, label: company }] : []}
              onChange={(v) => onChange({ companyName: String(v) })}
            />
          </Field>
        )}
      </div>
    </div>
  );
}
