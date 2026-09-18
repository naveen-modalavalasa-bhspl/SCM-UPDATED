import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, PackageCheck } from "lucide-react";
import {
  Button, Card, ResponsiveList, StatusPill, type Column,
} from "@/shared/components";
import { ReceiptModal } from "./ReceiptModal";
import { returnsApi } from "../api";
import { QUEUE, money } from "../constants";
import { formatReturnDate } from "../dateTime";
import type { StockReturn } from "../types";

const qty = (value: string | number) => Number(value ?? 0).toLocaleString();

/**
 * Whether this row is still owed a signature, or is one this desk has already given.
 *
 * The server sends both on the same queue (`RECEIPT_TAIL`) and puts the outstanding
 * ones first. `can_receive` is the server's own answer to "is there a press left on
 * this", so the row is never asked to work it out from a status — a return signed for
 * through the shipment in Logistics arrives here already settled too, and it has to
 * read the same way as one signed for on this screen.
 */
const settled = (row: StockReturn) => !row.can_receive;

/**
 * ADDED 2026-09-10 — what has left the gate and is waiting to be signed for.
 *
 * The receipt used to live in Logistics only: the desk recorded the far end's signature
 * on the shipment, and the return module picked it up on a hook. So the moment a load was
 * dispatched it vanished from every Returns screen that could be acted on, and the people
 * standing in front of the material had nothing to press. This panel is the second door —
 * the SAME acknowledgement, on the screen the receiving side already works.
 *
 * It draws its own queue (`QUEUE.RECEIPT`), which the server filters to what this login
 * may actually sign for, so every row here has a live button on it. Nothing renders at all
 * when the list is empty: a permanently visible "nothing to receive" block on the sign-off
 * screen would only push the endorsement queue down the page.
 *
 * The press posts to the ordinary `/acknowledge` endpoint. There is no second verb and no
 * new stage: the server sees the return is still on its leg and settles it — credits the
 * receiving point's stock balance, ends the leg, and raises the purchase return against
 * the warehouse's own document. No ladder, doc type or approval decision is involved.
 *
 * CHANGED 2026-09-10: the press opens `ReceiptModal`, which is the indent
 * acknowledgement's own form — a quantity per line, a photograph of the delivery, and
 * whether it arrived in one piece. It was a bare "are you sure" before, which credited
 * whatever had been dispatched and recorded nothing about what actually turned up.
 *
 * CHANGED 2026-09-10: a row does NOT leave when it is acknowledged. The same queue
 * carries what this login has signed for over the last week (`RECEIPT_TAIL` on the
 * server, which also puts the outstanding rows first), drawn with the receipt in place of
 * the button. Clearing the row on the press left the person who made it looking at a list
 * that no longer mentioned the return they had just put on a shelf — and a receipt that
 * moves stock is exactly what somebody wants to re-read a moment later.
 */
