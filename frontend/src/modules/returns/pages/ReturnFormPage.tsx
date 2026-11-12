import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, FileText, Layers, PackageCheck } from "lucide-react";
import {
  Button, DocumentNumberCard, ErrorBanner, Field, Input, PageHeader, Select, StatusPill,
  TONE_DEEP_MINT, TONE_MINT, TONE_PINK,
} from "@/shared/components";
import { returnsApi } from "../api";
import { AttachmentsPanel } from "../components/AttachmentsPanel";
import { FormSection } from "../components/FormSection";
import { NextStepsCard } from "../components/NextStepsCard";
import { RaiserStrip } from "../components/RaiserStrip";
import { ReasonRowsEditor } from "../components/ReasonRowsEditor";
import {
  newReasonRow, reasonProblems, reasonRowsFrom, reasonRowsPayload,
  withSingleRowFollowingTotal, type ReasonRow,
} from "../reasonRows";
import { SubmitChecklist, type ChecklistItem } from "../components/SubmitChecklist";
import {
  BLANK_LINE, ReturnLinesEditor, holdingFor, isWholeUnit,
} from "../components/ReturnLinesEditor";
import {
  PHOTO_CATEGORY, type IndentOption, type ReturnIntent, type ReturnKind,
  type ReturnLineWrite, type ReturnWrite, type StagedAttachment,
} from "../types";
import { comboFrom, comboPayload } from "@/shared/combination";
import { useDocNumberScope } from "@/shared/useDocNumberScope";

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
 *
 * CHANGES 2026-09-12, all in step 1 and all for one reason — the gate was asking for
 * things it could not honour:
 *
 *  - THE INDENT PICKER ONLY OFFERS INDENTS WITH SOMETHING LEFT TO RETURN. It listed
 *    every indent past approval, so an indent whose only item had already come back was
 *    still a choice — and taking it opened step 2 on an empty picker under "Nothing that
 *    indent asked for is on your shelf to return". The raiser answered the one question
 *    that gates the whole form and was told, only afterwards, that the answer was
 *    worthless. The filter is the SERVER's (`returns.service.returnable_indents`), using
 *    `my_stock`'s own shelf test, so the list and the picker cannot disagree; the option
 *    label now counts what is still returnable rather than the indent's original lines.
 *  - "(OPTIONAL)" IS OFF THE LABEL, and the field is marked required. The question has
 *    to be ANSWERED — "Not against an indent" is one of the two answers, not the absence
 *    of one — and step 2 stays locked until it is. The label said the opposite of what
 *    the form enforces. The `NO_INDENT` answer itself is untouched: material coming off
 *    a shelf did not all arrive on an indent.
 *  - WHAT WAS PICKED IS DRAWN OUT under the field — number, status, date, project, and
 *    how much of it is still on the shelf — off the option row already fetched. A
 *    dropdown closes over its own answer, and one indent number looks like every other.
 *    The three states that are not a live pick (a draft against an emptied indent, a
 *    raiser with nothing returnable anywhere, and a deliberate "on its own") each say so
 *    in their own sentence instead of leaving the reader to infer it from an empty
 *    step 2.
 *  - "WHAT KIND OF RETURN IS THIS?" IS NO LONGER ASKED. See `kind` below: it is still on
 *    the document and still posted, it is simply not the branch's decision to make.
 *    Reason and Description take the row it vacated rather than leaving a column of
 *    white beside a lone dropdown.
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

  const [reasonRows, setReasonRows] = useState<ReasonRow[]>(() => [newReasonRow()]);
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
  /**
   * Which family of return this is. NO LONGER ASKED ON THE FORM (2026-09-12), for the
   * same reason `intent` below stopped being asked: the branch answering it changed
   * nothing about how the stock moves. Where the material actually ends up is the
   * decision desk's call — `TO_VENDOR` is the disposition that sends it back to the
   * supplier — so a storekeeper was being made to classify a document on a distinction
   * that the next desk overrides anyway, and getting it wrong looked like a mistake.
   *
   * The field stays ON THE DOCUMENT and is still posted: the register shows both
   * families and a row has to say which it is. A saved draft still hydrates its own
   * value, so nothing already recorded is rewritten — a new return simply carries the
   * FIELD default, which is what a branch shelf sending material back into our own
   * network is. `KIND_OPTIONS` is untouched in `constants.ts` for the desk screens that
   * still label it.
   */
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
    setReasonRows(reasonRowsFrom(
      existing.reasons, existing.reason, existing.reason_note,
      existing.items.reduce((sum, line) => sum + Number(line.quantity ?? 0), 0)));
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
            ...comboFrom(line),
          }))
        : [{ ...BLANK_LINE }],
    );
  }, [existing]);

  const stock = stockPage?.items ?? [];
  const indents = indentPage?.items ?? [];
  // Whose paper the return is on (2026-11-12): COPIED from the indent it answers when
  // that indent carries an organisation, else selected here — `carry_or_select`.
  const scopeIndent = indents.find((row) => row.id === pickedIndentId) ?? null;
  const numberScope = useDocNumberScope({
    editing: returnId !== null,
    saved: existing,
    carried: scopeIndent?.organization_id ? scopeIndent : null,
    carriedLabel: scopeIndent?.indent_no,
  });
  const readOnly = existing ? !existing.can_edit : false;

  /**
   * The row behind the chosen id, so the form can SHOW what was picked rather than
   * leaving a line of code in a closed dropdown as the only evidence. Read out of the
   * list already fetched — no second request, and nothing here is derived state the
   * server does not already hold.
   *
   * It can legitimately be undefined on an EDIT: a draft saved against an indent whose
   * last item has since left the shelf still carries that indent id, but the picker no
   * longer lists it. The strip below handles that case explicitly rather than rendering
   * a row of blanks.
   */
  const pickedIndent: IndentOption | undefined = pickedIndentId
    ? indents.find((row) => row.id === pickedIndentId)
    : undefined;
  /**
   * Nothing left anywhere on the shelf that any of this person's requests asked for.
   * Said out loud under the field: the list is now filtered (`returnable_indents`), so
   * an empty dropdown is a real answer about the shelf and not a screen that failed to
   * load. Only after the fetch has actually landed — `indentPage` undefined is still
   * in flight, and "you have nothing to return" flashed during a load is alarming and
   * also untrue a moment later.
   */
  const noReturnableIndents = Boolean(indentPage) && indents.length === 0;

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

  // What the reasons have to add up to, read from the same lines `canSave` reads so the
  // two cannot disagree.
  const totalQty = useMemo(
    () => validLines.reduce((running, line) => running + Number(line.quantity), 0),
    [validLines],
  );
  // One row is "all of it" and follows the lines; several are the person's own split.
  const rows = useMemo(
    () => withSingleRowFollowingTotal(reasonRows, totalQty), [reasonRows, totalQty]);
  const reasonIssues = useMemo(() => reasonProblems(rows, totalQty), [rows, totalQty]);
  const reasonDone = rows.length > 0 && reasonIssues.length === 0;
  const canSave =
    reasonDone &&
    validLines.length > 0 &&
    !overCommitted &&
    !hasDuplicate &&
    !hasFraction;
  // A draft is a scratchpad and saves without the photo; submitting is what needs it,
  // and the backend refuses a submit without one either way.
  const canSubmit = canSave && photoCount > 0;

  /* --- what the rail and the step badges read ------------------------------------
   *
   * Derived from the SAME flags `canSave` / `canSubmit` are built from, deliberately —
   * a summary panel that recomputes the rules is how a screen ends up reporting
   * "all set" for a document the server then rejects.
   */
  const step1Done = indentAnswered && reasonDone;
  const linesClean = validLines.length > 0 && !overCommitted && !hasDuplicate && !hasFraction;

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
      done: reasonDone,
      hint: reasonIssues[0] ?? "Why is this coming back? Split it over several reasons if needed.",
    },
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
    ...numberScope.payload(),
    reasons: reasonRowsPayload(rows),
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
      ...comboPayload(line),
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

      {!numberScope.older && (
        <div className="mb-5">
          <DocumentNumberCard
            docType="ret" value={numberScope.value} exclusive
            ready={numberScope.ready} locks={numberScope.locks} source={numberScope.source}
            showInvalid={numberScope.touched}
            savedNumber={returnId !== null ? existing?.return_no ?? null : null}
            onChange={numberScope.onChange}
          />
        </div>
      )}

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
            {/* Two columns from `sm`. The gate spans both — it decides who signs the
              * return and which items step 2 can offer, so it is not a half-width field
              * beside something smaller — and Reason and Description share the row under
              * it. They used to sit either side of "What kind of return is this?", which
              * is gone (see `kind` above), and leaving Reason alone in a half-width cell
              * would have left a column of white beside it. */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {/* Picked FIRST, above the reason: it decides who approves the return and
                * which items step 2 can offer, so it is the most consequential thing on
                * the form. It is marked REQUIRED because the question must be ANSWERED —
                * "Not against an indent" is one of the two answers, not the absence of
                * one, and until one of them is chosen step 2 stays locked. The old
                * "(optional)" said the opposite of what the form enforces.
                *
                * The list only carries indents with something still on this shelf
                * (`returnable_indents`), so picking one can no longer land on an empty
                * item picker.
                *
                * The return ladder now runs first (see returns/enums.py
                * `PHASES_APPROVAL_FIRST`), and a picked indent limits it to approvers
                * who existed on that indent's approval path. */}
              <div className="sm:col-span-2">
                <Field
                  label="Against indent"
                  required
                  hint="The return uses the Indent Return approval flow, limited to approvers from this indent's original approval path."
                >
                  <Select
                    value={indentId}
                    onChange={pickIndent}
                    options={[
                      { value: NO_INDENT, label: "Not against an indent" },
                      ...indents.map((row) => ({
                        value: String(row.id),
                        // The count is what is STILL RETURNABLE, not the indent's
                        // original line count: an option reading "1 item" on a request
                        // holding nothing is what made the empty picker in step 2 read
                        // as a defect in the screen.
                        label: `${row.indent_no} · ${row.returnable_items} item${
                          row.returnable_items === 1 ? "" : "s"
                        } to return${row.indent_date ? ` · ${row.indent_date}` : ""}`,
                      })),
                    ]}
                    placeholder="Pick the indent this is coming back from"
                    isDisabled={readOnly}
                    ariaLabel="Indent this return is raised against"
                  />
                </Field>

                {/* WHAT WAS PICKED, drawn out. A dropdown closes over its own answer, and
                  * an indent number is fifteen characters that look like every other
                  * indent number — so the request about to be filed against is confirmed
                  * here in the terms a storekeeper would recognise it by. Every fact
                  * comes off the option row already fetched: nothing extra is requested
                  * and nothing is recomputed in the browser. */}
                {pickedIndent && (
                  <div className="mt-3 rounded-xl border border-line bg-content2/50 p-3">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <FileText aria-hidden="true" className="h-4 w-4 shrink-0 text-brand" />
                      <span className="text-sm font-bold text-ink">
                        {pickedIndent.indent_no}
                      </span>
                      <StatusPill status={pickedIndent.status} />
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                      {pickedIndent.indent_date && (
                        <span className="inline-flex items-center gap-1.5">
                          <CalendarDays aria-hidden="true" className="h-3.5 w-3.5" />
                          Raised {pickedIndent.indent_date}
                        </span>
                      )}
                      {pickedIndent.project_name && (
                        <span className="inline-flex min-w-0 items-center gap-1.5">
                          <Layers aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate" title={pickedIndent.project_name}>
                            {pickedIndent.project_name}
                          </span>
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1.5 font-semibold text-ok">
                        <PackageCheck aria-hidden="true" className="h-3.5 w-3.5" />
                        {pickedIndent.returnable_items} of {pickedIndent.total_items} item
                        {pickedIndent.total_items === 1 ? "" : "s"} still on your shelf
                      </span>
                    </div>
                  </div>
                )}

                {/* A draft raised against an indent that has since emptied. The link is
                  * still on the document and is still posted — it is not silently
                  * dropped — but the picker cannot show a row it no longer lists, so the
                  * form says which one it is and why it is not in the list. */}
                {pickedIndentId && !pickedIndent && indentPage && (
                  <p className="mt-3 rounded-xl border border-line bg-content2/50 px-3 py-2 text-xs text-muted">
                    This return is filed against indent #{pickedIndentId}, which no longer
                    has anything on your shelf to return. The link is kept — pick another
                    indent, or “Not against an indent”, to change it.
                  </p>
                )}

                {/* Nothing of this person's requests is left on the shelf at all. */}
                {noReturnableIndents && !pickedIndentId && (
                  <p className="mt-3 rounded-xl border border-line bg-content2/50 px-3 py-2 text-xs text-muted">
                    None of your indents has anything left on your shelf to return, so
                    only “Not against an indent” is available. That still raises a return
                    — it travels the stock return’s own approval chain instead.
                  </p>
                )}

                {/* Chosen deliberately, so the consequence is stated here rather than
                  * discovered two steps later. */}
                {indentId === NO_INDENT && (
                  <p className="mt-3 rounded-xl border border-line bg-content2/50 px-3 py-2 text-xs text-muted">
                    Step 2 offers everything on your shelf, and the return travels the
                    stock return’s own approval chain.
                  </p>
                )}
              </div>

              <Field
                label="Reasons"
                required
                hint="One row per reason, with how many. Together they cover every unit."
              >
                <ReasonRowsEditor
                  rows={rows}
                  reasons={reasons.map((row) => ({ value: row.value, label: row.label }))}
                  total={totalQty}
                  readOnly={readOnly}
                  onChange={setReasonRows}
                />
                {reasonIssues.length > 0 && rows.some((row) => row.reason) && (
                  <p className="mt-2 text-xs text-warn">{reasonIssues[0]}</p>
                )}
              </Field>

              <Field label="Description (optional)" hint="Anything the approver should know">
                <Input
                  value={reasonNote}
                  onChange={(event) => setReasonNote(event.target.value)}
                  disabled={readOnly}
                  placeholder="In your own words"
                  aria-label="Description"
                />
              </Field>
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
            {/* The picker is now filtered to indents that still have something on this
              * shelf, so the first branch is no longer the routine outcome it was — it
              * means the shelf moved since the list was fetched (somebody else issued
              * the last of it, or a draft already claimed it). Kept, and worded as the
              * stale answer it is, because a list cached for the length of a form fill
              * can always be overtaken by the floor. */}
            {indentAnswered && stock.length === 0 && (
              <p className="text-sm text-muted">
                {pickedIndentId
                  ? "Nothing that indent asked for is on your shelf any more — it has "
                    + "moved since this list was loaded. Reload, or pick another indent."
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
            {/* The route step 1 actually chose, so the rail stops promising the
              * indent's approvers to a return that named no indent. */}
            <NextStepsCard
              route={
                pickedIndentId ? "indent" : indentId === NO_INDENT ? "own" : "unanswered"
              }
            />
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
