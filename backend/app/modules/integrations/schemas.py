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
    scopes: list[str] = Field(default_factory=list)
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


class KeyIssuedOut(KeyOut):
    """The one response that ever carries the raw key. Not stored, not repeatable."""
    api_key: str
    warning: str = ("Copy this key now — only a hash is saved and it cannot be shown "
                    "again. Issue a new one if it is lost.")


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
    fields: list[FieldIn] = Field(default_factory=list)

    @field_validator("table")
    @classmethod
    def _table(cls, value: str) -> str:
        return _identifier(value, "Table")

    @field_validator("base_column", "join_column")
    @classmethod
    def _cols(cls, value: str) -> str:
        return _identifier(value, "Column")


class EndpointWrite(BaseModel):
    slug: str
    name: str = Field(min_length=2, max_length=200)
    client_code: str = ""
    table: str
    fields: list[FieldIn] = Field(min_length=1)
    joins: list[JoinIn] = Field(default_factory=list, max_length=8)
    # Always applied, whatever the caller sends. Keyed by the name the column comes
    # back under, so a joined column filters exactly like one of the base table's.
    filters: dict[str, str] = Field(default_factory=dict)
    # What a CALLER may narrow by at request time. A column not in this list is
    # ignored when it arrives as a query param — the endpoint decides its own surface.
    filterable: list[str] = Field(default_factory=list)
    searchable: list[str] = Field(default_factory=list)
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
