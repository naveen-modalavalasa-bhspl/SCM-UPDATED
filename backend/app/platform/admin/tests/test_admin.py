"""Admin: user access grants, group membership resolution, and the audit trail."""
import pytest
from sqlalchemy import select

from app.platform.hcm.models import (
    HcmEmployee, HcmFacility, HcmPosition, HcmPositionAssignment,
)
from app.platform.rbac import permissions as perms
from app.platform.rbac.models import Role, UserRole
from app.platform.settings.models import AuditLog, UserCredential
from app.shared.enums import GroupType, WarehouseType
from app.shared.models.base import utcnow
from app.shared.models.warehouse import Warehouse

ADMIN_PERMS = [perms.ADMIN_USERS_MANAGE, perms.ADMIN_GROUPS_MANAGE,
               perms.ADMIN_AUDIT_VIEW, perms.MASTER_LOCATION_MANAGE]


@pytest.fixture
async def admin(client, make_user, login):
    await make_user(employee_id=1, username="admin", password="pw",
                    permissions=ADMIN_PERMS)
    return await login("admin", "pw")


@pytest.fixture
async def staff(db):
    """Two employees with no SCM access, in different offices."""
    for i, office in ((10, 100), (11, 200)):
        db.add(HcmEmployee(id=i, emp_code=f"E{i}", full_name=f"Employee {i}",
                           office_id=office, is_active=True, synced_at=utcnow()))
    await db.commit()


# ------------------------------ users ------------------------------ #
async def test_list_users_shows_who_has_access(client, admin, staff):
    body = (await client.get("/api/admin/users", headers=admin)).json()
    by_id = {u["employee_id"]: u for u in body["items"]}
    assert by_id[1]["has_access"] is True      # the admin themselves
    assert by_id[10]["has_access"] is False


async def test_list_users_shows_hcm_position_role_before_scm_roles(
        client, admin, staff, db):
    db.add(HcmPosition(
        id=701, name="District Office Position", role_id=14, role_name="DEO",
        is_active=True, synced_at=utcnow(),
    ))
    db.add(HcmPositionAssignment(
        id=701, employee_id=10, position_id=701, position_name="District Officer",
        is_primary=True, is_active=True, synced_at=utcnow(),
    ))
    await db.commit()

    body = (await client.get("/api/admin/users?search=E10", headers=admin)).json()
    employee = next(row for row in body["items"] if row["employee_id"] == 10)
    assert employee["roles"][0] == {
        "id": 14, "code": "DEO", "name": "DEO",
        "source": "HCM", "assignable": False,
    }


async def test_filter_to_employees_without_access(client, admin, staff):
    body = (await client.get("/api/admin/users?with_access=false",
                             headers=admin)).json()
    assert {u["employee_id"] for u in body["items"]} == {10, 11}


async def test_grant_access_returns_a_password_once(client, admin, staff, db):
    role = Role(code="STORE", name="Store", is_active=True)
    db.add(role)
    await db.commit()

    r = await client.post("/api/admin/users/grant", headers=admin,
                          json={"employee_id": 10, "role_ids": [role.id]})
    assert r.status_code == 200, r.text
    assert r.json()["temporary_password"]

    assert await db.get(UserCredential, 10) is not None
    held = (await db.execute(
        select(UserRole.role_id).where(UserRole.employee_id == 10))).scalars().all()
    assert held == [role.id]


async def test_granted_user_can_log_in(client, admin, staff):
    granted = (await client.post("/api/admin/users/grant", headers=admin,
                                 json={"employee_id": 10})).json()
    r = await client.post("/api/auth/login",
                          data={"username": "E10",
                                "password": granted["temporary_password"]})
    assert r.status_code == 200


async def test_grant_rejects_an_unknown_role(client, admin, staff):
    r = await client.post("/api/admin/users/grant", headers=admin,
                          json={"employee_id": 10, "role_ids": [999]})
    assert r.status_code == 400


async def test_grant_rejects_an_unknown_employee(client, admin):
    r = await client.post("/api/admin/users/grant", headers=admin,
                          json={"employee_id": 4242})
    assert r.status_code == 404


