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


# ---- RBAC user directory: role filter + pagination ---- #
async def _seed_directory(db):
    from app.platform.hcm.models import (
        HcmEmployee, HcmPosition, HcmPositionAssignment,
    )
    from app.platform.rbac.models import Role, UserRole
    from app.shared.models.base import utcnow

    for i in (10, 11):
        db.add(HcmEmployee(id=i, emp_code=f"E{i}", full_name=f"Employee {i}",
                           is_active=True, synced_at=utcnow()))
    scm_role = Role(code="STORE", name="Store", is_active=True)
    db.add(scm_role)
    await db.flush()
    db.add(UserRole(employee_id=10, role_id=scm_role.id))
    # An HCM-mirrored role, held through a position rather than rbac_user_roles.
    db.add(HcmPosition(id=801, name="DEO Position", role_id=14, role_name="DEO",
                       is_active=True, synced_at=utcnow()))
    db.add(HcmPositionAssignment(id=801, employee_id=11, position_id=801,
                                 is_primary=True, is_active=True, synced_at=utcnow()))
    hcm_role = Role(code="deo", name="DEO", description="HCM role ID: 14",
                    is_system=True, is_active=True)
    db.add(hcm_role)
    await db.commit()
    return scm_role.id, hcm_role.id


async def test_rbac_users_filters_by_scm_role(client, db, make_user, login):
    await make_user(employee_id=1, username="admin", password="pw",
                    permissions=["admin.users.manage"])
    headers = await login("admin", "pw")
    scm_role_id, _ = await _seed_directory(db)

    body = (await client.get(f"/api/rbac/users?role_id={scm_role_id}",
                             headers=headers)).json()
    assert {row["employee_id"] for row in body["items"]} == {10}


async def test_rbac_users_filters_by_hcm_role_via_position(client, db, make_user, login):
    await make_user(employee_id=1, username="admin", password="pw",
                    permissions=["admin.users.manage"])
    headers = await login("admin", "pw")
    _, hcm_role_id = await _seed_directory(db)

    body = (await client.get(f"/api/rbac/users?role_id={hcm_role_id}",
                             headers=headers)).json()
    assert {row["employee_id"] for row in body["items"]} == {11}


async def test_rbac_users_unknown_role_is_404(client, make_user, login):
    await make_user(employee_id=1, username="admin", password="pw",
                    permissions=["admin.users.manage"])
    headers = await login("admin", "pw")
    r = await client.get("/api/rbac/users?role_id=999999", headers=headers)
    assert r.status_code == 404


async def test_rbac_users_paginates(client, db, make_user, login):
    await make_user(employee_id=1, username="admin", password="pw",
                    permissions=["admin.users.manage"])
    headers = await login("admin", "pw")
    await _seed_directory(db)

    body = (await client.get("/api/rbac/users?page=1&size=2", headers=headers)).json()
    assert body["size"] == 2
    assert len(body["items"]) <= 2
    assert body["total"] >= 3       # employees 1, 10, 11


async def test_rbac_users_requires_permission(client, make_user, login):
    await make_user(employee_id=2, username="plain", password="pw",
                    permissions=["indent.view"])
    headers = await login("plain", "pw")
    assert (await client.get("/api/rbac/users", headers=headers)).status_code == 403


# ---- RBAC user groups: role parent + region (district) sub-group ---- #
async def _admin(make_user, login):
    await make_user(employee_id=1, username="admin", password="pw",
                    permissions=["admin.groups.manage"])
    return await login("admin", "pw")


