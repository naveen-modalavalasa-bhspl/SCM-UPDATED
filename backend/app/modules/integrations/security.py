"""API-key issue, verification, rate limiting and the in-memory call log.

Kept out of `core/security.py` on purpose: that file is the login's password hashing
and JWT, and an integration key is neither. Nothing here touches a session, a JWT or
an employee — an API key is not a person and never becomes one.

The stored form is a SHA-256 of the whole key plus an indexed prefix. bcrypt (what
`sys_local_credentials` uses) is deliberately not reused: it costs ~100ms per verify,
which is right for a human password that can be guessed and wrong for a 256-bit random
secret that cannot.
"""
import hashlib
import logging
import secrets
from collections import defaultdict, deque
from datetime import datetime

from fastapi import Depends, Header, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.exceptions import AppException, AuthenticationError, PermissionError_
from app.modules.integrations import store
from app.modules.integrations.enums import CALL_LOG_SIZE, KeyState
from app.shared.time import now as ist_now

log = logging.getLogger("app.integrations")

KEY_NAMESPACE = "scm"
SEPARATOR = "."


class RateLimitError(AppException):
    status_code = 429


def new_key() -> tuple[str, str, str]:
    """`(raw, prefix, hash)`. The raw value is never persisted and never logged."""
    prefix = f"{KEY_NAMESPACE}_{secrets.token_hex(4)}"
    raw = f"{prefix}{SEPARATOR}{secrets.token_urlsafe(32)}"
    return raw, prefix, hash_key(raw)


def hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def split_prefix(raw: str) -> str | None:
    """The lookup handle, or None if the string is not shaped like one of our keys."""
    head, _, tail = (raw or "").strip().partition(SEPARATOR)
    if not tail or not head.startswith(f"{KEY_NAMESPACE}_") or len(head) > 24:
        return None
    return head


def masked(prefix: str) -> str:
    return f"{prefix}{SEPARATOR}{'•' * 8}"


def _stamp(value) -> datetime | None:
    if not value:
        return None
    return value if isinstance(value, datetime) else datetime.fromisoformat(str(value))


def key_state(doc: dict) -> str:
    if doc.get("revoked_at"):
        return KeyState.REVOKED.value
    expires = _stamp(doc.get("expires_at"))
    if expires is not None and expires <= ist_now():
        return KeyState.EXPIRED.value
    return KeyState.ACTIVE.value


# --------------------------------------------------------------------------- #
# Rate limiting
# --------------------------------------------------------------------------- #
# In-process and per-worker: two uvicorn workers mean a key's effective ceiling is
# twice what the console shows. Said plainly rather than hidden, because the point of
# this limiter is to stop a broken client's retry loop from hammering MySQL, not to
# meter a paid quota — and a shared limiter would mean Redis, which is not deployed.
_HITS: dict[str, deque] = {}
_WINDOW_SECONDS = 60


def check_rate(prefix: str, limit: int) -> None:
    if not limit or limit <= 0:
        return
    stamps = _HITS.setdefault(prefix, deque())
    cutoff = ist_now().timestamp() - _WINDOW_SECONDS
    while stamps and stamps[0] < cutoff:
        stamps.popleft()
    if len(stamps) >= limit:
        raise RateLimitError(f"Rate limit reached: {limit} requests per minute")
    stamps.append(ist_now().timestamp())


# --------------------------------------------------------------------------- #
# The call log
# --------------------------------------------------------------------------- #
# A ring buffer, not a table: this module owns no schema. It answers "what happened
# this morning" and forgets on restart, which the Usage screen says out loud rather
# than implying a permanent record exists.
_CALLS: dict[str, deque] = defaultdict(lambda: deque(maxlen=CALL_LOG_SIZE))


def record(client_code: str | None, **row) -> None:
    entry = {"at": ist_now(), "client_code": client_code, **row}
    _CALLS[client_code or "?"].append(entry)
    if row.get("status_code", 200) >= 400:
        log.warning("API call refused: %s %s -> %s %s", client_code,
                    row.get("slug"), row.get("status_code"), row.get("error"))


def calls_for(client_code: str) -> list[dict]:
    """Newest first."""
    return list(reversed(_CALLS.get(client_code, ())))


def reset_state() -> None:
    """Test hook. Never called by the application."""
    _HITS.clear()
    _CALLS.clear()


# --------------------------------------------------------------------------- #
# The dependency every /api/ext/v1 route carries
# --------------------------------------------------------------------------- #

