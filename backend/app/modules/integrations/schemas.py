"""Request/response shapes for the API console.

The interesting one is `EndpointWrite`: it is the whole definition of an API, as
composed on the screen. Everything it names is validated against the live schema in
`introspect.py` before it is stored, and again before it is served.
"""
import re
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.modules.integrations.enums import (
    IDENTIFIER_PATTERN, MAX_EXT_PAGE_SIZE, SLUG_PATTERN,
)
from app.shared.limits import (  # request-size guards, see the module
    MAX_CONFIG_ENTRIES,
)

CODE_PATTERN = r"^[A-Z][A-Z0-9_]{1,29}$"


def _identifier(value: str, what: str) -> str:
    value = (value or "").strip()
    if not re.match(IDENTIFIER_PATTERN, value):
        raise ValueError(f"{what} must be a plain SQL identifier")
    return value


# --------------------------------------------------------------------------- #
# Source picker
# --------------------------------------------------------------------------- #

class TableOut(BaseModel):
    table: str
    group: str
    columns: int


class ColumnOut(BaseModel):
    column: str
    type: str
    is_date: bool
    is_numeric: bool


# --------------------------------------------------------------------------- #
# Clients
# --------------------------------------------------------------------------- #

class ClientWrite(BaseModel):
    code: str
    name: str = Field(min_length=2, max_length=200)
    description: str | None = Field(default=None, max_length=500)
    contact_person: str | None = Field(default=None, max_length=200)
    contact_email: str | None = Field(default=None, max_length=200)
    is_active: bool = True

    @field_validator("code")
    @classmethod
    def _code(cls, value: str) -> str:
        # Upper-cased rather than rejected: "billing" and "BILLING" are the same application,
        # and letting both exist gives one integration two identities in the log.
        value = (value or "").strip().upper().replace(" ", "_")
        if not re.match(CODE_PATTERN, value):
            raise ValueError(
                "Code must start with a letter and use A-Z, 0-9 or _ (2-30 characters)")
        return value

    @field_validator("description", "contact_person", "contact_email")
    @classmethod
    def _trim(cls, value: str | None) -> str | None:
        return (value or "").strip() or None


class ClientOut(BaseModel):
    code: str
    name: str
    description: str | None = None
    contact_person: str | None = None
    contact_email: str | None = None
    is_active: bool = True
    created_by_name: str | None = None
    created_at: datetime | None = None
    active_keys: int = 0
    endpoints: int = 0
    last_called_at: datetime | None = None


# --------------------------------------------------------------------------- #
# Keys
# --------------------------------------------------------------------------- #

class KeyWrite(BaseModel):
    label: str = Field(min_length=2, max_length=120)
    # Endpoint slugs this key may call. EMPTY MEANS EVERY ENDPOINT OF ITS CLIENT — the
    # common case, and a list that has to be edited every time an endpoint is added is
    # a list that ends up stale and wrong.
    scopes: list[str] = Field(default_factory=list, max_length=MAX_CONFIG_ENTRIES)
    rate_limit_per_min: int = Field(default=120, ge=0, le=10_000)
    expires_at: datetime | None = None


class KeyOut(BaseModel):
    client_code: str
    label: str
    key_prefix: str
    masked_key: str = ""
    state: str = ""
    scopes: list[str] = []
    rate_limit_per_min: int = 120
    expires_at: datetime | None = None
    last_used_at: datetime | None = None
    revoked_at: datetime | None = None
    revoked_by_name: str | None = None
    created_by_name: str | None = None
    created_at: datetime | None = None
    # False for a key stored as a hash only — the list must not offer a copy it
    # cannot honour. See `service._key_out`.
    can_copy: bool = False


class KeyAttachIn(BaseModel):
    """The key itself, pasted back in to make a hash-only row copyable again."""
    api_key: str = Field(min_length=1, max_length=200)


class KeyIssuedOut(KeyOut):
    """The one response that ever carries the raw key. Not stored, not repeatable."""
    api_key: str
    warning: str = ("Copy this key now — only a hash is saved and it cannot be shown "
                    "again. Issue a new one if it is lost.")


class KeyRevealOut(KeyOut):
    """The stored key handed back for a copy, on `integration.keys.manage`."""
    api_key: str


class SecretStateOut(BaseModel):
    """What the page may know without seeing the per-application secret."""
    has_secret: bool
    needs_password: bool


class SecretRevealIn(BaseModel):
    password: str | None = Field(default=None, max_length=200)


class SecretRevealOut(BaseModel):
    """The stored shared secret, returned only after the reveal check."""
    shared_secret: str


# --------------------------------------------------------------------------- #
# Endpoints — the API you compose
# --------------------------------------------------------------------------- #

