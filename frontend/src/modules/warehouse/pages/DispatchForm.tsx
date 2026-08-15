import { useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Barcode,
  Boxes,
  Package,
  ShieldAlert,
  Thermometer,
  Truck,
} from "lucide-react";
import { Button, Can, ConfirmModal, ErrorBanner, Field, Input, PageHeader, Select, StatusPill } from "@/shared/components";
import { MetaCard, MetaRow, Section } from "../components/DocumentMeta";
import { Lookup } from "../components/Lookup";
import { AttachmentsPanel } from "../components/AttachmentsPanel";
import { Timeline, toTimeline } from "../components/Timeline";
import {
  addDispatchEvent, approveDispatch, cancelDispatch, dispatchGateOut, getDispatch,
  listConsignments, rejectDispatch,
} from "../api";
import { fmtDate, fmtMoney, fmtQty, humanise, num } from "../format";
import { alerts } from "@/modules/alerts";
import type { Dispatch, DispatchItem, DispatchPackage } from "../types";
import { usePointLabel } from "../usePointLabel";

const EVENTS = [
  { value: "PICKED_UP", label: "Picked up" },
  { value: "IN_TRANSIT", label: "In transit" },
  { value: "TEMPERATURE_CHECK", label: "Temperature check" },
  { value: "DELAYED", label: "Delayed" },
  { value: "DELIVERED", label: "Delivered" },
];

type GroupedItem = DispatchItem & {
  serials: string[];
  quantity: number;
  amount: number;
};

const packageItems = (doc: Dispatch, pkg: DispatchPackage): GroupedItem[] => {
  const rows = new Map<string, GroupedItem>();
  (doc.items ?? [])
    .filter((line) => line.package_id === pkg.id)
    .forEach((line) => {
      const key = `${line.item_id}:${line.batch_id ?? 0}:${line.rate ?? ""}:${line.remarks ?? ""}`;
      const current = rows.get(key);
      rows.set(key, {
        ...line,
        serials: [
          ...(current?.serials ?? []),
          ...(line.serial_no ? [line.serial_no] : []),
        ],
        quantity: num(current?.quantity) + num(line.quantity),
        amount: num(current?.amount) + num(line.amount),
      });
    });
  return Array.from(rows.values());
};

const destinationOf = (doc: Dispatch) =>
  doc.destination_office_name
  ?? doc.delivery_address
  ?? doc.to_warehouse_name
  ?? doc.customer_name
  ?? doc.vendor_name
  ?? "";

