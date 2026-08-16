import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Button, Can, Card, ErrorBanner, Field, Input, Select, useAction,
} from "@/shared/components";
import { transportApi } from "../api";
import { money } from "./modeCopy";
import type { CarrierQuote } from "../transportTypes";

/**
 * The tender: invite carriers, capture what they quoted, and award.
 *
 * The ranking comes from the backend, never from sorting here. That matters because
 * the score stored against the winning quote is the justification for the award — a
 * screen that ordered the rows itself could show a different winner from the one the
 * award check would accept.
 *
 * Changing the method in this dropdown only previews: it is a query parameter, and
 * nothing is written until Award.
 */
export function QuoteComparison({
  trId, status, quotes,
}: {
  trId: number;
  status: string;
  quotes: CarrierQuote[];
}) {
  const [method, setMethod] = useState("");
  const [inviting, setInviting] = useState(false);
  const [chosen, setChosen] = useState<number[]>([]);
  const [quoting, setQuoting] = useState<CarrierQuote | null>(null);
  const [form, setForm] = useState({
    freight_amount: "", other_charges: "", tax_percent: "", transit_days: "",
    vehicle_type: "",
  });

  const { data: methods } = useQuery({
    queryKey: ["transport-eval-methods"],
    queryFn: transportApi.evaluationMethods,
  });
  const { data: carriers } = useQuery({
    queryKey: ["transport-carriers"],
    queryFn: () => transportApi.carriers(),
  });
  const { data: comparison, error } = useQuery({
    queryKey: ["transport-comparison", trId, method],
    queryFn: () => transportApi.comparison(trId, method || undefined),
    enabled: quotes.length > 0,
  });

  const invalidates = [["transport", String(trId)], ["transport-comparison", trId]];

  const invite = useAction({
    run: () => transportApi.invite(trId, chosen, method || undefined),
    success: "Carriers invited to quote",
    invalidates,
    onDone: () => { setInviting(false); setChosen([]); },
  });
  const record = useAction({
    run: () => transportApi.recordQuote(trId, quoting!.carrier_id, {
      freight_amount: Number(form.freight_amount || 0),
      other_charges: Number(form.other_charges || 0),
      tax_percent: form.tax_percent ? Number(form.tax_percent) : null,
      transit_days: form.transit_days ? Number(form.transit_days) : null,
      vehicle_type: form.vehicle_type || null,
    }),
    success: "Quote recorded",
    invalidates,
    onDone: () => setQuoting(null),
  });
  const award = useAction({
    run: (quoteId: number) => transportApi.award(trId, quoteId),
    success: "Shipment awarded",
    invalidates,
  });

  const canTender = status === "QUOTING";

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold text-ink">
            Provider selection
          </h2>
          <p className="text-xs text-muted">
            {comparison
              ? `${comparison.responded} of ${comparison.invited} invited carriers have quoted`
              : "No carriers invited yet"}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-56">
            <Select
              value={method || comparison?.evaluation_method || ""}
              placeholder="Rank by…"
              options={(methods ?? []).map((m) => ({ value: m.value, label: m.label }))}
              onChange={setMethod}
            />
          </div>
          {canTender && (
            <Can do="transport.award">
              <Button variant="ghost" onClick={() => setInviting(true)}>
                Invite carriers
              </Button>
            </Can>
          )}
        </div>
      </div>

      <ErrorBanner error={error ?? invite.error ?? record.error ?? award.error} />

      {comparison && !comparison.meets_three_quote_norm && comparison.responded > 0 && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          Only {comparison.responded} quote{comparison.responded === 1 ? "" : "s"} on
          file. The standard is three — award anyway if this is a single-carrier lane.
        </p>
      )}

      {quotes.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">
          Invite carriers to price this shipment.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="py-2">Rank</th>
                <th className="py-2">Carrier</th>
                <th className="py-2 text-right">Freight</th>
                <th className="py-2 text-right">Other</th>
                <th className="py-2 text-right">Landed</th>
                <th className="py-2 text-right">Days</th>
                <th className="py-2 text-right">Score</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {(comparison?.rows ?? []).map((row) => (
                <tr
                  key={row.quote_id}
                  className={`border-b border-line/50 ${
                    row.is_recommended ? "bg-emerald-50/60 dark:bg-emerald-900/10" : ""
                  }`}
                >
                  <td className="py-2 font-semibold">
                    {row.rank}
                    {row.is_recommended && (
                      <span className="ml-1.5 text-[10px] font-medium uppercase text-emerald-700 dark:text-emerald-300">
                        Best
                      </span>
                    )}
                  </td>
                  <td className="py-2">
                    <div className="text-ink">{row.carrier_name}</div>
                    <div className="text-[11px] text-muted">
                      {row.vehicle_type ?? row.status.toLowerCase()}
                    </div>
                  </td>
                  <td className="py-2 text-right">{money(row.freight_amount)}</td>
                  <td className="py-2 text-right">{money(row.other_charges)}</td>
                  <td className="py-2 text-right font-semibold text-ink">
                    {money(row.landed_cost)}
                  </td>
                  <td className="py-2 text-right">{row.transit_days ?? "—"}</td>
                  <td className="py-2 text-right">{row.score.toFixed(2)}</td>
                  <td className="py-2 text-right">
                    {canTender && row.status === "SUBMITTED" && (
                      <Can do="transport.award">
                        <Button
                          variant="ghost"
                          onClick={() => award.mutate(row.quote_id)}
                          disabled={award.isPending}
                        >
                          Award
                        </Button>
                      </Can>
                    )}
                  </td>
                </tr>
              ))}

              {/* Invited but silent. Kept visible so "who has not replied" is one
                  glance rather than a diff against the invite list. */}
              {quotes.filter((q) => q.status === "INVITED").map((quote) => (
                <tr key={quote.id} className="border-b border-line/50 text-muted">
                  <td className="py-2">—</td>
                  <td className="py-2">{quote.carrier_name}</td>
                  <td className="py-2 text-right" colSpan={5}>
                    <span className="text-xs">Invited, no quote yet</span>
                  </td>
                  <td className="py-2 text-right">
                    {canTender && (
                      <Can do="transport.award">
                        <Button variant="ghost" onClick={() => { setQuoting(quote); }}>
                          Enter quote
                        </Button>
                      </Can>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {inviting && (
        <div className="rounded-lg border border-line p-4">
          <Field label="Carriers to invite">
            <Select
              value=""
              placeholder="Add a carrier"
              options={(carriers ?? [])
                .filter((c) => !chosen.includes(c.id)
                  && !quotes.some((q) => q.carrier_id === c.id))
                .map((c) => ({ value: c.id, label: c.name }))}
              onChange={(value) => setChosen([...chosen, Number(value)])}
            />
          </Field>
          <div className="mt-2 flex flex-wrap gap-2">
            {chosen.map((carrierId) => (
              <span
                key={carrierId}
                className="rounded-full bg-content2 px-2.5 py-1 text-xs text-body"
              >
                {carriers?.find((c) => c.id === carrierId)?.name ?? carrierId}
                <button
                  className="ml-1.5 text-muted"
                  onClick={() => setChosen(chosen.filter((c) => c !== carrierId))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <Button variant="ghost" onClick={() => { setInviting(false); setChosen([]); }}>
              Cancel
            </Button>
            <Button
              onClick={() => invite.mutate()}
              disabled={!chosen.length || invite.isPending}
            >
              Invite {chosen.length || ""}
            </Button>
          </div>
        </div>
      )}

      {quoting && (
        <div className="rounded-lg border border-line p-4">
          <h3 className="mb-3 text-sm font-semibold text-ink">
            Quote from {quoting.carrier_name}
          </h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Freight">
              <Input type="number" value={form.freight_amount}
                onChange={(e) => setForm({ ...form, freight_amount: e.target.value })} />
            </Field>
            <Field label="Other charges">
              <Input type="number" value={form.other_charges}
                onChange={(e) => setForm({ ...form, other_charges: e.target.value })} />
            </Field>
            <Field label="Tax %">
              <Input type="number" value={form.tax_percent}
                onChange={(e) => setForm({ ...form, tax_percent: e.target.value })} />
            </Field>
            <Field label="Transit days">
              <Input type="number" value={form.transit_days}
                onChange={(e) => setForm({ ...form, transit_days: e.target.value })} />
            </Field>
            <Field label="Vehicle type">
              <Input value={form.vehicle_type}
                onChange={(e) => setForm({ ...form, vehicle_type: e.target.value })} />
            </Field>
          </div>
          <div className="mt-3 flex gap-2">
            <Button variant="ghost" onClick={() => setQuoting(null)}>Cancel</Button>
            <Button onClick={() => record.mutate()} disabled={record.isPending}>
              Save quote
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
