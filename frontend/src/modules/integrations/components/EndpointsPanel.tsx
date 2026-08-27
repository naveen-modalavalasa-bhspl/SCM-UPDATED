import { useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { Copy, Download, Play, Plus, Trash2, Upload } from "lucide-react";
import {
  Button, Card, EmptyState, ErrorBanner, Field, Input, ResponsiveList, ScrollBox,
  Select, StatusPill, useToast, type Column,
} from "@/shared/components";
import { integrationsApi } from "../api";
import { absoluteUrl, curlFor } from "../snippets";
import { JoinEditor } from "./JoinEditor";
import type { ApiEndpoint, EndpointWrite, Preview } from "../types";

const BLANK: EndpointWrite = {
  slug: "", name: "", table: "", fields: [], joins: [], filters: {},
  filterable: [], searchable: [], order_by: "id", order_dir: "asc",
  updated_column: "", default_size: 100, max_size: 500, is_active: true,
};

/**
 * The builder — where an API is made. Pick any table the database has, tick the
 * columns, join what needs a name, pin the filters that must always apply, preview the
 * SQL and the first rows, save. No deploy, no developer, no fixed list of feeds.
 */
export function EndpointsPanel({ clientCode }: { clientCode: string }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<EndpointWrite | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [filterKey, setFilterKey] = useState("");
  const [filterValue, setFilterValue] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState("");
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveText, setMoveText] = useState("");

  const list = useQuery({
    queryKey: ["apis", "endpoints", clientCode],
    queryFn: () => integrationsApi.endpoints(clientCode),
  });

  const tables = useQuery({
    queryKey: ["apis", "tables"],
    queryFn: () => integrationsApi.tables(),
  });

  const columns = useQuery({
    queryKey: ["apis", "columns", draft?.table],
    queryFn: () => integrationsApi.columns(draft!.table),
    enabled: Boolean(draft?.table),
  });

  // Columns for every extra table, one query each, so the join editors and the
  // filter/search pickers all read the same cached lists.
  const joinColumns = useQueries({
    queries: (draft?.joins ?? []).map((join) => ({
      queryKey: ["apis", "columns", join.table],
      queryFn: () => integrationsApi.columns(join.table),
      enabled: Boolean(join.table),
    })),
  });

  /** Columns of whichever table an index refers to: -1 is the base table. */
  const columnsOf = (fromIndex: number) =>
    (fromIndex < 0 ? columns.data : joinColumns[fromIndex]?.data) ?? [];

  const columnOptions = useMemo(
    () => (columns.data ?? []).map((c) => ({ value: c.column, label: c.column })),
    [columns.data],
  );

  /**
   * Everything the endpoint RETURNS, base and joined, under the name it returns it as.
   * Filters, search and sort are keyed on these — so a joined column is narrowed
   * exactly like one of the base table's, without the caller knowing it was joined.
   */
  const exposedOptions = useMemo(() => {
    if (!draft) return [];
    const names = draft.fields.map((f) => f.label || f.column);
    draft.joins.forEach((join) => {
      join.fields.forEach((f) => names.push(f.label || `${join.table}_${f.column}`));
    });
    return names.map((name) => ({ value: name, label: name }));
  }, [draft]);

  /** What a pinned filter may name: any exposed column, plus base columns the endpoint
   *  chose not to return (pin `is_active=1` without shipping the flag). */
  const pinnableOptions = useMemo(() => {
    const seen = new Set(exposedOptions.map((o) => String(o.value)));
    return [
      ...exposedOptions,
      ...columnOptions.filter((o) => !seen.has(String(o.value))),
    ];
  }, [exposedOptions, columnOptions]);

  const dateOptions = useMemo(() => {
    if (!draft) return [];
    const out = (columns.data ?? []).filter((c) => c.is_date)
      .map((c) => ({ value: c.column, label: c.column }));
    draft.joins.forEach((join, index) => {
      (joinColumns[index]?.data ?? []).filter((c) => c.is_date).forEach((c) => {
        const field = join.fields.find((f) => f.column === c.column);
        if (field) out.push({
          value: field.label || `${join.table}_${c.column}`,
          label: field.label || `${join.table}_${c.column}`,
        });
      });
    });
    return out;
  }, [columns.data, draft, joinColumns]);

  /* ---- Moving a whole surface between deployments ------------------------- *
   * The box is what makes this work at all on a plain-http host, where
   * `navigator.clipboard` does not exist — the same reason the Job Profiles
   * copy/paste keeps one. The OS clipboard is a convenience on top, never the
   * carrier.
   */
  const clipCount = useMemo(() => {
    if (!moveText.trim()) return null;
    try {
      const parsed = JSON.parse(moveText);
      return Array.isArray(parsed?.endpoints) ? parsed.endpoints.length : null;
    } catch { return null; }
  }, [moveText]);

  const exportSet = useMutation({
    mutationFn: () => integrationsApi.exportEndpoints(clientCode),
    onSuccess: (clip) => {
      const text = JSON.stringify(clip, null, 2);
      setMoveText(text);
      setMoveOpen(true);
      const done = `${clip.endpoints.length} APIs copied — open the other deployment`
        + " and paste them there.";
      const written = navigator.clipboard?.writeText(text);
      // `?.` short-circuits the whole chain when the API is missing, so the toast has
      // to be raised on both paths or a plain-http host gets no feedback at all.
      if (!written) { toast.success(done); return; }
      written.then(() => toast.success(done),
                   () => toast.success(`${done} They are in the box below.`));
    },
    onError: () => toast.error("Those APIs could not be copied."),
  });

  const importSet = useMutation({
    mutationFn: ({ clip, replace }: { clip: unknown; replace: boolean }) =>
      integrationsApi.importEndpoints(clientCode, clip, replace),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["apis", "endpoints", clientCode] });
      setMoveOpen(false);
      setProblem("");
      toast.success(
        `${result.created} added, ${result.updated} updated`
        + (result.retired ? `, ${result.retired} switched off` : ""),
      );
    },
    // The server refuses the WHOLE clip when any one API does not fit, and says which
    // ones — that message is the useful part, so it is surfaced rather than replaced.
    onError: (error) => setProblem(
      (error as { response?: { data?: { error?: string } } })?.response?.data?.error
      || "Those APIs could not be applied here.",
    ),
  });

  const runImport = (replace: boolean) => {
    let clip: unknown;
    try {
      clip = JSON.parse(moveText);
    } catch {
      setProblem("That is not a copied set of APIs.");
      return;
    }
    importSet.mutate({ clip, replace });
  };

  const save = useMutation({
    mutationFn: (body: EndpointWrite) =>
      editing == null
        ? integrationsApi.createEndpoint(clientCode, body)
        : integrationsApi.updateEndpoint(clientCode, editing, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["apis"] });
      close();
      toast.success("Endpoint saved — it is live now");
    },
  });

  const runPreview = useMutation({
    mutationFn: (body: EndpointWrite) => integrationsApi.preview(clientCode, body),
    onSuccess: setPreview,
  });

  const remove = useMutation({
    mutationFn: (slug: string) => integrationsApi.deleteEndpoint(slug),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["apis"] });
      toast.success("Endpoint switched off");
    },
  });

  const close = () => {
    setDraft(null);
    setEditing(null);
    setPreview(null);
    setProblem("");
  };

  const open = (row?: ApiEndpoint) => {
    setPreview(null);
    setEditing(row?.slug ?? null);
    setDraft(row
      ? {
          slug: row.slug, name: row.name, table: row.table, fields: [...row.fields],
          joins: row.joins.map((j) => ({ ...j, fields: [...j.fields] })),
          filters: { ...row.filters }, filterable: [...row.filterable],
          searchable: [...row.searchable], order_by: row.order_by,
          order_dir: row.order_dir, updated_column: row.updated_column,
          default_size: row.default_size, max_size: row.max_size,
          is_active: row.is_active,
        }
      : { ...BLANK });
  };

  const pickTable = (table: string) => {
    if (!draft) return;
    // Columns belong to the table, so switching it clears everything that names one
    // rather than carrying names the new table has never heard of.
    setDraft({
      ...draft, table, fields: [], joins: [], filters: {}, filterable: [],
      searchable: [], order_by: "id", updated_column: "",
    });
    setPreview(null);
  };

  const toggleIn = (list: string[], name: string) =>
    list.includes(name) ? list.filter((n) => n !== name) : [...list, name];

  const toggleField = (name: string) => {
    if (!draft) return;
    setDraft({
      ...draft,
      fields: draft.fields.some((f) => f.column === name)
        ? draft.fields.filter((f) => f.column !== name)
        : [...draft.fields, { column: name, label: null }],
    });
  };

  const addFilter = () => {
    if (!draft || !filterKey || !filterValue.trim()) return;
    setDraft({ ...draft, filters: { ...draft.filters, [filterKey]: filterValue.trim() } });
    setFilterKey("");
    setFilterValue("");
  };

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  };

  const grid: Column<ApiEndpoint>[] = [
    {
      key: "slug",
      header: "Address",
      render: (row) => (
        <div>
          <div className="font-semibold text-ink">{row.name}</div>
          <div className="font-mono text-xs text-muted">{row.url}</div>
        </div>
      ),
    },
    {
      key: "source",
      header: "Source",
      render: (row) => (
        <div className="text-sm">
          <div className="font-mono text-ink">{row.table}</div>
          <div className="text-xs text-muted">
            {row.output_columns.length} columns
            {row.joins.length ? ` · ${row.joins.length} joined` : ""}
          </div>
        </div>
      ),
    },
    {
      key: "filters",
      header: "Always filtered by",
      hideOnNarrow: true,
      render: (row) => (
        <span className="text-xs text-muted">
          {Object.entries(row.filters).map(([k, v]) => `${k}=${v}`).join(", ") || "—"}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row) => <StatusPill status={row.is_active ? "ACTIVE" : "INACTIVE"} />,
    },
    {
      key: "actions",
      header: "",
      render: (row) => (
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => copy(curlFor(row))}>
            <Copy className="h-4 w-4" /> curl
          </Button>
          <Button variant="subtle" onClick={() => open(row)}>Edit</Button>
          {row.is_active && (
            <Button variant="dangerSoft" onClick={() => remove.mutate(row.slug)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  /** What is still missing, in words. Returning a reason beats greying a button out:
   *  a disabled control with no explanation is indistinguishable from a broken one. */
  const missing = (): string => {
    if (!draft) return "";
    if (!draft.name.trim()) return "Give the API a name.";
    if (!draft.slug.trim()) return "Give the API an address.";
    if (!draft.table) return "Pick a source table.";
    if (!draft.fields.length) return "Tick at least one column to expose.";
    return "";
  };

  const guarded = (run: (body: EndpointWrite) => void) => () => {
    if (!draft) return;
    const reason = missing();
    setProblem(reason);
    if (!reason) run(draft);
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          Any table in the database can be served. A caller can narrow what an endpoint
          returns; it can never widen past it.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {/* Moving a surface between deployments. 122 endpoints composed by hand on
            * one machine and composed again by hand on the next is not a migration,
            * it is a week of clicking with a typo in it. */}
          <Button variant="ghost" onClick={() => exportSet.mutate()}
                  disabled={exportSet.isPending || !(list.data ?? []).length}>
            <Download className="h-4 w-4" /> Copy all APIs
          </Button>
          <Button variant="ghost" onClick={() => setMoveOpen((v) => !v)}>
            <Upload className="h-4 w-4" /> Paste APIs
          </Button>
          <Button onClick={() => open()}>
            <Plus className="h-4 w-4" /> Build an API
          </Button>
        </div>
      </div>

      {moveOpen && (
        <Card className="mb-4 space-y-2 border-brand/40 p-3">
          <p className="text-sm font-semibold text-ink">
            {clipCount !== null
              ? `${clipCount} API${clipCount === 1 ? "" : "s"} in the box`
              : "Move APIs between deployments"}
          </p>
          <p className="text-xs text-muted">
            Copy on one deployment, paste on the next. Keys never travel — each
            deployment issues its own. Nothing is applied unless every API in the box
            fits this database, so a paste either lands whole or not at all.
          </p>
          <textarea
            value={moveText}
            onChange={(event) => setMoveText(event.target.value)}
            placeholder="Paste a copied set of APIs here"
            spellCheck={false}
            className="min-h-32 w-full rounded-lg border border-line bg-content1 p-3
                       font-mono text-xs text-ink"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={!moveText.trim() || importSet.isPending}
                    onClick={() => runImport(false)}>
              Add to this application
            </Button>
            {/* Switches off what the clip omits. Second, and never the default: a
              * partial paste must not silently retire the rest. */}
            <Button variant="ghost"
                    disabled={!moveText.trim() || importSet.isPending}
                    onClick={() => runImport(true)}>
              Replace everything here
            </Button>
            <Button variant="ghost" onClick={() => setMoveOpen(false)}>Close</Button>
          </div>
        </Card>
      )}

      {list.error && <ErrorBanner error="Endpoints could not be loaded." />}

      <ResponsiveList
        data={list.data ?? []}
        columns={grid}
        keyOf={(row) => row.slug}
        loading={list.isLoading}
        empty={
          <EmptyState
            title="No API built yet"
            hint="Pick a table, tick the columns you want to expose, give it an address — it is live the moment you save."
          />
        }
        renderCard={(row) => (
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-ink">{row.name}</span>
              <StatusPill status={row.is_active ? "ACTIVE" : "INACTIVE"} />
            </div>
            <div className="mt-1 font-mono text-xs text-muted">{row.url}</div>
            <div className="mt-1 text-xs text-muted">
              {row.table} · {row.output_columns.length} columns
            </div>
            <div className="mt-2 flex gap-2">
              <Button variant="ghost" onClick={() => copy(curlFor(row))}>Copy curl</Button>
              <Button variant="subtle" onClick={() => open(row)}>Edit</Button>
            </div>
          </div>
        )}
      />

      <Modal isOpen={draft !== null} onClose={close} size="5xl" scrollBehavior="inside">
        <ModalContent>
          <ModalHeader className="font-display text-lg font-bold text-ink">
            {editing == null ? "Build an API" : `Edit /${editing}`}
          </ModalHeader>
          <ModalBody>
            {draft && (
              <div className="space-y-4">
                {/* Inside the dialog: a banner behind an open modal is invisible, and
                    a rejected save then reads as a dead button. */}
                {save.error && <ErrorBanner error={save.error} />}
                {problem && <ErrorBanner error={problem} />}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Name">
                    <Input value={draft.name} placeholder="Stock on hand"
                           onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                  </Field>
                  <Field label="Address" hint="Lowercase, hyphenated.">
                    <Input value={draft.slug} placeholder="stock-on-hand"
                           onChange={(e) => setDraft({ ...draft, slug: e.target.value })} />
                  </Field>
                </div>

                <Field label="Source table"
                       hint="Everything the database has, except credentials and console configuration.">
                  <Select
                    value={draft.table}
                    onChange={pickTable}
                    options={(tables.data ?? []).map((t) => ({
                      value: t.table, label: `${t.group} · ${t.table}`,
                    }))}
                    placeholder="Pick a table"
                    ariaLabel="Source table"
                  />
                </Field>

                {draft.table && (
                  <>
                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-sm font-medium text-body">
                          Columns to expose ({draft.fields.length}/{columnOptions.length})
                        </span>
                        <Button variant="ghost" onClick={() => setDraft({
                          ...draft,
                          fields: (columns.data ?? []).map((c) => ({ column: c.column, label: null })),
                        })}>
                          Select all
                        </Button>
                      </div>
                      <div className="grid max-h-56 grid-cols-2 gap-1 overflow-y-auto rounded-xl border border-line p-3 sm:grid-cols-3">
                        {(columns.data ?? []).map((c) => (
                          <label key={c.column}
                                 className="flex min-h-9 cursor-pointer items-center gap-2 text-sm text-body">
                            <input type="checkbox" className="h-4 w-4"
                                   checked={draft.fields.some((f) => f.column === c.column)}
                                   onChange={() => toggleField(c.column)} />
                            <span className="font-mono text-xs">{c.column}</span>
                          </label>
                        ))}
                      </div>
                    </div>

                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-sm font-medium text-body">
                          More source tables ({draft.joins.length}) — each one joins to
                          the base table or to another already added
                        </span>
                        <Button variant="ghost"
                                disabled={draft.joins.length >= 8}
                                onClick={() => setDraft({
                                  ...draft,
                                  joins: [...draft.joins, {
                                    table: "", from_index: -1, base_column: "",
                                    join_column: "", fields: [],
                                  }],
                                })}>
                          Add table
                        </Button>
                      </div>
                      <div className="space-y-2">
                        {draft.joins.map((join, index) => (
                          <JoinEditor
                            key={index}
                            index={index}
                            join={join}
                            joins={draft.joins}
                            baseTable={draft.table}
                            columnsOf={columnsOf}
                            tables={tables.data ?? []}
                            onChange={(next) => setDraft({
                              ...draft,
                              joins: draft.joins.map((j, i) => (i === index ? next : j)),
                            })}
                            onRemove={() => setDraft({
                              ...draft,
                              joins: draft.joins.filter((_, i) => i !== index),
                            })}
                          />
                        ))}
                      </div>
                    </div>

                    <div>
                      <div className="mb-2 text-sm font-medium text-body">
                        Filters that always apply
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(draft.filters).map(([k, v]) => (
                          <span key={k}
                                className="inline-flex items-center gap-2 rounded-full bg-content2 px-3 py-1 text-xs">
                            <span className="font-mono">{k}={v}</span>
                            <button type="button" aria-label={`Remove ${k}`}
                                    onClick={() => {
                                      const next = { ...draft.filters };
                                      delete next[k];
                                      setDraft({ ...draft, filters: next });
                                    }}>
                              ×
                            </button>
                          </span>
                        ))}
                        {!Object.keys(draft.filters).length && (
                          <span className="text-xs text-muted">None — the whole table.</span>
                        )}
                      </div>
                      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                        {/* Exposed columns first (joined ones included), then any base
                            column not exposed — an endpoint can pin `is_active=1`
                            without having to return it. */}
                        <Select value={filterKey} onChange={setFilterKey}
                                options={pinnableOptions} placeholder="Column"
                                ariaLabel="Filter column" />
                        <Input value={filterValue} placeholder="Value (a,b for either)"
                               onChange={(e) => setFilterValue(e.target.value)} />
                        <Button variant="soft" onClick={addFilter}>Pin</Button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {/* Both lists are the columns the endpoint RETURNS, joined ones
                          included — so a caller narrows by the name it sees, without
                          needing to know which table the column came from. */}
                      <div>
                        <div className="mb-2 text-sm font-medium text-body">
                          Caller may filter by
                        </div>
                        <div className="grid max-h-40 grid-cols-2 gap-1 overflow-y-auto rounded-xl border border-line p-2">
                          {exposedOptions.map((c) => (
                            <label key={c.value}
                                   className="flex min-h-9 cursor-pointer items-center gap-2 text-xs text-body">
                              <input type="checkbox" className="h-4 w-4"
                                     checked={draft.filterable.includes(c.value)}
                                     onChange={() => setDraft({
                                       ...draft,
                                       filterable: toggleIn(draft.filterable, c.value),
                                     })} />
                              <span className="font-mono">{c.label}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="mb-2 text-sm font-medium text-body">
                          ?search= sweeps
                        </div>
                        <div className="grid max-h-40 grid-cols-2 gap-1 overflow-y-auto rounded-xl border border-line p-2">
                          {exposedOptions.map((c) => (
                            <label key={c.value}
                                   className="flex min-h-9 cursor-pointer items-center gap-2 text-xs text-body">
                              <input type="checkbox" className="h-4 w-4"
                                     checked={draft.searchable.includes(c.value)}
                                     onChange={() => setDraft({
                                       ...draft,
                                       searchable: toggleIn(draft.searchable, c.value),
                                     })} />
                              <span className="font-mono">{c.label}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <Field label="Sort by">
                        <Select value={draft.order_by}
                                onChange={(order_by) => setDraft({ ...draft, order_by })}
                                options={pinnableOptions} ariaLabel="Sort column" />
                      </Field>
                      <Field label="Direction">
                        <Select value={draft.order_dir}
                                onChange={(v) => setDraft({
                                  ...draft, order_dir: v === "desc" ? "desc" : "asc",
                                })}
                                options={[{ value: "asc", label: "Ascending" },
                                          { value: "desc", label: "Descending" }]}
                                ariaLabel="Sort direction" />
                      </Field>
                      <Field label="Default page size">
                        <Input type="number" value={String(draft.default_size)}
                               onChange={(e) => setDraft({
                                 ...draft, default_size: Number(e.target.value || 0),
                               })} />
                      </Field>
                      <Field label="Maximum page size">
                        <Input type="number" value={String(draft.max_size)}
                               onChange={(e) => setDraft({
                                 ...draft, max_size: Number(e.target.value || 0),
                               })} />
                      </Field>
                    </div>

                    <Field
                      label="Incremental pulls (?updated_since=)"
                      hint={dateOptions.length
                        ? "Pick the column that moves when a row changes. Blank means the consumer pulls the whole table each time."
                        : "This table has no date column, so it can only be pulled whole."}
                    >
                      <Select
                        value={draft.updated_column}
                        onChange={(updated_column) => setDraft({ ...draft, updated_column })}
                        options={[{ value: "", label: "— none —" }, ...dateOptions]}
                        ariaLabel="Change column"
                      />
                    </Field>

                    {draft.slug && (
                      <Card className="p-3">
                        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
                          What the consumer calls
                        </div>
                        <div className="break-all font-mono text-xs text-ink">
                          {absoluteUrl(`/api/ext/v1/${draft.slug}`)}
                        </div>
                        <div className="mt-2 break-all font-mono text-xs text-muted">
                          {curlFor({ url: `/api/ext/v1/${draft.slug}` })}
                        </div>
                      </Card>
                    )}

                    {runPreview.error && <ErrorBanner error={runPreview.error} />}

                    {preview && (
                      <Card className="p-3">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="text-sm font-medium text-body">
                            Preview — {preview.total.toLocaleString()} rows match
                          </span>
                          <Button variant="ghost" onClick={() => copy(preview.sql)}>
                            Copy SQL
                          </Button>
                        </div>
                        <ScrollBox className="max-h-56">
                          <table className="w-full text-left text-xs">
                            <thead>
                              <tr>
                                {preview.columns.map((c) => (
                                  <th key={c} className="whitespace-nowrap px-2 py-1 font-mono text-muted">
                                    {c}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {preview.rows.map((row, index) => (
                                <tr key={index} className="border-t border-line/60">
                                  {preview.columns.map((c) => (
                                    <td key={c} className="whitespace-nowrap px-2 py-1 text-ink">
                                      {row[c] == null ? "—" : String(row[c])}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </ScrollBox>
                        {!preview.rows.length && (
                          <p className="mt-2 text-xs text-muted">
                            No rows match. The endpoint is valid — the filters are simply
                            narrower than the data.
                          </p>
                        )}
                      </Card>
                    )}
                  </>
                )}
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="subtle" onClick={close}>Cancel</Button>
            <Button variant="soft" disabled={runPreview.isPending}
                    onClick={guarded((body) => runPreview.mutate(body))}>
              <Play className="h-4 w-4" /> Preview
            </Button>
            <Button disabled={save.isPending}
                    onClick={guarded((body) => save.mutate(body))}>
              Save & publish
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
