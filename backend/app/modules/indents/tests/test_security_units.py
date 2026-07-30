"""Mock-only Indents security tests.

These tests intentionally avoid the shared DB fixtures in backend/conftest.py.
They do not create schemas, open database connections, or commit data.
"""
from datetime import date, datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.core.exceptions import NotFoundError, PermissionError_, ValidationError
from app.core.pagination import PageParams
from app.modules.indents import service
from app.modules.indents.enums import AcknowledgmentStatus, ApprovalAction
from app.modules.indents.schemas import IndentCreate, IndentUpdate
from app.shared.enums import IndentStatus, InstanceStatus, Priority


def user(employee_id=10, position_id=100, project_id=900):
    return SimpleNamespace(
        id=employee_id,
        active_position_id=position_id,
        full_name=f"User {employee_id}",
        project_id=project_id,
        office_id=700,
    )


@pytest.mark.asyncio
async def test_create_rejects_missing_required_date_before_database_work():
    with pytest.raises(ValidationError, match="Required date is mandatory."):
        await service.create_indent(
            SimpleNamespace(),
            IndentCreate(items=[]),
            user(),
        )


@pytest.mark.asyncio
async def test_update_rejects_missing_required_date(monkeypatch):
    requester = user(employee_id=10)
    draft = SimpleNamespace(
        id=77,
        requested_by_id=10,
        status=IndentStatus.DRAFT.value,
    )
    monkeypatch.setattr(service, "get_indent", AsyncMock(return_value=draft))

    with pytest.raises(ValidationError, match="Required date is mandatory."):
        await service.update_indent(
            SimpleNamespace(),
            77,
            IndentUpdate(remarks="Missing required date"),
            requester,
        )


def test_required_date_validation_accepts_today():
    service._validate_required_date(date.today())


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
async def test_update_audit_values_are_json_safe(monkeypatch):
    requester = user(employee_id=10)
    original_date = date.today()
    updated_date = date.fromordinal(original_date.toordinal() + 2)
    draft = SimpleNamespace(
        id=77,
        indent_no="IND/77",
        requested_by_id=10,
        status=IndentStatus.DRAFT.value,
        required_date=original_date,
        priority=Priority.NORMAL.value,
        office_id=700,
        office_name="Main Office",
        remarks="Original",
        total_items=1,
        total_qty=Decimal("5.000"),
        items=[],
    )
    db = SimpleNamespace(commit=AsyncMock(), refresh=AsyncMock())
    monkeypatch.setattr(service, "get_indent", AsyncMock(return_value=draft))
    monkeypatch.setattr(service, "write_audit", AsyncMock())
    monkeypatch.setattr(service, "_attach_capabilities", AsyncMock(return_value=draft))

    await service.update_indent(
        db,
        77,
        IndentUpdate(required_date=updated_date, remarks="Edited"),
        requester,
    )

    audit = service.write_audit.await_args.kwargs
    assert audit["before"]["required_date"] == original_date.isoformat()
    assert audit["before"]["total_qty"] == 5.0
    assert audit["after"]["required_date"] == updated_date.isoformat()
    assert audit["after"]["total_qty"] == 5.0


@pytest.mark.asyncio
async def test_requester_can_delete_only_a_draft(monkeypatch):
    requester = user(employee_id=10)
    draft = SimpleNamespace(
        id=77,
        indent_no="IND/77",
        requested_by_id=10,
        status=IndentStatus.DRAFT.value,
        total_items=1,
        total_qty=Decimal("5.000"),
    )
    db = SimpleNamespace(delete=AsyncMock(), commit=AsyncMock())
    monkeypatch.setattr(service, "get_indent", AsyncMock(return_value=draft))
    monkeypatch.setattr(service, "write_audit", AsyncMock())

    await service.delete_indent(db, 77, requester)

    assert service.write_audit.await_args.kwargs["before"]["total_qty"] == 5.0
    db.delete.assert_awaited_once_with(draft)
    db.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_delete_rejects_non_draft_and_non_requester(monkeypatch):
    requester = user(employee_id=10)
    manager = user(employee_id=20)
    indent = SimpleNamespace(
        id=77,
        requested_by_id=10,
        status=IndentStatus.SUBMITTED.value,
    )
    db = SimpleNamespace(delete=AsyncMock(), commit=AsyncMock())
    monkeypatch.setattr(service, "get_indent", AsyncMock(return_value=indent))

    with pytest.raises(ValidationError):
        await service.delete_indent(db, 77, requester)

    indent.status = IndentStatus.DRAFT.value
    with pytest.raises(PermissionError_):
        await service.delete_indent(db, 77, manager)

    db.delete.assert_not_awaited()
    db.commit.assert_not_awaited()


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
    def __init__(self, scalar_row=None, mapping_rows=None):
        self.scalar_row = scalar_row
        self.mapping_rows = mapping_rows or []

    def scalars(self):
        return self

    def mappings(self):
        return self

    def scalar_one_or_none(self):
        return self.scalar_row

    def one(self):
        return (0, 0)

    def all(self):
        return self.mapping_rows


