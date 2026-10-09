"""The generic source picker: what the live database actually contains.

There is no curated list of feeds. The builder reads `information_schema` for the
schema the app is connected to, so any table SCM already has can be served the day
somebody asks for it — masters, stock, indents, purchase orders, warehouse documents,
the HCM mirror, the approval trail. A new table appears in the picker the moment its
migration runs, with no code change here.

Which makes the two lists below the whole security boundary, so they are stated once,
here, and enforced on every path in and out:

  * `BLOCKED_TABLES` — tables that are not business data. Credentials, sessions, and
    `sys_settings` itself, which is where this module keeps the API keys: an endpoint
    over `sys_settings` would hand a consumer every key hash and every scope in the
    console.
  * `BLOCKED_COLUMNS` — a name pattern, applied to every table. Passwords, hashes,
    tokens, bank and salary fields. CLAUDE.md rule 10 already forbids pulling
    bank/salary/EPFO data out of HCM; this keeps it out of the API surface too, even
    if a column like that ever lands in the mirror.

Nothing composed in the UI reaches SQL as text. Every identifier is matched against
`IDENTIFIER_PATTERN` for shape, then looked up in this schema map for existence — a
name that fails either is refused, never escaped and passed along.
"""
import re
import time

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.modules.integrations.enums import IDENTIFIER_PATTERN

# Not business data. Serving any of these is a credential leak, not a feature.
BLOCKED_TABLES: frozenset[str] = frozenset({
    "sys_local_credentials",   # password hashes
    "sys_user_credentials",    # the name doc 02 uses for the same thing
    "sys_sessions",            # live JWT ids
    "sys_settings",            # where THIS module stores its API keys
    "alembic_version",
    # ADDED 2026-08-26. These were on offer in the picker and are not business data.
    # The column filter alone is not enough for them: it strips `token_hash`, but the
    # rest of a reset row — which account, from which IP, still live or not — is a map
    # of who is currently able to take over an account, and a claim row is an
    # employee's personal address. Neither belongs behind an outside application's key.
    "sys_password_resets",     # live password-reset attempts
    "sys_email_claims",        # staff personal addresses awaiting confirmation
    "sys_mail_messages",       # everything this app has sent, bodies included
})

# Applied to every column of every table. Substring match on a lower-cased name.
BLOCKED_COLUMNS = re.compile(
    r"password|passwd|pwd|secret|token|_hash|hash_|^hash$|salt|otp|"
    r"bank|ifsc|account_no|salary|ctc|epfo|uan|aadha|pan_no|pan_number|api_key",
    re.IGNORECASE,
)

# information_schema is not free, and the schema changes when a migration runs, not
# between two requests. Cached per process with a short life so a deploy is picked up
# without a restart.
_CACHE: dict[str, dict[str, str]] = {}
_CACHED_AT: float = 0.0
CACHE_SECONDS = 300

_IDENTIFIER = re.compile(IDENTIFIER_PATTERN)

# Which module a table belongs to, for grouping the picker. Prefixes are the ones
# CLAUDE.md assigns; anything else is grouped as "Other" rather than hidden.
GROUPS: list[tuple[str, str]] = [
    ("mst_", "Masters"),
    ("stk_", "Stock"),
    ("inv_", "Inventory"),
    ("ind_", "Indents"),
    ("pro_", "Procurement"),
    ("whs_", "Warehouse"),
    ("lgs_", "Logistics"),
    ("wf_", "Approvals"),
    ("hcm_", "People (HCM mirror)"),
    ("rbac_", "Access control"),
    ("sys_", "System"),
]


def group_of(table: str) -> str:
    for prefix, label in GROUPS:
        if table.startswith(prefix):
            return label
    return "Other"


def is_identifier(name: str) -> bool:
    return bool(_IDENTIFIER.match(name or ""))


def column_is_blocked(name: str) -> bool:
    return bool(BLOCKED_COLUMNS.search(name or ""))


async def schema(db: AsyncSession, refresh: bool = False) -> dict[str, dict[str, str]]:
    """`{table: {column: data_type}}` for the connected schema, already filtered.

    Blocked tables and blocked columns are dropped HERE, at the single point every
    caller reads from — so a validator, the picker and the query builder cannot
    disagree about what is visible.
    """
    global _CACHED_AT
    if not refresh and _CACHE and (time.monotonic() - _CACHED_AT) < CACHE_SECONDS:
        return _CACHE

    rows = (await db.execute(text(
        "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE "
        "FROM information_schema.COLUMNS "
        "WHERE TABLE_SCHEMA = DATABASE() "
        "ORDER BY TABLE_NAME, ORDINAL_POSITION"
    ))).all()

    built: dict[str, dict[str, str]] = {}
    for table_name, column_name, data_type in rows:
        if table_name in BLOCKED_TABLES or not is_identifier(table_name):
            continue
        if column_is_blocked(column_name) or not is_identifier(column_name):
            continue
        built.setdefault(table_name, {})[column_name] = str(data_type)

    _CACHE.clear()
    _CACHE.update(built)
    _CACHED_AT = time.monotonic()
    return _CACHE


def reset_cache() -> None:
    """Test hook, and what the console's Refresh button calls after a deploy."""
    global _CACHED_AT
    _CACHE.clear()
    _CACHED_AT = 0.0


async def tables(db: AsyncSession) -> list[dict]:
    """Every servable table, grouped, for the picker."""
    found = await schema(db)
    return [
        {"table": name, "group": group_of(name), "columns": len(columns)}
        for name, columns in sorted(found.items())
    ]


async def columns(db: AsyncSession, table: str) -> list[dict]:
    """One table's servable columns, with enough type information for the builder to
    know which ones can carry a date filter and which can be summed."""
    found = await schema(db)
    if table not in found:
        raise NotFoundError(f"No table named {table} is available")
    return [
        {
            "column": name,
            "type": data_type,
            "is_date": data_type in DATE_TYPES,
            "is_numeric": data_type in NUMERIC_TYPES,
        }
        for name, data_type in found[table].items()
    ]


DATE_TYPES = {"date", "datetime", "timestamp"}
NUMERIC_TYPES = {"int", "bigint", "smallint", "tinyint", "decimal", "float", "double"}


async def require_table(db: AsyncSession, table: str) -> dict[str, str]:
    """The columns of a table the caller is allowed to use, or the reason it is not."""
    if not is_identifier(table):
        raise ValidationError(f"'{table}' is not a valid table name")
    if table in BLOCKED_TABLES:
        raise ValidationError(
            f"{table} holds credentials or console configuration and can never be served")
    found = await schema(db)
    if table not in found:
        raise ValidationError(f"No table named {table} is available")
    return found[table]


async def require_columns(db: AsyncSession, table: str, names: list[str],
                          what: str = "column") -> list[str]:
    available = await require_table(db, table)
    for name in names:
        if not is_identifier(name):
            raise ValidationError(f"'{name}' is not a valid {what} name")
        if name not in available:
            reason = ("it is blocked as sensitive" if column_is_blocked(name)
                      else "it does not exist")
            raise ValidationError(f"{table}.{name} cannot be used: {reason}")
    return names
