import { type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "@/shared/api/client";
import { SHORT_CODE_PATHS } from "../tabs/constants";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Switch,
} from "@heroui/react";
import { Plus, Search } from "lucide-react";
import {
  Button, Can, Field, Input, ResponsiveList, Select, type Column,
} from "@/shared/components";
import { BulkBar } from "./BulkBar";
import { alerts } from "@/modules/alerts";
import type { BulkApi, MasterUsage } from "../api";

export type FieldType =
  "text" | "number" | "date" | "select" | "switch" | "multiselect" | "custom";
export interface Option { value: string | number; label: string }

export interface FormField {
  key: string;
  label: string;
  type?: FieldType;
  options?: Option[];
  required?: boolean;
  placeholder?: string;
  /** Shown under the field. For rules the label cannot carry, e.g. what an empty
   *  multiselect means downstream. */
  hint?: string;
  maxLength?: number;
  /** Checked against the trimmed value. Pair it with `patternMessage`, or the user
   *  is told a regular expression rather than what to type. */
  pattern?: RegExp;
  patternMessage?: string;
  min?: number;
  max?: number;
  /** Renders at half width, sharing a row with the next field also marked `half` —
   *  a from/to pair reads as one line rather than two. Stacks below `sm`. */
  half?: boolean;
  /** Date fields only: the bounds the picker itself should offer, read from the rest
   *  of the form. Keeps the calendar from proposing a day `validate` would reject. */
  range?: (all: Values) => { min?: string; max?: string };
  /** Anything the rules above cannot express. Return a message, or null to pass. */
  validate?: (value: Values[string], all: Values) => string | null;
  /** Lets one field update local state owned by the tab, e.g. dependent dropdowns. */
  onChange?: (value: Values[string], all: Values, patch?: (updates: Partial<Values>) => void) => Partial<Values> | void;
  /** Clears dependent fields when this field changes. */
  clearOnChange?: string[];
  /** `custom` only: draws an editor that may own several form keys at once (a
   *  payment plan edits sixteen). `patch` merges into the form values. */
  render?: (ctx: { values: Values; patch: (next: Values) => void; error?: string }) => ReactNode;
  /** `custom` only: what the editor contributes to the saved payload. */
  payload?: (all: Values) => Values;
}

/** A multiselect holds an array; every other field holds a scalar. */
export type Values = Record<string, string | number | boolean | null | (string | number)[]>;

/** Searchable checkbox list. A plain dropdown hides what is already ticked, which
 *  is the one thing that matters when a brand carries several manufacturers. */
function MultiSelect({
  options, value, onChange, isInvalid,
}: {
  options: Option[];
  value: (string | number)[];
  onChange: (next: (string | number)[]) => void;
  isInvalid?: boolean;
}) {
  const [query, setQuery] = useState("");
  const chosen = new Set(value.map(String));
  const shown = query
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options;
  const toggle = (option: Option) =>
    onChange(chosen.has(String(option.value))
      ? value.filter((v) => String(v) !== String(option.value))
      : [...value, option.value]);

  return (
    <div className={`rounded-xl border ${isInvalid ? "border-bad" : "border-line"} bg-content1`}>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Type to filter…"
        className="h-11 w-full rounded-t-xl border-b border-line bg-transparent px-3 text-sm outline-none"
      />
      <div className="max-h-44 overflow-y-auto p-1">
        {shown.length === 0 && (
          <p className="px-2 py-3 text-sm text-muted">Nothing matches “{query}”.</p>
        )}
        {shown.map((option) => (
          <label key={String(option.value)}
                 className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm hover:bg-content2">
            <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]"
                   checked={chosen.has(String(option.value))}
                   onChange={() => toggle(option)} />
            {option.label}
          </label>
        ))}
      </div>
      <div className="border-t border-line px-3 py-2 text-xs text-muted">
        {value.length} selected
      </div>
    </div>
  );
}

/** Catches what the browser would catch, before a round-trip does. The backend
 *  still validates everything — this only saves the user a 422 they can fix here. */
