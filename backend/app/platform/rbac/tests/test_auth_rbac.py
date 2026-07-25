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


async def test_selected_position_supplies_hcm_role_and_permissions(client, db):
    from sqlalchemy import select

    from app.platform.hcm.models import (
        HcmEmployee, HcmPosition, HcmPositionAssignment,
    )
    from app.platform.rbac.models import Permission, Role, RolePermission
    from app.platform.rbac.service import sync_hcm_roles
    from app.shared.models.base import utcnow

    db.add(HcmEmployee(
        id=78, full_name="Role Switcher", emp_code="EMP-78",
        is_active=True, synced_at=utcnow(),
    ))
    db.add_all([
        HcmPosition(id=711, name="Field Position", role_id=91,
                    role_name="Field Staff", is_active=True, synced_at=utcnow()),
        HcmPosition(id=712, name="Manager Position", role_id=92,
                    role_name="Manager", is_active=True, synced_at=utcnow()),
        HcmPositionAssignment(
            id=711, employee_id=78, position_id=711, is_primary=True,
            is_active=True, synced_at=utcnow(),
        ),
        HcmPositionAssignment(
            id=712, employee_id=78, position_id=712, is_primary=False,
            is_active=True, synced_at=utcnow(),
        ),
    ])
    await db.flush()
    await sync_hcm_roles(db)
    manager = await db.scalar(
        select(Role).where(Role.description == "HCM role ID: 92")
    )
    permission = Permission(
        code="test.manager.page", module="test", resource="manager", action="page",
    )
    db.add(permission)
    await db.flush()
    db.add(RolePermission(role_id=manager.id, permission_id=permission.id))
    await db.commit()

    login = await client.post(
        "/api/auth/login", data={"username": "78", "password": "Bavya@123"},
    )
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    me = (await client.get("/api/auth/me", headers=headers)).json()
    assert "field_staff" in me["roles"]
    assert "test.manager.page" not in me["permissions"]

    switched = await client.post(
        "/api/auth/switch-position", json={"position_id": 712}, headers=headers,
    )
    switched_headers = {
        "Authorization": f"Bearer {switched.json()['access_token']}",
    }
    me = (await client.get("/api/auth/me", headers=switched_headers)).json()
    assert "manager" in me["roles"]
    assert "test.manager.page" in me["permissions"]


async def test_requester_is_not_granted_automatically(db):
    from sqlalchemy import select

    from app.platform.rbac.models import Role
    from app.platform.rbac.service import get_user_roles

    requester = await db.scalar(select(Role).where(Role.code == "REQUESTER"))
    if requester is None:
        requester = Role(code="REQUESTER", name="Requester", is_active=True)
        db.add(requester)
        await db.commit()

    roles = await get_user_roles(db, employee_id=99999)
    assert requester not in roles


async def test_page_and_feature_access_updates_preserve_each_other(db):
    from sqlalchemy import select

    from app.platform.hcm.models import HcmEmployee
    from app.platform.rbac.models import Page, Permission, Role, RolePermission
    from app.platform.rbac.service import (
        get_feature_access_matrix, get_page_access_matrix,
        set_role_feature_access, set_role_page_access,
    )
    from app.shared.models.base import utcnow

    actor = HcmEmployee(
        id=880, full_name="RBAC Admin", emp_code="RBAC-ADMIN",
        is_active=True, synced_at=utcnow(),
    )
    role = Role(code="REGRESSION_ROLE", name="Regression Role", is_active=True)
    page_permission = Permission(
        code="regression.view", module="regression",
        resource="regression", action="view",
    )
    feature_permission = Permission(
        code="regression.create", module="regression",
        resource="regression", action="create",
        description="Create regression records",
    )
    db.add_all([actor, role, page_permission, feature_permission])
    await db.flush()
    page = Page(
        code="regression_page", path="/regression", name="Regression",
        module="regression", required_permission=page_permission.code,
        is_active=True,
    )
    db.add(page)
    await db.commit()

    await set_role_page_access(db, role.id, [page.code], actor)
    page_matrix = await get_page_access_matrix(db)
    role_pages = next(row for row in page_matrix["roles"] if row["id"] == role.id)
    assert page.code in role_pages["page_codes"]

    await set_role_feature_access(
        db, role.id, [feature_permission.code], actor,
    )
    feature_matrix = await get_feature_access_matrix(db)
    role_features = next(
        row for row in feature_matrix["roles"] if row["id"] == role.id
    )
    assert feature_permission.code in role_features["permission_codes"]

    held = set((await db.execute(
        select(Permission.code)
        .join(RolePermission, RolePermission.permission_id == Permission.id)
        .where(RolePermission.role_id == role.id)
    )).scalars().all())
    assert held == {page_permission.code, feature_permission.code}


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
