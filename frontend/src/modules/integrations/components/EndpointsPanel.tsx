import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { Copy, Download, Play, Plus, Power, RefreshCw, Upload } from "lucide-react";
import {
  Button, Card, ConfirmModal, EmptyState, ErrorBanner, Field, Input, ResponsiveList,
  ScrollBox, Select, StatusPill, useToast, type Column,
} from "@/shared/components";
import { integrationsApi } from "../api";
import { absoluteUrl, curlFor } from "../snippets";
import { ColumnPicker } from "./ColumnPicker";
import { writeToClipboard } from "./Copyable";
import { JoinEditor } from "./JoinEditor";
import type { ApiEndpoint, EndpointWrite, Preview } from "../types";

const BLANK: EndpointWrite = {
  slug: "", name: "", table: "", fields: [], joins: [], filters: {},
  filterable: [], searchable: [], order_by: "id", order_dir: "asc",
  updated_column: "", default_size: 100, max_size: 500, is_active: true,
};

/** The address a name turns into — `Stock on hand` → `stock-on-hand`. The two fields
 *  were filled in by hand one after the other, which is a typo waiting to be
 *  published: the address is what the consumer hardcodes, and it cannot be corrected
 *  afterwards without breaking their build. */
const slugify = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** A saved endpoint back into the shape the form and the PUT both take. One
 *  definition, because switching an API back on saves the whole document — a second
 *  hand-written copy of this mapping would quietly drop whatever it forgot. */
const toWrite = (row: ApiEndpoint): EndpointWrite => ({
  slug: row.slug, name: row.name, table: row.table, fields: [...row.fields],
  joins: row.joins.map((j) => ({ ...j, fields: [...j.fields] })),
  filters: { ...row.filters }, filterable: [...row.filterable],
  searchable: [...row.searchable], order_by: row.order_by, order_dir: row.order_dir,
  updated_column: row.updated_column, default_size: row.default_size,
  max_size: row.max_size, is_active: row.is_active,
});

/** One numbered step of the builder. The form was eight unlabelled blocks in one
 *  scroll, so a first-time reader could not tell which of them they still had to
 *  answer, nor that the last four are all optional. */