export function validateForm(fields: FormField[], values: Values): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    if (f.type === "switch") continue;
    const raw = values[f.key];
    if (f.type === "custom") {
      const message = f.validate?.(raw, values);
      if (message) errors[f.key] = message;
      continue;
    }
    if (f.type === "multiselect") {
      const picked = Array.isArray(raw) ? raw : [];
      if (f.required && picked.length === 0) errors[f.key] = `${f.label} is required`;
      else if (f.validate) {
        const message = f.validate(raw, values);
        if (message) errors[f.key] = message;
      }
      continue;
    }
    const text = raw === null || raw === undefined ? "" : String(raw).trim();

    if (f.required && text === "") {
      errors[f.key] = `${f.label} is required`;
    } else if (text !== "") {
      if (f.maxLength && text.length > f.maxLength) {
        errors[f.key] = `${f.label} cannot be longer than ${f.maxLength} characters`;
      } else if (f.pattern && !f.pattern.test(text)) {
        errors[f.key] = f.patternMessage ?? `${f.label} is not in the expected format`;
      } else if (f.type === "number") {
        const n = Number(text);
        if (Number.isNaN(n)) errors[f.key] = `${f.label} must be a number`;
        else if (f.min !== undefined && n < f.min) errors[f.key] = `${f.label} cannot be below ${f.min}`;
        else if (f.max !== undefined && n > f.max) errors[f.key] = `${f.label} cannot be above ${f.max}`;
      }
    }
    if (!errors[f.key] && f.validate) {
      const message = f.validate(raw, values);
      if (message) errors[f.key] = message;
    }
  }
  return errors;
}

interface Props<T extends { id: number }> {
  title: string;
  queryKey: string;
  columns: Column<T>[];
  renderCard: (r: T) => ReactNode;
  fetchList: (search: string) => Promise<T[]>;
  /** A function when the form changes shape with its own values (a Level 1
   *  category has no parent; Level 2 and 3 do). */
  fields: FormField[] | ((values: Values) => FormField[]);
  emptyForm: Values;
  /** Replaces the single New button with one per kind, each opening the form with
   *  its own starting values — e.g. New Level 1 / Level 2 / Level 3 category. */
  newActions?: { label: string; preset: Values }[];
  /** The form's heading, when "New <title>" does not say enough. */
  formTitle?: (values: Values, editing: boolean) => string;
  toForm: (r: T) => Values;
  managePerm: string;
  onCreate: (v: Values) => Promise<unknown>;
  onUpdate: (id: number, v: Values) => Promise<unknown>;
  /** Omit for masters the backend cannot deactivate (no is_active column). */
  onDeactivate?: (id: number) => Promise<unknown>;
  searchable?: boolean;
  readOnly?: boolean;
  /** The master's own api object. Supplying it turns on Template/Export/Import;
   *  omit it for the two HCM mirrors, which are read-only upstream. */
  bulk?: BulkApi;
  /** Supplying it shows what points at a row before it can be deactivated. */
  usage?: (id: number) => Promise<MasterUsage>;
  /** A wider form, for a master whose editor needs the room. */
  modalSize?: "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl";
}

function buildPayload(fields: FormField[], values: Values): Values {
  const out: Values = {};
  for (const f of fields) {
    let v = values[f.key];
    if (f.type === "custom") {
      Object.assign(out, f.payload?.(values) ?? {});
      continue;
    }
    if (f.type === "multiselect") {
      // An empty array, not null: the backend reads it as "no manufacturers", which
      // is a real answer, whereas null would be a missing one.
      out[f.key] = Array.isArray(v) ? v : [];
      continue;
    }
    if (f.type === "number") v = v === "" || v === null ? null : Number(v);
    // A cleared date is null, not "": the backend reads the pair as an optional
    // window, and an empty string is not a date it can parse.
    if (f.type === "date" && v === "") v = null;
    if (f.type === "select") {
      v = v === "" || v === undefined
        ? null
        : (f.options?.find((option) => String(option.value) === String(v))?.value ?? v);
    }
    out[f.key] = v ?? null;
  }
  return out;
}

