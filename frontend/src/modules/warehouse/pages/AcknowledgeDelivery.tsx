import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Chip } from "@heroui/react";
import { CheckCircle2, Forward, ScanLine } from "lucide-react";
import { Button, Can, Card, ConfirmModal, ErrorBanner, Field, Input, PageHeader, StatusPill } from "@/shared/components";
import { MetaCard, MetaRow, Section } from "../components/DocumentMeta";
import { LinesEditor, QtyInput, type LineColumn } from "../components/LinesEditor";
import { AttachmentsPanel } from "../components/AttachmentsPanel";
import { Timeline, toTimeline } from "../components/Timeline";
import { acknowledgeDispatch, forwardDispatch, getDispatch, listDispatches, scanCode } from "../api";
import { fmtDate, fmtQty, num } from "../format";
import { alerts } from "@/modules/alerts";
import type { DispatchItem } from "../types";
import { usePointLabel } from "../usePointLabel";
import { CombinationTag } from "@/shared/combination";

/**
 * The receiving end: confirm what actually turned up.
 *
 * Delivered quantity is entered per line rather than accepted wholesale, because
 * "acknowledged" on a consignment that arrived two cartons short is exactly the
 * record that makes a shortage unprovable later. A line that comes up short is
 * highlighted and the difference is carried into the acknowledgement.
 *
 * The scan box takes a package QR or a dispatch number and opens the consignment, so
 * a receiver with a phone never types a document number.
 */
