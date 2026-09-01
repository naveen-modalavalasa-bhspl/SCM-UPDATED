import { api } from "@/shared/api/client";
import type {
  ActivityFilters, ActivityQuery, ActivityRow, ActivitySummary,
  ApiClient, ApiEndpoint, ApiKey, CallLog, CamsDocs, CamsEvent, CamsSecret, CamsStatus,
  ClientWrite, EndpointClip, EndpointWrite,
  ImportResult, IntegrationSecretReveal, IntegrationSecretState, IssuedKey,
  KeyWrite, LinkLogRow, LinkLogStats, LinkReveal, LinkTest, Page, PlatformLink,
  RevealedKey,
  ConnectionDocs, Preview, SourceColumn, SourceTable, Usage, Webhook,
  WebhookDocs,
  WebhookDelivery,
  WebhookHandler, WebhookSecret, WebhookWrite,
} from "./types";

/** API-console HTTP layer. Every call hits a real endpoint and every error propagates. */
const clean = (params: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(params).filter(
      ([, v]) => v !== "" && v !== undefined && v !== null && v !== false,
    ),
  );

const BASE = "/api/apis";

export const integrationsApi = {
  /** Every table the live database offers, grouped by module. */
  tables: async (): Promise<SourceTable[]> =>
    (await api.get(`${BASE}/tables`)).data,

  columns: async (table: string): Promise<SourceColumn[]> =>
    (await api.get(`${BASE}/tables/${table}/columns`)).data,

  /** Re-read the schema after a migration, without restarting the server. */
  refreshSchema: async (): Promise<void> => {
    await api.post(`${BASE}/schema/refresh`);
  },

  listClients: async (query: { page?: number; size?: number; search?: string } = {}):
    Promise<Page<ApiClient>> =>
    (await api.get(`${BASE}/clients`, { params: clean({ ...query }) })).data,

  getClient: async (code: string): Promise<ApiClient> =>
    (await api.get(`${BASE}/clients/${code}`)).data,

  createClient: async (body: ClientWrite): Promise<ApiClient> =>
    (await api.post(`${BASE}/clients`, body)).data,

  updateClient: async (code: string, body: ClientWrite): Promise<ApiClient> =>
    (await api.put(`${BASE}/clients/${code}`, body)).data,

  keys: async (code: string): Promise<ApiKey[]> =>
    (await api.get(`${BASE}/clients/${code}/keys`)).data,

  /** The response carries the raw key, and shows it once in the dialog. */
  issueKey: async (code: string, body: KeyWrite): Promise<IssuedKey> =>
    (await api.post(`${BASE}/clients/${code}/keys`, body)).data,

  /** The full key again, for a copy off the list. A POST, on
   *  `integration.keys.manage` — the same permission that issued it. */
  revealKey: async (prefix: string): Promise<RevealedKey> =>
    (await api.post(`${BASE}/keys/${prefix}/reveal`)).data,

  revokeKey: async (prefix: string): Promise<ApiKey> =>
    (await api.post(`${BASE}/keys/${prefix}/revoke`)).data,

  endpoints: async (code: string): Promise<ApiEndpoint[]> =>
    (await api.get(`${BASE}/clients/${code}/endpoints`)).data,

  /** The SQL and the first rows, before anything is saved. */
  preview: async (code: string, body: EndpointWrite): Promise<Preview> =>
    (await api.post(`${BASE}/clients/${code}/endpoints/preview`, body)).data,

  createEndpoint: async (code: string, body: EndpointWrite): Promise<ApiEndpoint> =>
    (await api.post(`${BASE}/clients/${code}/endpoints`, body)).data,

  updateEndpoint: async (code: string, slug: string, body: EndpointWrite):
    Promise<ApiEndpoint> =>
    (await api.put(`${BASE}/clients/${code}/endpoints/${slug}`, body)).data,

  deleteEndpoint: async (slug: string): Promise<ApiEndpoint> =>
    (await api.delete(`${BASE}/endpoints/${slug}`)).data,

  /** This application's whole endpoint set, to paste into another deployment.
   *  Carries no keys — see the note on the backend route. */
  exportEndpoints: async (code: string): Promise<EndpointClip> =>
    (await api.get(`${BASE}/clients/${code}/endpoints/export`)).data,

  /** All-or-nothing, and re-validated against the database it lands on. */
  importEndpoints: async (code: string, clip: unknown, replace = false):
    Promise<ImportResult> =>
    (await api.post(`${BASE}/clients/${code}/endpoints/import`,
                    { clip, replace })).data,

  /** Base URL, auth and every endpoint with what it accepts and returns. Derived on
   *  the server from the endpoint documents, so it cannot drift from what is served. */
  docs: async (code: string): Promise<ConnectionDocs> =>
    (await api.get(`${BASE}/clients/${code}/docs`)).data,

  /** A real response from one endpoint — the shape seen rather than imagined. */
  sample: async (slug: string, rows = 2): Promise<unknown> =>
    (await api.get(`${BASE}/endpoints/${slug}/sample`, { params: { rows } })).data,

  logs: async (code: string,
               query: { page?: number; size?: number; errors_only?: boolean } = {}):
    Promise<Page<CallLog>> =>
    (await api.get(`${BASE}/clients/${code}/logs`, { params: clean({ ...query }) })).data,

  usage: async (code: string): Promise<Usage> =>
    (await api.get(`${BASE}/clients/${code}/usage`)).data,
};

