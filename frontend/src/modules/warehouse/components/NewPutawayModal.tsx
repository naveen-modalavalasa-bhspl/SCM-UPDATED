import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { Button, ErrorBanner, Field } from "@/shared/components";
import { Lookup } from "./Lookup";
import { createPutaway, grnOptions, putawayCandidates } from "../api";
import { fmtQty } from "../format";

/**
 * Raise a putaway task by hand.
 *
 * A task normally appears on its own the moment QC passes a line, so this is the
 * repair path — a task that was cancelled, or one skipped back when skipping existed
 * and the pallet is still standing on the floor. It always starts from a GRN for that
 * reason: confirming a putaway only moves stock INTO a bin, so a task with no receipt
 * behind it would create stock that nothing was ever received against.
 *
 * Lines that cannot be raised are listed too, greyed out and carrying their reason.
 * "Why is this one not in the list" is the question a picker that hid them would leave
 * the storekeeper holding.
 */
export function NewPutawayModal({
  isOpen,
  onClose,
  onCreated,
}: {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (taskIds: number[]) => void;
}) {
  const qc = useQueryClient();
  const [grnId, setGrnId] = useState<number | "">("");
  const [picked, setPicked] = useState<number[]>([]);

  useEffect(() => {
    if (isOpen) {
      setGrnId("");
      setPicked([]);
    }
  }, [isOpen]);

  const { data: candidates = [], isFetching } = useQuery({
    queryKey: ["wh-putaway-candidates", grnId],
    queryFn: () => putawayCandidates(Number(grnId)),
    enabled: grnId !== "",
  });

  // Everything that can be raised starts ticked: the common case is "the whole GRN",
  // and unticking two lines is less work than ticking eight.
  useEffect(() => {
    setPicked(candidates.filter((c) => c.eligible).map((c) => c.grn_item_id));
  }, [candidates]);

  const eligible = candidates.filter((c) => c.eligible);

  const create = useMutation({
    mutationFn: () => createPutaway({ grn_id: Number(grnId), grn_item_ids: picked }),
    onSuccess: (tasks) => {
      qc.invalidateQueries({ queryKey: ["wh-putaways"] });
      onCreated(tasks.map((t) => t.id));
      onClose();
    },
  });

  const toggle = (id: number) =>
    setPicked((rows) => (rows.includes(id) ? rows.filter((r) => r !== id) : [...rows, id]));

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex-col items-start gap-0.5">
          <span className="font-display text-lg font-bold text-ink">New putaway</span>
          <span className="text-xs font-normal text-muted">
            Pick the GRN whose stock is still waiting on the floor.
          </span>
        </ModalHeader>

        <ModalBody>
          <ErrorBanner error={create.error} />

          <Field label="GRN">
            <Lookup
              name="grns"
              load={grnOptions}
              value={grnId}
              onChange={(id) => {
                setGrnId(id);
                setPicked([]);
              }}
              placeholder="Pick a GRN"
            />
          </Field>

          {grnId === "" ? (
            <div className="py-8 text-center text-sm text-muted">
              Choose a GRN to see its lines.
            </div>
          ) : isFetching ? (
            <div className="py-8 text-center text-sm text-muted">Loading lines…</div>
          ) : candidates.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted">
              This GRN has no lines.
            </div>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {candidates.map((c) => (
                <li key={c.grn_item_id}>
                  <label
                    className={`flex min-h-11 items-center gap-3 rounded-lg border px-3 py-2 ${
                      c.eligible
                        ? "cursor-pointer border-line/70 bg-content1"
                        : "border-line/50 bg-content2/40"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={picked.includes(c.grn_item_id)}
                      disabled={!c.eligible}
                      onChange={() => toggle(c.grn_item_id)}
                      aria-label={`Put away ${c.item_code ?? c.grn_item_id}`}
                      className="h-4 w-4 shrink-0 accent-current text-brand"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-xs text-ink">
                        {c.item_code ?? "—"}
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {c.item_name ?? "—"}
                        {c.batch_no ? ` · ${c.batch_no}` : ""}
                      </span>
                      {!c.eligible && c.reason && (
                        <span className="mt-0.5 block text-[11px] text-warn">{c.reason}</span>
                      )}
                    </span>
                    <span className="shrink-0 tabular text-sm text-ink">
                      {fmtQty(c.accepted_qty)} {c.uom_code ?? ""}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </ModalBody>

        <ModalFooter className="justify-between">
          <span className="self-center text-xs text-muted">
            {eligible.length > 0 && `${picked.length} of ${eligible.length} selected`}
          </span>
          <div className="flex gap-2">
            <Button variant="subtle" onClick={onClose}>Cancel</Button>
            <Button
              onClick={() => create.mutate()}
              disabled={picked.length === 0 || create.isPending}
            >
              Raise putaway
            </Button>
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