class CapturingDb:
    def __init__(self, scalar_row=None, mapping_rows=None, scalar_value=0):
        self.count_stmt = None
        self.result_stmt = None
        self.scalar_stmts = []
        self.execute_stmts = []
        self.scalar_row = scalar_row
        self.mapping_rows = mapping_rows
        self.scalar_value = scalar_value

    async def scalar(self, stmt):
        self.count_stmt = stmt
        self.scalar_stmts.append(stmt)
        return self.scalar_value

    async def execute(self, stmt):
        self.result_stmt = stmt
        self.execute_stmts.append(stmt)
        return EmptyResult(self.scalar_row, self.mapping_rows)


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
        search="  allocator name  ",
        date_from=date(2026, 8, 2),
        date_to=date(2026, 8, 14),
        required_from=date(2026, 8, 1),
        required_to=date(2026, 8, 15),
        statuses=[AcknowledgmentStatus.FULFILLED],
        priorities=[Priority.URGENT],
    )
    count_sql = sql_text(db.count_stmt)
    result_sql = sql_text(db.result_stmt)

    assert page == {"items": [], "total": 0, "page": 1, "size": 20}
    for text in (count_sql, result_sql):
        assert "ind_indents.requested_by_id = 10" in text
        assert "%allocator name%" in text
        assert "ind_indents.indent_no" in text
        assert "ind_indents.requested_by_name" in text
        assert "ind_indents.department_name" in text
        assert "allocated_by_name" not in text
        assert "inv_allocations" not in text
        assert "allocated_qty" not in text
        assert "fulfillment_evidence.actor_name" in text
        assert "fulfillment_evidence.action" in text
        assert "fulfillment_evidence.comments" in text
        assert "wf_actions" not in text
        assert "wf_instances" not in text
        assert "EXISTS" in text
        assert "ind_indent_items.item_code" in text
        assert "ind_indent_items.item_name" in text
        assert "ind_indents.priority IN ('URGENT')" in text
        assert "date(fulfillment_evidence.acted_at)" in text.lower()
        assert ">= '2026-08-02'" in text
        assert "<= '2026-08-14'" in text
        assert "ind_indents.required_date >= '2026-08-01'" in text
        assert "ind_indents.required_date <= '2026-08-15'" in text
        assert "fulfillment_evidence.action IN ('FULFILLED')" in text


@pytest.mark.asyncio
async def test_fully_allocated_but_unissued_indent_has_no_acknowledgment():
    db = CapturingDb()

    page = await service.list_acknowledgments(
        db,
        PageParams(page=1, size=20),
        statuses=[AcknowledgmentStatus.FULFILLED],
    )

    sql = captured_sql(db)
    assert page == {"items": [], "total": 0, "page": 1, "size": 20}
    assert "allocated_qty" not in sql
    assert "inv_allocations" not in sql
    assert "ALLOCATED" not in sql
    assert "0 = 1" in sql


@pytest.mark.asyncio
async def test_partial_allocation_or_lifecycle_state_has_no_acknowledgment():
    db = CapturingDb()

    page = await service.list_acknowledgments(
        db,
        PageParams(page=1, size=20),
        statuses=[AcknowledgmentStatus.PARTIALLY_FULFILLED],
    )

    sql = captured_sql(db)
    assert page == {"items": [], "total": 0, "page": 1, "size": 20}
    assert "allocated_qty" not in sql
    assert "ind_indents.status" not in sql
    assert "fulfillment_evidence.action IN ('PARTIALLY_FULFILLED')" in sql
    assert "0 = 1" in sql


