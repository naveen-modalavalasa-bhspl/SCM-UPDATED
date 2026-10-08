import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  BarChart3, CheckCircle2, ChevronRight, ClipboardList, Download, FileText,
  History, MinusCircle, Package, Truck, Undo2, XCircle,
} from "lucide-react";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import type { LucideIcon } from "lucide-react";
import * as XLSX from "xlsx";
import {
  Button, Card, ErrorBanner, Input, PageHeader, ResponsiveList, StatusPill, type Column,
} from "@/shared/components";
import { fmtDate, fmtRelative, fmtTime } from "@/shared/datetime";
import { approvalsApi } from "../api";
import { displayDocType, rowDocTypeLabel } from "../docTypes";
import { approvalDecisionDocumentPath, approvalDecisionLedgerPath } from "../documentRoutes";
import type { ApprovalDecisionExclusion, ApprovalDecisionRow } from "../types";
import { ApprovalPager } from "../components/Pager";
import { TONE_BLUE } from "@/shared/components/tones";

/* ---------------------------------------------------------------------------
 * My Decisions — the approver's own ledger.
 *
 * Read by people who never file a ticket in their life: a store keeper, a
 * district manager, a plant head. So a row reads as one short statement — what
 * you did, where you did it, what became of it — and no two cells on it say the
 * same thing twice. The raw status still sits there on a StatusPill, so the row
 * agrees with every other screen in the app.
 *
 * Nothing here writes. The redesign changed no data, no filter, no endpoint: it
 * is the same three pieces of state (search, decision, page) over the same
 * `/api/approvals/my-decisions` call, drawn differently.
 * ------------------------------------------------------------------------- */

/**
 * One glyph and one tint per document FAMILY — a request, a buying document,
 * something moving stock, something on the road. The approvals queue reads the
 * same four families, so a document looks like itself on both screens.
 */
const FAMILY: Record<string, { icon: LucideIcon; tint: string }> = {
  INDENT: { icon: ClipboardList, tint: "bg-brand-050 text-brand" },
  MR: { icon: ClipboardList, tint: "bg-brand-050 text-brand" },
  CONSOLIDATION: { icon: ClipboardList, tint: "bg-brand-050 text-brand" },
  REQUISITION: { icon: FileText, tint: "bg-info-bg text-info" },
  RFQ: { icon: FileText, tint: "bg-info-bg text-info" },
  PO: { icon: FileText, tint: "bg-info-bg text-info" },
  ALLOCATION: { icon: Package, tint: "bg-ok-bg text-ok" },
  OWN_STOCK_ALLOCATION: { icon: Package, tint: "bg-ok-bg text-ok" },
  ISSUE: { icon: Package, tint: "bg-ok-bg text-ok" },
  WH_ISSUE: { icon: Package, tint: "bg-ok-bg text-ok" },
  OWN_STOCK_ISSUE: { icon: Package, tint: "bg-ok-bg text-ok" },
  GRN: { icon: Package, tint: "bg-ok-bg text-ok" },
  PURCHASE_RETURN: { icon: Package, tint: "bg-ok-bg text-ok" },
  QC_OUTWARD: { icon: Package, tint: "bg-ok-bg text-ok" },
  DISPATCH: { icon: Truck, tint: "bg-warn-bg text-warn" },
  TRANSPORT_REQUEST: { icon: Truck, tint: "bg-warn-bg text-warn" },
  CARRIER_AWARD: { icon: Truck, tint: "bg-warn-bg text-warn" },
};

const family = (docType: string) =>
  FAMILY[docType] ?? { icon: FileText, tint: "bg-neutral-bg text-neutral" };

/** The three decisions this ledger can hold, said out loud. */
const DECISION: Record<string, {
  label: string; icon: LucideIcon; chip: string; rail: string;
}> = {
  APPROVED: {
    label: "Approved", icon: CheckCircle2, chip: "bg-ok-bg text-ok", rail: "bg-ok",
  },
  RETURNED: {
    label: "Sent back", icon: Undo2, chip: "bg-warn-bg text-warn", rail: "bg-warn",
  },
  REJECTED: {
    label: "Rejected", icon: XCircle, chip: "bg-bad-bg text-bad", rail: "bg-bad",
  },
};

