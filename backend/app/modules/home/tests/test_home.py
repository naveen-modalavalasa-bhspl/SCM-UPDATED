import pytest

from app.platform.rbac import permissions as perms


@pytest.mark.asyncio
async def test_home_only_returns_sections_allowed_by_rbac(client, make_user, login):
    await make_user(permissions=[perms.INDENT_VIEW, perms.INDENT_CREATE])
    headers = await login()

    response = await client.get("/api/home/summary", headers=headers)

    assert response.status_code == 200
    body = response.json()
    assert [item["key"] for item in body["kpis"]] == ["indents"]
    assert [item["key"] for item in body["quick_actions"]] == ["create_indent"]
    assert all(item["key"] not in {"low_stock", "out_of_stock"} for item in body["needs_attention"])


@pytest.mark.asyncio
async def test_home_range_is_validated(client, make_user, login):
    await make_user()
    headers = await login()

    assert (await client.get(
        "/api/home/summary?date_range=month", headers=headers,
    )).status_code == 200
    assert (await client.get(
        "/api/home/summary?date_range=forever", headers=headers,
    )).status_code == 422
