"""Mock-only Indents security tests.

These tests intentionally avoid the shared DB fixtures in backend/conftest.py.
They do not create schemas, open database connections, or commit data.
"""
from datetime import date, datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.core.exceptions import NotFoundError, PermissionError_, ValidationError
from app.core.pagination import PageParams
from app.modules.indents import service
from app.modules.indents.enums import ApprovalAction
from app.modules.indents.schemas import IndentUpdate
from app.shared.enums import IndentStatus, InstanceStatus, Priority


def user(employee_id=10, position_id=100, project_id=900):
    return SimpleNamespace(
        id=employee_id,
        active_position_id=position_id,
        full_name=f"User {employee_id}",
        project_id=project_id,
        office_id=700,
    )


def assignment(name="PILOT-AP-104-MMU", position_id=100):
    return SimpleNamespace(
        employee_id=10,
        position_id=position_id,
        position_name=name,
        raw={},
        office_id=701,
    )


def position(name="PILOT-AP-104-MMU", position_id=100, project_id=900, parent_id=None):
    return SimpleNamespace(
        id=position_id,
        code=None,
        role_name=None,
        job_name=None,
        raw={},
        name=name,
        project_id=project_id,
        office_id=702,
        parent_position_id=parent_id,
    )


def role(code: str):
    return SimpleNamespace(code=code)


def sql_text(expression) -> str:
    return str(expression.compile(compile_kwargs={"literal_binds": True}))


def test_unknown_indent_status_detection_reports_only_non_enum_values():
    assert service.unknown_indent_statuses([
        IndentStatus.DRAFT.value,
        IndentStatus.AWAITING_ALLOCATION.value,
        "LEGACY_UNKNOWN",
    ]) == {"LEGACY_UNKNOWN"}


def test_indent_search_uses_snapshot_fields_exists_and_escaped_like():
    stmt = service._apply_indent_filters(
        service.select(service.Indent),
        search=" ACME_% ",
    )
    text = sql_text(stmt)

    assert "ind_indents.indent_no" in text
    assert "ind_indents.requested_by_name" in text
    assert "ind_indents.position_name" in text
    assert "ind_indents.department_name" in text
    assert "ind_indents.project_name" in text
    assert "ind_indents.office_name" in text
    assert "EXISTS" in text
    assert "ind_indent_items.item_code" in text
    assert "ind_indent_items.item_name" in text
    assert "ACME\\_\\%" in text
    assert "ESCAPE '\\'" in text


def test_indent_search_ignores_blank_terms():
    stmt = service._apply_indent_filters(
        service.select(service.Indent),
        search="   ",
    )
    text = sql_text(stmt)

    assert "LIKE" not in text
    assert "EXISTS" not in text


async def access_sql(
    monkeypatch,
    *,
    role_name,
    role_codes=None,
    descendants=None,
    project_id=900,
    employee_id=10,
):
    monkeypatch.setattr(
        service,
        "_current_assignment",
        AsyncMock(return_value=(
            assignment(role_name),
            position(role_name, project_id=project_id),
        )),
    )
    monkeypatch.setattr(
        service,
        "_descendant_position_ids",
        AsyncMock(return_value=list(descendants or [])),
    )
    monkeypatch.setattr(
        service.rbac_service,
        "get_user_roles",
        AsyncMock(return_value=[role(code) for code in role_codes or []]),
    )
    return sql_text(await service.indent_access_condition(None, user(employee_id=employee_id)))


@pytest.mark.asyncio
async def test_leaf_user_sees_only_own_and_workflow_related_indents(monkeypatch):
    text = await access_sql(
        monkeypatch,
        role_name="PILOT-AP-104-MMU",
        descendants=[201, 202],
    )

    assert "ind_indents.requested_by_id = 10" in text
    assert "ind_indents.position_id IN" not in text
    assert "wf_pending" in text
    assert "wf_actions" in text


@pytest.mark.asyncio
@pytest.mark.parametrize("role_name", [
    "OPERATION EXECUTIVE-AP-104-MMU",
    "DISTRICT MANAGER-AP-104-HINDUPUR",
    "REGIONAL MANAGER-AP-104",
])
async def test_oe_dm_rm_reporting_branch_visibility_uses_descendants_and_project(monkeypatch, role_name):
    text = await access_sql(
        monkeypatch,
        role_name=role_name,
        descendants=[201, 202],
        project_id=900,
    )

    assert "ind_indents.requested_by_id = 10" in text
    assert "ind_indents.position_id IN (201, 202)" in text
    assert "ind_indents.project_id = 900" in text
    assert "ind_indents.office_id" not in text


