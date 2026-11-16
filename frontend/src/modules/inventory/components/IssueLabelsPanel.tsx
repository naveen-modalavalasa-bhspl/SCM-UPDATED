import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Printer, Search, Truck } from "lucide-react";
import { Button, Card, StatusPill } from "@/shared/components";
import { useDebouncedValue } from "@/shared/hooks/useDebouncedValue";
import { listIssues } from "@/modules/warehouse/api";
import { DocLabelsDialog } from "@/modules/warehouse/components/DocLabelsDialog";
import { fmtDate } from "@/modules/warehouse/format";
import { LoadingRows } from "./PageStates";

/**
 * Issue labels (2026-10-28): find a posted issue and print — or reprint — the labels
 * of everything it sent, the whole issue or item by item. Only POSTED issues are
 * listed: before posting, a part pack has no code to print.
 */
export function IssueLabelsPanel() {
  const [search, setSearch] = useState("");
  const q = useDebouncedValue(search, 300);
  const [open, setOpen] = useState<number | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["issue-labels-list", q],
    queryFn: () => listIssues({ direction: "OUT", search: q || undefined, size: 50 }),
  });
  const rows = (data?.items ?? []).filter((r) => r.is_stock_posted);

  return (
    <Card className="p-4">
      <label className="mb-3 flex h-11 max-w-md items-center gap-2 rounded-xl border border-line bg-content1 px-3 focus-within:border-brand">
        <Search className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <input value={search} onChange={(e) => setSearch(e.target.value)}
               placeholder="Find an issue by number, indent or destination"
               aria-label="Find an issue" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
      </label>
      {isLoading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-8 text-center text-sm text-muted">
          No issued (posted) material issues{q ? ` match “${q}”` : " yet"}.
        </p>
      ) : (
        <ul className="divide-y divide-line/70">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 py-3">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-ink">{r.issue_no}</span>
                  <StatusPill status={r.status} />
                </span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                  <span>{fmtDate(r.issue_date)}</span>
                  <span>· {r.total_items} item{r.total_items === 1 ? "" : "s"}</span>
                  {(r.destination_warehouse_name || r.issued_to_name) && (
                    <span className="inline-flex items-center gap-1">
                      · <Truck className="h-3 w-3" aria-hidden /> {r.destination_warehouse_name || r.issued_to_name}
                    </span>
                  )}
                </span>
              </span>
              <Button variant="subtle" onClick={() => setOpen(r.id)}>
                <Printer className="h-4 w-4" /> Print labels
              </Button>
            </li>
          ))}
        </ul>
      )}
      {open !== null && <DocLabelsDialog open={open !== null} onClose={() => setOpen(null)}
                       doc={open !== null ? { type: "ISSUE", id: open } : null} />}
    </Card>
  );
}
