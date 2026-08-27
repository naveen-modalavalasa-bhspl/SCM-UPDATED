"""All console logic. Routers stay 3-5 lines (rule 2).

Two halves that never mix:

  * the **console** — clients, keys, endpoints, preview, usage — driven by an SCM
    login through JWT + `require_permission`;
  * the **serving** half, `serve()`, driven by an API key, which can SELECT and
    nothing else.

The query builder is the heart of it. An endpoint definition is a document: a table,
the columns to expose, optional LEFT JOINs, pinned filters, an order and a page size.
Nothing in it reaches SQL as text — every identifier is checked for shape, looked up
in the live schema, and then used to build a SQLAlchemy Core construct, so the
statement is assembled from validated names and bound parameters rather than
concatenated.
"""
import logging
from datetime import date, datetime, timedelta
from decimal import Decimal
from time import perf_counter
from typing import Any, Mapping

from sqlalchemy import Select, and_, column, func, or_, select, table as sa_table
from sqlalchemy.dialects import mysql
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    AppException, ConflictError, NotFoundError, ValidationError,
)
from app.core.pagination import PageParams
from app.modules.integrations import introspect, security, store
from app.modules.integrations.enums import MAX_EXT_PAGE_SIZE
from app.modules.integrations.schemas import ClientWrite, EndpointWrite, KeyWrite
from app.modules.integrations.security import Caller, key_state, masked, new_key
from app.shared.time import now as ist_now

log = logging.getLogger("app.integrations")

# Query params that are controls rather than filters. Anything else is matched against
# the endpoint's own `filterable` list and ignored if it is not there — an unknown
# param is never an error, because a client library appending `?_=1234` for
# cache-busting must not take a nightly sync down.
CONTROL_PARAMS = {"page", "size", "search", "updated_since"}

EXT_PREFIX = "/api/ext/v1"

TRUE_WORDS = {"true", "yes", "y", "t"}
FALSE_WORDS = {"false", "no", "n", "f"}

PREVIEW_ROWS = 10


def endpoint_url(slug: str) -> str:
    """Relative on purpose: the host is the deployment's, never a literal in code."""
    return f"{EXT_PREFIX}/{slug}"


# --------------------------------------------------------------------------- #
# Clients
# --------------------------------------------------------------------------- #

async def list_clients(db: AsyncSession, params: PageParams,
                       search: str | None = None) -> dict:
    docs = await store.all_of(db, store.CLIENT)
    if search:
        needle = search.strip().lower()
        docs = [d for d in docs
                if needle in str(d.get("code", "")).lower()
                or needle in str(d.get("name", "")).lower()]
    docs.sort(key=lambda d: str(d.get("name", "")))
    total = len(docs)
    window = docs[params.offset:params.offset + params.size]
    items = [await _client_out(db, doc) for doc in window]
    return {"items": items, "total": total, "page": params.page, "size": params.size}


async def get_client(db: AsyncSession, code: str) -> dict:
    return await _client_out(db, await _client(db, code))


async def create_client(db: AsyncSession, data: ClientWrite, user) -> dict:
    if await store.get(db, store.client_key(data.code)) is not None:
        raise ConflictError(f"An application with code {data.code} already exists")
    doc = {
        **data.model_dump(),
        "created_by_name": getattr(user, "full_name", None),
        "created_at": ist_now().isoformat(),
    }
    await store.put(db, store.client_key(data.code), doc, f"API client {data.code}")
    await db.commit()
    return await _client_out(db, doc)


async def update_client(db: AsyncSession, code: str, data: ClientWrite) -> dict:
    doc = await _client(db, code)
    if data.code != code:
        # The code is the identity: every key and endpoint points at it by name, so
        # renaming would orphan them. Refused rather than silently rewritten.
        raise ValidationError(
            "An application's code cannot be changed — its keys and endpoints are "
            "filed under it. Register a new one instead.")
    doc.update(data.model_dump())
    await store.put(db, store.client_key(code), doc)
    await db.commit()
    return await _client_out(db, doc)


async def _client(db: AsyncSession, code: str) -> dict:
    doc = await store.get(db, store.client_key(code))
    if doc is None:
        raise NotFoundError("API client not found")
    return doc