@pytest.mark.asyncio
async def test_sibling_branch_isolation_uses_only_authenticated_descendant_positions(monkeypatch):
    text = await access_sql(
        monkeypatch,
        role_name="DISTRICT MANAGER-AP-104-HINDUPUR",
        descendants=[301],
        project_id=900,
    )

    assert "ind_indents.position_id IN (301)" in text
    assert "302" not in text


@pytest.mark.asyncio
@pytest.mark.parametrize("role_name", [
    "STATE PROJECT HEAD-AP",
    "CHIEF OPERATING OFFICER-AP",
])
async def test_sph_and_coo_global_read(monkeypatch, role_name):
    role_code = "state_project_head" if "STATE" in role_name else "chief_operating_officer"
    text = await access_sql(
        monkeypatch,
        role_name="Generic Position",
        role_codes=[role_code],
        descendants=[],
        project_id=None,
    )

    assert "ind_indents.requested_by_id = 10" in text
    assert "true" in text.lower() or "1 = 1" in text


@pytest.mark.asyncio
@pytest.mark.parametrize("role_code", ["ADMIN", "SUPER_ADMIN"])
async def test_admin_and_super_admin_global_read_uses_rbac_role_code(monkeypatch, role_code):
    text = await access_sql(
        monkeypatch,
        role_name="Generic Position",
        role_codes=[role_code],
        descendants=[201, 202],
        project_id=900,
    )

    assert "ind_indents.requested_by_id = 10" in text
    assert "true" in text.lower() or "1 = 1" in text
    assert "ind_indents.position_id IN" not in text


@pytest.mark.asyncio
async def test_sph_display_name_grants_final_authority_global_read(monkeypatch):
    text = await access_sql(
        monkeypatch,
        role_name="STATE PROJECT HEAD-AP",
        role_codes=[],
        descendants=[201, 202],
        project_id=900,
    )

    assert "true" in text.lower() or "1 = 1" in text


def test_dm_acknowledgment_scope_uses_canonical_role_before_position_name():
    assignment_row = assignment("REGIONAL MANAGER-AP-104")
    position_row = position("REGIONAL MANAGER-AP-104")
    position_row.role_name = "district_manager"

    assert service._acknowledgment_scope_code(assignment_row, position_row) == "DM"
    assert service._acknowledgment_stage_name(
        "Submitted",
        ApprovalAction.SUBMITTED.value,
        "DM",
    ) == "District Manager"


def test_dm_acknowledgment_scope_supports_current_position_format():
    assignment_row = assignment("DISTRICT MANAGER-AP-104-MMU-HINDUPUR")
    position_row = position("DISTRICT MANAGER-AP-104-MMU-HINDUPUR")

    assert service._acknowledgment_scope_code(assignment_row, position_row) == "DM"


