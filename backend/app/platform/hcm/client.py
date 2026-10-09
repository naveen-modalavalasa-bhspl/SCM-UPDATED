"""Async HCM HTTP client: X-API-Key auth, 5s timeout, 3 retries w/ backoff,
and a simple circuit breaker so a dead HCM doesn't hang the workers.

Normalises HCM's two envelope shapes (DRF `{results: [...]}` and bare `[...]`)
and follows pagination.
"""
import logging
import time
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
from tenacity import (
    AsyncRetrying, retry_if_exception_type, stop_after_attempt, wait_exponential,
)

from app.core.config import settings


class HcmUnavailable(Exception):
    """Raised when HCM is unreachable or the circuit is open.

    `retry_after` is how long the caller must wait before the request would even be
    ATTEMPTED again. Zero means it was attempted and failed; a positive value means the
    breaker refused it without calling HCM at all, and a caller with its own retry
    ladder must sleep at least that long or it spends every attempt on an answer that
    cannot change. `sync.sync_entity` is that caller.
    """

    def __init__(self, message: str, retry_after: float = 0.0):
        super().__init__(message)
        self.retry_after = retry_after


class _CircuitBreaker:
    """Trips after `threshold` consecutive failed calls; refuses calls for `cooldown`.

    Its ONLY job is to stop a worker hanging on a dead HCM. It must never be the reason
    a sync fails, and on a link that drops for a few seconds at a time it was exactly
    that — on 2026-08-31 a run at 14:39 failed all eight entities, six of them with
    "HCM circuit is open", three minutes after a run at 14:36 had pulled all 11,721
    rows without a complaint. Three separate faults, all fixed here:

    - **One entity's own retries trip it.** Pulling `offices` is up to 30 requests (5
      pages x 6 completeness passes) and `sync_entity` runs that up to four times. Five
      consecutive misses inside that is a blip, not a dead HCM — but it opened the
      breaker, and the entity then failed against a door it had shut on itself.
    - **A refusal cost the caller an attempt.** The cooldown (30s) outlasted the whole
      retry ladder (3+6+9s), so once open, every remaining attempt AND the next two
      entities failed without a packet sent, several seconds after the link was back.
      Refusals now carry `retry_after` so the caller waits the cooldown out instead.
    - **It never decayed.** Once the count reached the threshold it stayed there, so a
      SINGLE later failure re-opened it for another full cooldown, for ever. The count
      is cleared when the cooldown lapses: recovery takes a fresh burst, not one miss.
    """

    def __init__(self, threshold: int = 12, cooldown: float = 20.0):
        self.threshold = threshold
        self.cooldown = cooldown
        self._failures = 0
        self._open_until = 0.0

    def before(self) -> None:
        if not self._open_until:
            return
        remaining = self._open_until - time.monotonic()
        if remaining > 0:
            raise HcmUnavailable(
                f"HCM missed {self._failures} calls in a row, so this one was not sent "
                f"— it will be tried again in {remaining:.0f}s",
                retry_after=remaining,
            )
        # Cooldown lapsed: half-open. The next call goes through on a clean count, so
        # one probe failing costs one failure rather than another whole cooldown.
        self._failures = 0
        self._open_until = 0.0

    def on_success(self) -> None:
        self._failures = 0
        self._open_until = 0.0

    def on_failure(self) -> None:
        self._failures += 1
        if self._failures >= self.threshold:
            self._open_until = time.monotonic() + self.cooldown

    def reset(self) -> None:
        """Forget the past. A run a person just asked for starts on a clean slate — the
        state of the link ten minutes ago is not a reason to refuse to look now."""
        self._failures = 0
        self._open_until = 0.0


_breaker = _CircuitBreaker()

logger = logging.getLogger(__name__)

# How many times a lossy feed is walked again before the pull is called a failure.
# Sections is the worst of them: one pass over 2,849 rows serves ~2,545 distinct
# ones, so it takes several unions to come up whole.
_COMPLETENESS_ATTEMPTS = 6


def _row_id(row: Any) -> Any:
    """The row's own id, wherever this feed keeps it.

    The older nested employee shape has no id at the top level — it carries an
    `employee` block and the id is in there (see `mappers.map_employee`). Without
    this, every employee row would key on None, and a pull that served the same
    person twice would count as two rows towards the completeness check.
    """
    if not isinstance(row, dict):
        return None
    if row.get("id") is not None:
        return row["id"]
    nested = row.get("employee")
    return nested.get("id") if isinstance(nested, dict) else None


def _extract(data: Any) -> list[dict]:
    """DRF paginated dict -> results list; bare list -> itself."""
    if isinstance(data, dict) and "results" in data:
        return data["results"] or []
    if isinstance(data, list):
        return data
    return []


