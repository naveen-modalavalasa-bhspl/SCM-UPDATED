import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowUpFromLine, KeyRound, RefreshCw, Settings2 } from "lucide-react";
import {
  Button, Card, ErrorBanner, Field, Input, SubNav, type SubNavItem,
} from "@/shared/components";
import { api } from "@/shared/api/client";
import { useAuth } from "@/shared/auth/AuthContext";
import { fmtDateTime } from "@/shared/datetime";

/**
 * AIMS — the asset system. SCM PUSHES a signed event whenever an asset item's stock
 * arrives at a warehouse (a GRN posted, or an indent / issue / consignment acknowledged
 * at its destination), and AIMS PULLS the details through its own API key.
 *
 * Push: an outbox written in the same transaction as the stock movement, delivered
 * after commit (`adapters/aims/outbox.py`). Pull: the console's call log for the
 * application code AIMS uses. The server gates every call (view / manage / keys.manage);
 * the buttons here only mirror that.
 */
const TABS: SubNavItem[] = [
  { key: "push", label: "Pushed to AIMS", icon: ArrowUpFromLine },
  { key: "pull", label: "Pulled by AIMS", icon: ArrowDownToLine },
  { key: "settings", label: "Connection", icon: Settings2 },
];

type AimsConfig = {
  url: string; enabled: boolean; client_code: string; has_secret: boolean;
  rotated_at?: string | null; rotated_by_name?: string | null;
  updated_at?: string | null; updated_by_name?: string | null;
};
type AimsStatus = { config: AimsConfig; counts: Record<string, number>; last_sent_at?: string | null };
type AimsEvent = {
  event_id: string; status: string; attempts: number; created_at?: string | null;
  sent_at?: string | null; last_error?: string | null; last_status_code?: number | null;
  ref_no?: string | null; item_code?: string | null; warehouse_name?: string | null; quantity?: string | null;
};
type PullRow = { at: string; slug?: string; status_code?: number; row_count?: number; error?: string };
type Page<T> = { items: T[]; total: number; page: number; size: number };

const BASE = "/api/apis/aims";
const aimsApi = {
  status: async (): Promise<AimsStatus> => (await api.get(`${BASE}/status`)).data,
  events: async (status: string, page: number): Promise<Page<AimsEvent>> =>
    (await api.get(`${BASE}/events`, { params: { status: status || undefined, page, size: 25 } })).data,
  pulls: async (page: number): Promise<Page<PullRow> & { client_code: string }> =>
    (await api.get(`${BASE}/pulls`, { params: { page, size: 25 } })).data,
  retry: async (id: string) => (await api.post(`${BASE}/events/${id}/retry`)).data,
  deliver: async () => (await api.post(`${BASE}/deliver`)).data,
  saveConfig: async (body: { url: string; enabled: boolean; client_code: string }): Promise<AimsConfig> =>
    (await api.put(`${BASE}/config`, body)).data,
  rotateSecret: async (): Promise<{ shared_secret: string; note: string }> =>
    (await api.post(`${BASE}/secret`)).data,
  test: async (): Promise<{ ok: boolean; message: string }> =>
    (await api.post(`${BASE}/test`)).data,
};

const TONE: Record<string, string> = {
  sent: "bg-success-50 text-success-700", pending: "bg-warning-50 text-warning-700",
  failed: "bg-danger-50 text-danger-700",
};

