"""Stage 4: login, /me shape, and require_permission enforcement (403 vs 200)."""


async def test_login_and_me_returns_permissions(client, make_user, login):
    await make_user(employee_id=1, username="alice", password="secret",
                    full_name="Alice A", permissions=["indent.view", "indent.create"])
    headers = await login("alice", "secret")

    r = await client.get("/api/auth/me", headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert body["employee"]["name"] == "Alice A"
    assert set(body["permissions"]) == {"indent.view", "indent.create"}
    assert "roles" in body and "positions" in body and "menu" in body


async def test_bad_password_rejected(client, make_user):
    await make_user(employee_id=1, username="alice", password="secret")
    r = await client.post("/api/auth/login", data={"username": "alice", "password": "wrong"})
    assert r.status_code == 403


async def test_require_permission_forbidden_without_code(client, make_user, login):
    # bob lacks admin.users.manage -> 403 on the admin-only endpoint
    await make_user(employee_id=2, username="bob", password="pw", permissions=["indent.view"])
    headers = await login("bob", "pw")
    r = await client.get("/api/hcm/sync-log", headers=headers)
    assert r.status_code == 403


async def test_require_permission_allows_with_code(client, make_user, login):
    await make_user(employee_id=3, username="carol", password="pw",
                    permissions=["admin.users.manage"])
    headers = await login("carol", "pw")
    r = await client.get("/api/hcm/sync-log", headers=headers)
    assert r.status_code == 200


async def test_unauthenticated_is_401(client):
    r = await client.get("/api/auth/me")
    assert r.status_code == 401
