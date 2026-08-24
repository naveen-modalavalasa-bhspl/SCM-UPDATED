import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle, CheckCircle2, ExternalLink, KeyRound, Lock, LockOpen, Mail, Pencil,
  Phone, Plus, RotateCcw, Search, ShieldCheck, Trash2, Truck, UserRound,
} from "lucide-react";
import {
  Button, Can, Card, ConfirmModal, EmptyState, ErrorBanner, Field, Input, PageHeader,
  KpiTiles, ResponsiveList, Select, StatusPill, useAction,
  type Column, type KpiTileSpec,
} from "@/shared/components";
import { fmtDate } from "@/shared/datetime";
import { logisticsVendorApi } from "../api";
import type { LogisticsVendor, LogisticsVendorInput } from "../transportTypes";

const SIZE = 20;
const KEY = ["logistics-vendors"];
const SUMMARY_KEY = ["logistics-vendors", "summary"];

/** The partner's own door. Not a second sign-in: it is the vendor account this screen
 *  mints, the same `POST /api/supplier/login` a supplier uses, landing on the carrier
 *  screens instead of the RFQ list. Named here once so the button and the sentence
 *  below it can never drift apart. */
const PORTAL_LOGIN = "/carrier/login";

/** A new tab, deliberately. The portal runs outside the employee shell on its own
 *  token, so opening it in place would drop the desk out of Settings mid-task and
 *  make them navigate back. */
const openPortal = () => window.open(PORTAL_LOGIN, "_blank", "noopener,noreferrer");

/** HeroUI derives a placeholder's colour from the theme's `foreground`, which this
 *  theme sets to near-black — so the example in an empty box ("Flipkart" under Name)
 *  reads as a value someone already typed, and the desk saves it. Grey it down to the
 *  muted token so an example looks like an example. Lands on the wrapper, so it reaches
 *  the input from there. */
const PLACEHOLDER = "[&_input]:placeholder:text-muted";

/** The colour behind each Dispatch state. `StatusPill` renders every unmapped status
 *  in grey, so READY and LOCKED OUT arrived on the row looking identical — the one
 *  column the desk actually scans carried no signal. The dot supplies it without
 *  restyling the shared pill. */
const DISPATCH_DOT: Record<string, string> = {
  READY: "bg-ok",
  "NO LOGIN": "bg-warn",
  "LOCKED OUT": "bg-bad",
  INACTIVE: "bg-neutral",
  BLACKLISTED: "bg-bad",
};

/** First letter of the partner's name, so a row is findable by shape before it is
 *  read. Falls back rather than rendering an empty circle. */
const monogram = (name: string) => name.trim().charAt(0).toUpperCase() || "?";

const BLANK: LogisticsVendorInput = {
  name: "", code: "", vendor_type: "TRANSPORT", contact_person: "", phone: "",
  email: "", city: "", state: "", gstin: "", payment_terms_days: null,
  issue_login: true, username: "",
};

/** Empty string means "say nothing about this column" — sending "" would overwrite a
 *  real value with a blank one on an edit. */
const clean = (form: LogisticsVendorInput): LogisticsVendorInput =>
  Object.fromEntries(
    Object.entries(form).map(([k, v]) => [k, v === "" ? null : v]),
  ) as LogisticsVendorInput;

/**
 * Logistics Vendors — the register behind the Dispatch dropdown.
 *
 * Everything a third-party provider needs in order to be dispatched with, on one
 * screen: the row itself, and the login they answer with. Before this, standing one
 * up meant creating a vendor in Masters, knowing that the type had to be TRANSPORT or
 * the dropdown would not show them, then walking to Supplier & Carrier Logins to mint
 * an account — and when Dispatch said "No transport vendors on the master yet",
 * nothing told you which of the three steps was missed.
 *
 * A partner IS a vendor row (`mst_vendors`), so this is not a second supplier master.
 * The portal, the password rules and the token are the ones the supplier portal
 * already uses — the only thing that differs is the door they land on: /carrier.
 *
 * "Add partner" issues the login in the same press by default. A provider with no
 * account cannot answer a quote request, and the whole point of a THIRD_PARTY
 * dispatch is that round trip.
 */