def test_dm_acknowledgment_rows_use_district_manager_without_changing_other_roles():
    rows = [
        {
            "id": 1,
            "indent_id": 101,
            "indent_no": "IND/DM/SUBMIT",
            "action": ApprovalAction.SUBMITTED.value,
            "stage_name": "Submitted",
            "actor_name": "V Suresh Kumar",
            "actor_id": 10,
            "actor_position": "DISTRICT MANAGER-AP-104-MMU-HINDUPUR",
        },
        {
            "id": 2,
            "indent_id": 102,
            "indent_no": "IND/DM/APPROVE",
            "action": ApprovalAction.APPROVED.value,
            "stage_name": "Submitted",
            "actor_name": "V Suresh Kumar",
            "actor_id": 10,
            "actor_position": "DISTRICT MANAGER-AP-104-MMU-HINDUPUR",
        },
        {
            "id": 3,
            "indent_id": 103,
            "indent_no": "IND/RM/APPROVE",
            "action": ApprovalAction.APPROVED.value,
            "stage_name": "Reporting Manager",
            "actor_name": "Anita Appr",
            "actor_id": 20,
            "actor_position": "REGIONAL MANAGER-AP-104",
        },
        {
            "id": 4,
            "indent_id": 104,
            "indent_no": "IND/OE/SUBMIT",
            "action": ApprovalAction.SUBMITTED.value,
            "stage_name": "Submitted",
            "actor_name": "OE User",
            "actor_id": 30,
            "actor_position": "OPERATION EXECUTIVE-AP-104-MMU",
        },
        {
            "id": 5,
            "indent_id": 105,
            "indent_no": "IND/SPH/FINAL",
            "action": ApprovalAction.APPROVED.value,
            "stage_name": "Final Approval",
            "actor_name": "SPH User",
            "actor_id": 40,
            "actor_position": "STATE PROJECT HEAD-AP",
        },
        {
            "id": 6,
            "indent_id": 106,
            "indent_no": "IND/COO/FINAL",
            "action": ApprovalAction.APPROVED.value,
            "stage_name": "Final Approval",
            "actor_name": "COO User",
            "actor_id": 50,
            "actor_position": "CHIEF OPERATING OFFICER-AP",
        },
        {
            "id": 7,
            "indent_id": 107,
            "indent_no": "IND/DM/REJECT",
            "action": ApprovalAction.REJECTED.value,
            "stage_name": "Submitted",
            "actor_name": "V Suresh Kumar",
            "actor_id": 10,
            "actor_position": "DISTRICT MANAGER-AP-104-MMU-HINDUPUR",
        },
    ]
    result = service._apply_acknowledgment_stage_names(
        rows,
        {
            (20, "REGIONAL MANAGER-AP-104"): "RM",
            (30, "OPERATION EXECUTIVE-AP-104-MMU"): "OE",
            (40, "STATE PROJECT HEAD-AP"): "SPH",
            (50, "CHIEF OPERATING OFFICER-AP"): "COO",
        },
    )

    by_indent = {row["indent_no"]: row for row in result}
    assert by_indent["IND/DM/SUBMIT"]["stage_name"] == "District Manager"
    assert by_indent["IND/DM/APPROVE"]["stage_name"] == "District Manager"
    assert not any(
        row["actor_name"] == "V Suresh Kumar"
        and row["action"] == ApprovalAction.SUBMITTED.value
        and row["stage_name"] == "Submitted"
        for row in result
    )
    assert by_indent["IND/RM/APPROVE"]["stage_name"] == "Reporting Manager"
    assert by_indent["IND/OE/SUBMIT"]["stage_name"] == "Submitted"
    assert by_indent["IND/SPH/FINAL"]["stage_name"] == "Final Approval"
    assert by_indent["IND/COO/FINAL"]["stage_name"] == "Final Approval"
    assert by_indent["IND/DM/REJECT"]["stage_name"] == "Submitted"
    assert all("actor_position" not in row and "actor_id" not in row for row in result)


@pytest.mark.asyncio
async def test_active_workflow_assignee_can_approve(monkeypatch):
    approver = user(employee_id=20)
    indent = SimpleNamespace(
        id=77,
        indent_no="IND/77",
        status=IndentStatus.PENDING_APPROVAL.value,
        requested_by_id=10,
        department_id=1,
        position_id=101,
        position_name="PILOT-AP-104-MMU",
        total_qty=5,
    )
    db = SimpleNamespace(commit=AsyncMock(), refresh=AsyncMock())
    monkeypatch.setattr(service, "get_indent", AsyncMock(return_value=indent))
    active_task = AsyncMock()
    monkeypatch.setattr(service, "_assert_active_workflow_task", active_task)
    monkeypatch.setattr(
        service.engine,
        "act",
        AsyncMock(return_value=SimpleNamespace(status=InstanceStatus.IN_PROGRESS.value)),
    )
    monkeypatch.setattr(service, "_refresh_current_approver", AsyncMock())
    monkeypatch.setattr(service, "write_audit", AsyncMock())
    monkeypatch.setattr(service, "_attach_capabilities", AsyncMock(return_value=indent))

    result = await service.act_on_indent(db, 77, ApprovalAction.APPROVED, "ok", approver)

    assert result is indent
    active_task.assert_awaited_once_with(db, 77, 20)
    service.engine.act.assert_awaited_once()
    db.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_self_approval_is_rejected_before_workflow_action(monkeypatch):
    requester = user(employee_id=10)
    indent = SimpleNamespace(
        id=77,
        status=IndentStatus.PENDING_APPROVAL.value,
        requested_by_id=10,
    )
    monkeypatch.setattr(service, "get_indent", AsyncMock(return_value=indent))
    active_task = AsyncMock()
    monkeypatch.setattr(service, "_assert_active_workflow_task", active_task)

    with pytest.raises(ValidationError):
        await service.act_on_indent(SimpleNamespace(), 77, ApprovalAction.APPROVED, "self", requester)

    active_task.assert_not_awaited()


@pytest.mark.asyncio
async def test_requester_only_update_and_submit(monkeypatch):
    manager = user(employee_id=20)
    indent = SimpleNamespace(
        id=77,
        requested_by_id=10,
        status=IndentStatus.DRAFT.value,
    )
    monkeypatch.setattr(service, "get_indent", AsyncMock(return_value=indent))
    monkeypatch.setattr(service.engine, "start", AsyncMock())

    with pytest.raises(PermissionError_):
        await service.update_indent(SimpleNamespace(), 77, IndentUpdate(remarks="manager edit"), manager)
    with pytest.raises(PermissionError_):
        await service.submit_indent(SimpleNamespace(), 77, manager)

    service.engine.start.assert_not_awaited()