function Section({ step, title, note, children }: {
  step: number;
  title: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line/70 p-3">
      <div className="mb-3 flex items-start gap-2.5">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full
                         bg-brand-050 text-[11px] font-bold text-brand">
          {step}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-ink">{title}</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-muted">{note}</span>
        </span>
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/** A row of toggleable names — what a caller may narrow by, and what `?search=`
 *  sweeps. Two checkbox grids of the same list, side by side, read as one control
 *  duplicated by mistake; chips make what is ON visible at a glance. */
function ChipToggles({ options, value, onToggle, empty }: {
  options: { value: string; label: string }[];
  value: string[];
  onToggle: (name: string) => void;
  empty: string;
}) {
  const on = new Set(value);
  if (!options.length) {
    return <p className="text-xs text-muted">{empty}</p>;
  }
  return (
    <ScrollBox className="max-h-32">
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={on.has(option.value)}
            onClick={() => onToggle(option.value)}
            className={`rounded-full px-2.5 py-1 font-mono text-[11px] transition ${
              on.has(option.value)
                ? "bg-brand text-white"
                : "bg-content2 text-muted hover:bg-content2/70 hover:text-body"}`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </ScrollBox>
  );
}

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
  // Whether the address has been typed by hand. Until it has, it follows the name.
  const [slugTouched, setSlugTouched] = useState(false);
  const [filterKey, setFilterKey] = useState("");
  const [filterValue, setFilterValue] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState("");
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveText, setMoveText] = useState("");
  /* The paste box's OWN refusal, deliberately not `problem`. That one is rendered
   * inside the Build-an-API dialog, which is closed during a paste — so routing the
   * server's reason through it wrote the message to a surface nobody could see, and
   * a refused paste read as a dead button: no error, no toast, nothing applied. */
  const [moveProblem, setMoveProblem] = useState("");
  const [switchingOff, setSwitchingOff] = useState<ApiEndpoint | null>(null);

  const list = useQuery({
    queryKey: ["apis", "endpoints", clientCode],
    queryFn: () => integrationsApi.endpoints(clientCode),
  });

  const tables = useQuery({
    queryKey: ["apis", "tables"],
    queryFn: integrationsApi.tables,
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
      // One carrier for the whole console — it falls back to an off-screen textarea
      // where `navigator.clipboard` does not exist, and answers whether it landed, so
      // the toast can never claim a copy that did not happen. The box stays the
      // guarantee either way.
      writeToClipboard(text).then((ok) => toast.success(
        ok ? done : `${done} They are in the box below — select it and copy.`));
    },
    onError: () => toast.error("Could not copy the selected APIs. Try again."),
  });

  const importSet = useMutation({
    mutationFn: ({ clip, replace }: { clip: unknown; replace: boolean }) =>
      integrationsApi.importEndpoints(clientCode, clip, replace),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["apis", "endpoints", clientCode] });
      setMoveOpen(false);
      setMoveProblem("");
      toast.success(
        `${result.created} added, ${result.updated} updated`
        + (result.retired ? `, ${result.retired} switched off` : ""),
      );
    },
    // The server refuses the WHOLE clip when any one API does not fit, and says which
    // ones — that message is the useful part, so it is surfaced rather than replaced.
    // What it refuses for now is a table or column this deployment does not have.
    onError: (error) => setMoveProblem(
      (error as { response?: { data?: { error?: string } } })?.response?.data?.error
      || "Those APIs could not be applied here.",
    ),
  });

  const runImport = (replace: boolean) => {
    let clip: unknown;
    try {
      clip = JSON.parse(moveText);
    } catch {
      setMoveProblem("That is not a copied set of APIs.");
      return;
    }
    setMoveProblem("");
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
    mutationFn: (slug: string) => integrationsApi.deleteEndpoint(clientCode, slug),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["apis"] });
      setSwitchingOff(null);
      toast.success("Endpoint switched off");
    },
  });

  // The way back. Switching off is a `DELETE` that only sets the flag, and the
  // confirmation promises the definition "can be edited back on" — but the builder
  // has no on/off control (an API's state is not something to change halfway through
  // editing its columns), so the row that turned it off is the row that turns it back
  // on. Saves the whole document through the same PUT an edit uses.
  const switchOn = useMutation({
    mutationFn: (row: ApiEndpoint) =>
      integrationsApi.updateEndpoint(clientCode, row.slug,
                                     { ...toWrite(row), is_active: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["apis"] });
      toast.success("Endpoint switched back on — it is being served again");
    },
    onError: () => toast.error("Could not turn this API on. Try again."),
  });

  /* The picker is served off a schema cache the server builds once and keeps. A
   * migration adds a table and this console cannot see it until the process is
   * restarted — which is a deploy, for something an admin ought to be able to do
   * from the screen that needs it. `POST /schema/refresh` was already there with
   * nothing pressing it. The cached column lists go with it: they were read from
   * the same snapshot. */
  const refreshSchema = useMutation({
    mutationFn: () => integrationsApi.refreshSchema(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["apis", "tables"] });
      await queryClient.invalidateQueries({ queryKey: ["apis", "columns"] });
      toast.success("Schema re-read — new tables and columns are pickable now");
    },
    onError: () => toast.error("Could not refresh this API's details. Try again."),
  });

  const close = () => {
    setDraft(null);
    setEditing(null);
    setPreview(null);
    setProblem("");
    setSlugTouched(false);
  };

  const open = (row?: ApiEndpoint) => {
    setPreview(null);
    setEditing(row?.slug ?? null);
    // An existing address is never rewritten from the name: consumers have it.
    setSlugTouched(Boolean(row));
    setDraft(row ? toWrite(row) : { ...BLANK });
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

  const addFields = (names: string[]) => {
    if (!draft) return;
    const held = new Set(draft.fields.map((f) => f.column));
    setDraft({
      ...draft,
      fields: [
        ...draft.fields,
        ...names.filter((name) => !held.has(name)).map((name) => ({ column: name, label: null })),
      ],
    });
  };

  const addFilter = () => {
    if (!draft || !filterKey || !filterValue.trim()) return;
    setDraft({ ...draft, filters: { ...draft.filters, [filterKey]: filterValue.trim() } });
    setFilterKey("");
    setFilterValue("");
  };

  // Through the module's own carrier, not `navigator.clipboard` directly: that API
  // does not exist on a plain-http host, where the bare call threw and the press did
  // nothing and said nothing.
  const copy = async (text: string) => {
    if (await writeToClipboard(text)) {
      toast.success("Copied to clipboard");
      return;
    }
    toast.error("Copy did not work. Select the text with your mouse and press Ctrl+C.");
  };

  const grid: Column<ApiEndpoint>[] = [
    {
      key: "slug",
      header: "API",
      render: (row) => (
        <div className="min-w-0">
          <div className="font-semibold text-ink">{row.name}</div>
          <div className="truncate font-mono text-xs text-muted">{row.url}</div>
        </div>
      ),
    },
    {
      key: "source",
      header: "Reads from",
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
          {Object.entries(row.filters).map(([k, v]) => `${k}=${v}`).join(", ")
            || "Nothing — the whole table"}
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
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => copy(curlFor(row))}>
            <Copy className="h-4 w-4" /> curl
          </Button>
          <Button variant="subtle" onClick={() => open(row)}>Edit</Button>
          {row.is_active ? (
            // Named, not a bare bin icon: this switches an API off for whoever is
            // calling it, and a trash can suggests it is being deleted.
            <Button variant="dangerSoft" onClick={() => setSwitchingOff(row)}>
              <Power className="h-4 w-4" /> Switch off
            </Button>
          ) : (
            <Button variant="soft" disabled={switchOn.isPending}
                    onClick={() => switchOn.mutate(row)}>
              <Power className="h-4 w-4" /> Switch on
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
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted">
          An API is one dataset this application may read: a table, the columns you
          tick, and the filters that always apply. A caller can narrow what it returns;
          it can never widen past it, and it can never write.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {/* Beside the button that needs it: the only reason to re-read the schema
              is that the table you came to expose is not in the picker. */}
          <Button variant="ghost" disabled={refreshSchema.isPending}
                  onClick={() => refreshSchema.mutate()}
                  className="text-xs">
            <RefreshCw className={`h-4 w-4 ${refreshSchema.isPending ? "animate-spin" : ""}`} />
            {refreshSchema.isPending ? "Re-reading…" : "Re-read the database"}
          </Button>
          <Button onClick={() => open()}>
            <Plus className="h-4 w-4" /> Build an API
          </Button>
        </div>
      </div>

      {/* Moving a surface between deployments. 122 endpoints composed by hand on one
        * machine and composed again by hand on the next is not a migration, it is a
        * week of clicking with a typo in it. It sits below the register and under its
        * own heading now: two ghost buttons beside "Build an API" read as equal
        * choices, and "Paste APIs" is not something anyone does on their first visit.
        */}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>Moving this application to another deployment?</span>
        <Button variant="ghost" onClick={() => exportSet.mutate()}
                disabled={exportSet.isPending || !(list.data ?? []).length}>
          <Download className="h-4 w-4" /> Copy all APIs
        </Button>
        <Button variant="ghost" onClick={() => setMoveOpen((v) => !v)}>
          <Upload className="h-4 w-4" /> Paste APIs
        </Button>
      </div>

      {moveOpen && (
        <Card className="mb-4 space-y-2 border-brand/40 p-3">
          <p className="text-sm font-semibold text-ink">
            {clipCount !== null
              ? `${clipCount} API${clipCount === 1 ? "" : "s"} in the box`
              : "Move APIs between deployments"}
          </p>
          <p className="text-xs text-muted">
            Seed an application from a set somebody already built — another
            application here, or this one on the next deployment. Addresses arrive
            unchanged, because each application owns its own. Keys never travel; each
            deployment issues its own. Nothing is applied unless every API in the box
            fits this database, so a paste either lands whole or not at all.
          </p>
          {problem && <ErrorBanner error={problem} />}
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
          {/* In the box, under the buttons that caused it. The clip is all-or-nothing,
            * so a refusal means nothing changed — and the server names the APIs it
            * choked on, which is the only way to tell "this set belongs to another
            * application" apart from "this table is not on this deployment". */}
          {moveProblem && <ErrorBanner error={moveProblem} />}
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
            hint="Pick a table, tick the columns this application may read, give it an address — it is live the moment you save. Nothing is deployed and no developer is involved."
            action={
              <Button onClick={() => open()}>
                <Plus className="h-4 w-4" /> Build an API
              </Button>
            }
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
              {row.is_active ? (
                <Button variant="dangerSoft" onClick={() => setSwitchingOff(row)}>
                  <Power className="h-4 w-4" /> Switch off
                </Button>
              ) : (
                <Button variant="soft" disabled={switchOn.isPending}
                        onClick={() => switchOn.mutate(row)}>
                  <Power className="h-4 w-4" /> Switch on
                </Button>
              )}
            </div>
          </div>
        )}
      />

      {/* Switching an API off is felt on somebody else's machine, immediately, so it
          is asked rather than done on a single press of an icon. */}
      <ConfirmModal
        isOpen={switchingOff !== null}
        title={`Switch off ${switchingOff?.name ?? "this API"}?`}
        message={
          <>
            Calls to <code className="text-ink">{switchingOff?.url}</code> stop being
            served from the moment you confirm. The definition is kept — Switch on,
            on the same row, puts it back — but anything polling it fails until then.
          </>
        }
        confirmLabel="Switch it off"
        danger
        busy={remove.isPending}
        error={remove.error}
        onConfirm={() => switchingOff && remove.mutate(switchingOff.slug)}
        onClose={() => setSwitchingOff(null)}
      />

      <Modal isOpen={draft !== null} onClose={close} size="5xl" scrollBehavior="inside">
        <ModalContent>
          <ModalHeader className="font-display text-lg font-bold text-ink">
            {editing == null ? "Build an API" : `Edit ${draft?.name || editing}`}
          </ModalHeader>
          <ModalBody>
            {draft && (
              <div className="space-y-4">
                {/* Inside the dialog: a banner behind an open modal is invisible, and
                    a rejected save then reads as a dead button. */}
                {save.error && <ErrorBanner error={save.error} />}
                {problem && <ErrorBanner error={problem} />}

                <Section
                  step={1}
                  title="Name it"
                  note="The name is for this screen; the address is what the application calls. The address follows the name until you type one yourself, and cannot be changed afterwards without breaking their code."
                >
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="Name" required>
                      <Input value={draft.name} placeholder="Stock on hand"
                             onChange={(e) => {
                               const name = e.target.value;
                               setDraft({
                                 ...draft,
                                 name,
                                 slug: slugTouched ? draft.slug : slugify(name),
                               });
                             }} />
                    </Field>
                    <Field label="Address" required hint="Lowercase, hyphenated.">
                      <Input value={draft.slug} placeholder="stock-on-hand"
                             onChange={(e) => {
                               setSlugTouched(true);
                               setDraft({ ...draft, slug: e.target.value });
                             }} />
                    </Field>
                  </div>
                  {draft.slug && (
                    <div className="rounded-lg bg-content2 p-2.5">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                        They will call
                      </div>
                      <code className="mt-0.5 block break-all text-xs text-ink">
                        {absoluteUrl(`/api/ext/v1/${draft.slug}`)}
                      </code>
                    </div>
                  )}
                </Section>

                <Section
                  step={2}
                  title="Choose the data"
                  note="One table to start from, and the columns it returns. Nothing you leave unticked is visible to the caller, in any response."
                >
                  <Field label="Source table" required
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
                      <ColumnPicker
                        label="Columns to expose"
                        columns={columns.data ?? []}
                        selected={draft.fields.map((f) => f.column)}
                        onToggle={toggleField}
                        onAdd={addFields}
                        onClear={() => setDraft({ ...draft, fields: [] })}
                      />

                      <div>
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                          <span className="text-sm font-medium text-body">
                            More source tables ({draft.joins.length})
                            <span className="ml-1 text-xs text-muted">
                              — optional; each joins to the base table or to another
                              already added
                            </span>
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
                            <Plus className="h-4 w-4" /> Add table
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
                          {!draft.joins.length && (
                            <p className="text-xs text-muted">
                              Add one where a column holds an id and the caller needs
                              the name behind it.
                            </p>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </Section>

                {draft.table && (
                  <>
                    <Section
                      step={3}
                      title="Limit what leaves"
                      note="A pinned filter applies to every call and cannot be overridden — this is how one application sees only its own rows."
                    >
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
                          <span className="text-xs text-muted">
                            None pinned — every row of the table is served.
                          </span>
                        )}
                      </div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
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
                    </Section>

                    <Section
                      step={4}
                      title="What the caller may ask for"
                      note="Both lists are the columns this API RETURNS, joined ones included — so a caller narrows by the name it sees, without knowing which table it came from. Leave them empty and the API simply returns everything, every time."
                    >
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div>
                          <div className="mb-1.5 text-sm font-medium text-body">
                            May filter by
                            <span className="ml-1 text-xs text-muted">
                              (?column=value)
                            </span>
                          </div>
                          <ChipToggles
                            options={exposedOptions}
                            value={draft.filterable}
                            onToggle={(name) => setDraft({
                              ...draft, filterable: toggleIn(draft.filterable, name),
                            })}
                            empty="Tick some columns above first."
                          />
                        </div>
                        <div>
                          <div className="mb-1.5 text-sm font-medium text-body">
                            Free-text search sweeps
                            <span className="ml-1 text-xs text-muted">(?search=)</span>
                          </div>
                          <ChipToggles
                            options={exposedOptions}
                            value={draft.searchable}
                            onToggle={(name) => setDraft({
                              ...draft, searchable: toggleIn(draft.searchable, name),
                            })}
                            empty="Tick some columns above first."
                          />
                        </div>
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
                    </Section>

                    <Section
                      step={5}
                      title="Order and page size"
                      note="How rows come back, and how many at a time. The maximum is the ceiling a caller can ask for — it is what stops one request pulling the whole table."
                    >
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
                    </Section>

                    <Section
                      step={6}
                      title="Check it before you publish"
                      note="Preview runs the real query and shows the first rows and the SQL. Saving publishes it — there is no separate deploy."
                    >
                      {draft.slug && (
                        <div className="rounded-lg bg-content2 p-2.5">
                          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                            The line they run
                          </div>
                          <code className="mt-0.5 block break-all text-xs text-ink">
                            {curlFor({ url: `/api/ext/v1/${draft.slug}` })}
                          </code>
                        </div>
                      )}

                      {runPreview.error && <ErrorBanner error={runPreview.error} />}

                      {preview ? (
                        <Card className="p-3">
                          <div className="mb-2 flex items-center justify-between">
                            <span className="text-sm font-medium text-body">
                              {preview.total.toLocaleString()} rows match
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
                              No rows match. The endpoint is valid — the filters are
                              simply narrower than the data.
                            </p>
                          )}
                        </Card>
                      ) : (
                        <p className="text-xs text-muted">
                          Nothing previewed yet. Press Preview below to see exactly what
                          this application would receive.
                        </p>
                      )}
                    </Section>
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