async def test_revoke_removes_the_credential(client, admin, staff, db):
    await client.post("/api/admin/users/grant", headers=admin,
                      json={"employee_id": 10})
    r = await client.delete("/api/admin/users/10/access", headers=admin)
    assert r.status_code == 200
    assert await db.get(UserCredential, 10) is None


async def test_revoked_user_cannot_log_in(client, admin, staff):
    granted = (await client.post("/api/admin/users/grant", headers=admin,
                                 json={"employee_id": 10})).json()
    await client.delete("/api/admin/users/10/access", headers=admin)

    r = await client.post("/api/auth/login",
                          data={"username": "E10",
                                "password": granted["temporary_password"]})
    assert r.status_code == 403


async def test_revoking_someone_without_access_is_404(client, admin, staff):
    assert (await client.delete("/api/admin/users/10/access",
                                headers=admin)).status_code == 404


async def test_set_roles_replaces_rather_than_appends(client, admin, staff, db):
    first = Role(code="A", name="A", is_active=True)
    second = Role(code="B", name="B", is_active=True)
    db.add_all([first, second])
    await db.commit()

    await client.post("/api/admin/users/grant", headers=admin,
                      json={"employee_id": 10, "role_ids": [first.id]})
    await client.put("/api/admin/users/10/roles", headers=admin,
                     json={"role_ids": [second.id]})

    held = (await db.execute(
        select(UserRole.role_id).where(UserRole.employee_id == 10))).scalars().all()
    assert held == [second.id]


async def test_user_management_requires_the_permission(client, make_user, login):
    await make_user(employee_id=5, username="plain", password="pw",
                    permissions=["indent.view"])
    headers = await login("plain", "pw")
    assert (await client.get("/api/admin/users", headers=headers)).status_code == 403


# ------------------------------ groups ------------------------------ #
async def test_role_group_resolves_its_holders(client, admin, staff, db):
    role = Role(code="APPROVER", name="Approver", is_active=True)
    db.add(role)
    await db.flush()
    db.add_all([UserRole(employee_id=10, role_id=role.id),
                UserRole(employee_id=11, role_id=role.id)])
    await db.commit()

    group = (await client.post("/api/admin/groups", headers=admin, json={
        "code": "G_APPROVERS", "name": "Approvers",
        "group_type": GroupType.ROLE.value, "role_id": role.id})).json()

    members = (await client.get(f"/api/admin/groups/{group['id']}/members",
                                headers=admin)).json()
    assert {m["id"] for m in members["items"]} == {10, 11}


async def test_position_group_resolves_its_holders(client, admin, staff, db):
    db.add(HcmPositionAssignment(id=1, employee_id=10, position_id=77,
                                 position_name="Store Manager", is_active=True,
                                 synced_at=utcnow()))
    await db.commit()

    group = (await client.post("/api/admin/groups", headers=admin, json={
        "code": "G_SM", "name": "Store Managers",
        "group_type": GroupType.POSITION.value, "position_id": 77})).json()

    members = (await client.get(f"/api/admin/groups/{group['id']}/members",
                                headers=admin)).json()
    assert [m["id"] for m in members["items"]] == [10]


async def test_location_subgroup_intersects_with_its_parent(client, admin, staff, db):
    """"Approvers" + "Chennai" must mean the approvers in Chennai, not everyone there."""
    role = Role(code="APPROVER", name="Approver", is_active=True)
    db.add(role)
    await db.flush()
    # Both employees are approvers, but they sit in different offices.
    db.add_all([UserRole(employee_id=10, role_id=role.id),
                UserRole(employee_id=11, role_id=role.id)])
    db.add(HcmFacility(id=500, name="Chennai Plant", office_id=100,
                       is_active=True, synced_at=utcnow()))
    db.add(Warehouse(id=900, code="CHN", name="Chennai",
                     warehouse_type=WarehouseType.MAIN.value, facility_id=500))
    await db.commit()

    parent = (await client.post("/api/admin/groups", headers=admin, json={
        "code": "G_APP", "name": "Approvers",
        "group_type": GroupType.ROLE.value, "role_id": role.id})).json()
    child = (await client.post("/api/admin/groups", headers=admin, json={
        "code": "G_APP_CHN", "name": "Approvers Chennai",
        "group_type": GroupType.LOCATION.value, "location_id": 900,
        "parent_id": parent["id"]})).json()

    members = (await client.get(f"/api/admin/groups/{child['id']}/members",
                                headers=admin)).json()
    assert [m["id"] for m in members["items"]] == [10]   # employee 11 is in office 200