async def _seed_region_staff(db):
    """Two lab technicians, one in Krishna (office 100), one in Guntur (office 200)."""
    from app.platform.hcm.models import HcmEmployee, HcmOffice
    from app.platform.rbac.models import Role, UserRole
    from app.shared.models.base import utcnow

    db.add(HcmOffice(id=100, name="Krishna District", city="Vijayawada",
                     state="AP", is_active=True, synced_at=utcnow()))
    db.add(HcmOffice(id=200, name="Guntur District", city="Guntur",
                     state="AP", is_active=True, synced_at=utcnow()))
    for emp, office in ((10, 100), (11, 200)):
        db.add(HcmEmployee(id=emp, emp_code=f"E{emp}", full_name=f"Lab Tech {emp}",
                           office_id=office, is_active=True, synced_at=utcnow()))
    role = Role(code="LT", name="Lab Technician", is_active=True)
    db.add(role)
    await db.flush()
    db.add_all([UserRole(employee_id=10, role_id=role.id),
                UserRole(employee_id=11, role_id=role.id)])
    await db.commit()
    return role.id


async def test_group_regions_lists_offices(client, db, make_user, login):
    headers = await _admin(make_user, login)
    await _seed_region_staff(db)
    body = (await client.get("/api/rbac/regions", headers=headers)).json()
    names = {r["name"] for r in body["items"]}
    assert {"Krishna District", "Guntur District"} <= names


async def test_role_parent_group_resolves_all_holders(client, db, make_user, login):
    headers = await _admin(make_user, login)
    role_id = await _seed_region_staff(db)
    parent = (await client.post("/api/rbac/groups", headers=headers, json={
        "code": "GRP_LT", "name": "Lab Technicians",
        "group_type": "ROLE", "role_id": role_id})).json()
    members = (await client.get(f"/api/rbac/groups/{parent['id']}/members",
                                headers=headers)).json()
    assert {m["id"] for m in members["items"]} == {10, 11}


async def test_region_subgroup_narrows_parent_to_a_district(client, db, make_user, login):
    headers = await _admin(make_user, login)
    role_id = await _seed_region_staff(db)
    parent = (await client.post("/api/rbac/groups", headers=headers, json={
        "code": "GRP_LT", "name": "Lab Technicians",
        "group_type": "ROLE", "role_id": role_id})).json()
    child = (await client.post("/api/rbac/groups", headers=headers, json={
        "code": "GRP_LT_KRISHNA", "name": "Krishna Lab Technicians",
        "group_type": "LOCATION", "location_id": 100,
        "parent_id": parent["id"]})).json()
    members = (await client.get(f"/api/rbac/groups/{child['id']}/members",
                                headers=headers)).json()
    # Only the lab technician in Krishna, not the one in Guntur.
    assert {m["id"] for m in members["items"]} == {10}


async def test_location_group_without_parent_is_rejected(client, db, make_user, login):
    headers = await _admin(make_user, login)
    await _seed_region_staff(db)
    r = await client.post("/api/rbac/groups", headers=headers, json={
        "code": "ORPHAN", "name": "Orphan", "group_type": "LOCATION",
        "location_id": 100})
    assert r.status_code == 422


async def test_group_type_must_carry_its_key(client, db, make_user, login):
    headers = await _admin(make_user, login)
    r = await client.post("/api/rbac/groups", headers=headers, json={
        "code": "BAD", "name": "Bad", "group_type": "ROLE"})
    assert r.status_code == 422


async def test_groups_require_permission(client, make_user, login):
    await make_user(employee_id=2, username="plain", password="pw",
                    permissions=["indent.view"])
    headers = await login("plain", "pw")
    assert (await client.get("/api/rbac/groups", headers=headers)).status_code == 403


# ---- Role lifecycle: CRUD, protection, permissions set, clone ---- #
async def _roles_admin(make_user, login):
    # The extra codes ensure those Permission rows exist for the set/clone tests.
    await make_user(employee_id=1, username="admin", password="pw",
                    permissions=["admin.roles.manage", "indent.view",
                                 "indent.create", "stock.view"])
    return await login("admin", "pw")


