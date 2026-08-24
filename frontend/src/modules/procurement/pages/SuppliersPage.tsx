import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle, CheckCircle2, ExternalLink, KeyRound, Lock, LockOpen, Mail, Pencil,
  Phone, Plus, RotateCcw, Search, ShieldCheck, Store, Trash2, UserRound,
} from "lucide-react";
import {
  Button, Can, Card, ConfirmModal, EmptyState, ErrorBanner, Field, Input, PageHeader,
  KpiTiles, ResponsiveList, Select, StatusPill, useAction,
  type Column, type KpiTileSpec,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { supplierRegisterApi } from "../api";
import type { Supplier, SupplierInput } from "../types";

const SIZE = 20;
const KEY = ["suppliers"];
const SUMMARY_KEY = ["suppliers", "summary"];

/** The supplier's own door — the same `POST /api/supplier/login` this screen's account
 *  answers with, landing on the RFQ list instead of the carrier board. Named once so
 *  the button and the sentence under it can never drift apart. */
const PORTAL_LOGIN = "/supplier/login";

/** The shared first password every vendor account is minted with, server-side
 *  (`DEFAULT_VENDOR_PASSWORD`). Printed here because a desk that issues a login has to
 *  be able to tell the supplier what to type. */
const DEFAULT_PASSWORD = "Bavya@123";

/** A new tab, deliberately: the portal runs outside the employee shell on its own
 *  token, so opening it in place would drop the buyer out of Procurement mid-task. */
const openPortal = () => window.open(PORTAL_LOGIN, "_blank", "noopener,noreferrer");

/** HeroUI paints placeholders in the theme's near-black `foreground`, so an example
 *  reads as a value someone already typed. Grey it to the muted token. */
const PLACEHOLDER = "[&_input]:placeholder:text-muted";

/** The colour behind each state. `StatusPill` renders anything unmapped in grey, so
 *  READY and LOCKED OUT would arrive looking identical in the one column the desk
 *  actually scans. */
const STATE_DOT: Record<string, string> = {
  READY: "bg-ok",
  "NO LOGIN": "bg-warn",
  "LOCKED OUT": "bg-bad",
  "NOT APPROVED": "bg-warn",
  INACTIVE: "bg-neutral",
  BLACKLISTED: "bg-bad",
};

const monogram = (name: string) => name.trim().charAt(0).toUpperCase() || "?";

const BLANK: SupplierInput = {
  name: "", code: "", vendor_type: "MATERIAL", contact_person: "", phone: "",
  email: "", city: "", state: "", gstin: "", payment_terms_days: null,
  issue_login: true, username: "",
};

/** Empty string means "say nothing about this column" — sending "" would overwrite a
 *  real value with a blank one on an edit. */
const clean = (form: SupplierInput): SupplierInput =>
  Object.fromEntries(
    Object.entries(form).map(([k, v]) => [k, v === "" ? null : v]),
  ) as SupplierInput;

/**
 * Suppliers — the register behind every RFQ, and the door each supplier signs in at.
 *
 * The material twin of Logistics Vendors, and deliberately the same screen: a
 * supplier IS a `mst_vendors` row, and their portal account is the same
 * `pro_vendor_users` row a carrier gets. What this adds is the thing Masters cannot
 * say — whether the vendor you just created can actually GET IN. A supplier with a row
 * and no account is on every picker, gets sent a quote request, and is told their
 * username is wrong; nothing anywhere flagged it until the tender came back empty.
 *
 * "Add supplier" issues the login in the same press by default, and every existing
 * supplier can be given one from its own row — which is the whole reason this screen
 * exists rather than a note in the handover doc.
 *
 * Approval is NOT here. `is_approved` is procurement's commercial gate on the vendor
 * master; this screen reports it (the NOT APPROVED state) and never sets it.
 */
export function SuppliersPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  // Which slice the KPI strip has narrowed to. Client-side over the page already
  // loaded: these are flags on the row, not parameters the list endpoint takes, and
  // inventing query params the server does not have would 422.
  const [slice, setSlice] = useState<"" | "quotable" | "with_login" | "without_login">("");
  const [form, setForm] = useState<SupplierInput | null>(null);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [confirmOff, setConfirmOff] = useState<Supplier | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: [...KEY, page, search],
    // active_only: a removed supplier leaves the register rather than sitting in it
    // greyed out, where pressing Remove looks like it did nothing. The row is not
    // deleted — its RFQs, quotes and orders keep their vendor.
    queryFn: () => supplierRegisterApi.list({
      page, size: SIZE, search: search.trim() || undefined, active_only: true,
    }),
  });
  const { data: summary } = useQuery({
    queryKey: SUMMARY_KEY, queryFn: supplierRegisterApi.summary,
  });
  const { data: types = [] } = useQuery({
    queryKey: ["supplier-types"], queryFn: supplierRegisterApi.types,
  });

  // What the register shows once the tiles have had their say. The tiles keep counting
  // the SUMMARY — the whole register, not this page — so pressing one never changes
  // the number printed on it.
  const visible = (data?.items ?? []).filter((row) => {
    if (slice === "quotable") return Boolean(row.quotable);
    if (slice === "with_login") return Boolean(row.has_login);
    if (slice === "without_login") return !row.has_login;
    return true;
  });

  const invalidates = [KEY, SUMMARY_KEY, ["vendors"]];
  const close = () => { setForm(null); setEditing(null); };

  const save = useAction({
    run: (body: SupplierInput) =>
      editing
        ? supplierRegisterApi.update(editing.id, clean(body))
        : supplierRegisterApi.create(clean(body)),
    success: (row) => editing
      ? `${row.name} updated`
      : row.has_login
        ? `${row.name} added — they sign in as ${row.username} with ${DEFAULT_PASSWORD}`
        : `${row.name} added. Issue a login before sending them an RFQ.`,
    invalidates,
    onDone: close,
  });

  const issue = useAction({
    run: (row: Supplier) => supplierRegisterApi.issueLogin(row.id),
    success: (row) =>
      `${row.name} signs in as ${row.username} with ${DEFAULT_PASSWORD}`,
    invalidates,
  });
  const reset = useAction({
    run: (row: Supplier) => supplierRegisterApi.resetLogin(row.id),
    success: (row) => `${row.name}'s password is back to ${DEFAULT_PASSWORD}`,
    invalidates,
  });
  const toggleLogin = useAction({
    run: (row: Supplier) => supplierRegisterApi.setLoginActive(row.id, !row.login_is_active),
    success: (row) =>
      row.login_is_active ? `${row.name} can sign in` : `${row.name} is locked out`,
    invalidates,
  });
  const deactivate = useAction({
    run: (row: Supplier) => supplierRegisterApi.deactivate(row.id),
    success: (row) => `${row.name} is no longer offered on RFQs`,
    invalidates,
    onDone: () => setConfirmOff(null),
  });

  const busy = save.isPending || issue.isPending || reset.isPending
    || toggleLogin.isPending || deactivate.isPending;

  const openEdit = (row: Supplier) => {
    setEditing(row);
    setForm({
      name: row.name, code: row.code ?? "", vendor_type: row.vendor_type,
      contact_person: row.contact_person ?? "", phone: row.phone ?? "",
      email: row.email ?? "", city: row.city ?? "", state: row.state ?? "",
      gstin: row.gstin ?? "", payment_terms_days: row.payment_terms_days ?? null,
    });
  };

  const set = (patch: Partial<SupplierInput>) =>
    setForm((f) => (f ? { ...f, ...patch } : f));

  /** What buying will do with this row, said once so the table and the cards agree.
   *  Approval before login on purpose: an unapproved supplier cannot be sent an RFQ
   *  whether or not they can sign in, so that is the fact the column should carry. */
  const state = (row: Supplier) =>
    !row.is_active ? "INACTIVE"
      : row.is_blacklisted ? "BLACKLISTED"
        : !row.is_approved ? "NOT APPROVED"
          : !row.has_login ? "NO LOGIN"
            : row.login_is_active ? "READY" : "LOCKED OUT";

  const supplierCell = (row: Supplier) => (
    <div className="flex min-w-0 items-center gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full
                       bg-brand-050 font-display text-sm font-bold text-brand">
        {monogram(row.name)}
      </span>
      <div className="min-w-0">
        <span className="block truncate text-sm font-semibold text-ink">{row.name}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
          <span className="truncate font-mono">{row.code ?? "—"}</span>
          <span aria-hidden className="text-line">•</span>
          <span className="truncate uppercase tracking-wide">{row.vendor_type}</span>
        </span>
      </div>
    </div>
  );

  const loginCell = (row: Supplier) => (
    <div className="min-w-0">
      {row.has_login ? (
        <>
          {/* The username is what gets typed into the portal, so it is chipped like a
              credential rather than left as loose text. */}
          <span className="inline-flex max-w-full items-center gap-1.5 rounded-md
                           bg-content2 px-2 py-1">
            {row.login_is_active
              ? <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-ok" />
              : <Lock className="h-3.5 w-3.5 shrink-0 text-bad" />}
            <span className="truncate font-mono text-xs font-semibold text-ink">
              {row.username}
            </span>
          </span>
          <span className="mt-1 block truncate text-[11px] text-muted">
            {row.must_change_password ? `Default password (${DEFAULT_PASSWORD})`
              : row.last_login_at ? `Last in ${fmtDate(row.last_login_at)}`
                : "Password set, never signed in"}
          </span>
        </>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-warn">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> No login yet
        </span>
      )}
    </div>
  );

  const stateCell = (row: Supplier) => {
    const s = state(row);
    return (
      <span className="inline-flex items-center gap-2">
        <span aria-hidden
          className={`h-2 w-2 shrink-0 rounded-full ${STATE_DOT[s] ?? "bg-neutral"}`} />
        <StatusPill status={s} />
      </span>
    );
  };

  /* One row, one line: four full-width buttons do not fit the column. Wrapping is
   * still allowed under 768px, where these render inside a phone card. */
  const ROW_BTN = "px-3 whitespace-nowrap";

  const actions = (row: Supplier) => (
    <div className="flex flex-wrap items-center gap-1.5 md:flex-nowrap md:justify-end">
      <Can do="vendor.portal.manage">
        <Button variant="subtle" className={ROW_BTN} disabled={busy}
          onClick={() => openEdit(row)}>
          <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
        </Button>
        {row.has_login ? (
          <>
            <Button variant="ghost" className={ROW_BTN} disabled={busy}
              onClick={() => reset.mutate(row)}>
              <RotateCcw className="mr-1 h-3.5 w-3.5" /> Reset password
            </Button>
            <Button variant="ghost" className={ROW_BTN} disabled={busy}
              onClick={() => toggleLogin.mutate(row)}>
              {row.login_is_active
                ? <><Lock className="mr-1 h-3.5 w-3.5" /> Disable login</>
                : <><LockOpen className="mr-1 h-3.5 w-3.5" /> Enable login</>}
            </Button>
          </>
        ) : (
          <Button variant="soft" className={ROW_BTN} disabled={busy}
            onClick={() => issue.mutate(row)}>
            <KeyRound className="mr-1 h-3.5 w-3.5" /> Issue login
          </Button>
        )}
        {row.is_active && (
          // The bare symbol: no box, no label, square tap target. The colour sits on
          // the icon rather than the button, so the variant cannot override it.
          <span title="Remove" className="inline-flex">
            <Button variant="ghost"
              className="w-11 min-w-11 px-0 data-[hover=true]:bg-bad-bg"
              disabled={busy} onClick={() => setConfirmOff(row)}>
              <Trash2 className="h-4 w-4 text-bad" />
              <span className="sr-only">Remove</span>
            </Button>
          </span>
        )}
      </Can>
    </div>
  );

  const columns: Column<Supplier>[] = [
    { key: "name", header: "Supplier", render: supplierCell },
    {
      key: "contact",
      header: "Contact",
      hideOnNarrow: true,
      render: (r) => (
        <div className="min-w-0 space-y-1 text-xs">
          <span className="flex items-center gap-1.5 text-ink">
            <UserRound className="h-3.5 w-3.5 shrink-0 text-muted" />
            <span className="truncate">{r.contact_person ?? "—"}</span>
          </span>
          <span className="flex items-center gap-1.5 text-muted">
            {r.phone
              ? <Phone className="h-3.5 w-3.5 shrink-0" />
              : <Mail className="h-3.5 w-3.5 shrink-0" />}
            <span className="truncate">{r.phone ?? r.email ?? "—"}</span>
          </span>
        </div>
      ),
    },
    { key: "login", header: "Portal login", render: loginCell },
    { key: "state", header: "On RFQs", render: stateCell },
    { key: "actions", header: "", render: actions },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Procurement"
        title="Suppliers"
        actions={
          <>
            {/* Not gated on manage: opening the suppliers' own door is not an act on
                the register, and checking that a vendor can actually get in is exactly
                what the desk comes here to do. */}
            <Button variant="subtle" onClick={openPortal}>
              <ExternalLink className="mr-1 h-4 w-4" /> Supplier login
            </Button>
            <Can do="vendor.portal.manage">
              <Button onClick={() => { setEditing(null); setForm({ ...BLANK }); }}>
                <Plus className="mr-1 h-4 w-4" /> Add supplier
              </Button>
            </Can>
          </>
        }
      />

      <Card className="mb-4 overflow-hidden">
        <div className="flex gap-3 border-l-[3px] border-brand p-4 sm:gap-4 sm:p-5">
          <span className="mt-0.5 hidden h-9 w-9 shrink-0 items-center justify-center
                           rounded-xl bg-brand-050 text-brand sm:flex">
            <Store className="h-4.5 w-4.5" />
          </span>
          <p className="max-w-3xl text-sm leading-relaxed text-muted">
            The vendors we buy material from, and the login each one answers an RFQ
            with. A supplier reading <b className="text-body">Ready</b> is approved,
            active and able to sign in at{" "}
            <a href={PORTAL_LOGIN} target="_blank" rel="noopener noreferrer"
              className="rounded-md bg-brand-050 px-1.5 py-0.5 font-mono text-xs
                         font-semibold text-brand transition-colors hover:bg-brand-050/70">
              /supplier
            </a>{" "}
            to price the job, accept the order and raise a despatch note. Approving a
            supplier commercially stays on the vendor master — this screen reports it.
          </p>
        </div>
      </Card>

      <ErrorBanner error={error ?? save.error ?? issue.error ?? reset.error
        ?? toggleLogin.error ?? deactivate.error} />

      {/* Each tile narrows the register to what it counted, so "3 awaiting a login" is
          read and acted on in the same breath. "Suppliers" clears the others. */}
      <KpiTiles label="Supplier summary" className="mb-4" tiles={[
        {
          key: "total", label: "Suppliers", value: summary?.total, icon: Store,
          tone: "brand", active: slice === "",
          hint: "Every active supplier. Press to clear the tile filters.",
          onPress: () => { setSlice(""); setPage(1); },
        },
        {
          key: "quotable", label: "Can be sent an RFQ", value: summary?.quotable,
          icon: CheckCircle2, tone: "ok", active: slice === "quotable",
          onPress: () => {
            setSlice((on) => (on === "quotable" ? "" : "quotable")); setPage(1);
          },
        },
        {
          key: "with_login", label: "Can sign in", value: summary?.with_login,
          icon: ShieldCheck, tone: "info", active: slice === "with_login",
          onPress: () => {
            setSlice((on) => (on === "with_login" ? "" : "with_login")); setPage(1);
          },
        },
        // The one that costs a tender: a supplier is on the picker, gets sent an RFQ,
        // and has no way to answer it.
        {
          key: "without_login", label: "Awaiting a login", value: summary?.without_login,
          icon: AlertTriangle, tone: summary?.without_login ? "warn" : "neutral",
          active: slice === "without_login",
          onPress: () => {
            setSlice((on) => (on === "without_login" ? "" : "without_login")); setPage(1);
          },
        },
      ] satisfies KpiTileSpec[]} />

      <Card className="mb-4 p-3">
        <div className="relative">
          {/* z-10: HeroUI's input wrapper paints its own background over the box. */}
          <Search className="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4
                             -translate-y-1/2 text-muted" />
          <Input
            className={`${PLACEHOLDER} [&_input]:pl-7`}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search by name, code or city…"
          />
        </div>
      </Card>

      <Card className="p-2">
        <ResponsiveList
          data={visible}
          columns={columns}
          keyOf={(r) => r.id}
          loading={isLoading}
          page={page}
          totalPages={Math.max(1, Math.ceil((data?.total ?? 0) / SIZE))}
          onPageChange={setPage}
          empty="No suppliers yet — add the vendors you buy from."
          renderCard={(r) => (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-2">
                {supplierCell(r)}
                {stateCell(r)}
              </div>
              <div className="border-t border-line/70 pt-3">{loginCell(r)}</div>
              {actions(r)}
            </div>
          )}
        />
      </Card>

      {!isLoading && !(data?.items ?? []).length && !search && (
        <div className="mt-4">
          <EmptyState
            title="No suppliers on the register"
            hint="Until a vendor is listed here, an RFQ has nobody to go to — and a
                  supplier without a login cannot answer one even after it is sent."
            action={
              <Can do="vendor.portal.manage">
                <Button onClick={() => { setEditing(null); setForm({ ...BLANK }); }}>
                  <Store className="mr-1 h-4 w-4" /> Add the first supplier
                </Button>
              </Can>
            }
          />
        </div>
      )}

      {/* Add / edit. One dialog: the fields are the same, and only the login block
          differs — an existing supplier's account is run from its own row. */}
      <ConfirmModal
        isOpen={form !== null}
        title={editing ? `Edit ${editing.name}` : "Add a supplier"}
        confirmLabel={editing ? "Save" : "Add supplier"}
        busy={save.isPending}
        confirmDisabled={!form?.name?.trim()}
        error={save.error}
        onConfirm={() => form && save.mutate(form)}
        onClose={close}
      >
        {form && (
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field label="Name" hint="What the buyer will see on an RFQ">
              <Input value={form.name}
                onChange={(e) => set({ name: e.target.value })}
                className={PLACEHOLDER}
                placeholder="3M India" />
            </Field>
            <Field label="Type">
              <Select
                value={form.vendor_type}
                onChange={(value) => set({ vendor_type: value })}
                options={types.map((t) => ({ value: t.value, label: t.label }))}
                ariaLabel="Supplier type"
              />
            </Field>
            {!editing && (
              <Field label="Code" hint="Left blank, one is derived from the name">
                <Input value={form.code ?? ""}
                  onChange={(e) => set({ code: e.target.value })}
                  className={PLACEHOLDER}
                  placeholder="SUP-3MINDIA" />
              </Field>
            )}
            <Field label="Contact person">
              <Input value={form.contact_person ?? ""}
                onChange={(e) => set({ contact_person: e.target.value })} />
            </Field>
            <Field label="Phone">
              <Input value={form.phone ?? ""}
                onChange={(e) => set({ phone: e.target.value })} />
            </Field>
            <Field label="Email">
              <Input type="email" value={form.email ?? ""}
                onChange={(e) => set({ email: e.target.value })} />
            </Field>
            <Field label="City">
              <Input value={form.city ?? ""}
                onChange={(e) => set({ city: e.target.value })} />
            </Field>
            <Field label="State">
              <Input value={form.state ?? ""}
                onChange={(e) => set({ state: e.target.value })} />
            </Field>
            <Field label="GSTIN">
              <Input value={form.gstin ?? ""}
                onChange={(e) => set({ gstin: e.target.value.toUpperCase() })} />
            </Field>
            <Field label="Payment terms (days)">
              <Input type="number" min={0} max={365}
                value={form.payment_terms_days ?? ""}
                onChange={(e) => set({
                  payment_terms_days: e.target.value === ""
                    ? null : Number(e.target.value),
                })} />
            </Field>

            {!editing && (
              <div className="sm:col-span-2 rounded-xl border border-line bg-surface-2 p-3">
                <label className="flex min-h-11 items-center gap-3 text-sm text-ink">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={form.issue_login ?? true}
                    onChange={(e) => set({ issue_login: e.target.checked })}
                  />
                  Give them a portal login now
                </label>
                <p className="mt-1 text-xs text-muted">
                  They sign in at <span className="font-mono">/supplier</span> with the
                  shared password <b>{DEFAULT_PASSWORD}</b> and must change it before
                  anything is shown — an RFQ carries prices. A new supplier still has
                  to be approved on the vendor master before an RFQ can be sent.
                </p>
                {(form.issue_login ?? true) && (
                  <div className="mt-3">
                    <Field label="Username" hint="Blank uses the supplier code">
                      <Input value={form.username ?? ""}
                        onChange={(e) => set({ username: e.target.value })}
                        className={PLACEHOLDER}
                        placeholder="sup-3mindia" />
                    </Field>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </ConfirmModal>

      <ConfirmModal
        isOpen={confirmOff !== null}
        title={`Remove ${confirmOff?.name ?? ""} from the register?`}
        message="They stop being offered on RFQs and their portal login is disabled.
                 Orders and quotations they already hold keep their name and their
                 history — nothing is deleted."
        confirmLabel="Remove"
        danger
        busy={deactivate.isPending}
        error={deactivate.error}
        onConfirm={() => confirmOff && deactivate.mutate(confirmOff)}
        onClose={() => setConfirmOff(null)}
      />
    </div>
  );
}
