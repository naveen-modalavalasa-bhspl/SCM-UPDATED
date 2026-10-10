"""Where a label's QR points (`scan_links`). Pure: no database, no real network."""
import asyncio

from app.core.config import settings
from app.modules.warehouse import scan_links
from app.modules.warehouse.enums import ScanOriginSource, ScanReach


def _resolve(origin, monkeypatch, *, configured=None, lan="10.10.10.147"):
    monkeypatch.setattr(settings, "PUBLIC_SCAN_URL", configured)
    monkeypatch.setattr(scan_links, "_detect_lan_ip", lambda: lan)
    return asyncio.run(scan_links.resolve_scan_origin(origin))


def test_who_can_open_an_address():
    assert scan_links.reach_of("localhost") is ScanReach.THIS_DEVICE
    assert scan_links.reach_of("127.0.0.1") is ScanReach.THIS_DEVICE
    assert scan_links.reach_of("::1") is ScanReach.THIS_DEVICE
    assert scan_links.reach_of("10.10.10.147") is ScanReach.PRIVATE_NETWORK
    assert scan_links.reach_of("192.168.1.20") is ScanReach.PRIVATE_NETWORK
    assert scan_links.reach_of("desktop-pc") is ScanReach.PRIVATE_NETWORK
    assert scan_links.reach_of("scm.com") is ScanReach.PUBLIC


def test_a_localhost_print_carries_the_machines_network_address(monkeypatch):
    out = _resolve("http://localhost:5173", monkeypatch)
    assert out["origin"] == "http://10.10.10.147:5173"
    assert out["source"] is ScanOriginSource.DETECTED_LAN
    assert out["printable"] is True


def test_a_deployed_domain_is_kept_and_only_its_origin_used(monkeypatch):
    out = _resolve("https://scm.com/logistics/consignments/70?x=1", monkeypatch)
    assert out["origin"] == "https://scm.com"
    assert out["reach"] is ScanReach.PUBLIC


def test_the_environment_setting_wins_over_the_browser(monkeypatch):
    out = _resolve("http://localhost:5173", monkeypatch, configured="https://uat.scm.com/")
    assert out["origin"] == "https://uat.scm.com"
    assert out["source"] is ScanOriginSource.CONFIGURED


def test_a_label_only_this_computer_can_open_is_not_printable(monkeypatch):
    out = _resolve("http://localhost:5173", monkeypatch, lan=None)
    assert out["reach"] is ScanReach.THIS_DEVICE
    assert out["printable"] is False
    out = _resolve(None, monkeypatch, configured="http://127.0.0.1:5173")
    assert out["printable"] is False