@pytest.mark.asyncio
async def test_allocation_actor_and_timestamp_are_not_fulfillment_evidence():
    db = CapturingDb()

    await service.list_acknowledgments(db, PageParams(page=1, size=20))

    sql = captured_sql(db)
    assert "allocated_by_name" not in sql
    assert "inv_allocations.remarks" not in sql
    assert "inv_allocations.approved_at" not in sql
    assert "ind_indents.updated_at" not in sql
    assert "ind_indents.created_at" not in sql
    assert "CAST(NULL AS DATETIME)" in sql


@pytest.mark.asyncio
async def test_acknowledgment_status_filters_are_display_values_and_keep_pagination():
    full_db = CapturingDb()
    partial_db = CapturingDb()

    full_page = await service.list_acknowledgments(
        full_db,
        PageParams(page=3, size=10),
        statuses=[AcknowledgmentStatus.FULFILLED],
    )
    partial_page = await service.list_acknowledgments(
        partial_db,
        PageParams(page=1, size=10),
        statuses=[AcknowledgmentStatus.PARTIALLY_FULFILLED],
    )

    full_sql = sql_text(full_db.result_stmt)
    partial_sql = sql_text(partial_db.result_stmt)
    assert {status.value for status in AcknowledgmentStatus} == {
        "FULFILLED",
        "PARTIALLY_FULFILLED",
    }
    with pytest.raises(ValueError):
        AcknowledgmentStatus(IndentStatus.ALLOCATED.value)
    assert "ALLOCATED" not in full_sql
    assert "allocated_qty" not in full_sql
    assert "allocated_qty" not in partial_sql
    assert "fulfillment_evidence.action IN ('FULFILLED')" in full_sql
    assert "fulfillment_evidence.action IN ('PARTIALLY_FULFILLED')" in partial_sql
    assert full_page == {"items": [], "total": 0, "page": 3, "size": 10}
    assert partial_page == {"items": [], "total": 0, "page": 1, "size": 10}
    assert "LIMIT 10 OFFSET 20" in full_sql
    assert "LIMIT 10 OFFSET 0" in partial_sql


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
        assert "WITH visible_indents AS" in text
        assert "ind_indents.requested_by_id = 10" in text
        assert "%bolt approved%" in text
        assert "ind_indents.indent_no" in text
        assert "ind_indents.requested_by_name" in text
        assert "activity_events.item_code" in text
        assert "activity_events.item_name" in text
        assert "wf_actions.actor_name" in text
        assert "wf_actions.stage_name" in text
        assert "activity_events.event_label" in text
        assert "activity_events.result_label" in text
        assert "activity_events.department_name" in text
        assert "activity_events.office_name" in text
        assert "activity_events._project_name" in text
        assert "activity_events._search_remarks" in text
        assert "ind_indents.status IN ('APPROVED')" in text
        assert "ind_indents.priority IN ('NORMAL')" in text
        assert "ind_indents.required_date >= '2026-08-01'" in text
        assert "ind_indents.required_date <= '2026-08-15'" in text
    service.indent_access_condition.assert_awaited_once()


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
        transaction_type=service.IndentActivityType.APPROVAL_COMPLETED,
    )
    result_sql = sql_text(db.result_stmt)

    assert "activity_events.event_type = 'APPROVAL_COMPLETED'" in result_sql
    assert "WHEN 'APPROVED' THEN 'APPROVAL_COMPLETED'" in result_sql


@pytest.mark.asyncio
async def test_activity_has_one_creation_event_per_indent_without_line_join():
    db = CapturingDb()

    await service.activity_ledger(db, PageParams(page=1, size=20))

    sql = sql_text(db.result_stmt)
    creation_branch = sql.split(
        "UNION ALL SELECT 'workflow:'",
        maxsplit=1,
    )[0].split("FROM (SELECT", maxsplit=1)[-1]
    assert "'REQUEST_CREATED' AS event_type" in creation_branch
    assert "'Draft' AS result_label" in creation_branch
    assert "FROM visible_indents" in creation_branch
    assert "ind_indent_items" not in creation_branch
    assert "JOIN" not in creation_branch