export function AwaitingReceiptPanel({
  search = "",
  dateFrom = "",
  dateTo = "",
  filtersOn = false,
}: {
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  filtersOn?: boolean;
}) {
  const [signing, setSigning] = useState<StockReturn | null>(null);
  const [acknowledged, setAcknowledged] = useState<Record<number, StockReturn>>({});

  const { data, isLoading } = useQuery({
    queryKey: ["returns", "queue", QUEUE.RECEIPT, search, dateFrom, dateTo],
    queryFn: () =>
      returnsApi.list({
        page: 1,
        size: 20,
        queue: QUEUE.RECEIPT,
        search: search || undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
      }),
  });

  const rows = useMemo(() => {
    const live = (data?.items ?? []).map((row) => acknowledged[row.id] ?? row);
    const liveIds = new Set(live.map((row) => row.id));
    return [
      ...Object.values(acknowledged).filter((row) => !liveIds.has(row.id)),
      ...live,
    ];
  }, [acknowledged, data?.items]);
  // Nothing on the way is not news, so it says nothing.
  if (isLoading || rows.length === 0) return null;

  // What is actually owed a signature, as opposed to what is on the panel: the tail of
  // already-signed rows is deliberately part of this list, and a heading that counted
  // those would claim there is work here when there is none.
  const owed = rows.filter((row) => row.can_receive).length;

  const columns: Column<StockReturn>[] = [
    {
      key: "return_no",
      header: "Return",
      render: (row) => (
        <div>
          <div className="font-semibold text-ink">{row.return_no}</div>
          <div className="text-xs text-muted">{row.reason_label ?? row.reason ?? "—"}</div>
        </div>
      ),
    },
    {
      key: "route",
      header: "Coming from",
      render: (row) => (
        <div className="text-sm">
          <div className="text-ink">{row.from_warehouse_name ?? "—"}</div>
          <div className="text-xs text-muted">
            to {row.to_warehouse_name ?? row.leg_label ?? "—"}
          </div>
        </div>
      ),
    },
    {
      key: "qty",
      header: "Quantity",
      render: (row) => (
        <div className="text-sm">
          <div className="text-ink">{qty(row.total_qty)}</div>
          <div className="text-xs text-muted">
            {row.total_items} {row.total_items === 1 ? "item" : "items"}
          </div>
        </div>
      ),
    },
    {
      key: "value",
      header: "Worth",
      hideOnNarrow: true,
      render: (row) => <span className="text-sm text-body">{money(row.value)}</span>,
    },
    {
      key: "shipment",
      header: "Shipment",
      hideOnNarrow: true,
      render: (row) => (
        <span className="text-sm text-body">
          {row.transport?.transport_request_no ?? "—"}
        </span>
      ),
    },
    {
      key: "act",
      header: "",
      render: (row) => (settled(row) ? (
        // FIX 2026-09-10: the row used to leave the panel the instant it was
        // acknowledged, so the press had nothing to show for itself and the only way to
        // check what had just been signed for was to go and find the return in the
        // register. It stays for `RECEIPT_TAIL` days, with the receipt in place of the
        // button — the same row, saying it is done.
        <div className="text-right">
          <StatusPill status={row.status} label="Acknowledged" />
          <div className="mt-1 text-[11px] text-muted">
            {row.received_at ? `Signed ${formatReturnDate(row.received_at)}` : "Signed for"}
          </div>
        </div>
      ) : (
        <Button onClick={() => setSigning(row)}>
          <CheckCircle2 className="h-4 w-4" /> Acknowledge receipt
        </Button>
      )),
    },
  ];

  return (
    <section className="mb-6">
      <Card className="mb-3 flex items-start gap-3 p-3">
        <PackageCheck className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
        <div>
          <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
            Receipt acknowledgements
            {owed > 0 && (
              <span className="rounded-full bg-brand-050 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-brand">
                {owed} waiting on you
              </span>
            )}
          </h2>
          <p className="text-sm text-muted">
            {filtersOn ? "Matching receipts from the same filters below. " : ""}
            Open a row to check the lines, attach delivery proof and sign for what arrived.
            Recently signed receipts stay visible for a week.
          </p>
        </div>
      </Card>

      <ResponsiveList
        data={rows}
        columns={columns}
        keyOf={(row) => row.id}
        onRowClick={(row) => setSigning(row)}
        renderCard={(row) => (
          <div>
            <div>
              <span className="font-semibold text-ink">{row.return_no}</span>
              <div className="mt-1 text-sm text-body">
                {row.from_warehouse_name ?? "—"} &rarr;{" "}
                {row.to_warehouse_name ?? row.leg_label ?? "—"}
              </div>
              <div className="mt-1 text-xs text-muted">
                {qty(row.total_qty)} across {row.total_items}{" "}
                {row.total_items === 1 ? "item" : "items"} &middot; {money(row.value)}
                {row.transport?.transport_request_no
                  ? ` · ${row.transport.transport_request_no}`
                  : ""}
              </div>
            </div>
            {settled(row) ? (
              <div className="mt-3 flex items-center gap-2">
                <StatusPill status={row.status} label="Acknowledged" />
                <span className="text-xs text-muted">
                  {row.received_at
                    ? `Signed ${formatReturnDate(row.received_at)}`
                    : "Signed for"}
                </span>
              </div>
            ) : (
              <Button className="mt-3" onClick={() => setSigning(row)}>
                <CheckCircle2 className="h-4 w-4" />
                Acknowledge receipt
              </Button>
            )}
          </div>
        )}
      />

      {/* The receipt itself. Rendered off the row rather than refetched: the queue
          already serves every line with its dispatched and signed quantities, so the
          form opens with the numbers already on screen instead of a spinner. */}
      {signing && (
        <ReceiptModal
          doc={signing}
          onClose={() => setSigning(null)}
          onDone={(updated) => {
            setAcknowledged((current) => ({
              ...current,
              [updated.id]: {
                ...updated,
                can_receive: false,
                received_at: updated.received_at ?? new Date().toISOString(),
              },
            }));
          }}
        />
      )}
    </section>
  );
}