async def _client_out(db: AsyncSession, doc: dict) -> dict:
    code = str(doc.get("code", ""))
    keys = [k for k in await store.all_of(db, store.KEY)
            if k.get("client_code") == code]
    endpoints = [e for e in await store.all_of(db, store.ENDPOINT)
                 if e.get("client_code") == code and e.get("is_active", True)]
    calls = security.calls_for(code)
    return {
        **doc,
        "active_keys": sum(1 for k in keys if key_state(k) == "ACTIVE"),
        "endpoints": len(endpoints),
        "last_called_at": calls[0]["at"] if calls else None,
    }


# --------------------------------------------------------------------------- #
# Keys
# --------------------------------------------------------------------------- #

async def list_keys(db: AsyncSession, code: str) -> list[dict]:
    await _client(db, code)
    docs = [k for k in await store.all_of(db, store.KEY) if k.get("client_code") == code]
    docs.sort(key=lambda d: str(d.get("created_at", "")), reverse=True)
    return [_key_out(doc) for doc in docs]


async def issue_key(db: AsyncSession, code: str, data: KeyWrite, user) -> dict:
    await _client(db, code)
    scopes = await _valid_scopes(db, code, data.scopes)
    raw, prefix, digest = new_key()
    doc = {
        "client_code": code, "label": data.label.strip(), "key_prefix": prefix,
        "key_hash": digest, "scopes": scopes,
        "rate_limit_per_min": data.rate_limit_per_min,
        "expires_at": data.expires_at.isoformat() if data.expires_at else None,
        "last_used_at": None, "revoked_at": None, "revoked_by_name": None,
        "created_by_name": getattr(user, "full_name", None),
        "created_at": ist_now().isoformat(),
    }
    await store.put(db, store.key_key(prefix), doc, f"API key for {code}")
    await db.commit()
    log.info("API key %s issued for %s by %s", prefix, code,
             getattr(user, "full_name", "?"))
    # The only time the raw value leaves this process.
    return {**_key_out(doc), "api_key": raw}


async def revoke_key(db: AsyncSession, prefix: str, user) -> dict:
    doc = await store.get(db, store.key_key(prefix))
    if doc is None:
        raise NotFoundError("API key not found")
    if doc.get("revoked_at"):
        raise ValidationError("That key is already revoked")
    # Revoked, never deleted: usage entries point at this prefix, and "which key
    # pulled our stock last week" has to stay answerable after the key is retired.
    doc["revoked_at"] = ist_now().isoformat()
    doc["revoked_by_name"] = getattr(user, "full_name", None)
    await store.put(db, store.key_key(prefix), doc)
    await db.commit()
    log.info("API key %s revoked by %s", prefix, doc["revoked_by_name"] or "?")
    return _key_out(doc)


def _key_out(doc: dict) -> dict:
    out = {k: v for k, v in doc.items() if k != "key_hash"}
    out["masked_key"] = masked(str(doc.get("key_prefix", "")))
    out["state"] = key_state(doc)
    return out


async def _valid_scopes(db: AsyncSession, code: str, scopes: list[str]) -> list[str]:
    """Scopes are endpoint slugs belonging to this client. Empty means all of them."""
    if not scopes:
        return []
    owned = {e["slug"] for e in await store.all_of(db, store.ENDPOINT)
             if e.get("client_code") == code}
    unknown = sorted(set(scopes) - owned)
    if unknown:
        raise ValidationError(
            f"{code} has no endpoint(s): {', '.join(unknown)}")
    return sorted(set(scopes))


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #

async def list_endpoints(db: AsyncSession, code: str) -> list[dict]:
    await _client(db, code)
    docs = [e for e in await store.all_of(db, store.ENDPOINT)
            if e.get("client_code") == code]
    docs.sort(key=lambda d: str(d.get("slug", "")))
    return [_endpoint_out(doc) for doc in docs]


