import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Chip } from "@heroui/react";
import { CheckCircle2, ScanLine } from "lucide-react";
import { Button, Can, Card, ConfirmModal, ErrorBanner, Field, Input, PageHeader, StatusPill } from "@/shared/components";
import { MetaCard, MetaRow, Section } from "../components/DocumentMeta";
import { LinesEditor, QtyInput, type LineColumn } from "../components/LinesEditor";
import { AttachmentsPanel } from "../components/AttachmentsPanel";
import { Timeline, toTimeline } from "../components/Timeline";
import { acknowledgeDispatch, getDispatch, listDispatches, scanCode } from "../api";
import { fmtDate, fmtQty, num } from "../format";
import type { DispatchItem } from "../types";

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
  const qc = useQueryClient();
  const [dispatchId, setDispatchId] = useState<number | null>(null);
  const [scan, setScan] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);
  const [delivered, setDelivered] = useState<Record<number, number>>({});
  const [by, setBy] = useState("");
  const [remarks, setRemarks] = useState("");
  const [confirming, setConfirming] = useState(false);

  const { data: open = [] } = useQuery({
    queryKey: ["wh-dispatches-inbound"],
    queryFn: async () => {
      const page = await listDispatches({ size: 100 });
      return page.items.filter((d) => ["DISPATCHED", "IN_TRANSIT", "DELIVERED"].includes(d.status));
    },
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
      qc.invalidateQueries({ queryKey: ["wh-dispatch", String(dispatchId)] });
      qc.invalidateQueries({ queryKey: ["wh-dispatches"] });
      qc.invalidateQueries({ queryKey: ["wh-dispatches-inbound"] });
      setConfirming(false);
    },
  });

  const lines = doc?.items ?? [];
  const shortLines = lines.filter((l) => (delivered[l.id] ?? num(l.quantity)) < num(l.quantity));
  const done = doc?.status === "ACKNOWLEDGED";

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
      <PageHeader eyebrow="Warehouse" title="Acknowledge delivery" />

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

      <ErrorBanner error={scanError ?? error ?? acknowledge.error} />

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
            <Card className="mb-4 flex items-center justify-center gap-2 px-6 py-8 text-ok">
              <CheckCircle2 className="h-5 w-5" />
              <span className="font-display text-lg font-bold">Already acknowledged</span>
            </Card>
          ) : null}

          <Section title="What arrived" hint="Enter what was actually counted, not what was sent.">
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