@pytest.mark.asyncio
async def test_admin_cannot_update_or_submit_another_requesters_indent(monkeypatch):
    admin = user(employee_id=99)
    indent = SimpleNamespace(
        id=77,
        requested_by_id=10,
        status=IndentStatus.DRAFT.value,
    )
    monkeypatch.setattr(service, "get_indent", AsyncMock(return_value=indent))
    monkeypatch.setattr(service.engine, "start", AsyncMock())

    with pytest.raises(PermissionError_):
        await service.update_indent(SimpleNamespace(), 77, IndentUpdate(remarks="admin edit"), admin)
    with pytest.raises(PermissionError_):
        await service.submit_indent(SimpleNamespace(), 77, admin)

    service.engine.start.assert_not_awaited()


@pytest.mark.asyncio
async def test_global_visibility_does_not_enable_approve_or_reject(monkeypatch):
    admin = user(employee_id=99)
    indent = SimpleNamespace(
        id=77,
        indent_no="IND/77",
        status=IndentStatus.PENDING_APPROVAL.value,
        requested_by_id=10,
    )
    monkeypatch.setattr(service, "get_indent", AsyncMock(return_value=indent))
    monkeypatch.setattr(
        service,
        "_assert_active_workflow_task",
        AsyncMock(side_effect=PermissionError_("not assigned")),
    )
    monkeypatch.setattr(service.engine, "act", AsyncMock())

    with pytest.raises(PermissionError_):
        await service.act_on_indent(SimpleNamespace(), 77, ApprovalAction.APPROVED, "ok", admin)

    service.engine.act.assert_not_awaited()


@pytest.mark.asyncio
async def test_global_visibility_does_not_set_approve_reject_capabilities(monkeypatch):
    indent = SimpleNamespace(
        id=77,
        status=IndentStatus.PENDING_APPROVAL.value,
        requested_by_id=10,
    )
    db = SimpleNamespace(scalar=AsyncMock(return_value=0))
    monkeypatch.setattr(
        service.rbac_service,
        "get_user_permissions",
        AsyncMock(return_value={service.perms.INDENT_APPROVE, service.perms.INDENT_REJECT}),
    )

    result = await service._attach_capabilities(db, indent, user(employee_id=99))

    assert result.can_approve is False
    assert result.can_reject is False


@pytest.mark.asyncio
async def test_only_active_workflow_assignee_can_reject(monkeypatch):
    approver = user(employee_id=20)
    indent = SimpleNamespace(
        id=77,
        indent_no="IND/77",
        status=IndentStatus.PENDING_APPROVAL.value,
        requested_by_id=10,
    )
    monkeypatch.setattr(service, "get_indent", AsyncMock(return_value=indent))
    monkeypatch.setattr(
        service,
        "_assert_active_workflow_task",
        AsyncMock(side_effect=PermissionError_("not assigned")),
    )
    monkeypatch.setattr(service.engine, "act", AsyncMock())

    with pytest.raises(PermissionError_):
        await service.act_on_indent(SimpleNamespace(), 77, ApprovalAction.REJECTED, "no", approver)

    service.engine.act.assert_not_awaited()


@pytest.mark.asyncio
async def test_bookmark_filter_scopes_board_to_bookmarked_indents(monkeypatch):
    monkeypatch.setattr(
        service,
        "_current_assignment",
        AsyncMock(return_value=(assignment("PILOT-AP-104-MMU"), position("PILOT-AP-104-MMU"))),
    )
    monkeypatch.setattr(service, "_descendant_position_ids", AsyncMock(return_value=[]))
    monkeypatch.setattr(service.rbac_service, "get_user_roles", AsyncMock(return_value=[]))

    condition = await service.indent_access_condition(None, user())
    filtered = service._apply_indent_filters(
        service.select(service.Indent).where(condition),
        is_bookmarked="YES",
    )
    text = sql_text(filtered)

    assert "ind_indents.is_bookmarked = 'YES'" in text
    assert "ind_indents.requested_by_id = 10" in text