class Caller:
    """The authenticated external application. Not a user and not a session."""

    def __init__(self, key: dict, client: dict):
        self.key = key
        self.client = client

    @property
    def client_code(self) -> str:
        return str(self.client.get("code", ""))

    @property
    def prefix(self) -> str:
        return str(self.key.get("key_prefix", ""))

    @property
    def scopes(self) -> list[str]:
        return list(self.key.get("scopes") or [])

    def require_scope(self, slug: str) -> None:
        # An empty scope list means every endpoint of this client — see KeyWrite.
        if self.scopes and slug not in self.scopes:
            raise PermissionError_(f"This key is not scoped for /{slug}")


async def require_api_key(
    request: Request,
    x_api_key: str = Header(None, alias="X-API-Key"),
    db: AsyncSession = Depends(get_db),
) -> Caller:
    """401 unless the header carries a live key belonging to an active client."""
    if not x_api_key:
        raise AuthenticationError("Missing X-API-Key header")
    prefix = split_prefix(x_api_key)
    if prefix is None:
        raise AuthenticationError("Malformed API key")

    doc = await store.get(db, store.key_key(prefix))
    # compare_digest even when the row is missing, against a throwaway digest, so a
    # wrong prefix and a wrong secret take the same time to refuse.
    candidate = hash_key(x_api_key)
    if doc is None or not secrets.compare_digest(str(doc.get("key_hash", "")), candidate):
        raise AuthenticationError("Invalid API key")

    client = await store.get(db, store.client_key(str(doc.get("client_code", ""))))
    ip = request.client.host if request.client else None
    port = request.client.port if request.client else None
    server = request.scope.get("server") or (None, None)
    server_host = server[0] if isinstance(server, (tuple, list)) and len(server) > 0 else None
    server_port = server[1] if isinstance(server, (tuple, list)) and len(server) > 1 else None
    local_ip = request.url.hostname or server_host
    local_port = request.url.port or server_port
    slug = request.path_params.get("slug")

    state = key_state(doc)
    if state != KeyState.ACTIVE.value:
        _refuse(doc, client, 401, f"API key is {state.lower()}", slug, ip, port,
                request.url.path, request.method, local_ip, local_port)
    if client is None or not client.get("is_active", True):
        _refuse(doc, client, 401, "API client is disabled", slug, ip, port,
                request.url.path, request.method, local_ip, local_port)
    try:
        check_rate(prefix, int(doc.get("rate_limit_per_min") or 0))
    except RateLimitError as exc:
        _refuse(doc, client, exc.status_code, exc.message, slug, ip, port,
                request.url.path, request.method, local_ip, local_port)

    # A key issued before the console kept a copyable value has only a digest behind
    # it, and the Keys list can then never hand it out again. The header just proved
    # itself against that digest, so recording it here can only ever store what the
    # key already IS — and the row heals itself the first time the partner calls,
    # without anybody being asked to paste anything. Stored exactly as verified, hex
    # like the webhook secret, so it re-hashes to the same digest.
    dirty = False
    if not doc.get("key_secret"):
        doc["key_secret"] = x_api_key.encode("utf-8").hex()
        dirty = True
        log.info("API key %s: copyable value recovered from a verified call", prefix)

    # One write per minute at most. Stamping every call would turn a read-only feed
    # into a write on the hot path, and a nightly sync pulling 400 pages would be 400
    # UPDATEs to record something with one-minute resolution anyway.
    now = ist_now()
    last = _stamp(doc.get("last_used_at"))
    if last is None or (now - last).total_seconds() > 60:
        doc["last_used_at"] = now.isoformat()
        dirty = True
    if dirty:
        await store.put(db, store.key_key(prefix), doc)
        await db.commit()

    request.state.api_client_code = client.get("code")
    return Caller(doc, client)


def _refuse(key: dict, client: dict | None, status_code: int, message: str,
            slug: str | None, ip: str | None, remote_port: int | None,
            endpoint: str | None, http_method: str | None,
            local_ip: str | None, local_port: int | None) -> None:
    """Log a refusal against the key it was made with, then raise it.

    Only refusals that resolved to a REAL key are logged. A flood of made-up keys has
    nothing to attach an entry to and would be a way to fill the ring buffer on
    demand, so those are refused silently — "my key stopped working" is always a real
    key.
    """
    record(client.get("code") if client else None, key_prefix=key.get("key_prefix"),
           slug=slug, status_code=status_code, error=message, ip_address=ip,
           remote_port=remote_port, endpoint=endpoint, http_method=http_method,
           local_ip_address=local_ip, local_port=local_port)
    if status_code == 429:
        raise RateLimitError(message)
    raise AuthenticationError(message)