const decisionMeta = (value: string) => DECISION[value] ?? {
  label: value.replace(/_/g, " "), icon: History,
  chip: "bg-neutral-bg text-neutral", rail: "bg-neutral",
};

/**
 * What became of the document AFTER this decision.
 *
 * NOT a second reading of the status chip beside it — that would print the word
 * "approved" twice on the same row, which is what the first cut of this screen
 * did. The chip says where the document IS; this says what that means for the
 * decision you made. The line worth reading is the one where the two differ: you
 * approved and it was turned down higher up, or you sent it back and it came
 * through in the end. An approver's own ledger is the only place that shows.
 */
function aftermath(decision: string, status: string): string {
  const mine = status === decision;
  if (status === "CANCELLED") return "Withdrawn by the raiser";
  if (status === "IN_PROGRESS") return "Still in approval";
  if (status === "APPROVED") return mine ? "Cleared to the end" : "Approved after your step";
  if (status === "REJECTED") return mine ? "Stopped here" : "Turned down after your step";
  return "—";
}

/** How long the document waited on this approver — never a bare decimal, and
 *  never a whole clause: it sits at the tail of a line that already runs long. */
function turnaround(hours?: number | null): string | null {
  if (hours === null || hours === undefined) return null;
  const minutes = Math.round(hours * 60);
  if (minutes < 1) return "decided at once";
  if (minutes < 60) return `took ${minutes} min`;
  if (hours < 48) return `took ${Math.round(hours)} h`;
  return `took ${Math.round(hours / 24)} days`;
}

/** The lines this approver left out when they signed, if any.
 *
 *  An exclusion is part of the DECISION, not of the document that follows it: the
 *  indent screen shows the dropped line at zero and never says who took it out. So
 *  the ledger carries it, and a row that has one does not send the reader off to an
 *  indent to work it out for themselves.
 */
const exclusionsOf = (row: ApprovalDecisionRow): ApprovalDecisionExclusion[] =>
  row.excluded_items ?? [];

const exclusionLabel = (line: ApprovalDecisionExclusion) =>
  line.item_name ?? line.item_code ?? `Line #${line.line_id}`;

/** Quantities come off the wire as numbers; drop a trailing `.000` so a countable
 *  item reads as 10 rather than 10.000. Same shape the consolidation screen uses. */
const formatQty = (value: number) =>
  Number.isFinite(value) ? String(Number(value.toFixed(3))) : "—";

/** The chip that says something was left out. Same words and same warn tint as the
 *  Excluded column on the consolidation screen — one exclusion, one look. */
function ExcludedChip({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-warn-bg px-2.5 py-1 text-xs font-bold text-warn">
      <MinusCircle className="h-3.5 w-3.5" />
      {count} item{count === 1 ? "" : "s"} excluded
    </span>
  );
}

/** The buttons that stand in for the decision dropdown. Same values, all visible. */
const DECISION_FILTERS: Array<{ value: string; label: string; icon: LucideIcon }> = [
  { value: "", label: "All", icon: History },
  { value: "APPROVED", label: "Approved", icon: CheckCircle2 },
  { value: "RETURNED", label: "Sent back", icon: Undo2 },
  { value: "REJECTED", label: "Rejected", icon: XCircle },
];

/** `21 Aug 2026` split into its parts, so the date can be drawn as a calendar chip.
 *  Read off the shared IST formatter — the clock is never re-implemented here. */
function dayParts(value?: string | null) {
  const [day, month] = fmtDate(value, "").split(" ");
  return day && month ? { day, month } : null;
}

function exportExcel(rows: ApprovalDecisionRow[]) {
  const sheet = XLSX.utils.json_to_sheet(rows.map((row) => ({
    "Decision date": row.decision_at ? new Date(row.decision_at).toLocaleString() : "",
    "Document type": displayDocType(row),
    "Document number": row.doc_no ?? `#${row.doc_id}`,
    "Approval stage": row.stage_name ?? `Stage ${row.stage_sequence}`,
    Decision: row.decision,
    Comments: row.comments ?? "",
    Requester: row.requester ?? "",
    "Workflow status": row.workflow_status,
    Excluded: (row.excluded_items ?? [])
      .map((line) => `${exclusionLabel(line)} (${formatQty(line.requested_quantity)}${
        line.uom_code ? ` ${line.uom_code}` : ""})`)
      .join("; "),
  })));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "My Decisions");
  XLSX.writeFile(workbook, "my-approval-decisions.xlsx");
}

