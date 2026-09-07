import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, Card, ErrorBanner, Field, Input, PageHeader, Select,
} from "@/shared/components";
import { returnsApi } from "../api";
import { AttachmentsPanel } from "../components/AttachmentsPanel";
import {
  BLANK_LINE, ReturnLinesEditor, holdingFor, isWholeUnit,
} from "../components/ReturnLinesEditor";
import { INTENT_OPTIONS } from "../constants";
import {
  PHOTO_CATEGORY, type ReturnIntent, type ReturnLineWrite, type ReturnWrite,
  type StagedAttachment,
} from "../types";
import { TONE_SUBMIT } from "@/shared/components/tones";

/**
 * Raise or edit a return — laid out like the New indent screen: LINE ITEMS on the left,
 * a DETAILS rail on the right, the same header actions.
 *
 * The identity block in that rail is read from the server and shown read-only. It is
 * never posted: the backend derives it from the signed-in position, so a browser cannot
 * claim to be returning somebody else's stock from somebody else's office.
 *
 * Photos are picked here even on a brand new return: `sys_attachments` is keyed by
 * document id, so the files are held in state and posted the moment the draft is
 * created. A photograph of the stock is mandatory to submit — the approver is being
 * asked to believe material is damaged or expired, and the picture is the evidence.
 */
