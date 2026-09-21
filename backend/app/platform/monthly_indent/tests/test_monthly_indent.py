from datetime import date, datetime, time
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.modules.indents.enums import IndentStatus, IndentType
from app.modules.indents.models import Indent
from app.platform.hcm.models import HcmEmployee, HcmPosition, HcmPositionAssignment, HcmRole
from app.platform.monthly_indent.models import (
    MonthlyIndentNotificationLog, MonthlyIndentNotificationRule,
)
from app.platform.monthly_indent.schemas import MonthlyIndentCycle
from app.platform.monthly_indent import service
from app.platform.settings.models import Notification
from app.shared.models.base import utcnow


def test_cycle_end_clamps_for_february_leap_year():
    cycle = MonthlyIndentCycle(
        cycle_month_offset=0, start_day=1, end_day=31, timezone="Asia/Kolkata")

    window = service.calculate_cycle(
        cycle, datetime(2028, 2, 10, 9, 0))

    assert window.start == date(2028, 2, 1)
    assert window.end == date(2028, 2, 29)


def test_cycle_custom_range_can_cross_month():
    cycle = MonthlyIndentCycle(
        cycle_month_offset=0, start_day=26, end_day=5, timezone="Asia/Kolkata")

    window = service.calculate_cycle(
        cycle, datetime(2026, 9, 1, 9, 0))

    assert window.start == date(2026, 9, 26)
    assert window.end == date(2026, 10, 5)


def test_template_variables_render_and_unknowns_go_blank():
    message = service.render_template(
        "Dear {{ employee_name }}, {{month}} {{missing}}",
        {"employee_name": "Sai", "month": "September 2026"},
    )

    assert message == "Dear Sai, September 2026 "


async def _seed_role_target(db):
    now = utcnow()
    db.add(HcmRole(id=10, code="SK", name="Store Keeper", is_active=True, synced_at=now))
    db.add(HcmEmployee(id=100, emp_code="SK100", full_name="A Store Keeper",
                       is_active=True, synced_at=now))
    db.add(HcmPosition(id=200, name="Store Keeper Post", role_id=10,
                       role_name="Store Keeper", is_active=True, synced_at=now))
    db.add(HcmPositionAssignment(
        id=300, employee_id=100, employee_name="A Store Keeper",
        position_id=200, position_name="Store Keeper Post", is_primary=True,
        is_active=True, synced_at=now,
    ))
    await db.commit()


@pytest.mark.asyncio
async def test_duplicate_notifications_are_prevented_per_rule_user_cycle(db):
    await _seed_role_target(db)
    rule = MonthlyIndentNotificationRule(
        name="Chase store keepers",
        trigger_day=21,
        trigger_time=time(10, 0),
        target_type="HCM_ROLE",
        target_ref_id=10,
        target_name="Store Keeper",
        condition="NOT_SUBMITTED",
        message_template="Please submit {{month}}",
        is_active=True,
    )
    db.add(rule)
    await db.commit()

    now = datetime(2026, 9, 21, 11, 0)
    first = await service.run_due(db, now)
    second = await service.run_due(db, now)

    logs = (await db.execute(select(MonthlyIndentNotificationLog))).scalars().all()
    notifications = (await db.execute(select(Notification))).scalars().all()
    assert first["sent"] == 1
    assert second["sent"] == 0
    assert len(logs) == 1
    assert len(notifications) == 1


@pytest.mark.asyncio
async def test_submitted_monthly_indent_excludes_employee_from_not_submitted(db):
    await _seed_role_target(db)
    db.add(Indent(
        indent_no="IND-1",
        indent_type=IndentType.MONTHLY.value,
        indent_date=date(2026, 9, 2),
        required_date=date(2026, 9, 30),
        requested_by_id=100,
        requested_by_name="A Store Keeper",
        status=IndentStatus.PENDING_APPROVAL.value,
        priority="NORMAL",
        total_items=1,
        total_qty=Decimal("1"),
        created_by_id=100,
        created_by_name="A Store Keeper",
    ))
    rule = MonthlyIndentNotificationRule(
        name="Chase store keepers",
        trigger_day=21,
        trigger_time=time(10, 0),
        target_type="HCM_ROLE",
        target_ref_id=10,
        target_name="Store Keeper",
        condition="NOT_SUBMITTED",
        message_template="Please submit {{month}}",
        is_active=True,
    )
    db.add(rule)
    await db.commit()

    result = await service.run_due(db, datetime(2026, 9, 21, 11, 0))

    assert result["sent"] == 0
    assert (await db.execute(select(MonthlyIndentNotificationLog))).scalars().all() == []


@pytest.mark.asyncio
async def test_missing_reporting_manager_escalation_is_logged_as_skipped(db):
    await _seed_role_target(db)
    rule = MonthlyIndentNotificationRule(
        name="Escalate store keepers",
        trigger_day=21,
        trigger_time=time(10, 0),
        target_type="HCM_ROLE",
        target_ref_id=10,
        target_name="Store Keeper",
        condition="NOT_SUBMITTED",
        message_template="Please submit {{month}}",
        escalation_enabled=True,
        escalation_day=22,
        escalation_time=time(10, 0),
        escalation_target_type="REPORTING_MANAGER",
        escalation_target_name="Reporting manager",
        escalation_message_template="{{employee_name}} has not responded",
        is_active=True,
    )
    db.add(rule)
    await db.commit()

    result = await service.run_due(db, datetime(2026, 9, 22, 11, 0))

    skipped = (await db.execute(
        select(MonthlyIndentNotificationLog)
        .where(MonthlyIndentNotificationLog.kind == "ESCALATION")
    )).scalar_one()
    assert result["skipped"] == 1
    assert skipped.status == "SKIPPED"
    assert "No active escalation recipient" in skipped.reason