class FieldIn(BaseModel):
    """One output column. `label` is what the consumer sees, so a join can rename a
    column that would otherwise collide with one of the base table's."""
    column: str
    label: str | None = None

    @field_validator("column")
    @classmethod
    def _col(cls, value: str) -> str:
        return _identifier(value, "Column")

    @field_validator("label")
    @classmethod
    def _label(cls, value: str | None) -> str | None:
        return _identifier(value, "Label") if value else None


class JoinIn(BaseModel):
    """One more source table, LEFT JOINed onto a table already in the endpoint.

    LEFT and never INNER: a join is there to add columns to a row, and an inner join
    would silently drop rows whose reference is missing — which on this data (soft FKs
    to a lagging HCM mirror) is a routine state, not an error. An endpoint that quietly
    returns fewer rows than the table holds is the worst failure this builder has.

    `from_index` is what makes several tables chain rather than all hang off the base:
    -1 joins to the base table, 0 joins to the first extra table, 1 to the second, and
    so on. It may only point BACKWARD — a table cannot join to one added after it,
    which is also what makes the chain impossible to make circular.
    """
    table: str
    # -1 = the base table; otherwise the index of an earlier join.
    from_index: int = -1
    # `<from>.base_column = <table>.join_column`. Both sides checked against the schema.
    base_column: str
    join_column: str
    fields: list[FieldIn] = Field(default_factory=list, max_length=MAX_CONFIG_ENTRIES)

    @field_validator("table")
    @classmethod
    def _table(cls, value: str) -> str:
        return _identifier(value, "Table")

    @field_validator("base_column", "join_column")
    @classmethod
    def _cols(cls, value: str) -> str:
        return _identifier(value, "Column")


class WebhookWrite(BaseModel):
    """Registering a system that pushes INTO SCM.

    Note what is absent: no table, no column mapping, no SQL. `handler` names one of a
    closed set (`webhooks.HANDLERS`), because a screen that could point an inbound feed
    at a business table would be a way around every module's own service — and around
    rule 7 for stock in particular.
    """
    source: str = Field(min_length=2, max_length=39)
    name: str = Field(min_length=2, max_length=200)
    description: str | None = Field(default=None, max_length=500)
    #: The event names this source may send. Required: a webhook that accepts anything
    #: cannot be told apart from a misconfigured one.
    events: list[str] = Field(min_length=1, max_length=50)
    handler: str = "record"
    #: The API client whose key may push here. BLANK MEANS ANY LIVE KEY, which is how
    #: every webhook behaved before this field existed, so an existing registration is
    #: unchanged by its arrival. Set it and the mirror is reachable by one application
    #: only — hiding the URL is not the control, this is.
    client_code: str = Field(default="", max_length=50)
    #: Off only while two sides are being wired together, and it is recorded when it is.
    require_signature: bool = True
    is_active: bool = True

    @field_validator("client_code")
    @classmethod
    def _client_code(cls, value: str) -> str:
        # Upper-cased exactly as ClientWrite.code is, so the binding matches the code
        # the caller actually authenticates under rather than a look-alike of it.
        return (value or "").strip().upper().replace(" ", "_")


class WebhookOut(BaseModel):
    source: str
    name: str | None = None
    description: str | None = None
    events: list[str] = []
    handler: str = "record"
    #: Blank means any live key may push. Never a secret, so it is safe on the list.
    client_code: str = ""
    require_signature: bool = True
    #: Whether a secret exists, never the secret. Same posture as an API key.
    has_secret: bool = False
    is_active: bool = True
    url: str
    created_at: str | None = None
    created_by_name: str | None = None
    updated_at: str | None = None
    last_received_at: str | None = None
    received_count: int = 0
    last_sequence: int | None = None


class WebhookSecretOut(BaseModel):
    source: str
    shared_secret: str
    signature_header: str
    note: str


class EndpointImportIn(BaseModel):
    """An exported endpoint set, being pasted into this deployment.

    `clip` is taken as a free-form dict rather than a typed model on purpose: it may
    have come from another version, and the useful answer to that is
    "exported by a different version of the app" from `service._read_clip`, not a 422
    listing fields the person pasting has never heard of.
    """
    clip: dict
    #: Deactivate endpoints this application has that the clip does not mention.
    #: Off by default — pasting a partial set must not switch off what it omits.
    replace: bool = False


class ImportResultOut(BaseModel):
    created: int
    updated: int
    retired: int
    total: int


