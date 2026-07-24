"""sys_ tables — mapped to the canonical scm_rebuild schema (database-first)."""
from sqlalchemy import BigInteger, Boolean, Column, DateTime, Integer, String, Text

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