async def test_explicit_member_is_added_on_top_of_the_rule(client, admin, staff, db):
    role = Role(code="R", name="R", is_active=True)
    db.add(role)
    await db.flush()
    db.add(UserRole(employee_id=10, role_id=role.id))
    await db.commit()

    group = (await client.post("/api/admin/groups", headers=admin, json={
        "code": "G", "name": "G", "group_type": GroupType.ROLE.value,
        "role_id": role.id})).json()
    await client.post(f"/api/admin/groups/{group['id']}/members/11", headers=admin)

    members = (await client.get(f"/api/admin/groups/{group['id']}/members",
                                headers=admin)).json()
    assert {m["id"] for m in members["items"]} == {10, 11}


async def test_group_type_must_carry_its_own_key(client, admin):
    r = await client.post("/api/admin/groups", headers=admin, json={
        "code": "G", "name": "G", "group_type": GroupType.ROLE.value})
    assert r.status_code == 400


async def test_location_group_must_have_a_parent(client, admin, db):
    db.add(Warehouse(id=901, code="X", name="X",
                     warehouse_type=WarehouseType.MAIN.value))
    await db.commit()
    r = await client.post("/api/admin/groups", headers=admin, json={
        "code": "G", "name": "G", "group_type": GroupType.LOCATION.value,
        "location_id": 901})
    assert r.status_code == 400


async def test_group_loop_is_rejected(client, admin, db):
    role = Role(code="R", name="R", is_active=True)
    db.add(role)
    await db.commit()

    a = (await client.post("/api/admin/groups", headers=admin, json={
        "code": "A", "name": "A", "group_type": GroupType.ROLE.value,
        "role_id": role.id})).json()
    b = (await client.post("/api/admin/groups", headers=admin, json={
        "code": "B", "name": "B", "group_type": GroupType.ROLE.value,
        "role_id": role.id, "parent_id": a["id"]})).json()

    r = await client.put(f"/api/admin/groups/{a['id']}", headers=admin, json={
        "code": "A", "name": "A", "group_type": GroupType.ROLE.value,
        "role_id": role.id, "parent_id": b["id"]})
    assert r.status_code == 400


# ------------------------------ audit ------------------------------ #
async def test_master_edits_are_audited_with_only_the_changed_field(client, admin, db):
    item = (await client.post("/api/items", json={"code": "IT-1", "name": "Bolt"},
                              headers=admin)).json()
    await client.put(f"/api/items/{item['id']}",
                     json={"code": "IT-1", "name": "Hex Bolt"}, headers=admin)

    rows = (await db.execute(
        select(AuditLog).where(AuditLog.entity == "mst_items",
                               AuditLog.action == "UPDATE"))).scalars().all()
    assert len(rows) == 1
    assert rows[0].before == {"name": "Bolt"}
    assert rows[0].after == {"name": "Hex Bolt"}
    assert rows[0].actor_name == "Test User"


async def test_a_put_that_changes_nothing_is_not_logged(client, admin, db):
    item = (await client.post("/api/items", json={"code": "IT-1", "name": "Bolt"},
                              headers=admin)).json()
    await client.put(f"/api/items/{item['id']}",
                     json={"code": "IT-1", "name": "Bolt"}, headers=admin)

    rows = (await db.execute(
        select(AuditLog).where(AuditLog.action == "UPDATE"))).scalars().all()
    assert rows == []


async def test_audit_endpoint_filters_by_entity(client, admin):
    await client.post("/api/items", json={"code": "IT-1", "name": "Bolt"},
                      headers=admin)
    body = (await client.get("/api/admin/audit?entity=mst_items",
                             headers=admin)).json()
    assert body["total"] >= 1
    assert all(r["entity"] == "mst_items" for r in body["items"])


async def test_audit_requires_its_permission(client, make_user, login):
    await make_user(employee_id=6, username="plain", password="pw",
                    permissions=["indent.view"])
    headers = await login("plain", "pw")
    assert (await client.get("/api/admin/audit", headers=headers)).status_code == 403
