import { type ReactNode, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Switch,
} from "@heroui/react";
import { Plus, Search } from "lucide-react";
import {
  Button, Can, Field, Input, ResponsiveList, Select, type Column,
} from "@/shared/components";

export type FieldType = "text" | "number" | "select" | "switch" | "multiselect";
export interface Option { value: string | number; label: string }

export interface FormField {
  key: string;
  label: string;
  type?: FieldType;
  options?: Option[];
  required?: boolean;
  placeholder?: string;
  maxLength?: number;
  /** Checked against the trimmed value. Pair it with `patternMessage`, or the user
   *  is told a regular expression rather than what to type. */
  pattern?: RegExp;
  patternMessage?: string;
  min?: number;
  max?: number;
  /** Anything the rules above cannot express. Return a message, or null to pass. */
  validate?: (value: Values[string], all: Values) => string | null;
  /** Lets one field update local state owned by the tab, e.g. dependent dropdowns. */
  onChange?: (value: Values[string], all: Values) => void;
  /** Clears dependent fields when this field changes. */
  clearOnChange?: string[];
}

/** A multiselect holds an array; every other field holds a scalar. */
type Values = Record<string, string | number | boolean | null | (string | number)[]>;

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
  fields: FormField[];
  emptyForm: Values;
  toForm: (r: T) => Values;
  managePerm: string;
  onCreate: (v: Values) => Promise<unknown>;
  onUpdate: (id: number, v: Values) => Promise<unknown>;
  /** Omit for masters the backend cannot deactivate (no is_active column). */
  onDeactivate?: (id: number) => Promise<unknown>;
  searchable?: boolean;
  readOnly?: boolean;
}

function buildPayload(fields: FormField[], values: Values): Values {
  const out: Values = {};
  for (const f of fields) {
    let v = values[f.key];
    if (f.type === "multiselect") {
      // An empty array, not null: the backend reads it as "no manufacturers", which
      // is a real answer, whereas null would be a missing one.
      out[f.key] = Array.isArray(v) ? v : [];
      continue;
    }
    if (f.type === "number") v = v === "" || v === null ? null : Number(v);
    if (f.type === "select") {
      v = v === "" || v === undefined
        ? null
        : (f.options?.find((option) => String(option.value) === String(v))?.value ?? v);
    }
    out[f.key] = v ?? null;
  }
  return out;
}

export function MasterCrud<T extends { id: number }>(p: Props<T>) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [values, setValues] = useState<Values>(p.emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // loadError is surfaced, never swallowed. Defaulting a failed list to [] made a
  // broken request look like an empty master, which hid a 422 on every tab that asked
  // for more rows than the API allowed.
  const { data = [], isLoading, error: loadError, refetch } = useQuery({
    queryKey: ["masters", p.queryKey, search],
    queryFn: () => p.fetchList(search),
  });

  const save = useMutation({
    mutationFn: (v: Values) =>
      editingId == null ? p.onCreate(v) : p.onUpdate(editingId, v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["masters", p.queryKey] });
      setOpen(false);
    },
    onError: (e: Error) => setError(e.message),
  });

  const deactivate = useMutation({
    mutationFn: (id: number) => p.onDeactivate!(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["masters", p.queryKey] });
      setOpen(false);
    },
    onError: (e: Error) => setError(e.message),
  });

  const reset = () => { setError(null); setFieldErrors({}); };
  const openNew = () => { setEditingId(null); setValues(p.emptyForm); reset(); setOpen(true); };
  const openEdit = (row: T) => { setEditingId(row.id); setValues(p.toForm(row)); reset(); setOpen(true); };

  const canEdit = !p.readOnly;
  // Clearing the field's own error as it is edited keeps a stale message from
  // sitting under a value the user has already fixed.
  const set = (f: FormField, v: Values[string]) => {
    const k = f.key;
    const nextValues = { ...values, [k]: v };
    for (const dependent of f.clearOnChange ?? []) nextValues[dependent] = null;
    setValues(nextValues);
    f.onChange?.(v, nextValues);
    setFieldErrors((e) => {
      const next = { ...e };
      delete next[k];
      for (const dependent of f.clearOnChange ?? []) delete next[dependent];
      return next;
    });
  };

  const submit = () => {
    const found = validateForm(p.fields, values);
    setFieldErrors(found);
    if (Object.keys(found).length) return;
    setError(null);
    save.mutate(buildPayload(p.fields, values));
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
        <div className="ml-auto">
          {canEdit && (
            <Can do={p.managePerm}>
              <Button onClick={openNew}><Plus className="h-4 w-4" /> New</Button>
            </Can>
          )}
        </div>
      </div>

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
          data={data}
          loading={isLoading}
          keyOf={(r) => r.id}
          columns={p.columns}
          renderCard={p.renderCard}
          onRowClick={canEdit ? openEdit : undefined}
          empty={`No ${p.title.toLowerCase()} yet.`}
        />
      )}

      <Modal isOpen={open} onOpenChange={setOpen} placement="center" scrollBehavior="inside">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>{editingId == null ? `New ${p.title}` : `Edit ${p.title}`}</ModalHeader>
              <ModalBody className="gap-3">
                {error && (
                  <div className="rounded-lg bg-bad-bg px-3 py-2 text-sm font-medium text-bad">{error}</div>
                )}
                {p.fields.map((f) => {
                  const val = values[f.key];
                  const fieldError = fieldErrors[f.key] || undefined;
                  if (f.type === "switch") {
                    return (
                      <div key={f.key} className="flex items-center justify-between py-1">
                        <span className="text-sm font-medium text-body">{f.label}</span>
                        <Switch isSelected={Boolean(val)} onValueChange={(b) => set(f, b)}
                                color="primary" size="sm" />
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
                        {fieldError && (
                          <span className="mt-1 block text-xs text-bad">{fieldError}</span>
                        )}
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
                  return (
                    <Field key={f.key} label={f.label}>
                      <Input
                        type={f.type === "number" ? "number" : "text"}
                        value={val === null || val === undefined ? "" : String(val)}
                        placeholder={f.placeholder}
                        maxLength={f.maxLength}
                        isInvalid={Boolean(fieldError)}
                        errorMessage={fieldError}
                        onChange={(e) => set(f, e.target.value)}
                      />
                    </Field>
                  );
                })}
              </ModalBody>
              <ModalFooter className="justify-between">
                {/* Deactivate sits apart from Save so it is never the button you hit
                    by reflex. Records are deactivated, never deleted: documents
                    reference them by id. */}
                <div>
                  {editingId != null && p.onDeactivate && Boolean(values.is_active) && (
                    <Can do={p.managePerm}>
                      <Button variant="ghost"
                              className="text-bad hover:bg-bad-bg"
                              onClick={() => { setError(null); deactivate.mutate(editingId); }}
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
