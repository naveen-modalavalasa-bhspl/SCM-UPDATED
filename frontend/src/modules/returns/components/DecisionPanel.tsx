import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check } from "lucide-react";
import {
  Button, Card, ConfirmModal, ErrorBanner, Field, Input, Select,
} from "@/shared/components";
import { returnsApi } from "../api";
import { DESTRUCTIVE_DISPOSITIONS, money } from "../constants";
import type { Disposition, DispositionOption } from "../types";

/**
 * The decision desk — the heart of a field return.
 *
 * Six outcomes, two of which move nothing at all. That is the whole point of the screen:
 * before it existed every approved return moved stock, and refusing to spend freight on
 * material worth less than the freight is a call the business makes constantly.
 *
 * Everything on it is served by `GET /api/returns/{id}/decision-options` — the labels,
 * the one-line guidance under each button, which outcome the reason pre-selects, which
 * outcome this particular return may not take, the candidate points with how much of the
 * item each already holds, and the value. None of it is assembled here, so the words the
 * decider reads are the words the trail records.
 *
 * The hazard guard greys out Scrap, and `service.decide` refuses it again. Hiding a
 * button was never the control (rule 6) — scrapping something the masters flag as
 * affecting handling is the one outcome that can hurt somebody.
 */
export function DecisionPanel({
  returnId,
  onDone,
}: {
  returnId: number;
  onDone?: () => void;
}) {
  const queryClient = useQueryClient();

  const [choice, setChoice] = useState<Disposition | "">("");
  const [note, setNote] = useState("");
  const [destination, setDestination] = useState("");
  const [vendor, setVendor] = useState("");
  const [agency, setAgency] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: options, isLoading } = useQuery({
    queryKey: ["returns", returnId, "decision-options"],
    queryFn: () => returnsApi.decisionOptions(returnId),
  });

  // The reason's default, applied once the options arrive and never again — re-applying
  // it on every render would undo the decider's own choice as they typed the reason.
  useEffect(() => {
    if (!options || choice) return;
    if (options.default_disposition) setChoice(options.default_disposition);
    const preferred = options.destinations.find((row) => row.is_default);
    if (preferred) setDestination(String(preferred.warehouse_id));
  }, [options]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected: DispositionOption | undefined = useMemo(
    () => options?.dispositions.find((row) => row.value === choice),
    [options, choice],
  );

  const decide = useMutation({
    mutationFn: () =>
      returnsApi.decide(returnId, {
        disposition: choice as Disposition,
        note: note.trim(),
        to_warehouse_id: selected?.needs_destination ? Number(destination) : null,
        vendor_id: selected?.needs_vendor ? Number(vendor) : null,
        disposal_agency: selected?.needs_agency ? agency.trim() : null,
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

  const ready =
    Boolean(selected) &&
    !selected!.is_blocked &&
    note.trim().length > 0 &&
    (!selected!.needs_destination || Boolean(destination)) &&
    (!selected!.needs_vendor || Boolean(vendor)) &&
    (!selected!.needs_agency || agency.trim().length > 0);

  return (
    <Card className="p-4">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-bold text-ink">Where does this go?</h2>
        <span className="text-sm text-muted">
          {/* An em dash, never ₹0: the freight-versus-value call is made against this
            * number, and every valuation column is empty across the live data. */}
          Worth {money(options.value)}
        </span>
      </div>
      <p className="mb-4 text-sm text-muted">
        {options.intent_label ?? "—"} · pick one and say why. The floor reads your reason.
      </p>

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

      <div className="space-y-2" role="radiogroup" aria-label="What happens to the stock">
        {options.dispositions.map((option) => {
          const active = option.value === choice;
          const destructive = DESTRUCTIVE_DISPOSITIONS.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={option.is_blocked}
              onClick={() => setChoice(option.value)}
              className={`w-full rounded-xl border p-3 text-left transition-colors ${
                option.is_blocked
                  ? "cursor-not-allowed border-line bg-content2 opacity-60"
                  : active
                    ? destructive
                      ? "border-bad bg-bad-bg"
                      : "border-brand bg-brand/10"
                    : "border-line hover:bg-content2"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={`text-sm font-semibold ${
                    active ? (destructive ? "text-bad" : "text-brand") : "text-ink"
                  }`}
                >
                  {option.label}
                </span>
                <span className="flex items-center gap-2">
                  {option.is_default && !active && (
                    <span className="rounded-full bg-content2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                      Suggested
                    </span>
                  )}
                  {!option.moves_stock && (
                    <span className="rounded-full bg-content2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                      Nothing moves
                    </span>
                  )}
                  {active && <Check className="h-4 w-4 text-brand" />}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted">
                {option.is_blocked ? option.blocked_reason : option.hint}
              </p>
            </button>
          );
        })}
      </div>

      <div className="mt-4 space-y-4">
        {selected?.needs_destination && (
          <Field
            label="Send it to"
            hint="Whoever holds least of it is listed first — that is who needs it most."
          >
            <Select
              value={destination}
              onChange={setDestination}
              options={options.destinations.map((row) => ({
                value: String(row.warehouse_id),
                label: `${row.warehouse_name ?? row.warehouse_code ?? "—"}${
                  row.tier_label ? ` · ${row.tier_label}` : ""
                } · holds ${Number(row.on_hand ?? 0).toLocaleString()}`,
              }))}
              placeholder="Which stocking point?"
              ariaLabel="Destination stocking point"
            />
          </Field>
        )}

        {selected?.needs_vendor && (
          <Field label="Vendor" hint="Whoever is liable — under warranty, or the recall.">
            <Select
              value={vendor}
              onChange={setVendor}
              options={options.vendors.map((row) => ({
                value: String(row.id),
                label: `${row.name ?? "—"}${row.code ? ` · ${row.code}` : ""}`,
              }))}
              placeholder="Which vendor?"
              ariaLabel="Vendor the stock goes back to"
            />
          </Field>
        )}

        {selected?.needs_agency && (
          <Field
            label="Disposal agency"
            hint="Licensed agency. The certificate has to be on file before this closes."
          >
            <Input
              value={agency}
              onChange={(event) => setAgency(event.target.value)}
              placeholder="Who is carrying out the disposal?"
              aria-label="Disposal agency"
            />
          </Field>
        )}

        <Field label="Why" hint="Mandatory — the floor is about to read it.">
          <Input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            isInvalid={note.trim().length === 0}
            placeholder="In your own words"
            aria-label="Reason for the decision"
          />
        </Field>

        <Button disabled={!ready || decide.isPending} onClick={() => setConfirming(true)}>
          {decide.isPending ? "Recording…" : "Record decision"}
        </Button>
      </div>

      {confirming && selected && (
        <ConfirmModal
          isOpen
          danger={DESTRUCTIVE_DISPOSITIONS.includes(selected.value)}
          busy={decide.isPending}
          title={`${selected.label}?`}
          message={
            selected.moves_stock
              ? `${selected.hint} Your reason goes to the floor, who either carries it out or sends it back to you.`
              : `${selected.hint} The hold on the stock is released and nothing is shipped.`
          }
          confirmLabel="Record decision"
          onConfirm={() => decide.mutate()}
          onClose={() => setConfirming(false)}
        />
      )}
    </Card>
  );
}
