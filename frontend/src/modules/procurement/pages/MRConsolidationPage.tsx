import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, Card, ErrorBanner, Field, FormActions, Input, PageHeader, ResponsiveList,
  Select, StatusPill, useToast, type Column,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { requisitionApi } from "../api";
import { OrgFields, type OrgValue } from "../components/OrgFields";
import type { MRCandidate } from "../types";

const PRIORITIES = [
  { value: "NORMAL", label: "Normal" },
  { value: "HIGH", label: "High" },
  { value: "URGENT", label: "Urgent" },
];

const SIZE = 50;

/**
 * Fold several approved material requests into one requisition.
 *
 * Inventory raises an MR per shortage, one item at a time, so the same item arrives on
 * five of them in a week — each too small to tender and each producing its own
 * requisition, its own RFQ and its own order. This is the step that gathers them: pick
 * the requests, get one requisition, tender it once.
 *
 * Two rules a buyer already knows from the indents consolidation:
 *
 *  - **An MR is consolidated once.** The list only shows requests no requisition has
 *    claimed, so nothing can be double-counted and a later batch cannot reopen an
 *    earlier one. Cancelling a requisition puts its requests back on this list.
 *  - **No second approval.** The requests were approved in Inventory by the people who
 *    own the stock; the requisition lands APPROVED and goes straight to RFQ. It is
 *    still audited — who consolidated what, and when.
 */
export function MRConsolidationPage() {
  const nav = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [picked, setPicked] = useState<number[]>([]);
  const [org, setOrg] = useState<OrgValue>({
    departmentId: "", warehouseId: "", projectId: "", companyName: "",
  });
  const [priority, setPriority] = useState("NORMAL");
  const [requiredDate, setRequiredDate] = useState("");
  const [remarks, setRemarks] = useState("");
  const [page, setPage] = useState(1);
  const [problem, setProblem] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["mr-candidates", page],
    queryFn: () => requisitionApi.mrCandidates({ page, size: SIZE }),
  });

  const rows = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / SIZE));

  const toggle = (id: number) =>
    setPicked((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);

  const create = useMutation({
    mutationFn: () =>
      requisitionApi.createFromMrs({
        mr_ids: picked,
        warehouse_id: org.warehouseId === "" ? null : org.warehouseId,
        project_id: org.projectId === "" ? null : org.projectId,
        department_id: org.departmentId === "" ? null : org.departmentId,
        company_name: org.companyName || null,
        required_date: requiredDate || null,
        priority,
        remarks: remarks || null,
      }),
    onSuccess: (req) => {
      queryClient.invalidateQueries({ queryKey: ["mr-candidates"] });
      queryClient.invalidateQueries({ queryKey: ["requisitions"] });
      toast.success(
        `${req.req_no} raised from ${picked.length} material request${picked.length === 1 ? "" : "s"} — approved, ready to tender`);
      nav(`/procurement/requisitions/${req.id}`);
    },
  });

  const submit = () => {
    if (!picked.length) {
      setProblem("Pick at least one material request to consolidate.");
      return;
    }
    setProblem(null);
    create.mutate();
  };

  const columns: Column<MRCandidate>[] = [
    {
      key: "pick",
      header: "",
      render: (r) => (
        <label className="flex h-11 w-11 items-center justify-center">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={picked.includes(r.id)}
            onChange={() => toggle(r.id)}
            aria-label={`Include ${r.mr_no}`}
          />
        </label>
      ),
    },
    {
      key: "mr",
      header: "Material request",
      render: (r) => (
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-ink">{r.mr_no}</div>
          <div className="text-[11px] text-muted">
            {r.indent_no ? `for ${r.indent_no}` : "No indent"}
          </div>
        </div>
      ),
    },
    { key: "project", header: "Project", hideOnNarrow: true,
      render: (r) => r.project_name ?? "—" },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    {
      key: "raised",
      header: "Raised",
      hideOnNarrow: true,
      render: (r) => <span className="text-xs text-muted">{fmtDate(r.created_at)}</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Procurement"
        title="Consolidate material requests"
        actions={
          <Button variant="subtle" onClick={() => nav("/procurement/requisitions")}>
            Back
          </Button>
        }
      />

      <ErrorBanner error={error ?? create.error} />
      {problem && <ErrorBanner error={problem} />}

      <Card className="mb-4 space-y-5 p-5">
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-body">
          Lines for the same item are merged into one, and only what is still owed is
          carried over. The requisition is approved on arrival — these requests were
          already approved in Inventory — so it goes straight to RFQ.
        </p>

        <OrgFields value={org} onChange={(patch) => setOrg({ ...org, ...patch })} />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Priority">
            <Select value={priority} options={PRIORITIES}
                    onChange={(value) => setPriority(String(value))} />
          </Field>
          <Field label="Needed by" hint="Applies to every line.">
            <Input type="date" value={requiredDate}
                   onChange={(e) => setRequiredDate(e.target.value)} />
          </Field>
          <Field label="Remarks">
            <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </Field>
        </div>

        <FormActions>
          <Button variant="subtle" onClick={() => setPicked([])}>Clear selection</Button>
          <Button disabled={create.isPending} onClick={submit}>
            {create.isPending
              ? "Consolidating…"
              : `Create requisition${picked.length ? ` from ${picked.length}` : ""}`}
          </Button>
        </FormActions>
      </Card>

      <Card className="p-2">
        <ResponsiveList
          data={rows}
          columns={columns}
          keyOf={(r) => r.id}
          loading={isLoading}
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          empty="No approved material requests are waiting. Ones already on a requisition do not appear here."
          renderCard={(r) => (
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={picked.includes(r.id)}
                onChange={() => toggle(r.id)}
              />
              <span className="min-w-0 space-y-1">
                <span className="block font-mono text-xs font-semibold text-ink">
                  {r.mr_no}
                </span>
                <span className="block text-[11px] text-muted">
                  {r.indent_no ? `for ${r.indent_no}` : "No indent"}
                  {r.project_name ? ` · ${r.project_name}` : ""}
                </span>
              </span>
            </label>
          )}
        />
      </Card>
    </div>
  );
}
