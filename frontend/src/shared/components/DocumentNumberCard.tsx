import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, Hash, Lock } from "lucide-react";
import {
  docNumberApi, numberWillChange, openingValues, readLastProject, rememberProject,
  type DocNumberField, type DocNumberLocks, type DocNumberOption, type DocNumberPart,
  type DocNumberValue,
} from "@/shared/documentNumber";
import { ErrorBanner } from "./Feedback";
import { Select } from "./ui";

const label = (row: DocNumberOption) => (row.code ? `${row.code} — ${row.name}` : row.name);

/** A list that always holds the current selection, even one no longer offered. */
function withSelected(rows: DocNumberOption[], id: number | "", name?: string) {
  const options = rows.map((row) => ({ value: String(row.id), label: label(row) }));
  if (id !== "" && !rows.some((row) => row.id === id)) {
    options.unshift({ value: String(id), label: name || "Selected" });
  }
  return options;
}

function FieldShell({ title, required, locked, active, hint, children, onActive, onIdle }: {
  title: string; required?: boolean; locked?: boolean; active: boolean; hint?: ReactNode;
  children: ReactNode; onActive: () => void; onIdle: () => void;
}) {
  return (
    <div
      className={`min-w-0 rounded-xl p-1.5 transition-colors ${active ? "bg-brand-050/70" : ""}`}
      onMouseEnter={onActive} onMouseLeave={onIdle} onFocusCapture={onActive} onBlurCapture={onIdle}
    >
      <div className="mb-1.5 flex items-center gap-1 text-sm font-medium text-body">
        {locked && <Lock aria-hidden className="h-3.5 w-3.5 text-muted" />}
        {title}
        {required && (
          <>
            <span aria-hidden="true" className="text-danger">*</span>
            <span className="sr-only"> (required)</span>
          </>
        )}
      </div>
      {children}
      {hint && <div className="mt-1 min-h-4 text-xs text-muted">{hint}</div>}
    </div>
  );
}

const CAPTIONS: Record<string, string> = {
  company: "Organisation", project: "Project", fy: "Fin. year", prefix: "Document",
  num: "On save", yyyy: "Year", yy: "Year", mm: "Month", mon: "Month", dd: "Day",
};

function NumberPart({ part, highlighted, scopeSource }: {
  part: DocNumberPart; highlighted: boolean; scopeSource: "project" | "department" | null;
}) {
  const still = useReducedMotion();
  if (part.kind === "literal") {
    return <span aria-hidden className="self-start pt-1.5 font-mono text-lg font-semibold text-muted/60">{part.text}</span>;
  }
  const caption = part.kind === "project" && scopeSource === "department"
    ? "Department" : CAPTIONS[part.kind] ?? "On save";
  const missing = part.text === null;
  const pending = part.kind === "num" || part.kind === "other";
  return (
    <span className="flex flex-col items-center gap-1">
      <span
        className={`inline-flex min-h-9 items-center rounded-lg px-2 font-mono text-[15px] font-bold leading-none transition-shadow sm:text-base ${
          missing
            ? "border border-dashed border-warn/60 bg-warn-bg font-sans text-xs font-semibold text-warn"
            : pending
              ? "border border-dashed border-line bg-content1/60 tracking-wider text-muted"
              : "bg-content1 text-ink shadow-sm ring-1 ring-line"
        } ${highlighted ? "ring-2 ring-brand" : ""}`}
      >
        <motion.span
          key={part.text ?? "missing"}
          initial={still ? false : { opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18 }}
        >
          {part.text ?? "Select"}
        </motion.span>
      </span>
      <span className={`text-[10px] font-semibold uppercase tracking-wide ${missing ? "text-warn" : "text-muted"}`}>
        {caption}
      </span>
    </span>
  );
}

/**
 * The top of every document form: the fields the document series asks for, in the order
 * its pattern prints them, beside the number they make.
 *
 * Fields, options and every part of the number are served, so a screen only says which
 * document it is and what came from the document before. Hover or focus a field and the
 * part of the number it fills lights up.
 *
 * `ready`: the form has finished loading what it copies, so empty fields may take their
 * defaults. Never set on an edit, where an empty field is the document's own answer.
 */
