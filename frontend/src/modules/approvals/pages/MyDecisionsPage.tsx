import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  CheckCircle2, ChevronRight, Download, FileSearch, History,
  RotateCcw, Search, XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import * as XLSX from "xlsx";
import {
  Button, Card, ErrorBanner, Input, PageHeader, ResponsiveList, StatusPill, type Column,
} from "@/shared/components";
import { fmtDate, fmtTime } from "@/shared/datetime";
import { approvalsApi } from "../api";
import { approvalDecisionLedgerPath } from "../documentRoutes";
import type { ApprovalDecisionRow } from "../types";
import { ApprovalPager } from "../components/Pager";
import { TONE_BLUE } from "@/shared/components/tones";

/**
 * The record of what THIS approver has signed.
 *
 * One colour per outcome, and it is the same colour in all three places it appears:
 * the filter chip that narrows to it, the tile at the head of the row, and the badge
 * in the decision column. A reader who has never used the screen learns the language
 * once — green was approved, amber went back, red was denied — and can then scan a
 * page of history without reading a word of it.
 *
 * The header is ONE card rather than a stack: whose list this is, how many rows it
 * holds, and the two axes it narrows on (what kind of indent, what the outcome was).
 * The filters used to sit loose on the page under a card carrying nothing but a
 * search box, which read as three unrelated controls stacked above a table.
 */

type IndentKind = "ALL" | "REGULAR" | "MONTHLY";

interface DecisionMeta {
  label: string;
  icon: LucideIcon;
  /** The badge in the decision column. */
  chip: string;
  /** The square tile at the head of the row. */
  tile: string;
  /** The rail down the left of a phone card. */
  bar: string;
  /** The filter chip while it is the one that is on. */
  on: string;
}

const DECISION_META: Record<string, DecisionMeta> = {
  APPROVED: {
    label: "Approved", icon: CheckCircle2,
    chip: "bg-ok-bg text-ok", tile: "bg-ok-bg text-ok", bar: "bg-ok",
    on: "bg-ok-bg text-ok ring-ok/40",
  },
  RETURNED: {
    label: "Returned", icon: RotateCcw,
    chip: "bg-warn-bg text-warn", tile: "bg-warn-bg text-warn", bar: "bg-warn",
    on: "bg-warn-bg text-warn ring-warn/40",
  },
  REJECTED: {
    label: "Denied", icon: XCircle,
    chip: "bg-bad-bg text-bad", tile: "bg-bad-bg text-bad", bar: "bg-bad",
    on: "bg-bad-bg text-bad ring-bad/40",
  },
};

function decisionMeta(value: string): DecisionMeta {
  return DECISION_META[value] ?? {
    label: value.replace(/_/g, " "), icon: History,
    chip: "bg-neutral-bg text-neutral", tile: "bg-neutral-bg text-neutral",
    bar: "bg-neutral", on: "bg-neutral-bg text-neutral ring-neutral/40",
  };
}

/** The outcome filter. "All" wears the brand; the other three wear the outcome they
 *  select, taken from the table above so a chip's label cannot drift from a badge. */
const decisionOptions: Array<{ value: string; label: string; icon: LucideIcon; on: string }> = [
  { value: "", label: "All", icon: History, on: "bg-brand-050 text-brand ring-brand/40" },
  ...(["APPROVED", "RETURNED", "REJECTED"] as const).map((key) => ({
    value: key as string,
    label: DECISION_META[key].label,
    icon: DECISION_META[key].icon,
    on: DECISION_META[key].on,
  })),
];

const kindOptions: Array<{ value: IndentKind; label: string }> = [
  { value: "ALL", label: "All indents" },
  { value: "REGULAR", label: "Regular" },
  { value: "MONTHLY", label: "Monthly/Consolidation" },
];

/** An STR rides the INDENT workflow, so it lands on this list too — and is named as
 *  what it is rather than passing for a regular indent. */
const typeLabel = (row: ApprovalDecisionRow) =>
  row.indent_type === "MONTHLY" ? "Monthly/Consolidation"
    : row.indent_type === "STR" ? "Stock transfer request"
    : "Regular";

/** Where the row goes, said on the button.
 *
 *  One press on the Consolidation screen signs a whole month, and every indent in
 *  it writes its own row here — six on the live database, nine hundred at the scale
 *  this was sized for — so a monthly page of this list is the same decision over
 *  and over. Each of those rows opens the CYCLE ledger, which is the roll-up of all
 *  of them; saying "View decision" on it promised one document and delivered the
 *  month, which reads as the wrong page having loaded. */
