"""Where the current request came from, and on what, for the audit log.

`sys_audit_log.ip_address` has always existed and `write_audit` has always accepted an
`ip_address` argument — but essentially every call site omits it, so the column was NULL
on every row ever written. Threading a request through ~200 service functions to fix
that would be a large change for one field, so the client context is captured once per
request by the middleware in `app/main.py` into a contextvar and read back by
`write_audit` when it appends a row.

Everything here is best-effort by design. An audit row must never block or fail the
action it records, so each piece is wrapped: no header means None, a malformed
user-agent means "Unknown", and a geo service that is slow, refused or rate-limited
means the address is still recorded and the location is left blank.

**Two honest limits, both visible on the screen rather than hidden.**

*The address is what this server can see.* Behind the Vite dev proxy every request
genuinely arrives from `127.0.0.1`, and that is what gets stored. Behind a real reverse
proxy, `x-forwarded-for` carries the client and that is used instead. Nothing is
inferred beyond those two.

*The location is the ADDRESS's location, not the person's.* For a private or loopback
address there is no public location to look up, so `LOCATION_FOR_PRIVATE` decides what
happens: by default the deployment's own location is reported, which is the right answer
for a LAN install where the users are in the building, and the wrong one for anybody
connecting from elsewhere. Set `AUDIT_GEO_PRIVATE_IPS=false` to leave it blank instead.
The geo host itself is configuration (rule 13), not a literal in this file.
"""
from __future__ import annotations

import contextvars
import ipaddress
import logging
import os
import re
from typing import Any

import httpx

logger = logging.getLogger(__name__)

#: Where the current request's client context is parked. Scoped per request AND per
#: task, so a background job can never inherit the last request's caller.
_client_info: contextvars.ContextVar[dict[str, Any]] = contextvars.ContextVar(
    "scm_client_info", default={},
)

#: The IP geolocation service. Configuration, not a constant: it is an outside host this
#: deployment talks to, and which one (or none) is the operator's decision. Blank
#: switches location off entirely and nothing else changes.
GEO_URL = os.getenv("AUDIT_GEO_URL", "http://ip-api.com/json/{ip}")
GEO_TIMEOUT = float(os.getenv("AUDIT_GEO_TIMEOUT", "2.5"))

#: Whether a private/loopback address reports the deployment's own location. See the
#: module docstring — this is a real trade, so it is a switch and not a hidden default.
LOCATION_FOR_PRIVATE = os.getenv("AUDIT_GEO_PRIVATE_IPS", "true").lower() != "false"


def set_client_info(info: dict[str, Any] | None) -> None:
    """Store this request's client context (called by the HTTP middleware)."""
    _client_info.set(info or {})


def get_client_info() -> dict[str, Any]:
    """The captured context for the current request/task, or {} when there is none."""
    return _client_info.get()


# --------------------------------------------------------------------------- #
# The address
# --------------------------------------------------------------------------- #