@pytest.mark.asyncio
async def test_hidden_indents_cannot_be_bookmarked(monkeypatch):
    db = SimpleNamespace(commit=AsyncMock(), refresh=AsyncMock())
    monkeypatch.setattr(service, "get_indent", AsyncMock(side_effect=NotFoundError("Indent 77 not found")))

    with pytest.raises(NotFoundError):
        await service.set_indent_bookmark(db, 77, user(), is_bookmarked=True)

    db.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_bookmarking_does_not_modify_status_or_workflow(monkeypatch):
    indent = SimpleNamespace(
        id=77,
        indent_no="IND/77",
        requested_by_id=10,
        status=IndentStatus.PENDING_APPROVAL.value,
        is_bookmarked="NO",
    )
    db = SimpleNamespace(commit=AsyncMock(), refresh=AsyncMock())
    monkeypatch.setattr(service, "get_indent", AsyncMock(return_value=indent))
    monkeypatch.setattr(service, "_attach_capabilities", AsyncMock(return_value=indent))
    write_audit = AsyncMock()
    monkeypatch.setattr(service, "write_audit", write_audit)
    engine_start = AsyncMock()
    engine_act = AsyncMock()
    monkeypatch.setattr(service.engine, "start", engine_start)
    monkeypatch.setattr(service.engine, "act", engine_act)

    result = await service.set_indent_bookmark(db, 77, user(), is_bookmarked=True)

    assert result is indent
    assert indent.is_bookmarked == "YES"
    assert indent.status == IndentStatus.PENDING_APPROVAL.value
    engine_start.assert_not_awaited()
    engine_act.assert_not_awaited()
    write_audit.assert_awaited_once()
    db.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_unbookmark_clears_shared_bookmark_without_status_change(monkeypatch):
    indent = SimpleNamespace(
        id=77,
        indent_no="IND/77",
        requested_by_id=10,
        status=IndentStatus.AWAITING_ALLOCATION.value,
        is_bookmarked="YES",
    )
    db = SimpleNamespace(commit=AsyncMock(), refresh=AsyncMock())
    monkeypatch.setattr(service, "get_indent", AsyncMock(return_value=indent))
    monkeypatch.setattr(service, "_attach_capabilities", AsyncMock(return_value=indent))
    write_audit = AsyncMock()
    monkeypatch.setattr(service, "write_audit", write_audit)

    await service.set_indent_bookmark(db, 77, user(), is_bookmarked=False)

    assert indent.is_bookmarked == "NO"
    assert indent.status == IndentStatus.AWAITING_ALLOCATION.value
    write_audit.assert_awaited_once()


def test_invalid_create_or_update_priority_is_rejected():
    with pytest.raises(ValidationError):
        service._validate_priority("EXPEDITE")

    assert service._validate_priority(Priority.NORMAL.value) == Priority.NORMAL.value


class EmptyResult:
    def __init__(self, scalar_row=None):
        self.scalar_row = scalar_row

    def scalars(self):
        return self

    def mappings(self):
        return self

    def scalar_one_or_none(self):
        return self.scalar_row

    def one(self):
        return (0, 0)

    def all(self):
        return []


class CapturingDb:
    def __init__(self, scalar_row=None):
        self.count_stmt = None
        self.result_stmt = None
        self.scalar_stmts = []
        self.execute_stmts = []
        self.scalar_row = scalar_row

    async def scalar(self, stmt):
        self.count_stmt = stmt
        self.scalar_stmts.append(stmt)
        return 0

    async def execute(self, stmt):
        self.result_stmt = stmt
        self.execute_stmts.append(stmt)
        return EmptyResult(self.scalar_row)


EmptyAuditResult = EmptyResult


def captured_sql(db: CapturingDb) -> str:
    return "\n".join(sql_text(stmt) for stmt in [*db.scalar_stmts, *db.execute_stmts])


@pytest.mark.asyncio
async def test_global_visibility_applies_to_all_indent_read_surfaces(monkeypatch):
    indent = SimpleNamespace(id=77, indent_no="IND/77")
    monkeypatch.setattr(
        service,
        "indent_access_condition",
        AsyncMock(return_value=service.literal(True)),
    )

    db = CapturingDb(scalar_row=indent)
    params = PageParams(page=1, size=20)
    reader = user(employee_id=99)

    await service.list_indents(db, params, user=reader)
    await service.list_indents(db, params, user=reader, is_bookmarked="YES")
    await service.indent_stats(db, user=reader)
    await service.indent_stats(db, user=reader, is_bookmarked="YES")
    await service._assert_can_view_indent(db, 77, reader)
    await service._get_indent_for_journey(db, 77, reader)
    await service.list_acknowledgments(db, params, user=reader)
    await service.activity_ledger(db, params, user=reader)
    await service.list_notifications(db, params, reader)

    text = captured_sql(db)
    assert "true" in text.lower() or "1 = 1" in text
    assert "ind_indents.is_bookmarked = 'YES'" in text
    assert "wf_actions" in text
    assert "ind_indent_items" in text
    assert service.indent_access_condition.await_count == 9