export function AimsPanel() {
  const [tab, setTab] = useState("push");
  const status = useQuery({ queryKey: ["aims", "status"], queryFn: aimsApi.status });
  const s = status.data;
  return (
    <div>
      <ErrorBanner error={status.error} />
      <Card className="mb-5 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded bg-content2 px-2 py-0.5 text-xs font-semibold text-ink">aims</code>
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${s?.config.enabled ? TONE.sent : "bg-content2 text-muted"}`}>
            {s?.config.enabled ? "Push on" : "Push off"}
          </span>
        </div>
        <p className="mt-1.5 max-w-2xl text-sm text-body">
          When asset stock arrives at a warehouse — a GRN is posted, or an indent or issue is
          acknowledged at its destination — SCM tells AIMS with a signed event. Consumables are
          never sent. AIMS reads the details back with its own API key.
        </p>
        {s && <div className="mt-3 flex flex-wrap gap-4 text-sm">
          <span><b>{s.counts.sent ?? 0}</b> <span className="text-muted">sent</span></span>
          <span><b>{s.counts.pending ?? 0}</b> <span className="text-muted">waiting</span></span>
          <span><b>{s.counts.failed ?? 0}</b> <span className="text-muted">failed</span></span>
          {s.last_sent_at && <span className="text-muted">last sent {fmtDateTime(s.last_sent_at)}</span>}
        </div>}
      </Card>
      <SubNav label="AIMS" items={TABS} value={tab} onChange={setTab} />
      {tab === "push" ? <PushLog /> : tab === "pull" ? <PullLog /> : s ? <Connection config={s.config} /> : null}
    </div>
  );
}

function PushLog() {
  const client = useQueryClient();
  const { can } = useAuth();
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const list = useQuery({ queryKey: ["aims", "events", status, page], queryFn: () => aimsApi.events(status, page) });
  const refresh = () => client.invalidateQueries({ queryKey: ["aims"] });
  const retry = useMutation({ mutationFn: aimsApi.retry, onSuccess: refresh });
  const deliver = useMutation({ mutationFn: aimsApi.deliver, onSuccess: refresh });
  const rows = list.data?.items ?? [];
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.size)) : 1;
  return (
    <Card className="p-4">
      <ErrorBanner error={list.error ?? retry.error ?? deliver.error} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {["", "pending", "sent", "failed"].map((key) => (
          <button key={key || "all"} type="button" onClick={() => { setStatus(key); setPage(1); }}
            className={`rounded-full border px-3 py-1 text-sm ${status === key ? "border-primary bg-primary-50 text-primary" : "border-line text-body"}`}>
            {key ? key[0].toUpperCase() + key.slice(1) : "All"}
          </button>
        ))}
        {can("integration.manage") && <Button variant="subtle" className="ml-auto" disabled={deliver.isPending} onClick={() => deliver.mutate()}>
          <RefreshCw className="h-4 w-4" /> {deliver.isPending ? "Sending…" : "Send pending now"}
        </Button>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line text-left text-xs uppercase text-muted">
            <th className="py-2 pr-3">When</th><th className="pr-3">Document</th><th className="pr-3">Item</th>
            <th className="pr-3">Warehouse</th><th className="pr-3 text-right">Qty</th><th className="pr-3">Status</th>
            <th className="pr-3">Tries</th><th className="pr-3">Last result</th><th />
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.event_id} className="border-b border-line/60 align-top">
                <td className="py-2 pr-3 whitespace-nowrap">{r.created_at ? fmtDateTime(r.created_at) : "—"}</td>
                <td className="pr-3">{r.ref_no ?? "—"}<div className="text-xs text-muted">{r.event_id}</div></td>
                <td className="pr-3 font-mono text-xs">{r.item_code ?? "—"}</td>
                <td className="pr-3">{r.warehouse_name ?? "—"}</td>
                <td className="pr-3 text-right">{r.quantity ?? "—"}</td>
                <td className="pr-3"><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${TONE[r.status] ?? ""}`}>{r.status}</span></td>
                <td className="pr-3">{r.attempts}</td>
                <td className="pr-3 max-w-xs text-xs text-muted">{r.status === "sent" ? `Delivered ${r.sent_at ? fmtDateTime(r.sent_at) : ""}` : r.last_error ?? "Waiting to be sent"}</td>
                <td>{can("integration.manage") && r.status !== "sent" && <Button variant="ghost" disabled={retry.isPending} onClick={() => retry.mutate(r.event_id)}>Resend</Button>}</td>
              </tr>
            ))}
            {!list.isLoading && rows.length === 0 && <tr><td colSpan={9} className="py-6 text-center text-muted">Nothing sent to AIMS yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {pages > 1 && <div className="mt-3 flex items-center justify-center gap-3 text-sm">
        <Button variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
        <span>Page {page} of {pages}</span>
        <Button variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
      </div>}
    </Card>
  );
}

