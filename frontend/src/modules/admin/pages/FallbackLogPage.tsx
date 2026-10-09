import { useQuery } from "@tanstack/react-query";
import { api } from "@/shared/api/client";
import { PageHeader, ResponsiveList, StatusPill, type Column } from "@/shared/components";
import { fmtDateTime } from "@/shared/datetime";

/**
 * Every time approval configuration failed and the hardcoded ladder took over.
 *
 * A fallback that fires silently is a misconfiguration nobody ever fixes: the document
 * keeps moving, so no one complains, and the workflow stays broken for months. This
 * screen is the one place it is visible.
 *
 * No dedicated endpoint — fallbacks already write to the audit log under
 * entity_type "wf_instances", so this filters that rather than adding a second
 * source of the same truth.
 */
interface AuditRow {
  id: number;
  entity_no: string | null;
  action: string;
  actor_name: string | null;
  changed_fields: Record<string, unknown> | null;
  at: string | null;
}

const REASONS: Record<string, string> = {
  NO_WORKFLOW: "No workflow configured for this document type",
  EMPTY_STAGE: "A stage resolved to nobody",
  REPORTING_LADDER: "Routed up the reporting line",
  ADMIN_SAFETY_NET: "Nobody in the reporting line — routed to an admin",
  NO_APPROVER_STUCK: "Nobody at all — document is stuck and needs attention",
};

function explain(fields: Record<string, unknown> | null): { reason: string; who: string } {
  const raw = String((fields?.fallback as { to?: string } | string) ?? "");
  const value = typeof fields?.fallback === "object"
    ? String((fields.fallback as { to?: string }).to ?? "")
    : raw;
  const parts = value.split("/");
  const label = parts.map((p) => REASONS[p] ?? p).join(" → ");
  const who = typeof fields?.approvers === "object"
    ? String((fields.approvers as { to?: string }).to ?? "")
    : String(fields?.approvers ?? "");
  return { reason: label || value || "—", who: who || "—" };
}

const fmt = (s: string | null) => fmtDateTime(s);

export function FallbackLogPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["fallback-log"],
    queryFn: () =>
      api
        .get("/api/admin/audit", { params: { entity: "wf_instances", size: 100 } })
        .then((r) => r.data),
  });

  const rows: AuditRow[] = data?.items ?? [];

  const columns: Column<AuditRow>[] = [
    {
      key: "doc",
      header: "Document",
      render: (r) => <span className="mono font-semibold text-ink">{r.entity_no ?? "—"}</span>,
    },
    {
      key: "reason",
      header: "What happened",
      render: (r) => explain(r.changed_fields).reason,
    },
    {
      key: "who",
      header: "Routed to",
      render: (r) => explain(r.changed_fields).who,
      hideOnNarrow: true,
    },
    {
      key: "at",
      header: "When",
      render: (r) => <span className="text-muted">{fmt(r.at)}</span>,
      hideOnNarrow: true,
    },
  ];

  return (
    <>
      <PageHeader eyebrow="Settings" title="Approval fallback log" />

      <p className="mb-4 text-sm text-muted">
        Times the approval configuration failed and the built-in reporting ladder took
        over. Each row is a workflow somebody should fix — the document kept moving, so
        nobody will have complained.
      </p>

      {error ? (
        <p className="rounded-lg bg-danger-50 p-4 text-danger">{(error as Error).message}</p>
      ) : (
        <ResponsiveList
          data={rows}
          loading={isLoading}
          keyOf={(r) => r.id}
          columns={columns}
          empty="Nothing here — every document has found its configured approver. That is the goal."
          renderCard={(r) => {
            const { reason, who } = explain(r.changed_fields);
            return (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="mono font-semibold text-ink">{r.entity_no ?? "—"}</span>
                  <StatusPill status="FALLBACK" />
                </div>
                <p className="text-sm text-body">{reason}</p>
                <p className="text-xs text-muted">Routed to {who} · {fmt(r.at)}</p>
              </div>
            );
          }}
        />
      )}
    </>
  );
}