@pytest.mark.asyncio
async def test_acknowledgment_search_uses_same_visibility_and_search_filters(monkeypatch):
    db = CapturingDb()
    monkeypatch.setattr(
        service,
        "indent_access_condition",
        AsyncMock(return_value=service.Indent.requested_by_id == 10),
    )

    page = await service.list_acknowledgments(
        db,
        PageParams(page=1, size=20),
        user=user(),
        search="  approved final  ",
        required_from=date(2026, 8, 1),
        required_to=date(2026, 8, 15),
        statuses=[IndentStatus.REJECTED],
        priorities=[Priority.URGENT],
    )
    count_sql = sql_text(db.count_stmt)
    result_sql = sql_text(db.result_stmt)

    assert page == {"items": [], "total": 0, "page": 1, "size": 20}
    for text in (count_sql, result_sql):
        assert "ind_indents.requested_by_id = 10" in text
        assert "%approved final%" in text
        assert "ind_indents.indent_no" in text
        assert "ind_indents.requested_by_name" in text
        assert "ind_indents.department_name" in text
        assert "wf_actions.actor_name" in text
        assert "wf_actions.action" in text
        assert "wf_actions.stage_name" in text
        assert "wf_actions.comments" in text
        assert "EXISTS" in text
        assert "ind_indent_items.item_code" in text
        assert "ind_indent_items.item_name" in text
        assert "ind_indents.status IN ('REJECTED')" in text
        assert "ind_indents.priority IN ('URGENT')" in text
        assert "ind_indents.required_date >= '2026-08-01'" in text
        assert "ind_indents.required_date <= '2026-08-15'" in text


@pytest.mark.asyncio
async def test_activity_filters_use_visibility_status_priority_and_search(monkeypatch):
    db = CapturingDb()
    monkeypatch.setattr(
        service,
        "indent_access_condition",
        AsyncMock(return_value=service.Indent.requested_by_id == 10),
    )

    await service.activity_ledger(
        db,
        PageParams(page=1, size=20),
        user=user(),
        search="bolt approved",
        required_from=date(2026, 8, 1),
        required_to=date(2026, 8, 15),
        statuses=[IndentStatus.APPROVED],
        priorities=[Priority.NORMAL],
    )
    count_sql = sql_text(db.count_stmt)
    result_sql = sql_text(db.result_stmt)

    for text in (count_sql, result_sql):
        assert "ind_indents.requested_by_id = 10" in text
        assert "%bolt approved%" in text
        assert "ind_indents.indent_no" in text
        assert "ind_indents.requested_by_name" in text
        assert "ind_indent_items.item_code" in text
        assert "ind_indent_items.item_name" in text
        assert "wf_actions.actor_name" in text
        assert "wf_actions.action" in text
        assert "wf_actions.stage_name" in text
        assert "wf_actions.action AS transaction_type" in text
        assert "SUBMITTED" in text
        assert "APPROVED" in text
        assert "REJECTED" in text
        assert "RETURNED" in text
        assert "ind_indents.status IN ('APPROVED')" in text
        assert "ind_indents.priority IN ('NORMAL')" in text
        assert "ind_indents.required_date >= '2026-08-01'" in text
        assert "ind_indents.required_date <= '2026-08-15'" in text


@pytest.mark.asyncio
async def test_activity_transaction_filter_matches_real_workflow_action(monkeypatch):
    db = CapturingDb()
    monkeypatch.setattr(
        service,
        "indent_access_condition",
        AsyncMock(return_value=service.Indent.requested_by_id == 10),
    )

    await service.activity_ledger(
        db,
        PageParams(page=1, size=20),
        user=user(),
        transaction_type=service.IndentActivityType.APPROVED,
    )
    result_sql = sql_text(db.result_stmt)

    assert "wf_actions.action = 'APPROVED'" in result_sql
    assert "RAISED" not in result_sql