export function LogisticsVendorsPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  // Which slice of the register the KPI strip has narrowed to. Client-side over the
  // page already loaded: these are flags on the row, not parameters the list endpoint
  // takes, and inventing query params the server does not have would 422.
  const [slice, setSlice] = useState<"" | "dispatchable" | "with_login" | "without_login">("");
  const [form, setForm] = useState<LogisticsVendorInput | null>(null);
  const [editing, setEditing] = useState<LogisticsVendor | null>(null);
  const [confirmOff, setConfirmOff] = useState<LogisticsVendor | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: [...KEY, page, search],
    // active_only: a removed partner leaves the register. It was still listed, greyed
    // to INACTIVE, so pressing Remove looked like it had done nothing. The row is not
    // deleted — deactivate_partner keeps it and its shipments' history — it just stops
    // being one of the partners this screen is about.
    queryFn: () => logisticsVendorApi.list({
      page, size: SIZE, search: search.trim() || undefined, active_only: true,
    }),
  });
  const { data: summary } = useQuery({
    queryKey: SUMMARY_KEY, queryFn: logisticsVendorApi.summary,
  });
  const { data: types = [] } = useQuery({
    queryKey: ["logistics-vendor-types"], queryFn: logisticsVendorApi.types,
  });

  // What the register shows, once the KPI strip has had its say. The tiles keep
  // counting the SUMMARY, which is the whole register rather than this page, so
  // pressing one never changes the number printed on it.
  const visible = (data?.items ?? []).filter((row) => {
    if (slice === "dispatchable") return Boolean(row.dispatchable);
    if (slice === "with_login") return Boolean(row.has_login);
    if (slice === "without_login") return !row.has_login;
    return true;
  });

  const invalidates = [KEY, SUMMARY_KEY, ["transport-carriers"]];
  const close = () => { setForm(null); setEditing(null); };

  const save = useAction({
    run: (body: LogisticsVendorInput) =>
      editing
        ? logisticsVendorApi.update(editing.id, clean(body))
        : logisticsVendorApi.create(clean(body)),
    success: (row) => editing
      ? `${row.name} updated`
      : row.has_login
        ? `${row.name} added — they sign in as ${row.username} with Bavya@123`
        : `${row.name} added. Issue a login before sending them a quote request.`,
    invalidates,
    onDone: close,
  });

  const issue = useAction({
    run: (row: LogisticsVendor) => logisticsVendorApi.issueLogin(row.id),
    success: (row) => `${row.name} signs in as ${row.username} with Bavya@123`,
    invalidates,
  });
  const reset = useAction({
    run: (row: LogisticsVendor) => logisticsVendorApi.resetLogin(row.id),
    success: (row) => `${row.name}'s password is back to Bavya@123`,
    invalidates,
  });
  const toggleLogin = useAction({
    run: (row: LogisticsVendor) =>
      logisticsVendorApi.setLoginActive(row.id, !row.login_is_active),
    success: (row) =>
      row.login_is_active ? `${row.name} can sign in` : `${row.name} is locked out`,
    invalidates,
  });
  const deactivate = useAction({
    run: (row: LogisticsVendor) => logisticsVendorApi.deactivate(row.id),
    success: (row) => `${row.name} is no longer offered on Dispatch`,
    invalidates,
    onDone: () => setConfirmOff(null),
  });

  const busy = save.isPending || issue.isPending || reset.isPending
    || toggleLogin.isPending || deactivate.isPending;

  const openEdit = (row: LogisticsVendor) => {
    setEditing(row);
    setForm({
      name: row.name, code: row.code ?? "", vendor_type: row.vendor_type,
      contact_person: row.contact_person ?? "", phone: row.phone ?? "",
      email: row.email ?? "", city: row.city ?? "", state: row.state ?? "",
      gstin: row.gstin ?? "", payment_terms_days: row.payment_terms_days ?? null,
    });
  };

  const set = (patch: Partial<LogisticsVendorInput>) =>
    setForm((f) => (f ? { ...f, ...patch } : f));

  /** What Dispatch will do with this row, said once so the table and the cards agree. */
  const dispatchState = (row: LogisticsVendor) =>
    !row.is_active ? "INACTIVE"
      : row.is_blacklisted ? "BLACKLISTED"
        : !row.has_login ? "NO LOGIN"
          : row.login_is_active ? "READY" : "LOCKED OUT";

  /** The partner's identity, given a face. A wall of same-weight names is slow to
   *  scan; the monogram gives each row an anchor the eye can return to. */
  const partnerCell = (row: LogisticsVendor) => (
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

  const loginCell = (row: LogisticsVendor) => (
    <div className="min-w-0">
      {row.has_login ? (
        <>
          {/* The username is the thing that gets typed into the portal, so it is
              chipped like a credential rather than left as loose text. */}
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
            {row.must_change_password ? "Default password — not yet changed"
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

  const stateCell = (row: LogisticsVendor) => {
    const state = dispatchState(row);
    return (
      <span className="inline-flex items-center gap-2">
        <span aria-hidden
          className={`h-2 w-2 shrink-0 rounded-full ${DISPATCH_DOT[state] ?? "bg-neutral"}`} />
        <StatusPill status={state} />
      </span>
    );
  };

  /* One row, one line. Four full-width buttons did not fit the column, so the set
   * broke and Remove dropped underneath the others — the ragged look. The labels and
   * the handlers are untouched; the padding is tightened and Remove gives back the
   * ~70px it was spending on a word and a filled box. `className` reaches HeroUI
   * through tailwind-variants, which twMerges it, so `px-3` replaces its `px-4`
   * rather than layering on top of it.
   *
   * Wrapping is still allowed under 768px, where the same buttons render inside a
   * phone card and a single line is not physically possible. */
  const ROW_BTN = "px-3 whitespace-nowrap";

  const actions = (row: LogisticsVendor) => (
    <div className="flex flex-wrap items-center gap-1.5 md:flex-nowrap md:justify-end">
      <Can do="logistics.partner.manage">
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
          // the icon rather than the button, so it cannot be overridden by the
          // variant's own text colour.
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

  const columns: Column<LogisticsVendor>[] = [
    { key: "name", header: "Partner", render: partnerCell },
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
    { key: "state", header: "On Dispatch", render: stateCell },
    { key: "actions", header: "", render: actions },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Settings"
        title="Logistics Vendors"
        actions={
          <>
            {/* Not gated on `partner.manage`: opening the partners' own login is not
                an act on the register, and the desk that only watches the list still
                needs it to check a partner can actually get in. */}
            <Button variant="subtle" onClick={openPortal}>
              <ExternalLink className="mr-1 h-4 w-4" /> Partner login
            </Button>
            <Can do="logistics.partner.manage">
              <Button onClick={() => { setEditing(null); setForm({ ...BLANK }); }}>
                <Plus className="mr-1 h-4 w-4" /> Add partner
              </Button>
            </Can>
          </>
        }
      />

      {/* The same sentence, given a frame. Loose on the background it read as filler
          above the numbers; on its own panel with the module's mark it reads as the
          screen's brief. */}
      <Card className="mb-4 overflow-hidden">
        <div className="flex gap-3 border-l-[3px] border-brand p-4 sm:gap-4 sm:p-5">
          <span className="mt-0.5 hidden h-9 w-9 shrink-0 items-center justify-center
                           rounded-xl bg-brand-050 text-brand sm:flex">
            <Truck className="h-4.5 w-4.5" />
          </span>
          <p className="max-w-3xl text-sm leading-relaxed text-muted">
            The third-party providers that carry our consignments — Amazon, Flipkart,
            Alibaba, Misaba, a local truck operator. Everyone listed here as{" "}
            <b className="text-body">Ready</b> appears in the{" "}
            <b className="text-body">Logistics partner</b> dropdown on Dispatch, and
            signs in at{" "}
            <a href={PORTAL_LOGIN} target="_blank" rel="noopener noreferrer"
              className="rounded-md bg-brand-050 px-1.5 py-0.5 font-mono text-xs
                         font-semibold text-brand transition-colors hover:bg-brand-050/70">
              /carrier
            </a>{" "}
            — the same account this screen issues — to price the job, accept it and
            report it delivered. <b className="text-body">Partner login</b> above opens
            that door.
          </p>
        </div>
      </Card>

      <ErrorBanner error={error ?? save.error ?? issue.error ?? reset.error
        ?? toggleLogin.error ?? deactivate.error} />

      {/* Four identical grey numbers said nothing about which one mattered. Each tile
          carries its own mark and colour, the last only turns amber when there is
          something to chase, and every one of them now narrows the register to the
          partners it counted — "3 awaiting a login" is read and acted on in the same
          breath. "Partners" is the whole register and clears the others. */}
      <KpiTiles label="Partner summary" className="mb-4" tiles={[
        {
          key: "total", label: "Partners", value: summary?.total, icon: Truck,
          tone: "brand", active: slice === "",
          hint: "Every active partner. Press to clear the tile filters.",
          onPress: () => { setSlice(""); setPage(1); },
        },
        {
          key: "dispatchable", label: "Offered on Dispatch", value: summary?.dispatchable,
          icon: CheckCircle2, tone: "ok", active: slice === "dispatchable",
          onPress: () => {
            setSlice((on) => (on === "dispatchable" ? "" : "dispatchable")); setPage(1);
          },
        },
        {
          key: "with_login", label: "Can sign in", value: summary?.with_login,
          icon: ShieldCheck, tone: "info", active: slice === "with_login",
          onPress: () => {
            setSlice((on) => (on === "with_login" ? "" : "with_login")); setPage(1);
          },
        },
        // The one that costs a day: a partner is on the dropdown, gets sent a job, and
        // has no way to answer it.
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
          empty="No logistics vendors yet — add the providers you ship with."
          renderCard={(r) => (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-2">
                {partnerCell(r)}
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
            title="Dispatch has nobody to offer"
            hint="Until a partner is listed here, the Logistics partner dropdown on
                  Confirm dispatch stays empty and a third-party consignment cannot be
                  sent for a price."
            action={
              <Can do="logistics.partner.manage">
                <Button onClick={() => { setEditing(null); setForm({ ...BLANK }); }}>
                  <Truck className="mr-1 h-4 w-4" /> Add the first partner
                </Button>
              </Can>
            }
          />
        </div>
      )}

      {/* Add / edit. One dialog: the fields are the same, and only the login block
          differs — an existing partner's account is run from its own row. */}
      <ConfirmModal
        isOpen={form !== null}
        title={editing ? `Edit ${editing.name}` : "Add a logistics vendor"}
        confirmLabel={editing ? "Save" : "Add partner"}
        busy={save.isPending}
        confirmDisabled={!form?.name?.trim()}
        error={save.error}
        onConfirm={() => form && save.mutate(form)}
        onClose={close}
      >
        {form && (
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field label="Name" hint="What the desk will see on Dispatch">
              <Input value={form.name}
                onChange={(e) => set({ name: e.target.value })}
                className={PLACEHOLDER}
                placeholder="Flipkart" />
            </Field>
            <Field label="Type">
              <Select
                value={form.vendor_type}
                onChange={(value) => set({ vendor_type: value })}
                options={types.map((t) => ({ value: t.value, label: t.label }))}
                ariaLabel="Logistics vendor type"
              />
            </Field>
            {!editing && (
              <Field label="Code" hint="Left blank, one is derived from the name">
                <Input value={form.code ?? ""}
                  onChange={(e) => set({ code: e.target.value })}
                  className={PLACEHOLDER}
                  placeholder="LGV-FLIPKART" />
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
                  They sign in at <span className="font-mono">/carrier</span> with the
                  shared password <b>Bavya@123</b> and must change it before anything
                  is shown. Without an account they cannot answer a quote request.
                </p>
                {(form.issue_login ?? true) && (
                  <div className="mt-3">
                    <Field label="Username"
                      hint="Blank uses the partner code">
                      <Input value={form.username ?? ""}
                        onChange={(e) => set({ username: e.target.value })}
                        className={PLACEHOLDER}
                        placeholder="flipkart" />
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
        title={`Remove ${confirmOff?.name ?? ""} from Dispatch?`}
        message="They stop being offered as a provider and their portal login is
                 disabled. Shipments they already carry keep their name and their
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
