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
    """Raised when HCM is unreachable or the circuit is open."""


class _CircuitBreaker:
    def __init__(self, threshold: int = 5, cooldown: float = 30.0):
        self.threshold = threshold
        self.cooldown = cooldown
        self._failures = 0
        self._open_until = 0.0

    def before(self) -> None:
        if self._open_until and time.monotonic() < self._open_until:
            raise HcmUnavailable("HCM circuit is open")

    def on_success(self) -> None:
        self._failures = 0
        self._open_until = 0.0

    def on_failure(self) -> None:
        self._failures += 1
        if self._failures >= self.threshold:
            self._open_until = time.monotonic() + self.cooldown


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
    def __init__(self, base_url: str | None = None, api_key: str | None = None):
        self.base_url = (base_url or settings.HCM_BASE_URL).rstrip("/")
        self.api_key = api_key if api_key is not None else settings.HCM_API_KEY
        self.timeout = settings.HCM_TIMEOUT_SECONDS
        self.retries = settings.HCM_RETRIES

    @property
    def _headers(self) -> dict:
        return {"X-API-Key": self.api_key} if self.api_key else {}

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
                    async with httpx.AsyncClient(timeout=self.timeout) as http:
                        resp = await http.get(url, params=params, headers=self._headers)
                        resp.raise_for_status()
                        _breaker.on_success()
                        return resp.json()
        except httpx.HTTPError as exc:
            _breaker.on_failure()
            raise HcmUnavailable(f"HCM request failed: {exc}") from exc

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