/** The date, drawn the way a desk calendar draws it, on a rail coloured by the
 *  decision — so the shape of a month's work is readable down the left edge. */
function WhenCell({ row }: { row: ApprovalDecisionRow }) {
  const parts = dayParts(row.decision_at);
  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden="true"
        className={`h-11 w-1 shrink-0 rounded-full ${decisionMeta(row.decision).rail}`}
      />
      <span className="flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-xl border border-line bg-content2">
        {parts ? (
          <>
            <span className="tabular font-display text-[15px] font-bold leading-none text-ink">
              {parts.day}
            </span>
            <span className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
              {parts.month}
            </span>
          </>
        ) : (
          <span className="text-muted">—</span>
        )}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">{fmtTime(row.decision_at)}</p>
        <p className="text-xs text-muted">{fmtRelative(row.decision_at)}</p>
      </div>
    </div>
  );
}

/** Which document it was — the number, and what that number means. */
function DocumentCell({ row }: { row: ApprovalDecisionRow }) {
  const { icon: Icon, tint } = family(row.doc_type);
  return (
    <div className="flex items-start gap-3">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tint}`}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p className="mono text-[13px] font-semibold text-ink">
          {row.doc_no ?? `#${row.doc_id}`}
        </p>
        <p className="truncate text-xs text-muted">
          {rowDocTypeLabel(row)}
          {row.requester ? ` · raised by ${row.requester}` : ""}
        </p>
      </div>
    </div>
  );
}

/** The stamp: what this approver did, at which step, and how quickly.
 *
 *  One word, not a sentence. "You approved this" wrapped onto two lines in every
 *  row of the table and only repeated the column heading, which already says
 *  what you did — so the heading carries the voice and the chip carries the verb.
 */