export default function AcknowledgeDelivery() {
  const pointLabel = usePointLabel();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [dispatchId, setDispatchId] = useState<number | null>(null);
  const [scan, setScan] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);
  const [delivered, setDelivered] = useState<Record<number, number>>({});
  const [by, setBy] = useState("");
  const [remarks, setRemarks] = useState("");
  const [confirming, setConfirming] = useState(false);

  /* `inbound` is the whole scoping rule and it belongs on the server: the ordinary
   * dispatch scope is keyed on the SENDING dock, so asking for a plain page here put
   * every consignment in the company in front of a wide-scope login and offered them
   * the signature for goods arriving at a point they are nowhere near. It also came
   * back as the first 100 rows filtered afterwards in the browser, so once there were
   * more than 100 consignments a genuinely inbound one could simply fall off the end. */
  const { data: open = [] } = useQuery({
    queryKey: ["wh-dispatches-inbound"],
    queryFn: async () => (await listDispatches({ size: 100, inbound: true })).items,
  });

  const { data: doc, isLoading, error } = useQuery({
    queryKey: ["wh-dispatch", String(dispatchId)],
    queryFn: () => getDispatch(dispatchId as number),
    enabled: !!dispatchId,
  });

  useEffect(() => {
    if (!doc) return;
    setDelivered(
      Object.fromEntries(
        (doc.items ?? []).map((l) => [l.id, num(l.delivered_qty) || num(l.quantity)]),
      ),
    );
  }, [doc]);

  /** A package QR is `dispatch_no|package_no`; the backend resolves either form. */
  const resolve = async (code: string) => {
    const value = code.trim();
    if (!value) return;
    try {
      const hit = await scanCode(value.split("|")[0]);
      if (hit.kind !== "DISPATCH") {
        setScanError(`That code is a ${hit.kind.toLowerCase()}, not a consignment.`);
        return;
      }
      setDispatchId(hit.id);
      setScan("");
      setScanError(null);
    } catch (e) {
      setScanError(e instanceof Error ? e.message : "Could not find that code.");
    }
  };

  const acknowledge = useMutation({
    mutationFn: () =>
      acknowledgeDispatch(dispatchId as number, {
        acknowledged_by_name: by || null,
        remarks: remarks || null,
        lines: Object.entries(delivered).map(([lineId, qty]) => ({ id: Number(lineId), delivered_qty: qty })),
      }),
    onSuccess: () => {
      void alerts.success("issue.acknowledged", { number: doc?.dispatch_no ?? "The delivery" });
      qc.invalidateQueries({ queryKey: ["wh-dispatch", String(dispatchId)] });
      qc.invalidateQueries({ queryKey: ["wh-dispatches"] });
      qc.invalidateQueries({ queryKey: ["wh-dispatches-inbound"] });
      setConfirming(false);
    },
  });

  /**
   * The relay hop. This consignment was addressed to a point on the way to the
   * requester, not to the requester's own LIP, and this point does not run a receiving
   * desk — the stock went on the shelf the moment it was acknowledged, so there is no
   * GRN to forward from. The backend answers `can_forward` for exactly that case.
   */
  const forward = useMutation({
    mutationFn: () => forwardDispatch(dispatchId as number),
    onSuccess: (drafts) => {
      const made = drafts ?? [];
      if (made.length === 0) {
        void alerts.info("issue.forwarded_none");
        return;
      }
      void alerts.success("issue.forwarded", {
        number: made.map((d) => d.issue_no).filter(Boolean).join(", "),
      });
      qc.invalidateQueries({ queryKey: ["wh-dispatch", String(dispatchId)] });
      qc.invalidateQueries({ queryKey: ["wh-issues-OUT"] });
      nav("/warehouse/transactions/material-issues");
    },
  });

  const lines = doc?.items ?? [];
  const shortLines = lines.filter((l) => (delivered[l.id] ?? num(l.quantity)) < num(l.quantity));
  const done = doc?.status === "ACKNOWLEDGED";

  /* A serial-tracked item is one dispatch LINE per unit, so ten swabs in one carton
   * arrive as ten rows of "1 NOS" — ten identical item names and ten boxes to type
   * into for a single package the receiver opens once. The document is right; listing
   * it that way is not what anyone counts.
   *
   * So the default view is one row per item and batch, carrying the lines it stands
   * for. Batch is part of the key because two batches of the same item are two things
   * to count, whatever the packing list did with them.
   *
   * The per-serial view stays one press away, and it is not decoration: a group that
   * comes up short says how many are missing but not WHICH, and on serialised stock
   * that difference is the whole record. Whoever is short opens the serials and marks
   * the ones that did not turn up. */
  const groups = (() => {
    const out = new Map<string, { key: string; lines: typeof lines }>();
    for (const line of lines) {
      const key = `${line.item_id ?? line.item_code ?? "?"}|${line.batch_no ?? ""}`;
      const bucket = out.get(key) ?? { key, lines: [] };
      bucket.lines.push(line);
      out.set(key, bucket);
    }
    return [...out.values()];
  })();
  const grouped = groups.length < lines.length;
  const [bySerial, setBySerial] = useState(false);
  const expanded = bySerial || !grouped;

  const sentOf = (rows: typeof lines) => rows.reduce((t, l) => t + num(l.quantity), 0);
  const receivedOf = (rows: typeof lines) =>
    rows.reduce((t, l) => t + (delivered[l.id] ?? num(l.quantity)), 0);

  /** Spread a group's received count back over its lines, filling each in turn.
   *  Whole units, in packing-list order — the only defensible guess when the receiver
   *  gave a count and not a list. Marking specific units is what the serial view is
   *  for, and it overwrites this. */
  const spread = (rows: typeof lines, total: number) =>
    setDelivered((d) => {
      const next = { ...d };
      let left = total;
      for (const line of rows) {
        const take = Math.min(left, num(line.quantity));
        next[line.id] = take;
        left -= take;
      }
      return next;
    });

  type Group = { key: string; lines: DispatchItem[] };

  const groupColumns: LineColumn<Group>[] = [
    {
      key: "item",
      header: "Item",
      render: (g) => {
        const first = g.lines[0];
        return (
          <div className="min-w-0">
            <div className="truncate font-mono text-xs font-semibold text-ink">{first.item_code ?? "—"}</div>
            <div className="truncate text-xs text-muted">
              {first.item_name ?? "—"}
              {first.batch_no ? ` · ${first.batch_no}` : ""}
              {g.lines.length > 1 ? ` · ${g.lines.length} serials` : ""}
            </div>
            <CombinationTag value={first} className="mt-1" />
          </div>
        );
      },
    },
    {
      key: "sent",
      header: "Sent",
      numeric: true,
      width: "w-24",
      render: (g) => (
        <span className="tabular text-sm text-ink">
          {fmtQty(sentOf(g.lines))} {g.lines[0].uom_code ?? ""}
        </span>
      ),
    },
    {
      key: "delivered",
      header: "Received",
      numeric: true,
      width: "w-28",
      render: (g) => (
        <QtyInput
          ariaLabel={`Received quantity for ${g.lines[0].item_code ?? g.lines[0].item_id}`}
          uom={g.lines[0].uom_code}
          value={receivedOf(g.lines)}
          max={sentOf(g.lines)}
          disabled={done}
          onChange={(v) => spread(g.lines, v)}
        />
      ),
    },
    {
      key: "gap",
      header: "Short",
      numeric: true,
      width: "w-24",
      render: (g) => {
        const gap = sentOf(g.lines) - receivedOf(g.lines);
        return <span className={`tabular ${gap > 0 ? "font-semibold text-bad" : "text-muted"}`}>{fmtQty(gap)}</span>;
      },
    },
    {
      key: "serial",
      header: "Serial",
      hideOnNarrow: true,
      render: (g) => (
        <span className="font-mono text-xs text-muted">
          {g.lines.length === 1
            ? g.lines[0].serial_no ?? "—"
            : `${g.lines[0].serial_no ?? "—"} + ${g.lines.length - 1} more`}
        </span>
      ),
    },
  ];

  const columns: LineColumn<DispatchItem>[] = [
    {
      key: "item",
      header: "Item",
      render: (l) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-xs font-semibold text-ink">{l.item_code ?? "—"}</div>
          <div className="truncate text-xs text-muted">
            {l.item_name ?? "—"}
            {l.batch_no ? ` · ${l.batch_no}` : ""}
          </div>
          <CombinationTag value={l} className="mt-1" />
        </div>
      ),
    },
    {
      key: "sent",
      header: "Sent",
      numeric: true,
      width: "w-24",
      render: (l) => <span className="tabular text-sm text-ink">{fmtQty(l.quantity)} {l.uom_code ?? ""}</span>,
    },
    {
      key: "delivered",
      header: "Received",
      numeric: true,
      width: "w-28",
      render: (l) => (
        <QtyInput
          ariaLabel={`Received quantity for ${l.item_code ?? l.item_id}`}
          uom={l.uom_code}
          value={delivered[l.id] ?? num(l.quantity)}
          max={num(l.quantity)}
          disabled={done}
          onChange={(v) => setDelivered((d) => ({ ...d, [l.id]: v }))}
        />
      ),
    },
    {
      key: "gap",
      header: "Short",
      numeric: true,
      width: "w-24",
      render: (l) => {
        const gap = num(l.quantity) - (delivered[l.id] ?? num(l.quantity));
        return <span className={`tabular ${gap > 0 ? "font-semibold text-bad" : "text-muted"}`}>{fmtQty(gap)}</span>;
      },
    },
    {
      key: "serial",
      header: "Serial",
      hideOnNarrow: true,
      render: (l) => <span className="font-mono text-xs text-muted">{l.serial_no ?? "—"}</span>,
    },
  ];

  return (
    <div>
      <PageHeader eyebrow={pointLabel} title="Acknowledge delivery" />

      <Card className="mb-4 p-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="relative min-w-[260px] flex-1">
            <ScanLine className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              autoFocus
              value={scan}
              onChange={(e) => setScan(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void resolve(scan);
                }
              }}
              placeholder="Scan a package label or type a dispatch number"
              aria-label="Scan package or dispatch"
              className="min-h-11 w-full rounded-md border border-line bg-content1 pl-9 pr-3 text-sm text-ink outline-none placeholder:text-muted focus:border-brand"
            />
          </label>
        </div>

        {open.length > 0 && (
          <div className="mt-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
              On the way in
            </div>
            <div className="flex flex-wrap gap-2">
              {open.map((d) => (
                <button key={d.id} type="button" onClick={() => setDispatchId(d.id)}>
                  <Chip size="sm" variant={dispatchId === d.id ? "solid" : "flat"}
                        color={dispatchId === d.id ? "primary" : "default"}>
                    {d.dispatch_no} · {fmtDate(d.expected_delivery)}
                  </Chip>
                </button>
              ))}
            </div>
          </div>
        )}
      </Card>

      <ErrorBanner error={scanError ?? error ?? acknowledge.error ?? forward.error} />

      {!dispatchId ? (
        <Card className="px-6 py-14 text-center text-sm text-muted">
          Scan a package or pick a consignment above.
        </Card>
      ) : isLoading ? (
        <div className="py-16 text-center text-muted">Loading…</div>
      ) : doc ? (
        <>
          <MetaCard title="Consignment">
            <MetaRow label="Number" value={<span className="font-mono">{doc.dispatch_no}</span>} />
            <MetaRow label="Status" value={<StatusPill status={doc.status} />} />
            <MetaRow label="From" value={doc.warehouse_name} />
            <MetaRow label="Vehicle" value={doc.vehicle_number} />
            <MetaRow label="LR no" value={doc.lr_no} />
            <MetaRow label="Expected" value={fmtDate(doc.expected_delivery)} />
            <MetaRow label="Packages" value={doc.total_packages} />
            <MetaRow label="Acknowledged by" value={doc.acknowledged_by_name} />
          </MetaCard>

          {done ? (
            <Card className="mb-4 flex flex-col items-center justify-center gap-3 px-6 py-8">
              <div className="flex items-center gap-2 text-ok">
                <CheckCircle2 className="h-5 w-5" />
                <span className="font-display text-lg font-bold">Already acknowledged</span>
              </div>
              {doc.can_forward && (
                <Can do="issue.forward">
                  <p className="max-w-md text-center text-sm text-muted">
                    These goods are on their way further down — the stock is here, and the
                    request stays open until the point below signs for it.
                  </p>
                  <Button variant="soft" onClick={() => forward.mutate()}
                          disabled={forward.isPending}>
                    <Forward className="h-4 w-4" />
                    {forward.isPending ? "Forwarding…" : "Forward to the points below"}
                  </Button>
                </Can>
              )}
            </Card>
          ) : null}

          <Section title="What arrived" hint="Enter what was actually counted, not what was sent.">
            {grouped && (
              <div className="mb-3 flex items-center justify-between gap-3 text-sm">
                <span className="text-muted">
                  {groups.length} {groups.length === 1 ? "item" : "items"} · {lines.length} units
                </span>
                <button
                  type="button"
                  onClick={() => setBySerial((v) => !v)}
                  className="min-h-[44px] rounded-lg px-2 font-semibold text-brand outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand/60"
                >
                  {expanded ? "Group by item" : "Count each serial"}
                </button>
              </div>
            )}
            {expanded ? (
              <LinesEditor
                rows={lines}
                columns={columns}
                keyOf={(l) => l.id}
                rowTone={(l) =>
                  (delivered[l.id] ?? num(l.quantity)) < num(l.quantity) ? "bg-bad-bg/40" : undefined
                }
                empty="This consignment has no lines."
                footer={
                  <div className="flex flex-wrap justify-end gap-x-6 gap-y-1 text-sm">
                    <span className="text-muted">{lines.length} lines</span>
                    <span className={shortLines.length > 0 ? "text-bad" : "text-ok"}>
                      {shortLines.length > 0 ? `${shortLines.length} short` : "All complete"}
                    </span>
                  </div>
                }
              />
            ) : (
              <LinesEditor
                rows={groups}
                columns={groupColumns}
                keyOf={(g) => g.key}
                rowTone={(g) => (receivedOf(g.lines) < sentOf(g.lines) ? "bg-bad-bg/40" : undefined)}
                empty="This consignment has no lines."
                footer={
                  <div className="flex flex-wrap justify-end gap-x-6 gap-y-1 text-sm">
                    <span className="text-muted">{groups.length} items · {lines.length} units</span>
                    <span className={shortLines.length > 0 ? "text-bad" : "text-ok"}>
                      {shortLines.length > 0 ? `${shortLines.length} short` : "All complete"}
                    </span>
                  </div>
                }
              />
            )}
          </Section>

          {!done && (
            <Section title="Acknowledge">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Received by">
                  <Input value={by} onChange={(e) => setBy(e.target.value)} placeholder="Name of the receiver" />
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Remarks">
                    <Input value={remarks} onChange={(e) => setRemarks(e.target.value)}
                           placeholder="Damage, shortage, packaging condition…" />
                  </Field>
                </div>
              </div>
              <div className="mt-4">
                <Can do="issue.view">
                  <Button onClick={() => setConfirming(true)} disabled={lines.length === 0}>
                    Acknowledge delivery
                  </Button>
                </Can>
              </div>
            </Section>
          )}

          <Section title="Proof of delivery" hint="Signed POD, photographs of any damage.">
            <AttachmentsPanel entityType="DISPATCH" entityId={doc.id} category="POD" readOnly={done} />
          </Section>

          <Section title="Custody trail">
            <Timeline entries={toTimeline(doc.events)} />
          </Section>
        </>
      ) : null}

      <ConfirmModal
        isOpen={confirming}
        title="Acknowledge this delivery?"
        message={
          shortLines.length > 0
            ? `${shortLines.length} line${shortLines.length === 1 ? " is" : "s are"} short. The shortage is recorded against the consignment and cannot be edited afterwards.`
            : "Everything on the consignment is confirmed received."
        }
        confirmLabel="Acknowledge"
        danger={shortLines.length > 0}
        busy={acknowledge.isPending}
        error={acknowledge.error}
        onConfirm={() => acknowledge.mutate()}
        onClose={() => setConfirming(false)}
      />
    </div>
  );
}