/** Rows per page on a master list. The list is loaded whole; only the view is paged. */
export const MASTER_PAGE_SIZE = 25;

export function MasterCrud<T extends { id: number }>(p: Props<T>) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [values, setValues] = useState<Values>(p.emptyForm);
  // Three-letter codes: the code field takes its rule from here, for every master
  // in SHORT_CODE_PATHS, so fourteen tabs cannot each spell it differently.
  const shortPath = SHORT_CODE_PATHS[p.queryKey];
  const baseFields: FormField[] = typeof p.fields === "function" ? p.fields(values) : p.fields;
  const fields: FormField[] = shortPath ? baseFields.map((f) => f.key !== "code" ? f : {
    ...f, maxLength: undefined, pattern: undefined, patternMessage: undefined,
    hint: "Exactly 3 letters, e.g. ERB for Erba. Filled in from the name; change it if you like.",
    // Strict: every save must carry a 3-letter code. The legacy rows were all
    // recoded up front, so there is nothing left to grandfather here.
    validate: (v) => {
      const text = String(v ?? "").trim().toUpperCase();
      return /^[A-Z]{3}$/.test(text)
        ? null : "The code must be exactly 3 letters, e.g. ERB.";
    },
  }) : baseFields;
  const codeTouched = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [sortKey, setSortKey] = useState("");
  const [page, setPage] = useState(1);
  // A new search or sort starts again at page 1, or a narrowed list sits on an empty page.
  useEffect(() => setPage(1), [search, sortKey]);

  // loadError is surfaced, never swallowed. Defaulting a failed list to [] made a
  // broken request look like an empty master, which hid a 422 on every tab that asked
  // for more rows than the API allowed.
  const { data = [], isLoading, error: loadError, refetch } = useQuery({
    queryKey: ["masters", p.queryKey, search],
    queryFn: () => p.fetchList(search),
  });

  /** What the record is called in an alert. Falls back to the master's own name so
   *  a table without a `name` column still says something better than "undefined". */
  const recordLabel = () =>
    [values.name, values.code, values.title].find(
      (v): v is string => typeof v === "string" && v.trim() !== "",
    ) ?? p.title;

  const save = useMutation({
    mutationFn: (v: Values) =>
      editingId == null ? p.onCreate(v) : p.onUpdate(editingId, v),
    onSuccess: () => {
      void alerts.success("master.saved", { name: recordLabel() });
      qc.invalidateQueries({ queryKey: ["masters", p.queryKey] });
      setOpen(false);
    },
    onError: (e: Error) => setError(e.message),
  });

  const deactivate = useMutation({
    mutationFn: (id: number) => p.onDeactivate!(id),
    onSuccess: () => {
      void alerts.success("master.deactivated", { name: recordLabel() });
      qc.invalidateQueries({ queryKey: ["masters", p.queryKey] });
      setOpen(false);
    },
    onError: (e: Error) => setError(e.message),
  });

  const askThenDeactivate = async (id: number) => {
    setError(null);
    if (!(await alerts.confirm("master.deactivate", { name: recordLabel() }))) return;
    deactivate.mutate(id);
  };

  // What already points at the row being edited. Read while the modal is open so the
  // count is on screen before Deactivate is pressed, not discovered afterwards from a
  // document that lost its master.
  const { data: usage } = useQuery({
    queryKey: ["masters", p.queryKey, "usage", editingId],
    queryFn: () => p.usage!(editingId!),
    enabled: open && editingId != null && p.usage != null && p.onDeactivate != null,
  });

  const reset = () => { setError(null); setFieldErrors({}); };
  const openNew = (preset: Values = {}) => {
    codeTouched.current = false;
    setEditingId(null); setValues({ ...p.emptyForm, ...preset }); reset(); setOpen(true);
  };
  const openEdit = (row: T) => {
    codeTouched.current = true;   // an existing row's code is never re-suggested
    const form = p.toForm(row);
    setEditingId(row.id); setValues({ ...form, _orig_code: (row as { code?: string }).code ?? form.code ?? null });
    reset(); setOpen(true);
  };

  // Sorting is done here rather than in ResponsiveList: the list is a shared
  // component used by every module, and a master's list is already fully loaded, so
  // there is nothing a server round-trip would add.
  const sorted = sortKey
    ? [...data].sort((a, b) => {
        const column = p.columns.find((c) => c.key === sortKey);
        if (!column) return 0;
        const text = (row: T) => {
          const value = column.render(row);
          return typeof value === "string" || typeof value === "number"
            ? String(value)
            : String((row as Record<string, unknown>)[sortKey] ?? "");
        };
        return text(a).localeCompare(text(b), undefined, { numeric: true });
      })
    : data;

  /** Current page slice — shared between the S.No renderer (needs indexOf) and the list. */
  const pageSlice = sorted.slice((page - 1) * MASTER_PAGE_SIZE, page * MASTER_PAGE_SIZE);

  /** S.No prepended to every master list. Absolute across pages so page 2 starts at 26. */
  const snoColumn: Column<T> = {
    key: "__sno__",
    header: "S.No",
    className: "w-12 text-center",
    render: (row) => {
      const idx = pageSlice.indexOf(row);
      return (
        <span className="tabular-nums text-muted font-medium text-xs">
          {(page - 1) * MASTER_PAGE_SIZE + (idx >= 0 ? idx : 0) + 1}
        </span>
      );
    },
  };
  const columnsWithSno: Column<T>[] = [snoColumn, ...p.columns];

  const canEdit = !p.readOnly;
  // Clearing the field's own error as it is edited keeps a stale message from
  // sitting under a value the user has already fixed.
  const nameForCode = String(values.name ?? "").trim();
  useEffect(() => {
    if (!shortPath || !open || editingId != null || codeTouched.current || !nameForCode) return;
    const timer = window.setTimeout(() => {
      api.get<{ code: string }>(`${shortPath}/suggest-code`, { params: { name: nameForCode } })
        .then((r) => {
          if (!codeTouched.current) setValues((v) => ({ ...v, code: r.data.code }));
        })
        .catch(() => undefined);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [shortPath, open, editingId, nameForCode]);

  const set = (f: FormField, v: Values[string]) => {
    const k = f.key;
    if (k === "code") codeTouched.current = String(v ?? "") !== "";
    const nextValues = { ...values, [k]: v };
    for (const dependent of f.clearOnChange ?? []) nextValues[dependent] = null;
    const patch = (updates: Partial<Values>) => {
      setValues((curr) => ({ ...curr, ...updates }));
    };
    const updates = f.onChange?.(v, nextValues, patch);
    if (updates && typeof updates === "object") {
      Object.assign(nextValues, updates);
    }
    setValues(nextValues);
    setFieldErrors((e) => {
      const next = { ...e };
      delete next[k];
      for (const dependent of f.clearOnChange ?? []) delete next[dependent];
      // SCM_0069: a cross-field `validate` (e.g. "the four shares add up to 100%",
      // which can only live on one of the four percent fields) was cleared here
      // unconditionally — typing a NEW value that was STILL wrong made the error
      // vanish anyway, since nothing re-checked the field just edited against its
      // own rule. It showed again only on the next full-form validate (Save), which
      // read as the field "having an issue" with no visible cause while typing.
      if (f.validate) {
        const message = f.validate(v, nextValues);
        if (message) next[k] = message;
      }
      // A message under another field may have been about this one — the two ends of
      // a validity window judge each other. Re-run the ones still showing and drop
      // whichever this edit has just satisfied, so fixing one end clears both.
      for (const other of fields) {
        if (next[other.key] && !validateForm([other], nextValues)[other.key]) {
          delete next[other.key];
        }
      }
      return next;
    });
  };

  /** A custom editor's edit: several keys at once. Its own error clears, since the
   *  edit is the user answering it. */
  const patchMany = (f: FormField, next: Values) => {
    setValues((v) => ({ ...v, ...next }));
    setFieldErrors((e) => {
      if (!e[f.key]) return e;
      const copy = { ...e };
      delete copy[f.key];
      return copy;
    });
  };

  /** One field of the form. `bare` drops the hint: on a paired row the wrapper below
   *  prints the hints once, full width, instead of wrapping them under half a field. */
  const renderField = (f: FormField, bare = false) => {
    const val = values[f.key];
    const fieldError = fieldErrors[f.key] || undefined;
    const hint = bare ? undefined : f.hint;
    if (f.type === "custom") {
      return (
        <div key={f.key}>
          {f.render?.({ values, patch: (next) => patchMany(f, next), error: fieldError })}
        </div>
      );
    }
    if (f.type === "switch") {
      const isLockedOn = f.key === "is_bin_managed" && values.warehouse_type === "MAIN";
      const isChecked = isLockedOn ? true : Boolean(val);
      return (
        <div key={f.key} className="py-1">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              <span className="text-sm font-medium text-body">{f.label}</span>
              {isLockedOn && (
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700 ring-1 ring-emerald-200">
                  Always On for Main Store
                </span>
              )}
            </span>
            <Switch isSelected={isChecked} isDisabled={isLockedOn} onValueChange={(b) => set(f, b)}
                    color="primary" size="sm" />
          </div>
          {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
        </div>
      );
    }
    if (f.type === "multiselect") {
      return (
        <Field key={f.key} label={f.label}>
          <MultiSelect
            options={f.options ?? []}
            value={Array.isArray(val) ? val : []}
            isInvalid={Boolean(fieldError)}
            onChange={(next) => set(f, next)} />
          {fieldError
            ? <span className="mt-1 block text-xs text-bad">{fieldError}</span>
            : hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
        </Field>
      );
    }
    if (f.type === "select") {
      return (
        <Field key={f.key} label={f.label}>
          <Select value={(val as string | number | "") ?? ""}
                  placeholder={f.placeholder ?? "Type to search…"}
                  options={f.options ?? []}
                  isInvalid={Boolean(fieldError)}
                  errorMessage={fieldError}
                  onChange={(next) => set(
                    f,
                    next === ""
                      ? null
                      : (f.options?.find(
                          (option) => String(option.value) === String(next),
                        )?.value ?? next),
                  )} />
        </Field>
      );
    }
    // A date's own bounds come from the rest of the form, so the picker greys out
    // the days the pair forbids instead of letting one be chosen and then refused.
    const bounds = f.type === "date" ? f.range?.(values) ?? {} : {};
    return (
      // The hint steps aside for an error: two lines of small grey and
      // red text under one field is where the message gets missed.
      <Field key={f.key} label={f.label} hint={fieldError ? undefined : hint}>
        <Input
          type={f.type === "number" || f.type === "date" ? f.type : "text"}
          value={val === null || val === undefined ? "" : String(val)}
          placeholder={f.placeholder}
          maxLength={f.maxLength}
          min={bounds.min}
          max={bounds.max}
          isInvalid={Boolean(fieldError)}
          errorMessage={fieldError}
          onChange={(e) => set(f, e.target.value)}
        />
      </Field>
    );
  };

  // Consecutive fields marked `half` pair up into one row; everything else keeps a
  // row to itself.
  const rows: FormField[][] = [];
  for (const f of fields) {
    const last = rows[rows.length - 1];
    if (f.half && last?.length === 1 && last[0].half) last.push(f);
    else rows.push([f]);
  }

  const submit = () => {
    const found = validateForm(fields, values);
    setFieldErrors(found);
    if (Object.keys(found).length) return;
    setError(null);
    save.mutate(buildPayload(fields, values));
  };

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        {p.searchable && (
          <div className="relative flex-1 max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${p.title.toLowerCase()}…`}
              className="h-11 w-full rounded-xl border border-line bg-content1 pl-9 pr-3 text-sm outline-none focus:border-brand"
            />
          </div>
        )}
        <select
          aria-label={`Sort ${p.title.toLowerCase()}`}
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value)}
          className="h-11 rounded-xl border border-line bg-content1 px-3 text-sm outline-none focus:border-brand"
        >
          <option value="">Default order</option>
          {/* p.columns, not columnsWithSno — the S.No column is not sortable */}
          {p.columns.filter((c) => c.header).map((c) => (
            <option key={c.key} value={c.key}>Sort by {c.header}</option>
          ))}
        </select>
        <div className="ml-auto">
          {canEdit && (
            <Can do={p.managePerm}>
              {p.newActions ? (
                <div className="flex flex-wrap gap-2">
                  {p.newActions.map((action) => (
                    <Button key={action.label} onClick={() => openNew(action.preset)}>
                      <Plus className="h-4 w-4" /> {action.label}
                    </Button>
                  ))}
                </div>
              ) : (
                <Button onClick={() => openNew()}><Plus className="h-4 w-4" /> New</Button>
              )}
            </Can>
          )}
        </div>
      </div>

      {p.bulk && (
        <BulkBar api={p.bulk} managePerm={p.managePerm} queryKey={p.queryKey}
                 label={p.title} />
      )}

      {loadError ? (
        <div className="rounded-xl border border-bad/30 bg-bad-bg px-4 py-3">
          <div className="text-sm font-semibold text-bad">
            Could not load {p.title.toLowerCase()}s.
          </div>
          <p className="mt-1 text-xs text-body">{(loadError as Error).message}</p>
          <Button variant="ghost" className="mt-2" onClick={() => refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <ResponsiveList
          data={pageSlice}
          page={page}
          totalPages={Math.ceil(sorted.length / MASTER_PAGE_SIZE)}
          onPageChange={setPage}
          loading={isLoading}
          keyOf={(r) => r.id}
          columns={columnsWithSno}
          renderCard={p.renderCard}
          onRowClick={canEdit ? openEdit : undefined}
          empty={`No ${p.title.toLowerCase()} yet.`}
        />
      )}

      <Modal isOpen={open} onOpenChange={setOpen} placement="center" scrollBehavior="inside"
             size={p.modalSize ?? "md"}>
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>{p.formTitle ? p.formTitle(values, editingId != null)
                : editingId == null ? `New ${p.title}` : `Edit ${p.title}`}</ModalHeader>
              <ModalBody className="gap-3">
                {error && (
                  <div className="rounded-lg bg-bad-bg px-3 py-2 text-sm font-medium text-bad">{error}</div>
                )}
                {rows.map((row) => {
                  if (row.length === 1) return renderField(row[0]);
                  const hints = row
                    .filter((f) => f.hint && !fieldErrors[f.key])
                    .map((f) => f.hint);
                  return (
                    <div key={row[0].key}>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {row.map((f) => renderField(f, true))}
                      </div>
                      {hints.length > 0 && (
                        <p className="mt-1 text-xs text-muted">{hints.join(" ")}</p>
                      )}
                    </div>
                  );
                })}
              </ModalBody>
              <ModalFooter className="justify-between">
                {/* Deactivate sits apart from Save so it is never the button you hit
                    by reflex. Records are deactivated, never deleted: documents
                    reference them by id. */}
                <div>
                  {usage != null && usage.total > 0 && Boolean(values.is_active) && (
                    <p className="mb-2 max-w-md text-xs text-muted">
                      Used by {usage.used_by.map((u) => `${u.count} ${u.label.toLowerCase()}`).join(", ")}.
                      Deactivating hides it from new documents; existing ones keep it.
                    </p>
                  )}
                  {editingId != null && p.onDeactivate && Boolean(values.is_active) && (
                    <Can do={p.managePerm}>
                      <Button variant="ghost"
                              className="text-bad hover:bg-bad-bg"
                              onClick={() => void askThenDeactivate(editingId)}
                              disabled={deactivate.isPending}>
                        {deactivate.isPending ? "Deactivating…" : "Deactivate"}
                      </Button>
                    </Can>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={onClose}>Cancel</Button>
                  <Button onClick={submit} disabled={save.isPending}>
                    {save.isPending ? "Saving…" : "Save"}
                  </Button>
                </div>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </div>
  );
}