export function DocumentNumberCard({
  docType, value, onChange, ready = false, locks = {}, exclusive = false, defaultProject = true,
  showInvalid = false, savedNumber, source,
}: {
  docType: string;
  value: DocNumberValue;
  onChange: (patch: Partial<DocNumberValue>) => void;
  ready?: boolean;
  locks?: DocNumberLocks;
  /** Project OR department, never both: picking one clears the other. */
  exclusive?: boolean;
  /** False where the document before it may supply the project once the save runs. */
  defaultProject?: boolean;
  showInvalid?: boolean;
  /** The number a saved draft already holds. */
  savedNumber?: string | null;
  /** The document these values were copied from, named under each locked field. */
  source?: { label: string; to?: string } | null;
}) {
  const { data: card, error, isLoading } = useQuery({
    queryKey: ["document-number-card", docType],
    queryFn: () => docNumberApi.card(docType),
  });
  const { data: preview } = useQuery({
    queryKey: ["document-number-preview", docType, value.organizationId, value.projectId,
               value.orgDepartmentId, value.projectName, value.fiscalYear],
    queryFn: () => docNumberApi.preview(docType, value),
    placeholderData: keepPreviousData,
    enabled: Boolean(card),
  });

  const [guessed, setGuessed] = useState<DocNumberField[]>([]);
  const [activeField, setActiveField] = useState<DocNumberField | null>(null);

  // Once, when the form says it is ready and the options are here. Later edits are the
  // person's own: emptying a field must not fill it straight back in.
  const opened = useRef(false);
  useEffect(() => {
    if (!card || !ready || opened.current) return;
    opened.current = true;
    const { patch, guessed: guesses } = openingValues(card, value, {
      lastProject: readLastProject(docType), defaultProject, locks,
    });
    setGuessed(guesses);
    if (Object.keys(patch).length) onChange(patch);
  }, [card, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const clearGuess = (field: DocNumberField) =>
    setGuessed((all) => all.filter((f) => f !== field));

  const organisations = useMemo(
    () => withSelected(card?.organisations ?? [], value.organizationId, value.organizationName),
    [card, value.organizationId, value.organizationName]);
  const projects = useMemo(
    () => withSelected(card?.projects ?? [], value.projectId, value.projectName),
    [card, value.projectId, value.projectName]);
  const departments = useMemo(
    () => withSelected(card?.departments ?? [], value.orgDepartmentId, value.departmentName),
    [card, value.orgDepartmentId, value.departmentName]);
  const years = useMemo(() => {
    const list = card?.fiscal_years ?? [];
    const all = value.fiscalYear && !list.includes(value.fiscalYear) ? [value.fiscalYear, ...list] : list;
    return all.map((year) => ({
      value: year,
      label: year === card?.current_fiscal_year ? `${year} (this year)` : year,
    }));
  }, [card, value.fiscalYear]);

  const carried = value.projectId === "" && Boolean(value.projectName);
  const neither = value.projectId === "" && value.orgDepartmentId === "" && !carried;
  const lockedAll = Boolean(locks.all);
  const orgLocked = lockedAll || Boolean(locks.organisation);
  const projectLocked = lockedAll || Boolean(locks.project);
  const departmentLocked = lockedAll || Boolean(locks.department);
  const reasonFor = (field: DocNumberField) => locks.reasons?.[field] ?? fromSource;

  const shell = (field: DocNumberField) => ({
    active: activeField === field,
    onActive: () => setActiveField(field),
    onIdle: () => setActiveField((f) => (f === field ? null : f)),
  });
  const guess = <span className="font-semibold text-warn">Default, please check</span>;
  const fromSource = source ? (
    <>Copied from {source.to
      ? <Link to={source.to} className="font-semibold text-brand hover:underline">{source.label}</Link>
      : <span className="font-semibold text-body">{source.label}</span>}</>
  ) : "Copied from the document before";
  const notPrinted = "Kept on the document. This series does not print it.";

  const fieldViews: Record<DocNumberField, (inNumber: boolean) => ReactNode> = {
    organisation: (inNumber) => (
      <FieldShell key="organisation" title="Organisation" required locked={orgLocked}
                  {...shell("organisation")}
                  hint={guessed.includes("organisation") ? guess
                    : lockedAll ? "Fixed once submitted."
                      : locks.organisation ? reasonFor("organisation")
                        : inNumber ? "Goes into the number." : notPrinted}>
        <Select
          ariaLabel="Organisation" value={value.organizationId === "" ? "" : String(value.organizationId)}
          placeholder="Select organisation" options={organisations} isDisabled={orgLocked}
          isInvalid={showInvalid && value.organizationId === ""}
          onChange={(v) => {
            clearGuess("organisation");
            onChange({ organizationId: v ? Number(v) : "", organizationName: "" });
          }}
        />
      </FieldShell>
    ),
    project: (inNumber) => (
      <FieldShell key="project" title="Project" required={neither && !projectLocked} locked={projectLocked}
                  {...shell("project")}
                  hint={guessed.includes("project") ? guess
                    : lockedAll ? "Fixed once submitted."
                      : locks.project ? reasonFor("project")
                        : !inNumber ? notPrinted
                          : value.orgDepartmentId !== "" && value.projectId === ""
                            ? "Not set. The department prints instead."
                            : "Prints first, ahead of the department."}>
        <Select
          ariaLabel="Project" value={value.projectId === "" ? (carried ? "carried" : "") : String(value.projectId)}
          placeholder={projectLocked ? "Not chosen here" : "Select project"}
          options={carried ? [{ value: "carried", label: value.projectName as string }, ...projects] : projects}
          isDisabled={projectLocked} isInvalid={showInvalid && neither}
          onChange={(v) => {
            clearGuess("project");
            const id = v && v !== "carried" ? Number(v) : "";
            if (id !== "") rememberProject(docType, id);
            onChange({
              projectId: id, projectName: "",
              ...(exclusive && id !== "" ? { orgDepartmentId: "", departmentName: "" } : {}),
            });
          }}
        />
      </FieldShell>
    ),
    department: (inNumber) => (
      <FieldShell key="department" title="Department" required={neither && !departmentLocked}
                  locked={departmentLocked}
                  {...shell("department")}
                  hint={lockedAll ? "Fixed once submitted."
                    : locks.department ? reasonFor("department")
                    : !inNumber ? notPrinted
                      : value.projectId !== "" || carried
                        ? exclusive ? "Picking one clears the project." : "Kept on the document. The project prints."
                        : value.orgDepartmentId !== "" ? "Prints in the number." : "Prints when there is no project."}>
        <Select
          ariaLabel="Department" value={value.orgDepartmentId === "" ? "" : String(value.orgDepartmentId)}
          placeholder={departmentLocked ? "Not chosen here" : "Select department"}
          options={departments} isDisabled={departmentLocked}
          isInvalid={showInvalid && neither}
          onChange={(v) => {
            const id = v ? Number(v) : "";
            if (id !== "" && exclusive) clearGuess("project");
            onChange({
              orgDepartmentId: id, departmentName: "",
              ...(exclusive && id !== "" ? { projectId: "", projectName: "" } : {}),
            });
          }}
        />
      </FieldShell>
    ),
    fiscal_year: () => (
      <FieldShell key="fiscal_year" title="Financial year" required locked={lockedAll}
                  {...shell("fiscal_year")}
                  hint={lockedAll ? "Fixed once submitted."
                    : value.fiscalYear === card?.current_fiscal_year || !value.fiscalYear
                      ? "Set from today's date. You can change it."
                      : "An earlier year, picked by hand."}>
        <Select
          ariaLabel="Financial year" value={value.fiscalYear} options={years}
          placeholder="Select year" isDisabled={lockedAll}
          onChange={(v) => { if (v) onChange({ fiscalYear: String(v) }); }}
        />
      </FieldShell>
    ),
  };

  const willChange = !lockedAll && numberWillChange(savedNumber, preview?.number ?? null);
  const holding = savedNumber?.startsWith("DRAFT-");

  return (
    <section aria-label="Document number" className="overflow-hidden rounded-2xl border border-line bg-content1 shadow-sm">
      <div aria-hidden className="h-1 bg-gradient-to-r from-signal via-brand to-violet-700" />
      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(340px,0.8fr)]">
        <div className="min-w-0 p-3.5 sm:p-4">
          {error ? <ErrorBanner error={error} /> : isLoading ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {[0, 1, 2, 3].map((i) => <div key={i} className="h-16 animate-pulse rounded-xl bg-surface-2" />)}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-x-2 gap-y-1 sm:grid-cols-2">
              {card?.fields.map((field) => fieldViews[field.key](field.in_number))}
            </div>
          )}
        </div>

        {/* Above the fields on a phone, so the number is what is seen first. */}
        <div className="order-first flex min-w-0 flex-col justify-center border-b border-line bg-gradient-to-br from-brand-050/80 to-surface-2/60 p-4 lg:order-none lg:border-b-0 lg:border-l sm:p-5">
          <div className="mb-3 flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand text-white"><Hash aria-hidden className="h-4 w-4" /></span>
            <h2 className="text-xs font-bold uppercase tracking-widest text-body">
              {savedNumber && !holding && !willChange ? "Document number" : "This document will be numbered"}
            </h2>
          </div>

          {savedNumber && !holding && !willChange ? (
            <p className="font-mono text-lg font-bold text-ink [overflow-wrap:anywhere]">{savedNumber}</p>
          ) : (
            <div className="flex flex-wrap items-start gap-x-1 gap-y-2" aria-live="polite">
              {preview?.parts.map((part, index) => (
                <NumberPart key={`${part.kind}-${index}`} part={part} scopeSource={preview.scope_source}
                            highlighted={part.field !== null && part.field === activeField} />
              ))}
            </div>
          )}

          {willChange ? (
            <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-warn-bg px-2.5 py-2 text-xs font-medium text-warn">
              <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>Saving gives this draft a new number. <span className="font-mono">{savedNumber}</span> is skipped and kept in its history.</span>
            </p>
          ) : (
            <p className="mt-3 text-xs text-muted">
              {holding ? "This draft has no number yet. It takes one when you save."
                : savedNumber ? "It keeps this number while the selection stays the same."
                  : preview?.missing.length
                    ? "Complete the selection to finish the number."
                    : "The running number is given when you save."}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
