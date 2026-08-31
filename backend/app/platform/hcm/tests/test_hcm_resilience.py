"""A brief network drop must cost the sync a retry, never the whole run.

The failure these cover, from the live sync log on 2026-08-31: a run at 14:36 pulled
all 11,721 rows green, and the run three minutes later failed all eight entities — six
of them with "HCM circuit is open", meaning the client refused to send a packet at all,
several seconds after the link had come back. The link was intermittent; the amplifier
was ours.
"""
import time

import httpx
import pytest

from app.platform.hcm import client as hcm_client
from app.platform.hcm import sync
from app.platform.hcm.client import HcmClient, HcmUnavailable, _CircuitBreaker


def test_an_open_breaker_says_how_long_it_will_refuse_for():
    """A refusal is not an answer about HCM — the caller has to know to wait it out."""
    breaker = _CircuitBreaker(threshold=2, cooldown=30.0)
    breaker.on_failure()
    breaker.on_failure()

    with pytest.raises(HcmUnavailable) as caught:
        breaker.before()
    assert caught.value.retry_after > 0
    assert "not sent" in str(caught.value)


def test_the_breaker_forgets_the_burst_once_the_cooldown_lapses():
    """It used to latch. Once the count reached the threshold it stayed there, so a
    SINGLE later failure re-opened it for another full cooldown, for ever — which is
    how a run could fail on its first entity three minutes after a clean one."""
    breaker = _CircuitBreaker(threshold=2, cooldown=0.0)
    breaker.on_failure()
    breaker.on_failure()

    breaker.before()                      # cooldown has lapsed: half-open, count cleared
    assert breaker._failures == 0

    breaker.on_failure()                  # one miss must not shut it again
    breaker.before()


def test_a_run_starts_on_a_clean_breaker():
    """`reset_breaker` is what "Sync now" calls. The state of the link during the last
    run says nothing about this one."""
    hcm_client._breaker.on_failure()
    hcm_client._breaker.on_failure()
    hcm_client._breaker._open_until = time.monotonic() + 300

    hcm_client.reset_breaker()

    hcm_client._breaker.before()          # would raise if the reset had not landed


def test_the_entity_retry_waits_out_a_refusal_rather_than_spending_an_attempt():
    """3s, 6s, 9s all fit inside the old 30s cooldown, so every attempt after the first
    was refused without a packet sent and the entity failed against a door it had shut
    on itself."""
    refused = HcmUnavailable("not sent", retry_after=20.0)

    assert sync._retry_delay("offices", 0, refused) >= 21.0
    # A real failure still backs off normally.
    assert sync._retry_delay("offices", 0, RuntimeError("boom")) == 3.0
    assert sync._retry_delay("offices", 1, RuntimeError("boom")) == 6.0


def test_a_refused_connection_names_the_host_and_says_whose_side_it_is_on():
    """httpx's own wording is "All connection attempts failed", which was the entire
    diagnosis the screen offered."""
    client = HcmClient(base_url="http://hcm.example:8009/api", api_key="k")

    detail = client._explain(httpx.ConnectError("All connection attempts failed"), "u")
    assert "hcm.example:8009" in detail
    assert "mirror is unchanged" in detail

    response = httpx.Response(401, request=httpx.Request("GET", "http://hcm/api/x/"))
    rejected = client._explain(
        httpx.HTTPStatusError("401", request=response.request, response=response), "u")
    assert "HCM_API_KEY" in rejected


async def test_one_client_holds_one_connection_for_the_whole_run():
    """It used to open and throw away a TCP connection per request — around 60 of them
    a run, each one another chance to land in the gap when the link drops."""
    client = HcmClient(base_url="http://hcm.example:8009/api", api_key="k")
    try:
        assert client._client() is client._client()
    finally:
        await client.aclose()
    assert client._http is None
