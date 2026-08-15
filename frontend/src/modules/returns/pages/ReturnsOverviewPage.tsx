import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Ban, CalendarDays, CheckCircle2, ClipboardCheck, Clock, Package, Pencil, Plus, Scale,
  Trash2, XCircle,
} from "lucide-react";
import {
  Button, Card, PageHeader, StatCard, StatusPill,
} from "@/shared/components";
import { returnsApi } from "../api";
import { ReturnsNav } from "../components/ReturnsNav";
import { STATUS_LABEL, STATUS_ORDER } from "../constants";

/**
 * The module's landing screen — the same shape as the indent Overview: KPI tiles, a
 * status breakdown, and the most recent documents.
 *
 * Every number comes from `GET /api/returns/summary`, which counts in SQL over the
 * same visibility the grid applies. Summing the fetched page in the browser would make
 * the tiles disagree with the list the moment there was more than one page.
 */
export default function ReturnsOverviewPage() {
  const navigate = useNavigate();

  const { data: summary } = useQuery({
    queryKey: ["returns", "summary"],
    queryFn: returnsApi.summary,
  });

  const { data: recent } = useQuery({
    queryKey: ["returns", "list", { page: 1, size: 6 }],
    queryFn: () => returnsApi.list({ page: 1, size: 6 }),
  });

  const counts = summary?.by_status ?? {};
  const total = summary?.total ?? 0;
  const decided = (summary?.approved ?? 0) + (summary?.acknowledged ?? 0);
  const settled = decided + (summary?.rejected ?? 0);
  // Out of decisions actually taken, not out of every document ever raised: counting
  // drafts and pending rows as "not approved" would drag the rate down for work that
  // simply has not been looked at yet.
  const approvalRate = settled > 0 ? Math.round((decided / settled) * 1000) / 10 : null;

  const oldest = summary?.oldest_waiting_days;

  const tiles = [
    { label: "Total returns", value: total, icon: Package },
    // The two desks, separately. Both hold PENDING_APPROVAL documents, so one "awaiting
    // approval" count cannot say which desk is behind — and that was the whole point of
    // splitting them.
    {
      label: "Awaiting decision",
      value: summary?.awaiting_decision ?? 0,
      icon: Scale,
    },
    {
      label: "Awaiting sign-off",
      value: summary?.awaiting_endorsement ?? 0,
      icon: ClipboardCheck,
    },
    { label: "Awaiting approval", value: summary?.pending_approval ?? 0, icon: Clock },
    {
      label: "Oldest waiting",
      // Whole days at a desk. "—" when nothing is waiting, never 0 — a zero reads as
      // "something arrived today" rather than as "the queues are clear".
      value: oldest === null || oldest === undefined ? "—" : `${oldest}d`,
      icon: CalendarDays,
    },
    { label: "Written off", value: summary?.written_off ?? 0, icon: Trash2 },
    {
      label: "Refused — uneconomic",
      value: summary?.refused_uneconomic ?? 0,
      icon: Ban,
    },
    { label: "Approved", value: summary?.approved ?? 0, icon: CheckCircle2 },
    { label: "Acknowledged", value: summary?.acknowledged ?? 0, icon: ClipboardCheck },
    { label: "In draft", value: summary?.draft ?? 0, icon: Pencil },
    { label: "Rejected", value: summary?.rejected ?? 0, icon: XCircle },
    {
      label: "Approval rate",
      value: approvalRate === null ? "—" : `${approvalRate}%`,
      icon: CalendarDays,
    },
  ];

  const leaderboards = [
    { title: "Top reasons", rows: summary?.top_reasons ?? [] },
    { title: "Top branches", rows: summary?.top_branches ?? [] },
  ];

  return (
    <div>
      <ReturnsNav />

      <PageHeader
        eyebrow="RETURN"
        title="Overview"
        actions={
          // Deliberately not wrapped in <Can do="stock.transfer">: raising a return is
          // the whole point of the screen, and hiding the only way in left storekeepers
          // on an empty page with nothing to do. The endpoint is still permission-gated
          // — a login without the code is refused at submit, which is the real check.
          <Button onClick={() => navigate("/returns/new")}>
            <Plus className="h-4 w-4" /> New return
          </Button>
        }
      />

      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <StatCard key={tile.label} label={tile.label} value={tile.value} />
        ))}
      </div>

      {/* What is coming back and from where — the two questions the business asks of a
        * returns register that a status breakdown cannot answer. */}
      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {leaderboards.map((board) => (
          <Card key={board.title} className="p-4">
            <h2 className="mb-3 font-display text-lg font-bold text-ink">
              {board.title}
            </h2>
            {board.rows.length === 0 && (
              <p className="text-sm text-muted">Nothing yet.</p>
            )}
            <ul className="space-y-2">
              {board.rows.map((row) => (
                <li
                  key={row.label}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span className="text-body">{row.label}</span>
                  <span className="font-semibold tabular text-ink">{row.count}</span>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2">
          <h2 className="font-display text-lg font-bold text-ink">Status breakdown</h2>
          <p className="mb-4 text-sm text-muted">Current distribution by return status</p>

          {total === 0 && (
            <p className="text-sm text-muted">Nothing has been returned yet.</p>
          )}

          <ul className="space-y-3">
            {STATUS_ORDER.filter((status) => (counts[status] ?? 0) > 0).map((status) => {
              const count = counts[status] ?? 0;
              const share = total > 0 ? Math.round((count / total) * 100) : 0;
              return (
                <li key={status}>
                  <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                    <span className="text-body">{STATUS_LABEL[status] ?? status}</span>
                    <span className="text-muted">
                      {count} · {share}%
                    </span>
                  </div>
                  <div
                    className="h-2 w-full overflow-hidden rounded-full bg-content2"
                    role="img"
                    aria-label={`${STATUS_LABEL[status] ?? status}: ${count} of ${total}`}
                  >
                    <div
                      className="h-full rounded-full bg-brand"
                      style={{ width: `${share}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="font-display text-lg font-bold text-ink">Recent returns</h2>
            <Button variant="subtle" onClick={() => navigate("/returns")}>
              View all
            </Button>
          </div>

          {(recent?.items ?? []).length === 0 && (
            <p className="text-sm text-muted">No returns raised yet.</p>
          )}

          <ul className="space-y-3">
            {(recent?.items ?? []).map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/returns/${row.id}`)}
                  className="min-h-11 w-full rounded-lg px-2 py-2 text-left transition-colors hover:bg-content2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-ink">{row.return_no}</span>
                    <StatusPill status={row.status} />
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    {row.raised_by_name ?? "—"}
                    {row.office_name ? ` · ${row.office_name}` : ""}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
