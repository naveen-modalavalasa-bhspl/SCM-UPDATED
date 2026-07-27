import { PageHeader, type Column } from "@/shared/components";
import { MasterCrud, type Option } from "@/modules/masters/components/MasterCrud";
import { adminApi } from "../api";
import type { DocSeries } from "../types";

const RESET_POLICIES: Option[] = ["NEVER", "YEARLY", "MONTHLY"]
  .map((value) => ({ value, label: value }));

const Code = ({ children }: { children: React.ReactNode }) => (
  <span className="mono font-semibold text-ink">{children}</span>
);

const Active = ({ on }: { on: boolean }) => (
  <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
    on ? "bg-ok-bg text-ok" : "bg-default text-muted"
  }`}>
    <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-ok" : "bg-muted"}`} />
    {on ? "Active" : "Inactive"}
  </span>
);

export function NumberingPage() {
  const columns: Column<DocSeries>[] = [
    { key: "doc", header: "Document", render: (row) => <Code>{row.doc_type}</Code> },
    { key: "fy", header: "Fiscal year", render: (row) => row.fiscal_year },
    {
      key: "pattern", header: "Pattern", hideOnNarrow: true,
      render: (row) => <Code>{row.pattern}</Code>,
    },
    { key: "preview", header: "Next number", render: (row) => <Code>{row.preview}</Code> },
    { key: "reset", header: "Resets", hideOnNarrow: true, render: (row) => row.reset_policy },
    { key: "active", header: "Status", render: (row) => <Active on={row.is_active} /> },
  ];

  return (
    <>
      <PageHeader eyebrow="Settings" title="Document numbering" />
      <MasterCrud<DocSeries>
        title="Numbering series"
        queryKey="doc-series"
        managePerm="admin.numbering.manage"
        columns={columns}
        renderCard={(row) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Code>{row.doc_type}</Code>
              <Active on={row.is_active} />
            </div>
            <div className="text-sm text-body">Next: <Code>{row.preview}</Code></div>
            <div className="text-xs text-muted">
              {row.fiscal_year} · resets {row.reset_policy}
            </div>
          </div>
        )}
        fetchList={adminApi.docSeries.list}
        fields={[
          { key: "doc_type", label: "Document type (INDENT/PO/GRN/ISSUE)", required: true },
          { key: "fiscal_year", label: "Fiscal year", required: true },
          { key: "prefix", label: "Prefix", required: true },
          { key: "pattern", label: "Pattern", placeholder: "{PREFIX}/{FY}/{SEQ:5}" },
          { key: "reset_policy", label: "Reset", type: "select", options: RESET_POLICIES },
          { key: "is_active", label: "Active", type: "switch" },
        ]}
        emptyForm={{
          doc_type: "", fiscal_year: "", prefix: "",
          pattern: "{PREFIX}/{FY}/{SEQ:5}", reset_policy: "NEVER", is_active: true,
        }}
        toForm={(row) => ({
          doc_type: row.doc_type,
          fiscal_year: row.fiscal_year,
          prefix: row.prefix,
          pattern: row.pattern,
          reset_policy: row.reset_policy,
          is_active: row.is_active,
        })}
        onCreate={(value) => adminApi.docSeries.create(value as Partial<DocSeries>)}
        onUpdate={(id, value) => adminApi.docSeries.update(id, value as Partial<DocSeries>)}
        onDeactivate={adminApi.docSeries.deactivate}
      />
    </>
  );
}

