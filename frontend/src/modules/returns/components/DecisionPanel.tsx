import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Gavel } from "lucide-react";
import {
  Button, ConfirmModal, ErrorBanner, Field, Input, Select,
} from "@/shared/components";
import { SectionCard } from "./DetailChrome";
import { returnsApi } from "../api";
import { money } from "../constants";
import { RelatedDocumentsSection } from "./RelatedDocumentsSection";

/**
 * The decision desk: where does this material go, how does it travel, and whose vehicle.
 *
 * Every list on this screen is SERVED (`/decision-options`) and none of it is assembled
 * here — the destinations with their stock, the four standard logistics methods off
 * logistics' own mode rules, the vehicle arrangements, and the category the resulting
 * purchase return will be filed under. The reviewer reads the same words the service
 * stamps on the document, and a mode added to logistics appears here without this file
 * changing.
 *
 * FIX 2026-09-10: the destination starts EMPTY. "Send to a stocking point" moves the
 * material onto whichever point the reviewer picks — a warehouse, an MDP, any stocking
 * point — so the screen must not answer that question on their behalf. The originating
 * warehouse resolved from the paper trail is still served, and still shown: as a named
 * suggestion under the picker and as an "originating" tag on its own row. It is a hint,
 * not a selection. (Between 2026-09-08 and this change it was pre-filled and binding
 * unless the reviewer noticed and switched it; before 2026-09-08 the pre-fill was
 * `from_warehouse`, the one answer `decide` refuses outright.)
 *
 * The related documents behind the item are rendered by `RelatedDocumentsSection`, which
 * is the same component the detail page uses. It was duplicated inline here and the two
 * copies had already drifted.
 */
