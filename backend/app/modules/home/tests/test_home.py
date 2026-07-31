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


@pytest.mark.asyncio
async def test_home_indent_kpi_follows_active_employee_position(client, db, make_user):
    from app.modules.indents.models import Indent
    from app.platform.hcm.models import HcmPosition, HcmPositionAssignment
    from app.shared.enums import IndentStatus
    from app.shared.models.base import utcnow

    employee = await make_user(
        employee_id=15037,
        username="HR-EMP-15037",
        full_name="Anusha",
        permissions=[perms.INDENT_VIEW],
    )
    db.add_all([
        HcmPosition(
            id=1501, code="LT", name="Lab Technician", is_active=True,
            synced_at=utcnow(),
        ),
        HcmPosition(
            id=1502, code="SK", name="Storekeeper", is_active=True,
            synced_at=utcnow(),
        ),
        HcmPositionAssignment(
            id=1501, employee_id=employee.id, position_id=1501,
            position_name="Lab Technician", is_primary=True, is_active=True,
            synced_at=utcnow(),
        ),
        HcmPositionAssignment(
            id=1502, employee_id=employee.id, position_id=1502,
            position_name="Storekeeper", is_primary=False, is_active=True,
            synced_at=utcnow(),
        ),
        Indent(
            indent_no="IND-LT-1", requested_by_id=employee.id,
            requested_by_name=employee.full_name, position_id=1501,
            position_name="Lab Technician",
            status=IndentStatus.PENDING_APPROVAL.value, priority="NORMAL",
            total_items=0, total_qty=0,
        ),
        Indent(
            indent_no="IND-SK-1", requested_by_id=employee.id,
            requested_by_name=employee.full_name, position_id=1502,
            position_name="Storekeeper", status=IndentStatus.DRAFT.value,
            priority="NORMAL", total_items=0, total_qty=0,
        ),
        Indent(
            indent_no="IND-SK-2", requested_by_id=employee.id,
            requested_by_name=employee.full_name, position_id=1502,
            position_name="Storekeeper", status=IndentStatus.DRAFT.value,
            priority="NORMAL", total_items=0, total_qty=0,
        ),
    ])
    await db.commit()

    login = await client.post(
        "/api/auth/login",
        data={"username": "HR-EMP-15037", "password": "pw"},
    )
    lt_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    lt_summary = (await client.get("/api/home/summary", headers=lt_headers)).json()
    lt_kpi = next(item for item in lt_summary["kpis"] if item["key"] == "indents")

    assert lt_kpi["value"] == 1
    assert lt_kpi["detail"] == "1 Pending Approval"

    switched = await client.post(
        "/api/auth/switch-position", json={"position_id": 1502}, headers=lt_headers,
    )
    sk_headers = {"Authorization": f"Bearer {switched.json()['access_token']}"}
    sk_summary = (await client.get("/api/home/summary", headers=sk_headers)).json()
    sk_kpi = next(item for item in sk_summary["kpis"] if item["key"] == "indents")

    assert sk_kpi["value"] == 2
    assert sk_kpi["detail"] == "0 Pending Approval"
