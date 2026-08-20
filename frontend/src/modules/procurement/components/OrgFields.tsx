import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Field, Select } from "@/shared/components";
import { ItemCombobox } from "@/modules/indents/components/ItemCombobox";
import { api } from "@/shared/api/client";
import { useAuth } from "@/shared/auth/AuthContext";

/**
 * Department, warehouse, project and company — the four things that say who is buying,
 * for where, on whose budget and on whose paper.
 *
 * One component because two forms ask for them (a requisition and a cold RFQ) and the
 * pickers are not trivial:
 *
 *  - **Warehouse searches the server.** There are 983 of them, 948 of which are LIP
 *    points; a plain dropdown loads one page and the two MAIN warehouses — the ones a
 *    buyer actually orders into — sort last and never arrive. `ItemCombobox` sends the
 *    query to `/api/warehouses?search=`, so "central" finds them.
 *  - **Departments are deduplicated by name.** HCM has 788 rows and hundreds share a
 *    name (`104` appears dozens of times, once per office). The buyer picks a name;
 *    the first id carrying it is what gets stored.
 *  - **Company comes from Settings** and is preselected, because there is one. It is
 *    still a field rather than a caption: a document says whose paper it is on.
 */

export interface OrgValue {
  departmentId: number | "";
  warehouseId: number | "";
  projectId: number | "";
  companyName: string;
  /** The selected warehouse's name, as the source document already recorded it.
   *  Carried so the box can show what is selected before the search that would
   *  contain it has been typed — see `warehouseOptions` below. */
  warehouseName?: string;
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
  value, onChange, disabled = false,
}: {
  value: OrgValue;
  onChange: (patch: Partial<OrgValue>) => void;
  disabled?: boolean;
}) {
  const [warehouseQuery, setWarehouseQuery] = useState("");
  const company = useCompanyName();

  const { data: warehouses = [], isLoading: loadingWarehouses } = useQuery({
    queryKey: ["org-warehouses", warehouseQuery],
    queryFn: () =>
      api.get<{ items: NamedRow[] }>("/api/warehouses", {
        params: { search: warehouseQuery || undefined, size: 50, is_active: true },
      }).then((r) => r.data.items),
  });

  const { data: projects = [] } = useQuery({
    queryKey: ["org-projects"],
    queryFn: () =>
      api.get<{ items: NamedRow[] }>("/api/projects", {
        params: { size: 200, is_active: true },
      }).then((r) => r.data.items),
  });

  const { data: departments = [] } = useQuery({
    queryKey: ["org-departments"],
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
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Department" hint="Who the purchase is for.">
        <Select
          value={value.departmentId === "" ? "" : String(value.departmentId)}
          placeholder="Not stated"
          isDisabled={disabled}
          options={departments.map((d) => ({ value: String(d.id), label: d.name }))}
          onChange={(v) => onChange({ departmentId: v ? Number(v) : "" })}
        />
      </Field>

      <Field label="Warehouse" hint="Type to search all 983 stocking points.">
        <ItemCombobox
          value={value.warehouseId}
          options={warehouseOptions}
          isLoading={loadingWarehouses}
          onQueryChange={setWarehouseQuery}
          onChange={(v) => onChange({ warehouseId: v })}
          placeholder="Search warehouses…"
        />
      </Field>

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

      {/* The name comes from /me now (see useCompanyName), so a buyer sees it too.
        * Still disabled when Settings holds no company at all — there is nothing to
        * pick, and an empty dropdown that opens is worse than one that says so. */}
      <Field label="Company" hint="From Settings. One today; the field is here to say so.">
        <Select
          value={value.companyName || company}
          placeholder={company || "Not configured"}
          isDisabled={disabled || !company}
          options={company ? [{ value: company, label: company }] : []}
          onChange={(v) => onChange({ companyName: String(v) })}
        />
      </Field>
    </div>
  );
}
