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


def test_window_may_run_from_this_month_to_the_end_of_the_next():
    """The window the old shape could not express at all.

    `end_day < start_day` was the only way past the end of the opening month, so
    "1st of this month to the 31st of next" resolved to a single September.
    """
    cycle = MonthlyIndentCycle(
        cycle_month_offset=0, start_day=1, end_month_offset=1, end_day=31,
        timezone="Asia/Kolkata")

    window = service.calculate_cycle(cycle, datetime(2026, 9, 21, 9, 0))

    assert window.start == date(2026, 9, 1)
    assert window.end == date(2026, 10, 31)


def test_a_long_window_clamps_its_closing_day_to_that_months_length():
    cycle = MonthlyIndentCycle(
        cycle_month_offset=0, start_day=15, end_month_offset=5, end_day=31,
        timezone="Asia/Kolkata")

    window = service.calculate_cycle(cycle, datetime(2026, 9, 21, 9, 0))

    assert window.start == date(2026, 9, 15)
    assert window.end == date(2027, 2, 28)


def test_a_reminder_fires_in_the_month_of_the_window_that_carries_its_day():
    """The second month of a span is reachable.

    Read against the opening month alone, day 5 of a 1 Sep - 31 Oct window falls
    before the window opens and was pulled to 1 September — so a two-month cycle
    could not be nudged anywhere in its second half.
    """
    window = service.calculate_cycle(
        MonthlyIndentCycle(cycle_month_offset=0, start_day=10, end_month_offset=1,
                           end_day=31, timezone="Asia/Kolkata"),
        datetime(2026, 9, 1, 9, 0))

    assert service.occurrence(window, 20) == date(2026, 9, 20)
    assert service.occurrence(window, 5) == date(2026, 10, 5)


def test_a_day_the_window_never_reaches_still_runs_on_the_nearest_edge():
    window = service.calculate_cycle(
        MonthlyIndentCycle(cycle_month_offset=0, start_day=10, end_day=20,
                           timezone="Asia/Kolkata"),
        datetime(2026, 9, 1, 9, 0))

    assert service.occurrence(window, 3) == date(2026, 9, 10)
    assert service.occurrence(window, 28) == date(2026, 9, 20)


def test_the_month_a_cycle_serves_is_named_separately_from_where_it_sits():
    """Collect through September and October, for November — one cycle, not a
    window shoved two months into the future."""
    cycle = MonthlyIndentCycle(
        cycle_month_offset=0, start_day=1, end_month_offset=1, end_day=31,
        serves_month_offset=2, timezone="Asia/Kolkata")

    window = service.calculate_cycle(cycle, datetime(2026, 9, 21, 9, 0))

    assert window.start == date(2026, 9, 1)
    assert window.end == date(2026, 10, 31)
    assert window.serves == date(2026, 11, 1)
    assert service._values(
        service.Candidate(employee_id=1, employee_name="A Store Keeper"), window,
    )["month"] == "November 2026"


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


@pytest.mark.asyncio
async def test_a_reminder_can_be_saved_and_writes_its_audit_row(db):
    """Saving a reminder 500'd: `_rule_out` hands `write_audit` a `datetime.time`,
    `sys_audit_log.changed_fields` is a JSON column, and the driver could not write
    it — so the audit INSERT failed the whole create. The rule is saved with the
    audit row in the SAME transaction, which is why a log that cannot be written is
    a save that does not happen."""
    from types import SimpleNamespace

    from app.platform.monthly_indent.schemas import MonthlyIndentRuleIn
    from app.platform.settings.models import AuditLog

    await _seed_role_target(db)
    actor = SimpleNamespace(id=100, full_name="A Store Keeper")
    data = MonthlyIndentRuleIn(
        name="reminder to submit monthly indent",
        trigger_day=21,
        trigger_time=time(17, 0),
        target_type="HCM_ROLE",
        target_ref_id=10,
        condition="NOT_SUBMITTED",
        message_template="Please submit {{month}}",
    )

    created = await service.create_rule(db, data, actor)

    assert created["target_name"] == "Store Keeper"
    assert created["trigger_time"] == time(17, 0)
    audit = (await db.execute(
        select(AuditLog).where(AuditLog.entity_type == "mi_notification_rules")
    )).scalars().all()
    assert len(audit) == 1
    assert audit[0].changed_fields["trigger_time"]["to"] == "17:00:00"

    # The escalation half carries a second time, and the update path diffs both.
    data.escalation_enabled = True
    data.escalation_day = 25
    data.escalation_time = time(9, 30)
    data.escalation_target_type = "REPORTING_MANAGER"
    data.escalation_message_template = "Still not submitted for {{month}}"
    updated = await service.update_rule(db, created["id"], data, actor)

    assert updated["escalation_time"] == time(9, 30)
    rows = (await db.execute(select(MonthlyIndentNotificationRule))).scalars().all()
    assert len(rows) == 1 and rows[0].escalation_day == 25


@pytest.mark.asyncio
async def test_escalating_to_the_reporting_manager_needs_no_recipient_id(db):
    """The manager is found at send time by climbing the raiser's reporting line, so
    there is no id to give — and REPORTING_MANAGER is the escalation the screen offers
    by default. `_target_name`'s "no id, no name" guard ran before the branch that
    says so, so every such reminder was refused as unresolvable."""
    from types import SimpleNamespace

    from app.platform.monthly_indent.schemas import MonthlyIndentRuleIn

    await _seed_role_target(db)
    rule = await service.create_rule(db, MonthlyIndentRuleIn(
        name="Chase, then tell the manager",
        trigger_day=21, trigger_time=time(17, 0),
        target_type="HCM_ROLE", target_ref_id=10,
        condition="NOT_SUBMITTED", message_template="Please submit {{month}}",
        escalation_enabled=True, escalation_day=25, escalation_time=time(9, 30),
        escalation_target_type="REPORTING_MANAGER",
        escalation_message_template="Still not submitted for {{month}}",
    ), SimpleNamespace(id=100, full_name="A Store Keeper"))

    assert rule["escalation_target_name"] == "Reporting manager"
    assert rule["escalation_target_ref_id"] is None
    # With an id it means "climb until somebody of THIS rank", so the rank is named.
    assert await service._target_name(db, "REPORTING_MANAGER", 10) == "Store Keeper"