@pytest.mark.asyncio
async def test_activity_workflow_events_have_historical_results_and_safe_labels():
    db = CapturingDb()

    await service.activity_ledger(db, PageParams(page=1, size=20))

    sql = sql_text(db.result_stmt)
    for action, event_type, result_label in (
        ("SUBMITTED", "REQUEST_SUBMITTED", "Submitted"),
        ("APPROVED", "APPROVAL_COMPLETED", "Approved"),
        ("REJECTED", "REQUEST_REJECTED", "Rejected"),
        ("RETURNED", "REQUEST_RETURNED", "Returned"),
    ):
        assert f"WHEN '{action}' THEN '{event_type}'" in sql
        assert f"WHEN '{action}' THEN '{result_label}'" in sql
    assert "Approval routed automatically" in sql
    assert "Routed Automatically" in sql
    assert "THEN 'System' ELSE wf_actions.actor_name" in sql
    assert "NO_WORKFLOW" not in sql
    assert "REPORTING_LADDER" not in sql
    assert "EMPTY_STAGE" not in sql
    assert "Final Approval" in sql
    assert "Regional Manager Review" in sql
    assert "District Manager Review" in sql
    assert "OE Review" in sql


@pytest.mark.asyncio
async def test_activity_approved_allocations_aggregate_warehouse_splits():
    db = CapturingDb()

    await service.activity_ledger(db, PageParams(page=1, size=20))

    sql = sql_text(db.result_stmt)
    assert "inv_allocations.status = 'APPROVED'" in sql
    assert "inv_allocations.approved_at IS NOT NULL" in sql
    assert "sum(inv_allocation_items.quantity)" in sql
    assert "max(inv_allocation_items.requested_qty)" in sql
    assert "inv_allocation_items.indent_item_id" in sql
    assert "GROUP BY" in sql
    assert "wf_instances.doc_type = 'ALLOCATION'" in sql
    assert "wf_actions.action = 'APPROVED'" in sql
    assert "row_number() OVER" in sql


@pytest.mark.asyncio
async def test_activity_allocation_results_cover_full_partial_and_zero_decisions():
    db = CapturingDb()

    await service.activity_ledger(db, PageParams(page=1, size=20))

    sql = sql_text(db.result_stmt)
    assert (
        "sum(inv_allocation_items.quantity) = "
        "max(inv_allocation_items.requested_qty)"
    ) in sql
    assert "THEN 'ALLOCATED' ELSE 'PARTIALLY_ALLOCATED'" in sql
    assert "THEN 'Allocated' ELSE 'Partially Allocated'" in sql
    assert "inv_allocation_items.quantity > 0" not in sql


@pytest.mark.asyncio
async def test_activity_material_requests_keep_each_persisted_document_and_line():
    db = CapturingDb()

    await service.activity_ledger(db, PageParams(page=1, size=20))

    sql = sql_text(db.result_stmt)
    assert "'PROCUREMENT_REQUEST_CREATED' AS event_type" in sql
    assert "'Pending Approval' AS result_label" in sql
    assert "inv_material_requests.id" in sql
    assert "inv_material_requests.mr_no AS actor_position" in sql
    assert "inv_material_request_items.id" in sql
    assert "material-request:" in sql
    assert "DISTINCT" not in sql


@pytest.mark.asyncio
async def test_activity_bookmark_events_use_real_audit_changes():
    db = CapturingDb()

    await service.activity_ledger(db, PageParams(page=1, size=20))

    sql = sql_text(db.result_stmt)
    assert "sys_audit_log.entity_type = 'ind_indents'" in sql
    assert "sys_audit_log.action = 'UPDATE'" in sql
    assert "is_bookmarked" in sql
    assert "'BOOKMARK_ADDED'" in sql
    assert "'BOOKMARK_REMOVED'" in sql
    assert "'Bookmark added'" in sql
    assert "'Bookmark removed'" in sql


@pytest.mark.asyncio
async def test_activity_uses_event_result_not_current_indent_status():
    db = CapturingDb()

    await service.activity_ledger(
        db,
        PageParams(page=1, size=20),
        statuses=[IndentStatus.APPROVED],
    )

    sql = sql_text(db.result_stmt)
    response_select = sql[
        sql.index("SELECT filtered_activity_events"):
        sql.index("FROM (SELECT activity_events")
    ]
    assert "filtered_activity_events.result" in response_select
    assert "filtered_activity_events.result_label" in response_select
    assert "current_status" not in response_select
    assert "ind_indents.status IN ('APPROVED')" in sql