const openLabel = (row: ApprovalDecisionRow) =>
  row.indent_type === "MONTHLY" ? "View cycle" : "View decision";

function exportExcel(rows: ApprovalDecisionRow[]) {
  const sheet = XLSX.utils.json_to_sheet(rows.map((row) => ({
    "Decision date": row.decision_at ? new Date(row.decision_at).toLocaleString() : "",
    "Indent number": row.doc_no ?? `#${row.doc_id}`,
    Type: typeLabel(row),
    "Approval stage": row.stage_name ?? `Stage ${row.stage_sequence}`,
    Decision: row.decision,
    Comments: row.comments ?? "",
    Requester: row.requester ?? "",
    "Workflow status": row.workflow_status,
  })));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Indent Decisions");
  XLSX.writeFile(workbook, "my-indent-decisions.xlsx");
}

/** The view switch — one of three, so it reads as a switch and not as a filter. */
function Segment<T extends string>({
  value, options, onChange, ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex w-full flex-wrap gap-1 rounded-full border border-line bg-content2 p-1 sm:w-auto"
    >
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`min-h-10 flex-1 whitespace-nowrap rounded-full px-3.5 text-sm font-semibold transition-colors sm:flex-none ${
              active
                ? "bg-content1 text-ink shadow-sm ring-1 ring-line"
                : "text-muted hover:text-ink"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** The outcome filter, each chip wearing the colour of the outcome it selects. */
function OutcomeChips({
  value, onChange, ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap gap-1.5">
      {decisionOptions.map((option) => {
        const Icon = option.icon;
        const active = value === option.value;
        return (
          <button
            key={option.value || "ALL"}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`inline-flex min-h-10 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold ring-1 transition ${
              active
                ? `${option.on} shadow-sm`
                : "bg-content1 text-muted ring-line hover:bg-content2 hover:text-ink"
            }`}
          >
            <Icon className="h-4 w-4" />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function HeaderDeck({
  search, setSearch, decidedCount, kind, setKind, decision, setDecision,
}: {
  search: string;
  setSearch: (value: string) => void;
  decidedCount: number;
  kind: IndentKind;
  setKind: (value: IndentKind) => void;
  decision: string;
  setDecision: (value: string) => void;
}) {
  return (
    <Card className="mb-4 overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-050 text-brand">
          <FileSearch className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display text-[15px] font-bold text-ink">Approver decision workspace</p>
          <p className="text-xs text-muted">
            Indents you approved, reduced, denied, or returned for correction.
          </p>
        </div>
        <div className="flex items-baseline gap-2 rounded-xl bg-content2 px-3.5 py-2">
          <span className="tabular font-display text-2xl font-bold leading-none text-ink">
            {decidedCount}
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Decided
          </span>
        </div>
      </div>

      <div className="h-px bg-line" />

      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-[240px] flex-1">
            <Input
              aria-label="Search indent decisions"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search indent number, requester, stage, note"
            />
          </div>
          <Segment<IndentKind>
            ariaLabel="Indent type"
            value={kind}
            onChange={setKind}
            options={kindOptions}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <OutcomeChips ariaLabel="Decision result" value={decision} onChange={setDecision} />
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <Search className="h-3.5 w-3.5" />
            Use search with the type and decision filters for large indent histories.
          </p>
        </div>
      </div>
    </Card>
  );
}

function DecisionBadge({ value }: { value: string }) {
  const meta = decisionMeta(value);
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${meta.chip}`}>
      <Icon className="h-3.5 w-3.5" />
      {meta.label}
    </span>
  );
}

/** The indent, with its outcome as a tile so a page of history scans on colour. */
function IndentCell({ row }: { row: ApprovalDecisionRow }) {
  const meta = decisionMeta(row.decision);
  const Icon = meta.icon;
  return (
    <div className="flex items-center gap-3">
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${meta.tile}`}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p className="mono truncate text-sm font-bold text-ink">{row.doc_no ?? `#${row.doc_id}`}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span className="rounded border border-line bg-content2 px-1.5 py-px font-semibold text-body">
            {typeLabel(row)}
          </span>
          {row.requester ? `raised by ${row.requester}` : null}
        </p>
      </div>
    </div>
  );
}

function WhenCell({ value }: { value?: string | null }) {
  return (
    <div className="leading-tight">
      <p className="text-sm font-medium text-ink">{fmtDate(value)}</p>
      <p className="text-xs text-muted">{fmtTime(value)}</p>
    </div>
  );
}

