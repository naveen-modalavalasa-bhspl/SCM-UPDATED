import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Layers, MessageSquareQuote, X } from "lucide-react";
import { Can, Textarea, TONE_RED, useToast } from "@/shared/components";
import { PackChips } from "@/shared/packing";
import { Button } from "./ActionButton";
import { poApi } from "../api";
import type { POPackChange } from "../types";

const STATUS: Record<POPackChange["status"], { label: string; tone: string }> = {
  PENDING: { label: "Waiting for you", tone: "bg-warn-bg text-warn" },
  ACCEPTED: { label: "Accepted", tone: "bg-ok-bg text-ok" },
  DECLINED: { label: "Declined", tone: "bg-bad-bg text-bad" },
};

/**
 * A supplier sending a DIFFERENT pack hierarchy from the order's (2026-10-08) —
 * "you ordered strips of 10, we are sending strips of 15". Allowed, never silent: the
 * buyer is notified on submit and answers here. Accepting rewrites the order line's
 * packing (same quantity, new family); declining tells the supplier why, and the gate
 * sees the refusal before booking the goods in.
 */
export function PackChangesPanel({ poId }: { poId: number }) {
  const changes = useQuery({
    queryKey: ["po-pack-changes", poId],
    queryFn: () => poApi.packChanges(poId),
  });
  const location = useLocation();
  const anchor = useRef<HTMLDivElement>(null);
  const pending = (changes.data ?? []).filter((c) => c.status === "PENDING").length;

  // The buyer's notification deep-links here (?tab=packing).
  useEffect(() => {
    if (new URLSearchParams(location.search).get("tab") === "packing" && changes.data?.length) {
      anchor.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [location.search, changes.data?.length]);

  if (!changes.data?.length) return null;
  return (
    <div ref={anchor} id="packing"
         className="overflow-hidden rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 via-orange-50/40 to-white shadow-sm">
      <div className="h-1 w-full bg-gradient-to-r from-amber-400 via-orange-400 to-amber-500" />
      <div className="space-y-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-amber-500 text-white">
            <Layers className="h-4 w-4" />
          </div>
          <h2 className="text-sm font-extrabold uppercase tracking-widest text-amber-800">
            Packing changes from the supplier
          </h2>
          {pending > 0 && (
            <span className="rounded-full bg-amber-500 px-2.5 py-1 text-xs font-bold text-white">
              {pending} to answer
            </span>
          )}
        </div>
        <p className="text-xs text-amber-900/80">
          The quantity is what you bought and does not change. Accepting moves this order
          line to the supplier&apos;s pack hierarchy, so the receipt and the shelf follow it.
        </p>
        {changes.data.map((change) => (
          <PackChangeCard key={change.id} poId={poId} change={change} />
        ))}
      </div>
    </div>
  );
}

function PackChangeCard({ poId, change }: { poId: number; change: POPackChange }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState("");
  const decide = useMutation({
    mutationFn: (accept: boolean) => poApi.decidePackChange(poId, change.id, accept, note),
    onSuccess: (row) => {
      setDeclining(false);
      setNote("");
      qc.invalidateQueries({ queryKey: ["po-pack-changes", poId] });
      qc.invalidateQueries({ queryKey: ["purchase-order", poId] });
      qc.invalidateQueries({ queryKey: ["pos"] });
      toast.success(row.status === "ACCEPTED"
        ? `The order now asks for "${row.sent_hierarchy_name}" — the supplier has been told.`
        : "Declined — the supplier and the gate will see your reason.");
    },
  });
  const status = STATUS[change.status];

  return (
    <div className="rounded-xl bg-white p-3 ring-1 ring-amber-100">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-bold text-ink">{change.item_name ?? change.item_code}</div>
          <div className="font-mono text-xs text-muted">
            {change.item_code} · on {change.dn_no}
          </div>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${status.tone}`}>
          {status.label}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="rounded-lg bg-neutral-bg px-2 py-1 text-ink-700">
          Ordered: <b>{change.ordered_hierarchy_name ?? "—"}</b>
        </span>
        <ArrowRight className="h-4 w-4 text-amber-600" aria-label="changed to" />
        <span className="rounded-lg bg-amber-100 px-2 py-1 text-amber-900">
          Sent: <b>{change.sent_hierarchy_name ?? "—"}</b>
        </span>
      </div>
      <div className="mt-2">
        <PackChips entries={change.pack_breakdown} uom={change.uom_code} showHierarchy={false} />
      </div>
      {change.reason && (
        <blockquote className="mt-2 flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <MessageSquareQuote className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>&ldquo;{change.reason}&rdquo; — the supplier</span>
        </blockquote>
      )}
      {change.status !== "PENDING" && (
        <div className="mt-2 text-xs text-muted">
          {change.status === "ACCEPTED" ? "Accepted" : "Declined"} by{" "}
          {change.decided_by_name ?? "—"}{change.decision_note ? ` — “${change.decision_note}”` : ""}
        </div>
      )}
      {change.status === "PENDING" && (
        <Can do="po.pack_change">
          {declining ? (
            <div className="mt-3 space-y-2">
              <Textarea value={note} minRows={2} aria-label="Why the change is declined"
                        placeholder="Tell the supplier why — e.g. the 15-strip has a different MRP"
                        onChange={(e) => setNote(e.target.value)} />
              <div className="flex flex-wrap gap-2">
                <Button className={TONE_RED} disabled={!note.trim() || decide.isPending}
                        onClick={() => decide.mutate(false)}>
                  <X className="h-4 w-4" /> Decline change
                </Button>
                <Button variant="ghost" onClick={() => { setDeclining(false); setNote(""); }}>Back</Button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button disabled={decide.isPending} onClick={() => decide.mutate(true)}>
                <Check className="h-4 w-4" /> Accept {change.sent_hierarchy_name}
              </Button>
              <Button variant="subtle" onClick={() => setDeclining(true)}>Decline…</Button>
            </div>
          )}
        </Can>
      )}
    </div>
  );
}
