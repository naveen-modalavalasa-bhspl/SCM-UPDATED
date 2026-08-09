"""Small helpers shared by every model. Portable across MySQL (prod) and SQLite (test)."""
from datetime import datetime

from sqlalchemy import BigInteger, Column, DateTime, Integer

from app.shared.time import now as ist_now

# BIGINT everywhere in prod (MySQL); INTEGER on SQLite so autoincrement PKs work.
BigIntPortable = BigInteger().with_variant(Integer(), "sqlite")


def utcnow() -> datetime:
    """Kept under its old name — 43 models import it as their column default — but it
    is IST now, not UTC. See `app/shared/time.py`: MySQL runs on IST and drops tzinfo,
    so a UTC default stored a timestamp 5h30 behind the rows MySQL stamped itself."""
    return ist_now()


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