@pytest.mark.asyncio
async def test_journey_current_stage_calculation(monkeypatch):
    db = SimpleNamespace(execute=AsyncMock(return_value=EmptyAuditResult()))
    indent = SimpleNamespace(
        id=77,
        indent_no="IND/77",
        status=IndentStatus.PENDING_APPROVAL.value,
        requested_by_name="Pilot",
        position_id=101,
        position_name="PILOT-AP-104-MMU",
        created_at=datetime(2026, 7, 27, 9, 0, tzinfo=timezone.utc),
        approved_at=None,
        remarks=None,
    )
    oe_holder = service._JourneyPositionHolder(20, "OE One")
    dm_holder = service._JourneyPositionHolder(30, "DM One")
    monkeypatch.setattr(service, "_get_indent_for_journey", AsyncMock(return_value=indent))
    monkeypatch.setattr(service, "_workflow_rows", AsyncMock(return_value=(
        SimpleNamespace(id=1, status=InstanceStatus.IN_PROGRESS.value),
        [],
        [SimpleNamespace(id=1, approver_id=20, stage_sequence=1, created_at=indent.created_at)],
    )))
    monkeypatch.setattr(service, "_approval_positions", AsyncMock(return_value=[
        {"id": 201, "name": "OE-AP-104-MMU", "holders": [oe_holder], "is_top": False},
        {"id": 301, "name": "DISTRICT MANAGER-AP-104", "holders": [dm_holder], "is_top": False},
    ]))

    journey = await service.indent_journey(db, 77, user())
    current = [stage for stage in journey["stages"] if stage["is_current"]]

    assert len(current) == 1
    assert current[0]["title"] == "OE Review"
    assert all(
        not stage["is_current"]
        for stage in journey["stages"]
        if stage["title"] in {"DM Review", "Ready for Allocation"}
    )


@pytest.mark.asyncio
async def test_sph_coo_any_one_result_uses_successful_final_approver(monkeypatch):
    db = SimpleNamespace(execute=AsyncMock(return_value=EmptyAuditResult()))
    acted_at = datetime(2026, 7, 27, 10, 0, tzinfo=timezone.utc)
    indent = SimpleNamespace(
        id=77,
        indent_no="IND/77",
        status=IndentStatus.AWAITING_ALLOCATION.value,
        requested_by_name="Pilot",
        position_id=101,
        position_name="PILOT-AP-104-MMU",
        created_at=datetime(2026, 7, 27, 9, 0, tzinfo=timezone.utc),
        approved_at=acted_at,
        remarks=None,
    )
    actions = [
        SimpleNamespace(
            id=1,
            stage_sequence=4,
            actor_id=55,
            actor_name="SPH",
            actor_position="STATE PROJECT HEAD-AP",
            action=ApprovalAction.REJECTED.value,
            stage_name="Final Approval",
            comments="not approved",
            acted_at=acted_at,
        ),
        SimpleNamespace(
            id=2,
            stage_sequence=4,
            actor_id=56,
            actor_name="COO",
            actor_position="CHIEF OPERATING OFFICER-AP",
            action=ApprovalAction.APPROVED.value,
            stage_name="Final Approval",
            comments="approved by COO",
            acted_at=acted_at,
        ),
    ]
    monkeypatch.setattr(service, "_get_indent_for_journey", AsyncMock(return_value=indent))
    monkeypatch.setattr(service, "_workflow_rows", AsyncMock(return_value=(
        SimpleNamespace(id=1, status=InstanceStatus.APPROVED.value),
        actions,
        [],
    )))
    monkeypatch.setattr(service, "_approval_positions", AsyncMock(return_value=[
        {"id": 201, "name": "OE-AP-104-MMU", "holders": [], "is_top": False},
        {
            "id": 301,
            "name": "STATE PROJECT HEAD-AP",
            "holders": [service._JourneyPositionHolder(55, "SPH")],
            "is_top": False,
        },
        {
            "id": 401,
            "name": "CHIEF OPERATING OFFICER-AP",
            "holders": [service._JourneyPositionHolder(56, "COO")],
            "is_top": True,
        },
    ]))

    journey = await service.indent_journey(db, 77, user())
    final_stage = next(stage for stage in journey["stages"] if stage["stage_type"] == "final")

    assert journey["final_any_one_outcome"] == "Approved by COO"
    assert final_stage["status"] == "APPROVED"
    assert final_stage["approver_name"] == "COO"
    assert not any(
        stage["stage_type"] == "final_any_one_peer"
        and stage["approver_name"] == "SPH"
        and stage["status"] == "NOT_REQUIRED"
        for stage in journey["stages"]
    )