async def test_create_and_update_role(client, db, make_user, login):
    headers = await _roles_admin(make_user, login)
    created = await client.post("/api/rbac/roles", headers=headers, json={
        "code": "AUDITOR", "name": "Auditor"})
    assert created.status_code == 200, created.text
    role = created.json()
    assert role["is_system"] is False

    updated = await client.put(f"/api/rbac/roles/{role['id']}", headers=headers,
                               json={"code": "AUDITOR", "name": "Internal Auditor"})
    assert updated.json()["name"] == "Internal Auditor"


async def test_duplicate_role_code_is_rejected(client, db, make_user, login):
    headers = await _roles_admin(make_user, login)
    await client.post("/api/rbac/roles", headers=headers,
                      json={"code": "AUDITOR", "name": "Auditor"})
    r = await client.post("/api/rbac/roles", headers=headers,
                          json={"code": "auditor", "name": "Other"})
    assert r.status_code == 422


async def test_system_role_cannot_be_renamed_or_deleted(client, db, make_user, login):
    from app.platform.rbac.models import Role
    headers = await _roles_admin(make_user, login)
    role = Role(code="SEEDED", name="Seeded", is_system=True, is_active=True)
    db.add(role)
    await db.commit()

    rename = await client.put(f"/api/rbac/roles/{role.id}", headers=headers,
                              json={"code": "SEEDED", "name": "Renamed"})
    assert rename.status_code == 422
    delete = await client.delete(f"/api/rbac/roles/{role.id}", headers=headers)
    assert delete.status_code == 422


async def test_role_with_members_cannot_be_deleted(client, db, make_user, login):
    from app.platform.rbac.models import Role, UserRole
    from app.platform.hcm.models import HcmEmployee
    from app.shared.models.base import utcnow
    headers = await _roles_admin(make_user, login)
    role = Role(code="TEMP", name="Temp", is_system=False, is_active=True)
    db.add(HcmEmployee(id=50, emp_code="E50", full_name="Holder",
                       is_active=True, synced_at=utcnow()))
    db.add(role)
    await db.flush()
    db.add(UserRole(employee_id=50, role_id=role.id))
    await db.commit()

    r = await client.delete(f"/api/rbac/roles/{role.id}", headers=headers)
    assert r.status_code == 422
    assert "assigned" in r.json()["error"]


async def test_set_role_permissions_reports_the_diff(client, db, make_user, login):
    from app.platform.rbac.models import Role
    headers = await _roles_admin(make_user, login)
    role = Role(code="TEMP", name="Temp", is_system=False, is_active=True)
    db.add(role)
    await db.commit()

    first = (await client.put(f"/api/rbac/roles/{role.id}/permissions",
                              headers=headers,
                              json={"permission_codes": ["indent.view",
                                                         "indent.create"]})).json()
    assert set(first["granted"]) == {"indent.view", "indent.create"}
    assert first["revoked"] == []

    second = (await client.put(f"/api/rbac/roles/{role.id}/permissions",
                               headers=headers,
                               json={"permission_codes": ["indent.view",
                                                          "stock.view"]})).json()
    assert second["granted"] == ["stock.view"]
    assert second["revoked"] == ["indent.create"]


async def test_set_role_permissions_rejects_unknown_code(client, db, make_user, login):
    from app.platform.rbac.models import Role
    headers = await _roles_admin(make_user, login)
    role = Role(code="TEMP", name="Temp", is_system=False, is_active=True)
    db.add(role)
    await db.commit()
    r = await client.put(f"/api/rbac/roles/{role.id}/permissions", headers=headers,
                         json={"permission_codes": ["not.a.permission"]})
    assert r.status_code == 422