export function DecisionPanel({
  returnId,
  onDone,
  onDestinationChange,
}: {
  returnId: number;
  onDone?: () => void;
  /**
   * The point the reviewer has just picked, by name, or null when they have cleared the
   * box. ADDED 2026-09-10 so the document band above this panel can say where the
   * material is going as it is being decided, rather than going on showing the point the
   * return was merely ADDRESSED to when it was raised.
   *
   * The name, not the id: the band prints a name, and resolving an id back to one there
   * would need a second copy of `options.destinations` in the page. This panel already
   * holds the only list, so it answers the question it is the only one able to answer.
   *
   * Reported from the picker's own `onChange` and never from an effect — an effect would
   * have to carry a caller-supplied function in its dependencies, and an inline arrow
   * from the page re-fires it on every render of the page.
   */
  onDestinationChange?: (warehouseName: string | null) => void;
}) {
  const queryClient = useQueryClient();

  const [note, setNote] = useState("");
  const [destination, setDestination] = useState("");
  const [logisticsMode, setLogisticsMode] = useState("");
  const [vehicleType, setVehicleType] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: options, isLoading } = useQuery({
    queryKey: ["returns", returnId, "decision-options"],
    queryFn: () => returnsApi.decisionOptions(returnId),
  });

  // Pre-fill from the server's answer, once, and only where the reviewer has not already
  // typed over it.
  //
  // CHANGED 2026-09-10: "How does it travel?" and "Whose vehicle?" are no longer ASKED
  // here — the two pickers are gone from the form. The state and the effect stay because
  // the shipment raised on confirm still needs a mode and a vehicle arrangement on it, and
  // the server already names the right ones (`default_logistics_mode`,
  // `default_vehicle_type`). So the decision posts exactly what it posted before for a
  // desk that left the defaults alone, which was nearly every one of them; the logistics
  // desk changes the leg on Logistics > Shipments, which is where it owns it.
  //
  // FIX 2026-09-10: the DESTINATION is deliberately not among them. The service still
  // flags a row with `is_default` and still names `originating_warehouse_id`, and both
  // are still read below — but only to describe the suggestion, never to select it. The
  // reviewer picks the stocking point themselves, and `ready` keeps the button disabled
  // until they have.
  useEffect(() => {
    if (!options) return;
    setLogisticsMode((current) => current || options.default_logistics_mode || "");
    setVehicleType((current) => current || options.default_vehicle_type || "");
  }, [options]);

  /**
   * The desk sends returned material back up the chain to a stocking point. The other
   * five outcomes — vendor, branch use, scrap, controlled disposal, refusal — are not
   * reachable from this panel and are pressed from the detail page's own actions; this
   * screen exists for the one decision that ends in a dispatch.
   */
  const DISPOSITION = "SEND_TO_POINT" as const;

  const decide = useMutation({
    mutationFn: () =>
      returnsApi.decide(returnId, {
        disposition: DISPOSITION,
        note: note.trim(),
        to_warehouse_id: Number(destination) || null,
        vendor_id: null,
        disposal_agency: null,
        logistics_mode: logisticsMode || null,
        vehicle_type: vehicleType || null,
      }),
    onSuccess: () => {
      setError(null);
      setConfirming(false);
      queryClient.invalidateQueries({ queryKey: ["returns"] });
      onDone?.();
    },
    onError: (err: any) => {
      setConfirming(false);
      setError(err?.response?.data?.error ?? "That decision could not be recorded.");
    },
  });

  if (isLoading) return <p className="p-4 text-sm text-muted">Loading the desk…</p>;
  if (!options) return <ErrorBanner error="The decision options could not be loaded." />;

  const ready = note.trim().length > 0 && Boolean(destination);
  const chosen = options.destinations.find(
    (row) => String(row.warehouse_id) === destination,
  );

  // FIX 2026-09-10: the originating point is described, not selected. It is worded as a
  // suggestion, and worded differently when no document actually named it, so a guess
  // reads as a guess on the screen the way it does in the payload.
  const suggested = options.originating_warehouse_name;
  const destinationHint = !suggested
    ? "Pick the stocking point this material goes on to."
    : options.originating_is_resolved && options.originating_source_doc
      ? `Suggestion: ${suggested}, the point this came from, per ${options.originating_source_doc}. Nothing is chosen until you pick it.`
      : `No issue or GRN names an originating point. ${suggested} is only where the return was addressed — a hint, not a choice.`;

  return (
    <div className="space-y-4">
      <RelatedDocumentsSection returnId={returnId} />

      <SectionCard
        tone="action"
        icon={<Gavel className="h-4 w-4" />}
        title="Where does this go?"
        subtitle={`${options.intent_label ?? "—"} · check the documents above, choose the stocking point it goes to, then send it to dispatch.`}
        aside={<span className="text-sm text-muted">Worth {money(options.value)}</span>}
      >
        {options.hazard_features.length > 0 && (
          <div className="mb-4 flex items-start gap-2 rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              This material is flagged <strong>{options.hazard_features.join(", ")}</strong>.
              It cannot be scrapped at a branch — use controlled disposal.
            </span>
          </div>
        )}

        {error && <ErrorBanner error={error} />}

        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field
              label="Which stocking point does it go to?"
              hint={destinationHint}
            >
              <Select
                value={destination}
                onChange={(value) => {
                  setDestination(value);
                  onDestinationChange?.(
                    options.destinations.find(
                      (row) => String(row.warehouse_id) === value,
                    )?.warehouse_name ?? null,
                  );
                }}
                options={options.destinations.map((row) => ({
                  value: String(row.warehouse_id),
                  label: [
                    row.warehouse_name ?? row.warehouse_code ?? "—",
                    row.tier_label,
                    `holds ${Number(row.on_hand ?? 0).toLocaleString()}`,
                    row.is_originating ? "originating" : null,
                  ]
                    .filter(Boolean)
                    .join(" · "),
                }))}
                placeholder="Which stocking point?"
                ariaLabel="Which stocking point"
              />
            </Field>
            <Field
              label="Where it is now"
              hint="Where the stock physically stands. It cannot go back to this point."
            >
              <Input
                value={options.current_warehouse_name ?? "—"}
                readOnly
                aria-label="Current warehouse"
              />
            </Field>
          </div>

          <Field label="Why" hint="Mandatory — the floor reads it.">
            <Input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              isInvalid={note.trim().length === 0}
              placeholder="In your own words"
              aria-label="Reason for the decision"
            />
          </Field>

          <div className="rounded-lg bg-content2 p-3 text-xs text-muted">
            On confirm, a shipment draft is raised in Logistics and goes straight to
            Dispatch — there is no consignment step. When the vehicle leaves, the
            warehouse's own document is raised automatically, filed as{" "}
            <strong className="text-ink">
              {options.purchase_return_category_label ?? "—"}
            </strong>
            {options.qc_rejected_tag ? " and tagged QC rejected after GRN" : ""}. The
            purchase return against it is raised when the receiving warehouse
            acknowledges what arrived.
          </div>

          <Button disabled={!ready || decide.isPending} onClick={() => setConfirming(true)}>
            {decide.isPending ? "Sending…" : "Send to dispatch"}
          </Button>
        </div>

        {confirming && (
          <ConfirmModal
            isOpen
            busy={decide.isPending}
            title="Send to dispatch?"
            message={
              `This return goes to ${chosen?.warehouse_name ?? "the selected point"}. ` +
              "A shipment draft is raised in Logistics and goes straight to Dispatch — " +
              "no consignment step."
            }
            confirmLabel="Send to dispatch"
            onConfirm={() => decide.mutate()}
            onClose={() => setConfirming(false)}
          />
        )}
      </SectionCard>
    </div>
  );
}
