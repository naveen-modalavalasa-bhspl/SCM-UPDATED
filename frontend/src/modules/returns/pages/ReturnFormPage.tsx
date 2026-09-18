import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, ErrorBanner, Field, Input, PageHeader, Select,
  TONE_DEEP_MINT, TONE_MINT, TONE_PINK,
} from "@/shared/components";
import { returnsApi } from "../api";
import { AttachmentsPanel } from "../components/AttachmentsPanel";
import { FormSection } from "../components/FormSection";
import { NextStepsCard } from "../components/NextStepsCard";
import { RaiserStrip } from "../components/RaiserStrip";
import { SubmitChecklist, type ChecklistItem } from "../components/SubmitChecklist";
import {
  BLANK_LINE, ReturnLinesEditor, holdingFor, isWholeUnit,
} from "../components/ReturnLinesEditor";
import { KIND_OPTIONS } from "../constants";
import {
  PHOTO_CATEGORY, type ReturnIntent, type ReturnKind, type ReturnLineWrite,
  type ReturnWrite, type StagedAttachment,
} from "../types";

/**
 * Raise or edit a return.
 *
 * REDRAWN 2026-09-07 as THREE NUMBERED STEPS IN THE ORDER THEY MUST BE ANSWERED, over a
 * standing right-hand rail that says what is still outstanding. What was wrong with the
 * previous layout was not its styling — it was that the screen's shape contradicted its
 * own rules:
 *
 *  1. THE GATE WAS IN THE WRONG COLUMN. "Against indent" decides which shelf the item
 *     picker is built from, so until it is answered the picker legitimately has nothing
 *     in it. That question sat in the narrow right rail while the card it gated filled
 *     the wide left one, so the page opened with the eye landing on a switched-off Line
 *     items card whose only content was a note telling the reader to look elsewhere
 *     first. The gate is now step 1 and the items it gates are step 2, in the left
 *     column, in that order.
 *  2. THE READ-ONLY IDENTITY BLOCK WAS FIVE DISABLED TEXT BOXES — ~330px of rail for
 *     five short facts, in a control that reads as a broken input. It is `RaiserStrip`
 *     now: one row across the top, same five facts, same words, still server-derived and
 *     still never posted.
 *  3. THE DISABLED SUBMIT BUTTON WAS THE ONLY VALIDATION FEEDBACK. Five conditions gate
 *     it and none of them said so. `SubmitChecklist` lists every one, in the words the
 *     step itself uses, and separates "not done yet" from "actively wrong".
 *  4. NOTHING FILLED THE RAIL. Between them the checklist and `NextStepsCard` — what
 *     happens to the return after it is submitted, the question every branch asks a
 *     person because no screen answered it — give the rail a full column of content
 *     beside the steps rather than a short card and a stretch of white.
 *
 * The chrome is still the New indent screen's: same card padding, same uppercase section
 * headings, same `lg:grid-cols-3` split, and the commit buttons in the same sticky action
 * bar at the foot of the page (full width on a phone, right-aligned from `md` up) wearing
 * the same pastel tones off `shared/components/tones` — pink to back out, mint to save,
 * deep mint for the one commitment. A storekeeper who raises indents all day is not
 * relearning a second form.
 *
 * Every word on the screen is the returns module's own. Only the chrome is shared.
 *
 * FIX 2026-09-08: the APPROVAL FLOW panel is no longer drawn on this form. On a brand
 * new return it could only ever render "not started yet" with every stage Pending, so it
 * filled the middle of the screen with a forecast of a document that does not exist yet.
 * This is a DISPLAY-ONLY removal: the ladder itself, the doc-type catalogue and the
 * workflow engine are untouched, `ApprovalFlowPanel` still exists, and the signed flow is
 * still shown on the return once it has been submitted.
 *
 * The step badges are presentational — `canSave` / `canSubmit` below, and after them the
 * service's own guards, are what actually decide what may be pressed. Nothing in this
 * file is the security boundary and nothing in it derives document state.
 *
 * Photos are picked here even on a brand new return: `sys_attachments` is keyed by
 * document id, so the files are held in state and posted the moment the draft is
 * created. A photograph of the stock is mandatory to submit — the approver is being
 * asked to believe material is damaged or expired, and the picture is the evidence.
 */
