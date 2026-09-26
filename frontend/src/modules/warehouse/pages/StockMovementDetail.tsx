import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, CheckCircle2, ClipboardCheck, FileText, PackageCheck, ShieldCheck, X } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Button, Can, Card, ErrorBanner, PageHeader, StatusPill, ResponsiveList, useToast,
} from "@/shared/components";
import {
  actOnStockMovementOrder,
  completeStockMovementInspection,
  completeStockMovementOrder,
  getStockMovementOrder,
  submitStockMovementOrder,
} from "../api";
import { Modal, ModalBody, ModalContent, ModalHeader, ModalFooter , Tooltip} from "@heroui/react";
import { useState } from "react";
import { Section } from "../components/DocumentMeta";
import { fmtDateTime, fmtQty } from "../format";
import type { StockMovementOrderItem } from "../types";
import { TONE_APPROVE, TONE_REJECT } from "@/shared/components/tones";

const MOVEMENT_STEPS = [
  { label: "Draft", icon: FileText },
  { label: "Approval", icon: ShieldCheck },
  { label: "Inspection", icon: ClipboardCheck },
  { label: "Movement", icon: PackageCheck },
] as const;

function MovementProgress({ status }: { status: string }) {
  const active = ({ DRAFT: 0, PENDING_APPROVAL: 1, APPROVED: 2, INSPECTED: 3, COMPLETED: 4 } as Record<string, number>)[status] ?? 0;
  const rejected = status === "REJECTED";

  return (
    <Card className="mb-6 overflow-hidden border-line/70 bg-gradient-to-r from-white via-white to-brand/[0.035] p-5">
      <div className="grid grid-cols-4 gap-2">
        {MOVEMENT_STEPS.map(({ label, icon: Icon }, index) => {
          const done = !rejected && active > index;
          const current = !rejected && active === index;
          return (
            <div key={label} className="relative flex flex-col items-center text-center">
              {index > 0 && <span className={`absolute right-1/2 top-4 h-0.5 w-full ${done ? "bg-emerald-400" : "bg-line"}`} />}
              <span className={`relative z-10 grid h-8 w-8 place-items-center rounded-full border transition-colors ${
                done ? "border-emerald-500 bg-emerald-500 text-white"
                  : current ? "border-brand bg-brand text-white shadow-sm"
                    : rejected && index === 1 ? "border-danger bg-danger text-white"
                      : "border-line bg-white text-muted"
              }`}>
                {done ? <CheckCircle2 className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
              </span>
              <span className={`mt-2 text-[11px] font-semibold sm:text-xs ${current || done ? "text-ink" : "text-muted"}`}>
                {rejected && index === 1 ? "Rejected" : label}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function ViewSerials({ serials }: { serials: string[] | null | undefined }) {
  const [open, setOpen] = useState(false);
  if (!serials || serials.length === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1 inline-flex items-center text-[11px] font-medium text-brand hover:underline"
      >
        View {serials.length} identifier{serials.length !== 1 ? 's' : ''}
      </button>
      <Modal isOpen={open} onClose={() => setOpen(false)} size="md" scrollBehavior="inside">
        <ModalContent>
          <ModalHeader className="border-b border-line/50 pb-3 font-display text-lg text-ink">
            Identifiers
          </ModalHeader>
          <ModalBody className="py-4">
            <div className="flex flex-wrap gap-2">
              {serials.map((s, i) => (
                <span key={i} className="inline-flex items-center rounded-md bg-neutral-100 px-2 py-1 font-mono text-xs text-ink border border-neutral-200">
                  {s}
                </span>
              ))}
            </div>
          </ModalBody>
          <ModalFooter className="border-t border-line/50">
            <Button variant="subtle" onClick={() => setOpen(false)}>Close</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}

export default function StockMovementDetail() {
  const [params] = useSearchParams();
  const orderNo = params.get("order_no");
  const nav = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const refreshMovement = () => {
    queryClient.invalidateQueries({ queryKey: ["wh-stock-movement-order"] });
    queryClient.invalidateQueries({ queryKey: ["wh-stock-movement-orders"] });
    queryClient.invalidateQueries({ queryKey: ["inventory-stock"] });
    queryClient.invalidateQueries({ queryKey: ["wh-bin-options"] });
    queryClient.invalidateQueries({ queryKey: ["wh-serial-options"] });
  };

  const { data, isLoading, error } = useQuery({
    queryKey: ["wh-stock-movement-order", orderNo],
    queryFn: () => getStockMovementOrder(orderNo as string),
    enabled: !!orderNo,
  });

  const act = useMutation({
    mutationFn: (action: "APPROVED" | "REJECTED") =>
      actOnStockMovementOrder((data as { id: number }).id, action),
    onSuccess: (result) => {
      refreshMovement();
      toast.success(result.status === "REJECTED"
        ? `${result.order_no} rejected — nothing moved`
        : `${result.order_no} approved — ready for inspection`);
    },
  });

  const submit = useMutation({
    mutationFn: () => submitStockMovementOrder((data as { id: number }).id),
    onSuccess: (result) => {
      refreshMovement();
      toast.success(result.status === "APPROVED"
        ? `${result.order_no} approved — ready for inspection`
        : `${result.order_no} submitted for approval${
            result.current_approver_name ? ` — waiting on ${result.current_approver_name}` : ""}`);
    },
  });

  const inspect = useMutation({
    mutationFn: () => completeStockMovementInspection((data as { id: number }).id),
    onSuccess: (result) => {
      refreshMovement();
      toast.success(`${result.order_no} inspection completed — ready to move`);
    },
  });

  const complete = useMutation({
    mutationFn: () => completeStockMovementOrder((data as { id: number }).id),
    onSuccess: (result) => {
      refreshMovement();
      toast.success(`${result.order_no} completed — stock moved successfully`);
    },
  });

  if (!orderNo) {
    return <ErrorBanner error="No order number provided." />;
  }

  if (isLoading) {
    return <p className="p-8 text-sm text-muted">Loading movement details...</p>;
  }

  if (error || !data) {
    return <ErrorBanner error={error || "Movement order not found"} />;
  }

  return (
    <div>
      <PageHeader
        eyebrow="Warehouse"
        title="Stock Movement Order"
        actions={
          <>
            <Button variant="ghost" onClick={() => nav("/warehouse/stock-movements")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <Button
              variant="secondary"
              onClick={() => window.open(`/warehouse/stock-movements/print?order_no=${encodeURIComponent(data.order_no)}`, "_blank")}
            >
              <FileText className="h-4 w-4" /> Print
            </Button>
            {/* A saved order is a DRAFT and moves nothing until it is submitted.
                `id` is 0 only on a movement completed before orders were stored,
                which has no document to act on. Gated on the same codes the
                endpoints check: hiding a button is not security, the backend is. */}
            {data.status === "DRAFT" && data.id > 0 && (
              <Can do="movement.create">
                <Button
                  disabled={submit.isPending}
                  onClick={() => submit.mutate()}
                >
                  <Check className="h-4 w-4" />
                  {submit.isPending ? "Submitting…" : "Submit for approval"}
                </Button>
              </Can>
            )}
            {data.status === "PENDING_APPROVAL" && data.id > 0 && (
              <Can do="movement.approve">
                <Button className={TONE_REJECT}
                  variant="secondary"
                  disabled={act.isPending}
                  onClick={() => act.mutate("REJECTED")}
                >
                  <X className="h-4 w-4" /> Reject
                </Button>
                <Button className={TONE_APPROVE}
                  disabled={act.isPending}
                  onClick={() => act.mutate("APPROVED")}
                >
                  <Check className="h-4 w-4" />
                  {act.isPending ? "Working…" : "Approve"}
                </Button>
              </Can>
            )}
            {data.status === "APPROVED" && data.id > 0 && (
              <Can do="movement.inspect">
                <Button className={TONE_APPROVE} disabled={inspect.isPending} onClick={() => inspect.mutate()}>
                  <ClipboardCheck className="h-4 w-4" />
                  {inspect.isPending ? "Checking…" : "Complete inspection"}
                </Button>
              </Can>
            )}
            {data.status === "INSPECTED" && data.id > 0 && (
              <Can do="movement.complete">
                <Button className={TONE_APPROVE} disabled={complete.isPending} onClick={() => complete.mutate()}>
                  <PackageCheck className="h-4 w-4" />
                  {complete.isPending ? "Moving…" : "Complete movement"}
                </Button>
              </Can>
            )}
          </>
        }
      />

      <MovementProgress status={data.status} />
      {(act.error || submit.error || inspect.error || complete.error) && (
        <div className="mb-6">
          <ErrorBanner error={act.error || submit.error || inspect.error || complete.error} />
        </div>
      )}

      <Section title="Movement Summary">
        <Card className="p-6">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <div>
              <div className="text-xs text-muted">Order No</div>
              <div className="font-mono text-sm font-semibold">{data.order_no}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Status</div>
              <div className="mt-1">
                <StatusPill status={data.status} />
              </div>
            </div>
            <div>
              <div className="text-xs text-muted">
                {data.current_approver_name ? "Waiting on" : "Warehouse"}
              </div>
              <div className="text-sm">
                {data.current_approver_name ?? data.warehouse_name ?? "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted">Created</div>
              <div className="text-sm">{fmtDateTime(data.created_at)}</div>
            </div>
            <div className="col-span-2 md:col-span-4">
              <div className="text-xs text-muted">Reason</div>
              <div className="text-sm">{data.reason ?? "—"}</div>
            </div>
          </div>
        </Card>
      </Section>

      <Section title="Movement Lines">
        <ResponsiveList<StockMovementOrderItem>
          columns={[
            {
              key: "item",
              header: "Item",
              render: (row) => (
                <div>
                  <Tooltip content={row.item_name} placement="top" closeDelay={0}>
                    <div className="font-semibold text-ink truncate cursor-help">{row.item_name}</div>
                  </Tooltip>
                  <div className="font-mono text-[11px] text-muted">{row.item_code}</div>
                  <ViewSerials serials={row.serial_numbers} />
                </div>
              ),
            },
            {
              key: "source",
              header: "From",
              render: (row) => (
                <div>
                  <div className="font-mono text-[11px] text-ink">{row.source_bin_code ?? "—"}</div>
                  {row.batch_id ? (
                    <div className="text-[10px] text-muted">Batch: <span className="font-mono text-ink">{row.batch_no ?? "—"}</span></div>
                  ) : null}
                </div>
              ),
            },
            {
              key: "destination",
              header: "To",
              render: (row) => (
                <div className="font-mono text-[11px] text-ink">{row.destination_bin_code ?? "—"}</div>
              ),
            },
            {
              key: "qty",
              header: "Quantity",
              className: "text-right",
              render: (row) => (
                <span className="tabular text-sm text-ink">
                  {fmtQty(row.quantity)} <span className="text-xs text-muted">{row.uom_code}</span>
                </span>
              ),
            },
          ]}
          data={data.items || []}
          keyOf={(row) => row.id ?? `${row.item_id}-${row.source_bin_id}-${row.destination_bin_id}`}
          empty="No items moved."
          renderCard={(row) => (
            <div className="space-y-2">
              <div className="flex justify-between font-semibold">
                <Tooltip content={row.item_name} placement="top" closeDelay={0}>
                  <span className="truncate cursor-help max-w-[200px] block">{row.item_name}</span>
                </Tooltip>
                <span>{fmtQty(row.quantity)} <span className="text-xs text-muted">{row.uom_code}</span></span>
              </div>
              <div className="text-sm">
                <span className="text-muted">From:</span> {row.source_bin_code ?? "—"}
                {row.batch_id ? ` (Batch: ${row.batch_no ?? "—"})` : ""}
              </div>
              <div className="text-sm">
                <span className="text-muted">To:</span> {row.destination_bin_code ?? "—"}
              </div>
              <ViewSerials serials={row.serial_numbers} />
            </div>
          )}
        />
      </Section>
    </div>
  );
}