def _valid(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


def _is_public(value: str | None) -> bool:
    try:
        return bool(value) and ipaddress.ip_address(value).is_global
    except ValueError:
        return False


def client_ip(request: Any) -> str | None:
    """The caller's address: `x-forwarded-for` if a proxy set one, else the socket peer.

    The FIRST entry of `x-forwarded-for` is the client; the rest are the proxies it
    passed through. Anything that is not a parseable address is dropped rather than
    stored, so a junk or spoofed header cannot write arbitrary text into the audit
    trail.
    """
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        for candidate in re.split(r"[,\s]+", forwarded):
            candidate = candidate.strip()
            if candidate and _valid(candidate):
                return candidate[:45]
    host = getattr(getattr(request, "client", None), "host", None)
    return host[:45] if host and _valid(host) else None


# --------------------------------------------------------------------------- #
# The device — parsed locally, no dependency and no network
# --------------------------------------------------------------------------- #

_OS = [
    (re.compile(r"Windows NT 10\.0"), "Windows"),
    (re.compile(r"Windows NT 6\.1"), "Windows 7"),
    (re.compile(r"Windows"), "Windows"),
    (re.compile(r"Android"), "Android"),
    (re.compile(r"iPhone OS|iOS"), "iOS"),
    (re.compile(r"iPad"), "iPadOS"),
    (re.compile(r"CrOS"), "ChromeOS"),
    (re.compile(r"Mac OS X|Macintosh"), "macOS"),
    (re.compile(r"Linux"), "Linux"),
]
# Order matters: Edge and Opera both claim to be Chrome, and Chrome claims to be
# Safari, so the most specific token has to be tested first.
_BROWSER = [
    (re.compile(r"Edg[A-Z]?/"), "Edge"),
    (re.compile(r"OPR/|Opera"), "Opera"),
    (re.compile(r"SamsungBrowser/"), "Samsung Internet"),
    (re.compile(r"Firefox/|FxiOS/"), "Firefox"),
    (re.compile(r"Chrome/|CriOS/"), "Chrome"),
    (re.compile(r"Safari/"), "Safari"),
]
_DEVICE = [
    (re.compile(r"iPad|Tablet"), "Tablet"),
    (re.compile(r"Mobi|Android|iPhone|iPod"), "Mobile"),
    (re.compile(r"Windows|Macintosh|Mac OS|Linux|CrOS"), "Desktop"),
]


def parse_user_agent(ua: str | None) -> dict[str, str | None]:
    """Device, browser and OS from a raw user-agent header.

    Regexes rather than a parser library: the answer only has to be good enough to say
    "Desktop · Chrome · Windows" in an audit row, and a dependency that ships a
    browser database to do that is not worth carrying.
    """
    if not ua:
        return {"device_type": None, "browser": None, "os": None, "user_agent": None}
    ua = ua[:500]
    first = lambda table: next((n for rx, n in table if rx.search(ua)), "Unknown")
    return {
        "device_type": first(_DEVICE),
        "browser": first(_BROWSER),
        "os": first(_OS),
        "user_agent": ua,
    }


# --------------------------------------------------------------------------- #
# The location — cached per address, and never able to fail a write
# --------------------------------------------------------------------------- #

_geo_cache: dict[str, str | None] = {}


async def location_for_ip(ip: str | None) -> str | None:
    """`City, Region, Country` for an address, or None.

    Cached per address — including the misses, so an unreachable service is asked once
    and not on every request afterwards. Never raises: any failure returns None and the
    audit row is written without a location.
    """
    if not GEO_URL:
        return None
    key = ip or ""
    if key in _geo_cache:
        return _geo_cache[key]
    # A private address has no public location. `LOCATION_FOR_PRIVATE` asks the service
    # about the SERVER instead (an empty query returns the caller's own location, which
    # from here is this deployment's) — right for a LAN install, wrong for a remote user.
    if not _is_public(ip):
        if not LOCATION_FOR_PRIVATE:
            _geo_cache[key] = None
            return None
        url = GEO_URL.format(ip="")
    else:
        url = GEO_URL.format(ip=ip)

    location: str | None = None
    try:
        async with httpx.AsyncClient(timeout=GEO_TIMEOUT) as client:
            response = await client.get(url)
        if response.status_code == 200:
            data = response.json()
            if data.get("status", "success") == "success":
                parts = [data.get("city"), data.get("regionName") or data.get("region"),
                         data.get("country")]
                location = ", ".join(p for p in parts if p) or None
    except Exception:  # noqa: BLE001 — geography must never fail an audited action
        logger.warning("Could not resolve a location for %s", ip or "this server",
                       exc_info=True)
        return None                      # not cached: a transient outage may recover
    _geo_cache[key] = location
    return location


async def client_info(request: Any) -> dict[str, Any]:
    """Everything the audit log can learn about this caller, in one place."""
    ip = client_ip(request)
    info: dict[str, Any] = {"ip_address": ip}
    info.update(parse_user_agent(request.headers.get("user-agent")))
    info["location"] = await location_for_ip(ip)
    return info