/** Inbound webhooks — who may push INTO SCM, registered from the screen.
 *
 *  `handlers` is SERVED rather than listed here: what a webhook may do with what it
 *  receives is a closed set on the server (a screen that could point a feed at a
 *  business table would be a way around every module's own service), so the picker
 *  must offer exactly what the server will accept. */
export const webhooksApi = {
  handlers: async (): Promise<WebhookHandler[]> =>
    (await api.get(`${BASE}/webhook-handlers`)).data,

  /** Suggestions for the event picker, not a whitelist — a partner's own name is
   *  accepted too. Served so the list grows as webhooks are registered. */
  eventNames: async (): Promise<string[]> =>
    (await api.get(`${BASE}/webhook-events`)).data,

  list: async (): Promise<Webhook[]> =>
    (await api.get(`${BASE}/webhooks`)).data,

  /** One webhook, for its own screen — the same row the list carries, fetched on its
   *  own so the detail page opens on a deep link without the list behind it. */
  get: async (source: string): Promise<Webhook> =>
    (await api.get(`${BASE}/webhooks/${source}`)).data,

  create: async (body: WebhookWrite): Promise<Webhook> =>
    (await api.post(`${BASE}/webhooks`, body)).data,

  update: async (source: string, body: WebhookWrite): Promise<Webhook> =>
    (await api.put(`${BASE}/webhooks/${source}`, body)).data,

  /** Deactivates rather than deletes, so the deliveries it took keep their meaning. */
  disable: async (source: string): Promise<Webhook> =>
    (await api.delete(`${BASE}/webhooks/${source}`)).data,

  /** The only response that carries the secret. Shown once, never retrievable. */
  rotateSecret: async (source: string): Promise<WebhookSecret> =>
    (await api.post(`${BASE}/webhooks/${source}/secret`)).data,

  secretState: async (source: string): Promise<IntegrationSecretState> =>
    (await api.get(`${BASE}/webhooks/${source}/secret`)).data,

  revealSecret: async (source: string, password?: string): Promise<IntegrationSecretReveal> =>
    (await api.post(`${BASE}/webhooks/${source}/secret/reveal`, { password })).data,

  /** Clear the HCM sequence cursor. Needed when a push SCM itself refused left a gap
   *  the sender can never close, which wedges every later push on 409. */
  resetSequence: async (source: string): Promise<Webhook> =>
    (await api.post(`${BASE}/webhooks/${source}/reset-sequence`)).data,

  /** What you send the system that will push to us. Derived from the registration,
   *  so it cannot drift from what the endpoint will actually accept. */
  docs: async (source: string): Promise<WebhookDocs> =>
    (await api.get(`${BASE}/webhooks/${source}/docs`)).data,

  /** What has arrived. `size` is how far back the Received tab can see: its search,
   *  result and date filters all narrow what this brought back, so a page too small
   *  would make "this month" mean "the last 50 pushes". */
  deliveries: async (source?: string, size = 50): Promise<Page<WebhookDelivery>> =>
    (await api.get(`${BASE}/webhook-deliveries`, {
      params: clean({ source, size }),
    })).data,
};

