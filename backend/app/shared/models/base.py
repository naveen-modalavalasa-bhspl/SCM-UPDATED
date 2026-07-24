"""Small helpers shared by every model. Portable across MySQL (prod) and SQLite (test)."""
from datetime import datetime, timezone

from sqlalchemy import BigInteger, Column, DateTime, Integer

# BIGINT everywhere in prod (MySQL); INTEGER on SQLite so autoincrement PKs work.
BigIntPortable = BigInteger().with_variant(Integer(), "sqlite")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def created_at_col() -> Column:
    return Column(DateTime(timezone=True), nullable=False, default=utcnow)


def updated_at_col() -> Column:
    return Column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)


def pk() -> Column:
    """Autoincrement BIGINT primary key for SCM-owned tables."""
    return Column(BigIntPortable, primary_key=True, autoincrement=True)


def hcm_pk() -> Column:
    """HCM's own id is the primary key of hcm_* tables. No local id, no mapping table."""
    return Column(BigIntPortable, primary_key=True, autoincrement=False)


def soft_fk() -> Column:
    """A reference to an hcm_* row: indexed, but no DB constraint (the mirror may lag)."""
    return Column(BigIntPortable, index=True, nullable=True)
