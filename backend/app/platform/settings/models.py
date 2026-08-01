"""sys_ tables — mapped to the canonical scm_rebuild schema (database-first)."""
from sqlalchemy import (
    JSON, BigInteger, Boolean, Column, DateTime, Integer, String, Text,
)

from app.core.database import Base
from app.shared.models.base import utcnow


class Setting(Base):
    __tablename__ = "sys_settings"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    setting_key = Column(String(100), unique=True, nullable=False)
    setting_value = Column(Text, nullable=True)
    value_type = Column(String(20), nullable=False, default="string")
    category = Column(String(50), nullable=True)
    description = Column(String(500), nullable=True)
    is_editable = Column(Boolean, nullable=False, default=True)
    updated_by_id = Column(BigInteger, nullable=True)
    updated_at = Column(DateTime, nullable=False, default=utcnow, onupdate=utcnow)


class DocSeries(Base):
    __tablename__ = "sys_doc_series"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    doc_type = Column(String(30), nullable=False, index=True)
    fiscal_year = Column(String(10), nullable=False)
    prefix = Column(String(20), nullable=False)
    pattern = Column(String(50), nullable=False)   # e.g. {prefix}/{fy}/{num:04d}
    last_number = Column(BigInteger, nullable=False, default=0)
    is_active = Column(Boolean, nullable=False, default=True)
    # Added by the Admin build. NULL is read as NEVER, so a live row written before the
    # ALTER TABLE still numbers correctly. The column must exist in the live table or
    # every SELECT on this model raises 1054 — see docs/sql/2026-07-25_admin_masters.sql.
    reset_policy = Column(String(10), nullable=True)          # ResetPolicy
    last_reset_period = Column(String(10), nullable=True)     # "2026" or "2026-07"


class AuditLog(Base):
    """Who changed what, and when. Append-only: nothing updates or deletes a row.

    Columns mirror the DB team's live sys_audit_log. Note the shape they chose: one
    `changed_fields` JSON rather than separate before/after columns, so this build
    writes {"field": {"from": x, "to": y}} into it. Only the fields that actually
    changed go in, keeping the log from becoming a second copy of every table.
    """
    __tablename__ = "sys_audit_log"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    entity_type = Column(String(50), nullable=False, index=True)   # "mst_items"
    entity_id = Column(BigInteger, nullable=False, index=True)
    entity_no = Column(String(50), nullable=True)     # human-facing code or doc number
    action = Column(String(30), nullable=False)       # AuditAction
    changed_fields = Column(JSON, nullable=True)
    actor_id = Column(BigInteger, nullable=True, index=True)
    actor_name = Column(String(200), nullable=True)
    ip_address = Column(String(45), nullable=True)
    created_at = Column(DateTime, nullable=False, default=utcnow, index=True)


class AppLog(Base):
    """Operational errors captured from the API and browser.

    Request bodies and authorization headers are deliberately absent.  The log
    keeps only the information needed to locate a failure in the codebase.
    """
    __tablename__ = "sys_app_logs"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    request_id = Column(String(64), nullable=False, index=True)
    source = Column(String(20), nullable=False, index=True)  # BACKEND | FRONTEND
    level = Column(String(20), nullable=False, index=True)   # ERROR | WARNING
    message = Column(Text, nullable=False)
    error_type = Column(String(200), nullable=True)
    status_code = Column(Integer, nullable=True, index=True)
    http_method = Column(String(10), nullable=True)
    endpoint = Column(String(500), nullable=True)
    page_url = Column(String(1000), nullable=True)
    source_file = Column(String(500), nullable=True)
    function_name = Column(String(200), nullable=True)
    line_number = Column(Integer, nullable=True)
    column_number = Column(Integer, nullable=True)
    stack_trace = Column(Text, nullable=True)
    actor_id = Column(BigInteger, nullable=True, index=True)
    actor_name = Column(String(200), nullable=True)
    ip_address = Column(String(45), nullable=True)
    user_agent = Column(String(500), nullable=True)
    context_data = Column(JSON, nullable=True)
    created_at = Column(DateTime, nullable=False, default=utcnow, index=True)


class NotificationRule(Base):
    """Who to tell when a workflow reaches a stage, or when a rule fires."""
    __tablename__ = "sys_notification_rules"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    event_code = Column(String(50), nullable=False, index=True)
    stage = Column(String(100), nullable=True)      # NULL = every stage of the event
    recipient_type = Column(String(20), nullable=False)   # RecipientType
    recipient_id = Column(BigInteger, nullable=True)
    recipient_name = Column(String(200), nullable=True)   # snapshot for the admin list
    channel = Column(String(20), nullable=False, default="IN_APP")   # NotificationChannel
    template = Column(Text, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, nullable=False, default=utcnow)


class HcmSyncLog(Base):
    __tablename__ = "sys_hcm_sync_log"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    entity = Column(String(50), nullable=False, index=True)
    source = Column(String(20), nullable=False, default="HCM")
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
    status = Column(String(20), nullable=False)
    records_fetched = Column(Integer, nullable=True, default=0)
    records_upserted = Column(Integer, nullable=True, default=0)
    error_message = Column(Text, nullable=True)


class UserCredential(Base):
    """Local login secret. PK is the HCM employee id (no username column)."""
    __tablename__ = "sys_local_credentials"
    employee_id = Column(BigInteger, primary_key=True, autoincrement=False)
    password_hash = Column(String(255), nullable=False)
    must_change = Column(Boolean, nullable=False, default=False)
    failed_attempts = Column(Integer, nullable=False, default=0)
    locked_until = Column(DateTime, nullable=True)
    last_login_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, default=utcnow)
    updated_at = Column(DateTime, nullable=False, default=utcnow, onupdate=utcnow)


class Notification(Base):
    """`sys_notifications`. Raised when a document, or a stock level, needs someone.

    Lives here rather than in the warehouse module that first wrote it: it is a sys_
    table, the app shell's notification bell reads it, and inventory writes to it —
    none of which may import a module further down the chain (rule 5).
    """
    __tablename__ = "sys_notifications"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    employee_id = Column(BigInteger, index=True, nullable=False)
    title = Column(String(200), nullable=False)
    body = Column(String(1000), nullable=True)
    entity_type = Column(String(50), nullable=True)
    entity_id = Column(BigInteger, nullable=True)
    deep_link = Column(String(300), nullable=True)
    is_read = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, nullable=False, default=utcnow)


class UserSession(Base):
    __tablename__ = "sys_sessions"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    employee_id = Column(BigInteger, nullable=False, index=True)
    token_jti = Column(String(64), unique=True, nullable=False)
    issued_at = Column(DateTime, nullable=False, default=utcnow)
    expires_at = Column(DateTime, nullable=False)
    revoked_at = Column(DateTime, nullable=True)
    ip_address = Column(String(45), nullable=True)
    user_agent = Column(String(300), nullable=True)
