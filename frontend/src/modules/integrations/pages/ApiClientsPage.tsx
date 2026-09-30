import { useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Activity, Boxes, Columns3, MonitorSmartphone, Plug, Plus, Radio, Server, ShieldCheck,
  Stethoscope,
} from "lucide-react";
import {
  Button, EmptyState, ErrorBanner, FilterBar, PageHeader, ResponsiveList,
  SubNav, type Column,
} from "@/shared/components";
import { fmtDateTime, fmtRelative } from "@/shared/datetime";
import { integrationsApi } from "../api";
import { ActivityLog } from "../components/ActivityLog";
import { AimsPanel } from "../components/AimsPanel";
import { CamsPanel } from "../components/CamsPanel";
import { ClientFormModal } from "../components/ClientFormModal";
import { FlowExplainer } from "../components/Explain";
import { HealthPill, healthOf } from "../components/Health";
import { WebhooksPanel, type WebhooksPanelHandle } from "../components/WebhooksPanel";
import type { ApiClient } from "../types";

/** Out and in. Applications PULL from SCM through composed endpoints; webhooks are
 *  systems that PUSH into it. Same screen because they are the same question — who is
 *  connected, and on what terms.
 *
 *  B-CAMS is the third answer to that question and cannot be either of the first two:
 *  it pushes AND pulls, and two of the five things it pushes deduct stock, which no
 *  registered webhook may ever do. It is a hand-written adapter, so it gets its own
 *  tab rather than a row on one of theirs — but the same furniture, in the same order,
 *  because it is still "who is connected, and on what terms".
 *
 *  The last tab is the answer to the question the other three raise and never settle:
 *  it is connected, but is it WORKING. It spans all of them, because a partner going
 *  live reads from us and pushes to us on the same afternoon and the halves of that
 *  story were on different screens. */
const TABS = [
  { key: "clients", label: "Applications", icon: Plug },
  { key: "webhooks", label: "Webhooks", icon: Radio },
  { key: "cams", label: "B-CAMS", icon: Stethoscope },
  { key: "aims", label: "AIMS", icon: Boxes },
  { key: "activity", label: "Activity log", icon: Activity },
];

/** Our end of every wire on this screen, written once. Both diagrams draw SCM in the
 *  same place with the same words, so the only thing that changes between the tabs is
 *  the direction the packets run — which is the one fact the tabs differ on. */
const SCM_END = {
  icon: Server,
  label: "SCM",
  note: "this ERP — stock, indents, POs",
};

/** The order the work happens in, said once on the screen where the work starts.
 *  A row registered here is inert until both of the other two exist — which is what
 *  the "Not usable yet" pill on the list is reporting. */
const SETUP: { title: string; note: string }[] = [
  { title: "Register the application",
    note: "Name the outside system and who owns it." },
  { title: "Build the APIs it may call",
    note: "Pick a table, tick the columns it may read. Nothing else is visible to it." },
  { title: "Issue a key",
    note: "Send them the key and the connection details. They can start calling." },
];

/** The same three, said the same way, for the other direction. The push side is set
 *  up in exactly as many moves as the pull side, and until all three are done the row
 *  reads "Not usable yet" for the same reason — but the screen had never said so, and
 *  a webhook registered with no secret simply refused every push in silence. */
const WEBHOOK_SETUP: { title: string; note: string }[] = [
  { title: "Register the webhook",
    note: "Name the sending system and the events it may send. Anything else is refused." },
  { title: "Issue its signing secret",
    note: "They sign every body with it. It is shown once and never again." },
  { title: "Send them the address",
    note: "Connection details writes out the URL, the headers and a worked example." },
];

/** And the third, which is three moves for the same reason — except that step one is
 *  already done for you here. The adapter is code, so there is nothing to register:
 *  what is left is the key, the secret and the address. */
const CAMS_SETUP: { title: string; note: string }[] = [
  { title: "Issue them an API key",
    note: "On the Applications tab, against their application. Its scopes must be empty or include `cams`." },
  { title: "Issue the shared secret",
    note: "They sign every body with it. It is shown once and never again." },
  { title: "Send them the address",
    note: "Connection details writes out the five endpoints, the headers and a worked example." },
];

/**
 * The applications SCM serves. One row each, with enough on the row to answer "is this
 * integration alive?" without opening it — which is a different question from whether
 * an admin has switched the record on, and the two were being answered by the same
 * green pill. See `components/Health.tsx`.
 */
