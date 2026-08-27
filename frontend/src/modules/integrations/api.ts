import { api } from "@/shared/api/client";
import type {
  ApiClient, ApiEndpoint, ApiKey, CallLog, ClientWrite, EndpointClip, EndpointWrite,
  ImportResult, IssuedKey,
  KeyWrite, LinkLogRow, LinkLogStats, LinkReveal, LinkTest, Page, PlatformLink,
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

  /** The response carries the raw key. It is never retrievable again. */
  issueKey: async (code: string, body: KeyWrite): Promise<IssuedKey> =>
    (await api.post(`${BASE}/clients/${code}/keys`, body)).data,

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

  /** What you send the system that will push to us. Derived from the registration,
   *  so it cannot drift from what the endpoint will actually accept. */
  docs: async (source: string): Promise<WebhookDocs> =>
    (await api.get(`${BASE}/webhooks/${source}/docs`)).data,

  deliveries: async (source?: string): Promise<Page<WebhookDelivery>> =>
    (await api.get(`${BASE}/webhook-deliveries`, {
      params: clean({ source, size: 50 }),
    })).data,
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