class EndpointWrite(BaseModel):
    slug: str
    name: str = Field(min_length=2, max_length=200)
    client_code: str = ""
    table: str
    fields: list[FieldIn] = Field(min_length=1, max_length=MAX_CONFIG_ENTRIES)
    joins: list[JoinIn] = Field(default_factory=list, max_length=8)
    # Always applied, whatever the caller sends. Keyed by the name the column comes
    # back under, so a joined column filters exactly like one of the base table's.
    filters: dict[str, str] = Field(default_factory=dict)
    # What a CALLER may narrow by at request time. A column not in this list is
    # ignored when it arrives as a query param — the endpoint decides its own surface.
    filterable: list[str] = Field(default_factory=list, max_length=MAX_CONFIG_ENTRIES)
    searchable: list[str] = Field(default_factory=list, max_length=MAX_CONFIG_ENTRIES)
    order_by: str = "id"
    order_dir: str = "asc"
    # The column `?updated_since=` applies to. Blank means the endpoint cannot be
    # pulled incrementally, which is the honest answer for a table with no timestamp.
    # `None` says the same thing and is what a JSON client sends for "not set", so it
    # is accepted and folded to blank rather than 422'd — the screen posts "", an API
    # caller posts null, and both mean "this endpoint has no change column".
    updated_column: str | None = ""
    default_size: int = Field(default=100, ge=1, le=MAX_EXT_PAGE_SIZE)
    max_size: int = Field(default=500, ge=1, le=MAX_EXT_PAGE_SIZE)
    is_active: bool = True

    @field_validator("slug")
    @classmethod
    def _slug(cls, value: str) -> str:
        value = (value or "").strip().lower().replace(" ", "-").replace("_", "-")
        if not re.match(SLUG_PATTERN, value):
            raise ValueError(
                "Address must be lowercase letters, digits and hyphens (2-60 characters)")
        return value

    @field_validator("table", "order_by")
    @classmethod
    def _ident(cls, value: str) -> str:
        return _identifier(value, "Name")

    @field_validator("updated_column")
    @classmethod
    def _updated(cls, value: str | None) -> str:
        return _identifier(value, "Column") if (value or "").strip() else ""

    @field_validator("order_dir")
    @classmethod
    def _dir(cls, value: str) -> str:
        value = (value or "asc").strip().lower()
        if value not in {"asc", "desc"}:
            raise ValueError("Sort direction must be asc or desc")
        return value

    @field_validator("filters")
    @classmethod
    def _clean_filters(cls, value: dict[str, str]) -> dict[str, str]:
        # An empty value is not a filter — it is a row somebody added and left blank,
        # and passing it to the query builder would match nothing at all.
        cleaned = {}
        for name, raw in (value or {}).items():
            text = str(raw).strip()
            if text:
                cleaned[_identifier(name, "Column")] = text
        return cleaned

    @field_validator("filterable", "searchable")
    @classmethod
    def _col_list(cls, value: list[str]) -> list[str]:
        return [_identifier(v, "Column") for v in (value or []) if str(v).strip()]


class EndpointOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    slug: str
    name: str
    client_code: str
    table: str
    fields: list[dict[str, Any]] = []
    joins: list[dict[str, Any]] = []
    filters: dict[str, str] = {}
    filterable: list[str] = []
    searchable: list[str] = []
    order_by: str = "id"
    order_dir: str = "asc"
    updated_column: str = ""
    default_size: int = 100
    max_size: int = 500
    is_active: bool = True
    url: str = ""
    output_columns: list[str] = []
    created_by_name: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class PreviewOut(BaseModel):
    """What the builder shows before anything is saved: the SQL it would run and the
    first few rows it would return. Composing an API blind is how a wrong one ships."""
    columns: list[str]
    rows: list[dict[str, Any]]
    sql: str
    total: int


# --------------------------------------------------------------------------- #
# Usage
# --------------------------------------------------------------------------- #

class CallLogOut(BaseModel):
    at: datetime
    client_code: str | None = None
    key_prefix: str | None = None
    slug: str | None = None
    status_code: int
    row_count: int | None = None
    duration_ms: int | None = None
    ip_address: str | None = None
    error: str | None = None


class UsageOut(BaseModel):
    calls: int
    errors: int
    rows: int
    last_called_at: datetime | None = None
    since_restart: bool = True
    by_endpoint: list[dict[str, Any]]


# --------------------------------------------------------------------------- #
# What an external caller sees
# --------------------------------------------------------------------------- #

class ExtPage(BaseModel):
    items: list[dict[str, Any]]
    total: int
    page: int
    size: int


class ExtEndpointOut(BaseModel):
    slug: str
    name: str
    url: str
    columns: list[str]
    filterable: list[str]
    searchable: bool
    max_size: int
    updated_since_supported: bool