export default function DispatchForm() {
  const pointLabel = usePointLabel();
  const { id } = useParams();
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const qc = useQueryClient();
  const editing = !!id && id !== "new";
  const initialConsignmentId = Number(searchParams.get("consignment_id") ?? 0);

  const [selectedConsignment, setSelectedConsignment] = useState<number | "">(
    initialConsignmentId > 0 ? initialConsignmentId : "",
  );
  const [gatePass, setGatePass] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [confirming, setConfirming] = useState<
    "gate" | "cancel" | "approve" | "reject" | null>(null);
  const [decisionNote, setDecisionNote] = useState("");
  const [event, setEvent] = useState({
    event_type: "IN_TRANSIT",
    location_name: "",
    temperature_c: "",
    notes: "",
  });

  const { data: doc, isLoading } = useQuery({
    queryKey: ["wh-dispatch", id],
    queryFn: () => getDispatch(Number(id)),
    enabled: editing,
  });

  const confirmSelected = useMutation({
    mutationFn: () => dispatchGateOut(Number(selectedConsignment), gatePass || undefined),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["wh-dispatches"] });
      qc.invalidateQueries({ queryKey: ["wh-consignments"] });
      qc.invalidateQueries({ queryKey: ["wh-dispatch", String(saved.id)] });
      nav(`/warehouse/dispatch/${saved.id}`, { replace: true });
    },
  });

  const gateOut = useMutation({
    mutationFn: () => dispatchGateOut(Number(id), gatePass || undefined),
    // One endpoint, two outcomes: a consignment that has not been through its chain
    // is SENT to the approvers and the goods stay on the bench (see
    // `warehouse.service.gate_out` -> `_dispatch_approval_pending`). Announcing
    // "has left the site" for both told the storekeeper the stock was gone when it
    // was not — so the returned status, not the click, picks the message.
    onSuccess: (saved) => {
      if (saved.status === "DISPATCHED") {
        void alerts.success("dispatch.gated_out", { number: saved.dispatch_no });
      } else {
        void alerts.info("dispatch.sent_for_approval", {
          number: saved.dispatch_no,
          approver: saved.current_approver_name ?? "its approver",
        });
      }
      qc.invalidateQueries({ queryKey: ["wh-dispatch", id] });
      qc.invalidateQueries({ queryKey: ["wh-dispatches"] });
      qc.invalidateQueries({ queryKey: ["wh-consignments"] });
      qc.invalidateQueries({ queryKey: ["approvals"] });
      setConfirming(null);
    },
  });

  // The chain's decision on a consignment. `approveDispatch` and `rejectDispatch`
  // have existed in the api layer since dispatch approval was built; no screen ever
  // called them, so a consignment waiting on Logistics had no button anywhere and the
  // only way through was the Approvals inbox.
  const decide = useMutation({
    mutationFn: (approve: boolean) =>
      approve
        ? approveDispatch(Number(id), decisionNote)
        : rejectDispatch(Number(id), decisionNote),
    onSuccess: (saved) => {
      void alerts.success("dispatch.decided", { number: saved.dispatch_no });
      qc.invalidateQueries({ queryKey: ["wh-dispatch", id] });
      qc.invalidateQueries({ queryKey: ["wh-dispatches"] });
      qc.invalidateQueries({ queryKey: ["approvals"] });
      setConfirming(null);
      setDecisionNote("");
    },
  });

  const cancel = useMutation({
    mutationFn: () => cancelDispatch(Number(id), cancelReason || undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-dispatch", id] });
      qc.invalidateQueries({ queryKey: ["wh-dispatches"] });
      qc.invalidateQueries({ queryKey: ["wh-consignments"] });
      setConfirming(null);
    },
  });

  const logEvent = useMutation({
    mutationFn: () =>
      addDispatchEvent(Number(id), {
        event_type: event.event_type,
        location_name: event.location_name || null,
        temperature_c: event.temperature_c === "" ? null : Number(event.temperature_c),
        notes: event.notes || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-dispatch", id] });
      setEvent({ event_type: "IN_TRANSIT", location_name: "", temperature_c: "", notes: "" });
    },
  });

  // PACKED covers two different moments and the button meant something different in
  // each: a consignment nobody has sent for release yet, and one already signed off
  // that was re-packed (`add_package` puts an APPROVED dispatch back to PACKED).
  // `approved_at` is what tells them apart — it is stamped both by a real approval
  // and by the NO_APPROVAL ladder that approves on submit.
  const needsRelease = doc?.status === "PACKED" && !doc?.approved_at;

  const packageCount = doc?.packages?.length ?? 0;
  const itemCount = doc?.items?.reduce((sum, line) => sum + num(line.quantity), 0) ?? 0;
  const value = doc?.items?.reduce((sum, line) => sum + num(line.amount), 0) ?? 0;
  const destination = doc ? destinationOf(doc) : "";
  const packageGroups = useMemo(
    () => (doc?.packages ?? []).map((pkg) => ({ pkg, items: doc ? packageItems(doc, pkg) : [] })),
    [doc],
  );

  if (editing && isLoading) {
    return <div className="py-16 text-center text-muted">Loading...</div>;
  }

  if (!editing) {
    return (
      <div>
          <PageHeader
          eyebrow={pointLabel}
          title="Confirm dispatch"
          actions={
            <>
              <Button variant="ghost" onClick={() => nav("/warehouse/dispatch")}>
                <ArrowLeft className="h-4 w-4" /> Back
              </Button>
              <Can do="dispatch.gate_out">
                <Button
                  onClick={() => confirmSelected.mutate()}
                  disabled={selectedConsignment === "" || confirmSelected.isPending}
                >
                  <Truck className="h-4 w-4" />
                  {confirmSelected.isPending ? "Confirming..." : "Confirm dispatch"}
                </Button>
              </Can>
            </>
          }
        />
        <ErrorBanner error={confirmSelected.error} />
        <Section title="Ready consignment" hint="Only packed consignments are available for dispatch confirmation.">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Field label="Consignment">
              <Lookup
                name="ready-consignments"
                load={async () => {
                  const page = await listConsignments({ size: 100, status: "PACKED" });
                  return page.items.map((row) => ({
                    id: row.id,
                    code: row.dispatch_no,
                    name: `${destinationOf(row) || row.ref_no || "Material issue"} - ${row.total_packages} pkg - ${fmtQty(row.total_qty)}`,
                  }));
                }}
                value={selectedConsignment}
                onChange={setSelectedConsignment}
                placeholder="Select packed consignment"
              />
            </Field>
            <Field label="Gate pass no">
              <Input value={gatePass} onChange={(e) => setGatePass(e.target.value)} />
            </Field>
          </div>
        </Section>
      </div>
    );
  }

  if (!doc) return <div className="py-16 text-center text-muted">Dispatch not found.</div>;

  return (
    <div>
      <PageHeader
        eyebrow={pointLabel}
        title={`Dispatch ${doc.dispatch_no}`}
        actions={
          <>
            <Button variant="ghost" onClick={() => nav("/warehouse/dispatch")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            {/* can_approve, not just the permission: every warehouse login holds
                `dispatch.approve`, while only the person the chain named may act.
                Showing it to the rest sends them into "You are not a valid approver"
                after clicking. Same rule the Material Issue screen uses. */}
            {doc.status === "PENDING_APPROVAL" && doc.can_approve && (
              <Can do="dispatch.approve">
                <Button onClick={() => setConfirming("approve")}>Approve</Button>
                <Button variant="danger" onClick={() => setConfirming("reject")}>
                  Reject
                </Button>
              </Can>
            )}
            {["APPROVED", "PACKED"].includes(doc.status) && (
              <Can do="dispatch.gate_out">
                <Button onClick={() => setConfirming("gate")}>
                  <Truck className="h-4 w-4" />
                  {needsRelease ? "Send for release approval" : "Gate out"}
                </Button>
              </Can>
            )}
            {!["CANCELLED", "ACKNOWLEDGED", "DELIVERED"].includes(doc.status) && (
              <Can do="dispatch.approve">
                <Button variant="danger" onClick={() => setConfirming("cancel")}>Cancel</Button>
              </Can>
            )}
          </>
        }
      />

      <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-4">
        <div className="rounded-lg border border-line bg-content1 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase text-muted">
            <Truck className="h-4 w-4" /> Status
          </div>
          <div className="mt-2"><StatusPill status={doc.status} /></div>
        </div>
        <div className="rounded-lg border border-line bg-content1 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase text-muted">
            <Boxes className="h-4 w-4" /> Packages
          </div>
          <div className="mt-1 text-2xl font-bold text-ink">{packageCount}</div>
        </div>
        <div className="rounded-lg border border-line bg-content1 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase text-muted">
            <Package className="h-4 w-4" /> Quantity
          </div>
          <div className="mt-1 text-2xl font-bold text-ink">{fmtQty(itemCount)}</div>
        </div>
        <div className="rounded-lg border border-line bg-content1 p-4">
          <div className="text-xs font-semibold uppercase text-muted">Value</div>
          <div className="mt-1 text-2xl font-bold text-ink">₹ {fmtMoney(value)}</div>
        </div>
      </div>

      <MetaCard title="Consignment">
        <MetaRow label="Number" value={<span className="font-mono">{doc.dispatch_no}</span>} />
        <MetaRow label="Material issue" value={<span className="font-mono">{doc.ref_no ?? "-"}</span>} />
        <MetaRow label="Date" value={fmtDate(doc.dispatch_date)} />
        <MetaRow label="Type" value={humanise(doc.dispatch_type)} />
        <MetaRow label="From" value={doc.warehouse_name} />
        <MetaRow label="Destination" value={destination || "—"} />
        <MetaRow label="Gate pass" value={<span className="font-mono">{doc.gate_pass_no ?? "-"}</span>} />
        <MetaRow label="Gate out" value={fmtDate(doc.gate_out_at)} />
        <MetaRow label="Security" value={doc.security_by_name} />
        <MetaRow label="Transport" value={doc.carrier_name ?? doc.vehicle_number ?? doc.transport_mode} />
        <MetaRow label="LR no" value={<span className="font-mono">{doc.lr_no ?? "-"}</span>} />
        <MetaRow label="Expected" value={fmtDate(doc.expected_delivery)} />
      </MetaCard>

      <Section title="Packages" hint="Package-level view of the dispatched consignment.">
        {packageGroups.length === 0 ? (
          <div className="rounded-lg border border-line bg-content2 px-4 py-8 text-center text-sm text-muted">
            No packages are attached to this consignment.
          </div>
        ) : (
          <div className="space-y-4">
            {packageGroups.map(({ pkg, items }) => (
              <div key={pkg.id} className="overflow-hidden rounded-lg border border-line bg-content1 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line bg-content2/70 px-4 py-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-display text-base font-bold text-ink">{pkg.package_no}</h3>
                      <StatusPill status={pkg.status} />
                      {pkg.is_fragile && <span className="inline-flex items-center gap-1 rounded-full bg-bad-bg px-2 py-1 text-[11px] font-semibold text-bad"><ShieldAlert className="h-3 w-3" /> Fragile</span>}
                      {pkg.is_temp_controlled && <span className="inline-flex items-center gap-1 rounded-full bg-brand-050 px-2 py-1 text-[11px] font-semibold text-brand"><Thermometer className="h-3 w-3" /> Temp controlled</span>}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                      <span>{pkg.package_type ?? "Package"}</span>
                      <span className="inline-flex items-center gap-1"><Barcode className="h-3 w-3" /> {pkg.barcode ?? "-"}</span>
                      <span>packed by {pkg.packed_by_name ?? "-"}</span>
                      <span>{fmtDate(pkg.packed_at)}</span>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-right text-xs text-muted sm:grid-cols-4">
                    <div><div className="font-semibold text-ink">{fmtQty(pkg.weight_kg)} kg</div><div>Weight</div></div>
                    <div><div className="font-semibold text-ink">{fmtQty(pkg.length_cm)}</div><div>Length</div></div>
                    <div><div className="font-semibold text-ink">{fmtQty(pkg.width_cm)}</div><div>Width</div></div>
                    <div><div className="font-semibold text-ink">{fmtQty(pkg.height_cm)}</div><div>Height</div></div>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="min-w-[900px] w-full text-sm">
                    <thead className="bg-content1 text-left text-[11px] uppercase text-muted">
                      <tr>
                        <th className="px-4 py-2">Item</th>
                        <th className="px-4 py-2">Batch</th>
                        <th className="px-4 py-2 text-right">Qty</th>
                        <th className="px-4 py-2 text-right">Rate</th>
                        <th className="px-4 py-2 text-right">Amount</th>
                        <th className="px-4 py-2">Serials</th>
                        <th className="px-4 py-2">Remarks</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((line) => (
                        <tr key={`${pkg.id}-${line.item_id}-${line.batch_id ?? 0}-${line.serials.join("|")}`} className="border-t border-line">
                          <td className="px-4 py-3">
                            <div className="font-mono text-xs font-semibold text-ink">{line.item_code ?? line.item_id}</div>
                            <div className="max-w-[280px] truncate text-xs text-muted">{line.item_name ?? "-"}</div>
                          </td>
                          <td className="px-4 py-3 text-xs text-muted">{line.batch_no ?? "-"}</td>
                          <td className="px-4 py-3 text-right tabular">{fmtQty(line.quantity)} {line.uom_code ?? ""}</td>
                          <td className="px-4 py-3 text-right tabular">₹ {fmtMoney(line.rate)}</td>
                          <td className="px-4 py-3 text-right tabular">₹ {fmtMoney(line.amount)}</td>
                          <td className="px-4 py-3">
                            {line.serials.length ? (
                              <div className="flex max-w-[320px] flex-wrap gap-1">
                                {line.serials.slice(0, 8).map((serial) => (
                                  <span key={serial} className="rounded-md bg-content2 px-2 py-1 font-mono text-[11px] text-ink">
                                    {serial}
                                  </span>
                                ))}
                                {line.serials.length > 8 && (
                                  <span className="rounded-md bg-content2 px-2 py-1 text-[11px] text-muted">
                                    +{line.serials.length - 8}
                                  </span>
                                )}
                              </div>
                            ) : "-"}
                          </td>
                          <td className="px-4 py-3 text-xs text-muted">{line.remarks ?? "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Custody trail"
        hint="Every scan, stop and temperature reading, in order."
        actions={
          <Can do="dispatch.view">
            <Button variant="soft" onClick={() => logEvent.mutate()} disabled={logEvent.isPending}>
              {logEvent.isPending ? "Recording..." : "Record event"}
            </Button>
          </Can>
        }
      >
        <ErrorBanner error={logEvent.error} />
        <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Event">
            <Select
              value={event.event_type}
              onChange={(v) => setEvent((e) => ({ ...e, event_type: v }))}
              options={EVENTS}
              ariaLabel="Event type"
            />
          </Field>
          <Field label="Location">
            <Input value={event.location_name} onChange={(e) => setEvent((v) => ({ ...v, location_name: e.target.value }))} />
          </Field>
          <Field label="Temperature (C)">
            <Input type="number" value={event.temperature_c} onChange={(e) => setEvent((v) => ({ ...v, temperature_c: e.target.value }))} />
          </Field>
          <Field label="Notes">
            <Input value={event.notes} onChange={(e) => setEvent((v) => ({ ...v, notes: e.target.value }))} />
          </Field>
        </div>
        {doc.events?.some((entry) => entry.is_breach) && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-bad/30 bg-bad-bg px-3 py-2 text-sm text-bad">
            <Thermometer className="h-4 w-4" /> This consignment has a recorded temperature breach.
          </div>
        )}
        <Timeline entries={toTimeline(doc.events)} empty="No events recorded for this consignment." />
      </Section>

      <Section title="Documents" hint="LR copy, e-way bill, proof of delivery.">
        <AttachmentsPanel entityType="DISPATCH" entityId={doc.id} category="DISPATCH" />
      </Section>

      <ConfirmModal
        isOpen={confirming === "gate"}
        title={needsRelease ? "Send this consignment for approval?" : "Send this consignment out?"}
        message={needsRelease
          ? "It goes to whoever the approval config names for a dispatch. Nothing moves and no stock is deducted until they sign — if no approval is configured it goes out straight away."
          : "The consignment is marked dispatched and the linked material issue becomes dispatched."}
        confirmLabel={needsRelease ? "Send for approval" : "Gate out"}
        busy={gateOut.isPending}
        error={gateOut.error}
        onConfirm={() => gateOut.mutate()}
        onClose={() => setConfirming(null)}
      >
        {/* Only when the goods are actually leaving. A gate pass typed at the
            submit step is thrown away — gate_out is called again after approval. */}
        {!needsRelease && (
          <div className="mt-3">
            <Field label="Gate pass no">
              <Input value={gatePass} onChange={(e) => setGatePass(e.target.value)} />
            </Field>
          </div>
        )}
      </ConfirmModal>

      <ConfirmModal
        isOpen={confirming === "approve" || confirming === "reject"}
        title={confirming === "reject" ? "Reject this consignment?" : "Approve this consignment?"}
        message={confirming === "reject"
          ? "It stops here. Say why, so the warehouse knows what to fix."
          : "This records your decision in the shared approval history. The consignment can then be gated out."}
        confirmLabel={confirming === "reject" ? "Reject" : "Approve"}
        danger={confirming === "reject"}
        busy={decide.isPending}
        error={decide.error}
        confirmDisabled={confirming === "reject" && !decisionNote.trim()}
        onConfirm={() => decide.mutate(confirming === "approve")}
        onClose={() => { setConfirming(null); setDecisionNote(""); }}
      >
        <div className="mt-3">
          <Field label={confirming === "reject" ? "Reason" : "Comments"}>
            <Input
              value={decisionNote}
              onChange={(e) => setDecisionNote(e.target.value)}
              placeholder={confirming === "reject"
                ? "Why it cannot go" : "Optional"}
            />
          </Field>
        </div>
      </ConfirmModal>

      <ConfirmModal
        isOpen={confirming === "cancel"}
        title="Cancel this dispatch?"
        message="The consignment stops here."
        confirmLabel="Cancel dispatch"
        danger
        busy={cancel.isPending}
        error={cancel.error}
        onConfirm={() => cancel.mutate()}
        onClose={() => setConfirming(null)}
      >
        <div className="mt-3">
          <Field label="Reason">
            <Input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
          </Field>
        </div>
      </ConfirmModal>
    </div>
  );
}