async def save_endpoint(db: AsyncSession, code: str, data: EndpointWrite, user,
                        replacing: str | None = None) -> dict:
    """Create, or replace the endpoint at `replacing`. One path, because creating and
    editing validate identically and two paths drift."""
    await _client(db, code)
    await validate(db, data)

    existing = await store.get(db, store.endpoint_key(data.slug))
    if existing is not None and data.slug != replacing:
        raise ConflictError(f"The address /{data.slug} is already in use")
    if existing is not None and existing.get("client_code") != code:
        raise ConflictError(f"The address /{data.slug} belongs to another application")

    previous = (await store.get(db, store.endpoint_key(replacing))
                if replacing else None)
    doc = {
        **data.model_dump(),
        "client_code": code,
        "created_by_name": (previous or {}).get("created_by_name")
                           or getattr(user, "full_name", None),
        "created_at": (previous or {}).get("created_at") or ist_now().isoformat(),
        "updated_at": ist_now().isoformat(),
    }
    if replacing and replacing != data.slug:
        # The address moved. Drop the old row rather than leaving a live endpoint
        # nobody can see on the screen.
        await store.drop(db, store.endpoint_key(replacing))
    await store.put(db, store.endpoint_key(data.slug), doc,
                    f"API endpoint /{data.slug} for {code}")
    await db.commit()
    return _endpoint_out(doc)


# --------------------------------------------------------------------------- #
#  Moving a whole API surface between deployments
# --------------------------------------------------------------------------- #
#
# 122 endpoints composed by hand on one machine and then composed again by hand on
# the next is not a migration, it is a week of clicking with a typo in it. The
# definitions are already JSON documents (see store.py), so they travel as JSON.
#
# What deliberately does NOT travel:
#
#   * API KEYS. Only a hash is ever stored, so there is nothing to copy even if we
#     wanted to — and a key that worked on two deployments would mean revoking it in
#     one place left it live in the other. Each side mints its own.
#   * `created_by_name` / `created_at` / usage. Those describe what happened on the
#     machine the clip came FROM and would be a lie on the machine it lands on.
#
# An import validates every endpoint against the TARGET database through the same
# `validate()` the console uses, so a clip can never introduce a table this
# deployment does not have, a column it does not have, or a table on the blocked
# list. A clip is data, not a trust boundary.

CLIP_KIND = "scm-api-endpoints"
CLIP_VERSION = 1

#: Written by the machine the clip came from, meaningless on the one it lands on.
_LOCAL_ONLY_FIELDS = ("client_code", "created_by_name", "created_at", "updated_at")


async def export_endpoints(db: AsyncSession, code: str) -> dict:
    """Every endpoint of one application, as a clip that can be pasted elsewhere."""
    client = await _client(db, code)
    docs = [e for e in await store.all_of(db, store.ENDPOINT)
            if e.get("client_code") == code]
    docs.sort(key=lambda d: str(d.get("slug", "")))
    return {
        "v": CLIP_VERSION,
        "kind": CLIP_KIND,
        "client_code": code,
        "client_name": client.get("name") or code,
        "exported_at": ist_now().isoformat(),
        "endpoints": [
            {k: v for k, v in doc.items() if k not in _LOCAL_ONLY_FIELDS}
            for doc in docs
        ],
    }


def _read_clip(clip: dict) -> list[dict]:
    """The endpoint list out of a clip, or a plain-English reason it cannot be used."""
    if not isinstance(clip, dict) or clip.get("kind") != CLIP_KIND:
        raise ValidationError("That is not an exported set of API endpoints.")
    if clip.get("v") != CLIP_VERSION:
        raise ValidationError(
            "That set was exported by a different version of the app.")
    endpoints = clip.get("endpoints")
    if not isinstance(endpoints, list) or not endpoints:
        raise ValidationError("That set contains no endpoints.")
    return endpoints


