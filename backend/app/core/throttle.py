"""Per-address throttling for the doors that are open to the internet.

Four endpoints take a request from someone who has not signed in yet, and every one
of them does expensive work before it can decide whether to refuse: `/api/auth/login`,
`/api/auth/forgot-password`, and the vendor and carrier portal logins. Three of them
run a ~300 ms bcrypt; the fourth sends mail. None of them was metered, so a script at
100 requests a second took the whole application down without needing a single valid
credential, and the reset endpoint could be used to flood a real mailbox.

nginx's `limit_req` guards the same doors from outside and costs no code (see
`frontend/nginx.conf`). This exists as well rather than instead: the API is also
reachable directly on the LAN, a deployment may sit behind a different proxy, and a
limit that only exists in the edge configuration is a limit nobody reviewing the
handler can see.

`cache.allow` is shared across workers when Redis is configured and falls back to a
per-process counter when it is not — so the ceiling is per deployment in production
and per worker in development, and it is never simply absent.
"""
from app.core import cache
from app.core.exceptions import AppException


class RateLimitedError(AppException):
    """429. Its own class so the one shape every error uses carries the right code."""
    status_code = 429
    error_code = "RATE_LIMITED"
    title = "Too many attempts"


def caller_address(request) -> str | None:
    """Who is knocking.

    `X-Forwarded-For`'s FIRST hop, because nginx appends and the client's own address
    is the leftmost. Not `request.client.host`, which behind the proxy is the proxy —
    every caller in the deployment would share one bucket and the throttle would fire
    on ordinary morning traffic. The header is client-supplied and therefore forgeable,
    which is the accepted limit of this control: an attacker who rotates it defeats
    this and still meets the per-account lockout and nginx's own limit.
    """
    forwarded = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    return forwarded or (request.client.host if request.client else None)


async def guard(request, bucket: str, limit: int, *, message: str) -> None:
    """Refuse with 429 once one address has made `limit` requests in a minute."""
    address = caller_address(request)
    if not address:
        return
    if not await cache.allow(f"{bucket}:{address}", limit):
        raise RateLimitedError(message)
