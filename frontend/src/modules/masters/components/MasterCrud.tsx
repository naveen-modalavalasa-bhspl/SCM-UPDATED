import { type ReactNode, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Switch,
} from "@heroui/react";
import { Plus, Search } from "lucide-react";
import {
  Button, Can, Field, Input, ResponsiveList, Select, type Column,
} from "@/shared/components";

export type FieldType = "text" | "number" | "select" | "switch";
export interface Option { value: string | number; label: string }

export interface FormField {
  key: string;
  label: string;
  type?: FieldType;
  options?: Option[];
  required?: boolean;
  placeholder?: string;
}

type Values = Record<string, string | number | boolean | null>;

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

  const openNew = () => { setEditingId(null); setValues(p.emptyForm); setError(null); setOpen(true); };
  const openEdit = (row: T) => { setEditingId(row.id); setValues(p.toForm(row)); setError(null); setOpen(true); };

  const canEdit = !p.readOnly;
  const set = (k: string, v: Values[string]) => setValues((s) => ({ ...s, [k]: v }));

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
                  if (f.type === "switch") {
                    return (
                      <div key={f.key} className="flex items-center justify-between py-1">
                        <span className="text-sm font-medium text-body">{f.label}</span>
                        <Switch isSelected={Boolean(val)} onValueChange={(b) => set(f.key, b)}
                                color="primary" size="sm" />
                      </div>
                    );
                  }
                  if (f.type === "select") {
                    return (
                      <Field key={f.key} label={f.label}>
                        <Select value={(val as string | number | "") ?? ""}
                                placeholder={f.placeholder ?? "Select…"}
                                options={f.options ?? []}
                                onChange={(next) => set(
                                  f.key,
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
                        onChange={(e) => set(f.key, e.target.value)}
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
                  <Button onClick={() => { setError(null); save.mutate(buildPayload(p.fields, values)); }}
                          disabled={save.isPending}>
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
