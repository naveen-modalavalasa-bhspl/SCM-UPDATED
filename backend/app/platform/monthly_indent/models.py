"""mi_ tables for configurable monthly indent cycles and alerts."""
from sqlalchemy import (
    BigInteger, Boolean, Column, DateTime, Integer, String, Text, Time,
    UniqueConstraint, Index,
)

from app.core.database import Base
from app.shared.models.base import pk, utcnow


class MonthlyIndentSetting(Base):
    __tablename__ = "mi_settings"

    id = pk()
    is_enabled = Column(Boolean, nullable=False, default=True, server_default="1")
    approval_flow_enabled = Column(Boolean, nullable=False, default=False, server_default="0")
    cycle_month_offset = Column(Integer, nullable=False, default=0, server_default="0")
    start_day = Column(Integer, nullable=False, default=1, server_default="1")
    end_day = Column(Integer, nullable=False, default=31, server_default="31")
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
    kind = Column(String(20), nullable=False)  # PRIMARY | ESCALATION
    target_employee_id = Column(BigInteger, nullable=False, index=True)
    target_employee_name = Column(String(200), nullable=True)
    recipient_employee_id = Column(BigInteger, nullable=False, index=True)
    recipient_employee_name = Column(String(200), nullable=True)
    status = Column(String(20), nullable=False, default="SENT")
    reason = Column(String(300), nullable=True)
    title = Column(String(200), nullable=True)
    message = Column(Text, nullable=True)
    sent_at = Column(DateTime, nullable=False, default=utcnow, index=True)