/** B-CAMS is a hand-written adapter, not a registered webhook, so it has none of the
 *  rows the Webhooks tab reads: its writes go to `/api/ext/v1/cams/*` and are signed
 *  with their own header and their own shared secret. Everything a desk needs to
 *  operate it therefore lives behind these four calls and nowhere else. */
export const camsApi = {
  /** Whether a secret exists and what has arrived. Never the secret itself. */
  status: async (): Promise<CamsStatus> =>
    (await api.get(`${BASE}/cams/status`)).data,

  /** Where B-CAMS posts, how it signs, and one example per event. Derived on the
   *  server from the same table that registers the endpoints, so a URL in it is by
   *  construction a URL that exists. */
  docs: async (): Promise<CamsDocs> =>
    (await api.get(`${BASE}/cams/docs`)).data,

  /** The only response that carries the shared secret. Shown once, never retrievable
   *  — and it INVALIDATES the one B-CAMS is signing with, so the screen asks first. */
  rotateSecret: async (): Promise<CamsSecret> =>
    (await api.post(`${BASE}/cams/secret`)).data,

  /** What arrived, newest first. Bodies are excluded from the list — one is fetched
   *  by id — because a nightly sweep's payload is far too big to render in a table. */
  events: async (event?: string): Promise<Page<CamsEvent>> =>
    (await api.get(`${BASE}/cams/events`, {
      params: clean({ event, size: 50 }),
    })).data,

  event: async (eventId: string): Promise<CamsEvent> =>
    (await api.get(`${BASE}/cams/events/${eventId}`)).data,
};

/** What THIS app connects out to — HCM, mail, the database — and their own logs.
 *
 *  Every secret these return is masked server-side; there is no unmask route. `test`
 *  is how a credential is checked without the credential ever reaching the browser. */
export const platformLinksApi = {
  list: async (): Promise<PlatformLink[]> =>
    (await api.get(`${BASE}/platform`)).data,

  get: async (code: string): Promise<PlatformLink> =>
    (await api.get(`${BASE}/platform/${code}`)).data,

  /** Base URL, auth and every endpoint with what it accepts and returns. Derived on
   *  the server from the endpoint documents, so it cannot drift from what is served. */
  docs: async (code: string): Promise<ConnectionDocs> =>
    (await api.get(`${BASE}/clients/${code}/docs`)).data,

  /** A real response from one endpoint — the shape seen rather than imagined. */
  sample: async (slug: string, rows = 2): Promise<unknown> =>
    (await api.get(`${BASE}/endpoints/${slug}/sample`, { params: { rows } })).data,

  logs: async (code: string, params: { page?: number; size?: number; status?: string } = {})
    : Promise<Page<LinkLogRow>> =>
    (await api.get(`${BASE}/platform/${code}/logs`, { params: clean(params) })).data,

  logStats: async (code: string): Promise<LinkLogStats> =>
    (await api.get(`${BASE}/platform/${code}/log-stats`)).data,

  /** One live call against the configured credentials. Sends nothing, writes nothing. */
  test: async (code: string): Promise<LinkTest> =>
    (await api.post(`${BASE}/platform/${code}/test`)).data,

  /** The credentials in the clear. A POST, on `integration.keys.manage`, audited
   *  server-side — so it is never fetched as a side effect of opening the screen. The
   *  values are held in component state only and are gone on reload. */
  reveal: async (code: string): Promise<LinkReveal> =>
    (await api.post(`${BASE}/platform/${code}/reveal`)).data,
};

/** The Activity Log — one feed over applications AND webhooks.
 *
 *  Read-only, and every list it offers is SERVED: `filters()` returns the parties,
 *  channels and outcomes that actually exist, so an application or a webhook
 *  registered a minute ago is selectable without a change in here. */
export const activityApi = {
  feed: async (query: ActivityQuery = {}): Promise<Page<ActivityRow>> =>
    (await api.get(`${BASE}/activity`, { params: clean({ ...query }) })).data,

  summary: async (days?: number): Promise<ActivitySummary> =>
    (await api.get(`${BASE}/activity/summary`, { params: clean({ days }) })).data,

  filters: async (): Promise<ActivityFilters> =>
    (await api.get(`${BASE}/activity/filters`)).data,
};