class HcmClient:
    """One client per sync run, holding ONE connection to HCM for all of it.

    Keep-alive is not a micro-optimisation here. A full sync is around 60 requests, and
    the client used to open — and throw away — a fresh TCP connection for every single
    one of them. On a link that drops briefly, each of those handshakes is another
    chance to land in the gap, which is why the same code pulls 11,721 rows on a good
    network and cannot get past `offices` on a flaky one. Reusing the connection turns
    ~60 chances to fail into one, and `retries=2` on the transport re-dials underneath
    tenacity when the socket does die.

    Close it with `aclose()` when the run ends; every sync entry point does.
    """

    def __init__(self, base_url: str | None = None, api_key: str | None = None):
        self.base_url = (base_url or settings.HCM_BASE_URL).rstrip("/")
        self.api_key = api_key if api_key is not None else settings.HCM_API_KEY
        self.timeout = settings.HCM_TIMEOUT_SECONDS
        self.retries = settings.HCM_RETRIES
        self._http: httpx.AsyncClient | None = None

    @property
    def _headers(self) -> dict:
        return {"X-API-Key": self.api_key} if self.api_key else {}

    def _client(self) -> httpx.AsyncClient:
        if self._http is None or self._http.is_closed:
            self._http = httpx.AsyncClient(
                timeout=httpx.Timeout(self.timeout, connect=min(15.0, self.timeout)),
                headers=self._headers,
                # Re-dials a connection that died between pages, below tenacity. ONE
                # re-dial: tenacity already retries on top, and every layer multiplies
                # how long a genuinely dead HCM takes to be called dead.
                transport=httpx.AsyncHTTPTransport(retries=1),
                limits=httpx.Limits(max_keepalive_connections=4, max_connections=8),
            )
        return self._http

    async def aclose(self) -> None:
        if self._http is not None and not self._http.is_closed:
            await self._http.aclose()
        self._http = None

    async def __aenter__(self) -> "HcmClient":
        return self

    async def __aexit__(self, *exc_info) -> None:
        await self.aclose()

    async def _get(self, url: str, params: dict | None = None) -> Any:
        _breaker.before()
        try:
            async for attempt in AsyncRetrying(
                stop=stop_after_attempt(self.retries),
                wait=wait_exponential(multiplier=0.5, max=5),
                retry=retry_if_exception_type(httpx.HTTPError),
                reraise=True,
            ):
                with attempt:
                    resp = await self._client().get(url, params=params)
                    resp.raise_for_status()
                    _breaker.on_success()
                    return resp.json()
        except httpx.HTTPError as exc:
            _breaker.on_failure()
            raise HcmUnavailable(self._explain(exc, url)) from exc

    def _explain(self, exc: httpx.HTTPError, url: str) -> str:
        """Say WHOSE problem it is, because the sync screen shows this line and nothing
        else.

        httpx's own wording for a refused connection is "All connection attempts
        failed", which is what Settings > HCM & Config displayed under a red Offices
        row. It names neither the host that went quiet nor which side of the wire it is
        on, so every diagnosis started from scratch.
        """
        host = urlparse(self.base_url).netloc or self.base_url
        if isinstance(exc, httpx.ConnectError):
            return (f"Could not open a connection to HCM at {host} — either HCM is down "
                    f"or this machine cannot reach it right now (network, firewall or "
                    f"VPN). Nothing was pulled and the mirror is unchanged.")
        if isinstance(exc, httpx.TimeoutException):
            return (f"HCM at {host} accepted the connection but did not answer within "
                    f"{self.timeout:.0f}s (GET {url}) — it is up but stuck or very slow. "
                    f"Raise HCM_TIMEOUT_SECONDS in backend/.env if that is normal here.")
        if isinstance(exc, httpx.HTTPStatusError):
            code = exc.response.status_code
            if code in (401, 403):
                return (f"HCM at {host} answered HTTP {code} — the host is fine and it "
                        f"rejected our API key. Check HCM_API_KEY in backend/.env.")
            if code == 404:
                return (f"HCM at {host} answered HTTP 404 for {url} — the host is fine "
                        f"and that feed is not there. Check HCM_BASE_URL in "
                        f"backend/.env; it must end in /api.")
            return f"HCM at {host} answered HTTP {code} for {url}."
        return f"HCM request to {host} failed — {type(exc).__name__}: {exc}"

    # HCM paginates by PAGE NUMBER, and `page_size` is the only query parameter it
    # honours — `limit` and `offset` are read by nothing and silently fall back to 100
    # rows a page. 500 is the largest page it will serve; asking for more is capped.
    async def fetch_all(self, entity: str, page_size: int = 500) -> list[dict]:
        """Every row of an entity, following pagination. See `fetch_all_checked`."""
        rows, _complete = await self.fetch_all_checked(entity, page_size)
        return rows

    async def fetch_all_checked(self, entity: str,
                                page_size: int = 500) -> tuple[list[dict], bool]:
        """Every row of an entity, plus whether the feed actually served them all.

        Only the QUERY of HCM's `next` link is trusted, never its host: HCM builds
        that link from the request host it sees behind its proxy and drops the port,
        so `next` comes back as http://<host>/api/employees/?page=2 — a 404 that would
        end every sync one page in. The page numbers are still HCM's; we just ask for
        them on the address we were configured with.

        **A short pull is not a small feed.** HCM's list queryset has no ORDER BY, so
        MySQL is free to hand back the pages of one walk in overlapping orders: rows
        come twice and others are never served at all. Asking for `limit=200` — which
        HCM ignores — made that 41 pages over 4,021 positions and cost 145-176
        DIFFERENT posts on every single run. The mirror has no way to tell that from a
        deletion, so `sync._retire_positions` duly deactivated them and the seats on
        them: on 2026-08-28 that took out all sixteen Central Warehouse / Procurement
        posts and their holders' HCM role and position on Roles & Access.
        `hcm_cutover` and `hcm_clean_slate` read this same list to decide what to
        retire and delete, so the loss reached them too.

        So the walk is REPEATED and its results UNIONED until the rows collected match
        the count HCM declares in the envelope: a different shuffle serves different
        rows, and the gaps close in a pass or two.

        A pass that adds nothing new ends it early, and is the other failure: sections
        declares 2,849 and serves exactly the same 2,545 distinct ids however it is
        paged, so its count is inflated by rows its own query duplicates and no number
        of passes will reach it. That returns `complete=False` — the rows are as
        complete as HCM can make them, but nothing may be RETIRED on the strength of
        them.
        """
        by_id: dict[Any, dict] = {}
        anonymous: list[dict] = []
        declared: int | None = None
        for attempt in range(_COMPLETENESS_ATTEMPTS):
            before = len(by_id)
            # Rows with no id of their own cannot be de-duplicated, so the last pass
            # wins rather than every pass piling its copy on the one before.
            anonymous = []
            declared = await self._walk(entity, page_size, by_id, anonymous)
            rows = list(by_id.values()) + anonymous
            if declared is None or len(rows) >= declared:
                return rows, True
            if len(by_id) == before and attempt:
                logger.warning(
                    "hcm fetch: %s serves %s distinct rows however it is paged but "
                    "declares %s — its count includes rows its own query duplicates",
                    entity, len(rows), declared,
                )
                return rows, False
            logger.warning(
                "hcm fetch: %s has served %s of the %s rows it declares (pass %s/%s) — "
                "its pagination is unordered; walking it again",
                entity, len(rows), declared, attempt + 1, _COMPLETENESS_ATTEMPTS,
            )
        logger.error(
            "hcm fetch: %s never came up whole — %s of the %s rows it declares, after "
            "%s passes. Nothing will be retired on this pull.",
            entity, len(by_id) + len(anonymous), declared, _COMPLETENESS_ATTEMPTS,
        )
        return list(by_id.values()) + anonymous, False

    async def _walk(self, entity: str, page_size: int, by_id: dict,
                    anonymous: list) -> int | None:
        """One pass over every page, ADDING to what earlier passes collected.

        Passes accumulate on purpose: a walk that lost 176 rows loses a DIFFERENT 176
        next time, so the union closes the gap where re-reading alone never would.

        The count is taken from the LAST page rather than the first: a row deleted
        while the walk was running would otherwise leave the pull looking short for
        ever.
        """
        url = f"{self.base_url}/{entity}/"
        params: dict | None = {"page_size": page_size}
        declared: int | None = None
        while True:
            data = await self._get(url, params=params)
            for row in _extract(data):
                key = _row_id(row)
                if key is None:
                    anonymous.append(row)
                else:
                    by_id[key] = row
            if isinstance(data, dict) and isinstance(data.get("count"), int):
                declared = data["count"]
            nxt = data.get("next") if isinstance(data, dict) else None
            if not nxt:
                return declared
            params = {k: v[0] for k, v in parse_qs(urlparse(nxt).query).items()}
            params.setdefault("page_size", page_size)


def reset_breaker() -> None:
    """Clear the breaker before a run a person asked for.

    The state of the link during the LAST run says nothing about this one, and an armed
    breaker made a run fail on its first entity without a packet being sent.
    """
    _breaker.reset()