function DecisionCell({ row }: { row: ApprovalDecisionRow }) {
  const meta = decisionMeta(row.decision);
  const Icon = meta.icon;
  const took = turnaround(row.duration_hours);
  const stage = row.stage_name ?? `Stage ${row.stage_sequence}`;
  const excluded = exclusionsOf(row);
  return (
    <div className="space-y-1.5">
      <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-bold ${meta.chip}`}>
        <Icon className="h-3.5 w-3.5" />
        {meta.label}
      </span>
      <p className="line-clamp-2 text-xs text-muted" title={stage}>
        as {stage}{took ? ` · ${took}` : ""}
      </p>
      {excluded.length > 0 && <ExcludedChip count={excluded.length} />}
    </div>
  );
}

/** What was left out, item by item — the panel behind a row that excluded something.
 *  Deliberately a list and nothing else: the ledger is a record, and every action on
 *  these items belongs to the document, not to the decision that is already signed. */
function ExclusionList({ lines }: { lines: ApprovalDecisionExclusion[] }) {
  return (
    <ul className="divide-y divide-line rounded-xl border border-line">
      {lines.map((line) => (
        <li key={line.line_id} className="flex items-start justify-between gap-3 p-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">{exclusionLabel(line)}</p>
            {line.item_code && <p className="mono text-xs text-muted">{line.item_code}</p>}
          </div>
          <div className="shrink-0 text-right">
            <p className="tabular text-sm font-semibold text-warn">
              {formatQty(line.requested_quantity)}{line.uom_code ? ` ${line.uom_code}` : ""}
            </p>
            <p className="text-xs text-muted">left out</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The note, quoted the way a margin note is quoted — a rule down the side, not
 *  a glyph. An empty one is a dash: "No note left" on two rows in three is a
 *  sentence the eye has to read before it can skip it. */
function NoteCell({ row }: { row: ApprovalDecisionRow }) {
  if (!row.comments) return <span className="text-muted">—</span>;
  return (
    <p
      className="line-clamp-2 border-l-2 border-line pl-2.5 text-sm italic text-body"
      title={row.comments}
    >
      {row.comments}
    </p>
  );
}

/** Where the document stands — the status, then what it means for YOUR decision. */
function OutcomeCell({ row }: { row: ApprovalDecisionRow }) {
  return (
    <div className="space-y-1.5">
      <StatusPill status={row.workflow_status} />
      <p className="text-xs text-muted">{aftermath(row.decision, row.workflow_status)}</p>
    </div>
  );
}

export function MyDecisionsPage() {
  const nav = useNavigate();
  const [search, setSearch] = useState("");
  const [decision, setDecision] = useState("");
  const [page, setPage] = useState(1);
  const size = 20;
  const query = useQuery({ queryKey: ["approvals", "decisions", page, size, search, decision], queryFn: () => approvalsApi.decisions(page, size, { search: search.trim(), decision }) });
  useEffect(() => setPage(1), [decision, search]);
  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (query.data?.items ?? []).filter((row) => (!decision || row.decision === decision)
      && (!term || [row.doc_no, row.requester, row.comments, row.doc_type]
        .some((value) => String(value ?? "").toLowerCase().includes(term))));
  }, [decision, query.data?.items, search]);
  // A row that left something out opens its own panel rather than the document: the
  // question being asked of this screen is "what did I exclude", and the indent shows
  // the dropped line as a zero with nothing to say who zeroed it. Every other row is
  // unchanged — straight to the document, as before.
  const [detail, setDetail] = useState<ApprovalDecisionRow | null>(null);
  const openDocument = (row: ApprovalDecisionRow) => nav(
    row.doc_type === "INDENT"
      ? approvalDecisionLedgerPath(row)
      : approvalDecisionDocumentPath(row),
  );
  const openDecision = (row: ApprovalDecisionRow) => {
    if (row.doc_type !== "INDENT" && exclusionsOf(row).length > 0) setDetail(row);
    else openDocument(row);
  };
  const filtered = Boolean(decision || search.trim());
  const total = query.data?.total ?? 0;

  const columns: Column<ApprovalDecisionRow>[] = [
    {
      key: "date", header: "When", className: "w-[210px] align-middle",
      render: (row) => <WhenCell row={row} />,
    },
    {
      key: "document", header: "Document", className: "w-[250px] align-middle",
      render: (row) => <DocumentCell row={row} />,
    },
    {
      key: "decision", header: "What you did", className: "w-[230px] align-middle",
      render: (row) => <DecisionCell row={row} />,
    },
    {
      key: "comments", header: "Your note", hideOnNarrow: true,
      className: "align-middle",
      render: (row) => <NoteCell row={row} />,
    },
    {
      key: "status", header: "Where it stands", className: "w-[190px] align-middle",
      render: (row) => <OutcomeCell row={row} />,
    },
    {
      key: "action", header: "", className: "w-[150px] text-right align-middle",
      render: (row) => (
        <Button variant="ghost" onClick={() => openDecision(row)}>
          {row.doc_type === "INDENT" ? "View decision" : exclusionsOf(row).length > 0 ? "View excluded" : "View details"}
          <ChevronRight className="h-4 w-4" />
        </Button>
      ),
    },
  ];

  return <>
    <PageHeader
      eyebrow="Approvals"
      title="My Decisions"
      actions={<div className="flex gap-2">
        <Button variant="ghost" onClick={() => nav("/approvals?view=reports")}><BarChart3 className="h-4 w-4" /> Reports</Button>
        <Button className={TONE_BLUE} variant="ghost" disabled={!rows.length} onClick={() => exportExcel(rows)}><Download className="h-4 w-4" /> Export Excel</Button>
      </div>}
    />

    {/* The deck: what this page is, how many rows are in it, and the two ways to
      * narrow it. One card rather than a sentence, a card and a dropdown — the
      * count and the filters are answers to the same question. */}
    <Card className="mb-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-050 text-brand">
            <History className="h-5 w-5" />
          </span>
          <div>
            <p className="font-display text-[15px] font-bold text-ink">Your decision ledger</p>
            <p className="text-xs text-muted">
              Every approval you have signed, kept permanently. Nothing here can be changed.
            </p>
          </div>
        </div>
        <div className="text-right">
          <p className="tabular font-display text-[26px] font-bold leading-none text-ink">{total}</p>
          <p className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
            {filtered ? "matching" : "on record"}
          </p>
        </div>
      </div>

      <div className="my-4 h-px bg-line" />

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
        <Input
          aria-label="Search decisions"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by document number, who raised it, or your note"
        />
        {/* A dropdown hid three of the four choices behind a click. Four buttons
          * show every answer at once, which is the whole filter for somebody who
          * does not know that RETURNED is the word to go looking for. */}
        <div role="group" aria-label="Filter by decision" className="flex flex-wrap gap-1 rounded-xl border border-line bg-content2 p-1">
          {DECISION_FILTERS.map((option) => {
            const Icon = option.icon;
            const active = decision === option.value;
            return (
              <button
                key={option.value || "ALL"}
                type="button"
                aria-pressed={active}
                onClick={() => setDecision(option.value)}
                className={`inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold transition-colors lg:flex-none ${
                  active ? "bg-content1 text-brand shadow-sm" : "text-muted hover:text-ink"
                }`}
              >
                <Icon className="h-4 w-4" />
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
    </Card>

    <ErrorBanner error={query.error} />

    {!query.error && <ResponsiveList
      data={rows}
      loading={query.isLoading}
      keyOf={(row) => row.id}
      columns={columns}
      onRowClick={openDecision}
      empty={filtered
        ? "No decision matches what you are looking for. Clear the search, or choose All."
        : "You have not made an approval decision yet. Once you approve something, it is recorded here for good."}
      renderCard={(row) => {
        const meta = decisionMeta(row.decision);
        const Icon = meta.icon;
        const { icon: DocIcon, tint } = family(row.doc_type);
        const took = turnaround(row.duration_hours);
        const excluded = exclusionsOf(row);
        return (
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tint}`}>
                <DocIcon className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="mono text-[13px] font-semibold text-ink">{row.doc_no ?? `#${row.doc_id}`}</p>
                <p className="truncate text-xs text-muted">
                  {rowDocTypeLabel(row)}
                  {row.requester ? ` · raised by ${row.requester}` : ""}
                </p>
              </div>
            </div>
            <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-bold ${meta.chip}`}>
              <Icon className="h-3.5 w-3.5" />
              {meta.label}
            </span>
            <p className="text-xs text-muted">
              as {row.stage_name ?? `Stage ${row.stage_sequence}`}
              {took ? ` · ${took}` : ""}
            </p>
            {excluded.length > 0 && <ExcludedChip count={excluded.length} />}
            {row.comments && (
              <p className="border-l-2 border-line pl-2.5 text-sm italic text-body">
                {row.comments}
              </p>
            )}
            <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
              <div>
                <p className="text-sm font-medium text-body">
                  {aftermath(row.decision, row.workflow_status)}
                </p>
                <p className="text-xs text-muted">{fmtDate(row.decision_at)} · {fmtTime(row.decision_at)}</p>
              </div>
              <StatusPill status={row.workflow_status} />
            </div>
            <Button variant="soft" onClick={() => openDecision(row)}>
              {row.doc_type === "INDENT" ? "View decision" : excluded.length > 0 ? "View excluded" : "View details"}
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        );
      }}
    />}

    {!query.error && <ApprovalPager page={page} size={size} total={total} onPage={setPage} />}

    {/* What was excluded on this decision. The document is still one press away —
      * the panel answers the question first rather than instead. */}
    <Modal
      isOpen={Boolean(detail)}
      onClose={() => setDetail(null)}
      size="lg"
      scrollBehavior="inside"
      classNames={{ base: "rounded-2xl border border-line/70" }}
    >
      <ModalContent>
        <ModalHeader className="flex flex-col items-start gap-1 pb-2">
          <span className="mono text-[13px] font-semibold text-ink">
            {detail?.doc_no ?? (detail ? `#${detail.doc_id}` : "")}
          </span>
          <span className="text-xs font-normal text-muted">
            {detail ? rowDocTypeLabel(detail) : ""}
            {detail?.requester ? ` · raised by ${detail.requester}` : ""}
          </span>
        </ModalHeader>
        <ModalBody className="pt-0">
          <p className="text-[13px] leading-5 text-muted">
            You approved this on {fmtDate(detail?.decision_at)} and left the following
            out of it. The rest of the document went on at the quantities you signed.
          </p>
          {detail && <ExclusionList lines={exclusionsOf(detail)} />}
        </ModalBody>
        <ModalFooter className="pt-2">
          <Button variant="subtle" onClick={() => setDetail(null)}>Close</Button>
          <Button
            variant="soft"
            onClick={() => { const row = detail; setDetail(null); if (row) openDocument(row); }}
          >
            Open document<ChevronRight className="h-4 w-4" />
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  </>;
}