async def test_clone_role_copies_the_permission_set(client, db, make_user, login):
    # Read back through the API rather than the db fixture: the fixture session's
    # REPEATABLE READ snapshot cannot see rows the request session committed.
    from app.platform.rbac.models import Role
    headers = await _roles_admin(make_user, login)
    role = Role(code="BASE", name="Base", is_system=False, is_active=True)
    db.add(role)
    await db.commit()
    await client.put(f"/api/rbac/roles/{role.id}/permissions", headers=headers,
                     json={"permission_codes": ["indent.view", "stock.view"]})

    clone = (await client.post(f"/api/rbac/roles/{role.id}/clone", headers=headers,
                               json={"code": "BASE2", "name": "Base Copy"})).json()
    assert clone["is_system"] is False

    listed = (await client.get("/api/rbac/roles", headers=headers)).json()["items"]
    cloned = next(r for r in listed if r["id"] == clone["id"])
    assert set(cloned["permissions"]) == {"indent.view", "stock.view"}


# ---- Reporting hierarchy: RM -> DM -> OE -> SK/LT from the HCM position tree ---- #
async def _seed_org(db):
    """One RM; two DMs under them; one OE under DM1; one SK + one LT under the OE."""
    from app.platform.hcm.models import HcmEmployee, HcmPosition, HcmPositionAssignment
    from app.shared.models.base import utcnow

    tree = [
        # (position_id, name, role_name, parent_position_id, employee_id, emp_name)
        (900, "Regional Manager AP", "RM", None, 70, "Ravi RM"),
        (901, "District Manager Krishna", "DM", 900, 71, "Divya DM"),
        (902, "District Manager Guntur", "DM", 900, 72, "Dinesh DM"),
        (903, "Operations Executive Vijayawada", "OE", 901, 73, "Omkar OE"),
        (904, "Store Keeper Vijayawada", "SK", 903, 74, "Sana SK"),
        (905, "Lab Technician Vijayawada", "LT", 903, 75, "Lakshmi LT"),
    ]
    for position_id, name, role_name, parent, employee_id, emp_name in tree:
        db.add(HcmPosition(id=position_id, name=name, role_name=role_name,
                           parent_position_id=parent, is_active=True,
                           synced_at=utcnow()))
        db.add(HcmEmployee(id=employee_id, emp_code=f"E{employee_id}",
                           full_name=emp_name, is_active=True, synced_at=utcnow()))
        db.add(HcmPositionAssignment(id=position_id, employee_id=employee_id,
                                     position_id=position_id, is_primary=True,
                                     is_active=True, synced_at=utcnow()))
    await db.commit()


async def test_reporting_team_tree_goes_all_the_way_down(client, db, make_user, login):
    await make_user(employee_id=1, username="admin", password="pw",
                    permissions=["admin.users.manage"])
    headers = await login("admin", "pw")
    await _seed_org(db)

    body = (await client.get("/api/rbac/users/70/reporting", headers=headers)).json()
    assert body["managers"] == []                      # RM reports to nobody
    dm_names = {n["position_name"] for n in body["team"]}
    assert dm_names == {"District Manager Krishna", "District Manager Guntur"}

    krishna = next(n for n in body["team"]
                   if n["position_name"] == "District Manager Krishna")
    oe = krishna["children"][0]
    assert oe["role_name"] == "OE"
    grandchildren = {c["role_name"] for c in oe["children"]}
    assert grandchildren == {"SK", "LT"}


async def test_reporting_manager_chain_goes_all_the_way_up(client, db, make_user, login):
    await make_user(employee_id=1, username="admin", password="pw",
                    permissions=["admin.users.manage"])
    headers = await login("admin", "pw")
    await _seed_org(db)

    body = (await client.get("/api/rbac/users/74/reporting", headers=headers)).json()
    chain = [m["role_name"] for m in body["managers"]]
    assert chain == ["OE", "DM", "RM"]                 # nearest manager first
    assert body["managers"][0]["employees"][0]["full_name"] == "Omkar OE"
    assert body["team"] == []                          # SK has no reportees


