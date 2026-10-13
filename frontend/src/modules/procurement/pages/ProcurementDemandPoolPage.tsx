import { useState, useMemo, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Download, ChevronDown, FileSpreadsheet, FileText, Layers, Building2 } from "lucide-react";
import { PageHeader, Card, ErrorBanner, FilterBar, FilterMenu, FilterDateRange, useToast } from "@/shared/components";
import { exportToCSV } from "@/shared/exportUtils";
import { procurementDemandPoolApi, procurementDemandPoolKeys } from "../api";
import type {
  DemandPoolGroup,
  DemandPoolSource,
  DemandPoolStage,
} from "../types";

const STAGE_TONE: Record<string, { bg: string; text: string; border: string }> = {
  neutral: { bg: "#f1f5f9", text: "#475569", border: "#cbd5e1" },
  warning: { bg: "#fef3c7", text: "#92400e", border: "#fde68a" },
  info: { bg: "#dbeafe", text: "#1e40af", border: "#bfdbfe" },
  success: { bg: "#d1fae5", text: "#065f46", border: "#a7f3d0" },
};

/** Each document a pool row names, what it is called and where it opens. */
const DOC_KIND: Record<string, { label: string; path: (id: number) => string }> = {
  MR: { label: "MR", path: (id) => `/inventory/material-requests/${id}` },
  REQUISITION: { label: "Requisition", path: (id) => `/procurement/requisitions/${id}` },
  CONSOLIDATION: { label: "Requisition", path: (id) => `/procurement/requisitions/${id}` },
  RFQ: { label: "Requisition", path: (id) => `/procurement/requisitions/${id}` },
  PO: { label: "PO", path: (id) => `/pos/${id}` },
};

/** The part of a document number a person reads: BHS/104/2026-27/WHI0023 → WHI0023.
 *  The full number is in the chip's tooltip and in the export. */
const docShort = (no?: string | null) => (no ? no.split("/").pop() || no : null);

function stageStyle(tone: string) {
  return STAGE_TONE[tone] ?? STAGE_TONE.neutral;
}

function StagePill({
  stage,
  qty,
  stages,
  onClick,
}: {
  stage: string;
  qty: number;
  stages: DemandPoolStage[];
  onClick?: () => void;
}) {
  const meta = stages.find((s) => s.stage === stage);
  const style = stageStyle(meta?.tone ?? "neutral");
  return (
    <span
      onClick={onClick}
      title={meta?.hint ?? stage}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 10px",
        borderRadius: 20,
        fontSize: 12,
        fontWeight: 600,
        color: style.text,
        backgroundColor: style.bg,
        border: `1px solid ${style.border}`,
        cursor: onClick ? "pointer" : "default",
        whiteSpace: "nowrap",
      }}
    >
      {meta?.label ?? stage}
      <span style={{ opacity: 0.85, fontWeight: 500 }}>{qty}</span>
    </span>
  );
}

