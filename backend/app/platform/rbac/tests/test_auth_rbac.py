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


async def test_employee_id_login_and_position_switch(client, db):
    from app.core.security import decode_token
    from app.platform.hcm.models import (
        HcmEmployee, HcmPosition, HcmPositionAssignment,
    )
    from app.shared.models.base import utcnow

    db.add(HcmEmployee(
        id=77, full_name="Multi Position", emp_code="EMP-77",
        is_active=True, synced_at=utcnow(),
    ))
    db.add_all([
        HcmPosition(id=701, name="Position A", is_active=True, synced_at=utcnow()),
        HcmPosition(id=702, name="Position B", is_active=True, synced_at=utcnow()),
        HcmPositionAssignment(
            id=701, employee_id=77, position_id=701, is_primary=True,
            is_active=True, synced_at=utcnow(),
        ),
        HcmPositionAssignment(
            id=702, employee_id=77, position_id=702, is_primary=False,
            is_active=True, synced_at=utcnow(),
        ),
    ])
    await db.commit()

    login = await client.post(
        "/api/auth/login", data={"username": "77", "password": "Bavya@123"},
    )
    assert login.status_code == 200
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    me = (await client.get("/api/auth/me", headers=headers)).json()
    assert me["active_position"]["id"] == 701
    assert len(me["positions"]) == 2

    switched = await client.post(
        "/api/auth/switch-position", json={"position_id": 702}, headers=headers,
    )
    assert switched.status_code == 200
    assert decode_token(switched.json()["access_token"])["position_id"] == 702


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