# --------------------------------------------------------------------------- #
#  Platform links — what THIS app connects out to
# --------------------------------------------------------------------------- #
class LinkFieldOut(BaseModel):
    """One configuration line. `is_secret` rows carry a MASKED value and there is no
    route that returns the real one — see `platform_links._mask`."""
    label: str
    value: str | None = None
    is_secret: bool = False
    is_set: bool = False
    hint: str | None = None


class LinkActivityOut(BaseModel):
    at: datetime | None = None
    status: str | None = None
    detail: str | None = None


class PlatformLinkOut(BaseModel):
    code: str
    name: str
    kind: str
    direction: str
    icon: str | None = None
    endpoint: str | None = None
    configured: bool
    summary: str
    fields: list[LinkFieldOut] = []
    log_label: str | None = None
    has_log: bool = False
    last_activity: LinkActivityOut | None = None


class LinkLogRow(BaseModel):
    """One line of a link's own log, normalised so HCM syncs and sent mail render in
    the same table."""
    id: int
    at: datetime | None = None
    status: str
    subject: str | None = None
    detail: str | None = None
    error: str | None = None
    actor: str | None = None


class LinkTestOut(BaseModel):
    code: str
    ok: bool
    ms: int
    detail: str


class RevealedFieldOut(BaseModel):
    """One credential in the clear. Returned ONLY by the reveal route, which is a POST
    on `integration.keys.manage` and writes an audit row — never by a list or a get."""
    label: str
    value: str


class LinkRevealOut(BaseModel):
    code: str
    fields: list[RevealedFieldOut] = []


# --------------------------------------------------------------------------- #
# Activity Log
# --------------------------------------------------------------------------- #

class ActivityRowOut(BaseModel):
    """One thing that happened, in the same shape whichever source it came from.

    `headline` and `outcome_word` are the row as a person reads it; the status code
    and the reference are the evidence underneath. Both are served rather than
    assembled in the browser, so the wording of an event lives in one place.
    """
    id: str
    at: datetime | None = None
    direction: str            # IN (they sent) | OUT (they read)
    channel: str              # WEBHOOK | ADAPTER | APPLICATION
    channel_note: str = ""
    party: str
    party_code: str | None = None
    event: str
    outcome: str              # OK | DUPLICATE | FAILED
    outcome_word: str
    headline: str
    detail: str | None = None
    status_code: int | None = None
    rows: int | None = None
    reference: str | None = None
    request_id: str | None = None
    endpoint: str | None = None
    http_method: str | None = None
    ip_address: str | None = None
    remote_port: int | None = None
    local_ip_address: str | None = None
    local_port: int | None = None
    #: False for a row that came from the in-memory call ring, which empties on
    #: restart. The screen says so rather than showing a gap as silence.
    durable: bool = True


class ActivityFactOut(BaseModel):
    """One line of an event's record, already read out in plain words.

    Composed on the server for the same reason `headline` is: the three sources record
    different fields, and a browser that mapped each one would have to be edited every
    time a source learns to record something new.
    """
    field: str
    label: str
    value: str
    #: An identifier rather than a sentence - drawn in a monospaced face.
    mono: bool = False
    #: Too long for a line in a grid - drawn as its own block.
    block: bool = False


class ActivityServedOut(BaseModel):
    """The endpoint an application read, and every column it can ever return."""
    slug: str
    name: str
    table: str = ""
    columns: list[str] = []


class ActivityEventOut(ActivityRowOut):
    """One row of the log, opened - everything the source recorded about it.

    `payload` is the body that moved; `facts` is the rest of the record in plain
    words; `record` is that same record verbatim, for anyone who needs the field
    names rather than the labels.
    """
    payload: Any = None
    payload_label: str = ""
    payload_note: str = ""
    served: ActivityServedOut | None = None
    record: dict[str, Any] = {}
    facts: list[ActivityFactOut] = []


class ActivityPartyOut(BaseModel):
    party: str
    party_code: str | None = None
    channel: str
    total: int
    failed: int
    last_at: datetime | None = None


class ActivitySummaryOut(BaseModel):
    days: int
    total: int
    inbound: int
    outbound: int
    failed: int
    last_at: datetime | None = None
    last_failure_at: datetime | None = None
    reads_since_restart: bool = True
    by_party: list[ActivityPartyOut] = []


class ActivityOptionOut(BaseModel):
    code: str
    name: str


class ActivityFiltersOut(BaseModel):
    """Served, not hardcoded: an application or a webhook registered today is
    selectable today, with no change in the browser."""
    parties: list[ActivityOptionOut] = []
    channels: list[ActivityOptionOut] = []
    outcomes: list[ActivityOptionOut] = []
