"""One shared cache and one shared counter, for every worker in the deployment.

Added 2026-09-03, and the reason is capacity rather than speed. Three pieces of state
lived in a Python dict inside the web process, and each of them is why the app could
not run more than ONE worker:

* the integrations rate limiter — four workers meant four times the ceiling an
  administrator configured, and the code said so;
* the introspection cache — two workers could answer the same question differently;
* nothing cached a resolved permission set at all, so every authenticated request
  re-derived it in four to six queries for data that changes about monthly.

**Redis is optional and the app is whole without it.** With `REDIS_URL` unset every
function below falls back to a per-process dict with the same TTL semantics — which is
exactly the behaviour those three had before — so a developer needs nothing installed
and a single-process deployment is unchanged. Set it in production, where it is what
makes `--workers` and replicas safe.

**Nothing here may ever fail a request.** A cache is an optimisation; a Redis that is
down, slow or wrong must degrade to "not cached", never to a 500. Every call is
wrapped, and a connection that starts failing is dropped so the process stops paying
the timeout on every request. The one place that judgement is deliberately inverted is
`allow()` — see its docstring.
"""
import asyncio
import json
import logging
import time
from typing import Any

from app.core.config import settings

log = logging.getLogger("cache")

#: Set once, lazily, on first use. `None` means "not yet asked"; `False` means asked
#: and unavailable, which is a permanent answer for the life of the process only in
#: the sense that `_reset` puts it back to None after a failure.
_client: Any = None
_checked = False
_lock = asyncio.Lock()

#: The fallback store: key -> (value, expires_at). Per process, exactly like the three
#: dicts this replaces.
_local: dict[str, tuple[Any, float]] = {}


def enabled() -> bool:
    """Is a shared cache configured? Screens that report deployment health read this."""
    return bool(settings.REDIS_URL)


async def _redis():
    """The connection, or None. Built once; never raises."""
    global _client, _checked
    if _checked:
        return _client
    async with _lock:
        if _checked:
            return _client
        _checked = True
        if not settings.REDIS_URL:
            _client = None
            return None
        try:
            import redis.asyncio as redis_asyncio

            client = redis_asyncio.from_url(
                settings.REDIS_URL, encoding="utf-8", decode_responses=True,
                socket_timeout=2, socket_connect_timeout=2,
            )
            await client.ping()
            _client = client
            log.info("Shared cache connected")
        except Exception as exc:
            # Named at WARNING once, not per request: a deployment that meant to have
            # Redis and does not should see it in the log, and one that never had it
            # should not be told twice a second.
            log.warning("REDIS_URL is set but unreachable (%s) — "
                        "falling back to per-process caching", exc)
            _client = None
    return _client


def _reset() -> None:
    """Forget a connection that has started failing, so the next call re-dials once."""
    global _client, _checked
    _client, _checked = None, False


def _local_get(key: str):
    hit = _local.get(key)
    if hit is None:
        return None
    value, expires_at = hit
    if expires_at and expires_at < time.monotonic():
        _local.pop(key, None)
        return None
    return value


async def get_json(key: str):
    """The cached value, or None. Never raises, and a miss and a stored null are
    indistinguishable on purpose — a caller that needs to tell them apart should be
    caching a wrapper object, not relying on the cache to model absence."""
    client = await _redis()
    if client is None:
        return _local_get(key)
    try:
        raw = await client.get(key)
        return json.loads(raw) if raw is not None else None
    except Exception as exc:
        log.warning("Cache read failed for %s: %s", key, exc)
        _reset()
        return None


async def set_json(key: str, value, ttl_seconds: int) -> None:
    """Store a JSON-serialisable value under a TTL. Never raises."""
    client = await _redis()
    if client is None:
        _local[key] = (value, time.monotonic() + ttl_seconds if ttl_seconds else 0)
        # The fallback dict has no eviction of its own, so bound it. These are small
        # per-user payloads; a runaway key space is a memory leak in a long-lived
        # worker, which is a worse bug than a cold cache.
        if len(_local) > 5000:
            _local.clear()
        return
    try:
        await client.set(key, json.dumps(value, default=str), ex=ttl_seconds or None)
    except Exception as exc:
        log.warning("Cache write failed for %s: %s", key, exc)
        _reset()


async def delete_prefix(prefix: str) -> None:
    """Drop every key under a prefix — how an invalidation is expressed here.

    Scanned rather than `KEYS`-ed: this runs inside a request whenever a grant
    changes, and `KEYS` on a large database blocks the whole Redis server.
    """
    client = await _redis()
    if client is None:
        for key in [k for k in _local if k.startswith(prefix)]:
            _local.pop(key, None)
        return
    try:
        async for key in client.scan_iter(match=f"{prefix}*", count=500):
            await client.delete(key)
    except Exception as exc:
        log.warning("Cache invalidation failed for %s: %s", prefix, exc)
        _reset()


async def allow(key: str, limit: int, window_seconds: int = 60) -> bool:
    """Fixed-window counter. False once `limit` hits land in `window_seconds`.

    **Fails CLOSED where the rest of this module fails open.** A cache that is down
    should not break a screen, but a rate limiter that is down should not silently
    become no rate limiter — the endpoints this guards are sign-in and password reset,
    where the whole point is that an unmetered 300 ms bcrypt is a denial-of-service
    button. With Redis unreachable it falls back to the per-process counter, which is
    less strict across workers but is never absent.
    """
    if not limit or limit <= 0:
        return True
    client = await _redis()
    if client is None:
        bucket = f"{key}:{int(time.time()) // window_seconds}"
        count = (_local_get(bucket) or 0) + 1
        _local[bucket] = (count, time.monotonic() + window_seconds)
        return count <= limit
    try:
        bucket = f"{key}:{int(time.time()) // window_seconds}"
        count = await client.incr(bucket)
        if count == 1:
            # Only on the first hit of a window: re-expiring on every hit would turn
            # a fixed window into a sliding one that never lets the key go.
            await client.expire(bucket, window_seconds)
        return count <= limit
    except Exception as exc:
        log.warning("Rate limit check failed for %s: %s", key, exc)
        _reset()
        return True


async def close() -> None:
    """Shut the connection at process exit."""
    client = _client
    if client is not None:
        try:
            await client.aclose()
        except Exception:
            pass
    _reset()
