import { useQuery } from "@tanstack/react-query";
import { Network } from "lucide-react";
import { StatusPill } from "@/shared/components";
import { returnsApi } from "../api";
import { Fact, SectionCard } from "./DetailChrome";

/**
 * The paper trail behind the item, in one section under it.
 *
 * Intent, indent, material issue, PO, GRN, QC — and the warehouse document once the load
 * has left — so the reviewer checks everything in one place instead of opening four
 * modules. All resolved server-side (`/related-documents`); this renders the rows in the
 * order they arrive and works out nothing of its own.
 *
 * The two warehouses are shown as the two different facts they are: where the material
 * CAME from (which is what the destination picker pre-fills with) and where the stock
 * physically stands today (which can never be the destination).
 */
const TYPE_LABELS: Record<string, string> = {
  INTENT: "Intent",
  INDENT: "Indent",
  MATERIAL_ISSUE: "Material Issue",
  PO: "Purchase Order",
  GRN: "GRN / Receipt",
  QC: "QC Inspection",
  PURCHASE_RETURN: "Purchase Return",
};

export function RelatedDocumentsSection({ returnId }: { returnId: number }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["returns", returnId, "related-documents"],
    queryFn: () => returnsApi.relatedDocuments(returnId),
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (isLoading) {
    return (
      <SectionCard icon={<Network className="h-4 w-4" />} title="Related documents — under the item">
        <p className="text-sm text-muted">Loading related documents…</p>
      </SectionCard>
    );
  }
  if (error) {
    return (
      <SectionCard
        tone="bad"
        icon={<Network className="h-4 w-4" />}
        title="Related documents — under the item"
      >
        <p className="text-sm text-bad">
          The related documents could not be loaded — the decision still works below.
        </p>
      </SectionCard>
    );
  }
  if (!data) return null;

  const facts: { label: string; value: string; note?: string; bad?: boolean }[] = [
    {
      label: "Originating warehouse",
      value: data.originating_warehouse_name ?? "—",
      note: data.originating_is_resolved
        ? (data.originating_source_doc ?? undefined)
        : "not named by any document — addressed-to point",
    },
    {
      label: "Where it is now",
      value: data.current_warehouse_name ?? "—",
      note: "cannot be the destination",
    },
    {
      label: "Material issue",
      value: data.material_issue_no ?? "—",
    },
    {
      label: "Intent",
      value: data.intent_label ?? data.intent ?? "—",
    },
    {
      label: "Purchase return will be filed as",
      value: data.purchase_return_category_label ?? "—",
    },
    {
      label: "QC rejected after GRN",
      value: data.qc_rejected_tag ? "Yes — tagged" : "No",
      bad: data.qc_rejected_tag,
    },
  ];

  if (data.warehouse_return_no) {
    facts.push({
      label: "Warehouse document",
      value: data.warehouse_return_no,
      note: "raised when the vehicle left",
    });
  }

  return (
    <SectionCard
      icon={<Network className="h-4 w-4" />}
      title="Related documents — under the item"
      subtitle="Everything behind this material, so the whole call can be made here."
      aside={data.documents.length > 0 ? (
        <span className="tabular rounded-full bg-content2 px-2.5 py-1 text-xs font-semibold text-muted">
          {data.documents.length}
        </span>
      ) : undefined}
    >
      <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-3.5 rounded-xl border border-line bg-content2/50 p-3.5 md:grid-cols-3">
        {facts.map((fact) => (
          <Fact
            key={fact.label}
            label={fact.label}
            value={fact.value}
            note={fact.note}
            tone={fact.bad ? "font-semibold text-bad" : "text-ink"}
          />
        ))}
      </dl>

      {data.documents.length === 0 ? (
        <p className="text-sm text-muted">No related documents found for these items.</p>
      ) : (
        <ol className="space-y-2">
          {data.documents.map((doc, index) => (
            <li
              key={`${doc.doc_type}-${doc.doc_id ?? index}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line p-3 transition-colors hover:border-brand/30 hover:bg-content2/50 motion-reduce:transition-none"
            >
              <div className="flex min-w-0 items-center gap-3">
                {/* The step number: a trail is a sequence, and the order the server sends
                  * these in IS the order the material travelled. */}
                <span
                  aria-hidden="true"
                  className="tabular grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand/10 text-[11px] font-bold text-brand"
                >
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded bg-content2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                      {TYPE_LABELS[doc.doc_type] ?? doc.doc_type}
                    </span>
                    <span className="mono truncate text-sm font-semibold text-ink">
                      {doc.doc_no ?? "—"}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-muted">
                    {[doc.warehouse_name, doc.vendor_name, doc.date]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
              </div>
              {doc.status && <StatusPill status={doc.status} />}
            </li>
          ))}
        </ol>
      )}
    </SectionCard>
  );
}