@pytest.mark.asyncio
async def test_activity_orders_ties_deterministically_and_paginates_after_union():
    db = CapturingDb()

    await service.activity_ledger(db, PageParams(page=2, size=5))

    sql = sql_text(db.result_stmt)
    assert sql.count("UNION ALL") == 4
    assert (
        "ORDER BY filtered_activity_events.occurred_at DESC, "
        "filtered_activity_events._source_rank DESC, "
        "filtered_activity_events.source_id DESC, "
        "filtered_activity_events._event_key DESC"
    ) in sql
    assert sql.rfind("UNION ALL") < sql.rfind("LIMIT 5 OFFSET 5")
    assert sql.count("LIMIT 5 OFFSET 5") == 1


@pytest.mark.asyncio
async def test_activity_one_sided_dates_use_timestamp_ranges_without_date_function():
    from_db = CapturingDb()
    to_db = CapturingDb()

    await service.activity_ledger(
        from_db,
        PageParams(page=1, size=20),
        date_from=date(2026, 8, 2),
    )
    await service.activity_ledger(
        to_db,
        PageParams(page=1, size=20),
        date_to=date(2026, 8, 14),
    )

    from_sql = sql_text(from_db.result_stmt)
    to_sql = sql_text(to_db.result_stmt)
    assert "activity_events.occurred_at >= '2026-08-02 00:00:00'" in from_sql
    assert "activity_events.occurred_at <" not in from_sql
    assert "activity_events.occurred_at < '2026-08-15 00:00:00'" in to_sql
    assert "activity_events.occurred_at >=" not in to_sql
    assert "date(activity_events.occurred_at)" not in from_sql.lower()
    assert "date(activity_events.occurred_at)" not in to_sql.lower()


@pytest.mark.asyncio
async def test_journey_uses_frozen_dynamic_chain_and_omits_unavailable_roles(monkeypatch):
    db = SimpleNamespace(execute=AsyncMock(return_value=EmptyAuditResult()))
    submitted_at = datetime(2026, 7, 27, 9, 5, tzinfo=timezone.utc)
    approved_at = datetime(2026, 7, 27, 9, 30, tzinfo=timezone.utc)
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
    instance = SimpleNamespace(
        id=1,
        status=InstanceStatus.IN_PROGRESS.value,
        current_sequence=2,
        current_stage_name="SPH",
        resolved_chain=[
            {
                "sequence": 1,
                "position_id": 201,
                "position_name": "OE-AP-104-MMU",
                "role_name": "OE",
                "approver_ids": [20],
                "approver_names": ["OE One"],
            },
            {
                "sequence": 2,
                "position_id": 501,
                "position_name": "SPH-AP",
                "role_name": "SPH",
                "approver_ids": [50],
                "approver_names": ["SPH One"],
            },
        ],
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
            comments=None,
            acted_at=submitted_at,
        ),
        SimpleNamespace(
            id=2,
            stage_sequence=1,
            actor_id=20,
            actor_name="OE One",
            actor_position="OE-AP-104-MMU",
            action=ApprovalAction.APPROVED.value,
            stage_name="OE",
            comments="Approved",
            acted_at=approved_at,
        ),
    ]
    pending = [
        SimpleNamespace(
            id=1,
            approver_id=50,
            stage_sequence=2,
            created_at=approved_at,
        ),
    ]
    monkeypatch.setattr(service, "_get_indent_for_journey", AsyncMock(return_value=indent))
    monkeypatch.setattr(
        service,
        "_workflow_rows",
        AsyncMock(return_value=(instance, actions, pending)),
    )
    approval_positions = AsyncMock(side_effect=AssertionError(
        "Frozen workflow chain must be authoritative",
    ))
    monkeypatch.setattr(service, "_approval_positions", approval_positions)

    journey = await service.indent_journey(db, 77, user())

    assert [stage["title"] for stage in journey["stages"]] == [
        "Request Raised",
        "OE Review",
        "Final Approval - SPH",
    ]
    assert not any(
        "DM" in stage["title"] or "RM" in stage["title"]
        for stage in journey["stages"]
    )
    assert journey["stages"][1]["status"] == "APPROVED"
    assert journey["stages"][2]["status"] == "PENDING"
    assert journey["stages"][2]["is_current"] is True
    approval_positions.assert_not_awaited()


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