@pytest.mark.asyncio
async def test_journey_rejects_post_approval_without_identified_final_stage(monkeypatch):
    db = SimpleNamespace(execute=AsyncMock(return_value=EmptyAuditResult()))
    acted_at = datetime(2026, 7, 27, 10, 0, tzinfo=timezone.utc)
    indent = SimpleNamespace(
        id=77,
        indent_no="IND/77",
        status=IndentStatus.AWAITING_ALLOCATION.value,
        requested_by_name="Pilot",
        position_id=101,
        position_name="PILOT-AP-104-MMU",
        created_at=datetime(2026, 7, 27, 9, 0, tzinfo=timezone.utc),
        approved_at=acted_at,
        remarks=None,
    )
    monkeypatch.setattr(service, "_get_indent_for_journey", AsyncMock(return_value=indent))
    monkeypatch.setattr(service, "_workflow_rows", AsyncMock(return_value=(
        SimpleNamespace(id=1, status=InstanceStatus.APPROVED.value),
        [
            SimpleNamespace(
                id=1,
                stage_sequence=0,
                actor_id=10,
                actor_name="Pilot",
                actor_position="PILOT-AP-104-MMU",
                action=ApprovalAction.SUBMITTED.value,
                stage_name="Submitted",
                comments="",
                acted_at=acted_at,
            ),
            SimpleNamespace(
                id=2,
                stage_sequence=1,
                actor_id=20,
                actor_name="Approver",
                actor_position="APPROVER-AP-104",
                action=ApprovalAction.APPROVED.value,
                stage_name="Approval",
                comments="approved",
                acted_at=acted_at,
            ),
        ],
        [],
    )))
    monkeypatch.setattr(service, "_approval_positions", AsyncMock(return_value=[]))

    with pytest.raises(ValidationError, match="final stage_name"):
        await service.indent_journey(db, 77, user())


@pytest.mark.asyncio
async def test_journey_completed_stages_use_workflow_actions_not_latest_hcm(monkeypatch):
    db = SimpleNamespace(execute=AsyncMock(return_value=EmptyAuditResult()))
    acted_at = datetime(2026, 7, 27, 10, 0, tzinfo=timezone.utc)
    indent = SimpleNamespace(
        id=77,
        indent_no="IND/77",
        status=IndentStatus.PENDING_APPROVAL.value,
        requested_by_name="Pilot",
        position_id=101,
        position_name="PILOT-AP-104-MMU",
        created_at=datetime(2026, 7, 27, 9, 0, tzinfo=timezone.utc),
        approved_at=None,
        remarks=None,
    )
    actions = [
        SimpleNamespace(
            id=1,
            stage_sequence=0,
            actor_id=10,
            actor_name="Pilot",
            actor_position="PILOT-AP-104-MMU",
            action=ApprovalAction.SUBMITTED.value,
            stage_name="Submitted",
            comments="",
            acted_at=acted_at,
        ),
        SimpleNamespace(
            id=2,
            stage_sequence=1,
            actor_id=20,
            actor_name="Historical OE",
            actor_position="OLD OE POSITION",
            action=ApprovalAction.APPROVED.value,
            stage_name="OE Review",
            comments="approved",
            acted_at=acted_at,
        ),
    ]
    monkeypatch.setattr(service, "_get_indent_for_journey", AsyncMock(return_value=indent))
    monkeypatch.setattr(service, "_workflow_rows", AsyncMock(return_value=(
        SimpleNamespace(id=1, status=InstanceStatus.IN_PROGRESS.value),
        actions,
        [SimpleNamespace(id=1, approver_id=30, stage_sequence=2, created_at=acted_at)],
    )))
    monkeypatch.setattr(service, "_approval_positions", AsyncMock(return_value=[
        {"id": 201, "name": "NEW OE POSITION", "holders": [service._JourneyPositionHolder(20, "Current OE")], "is_top": False},
        {"id": 301, "name": "DM-AP-104", "holders": [service._JourneyPositionHolder(30, "DM One")], "is_top": False},
    ]))

    journey = await service.indent_journey(db, 77, user())
    completed = next(stage for stage in journey["stages"] if stage["title"] == "OE Review")
    current = next(stage for stage in journey["stages"] if stage["is_current"])

    assert completed["approver_name"] == "Historical OE"
    assert completed["position_name"] == "OLD OE POSITION"
    assert current["title"] == "DM Review"


def test_journey_history_keeps_same_timestamp_actions_with_same_type():
    timestamp = datetime(2026, 7, 27, 10, 0, tzinfo=timezone.utc)
    indent = SimpleNamespace(
        id=77,
        indent_no="IND/77",
        requested_by_name="Pilot",
        position_name="PILOT",
        created_at=timestamp,
        remarks=None,
    )
    actions = [
        SimpleNamespace(
            id=1,
            action=ApprovalAction.APPROVED.value,
            stage_name="Final Approval",
            actor_name="SPH",
            actor_position="SPH",
            acted_at=timestamp,
            comments="ok",
        ),
        SimpleNamespace(
            id=2,
            action=ApprovalAction.APPROVED.value,
            stage_name="Final Approval",
            actor_name="COO",
            actor_position="COO",
            acted_at=timestamp,
            comments="ok",
        ),
    ]

    history = service._journey_history(indent, actions, [])

    assert len([event for event in history if event["event_type"] == "APPROVED"]) == 2
