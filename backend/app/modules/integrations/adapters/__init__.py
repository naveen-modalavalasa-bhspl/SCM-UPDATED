"""Adapters — one folder per outside system that needs more than the console can build.

The console (`integrations/service.py`) composes an endpoint out of a table, its
columns, joins and filters. That covers most consumers. It cannot *derive*: a computed
warehouse tier, a destination SCM keeps on the consignment rather than on the issue, a
SUM over another table. When a system pins a payload shape the builder cannot express,
that system gets an adapter here.

An adapter is a self-contained sub-package. It owns no tables, edits nothing outside its
own folder, and exposes exactly two names:

    router  — an APIRouter; its feed routes live under `/api/ext/v1/<key>/…` (API key,
              no session) and its console routes under `/api/apis/<key>/…`
              (JWT + require_permission), same as every other route in the system
    ADAPTER — an `Adapter` describing it, so the console can list what is available

Nothing here is CAMS-specific. To add a system, drop a package beside `cams/`,
give it those two names, and it is discovered on the next start — `integrations/router.py`
mounts whatever this module finds and no file outside the new folder changes.
"""
from __future__ import annotations

import importlib
import logging
import pkgutil
from dataclasses import dataclass

from fastapi import APIRouter

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Adapter:
    """What the console shows about a hand-written integration."""

    key: str            # the scope an API key must carry, and the URL segment
    name: str           # what a human calls the system
    description: str = ""
    docs: str | None = None   # a file beside the adapter, e.g. "API.md"


def discover() -> list[tuple[Adapter, APIRouter]]:
    """Every adapter package under this folder that exposes `ADAPTER` and `router`.

    Import failures are logged and skipped rather than raised: one broken adapter must
    not stop the application booting, the same reason a missing workflow falls back
    instead of stranding a document.
    """
    found: list[tuple[Adapter, APIRouter]] = []
    for info in pkgutil.iter_modules(__path__):
        if not info.ispkg or info.name.startswith("_"):
            continue
        try:
            module = importlib.import_module(f"{__name__}.{info.name}.router")
            meta = importlib.import_module(f"{__name__}.{info.name}")
        except Exception:  # pragma: no cover - defensive
            logger.exception("Integration adapter %r failed to load", info.name)
            continue
        adapter = getattr(meta, "ADAPTER", None)
        router = getattr(module, "router", None)
        if adapter is None or router is None:
            logger.warning("Integration adapter %r exposes no ADAPTER/router", info.name)
            continue
        found.append((adapter, router))
    return sorted(found, key=lambda pair: pair[0].key)


def routers() -> list[APIRouter]:
    return [router for _, router in discover()]


def catalogue() -> list[Adapter]:
    return [adapter for adapter, _ in discover()]