function DecidedRows({
  rows, loading, onOpen,
}: {
  rows: ApprovalDecisionRow[];
  loading: boolean;
  onOpen: (row: ApprovalDecisionRow) => void;
}) {
  const columns: Column<ApprovalDecisionRow>[] = [
    { key: "indent", header: "Indent", render: (row) => <IndentCell row={row} /> },
    {
      key: "decision", header: "Your decision", render: (row) => <DecisionBadge value={row.decision} />,
    },
    {
      key: "stage", header: "Stage", hideOnNarrow: true, render: (row) => (
        <span className="inline-flex items-center rounded-md border border-line bg-content2 px-2 py-1 text-xs font-semibold text-body">
          {row.stage_name ?? `Stage ${row.stage_sequence}`}
        </span>
      ),
    },
    {
      key: "status", header: "Current status", render: (row) => <StatusPill status={row.workflow_status} />,
    },
    {
      key: "when", header: "When", hideOnNarrow: true, render: (row) => <WhenCell value={row.decision_at} />,
    },
    {
      key: "action", header: "", className: "w-[150px] text-right", render: (row) => (
        <Button variant="ghost" onClick={() => onOpen(row)}>
          {openLabel(row)} <ChevronRight className="h-4 w-4" />
        </Button>
      ),
    },
  ];
  return (
    <ResponsiveList
      data={rows}
      loading={loading}
      keyOf={(row) => row.id}
      columns={columns}
      onRowClick={onOpen}
      empty="You have not decided any indent approvals yet."
      renderCard={(row) => <DecisionCard row={row} onOpen={() => onOpen(row)} />}
    />
  );
}

/** The phone card. Same colour language and the same order of facts as the row. */
function DecisionCard({ row, onOpen }: { row: ApprovalDecisionRow; onOpen: () => void }) {
  const meta = decisionMeta(row.decision);
  return (
    <div className="relative space-y-3 pl-3">
      <span aria-hidden="true" className={`absolute left-0 top-0 h-full w-1 rounded-full ${meta.bar}`} />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="mono text-sm font-bold text-ink">{row.doc_no ?? `#${row.doc_id}`}</p>
          <p className="text-xs text-muted">
            {typeLabel(row)}
            {row.requester ? ` - raised by ${row.requester}` : ""}
          </p>
        </div>
        <DecisionBadge value={row.decision} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={row.workflow_status} />
        <span className="rounded-md border border-line bg-content2 px-2 py-1 text-xs font-semibold text-body">
          {row.stage_name ?? `Stage ${row.stage_sequence}`}
        </span>
      </div>
      <WhenCell value={row.decision_at} />
      <Button variant="soft" onClick={onOpen}>
        {openLabel(row)} <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

export function MyDecisionsPage() {
  const nav = useNavigate();
  const [search, setSearch] = useState("");
  const [decision, setDecision] = useState("");
  const [kind, setKind] = useState<IndentKind>("ALL");
  const [page, setPage] = useState(1);
  const size = 20;

  const decided = useQuery({
    queryKey: ["approvals", "my-decisions", "decided", page, size, search, decision],
    queryFn: () => approvalsApi.decisions(page, size, {
      search: search.trim(), decision, doc_type: "INDENT",
    }),
  });

  useEffect(() => setPage(1), [decision, search, kind]);

  const decidedRows = useMemo(() => {
    const rows = decided.data?.items ?? [];
    return rows.filter((row) => (
      kind === "ALL" || row.indent_type === kind
    ));
  }, [decided.data?.items, kind]);

  const openDecided = (row: ApprovalDecisionRow) => nav(approvalDecisionLedgerPath(row));

  return (
    <>
      <PageHeader
        eyebrow="Approvals"
        title="My Decisions"
        actions={
          <Button
            className={TONE_BLUE}
            variant="ghost"
            disabled={!decidedRows.length}
            onClick={() => exportExcel(decidedRows)}
          >
            <Download className="h-4 w-4" /> Export Excel
          </Button>
        }
      />
      <HeaderDeck
        search={search}
        setSearch={setSearch}
        decidedCount={decided.data?.total ?? 0}
        kind={kind}
        setKind={setKind}
        decision={decision}
        setDecision={setDecision}
      />
      <ErrorBanner error={decided.error} />
      {!decided.error && (
        <DecidedRows rows={decidedRows} loading={decided.isLoading} onOpen={openDecided} />
      )}
      {!decided.error && (
        <ApprovalPager
          page={page}
          size={size}
          total={decided.data?.total ?? 0}
          onPage={setPage}
        />
      )}
    </>
  );
}
