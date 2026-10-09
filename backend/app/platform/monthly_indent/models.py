"""mi_ tables for configurable monthly indent cycles and alerts."""
from sqlalchemy import (
    BigInteger, Boolean, Column, Date, DateTime, Integer, String, Text, Time,
    UniqueConstraint, Index,
)

from app.core.database import Base
from app.shared.models.base import pk, utcnow


class MonthlyIndentSetting(Base):
    __tablename__ = "mi_settings"

    id = pk()
    is_enabled = Column(Boolean, nullable=False, default=True, server_default="1")
    approval_flow_enabled = Column(Boolean, nullable=False, default=False, server_default="0")
    #: Which month the window OPENS in, counted from the current month. Only read
    #: when `anchor_month` is empty — see that column.
    cycle_month_offset = Column(Integer, nullable=False, default=0, server_default="0")
    #: The first of a month a cycle opens in, stored as a DATE rather than as "this
    #: month / next month". A relative offset re-anchors on every calendar month, so a
    #: window running into the next month was replaced by the NEXT cycle on the 1st
    #: while it was still open. Cycles open in this month and every `period` months
    #: either side of it (`service.cycle_period_months`).
    anchor_month = Column(Date, nullable=True)
    #: The submission rules double as the list of who MAY raise a monthly indent. Off,
    #: somebody no rule names can submit freely (the rules only limit); on, they are
    #: refused.
    restrict_to_rules = Column(Boolean, nullable=False, default=False, server_default="0")
    start_day = Column(Integer, nullable=False, default=1, server_default="1")
    #: How many months after the opening month the window CLOSES in. 0 is the same
    #: month; 1 makes "1st of this month to the 31st of next" sayable, which is the
    #: whole reason the column exists — `end_day < start_day` could only ever express
    #: a window one month long.
    end_month_offset = Column(Integer, nullable=False, default=0, server_default="0")
    end_day = Column(Integer, nullable=False, default=31, server_default="31")
    #: Which month the collected indents are FOR, counted from the opening month.
    #: Purely what the cycle is CALLED — it moves no date, so a two-month collection
    #: for October is one setting, not a window shoved into the future.
    serves_month_offset = Column(Integer, nullable=False, default=0, server_default="0")
    timezone = Column(String(80), nullable=False, default="Asia/Kolkata")
    scheduler_enabled = Column(Boolean, nullable=False, default=True, server_default="1")
    scheduler_interval_minutes = Column(Integer, nullable=False, default=30, server_default="30")
    updated_by_id = Column(BigInteger, nullable=True)
    updated_at = Column(DateTime, nullable=False, default=utcnow, onupdate=utcnow)


class MonthlyIndentNotificationRule(Base):
    __tablename__ = "mi_notification_rules"

    id = pk()
    name = Column(String(160), nullable=False)
    is_active = Column(Boolean, nullable=False, default=True, server_default="1")
    trigger_day = Column(Integer, nullable=False)
    trigger_time = Column(Time, nullable=False)
    target_type = Column(String(30), nullable=False)  # HCM_ROLE | POSITION | EMPLOYEE
    target_ref_id = Column(BigInteger, nullable=False)
    target_name = Column(String(200), nullable=True)
    condition = Column(String(40), nullable=False)  # NOT_SUBMITTED | PENDING_APPROVAL | NOT_RESPONDED
    message_template = Column(Text, nullable=False)
    escalation_enabled = Column(Boolean, nullable=False, default=False, server_default="0")
    escalation_day = Column(Integer, nullable=True)
    escalation_time = Column(Time, nullable=True)
    escalation_target_type = Column(String(30), nullable=True)  # REPORTING_MANAGER | HCM_ROLE | EMPLOYEE
    escalation_target_ref_id = Column(BigInteger, nullable=True)
    escalation_target_name = Column(String(200), nullable=True)
    escalation_message_template = Column(Text, nullable=True)
    #: The follow-up measured from the reminder instead of pinned to a day of the
    #: month: "1" is the next day. When set it wins over `escalation_day`.
    escalation_after_days = Column(Integer, nullable=True)
    #: How many rungs of the reporting line are told, one after another. Level k goes
    #: to the k-th manager up, `escalation_after_days` (or one day) after level k-1.
    #: Only meaningful for REPORTING_MANAGER.
    escalation_levels = Column(Integer, nullable=False, default=1, server_default="1")
    created_by_id = Column(BigInteger, nullable=True)
    created_at = Column(DateTime, nullable=False, default=utcnow)
    updated_at = Column(DateTime, nullable=False, default=utcnow, onupdate=utcnow)


class MonthlyIndentSubmissionRule(Base):
    __tablename__ = "mi_submission_rules"
    __table_args__ = (
        UniqueConstraint("target_type", "target_ref_id", name="uq_mi_submission_target"),
        Index("ix_mi_submission_active_target", "is_active", "target_type", "target_ref_id"),
    )

    id = pk()
    name = Column(String(160), nullable=False)
    is_active = Column(Boolean, nullable=False, default=True, server_default="1")
    target_type = Column(String(30), nullable=False)  # HCM_ROLE | POSITION | EMPLOYEE
    target_ref_id = Column(BigInteger, nullable=False)
    target_name = Column(String(200), nullable=True)
    max_submissions = Column(Integer, nullable=False, default=1, server_default="1")
    deadline_day = Column(Integer, nullable=False, default=31, server_default="31")
    allow_after_deadline = Column(Boolean, nullable=False, default=False, server_default="0")
    created_by_id = Column(BigInteger, nullable=True)
    created_at = Column(DateTime, nullable=False, default=utcnow)
    updated_at = Column(DateTime, nullable=False, default=utcnow, onupdate=utcnow)


class MonthlyIndentNotificationLog(Base):
    __tablename__ = "mi_notification_logs"
    __table_args__ = (
        UniqueConstraint(
            "rule_id", "cycle_key", "target_employee_id", "recipient_employee_id", "kind",
            name="uq_mi_notification_once",
        ),
        Index("ix_mi_logs_cycle_rule", "cycle_key", "rule_id"),
    )

    id = pk()
    rule_id = Column(BigInteger, nullable=False, index=True)
    cycle_key = Column(String(40), nullable=False, index=True)
    kind = Column(String(20), nullable=False)  # PRIMARY | ESCALATION | ESCALATION_L<n>
    target_employee_id = Column(BigInteger, nullable=False, index=True)
    target_employee_name = Column(String(200), nullable=True)
    recipient_employee_id = Column(BigInteger, nullable=False, index=True)
    recipient_employee_name = Column(String(200), nullable=True)
    status = Column(String(20), nullable=False, default="SENT")
    reason = Column(String(300), nullable=True)
    title = Column(String(200), nullable=True)
    message = Column(Text, nullable=True)
    sent_at = Column(DateTime, nullable=False, default=utcnow, index=True)