function SourceRow({
  source,
  stages,
}: {
  source: DemandPoolSource;
  stages: DemandPoolStage[];
}) {
  const nav = useNavigate();
  const meta = stages.find((s) => s.stage === source.stage);

  return (
    <tr className="border-b border-slate-200/80 text-xs hover:bg-slate-100/60 transition-colors">
      <td className="py-2.5 px-3 font-medium whitespace-nowrap">
        <button
          type="button"
          onClick={() => nav(`/indents/${source.indent_id}`)}
          className="text-blue-600 font-semibold hover:underline bg-none border-none p-0 cursor-pointer"
        >
          {source.indent_no}
        </button>
      </td>
      <td className="py-2.5 px-3 text-slate-700 font-medium">
        {source.owed_qty} {source.uom_code}
      </td>
      <td className="py-2.5 px-3">
        <div className="flex gap-1.5 flex-wrap">
          {Object.entries(source.stages).map(([st, qty]) => (
            <StagePill key={st} stage={st} qty={qty} stages={stages} />
          ))}
        </div>
      </td>
      <td className="py-2.5 px-3 text-slate-500">
        {source.department_name ?? "—"}
      </td>
      <td className="py-2.5 px-3 text-slate-500">
        {source.required_date ?? "—"}
      </td>
      <td className="py-2.5 px-3">
        <div className="flex gap-1.5 flex-wrap">
          {source.docs.map((doc, i) => {
            const known = DOC_KIND[doc.kind];
            return (
              <button
                key={`${doc.kind}-${doc.id}-${i}`}
                type="button"
                title={`${known?.label ?? doc.kind} ${doc.no ?? ""} · ${doc.status.replace(/_/g, " ").toLowerCase()} · ${doc.qty}`}
                onClick={() => nav(known ? known.path(doc.id) : meta?.deep_link ?? "#")}
                className="group inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] text-blue-800 transition-colors hover:border-blue-300 hover:bg-blue-100"
              >
                <span className="font-semibold uppercase tracking-wide text-blue-600/80">{known?.label ?? doc.kind}</span>
                <span className="font-mono font-semibold">{docShort(doc.no) ?? `#${doc.id}`}</span>
              </button>
            );
          })}
        </div>
      </td>
    </tr>
  );
}

