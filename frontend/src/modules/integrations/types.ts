/** Shapes the API console exchanges with `/api/apis`. */

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

/** A table the live database offers as a source. */
export interface SourceTable {
  table: string;
  group: string;
  columns: number;
}

export interface SourceColumn {
  column: string;
  type: string;
  is_date: boolean;
  is_numeric: boolean;
}

export interface ApiClient {
  code: string;
  name: string;
  description?: string | null;
  contact_person?: string | null;
  contact_email?: string | null;
  is_active: boolean;
  created_by_name?: string | null;
  created_at?: string | null;
  active_keys: number;
  endpoints: number;
  last_called_at?: string | null;
}

export interface ClientWrite {
  code: string;
  name: string;
  description?: string | null;
  contact_person?: string | null;
  contact_email?: string | null;
  is_active: boolean;
}

export type KeyState = "ACTIVE" | "EXPIRED" | "REVOKED";

export interface ApiKey {
  client_code: string;
  label: string;
  key_prefix: string;
  masked_key: string;
  state: KeyState;
  /** Endpoint slugs. Empty = every endpoint of this client. */
  scopes: string[];
  rate_limit_per_min: number;
  expires_at?: string | null;
  last_used_at?: string | null;
  revoked_at?: string | null;
  revoked_by_name?: string | null;
  created_by_name?: string | null;
  created_at?: string | null;
}

/** The one response that ever carries the raw key. Never re-fetchable. */
export interface IssuedKey extends ApiKey {
  api_key: string;
  warning: string;
}

export interface KeyWrite {
  label: string;
  scopes: string[];
  rate_limit_per_min: number;
  expires_at?: string | null;
}

/** One output column. `label` renames it, which is how a join avoids a collision. */
export interface FieldDef {
  column: string;
  label?: string | null;
}

/** One more source table. `from_index` is -1 for the base table, or the index of an
 *  earlier join — which is what lets tables chain instead of all hanging off the base. */
export interface JoinDef {
  table: string;
  from_index: number;
  base_column: string;
  join_column: string;
  fields: FieldDef[];
}

/** The whole definition of an API, as composed on the screen. */
export interface EndpointWrite {
  slug: string;
  name: string;
  table: string;
  fields: FieldDef[];
  joins: JoinDef[];
  filters: Record<string, string>;
  filterable: string[];
  searchable: string[];
  order_by: string;
  order_dir: "asc" | "desc";
  updated_column: string;
  default_size: number;
  max_size: number;
  is_active: boolean;
}

