import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Card, DocumentNumberCard, ErrorBanner, Field, Input, PageHeader, ResponsiveList, StatCard, StatusPill, useAction, type Column } from "@/shared/components";
import type { DocNumberValue } from "@/shared/documentNumber";
import { Button } from "../components/ActionButton";
import { fmtDate } from "@/shared/datetime";
import { consolidationApi } from "../api";
import { SelectAllBar } from "../components/SelectAllBar";
import { PickBox, PickedTag, pickRevision } from "../components/PickBox";
import { money } from "./RequisitionListPage";
import type { ReqListRow } from "../types";

const SIZE = 50;

/**
 * Pick the requisitions that go on a sheet.
 *
 * The picker only ever shows APPROVED requisitions that are not already on another
 * sheet — the backend filters that in the query, so there is nothing here that can
 * offer a requisition which would then be rejected on save.
 *
 * The lines themselves are not edited here. Aggregation is the backend's job (one
 * line per item and unit), and letting the form pre-compute it would mean two
 * implementations of the same sum.
 */
export function PurchaseConsolidationFormPage() {
  const nav = useNavigate();
  const [chosen, setChosen] = useState<number[]>([]);
  const [header, setHeader] = useState({
    title: "", period_label: "", remarks: "",
  });
  const [page, setPage] = useState(1);
  // Selected here only for requisitions older than organisations. Anything newer carries
  // its own, and those are what the card shows the moment one is ticked.
  const [selection, setSelection] = useState<DocNumberValue>({
    organizationId: "", projectId: "", orgDepartmentId: "", fiscalYear: "",
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ["consolidation-candidates", page],
    queryFn: () => consolidationApi.candidates({ page, size: SIZE }),
  });

  // Every candidate id, so "select all" can mean ALL of them rather than the fifty on
  // screen — a month of requisitions runs past one page and folding them into a sheet
  // was fifty ticks a page. Ids only: the rows themselves are already paged in, and
  // shipping the full records just to select them would be slower than the paging.
  const allIds = useQuery({
    queryKey: ["consolidation-candidate-ids"],
    queryFn: () => consolidationApi.candidateIds(),
  });

  const create = useAction({
    run: () => consolidationApi.create({
      requisition_ids: chosen,
      title: header.title || null,
      period_label: header.period_label || null,
      remarks: header.remarks || null,
      organization_id: selection.organizationId || null,
      org_department_id: selection.orgDepartmentId || null,
      fiscal_year: selection.fiscalYear || null,
    }),
    success: "Consolidated sheet created",
    invalidates: [["consolidations"], ["consolidation-candidates"]],
    onDone: (doc) => nav(`/procurement/consolidations/${doc.id}`),
  });

  const rows = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / SIZE));
  const picked = rows.filter((r) => chosen.includes(r.id));
  const pickedValue = picked.reduce((sum, r) => sum + Number(r.estimated_value ?? 0), 0);
  // The sheet takes the organisation of the requisitions on it, and the project of the
  // first. Read off the ticked rows on this page: the save checks the whole selection.
  const carriedFrom = picked.find((r) => r.organization_id);
  const scope: DocNumberValue = {
    ...selection,
    organizationId: carriedFrom?.organization_id ?? selection.organizationId,
    organizationName: carriedFrom?.organization_name ?? "",
    orgDepartmentId: carriedFrom?.org_department_id ?? selection.orgDepartmentId,
    departmentName: carriedFrom?.org_department_name ?? "",
    projectName: picked[0]?.project_name ?? "",
  };

  const toggle = (id: number) =>
    setChosen((all) => (all.includes(id) ? all.filter((x) => x !== id) : [...all, id]));

  const columns: Column<ReqListRow>[] = [
    {
      key: "pick",
      header: "",
      render: (r) => (
        <PickBox checked={chosen.includes(r.id)} onToggle={() => toggle(r.id)}
                 label={`Include ${r.req_no}`} />
      ),
    },
    {
      key: "req",
      header: "Requisition",
      render: (r) => (
        <div className="min-w-0">
          <div className={`font-mono text-xs font-semibold ${chosen.includes(r.id) ? "text-brand" : "text-ink"}`}>
            {r.req_no}<PickedTag show={chosen.includes(r.id)} />
          </div>
          <div className="text-[11px] text-muted">{r.warehouse_name ?? "—"}</div>
        </div>
      ),
    },
    { key: "organisation", header: "Organisation", hideOnNarrow: true, render: (r) => r.organization_name ?? "—" },
    { key: "project", header: "Project", hideOnNarrow: true, render: (r) => r.project_name ?? "—" },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    { key: "lines", header: "Lines", className: "text-right", render: (r) => r.total_items },
    {
      key: "value",
      header: "Estimated",
      className: "text-right",
      render: (r) => money(r.estimated_value),
    },
    {
      key: "raised",
      header: "Raised",
      hideOnNarrow: true,
      render: (r) => <span className="text-sm text-muted">{fmtDate(r.created_at)}</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        back={{ to: "/procurement/consolidations", label: "Back to Purchase sheets" }}
        eyebrow="Procurement"
        title="New consolidated sheet"
        actions={
          <>
            <Button variant="ghost" onClick={() => nav("/procurement/consolidations")}>
              Back
            </Button>
            <Button
              onClick={() => create.mutate()}
              disabled={!chosen.length || create.isPending}
            >
              {create.isPending ? "Building…" : `Consolidate ${chosen.length || ""}`}
            </Button>
          </>
        }
      />

      <ErrorBanner error={error ?? create.error} />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatCard label="Available to consolidate" value={data?.total ?? 0} />
        <StatCard label="Selected" value={chosen.length} />
        {/* FIXED 2026-08-22 — this totals only the rows in HAND. It always did, but
            with select-all spanning pages it can now be short by most of the sheet, and
            a value card that quietly under-reports is worse than one that admits its
            scope. The label says which it is; the figure itself is unchanged.
            Totalling the whole selection would mean fetching every chosen requisition
            just to add up a number the sheet computes properly on save. */}
        <StatCard
          label={picked.length < chosen.length ? "Value on this page" : "Selected value"}
          value={money(pickedValue)}
        />
      </div>

      <div className="mb-4">
        <DocumentNumberCard
          docType="consolidation" value={scope} ready defaultProject={false}
          locks={{ organisation: Boolean(carriedFrom), project: true }}
          source={carriedFrom
            ? { label: carriedFrom.req_no, to: `/procurement/requisitions/${carriedFrom.id}` }
            : { label: "the requisitions you tick" }}
          onChange={(patch) => setSelection((current) => ({ ...current, ...patch }))}
        />
      </div>

      <Card className="mb-4 space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title" hint="What this sheet is for, in your own words">
            <Input
              value={header.title}
              placeholder="August consumables"
              onChange={(e) => setHeader({ ...header, title: e.target.value })}
            />
          </Field>
          <Field label="Covers" hint="The period or region this sheet spans">
            <Input
              value={header.period_label}
              placeholder="August 2026 — Southern region"
              onChange={(e) => setHeader({ ...header, period_label: e.target.value })}
            />
          </Field>
        </div>
        <Field label="Notes">
          <Input
            value={header.remarks}
            onChange={(e) => setHeader({ ...header, remarks: e.target.value })}
          />
        </Field>
      </Card>

      {/* Pick a hundred in one press. The total comes from the server, so
          "Select all 137" ticks 137 and not the fifty in view. */}
      <SelectAllBar
        noun="requisition"
        pickedCount={chosen.length}
        pageIds={rows.map((r) => r.id)}
        allIds={allIds.data}
        loadingAll={allIds.isLoading}
        onPick={setChosen}
      />

      <Card className="p-2">
        <ResponsiveList
          data={rows}
          columns={columns}
          keyOf={(r) => r.id}
          loading={isLoading}
          // SCM_0158: the desktop table caches its rows; without a revision that moves
          // with the selection, a tick changed the counter and never the box.
          revision={pickRevision(page, chosen)}
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          empty="Nothing to consolidate — every approved requisition is already on a sheet."
          renderCard={(r) => (
            <div className={`-m-1 flex items-start gap-2 rounded-xl p-1 transition-colors ${
              chosen.includes(r.id) ? "bg-brand-050/70" : ""}`}>
              <PickBox checked={chosen.includes(r.id)} onToggle={() => toggle(r.id)}
                       label={`Include ${r.req_no}`} />
              <div className="min-w-0 flex-1 space-y-1 pt-2">
                <div className="flex items-start justify-between gap-2">
                  <span className={`font-mono text-xs font-semibold ${chosen.includes(r.id) ? "text-brand" : "text-ink"}`}>
                    {r.req_no}<PickedTag show={chosen.includes(r.id)} />
                  </span>
                  <StatusPill status={r.status} />
                </div>
                <div className="text-sm text-body">{r.warehouse_name ?? "—"}</div>
                <div className="text-xs text-muted">
                  {r.total_items} line{r.total_items === 1 ? "" : "s"} ·{" "}
                  {money(r.estimated_value)}
                </div>
              </div>
            </div>
          )}
        />
      </Card>
    </div>
  );
}