export default function ReturnFormPage() {
  const { id } = useParams<{ id: string }>();
  const returnId = id ? Number(id) : null;
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [reason, setReason] = useState("");
  const [reasonNote, setReasonNote] = useState("");
  // What the branch wants to happen next. Changes nothing about how the stock moves and
  // everything about what the decision desk decides: the same material with a replacement
  // expected goes back to a liable vendor, where with none wanted it might be scrapped.
  const [intent, setIntent] = useState<ReturnIntent>("RETURN");
  const [lines, setLines] = useState<ReturnLineWrite[]>([{ ...BLANK_LINE }]);
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);

  const { data: raiser } = useQuery({
    queryKey: ["returns", "raiser"],
    queryFn: returnsApi.raiser,
  });

  const { data: reasons = [] } = useQuery({
    queryKey: ["returns", "reasons"],
    queryFn: returnsApi.reasons,
  });

  // size 500 is the shared page ceiling: a picker cannot paginate, and a storekeeper
  // holding more than 500 distinct items does not exist in this data.
  const { data: stockPage } = useQuery({
    queryKey: ["returns", "my-stock"],
    queryFn: () => returnsApi.myStock({ size: 500 }),
  });

  const { data: existing } = useQuery({
    queryKey: ["returns", returnId],
    queryFn: () => returnsApi.get(returnId as number),
    enabled: returnId !== null,
  });

  // Same query key the panel uses, so this shares its cache rather than fetching twice.
  // Read here because the Submit gate lives here: a return with no photo of the stock
  // cannot go to an approver.
  const { data: attached = [] } = useQuery({
    queryKey: ["returns", returnId, "attachments"],
    queryFn: () => returnsApi.attachments(returnId as number),
    enabled: returnId !== null,
  });

  useEffect(() => {
    if (!existing) return;
    setReason(existing.reason ?? "");
    setReasonNote(existing.reason_note ?? "");
    setIntent(existing.intent ?? "RETURN");
    setLines(
      existing.items.length
        ? existing.items.map((line) => ({
            item_id: line.item_id,
            quantity: String(line.quantity ?? ""),
            remarks: line.remarks ?? "",
          }))
        : [{ ...BLANK_LINE }],
    );
  }, [existing]);

  const stock = stockPage?.items ?? [];
  const readOnly = existing ? !existing.can_edit : false;

  const validLines = useMemo(
    () => lines.filter((line) => line.item_id && Number(line.quantity) > 0),
    [lines],
  );

  const overCommitted = useMemo(() => {
    const wanted = new Map<number, number>();
    for (const line of validLines) {
      wanted.set(line.item_id, (wanted.get(line.item_id) ?? 0) + Number(line.quantity));
    }
    // Summed per item, not per line: two lines of the same item can each fit under the
    // shelf quantity while together exceeding it, which the backend would reject at
    // submit after the raiser thought they were done.
    return [...wanted.entries()].some(
      ([itemId, want]) => want > (holdingFor(stock, itemId)?.quantity ?? 0),
    );
  }, [validLines, stock]);

  /** The same item on two lines. Blocked here as well as in the editor, because the
   * editor only greys the option out — a draft loaded from the server could already
   * hold a pair, and that must not be submittable. */
  const hasDuplicate = useMemo(() => {
    const seen = new Set<number>();
    return validLines.some((line) =>
      seen.size === seen.add(line.item_id).size);
  }, [validLines]);

  const hasFraction = useMemo(
    () =>
      validLines.some((line) => {
        const holding = holdingFor(stock, line.item_id);
        return isWholeUnit(holding?.uom) && !Number.isInteger(Number(line.quantity));
      }),
    [validLines, stock],
  );

  /** Already on the document plus still in the tray — both count as attached. */
  const photoCount =
    attached.filter((file) => file.doc_category === PHOTO_CATEGORY).length +
    staged.filter((row) => row.category === PHOTO_CATEGORY).length;

  const noteRequired = reason === "OTHER";
  const canSave =
    Boolean(reason) &&
    validLines.length > 0 &&
    !overCommitted &&
    !hasDuplicate &&
    !hasFraction &&
    !(noteRequired && !reasonNote.trim());
  // A draft is a scratchpad and saves without the photo; submitting is what needs it,
  // and the backend refuses a submit without one either way.
  const canSubmit = canSave && photoCount > 0;

  const body = (): ReturnWrite => ({
    reason,
    reason_note: reasonNote.trim() || null,
    // Everything raised here comes off a branch shelf. Sent rather than left to default so
    // the register never has to infer which family a row belongs to.
    kind: "FIELD",
    intent,
    items: validLines.map((line) => ({
      item_id: line.item_id,
      quantity: String(line.quantity),
      remarks: line.remarks?.trim() || null,
    })),
  });

  const fail = (err: any) =>
    setError(err?.response?.data?.error ?? "That could not be saved.");

  /** Posts what was picked before the document had an id. Sequential, because the
   * endpoint takes one file per call. */
  const flushStaged = async (docId: number) => {
    for (const row of staged) {
      await returnsApi.upload(docId, row.file, row.category);
    }
    setStaged([]);
  };

  const save = useMutation({
    mutationFn: async () => {
      const saved = returnId
        ? await returnsApi.update(returnId, body())
        : await returnsApi.create(body());
      await flushStaged(saved.id);
      return saved;
    },
    onSuccess: (saved) => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["returns"] });
      if (!returnId) navigate(`/returns/${saved.id}/edit`, { replace: true });
    },
    onError: fail,
  });

  const submit = useMutation({
    mutationFn: async () => {
      const saved = returnId
        ? await returnsApi.update(returnId, body())
        : await returnsApi.create(body());
      // Before the submit, not after: `add_file` refuses anything once the document has
      // left DRAFT, so a photo posted afterwards would be rejected and lost.
      await flushStaged(saved.id);
      return returnsApi.submit(saved.id);
    },
    onSuccess: (saved) => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["returns"] });
      navigate(`/returns/${saved.id}`);
    },
    onError: fail,
  });

  const busy = save.isPending || submit.isPending;

  return (
    <div>
      <PageHeader
        eyebrow="RETURN"
        title={returnId ? "Edit return" : "New return"}
        actions={
          <>
            <Button variant="subtle" onClick={() => navigate("/returns")}>
              Back
            </Button>
            {!readOnly && (
              <>
                <Button variant="soft" disabled={!canSave || busy} onClick={() => save.mutate()}>
                  {save.isPending ? "Saving…" : "Save draft"}
                </Button>
                <Button className={TONE_SUBMIT} disabled={!canSubmit || busy} onClick={() => submit.mutate()}>
                  {submit.isPending ? "Submitting…" : "Submit for approval"}
                </Button>
              </>
            )}
          </>
        }
      />

      {error && <ErrorBanner error={error} />}

      {raiser?.destination_note && !raiser.to_warehouse_id && (
        <ErrorBanner error={raiser.destination_note} />
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card className="p-4">
            <h2 className="mb-4 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
              Line items
            </h2>
            <ReturnLinesEditor
              lines={lines}
              onChange={setLines}
              stock={stock}
              disabled={readOnly}
            />
            {stock.length === 0 && (
              <p className="mt-3 text-sm text-muted">
                There is no stock on your point to return.
              </p>
            )}
          </Card>

          <AttachmentsPanel
            returnId={returnId}
            editable={!readOnly}
            staged={staged}
            onStagedChange={setStaged}
            photoRequired={!readOnly}
          />
        </div>

        <Card className="h-fit p-4">
          <h2 className="mb-4 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
            Details
          </h2>

          <div className="space-y-4">
            <Field label="Reason">
              <Select
                value={reason}
                onChange={setReason}
                options={reasons.map((row) => ({ value: row.value, label: row.label }))}
                placeholder="Why is this coming back?"
                isDisabled={readOnly}
                ariaLabel="Reason for the return"
              />
            </Field>

            {/* Two options, so buttons rather than a dropdown — and the hint under each
              * says what it commits somebody else to, which a select cannot. */}
            <Field label="What do you want to happen?">
              <div className="space-y-2" role="radiogroup" aria-label="Return intent">
                {INTENT_OPTIONS.map((option) => {
                  const active = option.value === intent;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={readOnly}
                      onClick={() => setIntent(option.value)}
                      className={`w-full rounded-xl border p-3 text-left transition-colors ${
                        readOnly
                          ? "cursor-not-allowed border-line opacity-60"
                          : active
                            ? "border-brand bg-brand/10"
                            : "border-line hover:bg-content2"
                      }`}
                    >
                      <span
                        className={`text-sm font-semibold ${
                          active ? "text-brand" : "text-ink"
                        }`}
                      >
                        {option.label}
                      </span>
                      <p className="mt-0.5 text-xs text-muted">{option.hint}</p>
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field
              label={noteRequired ? "Description" : "Description (optional)"}
              hint={noteRequired ? "Required when the reason is Other" : undefined}
            >
              <Input
                value={reasonNote}
                onChange={(event) => setReasonNote(event.target.value)}
                disabled={readOnly}
                isInvalid={noteRequired && !reasonNote.trim()}
                placeholder="In your own words"
                aria-label="Description"
              />
            </Field>

            <div className="border-t border-line pt-4">
              <dl className="space-y-3 text-sm">
                {[
                  ["Returned by", raiser?.employee_name],
                  ["Employee id", raiser?.employee_code],
                  ["Position", raiser?.position_name],
                  ["Office", raiser?.office_name],
                  ["Returning from", raiser?.from_warehouse_name],
                  ["Going to", raiser?.to_warehouse_name],
                ].map(([label, value]) => (
                  <div key={label as string}>
                    <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                      {label}
                    </dt>
                    <dd className="text-ink">{(value as string) || "—"}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-4 text-xs text-muted">
                Filled in from your position — it cannot be edited here.
              </p>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