async def import_endpoints(db: AsyncSession, code: str, clip: dict, user,
                           replace: bool = False) -> dict:
    """Apply an exported set to this deployment. ALL-OR-NOTHING.

    Every endpoint is validated against THIS database first and a single bad one
    rejects the whole clip with the full list of problems — the same rule the masters
    importer follows, and for the same reason: a half-applied API surface cannot be
    re-pasted safely, because the second attempt collides with the half that landed.

    `replace=True` deactivates endpoints this application has that the clip does not
    mention. Off by default: pasting a partial set must not silently switch off
    everything it happens to omit.
    """
    await _client(db, code)
    endpoints = _read_clip(clip)

    parsed: list[EndpointWrite] = []
    problems: list[str] = []
    for index, raw in enumerate(endpoints, start=1):
        slug = (raw or {}).get("slug") or f"#{index}"
        try:
            data = EndpointWrite(**{**raw, "client_code": code})
            await validate(db, data)
            parsed.append(data)
        except ValidationError as exc:
            problems.append(f"{slug}: {exc.message if hasattr(exc, 'message') else exc}")
        except Exception as exc:  # noqa: BLE001 — a bad clip must read as a bad clip
            problems.append(f"{slug}: {exc}")

    # Another application already owning an address is a problem with the clip, not a
    # thing to discover halfway through writing it.
    for data in parsed:
        existing = await store.get(db, store.endpoint_key(data.slug))
        if existing is not None and existing.get("client_code") != code:
            problems.append(
                f"{data.slug}: that address already belongs to "
                f"{existing.get('client_code')}")

    if problems:
        raise ValidationError(
            f"{len(problems)} of {len(endpoints)} endpoints could not be imported, so "
            f"none were: " + "; ".join(problems[:10])
            + (f" (and {len(problems) - 10} more)" if len(problems) > 10 else ""))

    now = ist_now().isoformat()
    arriving = {data.slug for data in parsed}
    created = updated = 0
    for data in parsed:
        previous = await store.get(db, store.endpoint_key(data.slug))
        doc = {
            **data.model_dump(),
            "client_code": code,
            # An endpoint that was already here keeps its own history; a new one is
            # stamped with the person who pasted it, not whoever built it elsewhere.
            "created_by_name": (previous or {}).get("created_by_name")
                               or getattr(user, "full_name", None),
            "created_at": (previous or {}).get("created_at") or now,
            "updated_at": now,
        }
        await store.put(db, store.endpoint_key(data.slug), doc,
                        f"API endpoint /{data.slug} for {code}")
        if previous is None:
            created += 1
        else:
            updated += 1

    retired = 0
    if replace:
        for doc in await store.all_of(db, store.ENDPOINT):
            if (doc.get("client_code") == code and doc.get("slug") not in arriving
                    and doc.get("is_active")):
                doc["is_active"] = False
                doc["updated_at"] = now
                await store.put(db, store.endpoint_key(doc["slug"]), doc)
                retired += 1

    await db.commit()
    return {"created": created, "updated": updated, "retired": retired,
            "total": len(parsed)}


# --------------------------------------------------------------------------- #
#  Connection details — what you send a partner so they can start
# --------------------------------------------------------------------------- #
#
# Everything below is DERIVED from the endpoint documents. It is a view, never a
# second copy: a doc that has to be kept in step by hand is a doc that is wrong by the
# second week, and the whole point of composing endpoints in the console was that
# nobody edits code to add one.

async def connection_docs(db: AsyncSession, code: str, base_url: str = "") -> dict:
    """Base URL, auth, and every endpoint with what it accepts and returns."""
    client = await _client(db, code)
    docs = [e for e in await store.all_of(db, store.ENDPOINT)
            if e.get("client_code") == code and e.get("is_active")]
    docs.sort(key=lambda d: str(d.get("slug", "")))

    endpoints = []
    for doc in docs:
        returns = [f.get("label") or f.get("column")
                   for f in (doc.get("fields") or [])]
        for join in (doc.get("joins") or []):
            for field in (join.get("fields") or []):
                returns.append(field.get("label")
                               or f"{join.get('table')}_{field.get('column')}")
        params = []
        for name in (doc.get("filterable") or []):
            params.append({"name": name, "kind": "filter",
                           "note": f"exact match on {name}"})
        if doc.get("searchable"):
            params.append({"name": "search", "kind": "search",
                           "note": "partial match across "
                                   + ", ".join(doc["searchable"])})
        if doc.get("updated_column"):
            params.append({"name": "updated_since", "kind": "incremental",
                           "note": f"ISO date/time; returns rows whose "
                                   f"{doc['updated_column']} is newer"})
        params.append({"name": "page", "kind": "paging", "note": "1-based"})
        params.append({"name": "size", "kind": "paging",
                       "note": f"default {doc.get('default_size')}, "
                               f"max {doc.get('max_size')}"})
        endpoints.append({
            "slug": doc.get("slug"),
            "name": doc.get("name"),
            "path": f"/api/ext/v1/{doc.get('slug')}",
            "url": f"{base_url.rstrip('/')}/api/ext/v1/{doc.get('slug')}"
                   if base_url else f"/api/ext/v1/{doc.get('slug')}",
            "returns": returns,
            "params": params,
        })

    return {
        "client_code": code,
        "client_name": client.get("name") or code,
        "base_url": base_url.rstrip("/"),
        "auth": {
            "header": "X-API-Key",
            "note": ("Every request carries the key issued for this application. "
                     "It is shown once when issued and cannot be displayed again."),
        },
        "conventions": {
            "paging": "Every list answers {items, total, page, size}.",
            "incremental": ("Endpoints with an updated_since parameter can be pulled "
                            "incrementally; the rest must be read in full."),
            "errors": "A failure answers {success: false, error: \"...\"}.",
        },
        "probe": {
            "path": "/api/ext/v1/_ping",
            "note": "Confirms the key works and names the application it belongs to.",
        },
        "directory": {
            "path": "/api/ext/v1/_endpoints",
            "note": "Everything this key may call, read from the server.",
        },
        "endpoints": endpoints,
    }