export interface ApiEndpoint extends EndpointWrite {
  client_code: string;
  url: string;
  output_columns: string[];
  created_by_name?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface Preview {
  columns: string[];
  rows: Record<string, unknown>[];
  sql: string;
  total: number;
}

export interface CallLog {
  at: string;
  client_code?: string | null;
  key_prefix?: string | null;
  slug?: string | null;
  status_code: number;
  row_count?: number | null;
  duration_ms?: number | null;
  ip_address?: string | null;
  error?: string | null;
}

export interface Usage {
  calls: number;
  errors: number;
  rows: number;
  last_called_at?: string | null;
  /** The log is an in-memory ring: it starts empty after every server restart. */
  since_restart: boolean;
  by_endpoint: { slug: string; calls: number; rows: number; last_called_at?: string }[];
}

// --------------------------------------------------------------------------- //
//  Platform links — what THIS app connects out to
// --------------------------------------------------------------------------- //
// The mirror of the console types above: those describe applications that call US,
// these describe HCM, mail and the database, which we call.

export interface LinkField {
  label: string;
  /** MASKED for `is_secret` rows — the real value never leaves the server. */
  value?: string | null;
  is_secret: boolean;
  /** Carried separately so "not configured" is never inferred from a blank value. */
  is_set: boolean;
  hint?: string | null;
}

export interface LinkActivity {
  at?: string | null;
  status?: string | null;
  detail?: string | null;
}

export interface PlatformLink {
  code: string;
  name: string;
  kind: string;
  direction: string;
  icon?: string | null;
  endpoint?: string | null;
  configured: boolean;
  summary: string;
  fields: LinkField[];
  log_label?: string | null;
  has_log: boolean;
  last_activity?: LinkActivity | null;
}

/** One line of a link's own log, normalised so HCM syncs and sent mail share a table. */
export interface LinkLogRow {
  id: number;
  at?: string | null;
  status: string;
  subject?: string | null;
  detail?: string | null;
  error?: string | null;
  actor?: string | null;
}

export interface LinkTest {
  code: string;
  ok: boolean;
  ms: number;
  detail: string;
}

export interface LinkLogStats {
  by_status: Record<string, number>;
  total: number;
}

/** The real credentials, from the reveal route only — a POST on
 *  `integration.keys.manage` that writes an audit row. Never present on a list. */
export interface LinkReveal {
  code: string;
  fields: { label: string; value: string }[];
}

/** An exported endpoint set, for moving an API surface between deployments.
 *  Deliberately carries no keys: only a hash of those is ever stored, and one key
 *  live on two deployments could not be revoked on either. */
export interface EndpointClip {
  v: number;
  kind: string;
  client_code: string;
  client_name: string;
  exported_at: string;
  endpoints: EndpointWrite[];
}

export interface ImportResult {
  created: number;
  updated: number;
  retired: number;
  total: number;
}

/* ---- Inbound webhooks ---------------------------------------------------- */

/** What a webhook may DO with what arrives. A closed set on the server — adding one
 *  is a code change on purpose, because each handler is answerable for its writes. */
export interface WebhookHandler {
  key: string;
  label: string;
}

export interface Webhook {
  source: string;
  name?: string | null;
  description?: string | null;
  events: string[];
  handler: string;
  require_signature: boolean;
  /** Whether a secret exists — never the secret itself. */
  has_secret: boolean;
  is_active: boolean;
  url: string;
  created_at?: string | null;
  created_by_name?: string | null;
  updated_at?: string | null;
  last_received_at?: string | null;
  received_count: number;
}

export interface WebhookWrite {
  source: string;
  name: string;
  description?: string | null;
  events: string[];
  handler: string;
  require_signature: boolean;
  is_active: boolean;
}

export interface WebhookSecret {
  source: string;
  shared_secret: string;
  signature_header: string;
  note: string;
}

export interface WebhookDelivery {
  source: string;
  event: string;
  event_id: string;
  received_at: string;
  client_code?: string | null;
  body_sha256?: string | null;
  payload_truncated?: boolean;
  outcome?: Record<string, unknown> | null;
}

/* ---- Connection details -------------------------------------------------- */

export interface DocParam {
  name: string;
  kind: "filter" | "search" | "incremental" | "paging" | string;
  note: string;
}

export interface DocEndpoint {
  slug: string;
  name: string;
  path: string;
  url: string;
  returns: string[];
  params: DocParam[];
}

/** What a partner needs to start calling. Derived on the server from the endpoint
 *  documents — never a second, hand-maintained copy. */
export interface ConnectionDocs {
  client_code: string;
  client_name: string;
  base_url: string;
  auth: { header: string; note: string };
  conventions: Record<string, string>;
  probe: { path: string; note: string };
  directory: { path: string; note: string };
  endpoints: DocEndpoint[];
}

/** Everything the sending system needs, derived from the webhook registration. */
export interface WebhookDocs {
  source: string;
  name: string;
  url: string;
  method: string;
  handler: string;
  handler_label: string;
  events: string[];
  has_secret: boolean;
  require_signature: boolean;
  headers: { name: string; note: string }[];
  envelope: { field: string; note: string }[];
  answers: { status: number; body?: unknown; note: string }[];
  samples: { event: string; body: unknown }[];
  signing_note: string;
}