export default function ApiClientsPage() {
  const navigate = useNavigate();
  // The open tab lives in the URL, not only in state: a webhook and an application
  // both open onto their own page, and coming back has to land on the half of this
  // screen the reader left — otherwise closing a webhook drops them on Applications.
  const [params, setParams] = useSearchParams();
  const requestedTab = params.get("tab") ?? "clients";
  const tab = TABS.some((item) => item.key === requestedTab) ? requestedTab : "clients";
  const setTab = (next: string) => setParams(
    next === "clients" ? {} : { tab: next }, { replace: true },
  );
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [registering, setRegistering] = useState(false);
  // The webhooks tab's create button belongs in the PageHeader beside the
  // applications one — a create action never sits inside the list it creates into.
  // The panel owns the dialog, so the header presses this.
  const webhooks = useRef<WebhooksPanelHandle>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["apis", "clients", { page, search }],
    queryFn: () => integrationsApi.listClients({ page, size: 20, search }),
  });

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / (data?.size || 20)));

  const columns: Column<ApiClient>[] = [
    {
      key: "code",
      // The NAME is what a person knows this integration by; the code is the address
      // it is filed under. The row led with the code, which reads as a filing
      // reference and told the reader nothing they came to find out.
      header: "Application",
      render: (row) => (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-ink">{row.name}</span>
            <code className="rounded bg-content2 px-1.5 py-0.5 text-[11px] text-muted">
              {row.code}
            </code>
          </div>
          {row.description && (
            <div className="mt-0.5 truncate text-xs text-muted">{row.description}</div>
          )}
        </div>
      ),
    },
    {
      key: "surface",
      header: "What it can reach",
      render: (row) => (
        <div className="text-sm">
          <div className="text-ink">
            {row.endpoints} {row.endpoints === 1 ? "API" : "APIs"}
          </div>
          <div className="text-xs text-muted">
            {row.active_keys} active {row.active_keys === 1 ? "key" : "keys"}
          </div>
        </div>
      ),
    },
    {
      key: "last_called",
      // "Seen", not "called": the stamp comes from an in-memory ring that empties
      // when the server restarts, so an absence here is not evidence of silence.
      header: "Last call seen",
      hideOnNarrow: true,
      // Relative first: "3 h ago" is the answer, the stamp underneath is the evidence.
      // Both go through the shared IST clock — `toLocaleString` on a naive timestamp
      // renders it in the browser's own zone, so this column disagreed with every
      // other screen in the app by the reader's offset.
      render: (row) => (
        <div className="text-sm">
          <div className="text-ink">
            {row.last_called_at ? fmtRelative(row.last_called_at) : "None since restart"}
          </div>
          {row.last_called_at && (
            <div className="text-xs text-muted">{fmtDateTime(row.last_called_at)}</div>
          )}
        </div>
      ),
    },
    {
      key: "contact",
      header: "Owner",
      hideOnNarrow: true,
      render: (row) => (
        <div className="text-sm">
          <div className="text-ink">{row.contact_person ?? "—"}</div>
          <div className="text-xs text-muted">{row.contact_email ?? ""}</div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row) => {
        const health = healthOf(row);
        return (
          <div className="min-w-0">
            <HealthPill health={health} />
            <div className="mt-1 text-[11px] leading-tight text-muted">{health.note}</div>
          </div>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        // One title for both tabs. It read "Applications" on one and "Integrations"
        // on the other, so switching tabs looked like leaving the screen.
        title="Integrations"
        // Only the action that CREATES something on the tab you are on. The Activity
        // log is a place, not an action, and the tab strip below already names it —
        // a second button for the same destination beside a "Register…" button reads
        // as a different thing that does something else.
        actions={(
          <>
            {tab === "clients" && (
              <Button onClick={() => setRegistering(true)}>
                <Plus className="h-4 w-4" /> Register application
              </Button>
            )}
            {tab === "webhooks" && (
              <Button onClick={() => webhooks.current?.openRegister()}>
                <Plus className="h-4 w-4" /> Register a webhook
              </Button>
            )}
          </>
        )}
      />

      <SubNav label="Integrations" items={TABS} value={tab} onChange={setTab} />

      {tab === "activity" ? (
        <ActivityLog />
      ) : tab === "aims" ? (
        <AimsPanel />
      ) : tab === "cams" ? (
        <>
          {/* The same diagram as the webhook tab's, pointing the same way, with the
              one difference stated where a reader will meet it: what crosses this wire
              can change our stock. */}
          <FlowExplainer
            icon={Stethoscope}
            title="B-CAMS"
            // Brand, not a status tone: `ok` and `warn` are what the health pills two
            // inches below mean, and a green title chip beside them reads as a verdict
            // on the integration rather than as its colour.
            from={SCM_END}
            to={{
              icon: Stethoscope, label: "B-CAMS",
              note: "the clinic app, out in the field",
            }}
            forward={false}
            gate={{
              icon: ShieldCheck,
              label: "A signed body, on one of five endpoints",
            }}
            plainly="It is the clinic app telling us what the field actually used — and unlike a webhook, two of the things it says move our stock."
            steps={CAMS_SETUP}
          >
            B-CAMS pushes five events and reads fourteen feeds back, in shapes the
            endpoint builder cannot compose — so it is a hand-written adapter rather
            than a registration on either tab beside this one. Consumption and wastage
            DEDUCT what the field reported, through the same movement every other
            issue goes through; the other three record and change nothing. There is
            nothing to register here: give them a key, a secret and the address.
          </FlowExplainer>

          <CamsPanel />
        </>
      ) : tab === "webhooks" ? (
        <>
          {/* SCM stays on the LEFT in both diagrams and the packets run the other way
              here. The two tabs are mirror images of each other on purpose: which end
              of the wire the traffic starts at is the whole difference between them,
              and a reader flipping between the tabs sees it move. */}
          <FlowExplainer
            icon={Radio}
            title="Webhooks"
            tone="info"
            from={SCM_END}
            to={{
              icon: MonitorSmartphone, label: "Their system",
              note: "HCM, payroll, a partner",
            }}
            forward={false}
            gate={{
              icon: ShieldCheck,
              label: "A valid signature, and an event you registered",
            }}
            plainly="It is a doorbell with a name on it. They ring the moment something happens at their end, and SCM opens only for the ring it recognises."
            steps={WEBHOOK_SETUP}
          >
            A webhook is an outside system PUSHING an event into SCM the moment it
            happens — an employee changed, a document was signed. It posts to an
            address issued here, signs the body with a secret issued here, and may only
            send the events it was registered for. What SCM does with each one comes
            from a fixed list, never from a table this screen can point at.
          </FlowExplainer>

          <WebhooksPanel ref={webhooks} />
        </>
      ) : (
        <>
          <FlowExplainer
            icon={Plug}
            title="Applications"
            from={SCM_END}
            to={{
              icon: MonitorSmartphone, label: "Their system",
              note: "billing, a dashboard, a portal",
            }}
            // The DATA leaves SCM, even though the CALL is dialled the other way — the
            // thin dotted return line is that call. Drawing the call as the main arrow
            // is the confusion this diagram exists to end.
            forward
            gate={{ icon: Columns3, label: "Only the columns you ticked" }}
            plainly="It is a library card. They read the shelves you open for them, one row at a time, and can never write anything back."
            steps={SETUP}
          >
            An application is an outside system that READS SCM data — a billing system
            pricing a job, a dashboard counting stock. It calls SCM with a key you
            issue, and sees only the tables and columns you build for it: it can narrow
            what an API returns, never widen it, and it can never write.
          </FlowExplainer>

          <FilterBar
            search={search}
            onSearch={(value) => {
              setSearch(value);
              setPage(1);
            }}
            searchPlaceholder="Search by name or code…"
            searchLabel="Search applications"
            onClear={() => {
              setSearch("");
              setPage(1);
            }}
            active={search ? 1 : 0}
            right={
              <span className="text-sm text-muted">
                {total} {total === 1 ? "application" : "applications"}
              </span>
            }
          />

          {error && <ErrorBanner error="Applications could not be loaded." />}

          <ResponsiveList
            data={data?.items ?? []}
            columns={columns}
            keyOf={(row) => row.code}
            loading={isLoading}
            onRowClick={(row) => navigate(`/admin/integrations/${row.code}`)}
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
            empty={
              <EmptyState
                title="No outside system is connected yet"
                hint="Register the system that needs SCM data, build the APIs it may read, then issue it a key. Any table in the database can be served — no release, no developer."
                action={
                  <Button onClick={() => setRegistering(true)}>
                    <Plus className="h-4 w-4" /> Register application
                  </Button>
                }
              />
            }
            renderCard={(row) => {
              const health = healthOf(row);
              return (
                <Link to={`/admin/integrations/${row.code}`} className="block p-1">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0">
                      <span className="block font-semibold text-ink">{row.name}</span>
                      <code className="text-[11px] text-muted">{row.code}</code>
                    </span>
                    <HealthPill health={health} />
                  </div>
                  <div className="mt-2 text-xs text-muted">{health.note}</div>
                  <div className="mt-1 text-xs text-muted">
                    {row.endpoints} {row.endpoints === 1 ? "API" : "APIs"} ·{" "}
                    {row.active_keys} active {row.active_keys === 1 ? "key" : "keys"} ·
                    {" "}last call seen{" "}
                    {row.last_called_at ? fmtRelative(row.last_called_at) : "none since restart"}
                  </div>
                </Link>
              );
            }}
          />
        </>
      )}

      {/* One form for registering and for editing, opened from here and from the
          detail screen. Two copies of a form that decides what an application is
          would drift. */}
      <ClientFormModal
        open={registering}
        editing={null}
        onClose={() => setRegistering(false)}
        // Straight into it: registering is step one of three, and the other two — a
        // key and an endpoint — live on the detail screen.
        onSaved={(client) => {
          setRegistering(false);
          navigate(`/admin/integrations/${client.code}`);
        }}
      />
    </div>
  );
}
