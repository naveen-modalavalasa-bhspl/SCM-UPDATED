import { api } from "@/shared/api/client";
import type {
  ApiClient, ApiEndpoint, ApiKey, CallLog, ClientWrite, EndpointWrite, IssuedKey,
  KeyWrite, Page, Preview, SourceColumn, SourceTable, Usage,
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

  logs: async (code: string,
               query: { page?: number; size?: number; errors_only?: boolean } = {}):
    Promise<Page<CallLog>> =>
    (await api.get(`${BASE}/clients/${code}/logs`, { params: clean({ ...query }) })).data,

  usage: async (code: string): Promise<Usage> =>
    (await api.get(`${BASE}/clients/${code}/usage`)).data,
};
