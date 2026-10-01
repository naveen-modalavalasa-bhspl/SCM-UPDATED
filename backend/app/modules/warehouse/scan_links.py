"""Where a printed label's QR code points — decided HERE, never by the browser.

A consignment or package label carries `<origin>/c/<signed token>`. The origin used
to be whatever the printing browser's address bar said, so a label printed from
`http://localhost:5173` encoded `localhost` — which on the phone that scans it means
the PHONE, and the carton went out with a QR nobody could ever open. A label printed
from the PC's LAN address opened on the office Wi-Fi only.

The order of trust:

1. `PUBLIC_SCAN_URL` (backend `.env`, read at runtime). Production and UAT set it to
   their public address, so one build prints the right label in every environment and
   moving a server is one line, not a rebuild.
2. The printing browser's own address, when it is not loopback — a deployment opened
   at its domain prints that domain, which is what it always did.
3. Loopback swapped for this machine's network IP, keeping the browser's scheme and
   port. Development only: Vite listens on every interface (`host: true`), so the
   phone reaches the same dev server the PC is on. Detected per request, so a new IP
   from DHCP is simply the next label's address.

The token half is untouched: it is signed with this environment's SECRET_KEY, which
is why the address must lead back to the environment that printed it.
"""
from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit

from app.core.config import settings
from app.modules.warehouse.enums import ScanOriginSource, ScanReach

_LOOPBACK_NAMES = {"localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"}

_WORDING = {
    ScanReach.PUBLIC: (
        "Labels open on any phone",
        "The QR code points at {host}, which phones can reach from any network.",
    ),
    ScanReach.PRIVATE_NETWORK: (
        "Labels open on this network only",
        "The QR code points at {host}. A phone on the same Wi-Fi or the office VPN can "
        "open it; one anywhere else cannot. Set PUBLIC_SCAN_URL to a public address "
        "for labels that travel.",
    ),
    ScanReach.THIS_DEVICE: (
        "These labels cannot be scanned",
        "The QR code points at {host}, which only this computer can open. Open the app "
        "by its network address or set PUBLIC_SCAN_URL on the server, then print.",
    ),
}


def _split_origin(value: str | None) -> tuple[str, str, int | None] | None:
    """(scheme, host, port) of an http(s) origin; anything else is not an origin.
    Only those three parts are ever kept, so a path or query in the input is dropped."""
    if not value:
        return None
    try:
        parts = urlsplit(value.strip())
        port = parts.port
    except ValueError:
        return None
    if parts.scheme not in {"http", "https"} or not parts.hostname:
        return None
    return parts.scheme, parts.hostname.lower(), port


def _join_origin(scheme: str, host: str, port: int | None) -> str:
    shown = f"[{host}]" if ":" in host else host
    default = {"http": 80, "https": 443}[scheme]
    return f"{scheme}://{shown}" if port in (None, default) else f"{scheme}://{shown}:{port}"


def reach_of(host: str) -> ScanReach:
    """Who can open an address on this host. Pure — tested without a network."""
    host = host.strip("[]").lower()
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        if host in _LOOPBACK_NAMES or host.endswith(".localhost"):
            return ScanReach.THIS_DEVICE
        # A bare machine name or an mDNS name resolves on the local network only.
        if "." not in host or host.endswith((".local", ".lan", ".internal", ".home.arpa")):
            return ScanReach.PRIVATE_NETWORK
        return ScanReach.PUBLIC
    if ip.is_loopback or ip.is_unspecified:
        return ScanReach.THIS_DEVICE
    # Private, link-local, CGNAT/Tailscale: none of them is reachable from the internet.
    return ScanReach.PUBLIC if ip.is_global else ScanReach.PRIVATE_NETWORK


def _detect_lan_ip() -> str | None:
    """This machine's IPv4 address on the network it routes out through.

    Connecting a UDP socket sends nothing; it only asks the OS which interface it
    would use, which is the address another device on that network reaches us at.
    With no route at all, fall back to the addresses the host name resolves to."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("8.8.8.8", 80))
            address = probe.getsockname()[0]
        if reach_of(address) is not ScanReach.THIS_DEVICE:
            return address
    except OSError:
        pass
    try:
        _, _, addresses = socket.gethostbyname_ex(socket.gethostname())
    except OSError:
        return None
    for address in addresses:
        if reach_of(address) is ScanReach.PRIVATE_NETWORK:
            return address
    return None


def _answer(origin: str, host: str, source: ScanOriginSource) -> dict:
    reach = reach_of(host)
    headline, detail = _WORDING[reach]
    return {
        "origin": origin,
        "source": source,
        "reach": reach,
        "printable": reach is not ScanReach.THIS_DEVICE,
        "headline": headline,
        "detail": detail.format(host=origin.split("://", 1)[1]),
    }


async def resolve_scan_origin(browser_origin: str | None) -> dict:
    """The origin a label printed from `browser_origin` should carry. Never raises."""
    configured = _split_origin(settings.PUBLIC_SCAN_URL)
    if configured:
        return _answer(_join_origin(*configured), configured[1], ScanOriginSource.CONFIGURED)

    browser = _split_origin(browser_origin) or _split_origin(settings.APP_BASE_URL)
    if not browser:
        return _answer("http://localhost", "localhost", ScanOriginSource.BROWSER)
    scheme, host, port = browser
    if reach_of(host) is not ScanReach.THIS_DEVICE:
        return _answer(_join_origin(scheme, host, port), host, ScanOriginSource.BROWSER)

    # gethostbyname_ex can wait on DNS, so it never runs on the event loop.
    lan_ip = await asyncio.to_thread(_detect_lan_ip)
    if lan_ip:
        return _answer(_join_origin(scheme, lan_ip, port), lan_ip, ScanOriginSource.DETECTED_LAN)
    return _answer(_join_origin(scheme, host, port), host, ScanOriginSource.BROWSER)
