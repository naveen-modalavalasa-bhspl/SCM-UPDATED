import re
from pathlib import Path

import pytest

from app.modules.alerts import service
from app.modules.alerts.schemas import AlertMode, AlertVariant


def test_a_confirm_never_closes_itself():
    """A question that answers itself after three seconds is a bug."""
    for item in service.CATALOG.values():
        if item.mode is AlertMode.CONFIRM:
            assert item.auto_close_ms is None, item.code
            assert item.confirm_label, item.code
            assert item.cancel_label, item.code


def test_failures_stay_on_screen():
    for item in service.CATALOG.values():
        if item.variant in (AlertVariant.ERROR, AlertVariant.WARNING):
            assert item.auto_close_ms is None, item.code


def test_informational_alerts_close_after_three_seconds():
    posted = service.CATALOG["grn.posted"]
    assert posted.mode is AlertMode.ALERT
    assert posted.auto_close_ms == service.AUTO_CLOSE_MS == 3000


def test_destructive_actions_are_danger_confirms():
    for code in ("vendor.delete", "item.delete", "user.delete", "po.cancel"):
        item = service.CATALOG[code]
        assert item.variant is AlertVariant.DANGER
        assert item.mode is AlertMode.CONFIRM


def test_unknown_code_raises_rather_than_inventing_copy():
    from app.core.exceptions import NotFoundError

    with pytest.raises(NotFoundError):
        service.get("nope.not.a.code")


def test_frontend_mirror_has_the_same_codes():
    """The bundled TS catalog is what users see before the API answers.

    It is a copy by necessity, so drift is caught here rather than by someone
    meeting a blank dialog. Skipped when the frontend is not checked out beside
    the backend (a backend-only deployment or container).
    """
    mirror = Path(__file__).resolve().parents[4].parent / (
        "frontend/src/modules/alerts/catalog.ts"
    )
    if not mirror.exists():
        pytest.skip("frontend not present next to backend")

    source = mirror.read_text(encoding="utf-8")
    codes = set(re.findall(r'^\s*(?:alert|confirm)\(\s*\n?\s*"([\w.]+)"', source, re.M))

    assert codes == set(service.CATALOG), (
        f"only in backend: {sorted(set(service.CATALOG) - codes)}; "
        f"only in frontend: {sorted(codes - set(service.CATALOG))}"
    )


@pytest.mark.asyncio
async def test_catalog_endpoint_requires_a_login(client, make_user, login):
    assert (await client.get("/api/alerts/catalog")).status_code in (401, 403)

    await make_user()
    headers = await login()
    response = await client.get("/api/alerts/catalog", headers=headers)

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == len(service.CATALOG)
    assert body["items"]["grn.posted"]["auto_close_ms"] == 3000


@pytest.mark.asyncio
async def test_single_code_lookup(client, make_user, login):
    await make_user()
    headers = await login()

    response = await client.get("/api/alerts/catalog/user.delete", headers=headers)

    assert response.status_code == 200
    assert response.json()["variant"] == "danger"
    assert (await client.get("/api/alerts/catalog/nope", headers=headers)).status_code == 404