/**
 * "Raised on its own" as a Select value. A sentinel rather than "" because "" is what a
 * Select shows its placeholder for, and the two states have to be told apart: nothing
 * chosen yet keeps the item picker empty, choosing this deliberately opens the whole
 * shelf. Never sent to the server — the body posts `indent_id: null` for it.
 */
const NO_INDENT = "NONE";

export default function ReturnFormPage() {
  const { id } = useParams<{ id: string }>();
  const returnId = id ? Number(id) : null;
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [reason, setReason] = useState("");
  const [reasonNote, setReasonNote] = useState("");
  /**
   * The indent this return answers. THREE states, not two (2026-09-07):
   *
   *   ""        nothing decided yet — the form's opening state
   *   NO_INDENT explicitly raised on its own, which stays a legal choice because not
   *             all material coming back off a shelf came in on an indent
   *   "<id>"    raised against that request
   *
   * The blank state used to mean "on its own", which is why the item picker offered the
   * whole shelf before anybody had chosen anything. Separating the two is what lets the
   * items stay empty until the question has actually been answered.
   *
   * Picking an indent changes WHO APPROVES the return: it then travels the approval flow
   * configured for that indent's raiser rank rather than the stock return's own chain.
   * The panel beside it shows exactly which people that is, resolved by the backend.
   *
   * It also changes WHEN they approve. Since 2026-09-07 that flow runs FIRST, before the
   * inventory desk decides where the material goes — picking an indent used to leave the
   * return sitting on that desk with the chosen chain two legs away, which read as the
   * choice having been ignored.
   */
  const [indentId, setIndentId] = useState("");
  // Which family of return this is. Recorded on the document rather than assumed, so the
  // register can say which it is without inferring it from the table the row came out of.
  const [kind, setKind] = useState<ReturnKind>("FIELD");
  // What the branch wants to happen next. No longer asked on the form (2026-09-07): the
  // branch answering it changed nothing about how the stock moves, and where the material
  // ends up was always the decision desk's call. The field stays on the document and a
  // saved draft still hydrates its own value, so nothing already recorded is rewritten —
  // a new return simply carries the RETURN default and the desk decides the rest.
  const [intent, setIntent] = useState<ReturnIntent>("RETURN");
  const [lines, setLines] = useState<ReturnLineWrite[]>([{ ...BLANK_LINE }]);
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);

  /** The indent actually named, or null for "on its own". Never the sentinel. */
  const pickedIndentId = indentId && indentId !== NO_INDENT ? Number(indentId) : null;
  /** Has the raiser answered the indent question at all? Gates the item picker. */
  const indentAnswered = indentId !== "";

  /**
   * Answering the indent question again throws the lines away. The shelf the picker is
   * built from is a different shelf now, so an item carried over from the previous
   * answer would either not be on the new indent at all or would keep a quantity that
   * was checked against a holding nobody re-read. Cheaper to retype two lines than to
   * submit one nobody meant.
   */
  const pickIndent = (value: string) => {
    if (value === indentId) return;
    setIndentId(value);
    setLines([{ ...BLANK_LINE }]);
  };

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
  //
  // Fetched only once the indent question has been answered, and scoped to that indent
  // when one was named: a return raised against an indent answers THAT request, so
  // offering the whole shelf let a line be filed under the approval chain of a request
  // that never asked for it. `indent_id` is in the key, so changing the indent refetches
  // rather than reusing the previous request's shelf.
  const { data: stockPage } = useQuery({
    queryKey: ["returns", "my-stock", pickedIndentId],
    queryFn: () =>
      returnsApi.myStock({ size: 500, ...(pickedIndentId ? { indent_id: pickedIndentId } : {}) }),
    enabled: indentAnswered,
  });

  // The raiser's own indents, past approval. 200 is well inside the shared page ceiling
  // and a picker cannot paginate; a storekeeper with more than 200 open requests does
  // not exist in this data.
  const { data: indentPage } = useQuery({
    queryKey: ["returns", "indent-options"],
    queryFn: () => returnsApi.indents({ size: 200 }),
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
    setKind(existing.kind ?? "FIELD");
    // A saved draft with no indent on it was a deliberate "on its own", not an
    // unanswered question — so it hydrates to the sentinel and its lines stay editable.
    setIndentId(existing.indent_id ? String(existing.indent_id) : NO_INDENT);
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
  const indents = indentPage?.items ?? [];
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
  // The dropdown shows only the label, so the sentence that says what the choice
  // commits to is served under the field instead of being lost with the buttons.
  const kindHint = KIND_OPTIONS.find((option) => option.value === kind)?.hint;
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

  /* --- what the rail and the step badges read ------------------------------------
   *
   * Derived from the SAME flags `canSave` / `canSubmit` are built from, deliberately —
   * a summary panel that recomputes the rules is how a screen ends up reporting
   * "all set" for a document the server then rejects.
   */
  const noteDone = !noteRequired || Boolean(reasonNote.trim());
  const step1Done = indentAnswered && Boolean(reason) && noteDone;
  const linesClean = validLines.length > 0 && !overCommitted && !hasDuplicate && !hasFraction;
  const totalQty = useMemo(
    () => validLines.reduce((running, line) => running + Number(line.quantity), 0),
    [validLines],
  );

  /**
   * The step to fill in next: the first that is neither finished nor unreachable. One
   * marker on the screen at a time — a form with three "you are here" badges has none.
   * A read-only return has no next step, and neither does a finished one.
   */
  const currentStep = readOnly
    ? 0
    : !step1Done
      ? 1
      : !linesClean
        ? 2
        : photoCount === 0
          ? 3
          : 0;

  const checklist: ChecklistItem[] = [
    {
      key: "indent",
      label: "Answer “Against indent”",
      done: indentAnswered,
      hint: "It decides who approves the return, and which items you can pick.",
    },
    {
      key: "reason",
      label: "Pick a reason",
      done: Boolean(reason),
      hint: "Why is this coming back?",
    },
    // Only asked for when it is actually required, so a form nobody has broken never
    // shows a row nobody has to act on.
    ...(noteRequired
      ? [{
          key: "note",
          label: "Add a description",
          done: noteDone,
          hint: "Required when the reason is Others.",
        }]
      : []),
    {
      key: "lines",
      label: "Add at least one item",
      done: validLines.length > 0,
      hint: indentAnswered
        ? "An item and a quantity, on one line each."
        : "Unlocks once the indent question is answered.",
    },
    // The three mistakes, each listed only while it is being made. A row that appears is
    // news; a permanent list of things that are fine is not.
    ...(overCommitted
      ? [{
          key: "over",
          label: "Bring every quantity within your shelf",
          done: false,
          blocked: true,
          hint: "A line asks for more of an item than you are holding.",
        }]
      : []),
    ...(hasDuplicate
      ? [{
          key: "duplicate",
          label: "Put each item on one line only",
          done: false,
          blocked: true,
          hint: "The same item is on two lines — change the quantity on one instead.",
        }]
      : []),
    ...(hasFraction
      ? [{
          key: "fraction",
          label: "Use whole units where the item comes in them",
          done: false,
          blocked: true,
          hint: "A line asks for part of a unit that cannot be split.",
        }]
      : []),
    {
      key: "photo",
      label: "Add a photo of the stock",
      done: photoCount > 0,
      hint: "The approver is being asked to believe this material is damaged or expired.",
    },
  ];

  const body = (): ReturnWrite => ({
    reason,
    reason_note: reasonNote.trim() || null,
    // null, not omitted: clearing the picker on an edit has to CLEAR the link, and the
    // backend rebuilds the whole marker payload from what it is sent.
    indent_id: pickedIndentId,
    // Sent rather than left to default, so the register never has to infer which family
    // a row belongs to.
    kind,
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
    // Cleared on the way IN, not only on success: a banner left over from the last
    // press reads as a fresh complaint about the field the raiser has just fixed.
    onMutate: () => setError(null),
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
    onMutate: () => setError(null),
    onSuccess: (saved) => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["returns"] });
      navigate(`/returns/${saved.id}`);
    },
    onError: fail,
  });

  const busy = save.isPending || submit.isPending;

  return (
    <>
      <PageHeader
        eyebrow="RETURN"
        title={returnId ? "Edit return" : "New return"}
        // A form is a screen you arrive AT, and the only way off this one was the Back
        // button pinned below the fold on a phone.
        back={{ to: "/returns", label: "Back to All returns" }}
      />

      {error && <ErrorBanner error={error} />}

      {raiser?.destination_note && !raiser.to_warehouse_id && (
        <ErrorBanner error={raiser.destination_note} />
      )}

      {/* Who is returning what, from where, to where. Across the top because it is the
        * frame the rest of the form sits inside, and one strip because five facts do not
        * need five text boxes. */}
      <RaiserStrip raiser={raiser} className="mb-5" />

      {/* A return that has left the raiser drops the rail entirely and lets the steps
        * claim the width. Neither of the rail's cards has anything to say about a
        * document that is already submitted — a checklist of what is outstanding is
        * nothing, and "After you submit" is advice about a press that has happened. An
        * empty third column would be exactly the hollow space this redraw removed. */}
      <div className={`grid grid-cols-1 gap-5 ${readOnly ? "" : "lg:grid-cols-3"}`}>
        <div className={`space-y-5 ${readOnly ? "" : "lg:col-span-2"}`}>
          <FormSection
            step={1}
            title="Details"
            hint="What is coming back, and why. The indent you name decides who signs it."
            done={step1Done}
            current={currentStep === 1}
            required
          >
            {/* Two columns from `sm`, and the two fields whose hints run long take the
              * full width — a 340px box under a two-line hint reads as a cramped
              * afterthought beside a short one. */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {/* Picked FIRST, above the reason: it decides who approves the return and
                * which items step 2 can offer, so it is the most consequential thing on
                * the form. The flow panel under this card updates as soon as it
                * changes.
                *
                * The return ladder now runs first (see returns/enums.py
                * `PHASES_APPROVAL_FIRST`), and a picked indent limits it to approvers
                * who existed on that indent's approval path. */}
              <div className="sm:col-span-2">
                <Field
                  label="Against indent (optional)"
                  hint="The return uses the Indent Return approval flow, limited to approvers from this indent's original approval path."
                >
                  <Select
                    value={indentId}
                    onChange={pickIndent}
                    options={[
                      { value: NO_INDENT, label: "Not against an indent" },
                      ...indents.map((row) => ({
                        value: String(row.id),
                        label: `${row.indent_no} · ${row.total_items} item${
                          row.total_items === 1 ? "" : "s"
                        }${row.indent_date ? ` · ${row.indent_date}` : ""}`,
                      })),
                    ]}
                    placeholder="Pick the indent this is coming back from"
                    isDisabled={readOnly}
                    ariaLabel="Indent this return is raised against"
                  />
                </Field>
              </div>

              <Field label="Reason" required>
                <Select
                  value={reason}
                  onChange={setReason}
                  options={reasons.map((row) => ({ value: row.value, label: row.label }))}
                  placeholder="Why is this coming back?"
                  isDisabled={readOnly}
                  ariaLabel="Reason for the return"
                />
              </Field>

              {/* Which family of return this is — a plain dropdown, like Reason beside
                * it, so the step reads as one set of fields rather than a stack of
                * cards. It does NOT skip the decision desk — where the material ends up
                * is still that desk's call — it records what the branch believes it is
                * sending back. The hint under each option lives on `KIND_OPTIONS`; the
                * selected one is shown beneath the field so the sentence is not lost. */}
              <Field label="What kind of return is this?" hint={kindHint}>
                <Select
                  // An empty value is HeroUI deselecting: a single Select toggles its
                  // own selected item off when it is clicked again, and the default
                  // reads "Return" — so a raiser clicking "Return" to confirm the
                  // answer they could already see CLEARED it, and the submit failed
                  // 422 on a field the screen still looked like it had answered.
                  // There is no "no kind" on this document; ignore the clear.
                  value={kind}
                  onChange={(value) => { if (value) setKind(value as ReturnKind); }}
                  options={KIND_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  isDisabled={readOnly}
                  ariaLabel="Kind of return"
                />
              </Field>

              <div className="sm:col-span-2">
                <Field
                  label={noteRequired ? "Description" : "Description (optional)"}
                  hint={noteRequired ? "Required when the reason is Others" : undefined}
                  required={noteRequired}
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
              </div>
            </div>
          </FormSection>

          <FormSection
            step={2}
            title="Line items"
            hint="Each item once, with the quantity coming back off your shelf."
            done={linesClean}
            current={currentStep === 2}
            locked={!indentAnswered}
            required
            aside={
              validLines.length > 0
                ? `${validLines.length} item${validLines.length === 1 ? "" : "s"}`
                : undefined
            }
          >
            <ReturnLinesEditor
              lines={lines}
              onChange={setLines}
              stock={stock}
              disabled={readOnly || !indentAnswered}
              lockedNote={
                indentAnswered
                  ? null
                  : "Answer “Against indent” in step 1 first — the items you can "
                    + "return are the ones that request asked for."
              }
            />
            {indentAnswered && stock.length === 0 && (
              <p className="text-sm text-muted">
                {pickedIndentId
                  ? "Nothing that indent asked for is on your shelf to return."
                  : "There is no stock on your point to return."}
              </p>
            )}
          </FormSection>

          <FormSection
            step={3}
            title="Photos & documents"
            hint="A photo of the material is the evidence the approver decides on. The inward bill helps."
            done={photoCount > 0}
            current={currentStep === 3}
            required={!readOnly}
            aside={
              photoCount > 0 ? `${photoCount} photo${photoCount === 1 ? "" : "s"}` : undefined
            }
          >
            {/* `embedded`: the step above supplies the card and the heading, so the panel
              * draws its contents bare rather than a card inside a card. Same component,
              * same rules — the detail page still gets the standalone version. */}
            <AttachmentsPanel
              returnId={returnId}
              editable={!readOnly}
              staged={staged}
              onStagedChange={setStaged}
              photoRequired={!readOnly}
              embedded
            />
          </FormSection>
        </div>

        {/* The standing rail. Sticky from `lg`, so what is still outstanding stays on
          * screen while the reader works down three steps of fields — a checklist you
          * have to scroll back up to read is a checklist nobody reads. `top-24` and
          * `self-start` are the offset and the anchor procurement's detail rail already
          * uses under the same `sticky top-0` app header — one number, not a third
          * guess at how tall the chrome is. */}
        {!readOnly && (
          <div className="space-y-5 lg:sticky lg:top-24 lg:self-start">
            <SubmitChecklist
              items={checklist}
              summary={{ lines: validLines.length, quantity: totalQty }}
            />
            <NextStepsCard />
          </div>
        )}
      </div>

      {/* The indent form's action bar: pinned to the bottom of a phone screen where the
        * thumb is, static and right-aligned from `md` up. The tones are the shared
        * palette's — pink for backing out, mint for the save, the deeper mint for the one
        * commitment on the screen — so the same action wears the same colour here as it
        * does on an indent. Purely visual: `canSave` / `canSubmit` and the server's own
        * guards still decide what may be pressed. */}
      <div className="fixed inset-x-0 bottom-0 z-10 flex gap-3 border-t border-line bg-content1 p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] md:static md:mt-6 md:justify-end md:border-0 md:bg-transparent md:p-0">
        <Button
          variant="soft"
          className={`flex-1 md:flex-none ${TONE_PINK}`}
          onClick={() => navigate("/returns")}
        >
          Back
        </Button>
        {!readOnly && (
          <>
            <Button
              variant="soft"
              className={`flex-1 md:flex-none ${TONE_MINT}`}
              disabled={!canSave || busy}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : "Save draft"}
            </Button>
            <Button
              className={`flex-1 md:flex-none ${TONE_DEEP_MINT}`}
              disabled={!canSubmit || busy}
              onClick={() => submit.mutate()}
            >
              {submit.isPending ? "Submitting…" : "Submit for approval"}
            </Button>
          </>
        )}
      </div>
    </>
  );
}
