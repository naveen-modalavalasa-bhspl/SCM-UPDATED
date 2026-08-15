import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import {
  Button, Card, EmptyState, ErrorBanner, Input, PageHeader,
} from "@/shared/components";
import { returnsApi } from "../api";
import { ReturnsNav } from "../components/ReturnsNav";
import type { ReceivingStep } from "../types";

/**
 * Who looks at a return once its reporting line has signed — the inventory desk, then
 * the warehouse. The same leg an indent has between its approval and the goods moving.
 *
 * It has to be configured rather than derived: nothing in HCM or the warehouse data
 * says which post is the inventory desk (their posts have no parent and are mapped to
 * no stocking point), so a climb can never reach them. Saving here writes the ladder
 * the workflow engine then resolves at submit — see `modules/returns/receiving.py`.
 *
 * Order is the signing order. An empty list is a real choice: no receiving check, and
 * returns settle on their reporting line's approval alone.
 */
export default function ReceivingConfigPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<ReceivingStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const { data: config, isLoading } = useQuery({
    queryKey: ["returns", "receiving-config"],
    queryFn: returnsApi.receivingConfig,
  });

  const { data: found = [], isFetching } = useQuery({
    queryKey: ["returns", "receiving-positions", search],
    queryFn: () => returnsApi.receivingPositions(search),
    enabled: search.trim().length >= 2,
  });

  // The draft only exists once something is changed; until then the screen shows what
  // is saved, so a reload can never look like unsaved work.
  const steps = draft ?? config?.steps ?? [];
  const dirty = draft !== null;

  const change = (next: ReceivingStep[]) => {
    setSaved(false);
    setDraft(next.map((step, index) => ({ ...step, sequence: index + 1 })));
  };

  const add = (position: { id: number; name: string | null; holders: ReceivingStep["holders"] }) => {
    if (steps.some((step) => step.position_id === position.id)) return;
    change([
      ...steps,
      {
        sequence: steps.length + 1,
        position_id: position.id,
        name: position.name,
        holders: position.holders,
        is_dead: position.holders.length === 0,
      },
    ]);
  };

  const move = (index: number, by: -1 | 1) => {
    const next = [...steps];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    change(next);
  };

  const save = useMutation({
    mutationFn: () => returnsApi.saveReceivingConfig(steps.map((s) => s.position_id)),
    onSuccess: () => {
      setError(null);
      setDraft(null);
      setSaved(true);
      queryClient.invalidateQueries({ queryKey: ["returns", "receiving-config"] });
    },
    onError: (err: any) =>
      setError(err?.response?.data?.error ?? "That could not be saved."),
  });

  return (
    <div>
      <ReturnsNav />
      <PageHeader
        eyebrow="RETURNS"
        title="Receiving approvers"
        actions={
          <>
            {dirty && (
              <Button variant="subtle" onClick={() => { setDraft(null); setError(null); }}>
                Discard
              </Button>
            )}
            <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </>
        }
      />

      {error && <ErrorBanner error={error} />}

      <Card className="mb-4 p-4">
        <p className="text-sm text-body">
          After a return is approved along the reporting line it comes here: each post
          below signs in order, and the stock moves only when the last one does. Then the
          person who raised it acknowledges.
        </p>
        {config && config.version > 0 && (
          <p className="mt-2 text-xs text-muted">
            Version {config.version} is live.
            {config.in_flight > 0 &&
              ` ${config.in_flight} return${config.in_flight > 1 ? "s" : ""} already with
               this desk keep the version they started on — saving never moves a return
               already in approval.`}
          </p>
        )}
        {config?.warnings.map((warning) => (
          <p key={warning} className="mt-2 text-sm font-medium text-warn">
            {warning}
          </p>
        ))}
        {saved && !dirty && (
          <p className="mt-2 text-sm font-medium text-ok">Saved.</p>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
            Signing order
          </h2>
          {isLoading && <p className="text-sm text-muted">Loading…</p>}
          {!isLoading && steps.length === 0 && (
            <EmptyState
              title="No receiving check"
              hint="Returns settle on their reporting line's approval alone. Add the inventory and warehouse posts on the right."
            />
          )}
          <ol className="space-y-2">
            {steps.map((step, index) => (
              <li
                key={step.position_id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line/70 p-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-ink">
                    {index + 1}. {step.name ?? `Position ${step.position_id}`}
                  </div>
                  <div className="text-xs text-muted">
                    {step.holders.map((holder) => holder.name).filter(Boolean).join(", ")
                      || "Nobody in this chair — it will be skipped"}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="subtle"
                    aria-label={`Move ${step.name ?? step.position_id} up`}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="subtle"
                    aria-label={`Move ${step.name ?? step.position_id} down`}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="dangerSoft"
                    aria-label={`Remove ${step.name ?? step.position_id}`}
                    onClick={() =>
                      change(steps.filter((row) => row.position_id !== step.position_id))
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        </Card>

        <Card className="p-4">
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
            Add a post
          </h2>
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by post, rank or the person in it"
            aria-label="Search positions"
          />
          {search.trim().length > 0 && search.trim().length < 2 && (
            <p className="mt-2 text-xs text-muted">Type at least two characters.</p>
          )}
          {isFetching && <p className="mt-2 text-sm text-muted">Searching…</p>}
          {search.trim().length >= 2 && !isFetching && found.length === 0 && (
            <p className="mt-2 text-sm text-muted">No post matches that.</p>
          )}
          <ul className="mt-3 space-y-2">
            {found.map((position) => (
              <li
                key={position.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line/70 p-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-ink">
                    {position.name}
                  </div>
                  <div className="text-xs text-muted">
                    {[
                      position.role_name,
                      position.holders.map((holder) => holder.name).filter(Boolean).join(", "),
                    ]
                      .filter(Boolean)
                      .join(" · ") || "Nobody in this chair"}
                  </div>
                </div>
                <Button
                  variant="soft"
                  disabled={steps.some((step) => step.position_id === position.id)}
                  onClick={() => add(position)}
                >
                  <Plus className="h-4 w-4" /> Add
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