async def endpoint_sample(db: AsyncSession, slug: str, rows: int = 2) -> dict:
    """A real response from one saved endpoint, so the shape is seen and not imagined.

    Runs the endpoint exactly as an API key would (`serve`), just with a small page —
    a documented shape that is written by hand drifts from the one that is served, and
    the drift is only ever found by the partner.
    """
    doc = await _endpoint(db, slug)
    return await serve(db, doc, {"size": str(max(1, min(rows, 5)))})


async def delete_endpoint(db: AsyncSession, slug: str) -> dict:
    """Deactivates rather than deletes, so usage entries keep their meaning."""
    doc = await _endpoint(db, slug)
    doc["is_active"] = False
    doc["updated_at"] = ist_now().isoformat()
    await store.put(db, store.endpoint_key(slug), doc)
    await db.commit()
    return _endpoint_out(doc)


async def _endpoint(db: AsyncSession, slug: str) -> dict:
    doc = await store.get(db, store.endpoint_key(slug))
    if doc is None:
        raise NotFoundError("Endpoint not found")
    return doc


def _endpoint_out(doc: dict) -> dict:
    return {**doc, "url": endpoint_url(str(doc.get("slug", ""))),
            "output_columns": output_columns(doc)}


def output_columns(doc: Mapping[str, Any]) -> list[str]:
    """The column names a consumer will see, base columns then each join's."""
    return [name for name, _, _ in _exposed(doc)]


BASE = -1   # `from_index` value meaning "the endpoint's base table"


def _exposed(doc: Mapping[str, Any]) -> list[tuple[str, int, str]]:
    """`(output name, owner index, real column)` for every column the endpoint returns.

    Owner index is -1 for the base table and the join's position otherwise, which is
    what lets a filter name a joined column without the caller knowing it was joined.
    """
    out: list[tuple[str, int, str]] = [
        (f.get("label") or f["column"], BASE, f["column"])
        for f in doc.get("fields", []) or []
    ]
    for index, join in enumerate(doc.get("joins", []) or []):
        for field in join.get("fields", []) or []:
            label = field.get("label") or f"{join['table']}_{field['column']}"
            out.append((label, index, field["column"]))
    return out


def _resolver(doc: Mapping[str, Any]) -> dict[str, tuple[int, str]]:
    """Name a caller or an endpoint may use -> the table and column it means.

    Two things resolve: the output name of any exposed column (so a joined column is
    filterable under the name it comes back as), and any raw column of the BASE table
    (so an endpoint can pin `is_active=1` without also having to expose it).
    """
    found: dict[str, tuple[int, str]] = {}
    for name, owner, column in _exposed(doc):
        found.setdefault(name, (owner, column))
    return found


def _table_name(doc: Mapping[str, Any], index: int) -> str:
    joins = doc.get("joins") or []
    return str(doc["table"]) if index == BASE else str(joins[index]["table"])


# --------------------------------------------------------------------------- #
# Validation — everything an endpoint claims must exist in the live schema
# --------------------------------------------------------------------------- #

