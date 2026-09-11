import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Chip } from "@heroui/react";
import { Boxes, Layers, Plus, Warehouse as WarehouseIcon } from "lucide-react";
import {
  Button, Can, KpiTiles, PageHeader, ResponsiveList, StatusPill, type Column,
} from "@/shared/components";
import { ErrorBanner } from "@/shared/components";
import { FilterBar, FilterSelect } from "../../components/FilterBar";
import { listWarehouses } from "../../api";
import { usePointLabel } from "../../usePointLabel";
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
  const label = usePointLabel();
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [active, setActive] = useState("");

  // Searched on the SERVER. The page asked for 200 warehouses and then filtered them
  // in the browser, but the network holds ~1,000 — so anything past the 200th by code
  // simply did not exist as far as this screen was concerned, and searching for it
  // returned "no warehouses match" rather than the row sitting in the table.
  const [applied, setApplied] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setApplied(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["wh-warehouses", applied],
    queryFn: () => listWarehouses({ size: 200, ...(applied ? { search: applied } : {}) }),
    placeholderData: (previous) => previous,
  });

  // Type and status still narrow in the browser: they are a handful of values over a
  // set the server has already cut down, so a round trip would buy nothing.
  const rows = useMemo(() => (data?.items ?? []).filter((w) => {
    if (type && w.warehouse_type !== type) return false;
    if (active && String(w.is_active) !== active) return false;
    return true;
  }), [data, type, active]);

  // The strip counts what the SERVER returned for this search, not the whole network:
  // the page asks for 200 rows and there are around a thousand sites. Labelled "on this
  // page" for that reason — a tile that quietly means something narrower than it says
  // is worse than no tile.
  const loaded = data?.items ?? [];
  const tiles = [
    {
      key: "all",
      label: "On this page",
      icon: WarehouseIcon,
      tone: "brand" as const,
      value: isLoading ? undefined : loaded.length,
      hint: data?.total ? `of ${data.total} in the network` : undefined,
    },
    {
      key: "binned",
      label: "Bin managed",
      icon: Layers,
      tone: "info" as const,
      value: isLoading ? undefined : loaded.filter((w) => w.is_bin_managed).length,
      hint: "Stock is counted per location",
    },
    {
      key: "bulk",
      label: "Bulk",
      icon: Boxes,
      tone: "neutral" as const,
      value: isLoading ? undefined : loaded.filter((w) => !w.is_bin_managed).length,
      hint: "No location tree",
    },
    {
      key: "inactive",
      label: "Inactive",
      icon: WarehouseIcon,
      tone: "warn" as const,
      value: isLoading ? undefined : loaded.filter((w) => !w.is_active).length,
      onPress: () => setActive(active === "false" ? "" : "false"),
      active: active === "false",
    },
  ];

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
        eyebrow={label}
        title="Warehouses"
        actions={
          <Can do="master.location.manage">
            <Button onClick={() => nav("new")}>
              <Plus className="h-4 w-4" /> New warehouse
            </Button>
          </Can>
        }
      />

      <KpiTiles label="Warehouse totals" tiles={tiles} className="mb-4" />

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