function GroupRow({
  group,
  stages,
}: {
  group: DemandPoolGroup;
  stages: DemandPoolStage[];
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <tr
        onClick={() => setExpanded((e) => !e)}
        className={`cursor-pointer border-b border-slate-200 transition-colors ${
          expanded ? "bg-blue-50/50" : "hover:bg-slate-50/80 bg-white"
        }`}
      >
        <td className="py-3 px-4 w-8 text-center">
          <span
            className={`inline-block transition-transform duration-200 text-blue-600 text-xs ${
              expanded ? "rotate-90" : "rotate-0"
            }`}
          >
            ▶
          </span>
        </td>
        <td className="py-3 px-4">
          <div className="font-semibold text-slate-900 text-sm">
            {group.item_name}
          </div>
          <div className="text-slate-500 text-xs font-mono mt-0.5">
            {group.item_code}
          </div>
        </td>
        <td className="py-3 px-4 text-slate-700 text-sm font-medium">
          {group.total_qty} {group.uom_code}
        </td>
        <td className="py-3 px-4">
          <div className="flex gap-1.5 flex-wrap">
            {Object.entries(group.stage_summary).map(([st, qty]) => (
              <StagePill key={st} stage={st} qty={qty} stages={stages} />
            ))}
          </div>
        </td>
        <td className="py-3 px-4 text-slate-500 text-xs">
          {group.indent_count} indent{group.indent_count !== 1 ? "s" : ""}
        </td>
        <td className="py-3 px-4 text-slate-500 text-xs">
          {group.earliest_required ?? "—"}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} className="p-0 border-b border-slate-200">
            <div className="bg-slate-50/90 border-b-2 border-blue-200 px-4 py-2">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-slate-200/80 text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                    {[
                      "Indent",
                      "Owed Qty",
                      "Stage",
                      "Department",
                      "Required",
                      "Documents",
                    ].map((h) => (
                      <th key={h} className="py-1.5 px-3 text-left">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {group.sources.map((src) => (
                    <SourceRow
                      key={src.indent_item_id}
                      source={src}
                      stages={stages}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default function ProcurementDemandPoolPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const activeStage = params.get("stage") ?? undefined;
  const search = params.get("search") ?? "";
  const department = params.get("department") ?? "";
  const dateFrom = params.get("date_from") ?? "";
  const dateTo = params.get("date_to") ?? "";
  const page = parseInt(params.get("page") ?? "1");
  const PAGE_SIZE = 50;

  const [exportOpen, setExportOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  // Close export dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) {
        setExportOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const stagesQ = useQuery({
    queryKey: procurementDemandPoolKeys.stages(),
    queryFn: ({ signal }) => procurementDemandPoolApi.stages(signal),
    staleTime: 5 * 60_000,
  });

  const poolQ = useQuery({
    queryKey: procurementDemandPoolKeys.pool({ activeStage, search, page: 1, size: 500 }),
    queryFn: ({ signal }) =>
      procurementDemandPoolApi.pool(
        { stage: activeStage, search: search || undefined, page: 1, size: 500 },
        signal
      ),
    placeholderData: (prev) => prev,
  });

  const stages: DemandPoolStage[] = stagesQ.data ?? [];
  const rawData = poolQ.data;

  // Department options derived from data
  const departmentOptions = useMemo(() => {
    if (!rawData?.groups) return [];
    const depts = new Set<string>();
    for (const g of rawData.groups) {
      for (const s of g.sources) {
        if (s.department_name) depts.add(s.department_name);
      }
    }
    return Array.from(depts).sort().map((d) => ({ value: d, label: d }));
  }, [rawData]);

  // Stage dropdown options for FilterMenu
  const stageMenuOptions = useMemo(() => {
    return [
      { value: "", label: "All Stages", reset: true },
      ...stages.map((s) => ({
        value: s.stage,
        label: s.label,
        hint: s.hint,
      })),
    ];
  }, [stages]);

  // Client-side filtering for department & date range
  const filteredGroups = useMemo(() => {
    if (!rawData?.groups) return [];
    return rawData.groups
      .map((group) => {
        let sources = group.sources;

        if (department) {
          sources = sources.filter(
            (s) => (s.department_name ?? "").toLowerCase() === department.toLowerCase()
          );
        }

        if (dateFrom) {
          sources = sources.filter(
            (s) => s.required_date && s.required_date >= dateFrom
          );
        }

        if (dateTo) {
          sources = sources.filter(
            (s) => s.required_date && s.required_date <= dateTo
          );
        }

        if (sources.length === 0) return null;

        const totalQty = sources.reduce((sum, s) => sum + s.owed_qty, 0);
        const stageSummary: Record<string, number> = {};
        for (const s of sources) {
          for (const [st, q] of Object.entries(s.stages)) {
            stageSummary[st] = (stageSummary[st] ?? 0) + q;
          }
        }

        return {
          ...group,
          total_qty: Math.round(totalQty * 100) / 100,
          indent_count: new Set(sources.map((s) => s.indent_id)).size,
          stage_summary: stageSummary,
          sources,
        };
      })
      .filter((g): g is DemandPoolGroup => g !== null);
  }, [rawData, department, dateFrom, dateTo]);

  // Paginated groups view
  const totalItems = filteredGroups.length;
  const totalPages = Math.ceil(totalItems / PAGE_SIZE) || 1;
  const paginatedGroups = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredGroups.slice(start, start + PAGE_SIZE);
  }, [filteredGroups, page, PAGE_SIZE]);

  // Dynamic KPI counts based on current filters
  const stageTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const g of filteredGroups) {
      for (const [st, qty] of Object.entries(g.stage_summary)) {
        totals[st] = (totals[st] ?? 0) + qty;
      }
    }
    return totals;
  }, [filteredGroups]);

  const totalIndentCount = useMemo(() => {
    const ids = new Set<number>();
    for (const g of filteredGroups) {
      for (const s of g.sources) {
        ids.add(s.indent_id);
      }
    }
    return ids.size;
  }, [filteredGroups]);

  // URL state modifiers
  function updateParam(key: string, val: string | undefined) {
    const next = new URLSearchParams(params);
    if (val) next.set(key, val);
    else next.delete(key);
    next.set("page", "1");
    setParams(next);
  }

  function setStage(s: string | undefined) {
    updateParam("stage", s);
  }

  function setSearch(v: string) {
    updateParam("search", v || undefined);
  }

  function setDepartment(v: string) {
    updateParam("department", v || undefined);
  }

  function setDateFrom(v: string) {
    updateParam("date_from", v || undefined);
  }

  function setDateTo(v: string) {
    updateParam("date_to", v || undefined);
  }

  function clearAllFilters() {
    setParams(new URLSearchParams());
  }

  function setPage(p: number) {
    const next = new URLSearchParams(params);
    next.set("page", String(p));
    setParams(next);
  }

  // Active filters counter
  const activeFilterCount =
    (activeStage ? 1 : 0) +
    (search ? 1 : 0) +
    (department ? 1 : 0) +
    (dateFrom || dateTo ? 1 : 0);

  // Helper to fetch complete dataset without violating size <= 500
  async function fetchAllFilteredExportData(): Promise<DemandPoolGroup[]> {
    let allGroups: DemandPoolGroup[] = [];
    let p = 1;
    let totalP = 1;
    do {
      const res = await procurementDemandPoolApi.pool({
        stage: activeStage,
        search: search || undefined,
        page: p,
        size: 500,
      });
      if (res?.groups) {
        allGroups = allGroups.concat(res.groups);
        totalP = Math.ceil((res.total || 0) / 500) || 1;
      }
      p++;
    } while (p <= totalP);

    // Apply client filters if present
    if (department || dateFrom || dateTo) {
      return allGroups
        .map((group) => {
          let sources = group.sources;
          if (department) {
            sources = sources.filter(
              (s) => (s.department_name ?? "").toLowerCase() === department.toLowerCase()
            );
          }
          if (dateFrom) {
            sources = sources.filter((s) => s.required_date && s.required_date >= dateFrom);
          }
          if (dateTo) {
            sources = sources.filter((s) => s.required_date && s.required_date <= dateTo);
          }
          if (sources.length === 0) return null;
          const totalQty = sources.reduce((sum, s) => sum + s.owed_qty, 0);
          const stageSummary: Record<string, number> = {};
          for (const s of sources) {
            for (const [st, q] of Object.entries(s.stages)) {
              stageSummary[st] = (stageSummary[st] ?? 0) + q;
            }
          }
          return {
            ...group,
            total_qty: Math.round(totalQty * 100) / 100,
            indent_count: new Set(sources.map((s) => s.indent_id)).size,
            stage_summary: stageSummary,
            sources,
          };
        })
        .filter((g): g is DemandPoolGroup => g !== null);
    }

    return allGroups;
  }

  // ── CSV EXPORT HANDLERS ──
  async function handleExportGroupedCSV() {
    try {
      setIsExporting(true);
      const groupsToExport = await fetchAllFilteredExportData();
      if (groupsToExport.length === 0) {
        toast.error("There is nothing in the list to download.");
        return;
      }

      const headers = [
        "Item Code",
        "Item Name",
        "UOM",
        "Total Outstanding Qty",
        "Indent Count",
        "Stage Breakdown",
        "Earliest Required Date",
      ];

      const rows = groupsToExport.map((g) => {
        const breakdown = Object.entries(g.stage_summary)
          .map(([st, q]) => `${st}: ${q}`)
          .join("; ");
        return [
          g.item_code,
          g.item_name,
          g.uom_code,
          g.total_qty,
          g.indent_count,
          breakdown,
          g.earliest_required ?? "",
        ];
      });

      const filename = `Procurement_Demand_Pool_Summary_${new Date().toISOString().slice(0, 10)}.csv`;
      exportToCSV({ filename, headers, rows });
      toast.success(`Exported ${groupsToExport.length} item group(s) to CSV`);
    } catch (err: any) {
      toast.error(err?.message ?? "Could not download the Excel file. Try again.");
    } finally {
      setIsExporting(false);
      setExportOpen(false);
    }
  }

  async function handleExportDetailedCSV() {
    try {
      setIsExporting(true);
      const groupsToExport = await fetchAllFilteredExportData();
      if (groupsToExport.length === 0) {
        toast.error("There are no indent items to download.");
        return;
      }

      const headers = [
        "Indent No",
        "Item Code",
        "Item Name",
        "Department",
        "Required Date",
        "Owed Qty",
        "UOM",
        "Current Stage",
        "Documents",
      ];

      const rows: (string | number | boolean | null | undefined)[][] = [];
      for (const g of groupsToExport) {
        for (const s of g.sources) {
          const docsStr = s.docs.map((d) => `${DOC_KIND[d.kind]?.label ?? d.kind} ${d.no ?? `#${d.id}`}`).join("; ");
          rows.push([
            s.indent_no,
            g.item_code,
            g.item_name,
            s.department_name ?? "",
            s.required_date ?? "",
            s.owed_qty,
            s.uom_code,
            s.stage,
            docsStr,
          ]);
        }
      }

      const filename = `Procurement_Demand_Pool_Detailed_${new Date().toISOString().slice(0, 10)}.csv`;
      exportToCSV({ filename, headers, rows });
      toast.success(`Exported ${rows.length} detailed line(s) to CSV`);
    } catch (err: any) {
      toast.error(err?.message ?? "Could not download the Excel file. Try again.");
    } finally {
      setIsExporting(false);
      setExportOpen(false);
    }
  }

  return (
    <div className="space-y-6 pb-12">
      <div>
        <PageHeader
          eyebrow="Procurement"
          title="Demand Pool"
          actions={
            <div className="relative" ref={exportRef}>
              <button
                type="button"
                disabled={isExporting}
                onClick={() => setExportOpen((o) => !o)}
                className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold shadow-sm transition-all cursor-pointer disabled:opacity-50"
              >
                <Download className="h-4 w-4 text-blue-600" />
                {isExporting ? "Exporting…" : "Export Demand"}
                <ChevronDown className="h-3.5 w-3.5 opacity-60" />
              </button>

              {exportOpen && (
                <div className="absolute right-0 mt-1.5 w-60 bg-white border border-slate-200 rounded-xl shadow-lg z-50 py-1 text-xs divide-y divide-slate-100">
                  <button
                    type="button"
                    onClick={handleExportGroupedCSV}
                    className="w-full text-left px-4 py-2.5 hover:bg-blue-50/70 text-slate-700 flex items-center gap-2.5 font-medium transition-colors cursor-pointer"
                  >
                    <FileSpreadsheet className="h-4 w-4 text-blue-600 shrink-0" />
                    <div>
                      <div className="font-semibold text-slate-800">Export Grouped Summary</div>
                      <div className="text-[11px] text-slate-400">Item-wise total demand (CSV)</div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={handleExportDetailedCSV}
                    className="w-full text-left px-4 py-2.5 hover:bg-blue-50/70 text-slate-700 flex items-center gap-2.5 font-medium transition-colors cursor-pointer"
                  >
                    <FileText className="h-4 w-4 text-emerald-600 shrink-0" />
                    <div>
                      <div className="font-semibold text-slate-800">Export Detailed Lines</div>
                      <div className="text-[11px] text-slate-400">Granular indent lines (CSV)</div>
                    </div>
                  </button>
                </div>
              )}
            </div>
          }
        />
        <p className="text-xs text-slate-500 font-medium -mt-3">
          Every outstanding indent quantity, where it sits in the buying chain
        </p>
      </div>

      {/* ── Top KPI Interactive Cards ── */}
      <div className="flex gap-3 flex-wrap">
        {/* All Indents Tile */}
        <button
          type="button"
          onClick={() => setStage(undefined)}
          className={`px-4 py-3 rounded-xl border text-left min-w-[130px] transition-all cursor-pointer ${
            !activeStage
              ? "bg-blue-50/90 border-blue-500 text-blue-800 shadow-sm ring-1 ring-blue-400/50"
              : "bg-white border-slate-200 text-slate-700 hover:border-slate-300 hover:bg-slate-50"
          }`}
        >
          <div className="text-2xl font-bold font-display leading-tight flex items-center justify-between">
            {totalIndentCount}
            {!activeStage && (
              <span className="h-2 w-2 rounded-full bg-blue-600 animate-pulse" />
            )}
          </div>
          <div className="text-xs text-slate-500 mt-1 font-medium flex items-center gap-1">
            <Layers className="h-3 w-3 text-slate-400" />
            All Indents
          </div>
        </button>

        {/* Stage KPI Cards */}
        {stages.map((s) => {
          const qty = stageTotals[s.stage] ?? 0;
          const active = activeStage === s.stage;
          const style = stageStyle(s.tone);
          return (
            <button
              key={s.stage}
              type="button"
              onClick={() => setStage(active ? undefined : s.stage)}
              title={s.hint}
              className={`px-4 py-3 rounded-xl border text-left min-w-[130px] transition-all cursor-pointer ${
                active
                  ? "bg-blue-50/90 border-blue-500 text-blue-800 shadow-sm ring-1 ring-blue-400/50"
                  : "bg-white border-slate-200 text-slate-700 hover:border-slate-300 hover:bg-slate-50"
              }`}
            >
              <div
                className="text-2xl font-bold font-display leading-tight flex items-center justify-between"
                style={{ color: active ? "#1d4ed8" : style.text }}
              >
                {qty}
                {active && (
                  <span className="h-2 w-2 rounded-full bg-blue-600 animate-pulse" />
                )}
              </div>
              <div className="text-xs text-slate-500 mt-1 font-medium">
                {s.label}
              </div>
            </button>
          );
        })}
      </div>

      {/* ── Top-Notch Filter Bar ── */}
      <FilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search item name, code, or indent no… (Press /)"
        active={activeFilterCount}
        onClear={clearAllFilters}
        right={
          <span className="text-xs text-slate-500 font-medium hidden sm:inline">
            {totalItems} group{totalItems !== 1 ? "s" : ""} ({totalIndentCount} indents)
          </span>
        }
      >
        {/* Stage Filter Dropdown */}
        <FilterMenu
          label="Stage Filter"
          value={activeStage ?? ""}
          onChange={(v) => setStage(v || undefined)}
          options={stageMenuOptions}
          className="w-44"
        />

        {/* Department Filter Dropdown */}
        {departmentOptions.length > 0 && (
          <FilterMenu
            label="Department"
            value={department}
            onChange={setDepartment}
            options={[
              { value: "", label: "All Departments", reset: true },
              ...departmentOptions,
            ]}
            icon={<Building2 className="h-4 w-4 opacity-70" />}
            className="w-48"
          />
        )}

        {/* Date Range Filter */}
        <FilterDateRange
          label="Required Date"
          from={dateFrom}
          to={dateTo}
          onFrom={setDateFrom}
          onTo={setDateTo}
        />
      </FilterBar>

      {poolQ.error && <ErrorBanner error={poolQ.error} />}

      {/* ── Demand Pool Table Card ── */}
      <Card className="p-0 overflow-hidden border border-slate-200 shadow-sm bg-white">
        {filteredGroups.length === 0 ? (
          <div className="p-12 text-center text-slate-500 text-sm">
            {poolQ.isLoading
              ? "Loading demand pool…"
              : "No outstanding demand matching the active filters."}
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-xs font-bold uppercase tracking-wider">
                {["", "Item", "Total Qty", "Stage Breakdown", "Indents", "Earliest Required"].map(
                  (h) => (
                    <th key={h} className="py-3 px-4 text-left">
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {paginatedGroups.map((g) => (
                <GroupRow key={g.item_id} group={g} stages={stages} />
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* ── Pagination ── */}
      {totalPages > 1 && (
        <div className="flex justify-center gap-3 mt-6">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
            className="px-4 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 text-sm font-medium hover:bg-slate-50 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            Previous
          </button>
          <span className="px-4 py-2 text-slate-600 text-sm self-center font-medium">
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage(page + 1)}
            className="px-4 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 text-sm font-medium hover:bg-slate-50 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