async def validate(db: AsyncSession, data: EndpointWrite) -> None:
    doc = data.model_dump()

    # 1. The join chain has to be a chain: every join points at the base or at a table
    #    added BEFORE it. Backward-only is also what makes a cycle unrepresentable.
    for index, join in enumerate(data.joins):
        if join.from_index != BASE and not (0 <= join.from_index < index):
            raise ValidationError(
                f"'{join.table}' is joined to a table that does not come before it. "
                f"A table can only join to the base table or to one added earlier.")

    # 2. Every column each table is asked for actually exists on THAT table.
    needed: dict[int, set[str]] = {BASE: {f.column for f in data.fields}}
    for index, join in enumerate(data.joins):
        needed[index] = {f.column for f in join.fields} | {join.join_column}
        needed.setdefault(join.from_index, set()).add(join.base_column)

    # 3. Filters, search, sort and the change column are named the way the endpoint
    #    returns them, so they resolve through the same map a caller's query does.
    resolve = _resolver(doc)
    base_columns = await introspect.require_table(db, data.table)
    for name in set(data.filters) | set(data.filterable) | set(data.searchable) \
            | {data.order_by} | ({data.updated_column} if data.updated_column else set()):
        if name in resolve:
            owner, column = resolve[name]
            needed.setdefault(owner, set()).add(column)
        elif name in base_columns:
            needed[BASE].add(name)      # a base column pinned but not exposed
        else:
            raise ValidationError(
                f"'{name}' is not a column this endpoint returns, and {data.table} "
                f"does not have it either.")

    for owner, columns in needed.items():
        await introspect.require_columns(db, _table_name(doc, owner), sorted(columns))

    if data.max_size < data.default_size:
        raise ValidationError("Maximum page size cannot be below the default page size")

    names = output_columns(data.model_dump())
    duplicates = sorted({n for n in names if names.count(n) > 1})
    if duplicates:
        raise ValidationError(
            f"Two columns would be returned under the same name: {', '.join(duplicates)}. "
            f"Give one of them a label.")


# --------------------------------------------------------------------------- #
# The query builder
# --------------------------------------------------------------------------- #

def build(doc: Mapping[str, Any], query: Mapping[str, str] | None = None) -> Select:
    """The SELECT an endpoint definition describes, with the caller's narrowing applied.

    Built from `sqlalchemy.table()`/`column()` on names that were validated against the
    live schema before they were stored — so this assembles a Core construct, and every
    VALUE travels as a bound parameter.
    """
    query = query or {}
    fields = list(doc.get("fields") or [])
    if not fields:
        raise ValidationError("This endpoint exposes no columns")

    joins = list(doc.get("joins") or [])
    filters = dict(doc.get("filters") or {})
    filterable = set(doc.get("filterable") or [])
    searchable = list(doc.get("searchable") or [])
    order_by = str(doc.get("order_by") or "id")
    updated_column = str(doc.get("updated_column") or "")
    resolve = _resolver(doc)

    def owner_of(name: str) -> tuple[int, str]:
        """Which table a name means. Unknown names fall back to the base table, where
        `require_columns` has already established they exist."""
        return resolve.get(name, (BASE, name))

    # A TableClause only knows the columns it is handed, so gather per table every
    # name this statement will touch — selected, joined on, filtered, searched, sorted.
    needed: dict[int, set[str]] = {BASE: {f["column"] for f in fields}}
    for index, join in enumerate(joins):
        needed[index] = {f["column"] for f in (join.get("fields") or [])} \
            | {join["join_column"]}
        needed.setdefault(int(join.get("from_index", BASE)), set()).add(join["base_column"])
    for name in set(filters) | filterable | set(searchable) | {order_by} \
            | ({updated_column} if updated_column else set()):
        owner, real = owner_of(name)
        needed.setdefault(owner, set()).add(real)

    # Each table gets its own alias, so the same table may appear twice in one endpoint
    # without MySQL calling the column reference ambiguous.
    clauses: dict[int, Any] = {
        BASE: sa_table(str(doc["table"]),
                       *[column(n) for n in sorted(needed[BASE])]).alias("t0"),
    }
    source = clauses[BASE]
    for index, join in enumerate(joins):
        clauses[index] = sa_table(
            str(join["table"]),
            *[column(n) for n in sorted(needed.get(index, {join["join_column"]}))],
        ).alias(f"j{index}")
        left = clauses[int(join.get("from_index", BASE))]
        # LEFT, always — see JoinIn. isouter=True keeps a row whose reference is
        # missing, which on soft FKs to the HCM mirror is routine, not an error.
        source = source.join(
            clauses[index],
            left.c[join["base_column"]] == clauses[index].c[join["join_column"]],
            isouter=True)

    def col(name: str):
        owner, real = owner_of(name)
        return clauses[owner].c[real]

    selected = [clauses[owner].c[real].label(name)
                for name, owner, real in _exposed(doc)]
    stmt = select(*selected).select_from(source)

    conditions = []
    # Pinned first. A caller's own filter is ANDed on top, so it can only narrow.
    for name, raw in filters.items():
        conditions.append(_condition(col(name), str(raw)))
    for name, raw in query.items():
        if name in CONTROL_PARAMS or name not in filterable:
            continue
        value = (raw or "").strip()
        if value:
            conditions.append(_condition(col(name), value))

    search = (query.get("search") or "").strip()
    if search and searchable:
        like = f"%{search}%"
        conditions.append(or_(*[col(c).like(like) for c in searchable]))

    since = (query.get("updated_since") or "").strip()
    if since:
        if not updated_column:
            raise ValidationError(
                "This endpoint has no change column, so updated_since cannot be "
                "applied — pull it whole.")
        conditions.append(col(updated_column) >= _as_datetime(since))

    if conditions:
        stmt = stmt.where(and_(*conditions))

    order_column = col(order_by)
    return stmt.order_by(
        order_column.desc() if str(doc.get("order_dir")) == "desc"
        else order_column.asc())


