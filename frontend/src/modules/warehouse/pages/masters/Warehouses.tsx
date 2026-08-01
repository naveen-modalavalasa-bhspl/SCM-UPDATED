import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Chip } from "@heroui/react";
import { Plus } from "lucide-react";
import {
  Button, Can, PageHeader, ResponsiveList, StatusPill, type Column,
} from "@/shared/components";
import { ErrorBanner } from "../../components/compat";
import { FilterBar, FilterSelect } from "../../components/FilterBar";
import { listWarehouses } from "../../api";
import type { Warehouse } from "../../types";

/**
 * The warehouse master.
 *
 * `is_bin_managed` gets a column of its own because it changes how every downstream
 * screen behaves: a bulk warehouse keeps `bin_id` at 0, so putaway and picking show
 * no bin at all there. Storekeepers were opening the bin tree on a bulk site and
 * finding nothing, so the list says which kind each site is up front.
 */

const TYPES = [
  { value: "MAIN", label: "Main" },
  { value: "TRANSIT", label: "Transit" },
  { value: "QUARANTINE", label: "Quarantine" },
  { value: "SCRAP", label: "Scrap" },
  { value: "COLD", label: "Cold storage" },
];

export default function Warehouses() {
  const nav = useNavigate();
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [active, setActive] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["wh-warehouses"],
    queryFn: () => listWarehouses({ size: 200 }),
  });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.items ?? []).filter((w) => {
      if (type && w.warehouse_type !== type) return false;
      if (active && String(w.is_active) !== active) return false;
      if (!q) return true;
      return (
        w.code.toLowerCase().includes(q) ||
        w.name.toLowerCase().includes(q) ||
        (w.facility_name ?? "").toLowerCase().includes(q) ||
        (w.incharge_name ?? "").toLowerCase().includes(q)
      );
    });
  }, [data, search, type, active]);

  const columns: Column<Warehouse>[] = [
    {
      key: "code",
      header: "Warehouse",
      render: (w) => (
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-ink">{w.code}</div>
          <div className="truncate text-sm text-body">{w.name}</div>
        </div>
      ),
    },
    {
      key: "facility",
      header: "Facility",
      hideOnNarrow: true,
      render: (w) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-ink">{w.facility_name ?? "—"}</div>
          <div className="truncate text-[11px] text-muted">{w.office_name ?? "—"}</div>
        </div>
      ),
    },
    {
      key: "type",
      header: "Type",
      render: (w) => <Chip size="sm" variant="flat">{w.warehouse_type}</Chip>,
    },
    {
      key: "bins",
      header: "Storage",
      render: (w) => (
        <Chip size="sm" variant="flat" color={w.is_bin_managed ? "primary" : "default"}>
          {w.is_bin_managed ? "Bin managed" : "Bulk"}
        </Chip>
      ),
    },
    {
      key: "incharge",
      header: "In charge",
      hideOnNarrow: true,
      render: (w) => <span className="text-sm text-ink">{w.incharge_name ?? "—"}</span>,
    },
    {
      key: "status",
      header: "Status",
      render: (w) => <StatusPill status={w.is_active ? "APPROVED" : "CLOSED"} />,
    },
  ];

  // `master.location.manage` is the existing "manage warehouses & bins" code — the
  // module gates on that rather than inventing a permission code of its own.
  return (
    <div>
      <PageHeader
        eyebrow="Warehouse"
        title="Warehouses"
        actions={
          <Can do="master.location.manage">
            <Button onClick={() => nav("new")}>
              <Plus className="h-4 w-4" /> New warehouse
            </Button>
          </Can>
        }
      />

      <FilterBar
        search={search}
        onSearch={setSearch}
        placeholder="Search code, name, facility or in-charge…"
        onReset={() => {
          setSearch("");
          setType("");
          setActive("");
        }}
      >
        <FilterSelect label="Type" value={type} onChange={setType} options={TYPES} />
        <FilterSelect
          label="Status"
          value={active}
          onChange={setActive}
          options={[
            { value: "true", label: "Active" },
            { value: "false", label: "Inactive" },
          ]}
        />
      </FilterBar>

      <ErrorBanner error={error} />

      <ResponsiveList
        data={rows}
        columns={columns}
        keyOf={(w) => w.id}
        loading={isLoading}
        onRowClick={(w) => nav(String(w.id))}
        empty="No warehouses match these filters."
        renderCard={(w) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs font-semibold text-ink">{w.code}</span>
              <StatusPill status={w.is_active ? "APPROVED" : "CLOSED"} />
            </div>
            <div className="truncate text-sm font-medium text-body">{w.name}</div>
            <div className="truncate text-[11px] text-muted">
              {w.facility_name ?? "—"} · {w.is_bin_managed ? "Bin managed" : "Bulk"}
            </div>
          </div>
        )}
      />
    </div>
  );
}