function PullLog() {
  const [page, setPage] = useState(1);
  const list = useQuery({ queryKey: ["aims", "pulls", page], queryFn: () => aimsApi.pulls(page) });
  const rows = list.data?.items ?? [];
  return (
    <Card className="p-4">
      <ErrorBanner error={list.error} />
      <p className="mb-3 text-sm text-muted">
        {list.data?.client_code
          ? <>Calls made with application <code className="text-body">{list.data.client_code}</code>’s API key, newest first. Covers this server since its last restart.</>
          : <>Set the application code AIMS uses on the Connection tab to see its reads here.</>}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line text-left text-xs uppercase text-muted">
            <th className="py-2 pr-3">When</th><th className="pr-3">Endpoint</th><th className="pr-3">Result</th><th className="pr-3 text-right">Rows</th>
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.at}-${i}`} className="border-b border-line/60">
                <td className="py-2 pr-3 whitespace-nowrap">{fmtDateTime(r.at)}</td>
                <td className="pr-3 font-mono text-xs">{r.slug ?? "—"}</td>
                <td className="pr-3">{(r.status_code ?? 200) < 400 ? <span className="text-success-700">{r.status_code ?? 200}</span> : <span className="text-danger-700">{r.status_code} {r.error ?? ""}</span>}</td>
                <td className="pr-3 text-right">{r.row_count ?? "—"}</td>
              </tr>
            ))}
            {!list.isLoading && rows.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-muted">No reads recorded since the last restart.</td></tr>}
          </tbody>
        </table>
      </div>
      {list.data && list.data.total > list.data.size && <div className="mt-3 flex items-center justify-center gap-3 text-sm">
        <Button variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
        <span>Page {page}</span>
        <Button variant="ghost" disabled={page * list.data.size >= list.data.total} onClick={() => setPage(page + 1)}>Next</Button>
      </div>}
    </Card>
  );
}

function Connection({ config }: { config: AimsConfig }) {
  const client = useQueryClient();
  const { can } = useAuth();
  const canEdit = can("integration.keys.manage");
  const [url, setUrl] = useState(config.url);
  const [enabled, setEnabled] = useState(config.enabled);
  const [code, setCode] = useState(config.client_code);
  const [secret, setSecret] = useState<string | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ["aims"] });
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);
  const save = useMutation({
    mutationFn: () => aimsApi.saveConfig({ url, enabled, client_code: code }),
    onMutate: () => setNote(null),
    onSuccess: (saved) => {
      setNote({ ok: true, message: `Saved. Push is ${saved.enabled ? "on" : "off"}.` });
      refresh();
    },
  });
  const test = useMutation({ mutationFn: aimsApi.test, onMutate: () => setNote(null), onSuccess: setNote });
  const rotate = useMutation({ mutationFn: aimsApi.rotateSecret, onSuccess: (data) => { setSecret(data.shared_secret); refresh(); } });
  return (
    <Card className="grid gap-4 p-4">
      <ErrorBanner error={save.error ?? rotate.error ?? test.error} />
      {note && <div className={`rounded-md p-3 text-sm ${note.ok ? TONE.sent : TONE.failed}`}>{note.message}</div>}
      <Field label="AIMS address" hint="Where SCM posts events, e.g. https://aims.example.com/api/v1/integrations/scm/events">
        <Input value={url} disabled={!canEdit} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUrl(e.target.value)} placeholder="https://…/api/v1/integrations/scm/events" />
      </Field>
      <Field label="Application code AIMS reads with" hint="The code of the Applications-tab client whose API key AIMS uses; its reads appear on the Pulled tab.">
        <Input value={code} disabled={!canEdit} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCode(e.target.value)} placeholder="AIMS" />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} disabled={!canEdit} onChange={(e) => setEnabled(e.target.checked)} />
        Push asset arrivals to AIMS
      </label>
      <div className="text-xs text-muted">
        Signing secret: {config.has_secret ? `issued ${config.rotated_at ? fmtDateTime(config.rotated_at) : ""}${config.rotated_by_name ? ` by ${config.rotated_by_name}` : ""}` : "not issued yet"}.
        Events are signed with HMAC-SHA256 over <code>timestamp.body</code> in <code>X-Webhook-Signature</code> and <code>X-Webhook-Timestamp</code>, with the event id in <code>X-Event-Id</code>.
        {config.updated_by_name && <> Settings last changed by {config.updated_by_name}{config.updated_at ? ` on ${fmtDateTime(config.updated_at)}` : ""}.</>}
      </div>
      {secret && <div className="rounded-md border border-warning-200 bg-warning-50 p-3 text-sm">
        <b>New secret — shown once.</b> Put it in AIMS as <code>AIMS_SCM_WEBHOOK_SECRET</code> now:
        <div className="mt-1 break-all font-mono">{secret}</div>
      </div>}
      {canEdit ? <div className="flex flex-wrap gap-2">
        <Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save"}</Button>
        <Button variant="subtle" disabled={test.isPending || !config.url} onClick={() => test.mutate()}>
          {test.isPending ? "Testing…" : "Test connection"}
        </Button>
        <Button variant="subtle" disabled={rotate.isPending} onClick={() => {
          if (!config.has_secret || window.confirm("Issue a new secret? AIMS stops accepting events until you give it the new one.")) rotate.mutate();
        }}><KeyRound className="h-4 w-4" /> {config.has_secret ? "Replace secret" : "Issue secret"}</Button>
      </div> : <p className="text-xs text-muted">Only people with the integration keys permission can change these.</p>}
    </Card>
  );
}