def _condition(col, raw: str):
    """`a,b` is an IN list; `true`/`false` become 1/0 so a flag filters correctly."""
    values = [_coerce(v.strip()) for v in raw.split(",") if v.strip()]
    if not values:
        raise ValidationError("A filter cannot be empty")
    return col.in_(values) if len(values) > 1 else col == values[0]


def _coerce(value: str):
    lowered = value.lower()
    if lowered in TRUE_WORDS:
        return 1
    if lowered in FALSE_WORDS:
        return 0
    return value


def _int_param(query: Mapping[str, str], name: str, default: int) -> int:
    raw = (query.get(name) or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ValidationError(f"{name} must be a whole number") from exc


def _as_datetime(value: str) -> datetime:
    """Accepts a date or a full timestamp. A bare date means midnight that day."""
    text = value.strip().replace("Z", "").replace(" ", "T")
    try:
        if len(text) <= 10:
            return datetime.combine(date.fromisoformat(text[:10]), datetime.min.time())
        # A caller sending +05:30 means the same wall clock the column stores, so the
        # offset is dropped rather than converted (see shared/time.py).
        return datetime.fromisoformat(text[:26].split("+")[0])
    except ValueError as exc:
        raise ValidationError(
            "updated_since must be YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS") from exc


def _jsonable(row: dict) -> dict:
    """Decimals as strings, timestamps as ISO. Never float: a quantity of 0.1 that
    survives NUMERIC(16,3) must not become 0.09999999999999999 in transit."""
    out: dict[str, Any] = {}
    for name, value in row.items():
        if isinstance(value, Decimal):
            out[name] = str(value)
        elif isinstance(value, (datetime, date)):
            out[name] = value.isoformat()
        elif isinstance(value, (bytes, bytearray)):
            out[name] = value.decode("utf-8", "replace")
        else:
            out[name] = value
    return out


def sql_text(stmt: Select) -> str:
    """The statement as MySQL would see it, for the builder's preview panel."""
    return str(stmt.compile(dialect=mysql.dialect(),
                            compile_kwargs={"literal_binds": True}))


# --------------------------------------------------------------------------- #
# Preview — what the builder shows before anything is saved
# --------------------------------------------------------------------------- #

async def preview(db: AsyncSession, code: str, data: EndpointWrite) -> dict:
    await _client(db, code)
    await validate(db, data)
    doc = {**data.model_dump(), "client_code": code}
    stmt = build(doc, {})
    total = await db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = (await db.execute(stmt.limit(PREVIEW_ROWS))).all()
    return {
        "columns": output_columns(doc),
        "rows": [_jsonable(dict(row._mapping)) for row in rows],
        "sql": sql_text(stmt),
        "total": total,
    }


# --------------------------------------------------------------------------- #
# Usage
# --------------------------------------------------------------------------- #

async def call_logs(db: AsyncSession, code: str, params: PageParams,
                    errors_only: bool = False) -> dict:
    await _client(db, code)
    entries = security.calls_for(code)
    if errors_only:
        entries = [e for e in entries if e.get("status_code", 200) >= 400]
    total = len(entries)
    window = entries[params.offset:params.offset + params.size]
    return {"items": window, "total": total, "page": params.page, "size": params.size}


async def usage(db: AsyncSession, code: str) -> dict:
    await _client(db, code)
    entries = security.calls_for(code)
    by_slug: dict[str, dict] = {}
    for entry in entries:
        slug = entry.get("slug") or "—"
        row = by_slug.setdefault(slug, {"slug": slug, "calls": 0, "rows": 0,
                                        "last_called_at": None})
        row["calls"] += 1
        row["rows"] += int(entry.get("row_count") or 0)
        if row["last_called_at"] is None:
            row["last_called_at"] = entry["at"]
    return {
        "calls": len(entries),
        "errors": sum(1 for e in entries if e.get("status_code", 200) >= 400),
        "rows": sum(int(e.get("row_count") or 0) for e in entries),
        "last_called_at": entries[0]["at"] if entries else None,
        # Said out loud on the screen: this module owns no table, so the log is a ring
        # buffer that starts empty after every restart.
        "since_restart": True,
        "by_endpoint": sorted(by_slug.values(), key=lambda r: -r["calls"]),
    }


# --------------------------------------------------------------------------- #
# Serving an external caller
# --------------------------------------------------------------------------- #

async def resolve(db: AsyncSession, slug: str, caller: Caller) -> dict:
    """The endpoint this key may call, or the reason it may not."""
    doc = await store.get(db, store.endpoint_key((slug or "").strip().lower()))
    if doc is None or not doc.get("is_active", True):
        raise NotFoundError(f"No endpoint at /{slug}")
    if doc.get("client_code") != caller.client_code:
        # Deliberately the same message as "not found": a key must not be able to
        # enumerate another application's endpoints by watching which slugs 403.
        raise NotFoundError(f"No endpoint at /{slug}")
    caller.require_scope(str(doc.get("slug")))
    return doc


async def serve(db: AsyncSession, doc: Mapping[str, Any],
                query: Mapping[str, str]) -> dict:
    """One page of one endpoint. The only read an API key can perform."""
    size = _int_param(query, "size", int(doc.get("default_size") or 100))
    size = max(1, min(size, int(doc.get("max_size") or 500), MAX_EXT_PAGE_SIZE))
    page = max(1, _int_param(query, "page", 1))

    stmt = build(doc, query)
    total = await db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = (await db.execute(stmt.offset((page - 1) * size).limit(size))).all()
    return {
        "items": [_jsonable(dict(row._mapping)) for row in rows],
        "total": total, "page": page, "size": size,
    }


async def serve_logged(db: AsyncSession, slug: str, caller: Caller,
                       query: Mapping[str, str], *, ip: str | None = None) -> dict:
    """`serve()` with the call recorded either way.

    The refusal is recorded before it is re-raised, because "why is this integration
    getting a 403" is the question the Usage screen exists to answer.
    """
    started = perf_counter()
    try:
        doc = await resolve(db, slug, caller)
        result = await serve(db, doc, query)
    except AppException as exc:
        security.record(caller.client_code, key_prefix=caller.prefix, slug=slug,
                        status_code=exc.status_code, duration_ms=_elapsed(started),
                        ip_address=ip, error=exc.message)
        raise
    security.record(caller.client_code, key_prefix=caller.prefix, slug=slug,
                    status_code=200, row_count=len(result["items"]),
                    duration_ms=_elapsed(started), ip_address=ip)
    return result


def _elapsed(started: float) -> int:
    return int((perf_counter() - started) * 1000)


async def visible_endpoints(db: AsyncSession, caller: Caller) -> list[dict]:
    """What this key can actually call — where a new consumer starts."""
    docs = [e for e in await store.all_of(db, store.ENDPOINT)
            if e.get("client_code") == caller.client_code and e.get("is_active", True)]
    scopes = set(caller.scopes)
    return [
        {
            "slug": doc["slug"], "name": doc.get("name", doc["slug"]),
            "url": endpoint_url(doc["slug"]),
            "columns": output_columns(doc),
            "filterable": list(doc.get("filterable") or []),
            "searchable": bool(doc.get("searchable")),
            "max_size": int(doc.get("max_size") or 500),
            "updated_since_supported": bool(doc.get("updated_column")),
        }
        for doc in sorted(docs, key=lambda d: d["slug"])
        if not scopes or doc["slug"] in scopes
    ]
