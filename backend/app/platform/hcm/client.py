"""Async HCM HTTP client: X-API-Key auth, 5s timeout, 3 retries w/ backoff,
and a simple circuit breaker so a dead HCM doesn't hang the workers.

Normalises HCM's two envelope shapes (DRF `{results: [...]}` and bare `[...]`)
and follows pagination.
"""
import time
from typing import Any

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

    async def fetch_all(self, entity: str, page_size: int = 100) -> list[dict]:
        """Fetch every row of an entity, following pagination."""
        url = f"{self.base_url}/{entity}/"
        params: dict | None = {"limit": page_size}
        rows: list[dict] = []
        while url:
            data = await self._get(url, params=params)
            rows.extend(_extract(data))
            url = data.get("next") if isinstance(data, dict) else None
            params = None  # `next` already carries query params
        return rows
