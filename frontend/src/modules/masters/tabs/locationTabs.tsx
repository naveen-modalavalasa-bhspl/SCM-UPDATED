import { mastersApi } from "../api";
import { MasterCrud } from "../components/MasterCrud";
import type { Option } from "../components/MasterCrud";
import type { MasterWarehouse, Project } from "../types";
import type { Column } from "@/shared/components";
import { Active, Code, ReadOnlyTab } from "./common";
import { WAREHOUSE_TYPES } from "./constants";



export function WarehousesTab({ facilities }: { facilities: Option[] }) {
  const columns: Column<MasterWarehouse>[] = [
    { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
    { key: "name", header: "Name", render: (r) => r.name },
    { key: "type", header: "Type", render: (r) => r.warehouse_type, hideOnNarrow: true },
    { key: "facility", header: "Facility", render: (r) => r.facility_name ?? "—", hideOnNarrow: true },
    { key: "bins", header: "Bins", hideOnNarrow: true,
      render: (r) => r.is_bin_managed ? "Bin-managed" : "Bulk" },
    { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
  ];
  return (
    <MasterCrud<MasterWarehouse>
      title="Warehouse" queryKey="warehouses" searchable managePerm="master.location.manage"
      columns={columns}
      renderCard={(r) => (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Code>{r.code}</Code><Active on={r.is_active} />
          </div>
          <div className="text-sm text-body">{r.name}</div>
          <div className="text-xs text-muted">
            {r.warehouse_type} · {r.is_bin_managed ? "Bin-managed" : "Bulk"}
          </div>
        </div>
      )}
      fetchList={(search) => mastersApi.warehouses.list({ search, size: 100 }).then((p) => p.items)}
      fields={[
        { key: "code", label: "Code", required: true, maxLength: 50,
          pattern: /^[A-Za-z0-9-]+$/,
          patternMessage: "Use letters, numbers or a hyphen" },
        { key: "name", label: "Name", required: true, maxLength: 200 },
        {
          key: "warehouse_type",
          label: "Type",
          type: "select",
          options: WAREHOUSE_TYPES,
          onChange: (v) => {
            if (v === "MAIN") {
              return { is_bin_managed: true };
            }
          },
        },
        { key: "facility_id", label: "Facility", type: "select", options: facilities },
        { key: "address", label: "Address" },
        {
          key: "is_bin_managed",
          label: "Bin managed",
          type: "switch",
          hint: "Main store warehouses are automatically bin managed.",
        },
        { key: "is_active", label: "Active", type: "switch" },
      ]}
      // A new warehouse starts as MAIN, and a main store keeps storage locations by
      // default — the same rule as Warehouse > Masters (`WarehouseForm`).
      emptyForm={{ code: "", name: "", warehouse_type: "MAIN", facility_id: null,
                   address: "", is_bin_managed: true, is_active: true }}
      toForm={(r) => ({ code: r.code, name: r.name, warehouse_type: r.warehouse_type,
        facility_id: r.facility_id ?? null, address: r.address ?? "",
        is_bin_managed: r.warehouse_type === "MAIN" ? true : r.is_bin_managed,
        is_active: r.is_active })}
      bulk={mastersApi.warehouses} usage={mastersApi.warehouses.usage}
      onCreate={(v) => mastersApi.warehouses.create({
        ...v,
        is_bin_managed: v.warehouse_type === "MAIN" ? true : Boolean(v.is_bin_managed),
      } as Partial<MasterWarehouse>)}
      onUpdate={(id, v) => mastersApi.warehouses.update(id, {
        ...v,
        is_bin_managed: v.warehouse_type === "MAIN" ? true : Boolean(v.is_bin_managed),
      } as Partial<MasterWarehouse>)}
      onDeactivate={mastersApi.warehouses.deactivate}
    />
  );
}

/** HCM owns projects and its sync writes them, so there is nothing to edit here.
 *  The backend registers no write routes either — hiding the button is not the
 *  control (rule 6), the missing endpoint is. */

/** HCM owns projects and its sync writes them, so there is nothing to edit here.
 *  The backend registers no write routes either — hiding the button is not the
 *  control (rule 6), the missing endpoint is. */
export function ProjectsTab() {
  return (
    <>
      <div className="mb-3 rounded-xl bg-content2 px-4 py-3 text-sm text-muted">
        Projects come from <strong className="text-body">HCM</strong> and refresh on
        each sync. To add or change one, do it in HCM.
      </div>
      <ReadOnlyTab<Project>
        title="Projects"
        fetchList={() => mastersApi.projects.list({ size: 300 }).then((p) => p.items)}
        columns={[
          { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
          { key: "name", header: "Name", render: (r) => r.name },
          { key: "office", header: "Office", hideOnNarrow: true,
            render: (r) => r.office_name ?? "—" },
          { key: "dates", header: "Dates", hideOnNarrow: true,
            render: (r) => `${r.start_date ?? "—"} → ${r.end_date ?? "—"}` },
          { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
        ]}
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Code>{r.code}</Code><Active on={r.is_active} />
            </div>
            <div className="text-sm text-body">{r.name}</div>
          </div>
        )}
      />
    </>
  );
}

// The live column is free text, not an enum. These are the values already in it —
// offered as a dropdown so a third spelling of "TRANSPORT" never appears.