async def test_org_tree_starts_at_the_top(client, db, make_user, login):
    await make_user(employee_id=1, username="admin", password="pw",
                    permissions=["admin.users.manage"])
    headers = await login("admin", "pw")
    await _seed_org(db)

    body = (await client.get("/api/rbac/org-tree", headers=headers)).json()
    rm = next(r for r in body["roots"] if r["role_name"] == "RM")
    assert rm["direct_count"] == 2                    # two DMs
    assert rm["team_size"] == 5                       # 2 DM + 1 OE + 1 SK + 1 LT
    krishna = next(c for c in rm["children"]
                   if c["position_name"] == "District Manager Krishna")
    assert krishna["team_size"] == 3                  # OE + SK + LT


async def test_reporting_unknown_employee_is_404(client, make_user, login):
    await make_user(employee_id=1, username="admin", password="pw",
                    permissions=["admin.users.manage"])
    headers = await login("admin", "pw")
    r = await client.get("/api/rbac/users/999999/reporting", headers=headers)
    assert r.status_code == 404


# ---- Reverse lookup + view-as ---- #
async def test_permission_holders_reverse_lookup(client, db, make_user, login):
    from app.platform.hcm.models import HcmEmployee
    from app.platform.rbac.models import Permission, Role, RolePermission, UserRole
    from app.shared.models.base import utcnow
    await make_user(employee_id=1, username="admin", password="pw",
                    permissions=["admin.roles.manage"])
    headers = await login("admin", "pw")

    permission = Permission(code="po.approve", module="procurement",
                            resource="po", action="approve",
                            description="Approve POs")
    role = Role(code="PO_APPROVER", name="PO Approver", is_active=True)
    db.add_all([permission, role])
    db.add(HcmEmployee(id=60, emp_code="E60", full_name="Priya Approver",
                       is_active=True, synced_at=utcnow()))
    await db.flush()
    db.add(RolePermission(role_id=role.id, permission_id=permission.id))
    db.add(UserRole(employee_id=60, role_id=role.id))
    await db.commit()

    body = (await client.get("/api/rbac/permissions/po.approve/holders",
                             headers=headers)).json()
    assert body["total_employees"] == 1
    assert body["roles"][0]["name"] == "PO Approver"
    assert body["roles"][0]["employees"][0]["full_name"] == "Priya Approver"


async def test_permission_holders_unknown_code_is_404(client, make_user, login):
    await make_user(employee_id=1, username="admin", password="pw",
                    permissions=["admin.roles.manage"])
    headers = await login("admin", "pw")
    r = await client.get("/api/rbac/permissions/no.such.perm/holders", headers=headers)
    assert r.status_code == 404


async def test_view_as_user_returns_permissions_and_menu(client, db, make_user, login):
    await make_user(employee_id=1, username="admin", password="pw",
                    permissions=["admin.users.manage"])
    await make_user(employee_id=2, username="worker", password="pw",
                    full_name="Field Worker", permissions=["indent.view"])
    headers = await login("admin", "pw")

    body = (await client.get("/api/rbac/users/2/view-as", headers=headers)).json()
    assert body["employee"]["full_name"] == "Field Worker"
    assert body["permissions"] == ["indent.view"]
    assert isinstance(body["menu"], list)
    assert body["roles"]                       # the role make_user created


async def test_view_as_requires_permission(client, make_user, login):
    await make_user(employee_id=3, username="plain", password="pw",
                    permissions=["indent.view"])
    headers = await login("plain", "pw")
    assert (await client.get("/api/rbac/users/3/view-as",
                             headers=headers)).status_code == 403


async def test_role_changes_are_audited(client, make_user, login):
    await make_user(employee_id=1, username="admin", password="pw",
                    permissions=["admin.roles.manage", "admin.audit.view"])
    headers = await login("admin", "pw")
    created = (await client.post("/api/rbac/roles", headers=headers,
                                 json={"code": "AUD", "name": "Audited"})).json()
    audit = (await client.get(
        f"/api/admin/audit?entity=rbac_roles&entity_id={created['id']}",
        headers=headers)).json()
    assert audit["total"] == 1
